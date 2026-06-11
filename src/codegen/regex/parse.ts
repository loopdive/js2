// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1539 Phase 2a/2b — Regex pattern parser (compile-time, pure TypeScript).
 *
 * Recursive-descent parser for the Phase-2a/2b subset of ECMAScript regular
 * expressions (ES2024 §22.2.1 + Annex B.1.2). Produces a small AST consumed by
 * `compile.ts`. Anything outside the subset throws `RegexUnsupportedError`,
 * which the codegen entry points turn into a clean #1539-phased compile error
 * (the "narrowed refusal" the architect requires). Genuinely *invalid* patterns
 * (real ES SyntaxErrors, e.g. `[b-a]` or `a**`) also surface as
 * `RegexUnsupportedError` here — the `new RegExp(...)` codegen entry point
 * (#1912) consults the compile-time host `RegExp` constructor to tell the two
 * apart and lowers real SyntaxErrors to a runtime `throw`.
 *
 * Supported in 2a:
 *   - literal code units, `.`
 *   - char classes `[...]` / `[^...]` with ranges and `\d \D \w \W \s \S`
 *   - escapes `\n \r \t \f \v`, `\xHH`, `\uHHHH`, escaped metacharacters
 *   - anchors `^` `$`
 *   - quantifiers `* + ?` and `{n}` `{n,}` `{n,m}`, optional lazy `?` suffix
 *   - alternation `|`
 *   - groups `(…)` capturing, `(?:…)` non-capturing, `(?<name>…)` named
 *
 * Added in 2b (#1912):
 *   - word boundaries `\b` / `\B`
 *   - backreferences `\1`…`\99` and `\k<name>` (forward refs allowed; an
 *     out-of-range decimal escape falls back to Annex B legacy octal)
 *   - negated shorthands inside classes (`[\D]` `[\W]` `[\S]`) via compile-time
 *     range complement
 *   - Annex B class-range compatibility: a shorthand adjacent to `-` makes the
 *     `-` literal (`[\d-z]` = `\d ∪ {-} ∪ {z}`), never a range
 *   - Annex B legacy octal escapes (`\0`…`\377`) and `\cX` control escapes
 *
 * Added in 2d Slice A (#1911):
 *   - lookahead/lookbehind `(?=) (?!) (?<=) (?<!)` — compiled to recursive
 *     sub-programs; quantified lookarounds (Annex B QuantifiableAssertion)
 *     rewrite to their zero-width-idempotent equivalent
 *   - inline modifier groups `(?ims-ims:…)` (regexp-modifiers proposal)
 *
 * Still refused (each cites the phase/slice that adds it):
 *   - Unicode property escapes `\p{…}` / `\P{…}`   → 2d Slice B
 *   - the `u`/`v` flags' code-point semantics      → 2d Slice B (parse stays UTF-16)
 */
import { RE_FLAG_I, RE_FLAG_M, RE_FLAG_S, RE_FLAG_U, RE_FLAG_V, RegexUnsupportedError } from "./bytecode.js";
import { codePointSource, cpRangesToNode, enumerateClassRanges } from "./unicode.js";

export type ReNode =
  | { kind: "char"; code: number }
  | { kind: "any" }
  | { kind: "class"; ranges: Array<[number, number]>; negated: boolean }
  | { kind: "bol" }
  | { kind: "eol" }
  | { kind: "wordBoundary"; negated: boolean }
  | { kind: "backref"; index: number }
  | { kind: "lookaround"; node: ReNode; negated: boolean; behind: boolean }
  // Inline modifier group `(?ims-ims:…)`: add/remove are RE_FLAG_I|M|S masks.
  | { kind: "modGroup"; add: number; remove: number; node: ReNode }
  // `.` under u/v — desugared at COMPILE time (dotAll is modifier-scoped). #1911 Slice B.
  | { kind: "udot" }
  | { kind: "concat"; parts: ReNode[] }
  | { kind: "alt"; options: ReNode[] }
  | { kind: "star"; node: ReNode; greedy: boolean }
  | { kind: "plus"; node: ReNode; greedy: boolean }
  | { kind: "opt"; node: ReNode; greedy: boolean }
  | { kind: "repeat"; node: ReNode; min: number; max: number; greedy: boolean } // max=-1 => unbounded
  | { kind: "group"; node: ReNode; capIndex: number; name: string | null }; // capIndex<0 => non-capturing

export interface ParsedRegex {
  root: ReNode;
  /** Number of capturing groups (group 0 / whole match NOT included). */
  numCaptures: number;
  /** Capture name → 1-based group index for named groups. */
  groupNames: Map<string, number>;
}

const DIGIT: Array<[number, number]> = [[0x30, 0x39]];
const WORD: Array<[number, number]> = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
// \s per §22.2.2.1: \t \n \v \f \r space      -
//
const SPACE: Array<[number, number]> = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];

/**
 * Complement a range list over the full UTF-16 code-unit space [0, 0xFFFF].
 * Used to lower negated shorthands *inside* a class (`[\D]`) to plain ranges,
 * since a class is the union of its members and per-member negation cannot be
 * expressed in the run-length class table. #1912.
 */
export function complementRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  let next = 0;
  for (const [lo, hi] of sorted) {
    if (lo > next) out.push([next, lo - 1]);
    next = Math.max(next, hi + 1);
  }
  if (next <= 0xffff) out.push([next, 0xffff]);
  return out;
}

const NOT_DIGIT = complementRanges(DIGIT);
const NOT_WORD = complementRanges(WORD);
const NOT_SPACE = complementRanges(SPACE);

/**
 * Pre-scan the pattern for the total capture-group count and the named-group
 * table. Both are needed *before* the descent parse: a decimal escape is a
 * backreference only when its value does not exceed the total group count
 * (§22.2.1 NcapturingParens — counted over the WHOLE pattern, so `\1(a)` is a
 * legal forward reference), and `\k<name>` may reference a group declared
 * later. Skips class bodies and escapes so `([(]` does not miscount.
 */
function scanGroups(src: string): { count: number; names: Map<string, number> } {
  let i = 0;
  let inClass = false;
  let count = 0;
  const names = new Map<string, number>();
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      i++;
      continue;
    }
    if (c === "(") {
      if (src[i + 1] === "?") {
        if (src[i + 2] === "<" && src[i + 3] !== "=" && src[i + 3] !== "!") {
          let j = i + 3;
          let name = "";
          while (j < src.length && src[j] !== ">") name += src[j++];
          count++;
          if (!names.has(name)) names.set(name, count);
        }
      } else {
        count++;
      }
    }
    i++;
  }
  return { count, names };
}

