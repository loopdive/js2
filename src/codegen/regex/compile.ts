// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2a — Regex AST → flat bytecode compiler (compile-time, pure TS).
 *
 * Turns a `ParsedRegex` into a `CompiledRegex` program executed by the Wasm
 * backtracking VM (`__regex_run` in `src/codegen/native-regex.ts`). The
 * program is a flat `number[]` of fixed-width `[op, a, b]` records.
 *
 * Capture slots: group g occupies slots `2g` (start) and `2g+1` (end). Group 0
 * is the whole match. The VM allocates `2 * (numCaptures + 1)` slots.
 *
 * Backtracking is encoded with `SPLIT`/`JMP`, the classic Thompson→VM lowering
 * (Russ Cox, "Regular Expression Matching: the Virtual Machine Approach").
 * Greedy `x*` is `L1: SPLIT body, L2 ; body ; JMP L1 ; L2:` — body tried first.
 * Lazy `x*?` swaps the SPLIT targets so the exit is tried first.
 *
 * #1911 — lookarounds compile to SUB-PROGRAMS appended after the main
 * program's MATCH: `LOOKAROUND [subPc, flags]` runs the sub-program as a
 * fresh anchored attempt via a recursive `__regex_run` call. Lookbehind
 * bodies are compiled REVERSED (concat order flipped, capture SAVE slots
 * swapped) and executed with direction -1 — the Irregexp approach. Inline
 * modifier groups `(?ims-ims:…)` are a pure compile-time flag-scope: the
 * emitter's i/m/s state nests with the group.
 */
import {
  INSTR_WIDTH,
  ReOp,
  RE_FLAG_I,
  RE_FLAG_M,
  RE_FLAG_S,
  RE_FLAG_U,
  RE_FLAG_V,
  type CompiledRegex,
} from "./bytecode.js";
import { parsePattern, type ParsedRegex, type ReNode } from "./parse.js";
import { foldCharUnitsLegacy, foldClassRangesLegacy, unitsToRanges } from "./casefold.js";
import { dotCpRanges } from "./unicode.js";

/** Bounded repetition expansion guard — `{n,m}` with large m is rewritten to
 *  repeated atoms, so cap the expansion to keep programs small. */
const MAX_REPEAT_EXPANSION = 1000;

/** A lookaround body queued for sub-program emission after the main MATCH.
 *  Snapshot the modifier state (#1911) — the body compiles LATER but must see
 *  the i/m/s flags that were active at its syntactic position. */
interface PendingSub {
  /** Body AST (already reversed for lookbehind). */
  node: ReNode;
  /** pc of the LOOKAROUND instruction whose operand `a` needs the sub start. */
  patchPc: number;
  /** Lookbehind bodies emit reversed capture SAVE order. */
  reversed: boolean;
  caseInsensitive: boolean;
  dotAll: boolean;
  multiline: boolean;
}

class Emitter {
  /** Instruction records, each `[op,a,b]`, flattened on finish. */
  private readonly instrs: Array<[number, number, number]> = [];
  /** Flat class table; class offset = index of its rangeCount cell. */
  readonly classTable: number[] = [];
  // Mutable since #1911: inline modifier groups `(?ims-ims:…)` scope these
  // per-subtree; lookaround sub-programs restore the snapshot they captured.
  private caseInsensitive: boolean;
  /** dotAll (`s` flag): `.` matches line terminators too. */
  private dotAll: boolean;
  /** multiline (`m` flag): `^`/`$` match at line boundaries, not just BOS/EOS. */
  private multiline: boolean;
  /** Code-point mode (`u`/`v`). Pattern-level (not modifier-scoped). In u/v mode
   *  cased atoms are already folded to plain unit classes at parse time by the
   *  host-oracle (`unicode.ts`); the `i`-fold below therefore only applies full
   *  legacy (non-Unicode) case folding when this is false. #2720. */
  private readonly unicode: boolean;
  /** Lookbehind bodies emit group SAVE slots swapped (end first) so capture
   *  spans stay [left, right] while matching right-to-left. #1911. */
  private reversed = false;
  /** Lookaround bodies pending sub-program emission (drained by compileParsed). */
  private readonly pendingSubs: PendingSub[] = [];
  /** Count of scratch capture slots allocated for `ReOp.PROGRESS` empty-loop
   *  guards (#1959). Each nullable star/plus claims one slot, appended after
   *  the real capture slots so it is never reported as a capture. Seeded by
   *  compileParsed once the capture count is known. */
  scratchCount = 0;
  /** Base slot index for the next scratch slot = `2 * nGroups + scratchCount`.
   *  Set by compileParsed before compileNode runs. */
  private scratchBase = 0;

