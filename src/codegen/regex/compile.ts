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
 */
import { INSTR_WIDTH, ReOp, RE_FLAG_I, RE_FLAG_M, RE_FLAG_S, type CompiledRegex } from "./bytecode.js";
import { parsePattern, type ParsedRegex, type ReNode } from "./parse.js";

/** Bounded repetition expansion guard — `{n,m}` with large m is rewritten to
 *  repeated atoms, so cap the expansion to keep programs small. */
const MAX_REPEAT_EXPANSION = 1000;

class Emitter {
  /** Instruction records, each `[op,a,b]`, flattened on finish. */
  private readonly instrs: Array<[number, number, number]> = [];
  /** Flat class table; class offset = index of its rangeCount cell. */
  readonly classTable: number[] = [];
  private readonly caseInsensitive: boolean;
  /** dotAll (`s` flag): `.` matches line terminators too. */
  private readonly dotAll: boolean;
  /** multiline (`m` flag): `^`/`$` match at line boundaries, not just BOS/EOS. */
  private readonly multiline: boolean;

  constructor(caseInsensitive: boolean, dotAll: boolean, multiline: boolean) {
    this.caseInsensitive = caseInsensitive;
    this.dotAll = dotAll;
    this.multiline = multiline;
  }

  /** Append an instruction, return its program-counter (instruction index). */
  private emit(op: number, a = 0, b = 0): number {
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

  /** Add a class to the class table, return its start offset. */
  private addClass(ranges: Array<[number, number]>): number {
    const offset = this.classTable.length;
    this.classTable.push(ranges.length);
    for (const [lo, hi] of ranges) {
      this.classTable.push(lo, hi);
    }
    return offset;
  }

  compileNode(node: ReNode): void {
    switch (node.kind) {
      case "char": {
        if (this.caseInsensitive) {
          this.emit(ReOp.CHARI, asciiFold(node.code));
        } else {
          this.emit(ReOp.CHAR, node.code);
        }
        return;
      }
      case "any":
        // `dotAll`=1 under the `s` flag (`.` matches line terminators too);
        // otherwise 0 (the VM excludes \n \r U+2028 U+2029).
        this.emit(ReOp.ANY, this.dotAll ? 1 : 0);
        return;
      case "class": {
        const ranges = this.caseInsensitive ? foldClassRangesAscii(node.ranges) : node.ranges;
        const offset = this.addClass(ranges);
        this.emit(ReOp.CLASS, offset, node.negated ? 1 : 0);
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
      case "concat":
        for (const part of node.parts) this.compileNode(part);
        return;
      case "alt": {
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
        // L1: SPLIT body,exit ; body ; JMP L1 ; exit:   (greedy: body first)
        const l1 = this.emit(ReOp.SPLIT, 0, 0);
        const bodyStart = this.here();
        this.compileNode(node.node);
        this.emit(ReOp.JMP, l1);
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
        // L1: body ; SPLIT L1,exit ; exit:   (greedy: loop first)
        const l1 = this.here();
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
        this.emit(ReOp.SAVE, 2 * node.capIndex);
        this.compileNode(node.node);
        this.emit(ReOp.SAVE, 2 * node.capIndex + 1);
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

  finish(): number[] {
    // Whole-match capture (slot 0/1) + MATCH terminator are added by compile().
    const prog: number[] = [];
    for (const [op, a, b] of this.instrs) prog.push(op, a, b);
    return prog;
  }
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
 * Compile a parsed pattern + flag bits into a runnable program. Wraps the body
 * in SAVE 0 … SAVE 1 (whole match) and a trailing MATCH.
 */
export function compileParsed(parsed: ParsedRegex, flags: number): CompiledRegex {
  const caseInsensitive = (flags & RE_FLAG_I) !== 0;
  const dotAll = (flags & RE_FLAG_S) !== 0;
  const multiline = (flags & RE_FLAG_M) !== 0;
  const em = new Emitter(caseInsensitive, dotAll, multiline);
  // SAVE 0 (match start)
  emitRaw(em, ReOp.SAVE, 0);
  em.compileNode(parsed.root);
  // SAVE 1 (match end), MATCH
  emitRaw(em, ReOp.SAVE, 1);
  emitRaw(em, ReOp.MATCH);
  const prog = em.finish();
  void INSTR_WIDTH; // width is enforced by the [op,a,b] tuple shape.
  return {
    prog,
    classTable: em.classTable,
    nGroups: parsed.numCaptures + 1,
    flags,
  };
}

// Emitter.emit is private; this thin shim lets compileParsed add the wrapper
// SAVE/MATCH without exposing emit on the public surface.
function emitRaw(em: Emitter, op: number, a = 0, b = 0): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (em as any).emit(op, a, b);
}

/** Convenience: parse + compile in one step. Throws RegexUnsupportedError /
 *  RepeatTooLargeError for out-of-subset patterns. */
export function compilePattern(pattern: string, flags: number): CompiledRegex {
  return compileParsed(parsePattern(pattern), flags);
}