class Parser {
  private pos = 0;
  numCaptures = 0;
  /** Total capture count over the whole pattern (pre-scanned). */
  private readonly totalCaptures: number;
  /** Name → group index over the whole pattern (pre-scanned, forward refs ok). */
  readonly groupNames: Map<string, number>;
  /** Code-point mode (`u` or `v`). #1911 Slice B. */
  private readonly unicode: boolean;
  /** UnicodeSets mode (`v`) — affects class-source extraction (nesting). */
  private readonly vMode: boolean;
  /** Effective `i` state at the current syntactic position (modifier-scoped) —
   *  drives host enumeration flags for code-point atoms in u/v mode. */
  private iState: boolean;

  constructor(
    private readonly src: string,
    flags = 0,
  ) {
    const scan = scanGroups(src);
    this.totalCaptures = scan.count;
    this.groupNames = scan.names;
    this.unicode = (flags & (RE_FLAG_U | RE_FLAG_V)) !== 0;
    this.vMode = (flags & RE_FLAG_V) !== 0;
    this.iState = (flags & RE_FLAG_I) !== 0;
  }

  /** Host-enumeration flag string for the current position. */
  private enumFlags(): string {
    return (this.vMode ? "v" : "u") + (this.iState ? "i" : "");
  }

  /** Lower a single code point atom in u/v mode. Case-insensitive atoms are
   *  enumerated through the host (spec Canonicalize — Kelvin sign and friends);
   *  otherwise BMP → CHAR, astral → lead+trail concat. */
  private uChar(cp: number): ReNode {
    if (this.iState) {
      return cpRangesToNode(enumerateClassRanges(codePointSource(cp), this.enumFlags()));
    }
    if (cp > 0xffff) {
      const lead = 0xd800 + ((cp - 0x10000) >> 10);
      const trail = 0xdc00 + ((cp - 0x10000) & 0x3ff);
      return {
        kind: "concat",
        parts: [
          { kind: "char", code: lead },
          { kind: "char", code: trail },
        ],
      };
    }
    return { kind: "char", code: cp };
  }