  constructor(caseInsensitive: boolean, dotAll: boolean, multiline: boolean, unicode: boolean) {
    this.caseInsensitive = caseInsensitive;
    this.dotAll = dotAll;
    this.multiline = multiline;
    this.unicode = unicode;
  }

  /** Append an instruction, return its program-counter (instruction index). */
  emit(op: number, a = 0, b = 0): number {
    const pc = this.instrs.length;
    this.instrs.push([op, a, b]);
    return pc;
  }

  /** Patch operand `a`/`b` of a previously emitted instruction. */
  private patchA(pc: number, a: number): void {
    this.instrs[pc]![1] = a;
  }
  private patchB(pc: number, b: number): void {
    this.instrs[pc]![2] = b;
  }

  private here(): number {
    return this.instrs.length;
  }

  /** Set the base index for scratch slots (called once nGroups is known). */
  setScratchBase(base: number): void {
    this.scratchBase = base;
  }

  /** Claim the next scratch capture slot for a PROGRESS guard (#1959). */
  private allocScratch(): number {
    return this.scratchBase + this.scratchCount++;
  }

  /**
   * Emit a `CLEAR` at a quantifier-iteration head that resets the body's
   * capture-group slots to -1 (§22.2.2.3.1 RepeatMatcher, #1960). No-op when the
   * body has no capture groups. The slot range is `[2*lo, 2*hi+1]` for the
   * group-index span `[lo, hi]`. Lookbehind bodies (reversed) store group spans
   * the same way, so the same range applies.
   */
  private emitClearForBody(body: ReNode): void {
    const span = captureSpan(body);
    if (span === null) return;
    this.emit(ReOp.CLEAR, 2 * span[0], 2 * span[1] + 1);
  }

  /** Add a class to the class table, return its start offset. */
  private addClass(ranges: Array<[number, number]>): number {
    // Binary-search membership requires sorted, disjoint ranges. Legacy
    // source-order classes and case-fold augmentation need not arrive sorted,
    // so canonicalise once at compile time. #3652.
    const sorted = ranges
      .map(([lo, hi]) => [lo, hi] as [number, number])
      .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const normalized: Array<[number, number]> = [];
    for (const [lo, hi] of sorted) {
      const last = normalized[normalized.length - 1];
      if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
      else normalized.push([lo, hi]);
    }
    const offset = this.classTable.length;
    this.classTable.push(normalized.length);
    for (const [lo, hi] of normalized) {
      this.classTable.push(lo, hi);
    }
    return offset;
  }

  /**
   * (#3673 round 16) Pure-literal codes of a node, or undefined when it is
   * anything but a `char` / concat-of-`char`s. Used by the alternation trie.
   */
  private literalCodes(node: ReNode): number[] | undefined {
    if (node.kind === "char") return [node.code];
    if (node.kind === "concat") {
      const codes: number[] = [];
      for (const part of node.parts) {
        if (part.kind !== "char") return undefined;
        codes.push(part.code);
      }
      return codes;
    }
    return undefined;
  }

  /**
   * (#3673 round 16) Shared-prefix (first-char-grouped) emission for an
   * alternation whose options are all NON-EMPTY pure literals — the acorn
   * keyword-regex shape. Grouping options with DISTINCT first chars is
   * priority-safe: their branches consume disjoint next chars, so at most one
   * can match any subject continuation and ordered-alternation semantics are
   * unobservable across groups; options sharing a first char keep their
   * original relative order inside the group (recursively — prefix words
   * become ε suffixes, which BLOCK grouping across them since ε consumes
   * nothing and priority against later options is observable under anchor
   * backtracking). Case-insensitive alternations bail: folded first chars can
   * collide, breaking the disjointness argument.
   */
  private tryEmitLiteralAltTrie(options: readonly ReNode[]): boolean {
    if (this.caseInsensitive) return false;
    if (options.length < 4) return false;
    const lits: number[][] = [];
    for (const o of options) {
      const codes = this.literalCodes(o);
      if (codes === undefined || codes.length === 0) return false;
      lits.push(codes);
    }
    this.emitLitAltGrouped(lits);
    return true;
  }

