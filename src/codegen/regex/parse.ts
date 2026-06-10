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
 * Still refused (each cites the phase that adds it):
 *   - lookahead/lookbehind `(?=) (?!) (?<=) (?<!)` → 2d
 *   - Unicode property escapes `\p{…}` / `\P{…}`   → 2d
 *   - the `u`/`v` flags' code-point semantics      → 2c/2d (parse still UTF-16)
 */
import { RegexUnsupportedError } from "./bytecode.js";

export type ReNode =
  | { kind: "char"; code: number }
  | { kind: "any" }
  | { kind: "class"; ranges: Array<[number, number]>; negated: boolean }
  | { kind: "bol" }
  | { kind: "eol" }
  | { kind: "wordBoundary"; negated: boolean }
  | { kind: "backref"; index: number }
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

  constructor(private readonly src: string) {
    const scan = scanGroups(src);
    this.totalCaptures = scan.count;
    this.groupNames = scan.names;
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
    if (c === "[") return this.parseClass();
    if (c === ".") {
      this.next();
      return { kind: "any" };
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
    // ordinary literal code unit
    this.next();
    return { kind: "char", code: c.charCodeAt(0) };
  }

  private parseGroup(): ReNode {
    this.next(); // consume "("
    let capIndex = -1;
    let name: string | null = null;
    if (this.peek() === "?") {
      this.next();
      const t = this.peek();
      if (t === ":") {
        this.next(); // non-capturing
      } else if (t === "<") {
        this.next();
        const after = this.peek();
        if (after === "=" || after === "!") {
          throw new RegexUnsupportedError("lookbehind (?<= / ?<!) — #1539 Phase 2d");
        }
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
      } else if (t === "=" || t === "!") {
        throw new RegexUnsupportedError("lookahead (?= / ?!) — #1539 Phase 2d");
      } else {
        throw new RegexUnsupportedError(`unsupported group form '(?${t ?? ""}' — #1539 Phase 2d`);
      }
    } else {
      capIndex = ++this.numCaptures;
    }
    const inner = this.parseAlternation();
    if (this.peek() !== ")") throw new RegexUnsupportedError("unterminated group");
    this.next();
    return { kind: "group", node: inner, capIndex, name };
  }

  private parseEscapeAtom(): ReNode {
    this.next(); // consume "\"
    const e = this.peek();
    if (e === undefined) throw new RegexUnsupportedError("trailing escape");
    // Class shorthands as standalone atoms.
    if (e === "d") {
      this.next();
      return { kind: "class", ranges: DIGIT, negated: false };
    }
    if (e === "D") {
      this.next();
      return { kind: "class", ranges: DIGIT, negated: true };
    }
    if (e === "w") {
      this.next();
      return { kind: "class", ranges: WORD, negated: false };
    }
    if (e === "W") {
      this.next();
      return { kind: "class", ranges: WORD, negated: true };
    }
    if (e === "s") {
      this.next();
      return { kind: "class", ranges: SPACE, negated: false };
    }
    if (e === "S") {
      this.next();
      return { kind: "class", ranges: SPACE, negated: true };
    }
    if (e === "b") {
      this.next();
      return { kind: "wordBoundary", negated: false };
    }
    if (e === "B") {
      this.next();
      return { kind: "wordBoundary", negated: true };
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
        return { kind: "backref", index: value };
      }
      this.pos = saved;
      if (e >= "8") {
        this.next();
        return { kind: "char", code: e.charCodeAt(0) }; // \8 \9 — identity
      }
      return { kind: "char", code: this.parseLegacyOctal() };
    }
    if (e === "k") {
      // \k<name> — named backreference. Annex B: when the pattern declares NO
      // named groups, `\k` is an identity escape for `k`.
      if (this.groupNames.size === 0) {
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
      return { kind: "backref", index: idx };
    }
    if (e === "p" || e === "P") {
      throw new RegexUnsupportedError(`Unicode property escape \\${e}{…} — #1539 Phase 2d`);
    }
    return { kind: "char", code: this.parseEscapedCodeUnit() };
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

export function parsePattern(pattern: string): ParsedRegex {
  const p = new Parser(pattern);
  const root = p.parse();
  return { root, numCaptures: p.numCaptures, groupNames: p.groupNames };
}