  /** Enumerate a class-like source fragment under the current flags and lower
   *  it to the unit-level AST. */
  private uEnum(source: string): ReNode {
    return cpRangesToNode(enumerateClassRanges(source, this.enumFlags()));
  }

  /** Extract the raw `[...]` class source starting at the current `[`. In v
   *  mode classes nest (`[[a]&&[b]]`); in u mode the first unescaped `]`
   *  closes (`[` is a literal inside a u-mode class). The cursor advances past
   *  the closing bracket. */
  private extractClassSource(): string {
    const start = this.pos;
    this.pos++; // consume the opening "["
    let depth = 1;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === "\\") {
        this.pos += 2;
        continue;
      }
      if (this.vMode && c === "[") depth++;
      if (c === "]") {
        depth--;
        if (!this.vMode || depth === 0) {
          this.pos++;
          return this.src.slice(start, this.pos);
        }
      }
      this.pos++;
    }
    throw new RegexUnsupportedError("unterminated character class");
  }

  private peek(): string | undefined {
    return this.src[this.pos];
  }
  private next(): string {
    const c = this.src[this.pos];
    if (c === undefined) throw new RegexUnsupportedError("unexpected end of pattern");
    this.pos++;
    return c;
  }
  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  parse(): ReNode {
    const node = this.parseAlternation();
    if (!this.eof()) {
      // A stray ) or other leftover — surface as unsupported rather than wrong.
      throw new RegexUnsupportedError(`unexpected '${this.peek()}' at index ${this.pos}`);
    }
    return node;
  }

  private parseAlternation(): ReNode {
    const options: ReNode[] = [this.parseConcat()];
    while (this.peek() === "|") {
      this.next();
      options.push(this.parseConcat());
    }
    return options.length === 1 ? options[0]! : { kind: "alt", options };
  }

  private parseConcat(): ReNode {
    const parts: ReNode[] = [];
    while (!this.eof() && this.peek() !== "|" && this.peek() !== ")") {
      parts.push(this.parseQuantified());
    }
    if (parts.length === 0) return { kind: "concat", parts: [] };
    return parts.length === 1 ? parts[0]! : { kind: "concat", parts };
  }

  private parseQuantified(): ReNode {
    const atom = this.parseAtom();
    const c = this.peek();
    const isAssertion = atom.kind === "bol" || atom.kind === "eol" || atom.kind === "wordBoundary";
    if (isAssertion && (c === "*" || c === "+" || c === "?")) {
      // Assertions are not quantifiable (§22.2.1 Term; Annex B only exempts
      // lookahead). `/\b*/` is a real SyntaxError — refuse instead of emitting
      // a zero-progress loop the VM would spin on until the step cap.
      throw new RegexUnsupportedError(`nothing to repeat at index ${this.pos}`);
    }
    if (c === "*" || c === "+" || c === "?") {
      this.next();
      const greedy = this.consumeLazy();
      // Annex B QuantifiableAssertion: a quantified lookaround is legal in
      // non-u mode. A lookaround is zero-width and deterministic at a fixed
      // position, so `X*`/`X{n,m}` collapse to `X?` (or `X` when min ≥ 1) —
      // rewriting avoids a zero-progress SPLIT loop in the VM. #1911.
      if (atom.kind === "lookaround") {
        if (c === "+") return atom;
        return { kind: "opt", node: atom, greedy };
      }
      if (c === "*") return { kind: "star", node: atom, greedy };
      if (c === "+") return { kind: "plus", node: atom, greedy };
      return { kind: "opt", node: atom, greedy };
    }
    if (c === "{") {
      const saved = this.pos;
      const bounds = this.tryParseBraceQuantifier();
      if (bounds) {
        if (isAssertion) {
          throw new RegexUnsupportedError(`nothing to repeat at index ${saved}`);
        }
        const greedy = this.consumeLazy();
        if (atom.kind === "lookaround") {
          // Zero-width idempotence (see above): {0,0} → ε, {0,…} → opt,
          // {n≥1,…} → atom.
          if (bounds[1] === 0) return { kind: "concat", parts: [] };
          return bounds[0] >= 1 ? atom : { kind: "opt", node: atom, greedy };
        }
        return { kind: "repeat", node: atom, min: bounds[0], max: bounds[1], greedy };
      }
      // Not a valid quantifier — treat `{` as a literal (Annex B). Rewind.
      this.pos = saved;
    }
    return atom;
  }

  private consumeLazy(): boolean {
    if (this.peek() === "?") {
      this.next();
      return false; // lazy
    }
    return true; // greedy
  }

  /** Returns [min,max] (max=-1 unbounded) or null if not a `{n}`/`{n,}`/`{n,m}`. */
  private tryParseBraceQuantifier(): [number, number] | null {
    if (this.peek() !== "{") return null;
    this.next();
    let minStr = "";
    while (this.peek() !== undefined && /[0-9]/.test(this.peek()!)) minStr += this.next();
    if (minStr === "") return null;
    const min = parseInt(minStr, 10);
    let max = min;
    if (this.peek() === ",") {
      this.next();
      let maxStr = "";
      while (this.peek() !== undefined && /[0-9]/.test(this.peek()!)) maxStr += this.next();
      max = maxStr === "" ? -1 : parseInt(maxStr, 10);
    }
    if (this.peek() !== "}") return null;
    this.next();
    if (max !== -1 && max < min) throw new RegexUnsupportedError("quantifier max < min");
    return [min, max];
  }

  private parseAtom(): ReNode {
    const c = this.peek();
    if (c === undefined) throw new RegexUnsupportedError("unexpected end of pattern");
    if (c === "(") return this.parseGroup();
    if (c === "[") {
      // u/v mode: hand the raw class source to the host enumerator — it
      // resolves negation, properties, set operations, and case folding
      // exactly; the result desugars to unit-level nodes. #1911 Slice B.
      if (this.unicode) return this.uEnum(this.extractClassSource());
      return this.parseClass();
    }
    if (c === ".") {
      this.next();
      // u/v: `.` matches one CODE POINT — desugared at compile time, where the
      // (modifier-scoped) dotAll state lives.
      return this.unicode ? { kind: "udot" } : { kind: "any" };
    }
    if (c === "^") {
      this.next();
      return { kind: "bol" };
    }
    if (c === "$") {
      this.next();
      return { kind: "eol" };
    }
    if (c === "\\") return this.parseEscapeAtom();
    if (c === "*" || c === "+" || c === "?") {
      throw new RegexUnsupportedError(`nothing to repeat at index ${this.pos}`);
    }
    // ordinary literal — in u/v mode read a full code point (surrogate pairs
    // in the source are ONE atom: quantifiers wrap the whole pair).
    if (this.unicode) {
      const cp = this.src.codePointAt(this.pos)!;
      this.pos += cp > 0xffff ? 2 : 1;
      return this.uChar(cp);
    }
    this.next();
    return { kind: "char", code: c.charCodeAt(0) };
  }

  private parseGroup(): ReNode {
    this.next(); // consume "("
    let capIndex = -1;
    let name: string | null = null;
    let lookaround: { negated: boolean; behind: boolean } | null = null;
    let modifiers: { add: number; remove: number } | null = null;
    if (this.peek() === "?") {
      this.next();
      const t = this.peek();
      if (t === ":") {
        this.next(); // non-capturing
      } else if (t === "<") {
        this.next();
        const after = this.peek();
        if (after === "=" || after === "!") {
          // lookbehind (?<= / ?<! — #1911
          this.next();
          lookaround = { negated: after === "!", behind: true };
        } else {
          // named capture (?<name>…)
          name = "";
          while (this.peek() !== ">" && !this.eof()) name += this.next();
          if (this.peek() !== ">") throw new RegexUnsupportedError("unterminated group name");
          this.next();
          capIndex = ++this.numCaptures;
          // The pre-scan kept the FIRST index for each name; a different index
          // here means the pattern re-declares the name — ES2025 duplicate
          // named groups stay outside the subset until the alternative-scoped
          // semantics land.
          if (this.groupNames.get(name) !== capIndex) {
            throw new RegexUnsupportedError(`duplicate capture group name '${name}'`);
          }
        }
      } else if (t === "=" || t === "!") {
        // lookahead (?= / ?! — #1911
        this.next();
        lookaround = { negated: t === "!", behind: false };
      } else if (t !== undefined && (t === "-" || t === "i" || t === "m" || t === "s")) {
        // Inline modifier group `(?ims-ims:…)` (regexp-modifiers). Only i/m/s
        // are valid; duplicates, letters on both sides, and an empty modifier
        // pair are real SyntaxErrors (the `new RegExp` host oracle confirms).
        modifiers = this.parseModifiers();
      } else {
        throw new RegexUnsupportedError(`unsupported group form '(?${t ?? ""}' — #1539 Phase 2d`);
      }
    } else {
      capIndex = ++this.numCaptures;
    }
    // Scope the parse-time `i` state over a modifier group's body — in u/v
    // mode the host enumeration of code-point atoms happens DURING parse, so
    // it must see the modifier-effective flags (the emitter still scopes the
    // unit-level i/m/s state at compile time). #1911 Slice B.
    const savedI = this.iState;
    if (modifiers !== null) {
      if (modifiers.add & RE_FLAG_I) this.iState = true;
      if (modifiers.remove & RE_FLAG_I) this.iState = false;
    }
    const inner = this.parseAlternation();
    this.iState = savedI;
    if (this.peek() !== ")") throw new RegexUnsupportedError("unterminated group");
    this.next();
    if (lookaround !== null) {
      return { kind: "lookaround", node: inner, negated: lookaround.negated, behind: lookaround.behind };
    }
    if (modifiers !== null) {
      return { kind: "modGroup", add: modifiers.add, remove: modifiers.remove, node: inner };
    }
    return { kind: "group", node: inner, capIndex, name };
  }

  /** Parse `ims-ims:` after `(?` (regexp-modifiers proposal). The cursor sits
   *  on the first modifier letter or `-`. Returns add/remove flag masks; the
   *  trailing `:` is consumed. */
  private parseModifiers(): { add: number; remove: number } {
    const flagBit = (ch: string): number => {
      if (ch === "i") return RE_FLAG_I;
      if (ch === "m") return RE_FLAG_M;
      if (ch === "s") return RE_FLAG_S;
      throw new RegexUnsupportedError(`invalid regexp modifier '${ch}'`);
    };
    let add = 0;
    let remove = 0;
    while (this.peek() !== undefined && this.peek() !== "-" && this.peek() !== ":") {
      const bit = flagBit(this.next());
      if ((add & bit) !== 0) throw new RegexUnsupportedError("duplicate regexp modifier");
      add |= bit;
    }
    if (this.peek() === "-") {
      this.next();
      while (this.peek() !== undefined && this.peek() !== ":") {
        const bit = flagBit(this.next());
        if (((add | remove) & bit) !== 0) throw new RegexUnsupportedError("duplicate regexp modifier");
        remove |= bit;
      }
    }
    if (this.peek() !== ":") throw new RegexUnsupportedError("unterminated regexp modifier group");
    this.next();
    if (add === 0 && remove === 0) throw new RegexUnsupportedError("empty regexp modifier group");
    return { add, remove };
  }

  private parseEscapeAtom(): ReNode {
    this.next(); // consume "\"
    const e = this.peek();
    if (e === undefined) throw new RegexUnsupportedError("trailing escape");
    // Class shorthands as standalone atoms. In u/v mode the negated forms
    // must consume a full CODE POINT (e.g. /\D/u consumes a whole astral
    // pair) and `\w`/`\W` fold differently under `i` (ſ, K) — route them
    // through the host enumerator. #1911 Slice B.
    if (e === "d" || e === "D" || e === "w" || e === "W" || e === "s" || e === "S") {
      this.next();
      if (this.unicode) return this.uEnum(`\\${e}`);
      if (e === "d") return { kind: "class", ranges: DIGIT, negated: false };
      if (e === "D") return { kind: "class", ranges: DIGIT, negated: true };
      if (e === "w") return { kind: "class", ranges: WORD, negated: false };
      if (e === "W") return { kind: "class", ranges: WORD, negated: true };
      if (e === "s") return { kind: "class", ranges: SPACE, negated: false };
      return { kind: "class", ranges: SPACE, negated: true };
    }
    if (e === "b" || e === "B") {
      // §22.2.2.6: under u+i, IsWordChar adds U+017F/U+212A — the VM's ASCII
      // word check would be silently wrong, so refuse that combination.
      if (this.unicode && this.iState) {
        throw new RegexUnsupportedError(`\\${e} with the u+i Unicode word characters — #1911 Slice B residual`);
      }
      this.next();
      return { kind: "wordBoundary", negated: e === "B" };
    }
    if (e >= "1" && e <= "9") {
      // DecimalEscape (§22.2.1): a backreference when the decimal value does
      // not exceed the pattern's total capture count (forward refs included);
      // otherwise Annex B legacy octal (`\1`-`\7`…) or an identity escape
      // (`\8` `\9`).
      const saved = this.pos;
      let digits = "";
      while (this.peek() !== undefined && this.peek()! >= "0" && this.peek()! <= "9") digits += this.next();
      const value = parseInt(digits, 10);
      if (value >= 1 && value <= this.totalCaptures) {
        return this.backrefNode(value);
      }
      // u/v mode has no legacy octal/identity fallback (§22.2.1 strict
      // DecimalEscape) — an out-of-range value is a real SyntaxError.
      if (this.unicode) {
        throw new RegexUnsupportedError(`invalid decimal escape \\${digits} in u/v mode`);
      }
      this.pos = saved;
      if (e >= "8") {
        this.next();
        return { kind: "char", code: e.charCodeAt(0) }; // \8 \9 — identity
      }
      return { kind: "char", code: this.parseLegacyOctal() };
    }
    if (e === "k") {
      // \k<name> — named backreference. Annex B (non-u only): when the
      // pattern declares NO named groups, `\k` is an identity escape for `k`.
      if (this.groupNames.size === 0) {
        if (this.unicode) throw new RegexUnsupportedError("\\k without a named group in u/v mode");
        this.next();
        return { kind: "char", code: 0x6b };
      }
      this.next();
      if (this.peek() !== "<") throw new RegexUnsupportedError("\\k must be followed by <name>");
      this.next();
      let name = "";
      while (this.peek() !== undefined && this.peek() !== ">") name += this.next();
      if (this.peek() !== ">") throw new RegexUnsupportedError("unterminated \\k<name>");
      this.next();
      const idx = this.groupNames.get(name);
      if (idx === undefined) {
        throw new RegexUnsupportedError(`\\k<${name}> references an undeclared group`);
      }
      return this.backrefNode(idx);
    }
    if (e === "p" || e === "P") {
      // u/v: property escapes resolve through the host enumerator. Non-u
      // `\p` stays a narrowed refusal (Annex B treats it as identity — rare).
      if (this.unicode) {
        return this.uEnum(this.extractPropertyEscapeSource());
      }
      throw new RegexUnsupportedError(`Unicode property escape \\${e}{…} — #1539 Phase 2d`);
    }
    if (this.unicode) return this.parseUnicodeEscapeTail();
    return { kind: "char", code: this.parseEscapedCodeUnit() };
  }

  /** Backreference node with the u+i guard: the VM compares ASCII-folded
   *  units, but u+i requires spec Canonicalize (full simple folding) — refuse
   *  rather than match wrongly. */
  private backrefNode(index: number): ReNode {
    if (this.unicode && this.iState) {
      throw new RegexUnsupportedError("backreference under u+i Canonicalize folding — #1911 Slice B residual");
    }
    return { kind: "backref", index };
  }

  /** Extract `\p{…}` / `\P{…}` source for host enumeration. The cursor sits ON
   *  the `p`/`P` (the backslash is consumed). */
  private extractPropertyEscapeSource(): string {
    const letter = this.next(); // p or P
    if (this.peek() !== "{") throw new RegexUnsupportedError(`\\${letter} must be followed by {…} in u/v mode`);
    let body = "";
    this.next();
    while (this.peek() !== undefined && this.peek() !== "}") body += this.next();
    if (this.peek() !== "}") throw new RegexUnsupportedError(`unterminated \\${letter}{…}`);
    this.next();
    return `\\${letter}{${body}}`;
  }

  /** u/v-mode escape tail for character-valued escapes: `\u{…}` code points,
   *  `\uHHHH` (lead+trail escape pairs combine into ONE code point atom per
   *  §22.2.2.7.3), and the unit-valued escapes shared with non-u mode — all
   *  routed through {@link uChar} so `i` folding applies. */
  private parseUnicodeEscapeTail(): ReNode {
    if (this.peek() === "u") {
      this.next();
      if (this.peek() === "{") {
        this.next();
        let hex = "";
        while (this.peek() !== undefined && this.peek() !== "}") hex += this.next();
        if (this.peek() !== "}" || !/^[0-9a-fA-F]+$/.test(hex)) {
          throw new RegexUnsupportedError("bad \\u{…} escape");
        }
        this.next();
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) throw new RegexUnsupportedError("\\u{…} out of code-point range");
        return this.uChar(cp);
      }
      const readHex4 = (): number => {
        const hex = this.next() + this.next() + this.next() + this.next();
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new RegexUnsupportedError("bad \\u escape");
        return parseInt(hex, 16);
      };
      const lead = readHex4();
      // A lead-surrogate escape immediately followed by a trail-surrogate
      // escape is a single code point in u/v mode.
      if (lead >= 0xd800 && lead <= 0xdbff && this.src.startsWith("\\u", this.pos)) {
        const saved = this.pos;
        this.pos += 2;
        try {
          const trail = readHex4();
          if (trail >= 0xdc00 && trail <= 0xdfff) {
            return this.uChar(0x10000 + ((lead - 0xd800) << 10) + (trail - 0xdc00));
          }
        } catch {
          // not a 4-hex escape — fall through to the lone lead
        }
        this.pos = saved;
      }
      return this.uChar(lead);
    }
    return this.uChar(this.parseEscapedCodeUnit());
  }

  /** Annex B LegacyOctalEscapeSequence: 1-3 octal digits, value ≤ 0o377. The
   *  cursor sits ON the first digit (the backslash is consumed). */
  private parseLegacyOctal(): number {
    let v = 0;
    let n = 0;
    while (n < 3 && this.peek() !== undefined && this.peek()! >= "0" && this.peek()! <= "7") {
      const nv = v * 8 + (this.src[this.pos]!.charCodeAt(0) - 0x30);
      if (nv > 0o377) break;
      this.next();
      v = nv;
      n++;
    }
    return v;
  }

  /** Parse the code unit denoted by an escape, with the backslash already
   *  consumed. Shared by atom and class parsing for non-class-shorthand
   *  escapes. */
  private parseEscapedCodeUnit(): number {
    const e = this.next();
    switch (e) {
      case "n":
        return 0x0a;
      case "r":
        return 0x0d;
      case "t":
        return 0x09;
      case "f":
        return 0x0c;
      case "v":
        return 0x0b;
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7": {
        // Annex B legacy octal (covers strict `\0` as the zero-digit case).
        // Backref classification happened in parseEscapeAtom; inside a class a
        // decimal escape is always octal/identity.
        this.pos--;
        return this.parseLegacyOctal();
      }
      case "8":
      case "9":
        return e.charCodeAt(0); // identity (Annex B)
      case "c": {
        // ControlLetter escape: \cA-\cZ \ca-\cz → code % 32. Anything else is
        // host-invalid or a deeper Annex B identity case — refuse.
        const l = this.peek();
        if (l !== undefined && ((l >= "A" && l <= "Z") || (l >= "a" && l <= "z"))) {
          this.next();
          return l.charCodeAt(0) % 32;
        }
        throw new RegexUnsupportedError("\\c without a control letter");
      }
      case "x": {
        const hex = this.next() + this.next();
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new RegexUnsupportedError(`bad \\x escape`);
        return parseInt(hex, 16);
      }
      case "u": {
        if (this.peek() === "{") throw new RegexUnsupportedError("\\u{…} code-point escape — #1539 Phase 2c/2d");
        const hex = this.next() + this.next() + this.next() + this.next();
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new RegexUnsupportedError(`bad \\u escape`);
        return parseInt(hex, 16);
      }
      default:
        // Escaped metacharacter or escaped literal — the char itself.
        return e.charCodeAt(0);
    }
  }

  private parseClass(): ReNode {
    this.next(); // consume "["
    let negated = false;
    if (this.peek() === "^") {
      this.next();
      negated = true;
    }
    const ranges: Array<[number, number]> = [];
    while (!this.eof() && this.peek() !== "]") {
      // Parse one class member: a code unit or a shorthand class.
      const member = this.parseClassMember();
      if (member.kind === "shorthand") {
        for (const r of member.ranges) ranges.push([r[0], r[1]]);
        // Annex B NonemptyClassRanges: a `-` after a class escape is a literal
        // `-` (unless it closes the class): `[\d-z]` = \d ∪ {-} ∪ {z}, never a
        // range. Consume it here so the next member parses standalone. #1912.
        if (this.peek() === "-" && this.src[this.pos + 1] !== "]" && this.src[this.pos + 1] !== undefined) {
          this.next();
          ranges.push([0x2d, 0x2d]);
        }
        continue;
      }
      const lo = member.code;
      // Range? `a-z`, but a trailing `-` (e.g. `[a-]`) is a literal `-`.
      if (this.peek() === "-" && this.src[this.pos + 1] !== "]" && this.src[this.pos + 1] !== undefined) {
        this.next(); // consume "-"
        const hiMember = this.parseClassMember();
        if (hiMember.kind === "shorthand") {
          // Annex B: shorthand as the upper bound → union {lo, '-', shorthand}.
          ranges.push([lo, lo], [0x2d, 0x2d]);
          for (const r of hiMember.ranges) ranges.push([r[0], r[1]]);
          continue;
        }
        const hi = hiMember.code;
        if (hi < lo) throw new RegexUnsupportedError("class range out of order");
        ranges.push([lo, hi]);
      } else {
        ranges.push([lo, lo]);
      }
    }
    if (this.peek() !== "]") throw new RegexUnsupportedError("unterminated character class");
    this.next();
    return { kind: "class", ranges, negated };
  }

  private parseClassMember(): { kind: "char"; code: number } | { kind: "shorthand"; ranges: Array<[number, number]> } {
    if (this.peek() === "\\") {
      this.next();
      const e = this.peek();
      if (e === "d") {
        this.next();
        return { kind: "shorthand", ranges: DIGIT };
      }
      if (e === "w") {
        this.next();
        return { kind: "shorthand", ranges: WORD };
      }
      if (e === "s") {
        this.next();
        return { kind: "shorthand", ranges: SPACE };
      }
      // Negated shorthands inside a class — lowered to their complement range
      // list (the class is a union of members, so per-member negation must be
      // materialized as ranges). #1912.
      if (e === "D") {
        this.next();
        return { kind: "shorthand", ranges: NOT_DIGIT };
      }
      if (e === "W") {
        this.next();
        return { kind: "shorthand", ranges: NOT_WORD };
      }
      if (e === "S") {
        this.next();
        return { kind: "shorthand", ranges: NOT_SPACE };
      }
      if (e === "b") {
        this.next();
        return { kind: "char", code: 0x08 };
      } // \b is backspace in a class
      if (e === "p" || e === "P") {
        throw new RegexUnsupportedError(`Unicode property escape \\${e}{…} — #1539 Phase 2d`);
      }
      return { kind: "char", code: this.parseEscapedCodeUnit() };
    }
    return { kind: "char", code: this.next().charCodeAt(0) };
  }
}

export function parsePattern(pattern: string, flags = 0): ParsedRegex {
  const p = new Parser(pattern, flags);
  const root = p.parse();
  return { root, numCaptures: p.numCaptures, groupNames: p.groupNames };
}