  private emitLitAltGrouped(lits: number[][]): void {
    type Branch = { eps: true } | { eps: false; c: number; suffixes: number[][] };
    const branches: Branch[] = [];
    const idxByChar = new Map<number, number>();
    for (const l of lits) {
      if (l.length === 0) {
        branches.push({ eps: true });
        idxByChar.clear(); // ε blocks grouping across it (priority-observable)
        continue;
      }
      const c = l[0]!;
      const gi = idxByChar.get(c);
      if (gi !== undefined) {
        (branches[gi] as { eps: false; c: number; suffixes: number[][] }).suffixes.push(l.slice(1));
      } else {
        idxByChar.set(c, branches.length);
        branches.push({ eps: false, c, suffixes: [l.slice(1)] });
      }
    }
    const jmpEnds: number[] = [];
    for (let i = 0; i < branches.length; i++) {
      const isLast = i === branches.length - 1;
      let split = -1;
      if (!isLast) {
        split = this.emit(ReOp.SPLIT, 0, 0);
        this.patchA(split, this.here());
      }
      const b = branches[i]!;
      if (!b.eps) {
        this.emit(ReOp.CHAR, b.c);
        if (b.suffixes.length === 1) {
          for (const code of b.suffixes[0]!) this.emit(ReOp.CHAR, code);
        } else {
          this.emitLitAltGrouped(b.suffixes);
        }
      }
      if (!isLast) {
        jmpEnds.push(this.emit(ReOp.JMP, 0));
        this.patchB(split, this.here());
      }
    }
    const end = this.here();
    for (const j of jmpEnds) this.patchA(j, end);
  }

  compileNode(node: ReNode): void {
    switch (node.kind) {
      case "char": {
        if (!this.caseInsensitive) {
          this.emit(ReOp.CHAR, node.code);
          return;
        }
        if (this.unicode) {
          // u/v mode: the parser already folded cased atoms to classes via the
          // host oracle, so a bare CHAR here is non-cased — ASCII fold is a no-op.
          this.emit(ReOp.CHARI, asciiFold(node.code));
          return;
        }
        // Non-Unicode `i`: full legacy (§22.2.2.9.3) Canonicalize, resolved at
        // compile time into the code-unit equivalence set and desugared to a
        // plain CHAR/CLASS so the VM needs no runtime Unicode tables. #2720.
        const units = foldCharUnitsLegacy(node.code);
        if (units.length === 1) {
          this.emit(ReOp.CHAR, units[0]!);
        } else {
          const offset = this.addClass(unitsToRanges(units));
          this.emit(ReOp.CLASS, offset, 0);
        }
        return;
      }
      case "any":
        // `dotAll`=1 under the `s` flag (`.` matches line terminators too);
        // otherwise 0 (the VM excludes \n \r U+2028 U+2029).
        this.emit(ReOp.ANY, this.dotAll ? 1 : 0);
        return;
      case "udot":
        // u/v-mode `.` — one CODE POINT. Resolve the modifier-scoped dotAll
        // set here, then keep it compact for CPCLASS. #3652.
        this.emit(ReOp.CPCLASS, this.addClass(dotCpRanges(this.dotAll)), 0);
        return;
      case "class": {
        // Non-Unicode `i` uses full legacy (§22.2.2.9.3) case folding; u/v mode
        // classes are already host-folded at parse time, so keep the (harmless,
        // idempotent) ASCII fold there to avoid touching that path. #2720.
        let ranges = node.ranges;
        if (this.caseInsensitive) {
          ranges = this.unicode ? foldClassRangesAscii(node.ranges) : foldClassRangesLegacy(node.ranges);
        }
        const offset = this.addClass(ranges);
        this.emit(ReOp.CLASS, offset, node.negated ? 1 : 0);
        return;
      }
      case "cpclass": {
        const offset = this.addClass(node.ranges);
        this.emit(ReOp.CPCLASS, offset, node.negated ? 1 : 0);
        return;
      }
      case "bol":
        // operand a = multiline flag: when 1, `^` also matches right after a
        // line terminator, not only at position 0.
        this.emit(ReOp.BOL, this.multiline ? 1 : 0);
        return;
      case "eol":
        // operand a = multiline flag: when 1, `$` also matches right before a
        // line terminator, not only at the end of input.
        this.emit(ReOp.EOL, this.multiline ? 1 : 0);
        return;
      case "wordBoundary":
        // operand a = negated (`\B`). #1912.
        this.emit(ReOp.WBOUND, node.negated ? 1 : 0);
        return;
      case "backref":
        // operand a = group index, b = case-insensitive comparison. #1912.
        this.emit(ReOp.BACKREF, node.index, this.caseInsensitive ? 1 : 0);
        return;
      case "lookaround": {
        // operand a = sub-program start (patched when the queue drains),
        // b = bit0 negated | bit1 behind. The body is queued — sub-programs
        // live after the main MATCH so the linear flow never falls into them.
        const flags = (node.negated ? 1 : 0) | (node.behind ? 2 : 0);
        const pc = this.emit(ReOp.LOOKAROUND, 0, flags);
        this.pendingSubs.push({
          node: node.behind ? reverseNode(node.node) : node.node,
          patchPc: pc,
          reversed: node.behind,
          caseInsensitive: this.caseInsensitive,
          dotAll: this.dotAll,
          multiline: this.multiline,
        });
        return;
      }
      case "modGroup": {
        // `(?ims-ims:…)` — scope the emitter flags over the subtree. #1911.
        const saved: [boolean, boolean, boolean] = [this.caseInsensitive, this.dotAll, this.multiline];
        if (node.add & RE_FLAG_I) this.caseInsensitive = true;
        if (node.remove & RE_FLAG_I) this.caseInsensitive = false;
        if (node.add & RE_FLAG_S) this.dotAll = true;
        if (node.remove & RE_FLAG_S) this.dotAll = false;
        if (node.add & RE_FLAG_M) this.multiline = true;
        if (node.remove & RE_FLAG_M) this.multiline = false;
        this.compileNode(node.node);
        [this.caseInsensitive, this.dotAll, this.multiline] = saved;
        return;
      }
      case "concat":
        for (const part of node.parts) this.compileNode(part);
        return;
      case "alt": {
        // (#3673 round 16) Literal alternations (acorn's keyword regexes —
        // `^(?:break|case|…)$`, ~35 words) compile to a shared-prefix trie so a
        // probe fails after ONE first-char compare per distinct group instead
        // of pushing one backtrack frame per word. Falls through to the linear
        // chain for anything non-literal / case-insensitive / small.
        if (this.tryEmitLiteralAltTrie(node.options)) return;
        // For options [a,b,c]: SPLIT a,(b|c) ; a ; JMP end ; SPLIT b,c ; b ; JMP end ; c ; end:
        const jmpEnds: number[] = [];
        for (let i = 0; i < node.options.length; i++) {
          const isLast = i === node.options.length - 1;
          if (!isLast) {
            const split = this.emit(ReOp.SPLIT, 0, 0);
            this.patchA(split, this.here());
            this.compileNode(node.options[i]!);
            jmpEnds.push(this.emit(ReOp.JMP, 0));
            this.patchB(split, this.here());
          } else {
            this.compileNode(node.options[i]!);
          }
        }
        const end = this.here();
        for (const j of jmpEnds) this.patchA(j, end);
        return;
      }
      case "star": {
        // Greedy: SAVE? sp ; L1: SPLIT body,exit ; CLEAR? ; body ; PROGRESS? ; JMP L1 ; exit
        // A nullable body needs the empty-iteration guard (§22.2.2.3.1): record
        // sp before SPLIT, and after the body PROGRESS fails the iteration when
        // sp is unchanged, so the loop can't spin on a zero-width match (#1959).
        // CLEAR resets the subtree's capture slots on each iteration entry so a
        // group that doesn't participate this time reads as unset (#1960).
        const guard = canMatchEmpty(node.node) ? this.allocScratch() : -1;
        if (guard >= 0) this.emit(ReOp.SAVE, guard);
        const l1 = this.emit(ReOp.SPLIT, 0, 0);
        const bodyStart = this.here();
        this.emitClearForBody(node.node);
        this.compileNode(node.node);
        if (guard >= 0) this.emit(ReOp.PROGRESS, guard);
        this.emit(ReOp.JMP, guard >= 0 ? l1 - 1 : l1);
        const exit = this.here();
        if (node.greedy) {
          this.patchA(l1, bodyStart);
          this.patchB(l1, exit);
        } else {
          this.patchA(l1, exit);
          this.patchB(l1, bodyStart);
        }
        return;
      }
      case "plus": {
        // The first repetition is mandatory (min=1), so it is NOT guarded — an
        // empty first match is a legitimate one-repetition match. Only the loop
        // back-edge (the min=0 repetitions) needs the empty-iteration guard.
        // Non-nullable body keeps the tight original encoding:
        //   L1: body ; SPLIT L1,exit ; exit
        // Nullable body lowers to one body + a guarded star for the rest:
        //   body ; SAVE g ; L2: SPLIT body2,exit ; body2 ; PROGRESS g ; JMP L2 ; exit
        const guard = canMatchEmpty(node.node) ? this.allocScratch() : -1;
        if (guard < 0) {
          // L1: CLEAR? ; body ; SPLIT L1,exit ; exit — CLEAR runs each iteration
          // (the SPLIT back-edge re-enters at L1), resetting the subtree's
          // captures so only the final iteration participates (#1960).
          const l1 = this.here();
          this.emitClearForBody(node.node);
          this.compileNode(node.node);
          const split = this.emit(ReOp.SPLIT, 0, 0);
          const exit = this.here();
          if (node.greedy) {
            this.patchA(split, l1);
            this.patchB(split, exit);
          } else {
            this.patchA(split, exit);
            this.patchB(split, l1);
          }
          return;
        }
        // Nullable body: mandatory first match (cleared), then a guarded star
        // (which clears on every iteration of the remaining repetitions).
        this.emitClearForBody(node.node);
        this.compileNode(node.node);
        this.compileNode({ kind: "star", node: node.node, greedy: node.greedy });
        return;
      }
      case "opt": {
        // SPLIT body,exit ; body ; exit:   (greedy: body first)
        const split = this.emit(ReOp.SPLIT, 0, 0);
        const bodyStart = this.here();
        this.compileNode(node.node);
        const exit = this.here();
        if (node.greedy) {
          this.patchA(split, bodyStart);
          this.patchB(split, exit);
        } else {
          this.patchA(split, exit);
          this.patchB(split, bodyStart);
        }
        return;
      }
      case "repeat": {
        this.compileRepeat(node);
        return;
      }
      case "group": {
        if (node.capIndex < 0) {
          this.compileNode(node.node);
          return;
        }
        // In a reversed (lookbehind) sub-program sp moves right-to-left, so
        // the END slot is recorded first — capture spans stay [left, right].
        const first = this.reversed ? 2 * node.capIndex + 1 : 2 * node.capIndex;
        const second = this.reversed ? 2 * node.capIndex : 2 * node.capIndex + 1;
        this.emit(ReOp.SAVE, first);
        this.compileNode(node.node);
        this.emit(ReOp.SAVE, second);
        return;
      }
    }
  }

  /** Expand `{min,max}` into mandatory copies + optional/star tail. */
  private compileRepeat(node: ReNode & { kind: "repeat" }): void {
    const { min, max, greedy } = node;
    if (max !== -1 && (max > MAX_REPEAT_EXPANSION || min > MAX_REPEAT_EXPANSION)) {
      throw new RepeatTooLargeError(`{${min},${max === -1 ? "" : max}} exceeds expansion cap`);
    }
    // Mandatory copies: node repeated `min` times.
    for (let i = 0; i < min; i++) this.compileNode(node.node);
    if (max === -1) {
      // `{min,}` → after the mandatory copies, a greedy/lazy star.
      this.compileNode({ kind: "star", node: node.node, greedy });
    } else {
      // `{min,max}` → (max-min) optional copies.
      for (let i = min; i < max; i++) {
        this.compileNode({ kind: "opt", node: node.node, greedy });
      }
    }
  }

  /**
   * Emit all queued lookaround sub-programs (each body + MATCH), patching the
   * owning LOOKAROUND's `a` operand. Bodies may queue further lookarounds —
   * the queue keeps draining. #1911.
   */
  drainPendingSubs(): void {
    while (this.pendingSubs.length > 0) {
      const sub = this.pendingSubs.shift()!;
      this.patchA(sub.patchPc, this.here());
      const saved: [boolean, boolean, boolean, boolean] = [
        this.caseInsensitive,
        this.dotAll,
        this.multiline,
        this.reversed,
      ];
      this.caseInsensitive = sub.caseInsensitive;
      this.dotAll = sub.dotAll;
      this.multiline = sub.multiline;
      this.reversed = sub.reversed;
      this.compileNode(sub.node);
      this.emit(ReOp.MATCH);
      [this.caseInsensitive, this.dotAll, this.multiline, this.reversed] = saved;
    }
  }

  finish(): number[] {
    // Whole-match capture (slot 0/1) + MATCH terminator are added by compile().
    const prog: number[] = [];
    for (const [op, a, b] of this.instrs) prog.push(op, a, b);
    return prog;
  }
}

/**
 * Conservative nullability test (#1959): can `node` match the empty string?
 * Used to decide whether a star/plus loop needs the empty-iteration PROGRESS
 * guard. Over-approximating (returning true when unsure) only adds a cheap
 * guard; under-approximating would risk the silent-no-match bug, so unknown
 * shapes default to nullable. Zero-width assertions (`^`, `$`, `\b`,
 * lookaround) are nullable; consuming atoms (char/class/any) are not.
 */
export function canMatchEmpty(node: ReNode): boolean {
  switch (node.kind) {
    case "char":
    case "any":
    case "udot":
    case "class":
    case "cpclass":
      return false;
    case "backref":
      // An unset capture matches empty, and a participating capture may itself
      // span zero input units. Conservatively guard quantified backreferences.
      return true;
    case "bol":
    case "eol":
    case "wordBoundary":
    case "lookaround":
      return true;
    case "star":
    case "opt":
      return true;
    case "plus":
      return canMatchEmpty(node.node);
    case "repeat":
      return node.min === 0 || canMatchEmpty(node.node);
    case "group":
    case "modGroup":
      return canMatchEmpty(node.node);
    case "concat":
      return node.parts.every(canMatchEmpty);
    case "alt":
      return node.options.some(canMatchEmpty);
  }
}

/**
 * Capture-group index span of a subtree (#1960): `[min, max]` of every group's
 * `capIndex` reachable inside `node`, or null when it contains no captures.
 * Used to emit a `CLEAR` at each quantifier-iteration head so stale captures
 * from an earlier iteration don't leak (§22.2.2.3.1 RepeatMatcher). Lookaround
 * bodies are NOT descended into — their captures live in separate sub-programs
 * governed by the lookaround's own atomic attempt, not the outer loop.
 */
export function captureSpan(node: ReNode): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const visit = (n: ReNode): void => {
    switch (n.kind) {
      case "group":
        if (n.capIndex >= 0) {
          if (n.capIndex < lo) lo = n.capIndex;
          if (n.capIndex > hi) hi = n.capIndex;
        }
        visit(n.node);
        return;
      case "concat":
        for (const p of n.parts) visit(p);
        return;
      case "alt":
        for (const o of n.options) visit(o);
        return;
      case "star":
      case "plus":
      case "opt":
      case "modGroup":
      case "repeat":
        visit(n.node);
        return;
      // lookaround: separate sub-program — do not descend.
      // char/any/udot/class/cpclass/bol/eol/wordBoundary/backref define no groups.
      default:
        return;
    }
  };
  visit(node);
  return hi >= lo ? [lo, hi] : null;
}

/** Thrown when `{n,m}` expansion would blow past the size cap. */
export class RepeatTooLargeError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RepeatTooLargeError";
  }
}

/** ASCII-only case fold (uppercase → lowercase). Phase 2a `i` is ASCII; full
 *  Unicode case folding is deferred (documented in the issue + test file). */
export function asciiFold(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code + 0x20;
  return code;
}

/**
 * For the `i` flag (ASCII), augment class ranges with their case counterparts
 * so a CLASS op stays a plain range-membership test (no per-op fold). For each
 * range overlapping `A-Z` we add the matching lowercase span and vice versa.
 * Letters only; non-letters are unaffected (ASCII case folding).
 */
export function foldClassRangesAscii(ranges: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [lo, hi] of ranges) {
    out.push([lo, hi]);
    // Uppercase portion [max(lo,A), min(hi,Z)] → add its lowercase image.
    const uLo = Math.max(lo, 0x41);
    const uHi = Math.min(hi, 0x5a);
    if (uLo <= uHi) out.push([uLo + 0x20, uHi + 0x20]);
    // Lowercase portion [max(lo,a), min(hi,z)] → add its uppercase image.
    const lLo = Math.max(lo, 0x61);
    const lHi = Math.min(hi, 0x7a);
    if (lLo <= lHi) out.push([lLo - 0x20, lHi - 0x20]);
  }
  return out;
}

/**
 * Structurally reverse an AST for lookbehind compilation (#1911): concat order
 * flips recursively so the body matches right-to-left when the VM runs with
 * direction -1. Alternative ORDER is preserved (only each option's contents
 * reverse). Lookaround nodes are leaves — their bodies are separate
 * sub-programs compiled in their own direction.
 */
export function reverseNode(node: ReNode): ReNode {
  switch (node.kind) {
    case "concat":
      return { kind: "concat", parts: [...node.parts].reverse().map(reverseNode) };
    case "alt":
      return { kind: "alt", options: node.options.map(reverseNode) };
    case "star":
      return { kind: "star", node: reverseNode(node.node), greedy: node.greedy };
    case "plus":
      return { kind: "plus", node: reverseNode(node.node), greedy: node.greedy };
    case "opt":
      return { kind: "opt", node: reverseNode(node.node), greedy: node.greedy };
    case "repeat":
      return { kind: "repeat", node: reverseNode(node.node), min: node.min, max: node.max, greedy: node.greedy };
    case "group":
      return { kind: "group", node: reverseNode(node.node), capIndex: node.capIndex, name: node.name };
    case "modGroup":
      return { kind: "modGroup", add: node.add, remove: node.remove, node: reverseNode(node.node) };
    default:
      // char / any / udot / class / cpclass / bol / eol / wordBoundary /
      // backref / lookaround — single atoms or position assertions; nothing
      // to reverse internally.
      return node;
  }
}

/**
 * Compile a parsed pattern + flag bits into a runnable program. Wraps the body
 * in SAVE 0 … SAVE 1 (whole match) and a trailing MATCH, then appends the
 * queued lookaround sub-programs.
 */
export function compileParsed(parsed: ParsedRegex, flags: number): CompiledRegex {
  const caseInsensitive = (flags & RE_FLAG_I) !== 0;
  const dotAll = (flags & RE_FLAG_S) !== 0;
  const multiline = (flags & RE_FLAG_M) !== 0;
  const unicode = (flags & (RE_FLAG_U | RE_FLAG_V)) !== 0;
  const nGroups = parsed.numCaptures + 1;
  const em = new Emitter(caseInsensitive, dotAll, multiline, unicode);
  // Scratch slots for PROGRESS guards (#1959) live after the 2*nGroups capture
  // slots, so the emitter must know the capture-slot count before lowering.
  em.setScratchBase(2 * nGroups);
  // SAVE 0 (match start)
  em.emit(ReOp.SAVE, 0);
  em.compileNode(parsed.root);
  // SAVE 1 (match end), MATCH
  em.emit(ReOp.SAVE, 1);
  em.emit(ReOp.MATCH);
  // Lookaround sub-programs live after the main MATCH (#1911).
  em.drainPendingSubs();
  const prog = em.finish();
  void INSTR_WIDTH; // width is enforced by the [op,a,b] tuple shape.
  return {
    prog,
    classTable: em.classTable,
    nGroups,
    nScratch: em.scratchCount,
    flags,
    // #2588 — preserve the parser's name→1-based-index map so the standalone
    // backend can materialise the `groups` result object and resolve
    // `$<name>` substitution. A fresh Map (not the parser's instance) keeps
    // CompiledRegex self-contained.
    groupNames: new Map(parsed.groupNames),
  };
}

/** Convenience: parse + compile in one step. Throws RegexUnsupportedError /
 *  RepeatTooLargeError for out-of-subset patterns. */
export function compilePattern(pattern: string, flags: number): CompiledRegex {
  return compileParsed(parsePattern(pattern, flags), flags);
}
