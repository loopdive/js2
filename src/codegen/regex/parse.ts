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
 * Added in 2d Slice B (#1911, compacted by #3652):
 *   - `u`/`v` code-point classes, Unicode property escapes, dot, and Unicode
 *     ignore-case atoms as compile-time-enumerated CPCLASS range sets
 *   - astral literals as explicit lead/trail sequences, with direction-aware
 *     code-point classes inside lookbehind
 *
 * Added by #2591:
 *   - v-mode `\q{…}` finite string disjunctions
 *
 * Added by #3665:
 *   - Unicode 17 properties of strings and finite v-set union, intersection,
 *     and subtraction, lowered through existing CPCLASS/string alternations
 */
import { RE_FLAG_I, RE_FLAG_M, RE_FLAG_S, RE_FLAG_U, RE_FLAG_V, RegexUnsupportedError } from "./bytecode.js";
import {
  evaluateUnicodeStringClass,
  hasUnicodeStringSetSyntax,
  unicodeStringPropertyEscape,
  type UnicodeStringSet,
} from "./unicode-string-properties.js";
import { codePointSource, enumerateClassRanges, parseStringDisjunction, type CpRanges } from "./unicode.js";

export type ReNode =
  | { kind: "char"; code: number }
  | { kind: "any" }
  | { kind: "class"; ranges: Array<[number, number]>; negated: boolean }
  | { kind: "cpclass"; ranges: CpRanges; negated: boolean }
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

interface UnicodeStringTrieNode {
  terminal: boolean;
  children: Map<number, UnicodeStringTrieNode>;
}

function newUnicodeStringTrieNode(): UnicodeStringTrieNode {
  return { terminal: false, children: new Map() };
}

function insertUnicodeString(root: UnicodeStringTrieNode, sequence: readonly number[]): void {
  let node = root;
  for (const cp of sequence) {
    let child = node.children.get(cp);
    if (child === undefined) {
      child = newUnicodeStringTrieNode();
      node.children.set(cp, child);
    }
    node = child;
  }
  node.terminal = true;
}

function unicodeStringTrieSignature(node: UnicodeStringTrieNode): string {
  const children = [...node.children]
    .map(([cp, child]) => `${cp.toString(36)}:${unicodeStringTrieSignature(child)}`)
    .sort();
  return `${node.terminal ? "1" : "0"}[${children.join(",")}]`;
}

function codePointRanges(codePoints: readonly number[]): CpRanges {
  const sorted = [...codePoints].sort((left, right) => left - right);
  const ranges: CpRanges = [];
  for (const cp of sorted) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && cp <= last[1] + 1) last[1] = Math.max(last[1], cp);
    else ranges.push([cp, cp]);
  }
  return ranges;
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
const PROPERTY_OF_STRINGS_RE =
  /\\[pP]\{(?:Basic_Emoji|Emoji_Keycap_Sequence|RGI_Emoji(?:_Flag_Sequence|_Modifier_Sequence|_Tag_Sequence|_ZWJ_Sequence)?)\}/;

/**
 * Decode the UnicodeEscapeSequence spelling permitted inside a RegExp group
 * name. The parser otherwise consumes pattern source text verbatim, but named
 * captures/backreferences are keyed by the resulting String value:
 * `(?<\u{03C0}>a)` and `(?<π>a)` both declare the property `"π"`.
 *
 * Pattern validity is host-prechecked for u/v literals. Keep this helper
 * defensive for constructor/non-u entry points so malformed escapes refuse
 * loudly instead of creating an unreachable raw backslash-keyed group.
 */
function decodeGroupName(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; ) {
    if (raw[i] !== "\\") {
      out += raw[i++]!;
      continue;
    }
    if (raw[i + 1] !== "u") {
      throw new RegexUnsupportedError(`invalid escape in group name '${raw}'`);
    }
    if (raw[i + 2] === "{") {
      const close = raw.indexOf("}", i + 3);
      if (close < 0) throw new RegexUnsupportedError(`unterminated Unicode escape in group name '${raw}'`);
      const digits = raw.slice(i + 3, close);
      if (!/^[0-9a-fA-F]+$/.test(digits)) {
        throw new RegexUnsupportedError(`invalid Unicode escape in group name '${raw}'`);
      }
      const cp = Number.parseInt(digits, 16);
      if (cp > 0x10ffff) throw new RegexUnsupportedError(`group-name code point out of range in '${raw}'`);
      out += String.fromCodePoint(cp);
      i = close + 1;
      continue;
    }
    const digits = raw.slice(i + 2, i + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
      throw new RegexUnsupportedError(`invalid Unicode escape in group name '${raw}'`);
    }
    out += String.fromCharCode(Number.parseInt(digits, 16));
    i += 6;
  }
  return out;
}

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
          let rawName = "";
          while (j < src.length && src[j] !== ">") rawName += src[j++];
          const name = decodeGroupName(rawName);
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
      return this.cpClass(enumerateClassRanges(codePointSource(cp), this.enumFlags()));
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

  /** Enumerate a class-like source fragment under the current flags and keep
   *  the resulting code-point ranges compact for the VM. */
  private uEnum(source: string): ReNode {
    return this.cpClass(enumerateClassRanges(source, this.enumFlags()));
  }

  private cpClass(ranges: CpRanges): ReNode {
    return { kind: "cpclass", ranges, negated: false };
  }

  /** A group of trie edges with the same continuation can share one CPCLASS
   * head. This is essential for aggregate properties: Test262 concatenates all
   * 3,953 RGI_Emoji members, so scanning hundreds of equivalent root branches
   * for every member would exhaust the unchanged VM step budget. */
  private uStringTrieHead(codePoints: readonly number[]): ReNode {
    if (codePoints.length === 1) return this.uChar(codePoints[0]!);
    if (this.iState) {
      const source = `[${codePoints.map((cp) => codePointSource(cp)).join("")}]`;
      return this.cpClass(enumerateClassRanges(source, this.enumFlags()));
    }
    return this.cpClass(codePointRanges(codePoints));
  }

  private uStringTrieBranches(node: UnicodeStringTrieNode): ReNode[] {
    const groups = new Map<string, { codePoints: number[]; child: UnicodeStringTrieNode }>();
    for (const [cp, child] of node.children) {
      const signature = unicodeStringTrieSignature(child);
      const group = groups.get(signature);
      if (group === undefined) groups.set(signature, { codePoints: [cp], child });
      else group.codePoints.push(cp);
    }

    const branches: ReNode[] = [];
    for (const { codePoints, child } of groups.values()) {
      const head = this.uStringTrieHead(codePoints);
      const tail = this.uStringTrieNode(child);
      branches.push(
        tail.kind === "concat" && tail.parts.length === 0
          ? head
          : tail.kind === "concat"
            ? { kind: "concat", parts: [head, ...tail.parts] }
            : { kind: "concat", parts: [head, tail] },
      );
    }
    return branches;
  }

  /** Lower one non-root prefix-trie node. Descendants precede the terminal
   * empty arm, preserving the v-set rule that a longer member wins over its
   * prefix without emitting one top-level branch per complete string. */
  private uStringTrieNode(node: UnicodeStringTrieNode): ReNode {
    const options = this.uStringTrieBranches(node);
    if (node.terminal) options.push({ kind: "concat", parts: [] });
    if (options.length === 0) return this.cpClass([]);
    return options.length === 1 ? options[0]! : { kind: "alt", options };
  }

  /** Lower a completed finite v-set through the existing regex AST. Multi-code-
   * point members share prefixes in a trie; the one-code-point domain stays
   * compact in one CPCLASS arm, and an empty member remains the final arm. */
  private uStringSet(set: UnicodeStringSet): ReNode {
    const root = newUnicodeStringTrieNode();
    for (const sequence of set.strings.values()) {
      insertUnicodeString(root, sequence);
    }

    const options = this.uStringTrieBranches(root);
    if (set.ranges.length > 0) options.push(this.cpClass(set.ranges));
    if (root.terminal) options.push({ kind: "concat", parts: [] });
    if (options.length === 0) return this.cpClass([]);
    return options.length === 1 ? options[0]! : { kind: "alt", options };
  }

  /**
   * Lower a v-mode `[…]` class that contains one or more `\q{…}` string
   * disjunctions (§22.2.1 ClassStringDisjunction). `source` is the full class
   * text including the surrounding brackets, already extracted by
   * `extractClassSource`.
   *
   * A `\q{s1|s2|…}` operand matches the literal STRING `si` (a possibly
   * multi-code-point sequence), so it cannot be a member of the single-code-point
   * range set the host enumerator produces. We desugar the whole class to an
   * **alternation**: each multi-code-point operand becomes a `concat` of
   * single-code-point arms, unioned with the residual code-point class (the rest
   * of the members, enumerated the usual way).
   *
   * Per spec the class set is matched longest-first, so the alternation arms are
   * ordered by descending code-point length: multi-char operands precede the
   * single-code-point class (length 1), which precedes the empty operand
   * (length 0). Single-length operands and the class tie (they consume the same
   * one code point), so their relative order is immaterial.
   *
   * Negated classes containing strings (`[^\q{…}]`) are a host SyntaxError and
   * never reach here. `\q{…}` inside a top-level set operation (`&&`/`--`) is
   * narrowly refused (loud `RegexUnsupportedError`) for this slice. #2591.
   */
  private uEnumClassWithStrings(source: string): ReNode {
    // Strip the outer brackets. `extractClassSource` guarantees a leading `[`
    // and trailing `]`.
    const body = source.slice(1, -1);
    if (body.startsWith("^")) {
      // Should be unreachable — a negated class with strings is a host
      // SyntaxError pre-validated at the literal site — but refuse loudly.
      throw new RegexUnsupportedError("negated v-mode class with \\q{…} strings");
    }

    // Scan the body once: reject top-level set operations carrying strings, and
    // collect the `\q{…}` operand spans (start..end of the `{…}` body).
    const qSpans: Array<{ bodyStart: number; bodyEnd: number; full: [number, number] }> = [];
    let depth = 0;
    for (let i = 0; i < body.length; ) {
      const c = body[i]!;
      if (c === "\\") {
        // `\q{…}` only matters at depth 0 (a nested `[…]` operand is its own
        // class — strings there are part of a set operation we refuse below).
        if (body[i + 1] === "q" && body[i + 2] === "{") {
          const fullStart = i;
          let j = i + 3;
          while (j < body.length && body[j] !== "}") {
            if (body[j] === "\\") {
              // A `\u{H…}` escape carries its own braces — skip the whole block
              // so its closing `}` is not mistaken for the `\q{` terminator.
              if (body[j + 1] === "u" && body[j + 2] === "{") {
                j += 3;
                while (j < body.length && body[j] !== "}") j++;
                j++; // consume the escape's closing `}`
              } else {
                j += 2;
              }
            } else {
              j++;
            }
          }
          if (body[j] !== "}") throw new RegexUnsupportedError("unterminated \\q{…}");
          if (depth === 0) qSpans.push({ bodyStart: i + 3, bodyEnd: j, full: [fullStart, j + 1] });
          i = j + 1;
          continue;
        }
        i += 2;
        continue;
      }
      if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (depth === 0 && (body.startsWith("&&", i) || body.startsWith("--", i))) {
        // A top-level set operation combined with a string disjunction needs
        // string-aware set algebra (a string survives `&&` only if both
        // operands contain it). Out of slice scope — refuse loudly so the
        // result is an honest compile_error, never a wrong match. #2591.
        throw new RegexUnsupportedError(
          "\\q{…} string disjunction inside a v-mode set operation (&&/--) — #2591 residual",
        );
      }
      i++;
    }

    if (qSpans.length === 0) {
      // No top-level `\q{…}` after all (it was nested in a set operand we'd have
      // refused, or escaped) — fall back to the plain enumerator/refusal.
      return this.uEnum(source);
    }

    const flagStr = this.enumFlags();
    const caseFold = this.iState;
    const arms: Array<{ len: number; node: ReNode }> = [];

    // Build one alternation arm per disjunction operand.
    for (const span of qSpans) {
      const operands = parseStringDisjunction(body.slice(span.bodyStart, span.bodyEnd));
      for (const cps of operands) {
        if (cps.length === 0) {
          // Empty operand → matches the empty string (a zero-width arm).
          arms.push({ len: 0, node: { kind: "concat", parts: [] } });
          continue;
        }
        const parts: ReNode[] = [];
        for (const cp of cps) {
          // Under `i`, fold each literal code point through the host so the
          // operand matches case-insensitively (reuses the Slice B oracle).
          if (caseFold) {
            parts.push(this.cpClass(enumerateClassRanges(codePointSource(cp), flagStr)));
          } else {
            parts.push(this.uChar(cp));
          }
        }
        arms.push({ len: cps.length, node: parts.length === 1 ? parts[0]! : { kind: "concat", parts } });
      }
    }

    // Residual code-point class = the class with every top-level `\q{…}` span
    // removed. If anything is left (ranges/escapes/props), enumerate it as a
    // single-code-point class and add it as a length-1 arm.
    let residual = "";
    let prev = 0;
    for (const span of qSpans) {
      residual += body.slice(prev, span.full[0]);
      prev = span.full[1];
    }
    residual += body.slice(prev);
    if (residual.length > 0) {
      // Remaining members (ranges/escapes/props) survive as a single-code-point
      // class. `enumerateClassRanges` returns an empty set for a vacuous residual
      // (e.g. `\q{ab}` alone leaves ``), in which case no arm is added.
      const residualRanges = enumerateClassRanges(`[${residual}]`, flagStr);
      if (residualRanges.length > 0) {
        arms.push({ len: 1, node: this.cpClass(residualRanges) });
      } else if (PROPERTY_OF_STRINGS_RE.test(residual)) {
        // A residual that enumerates to NO code points but names a
        // **property of strings** (`\p{Basic_Emoji}`, `\p{RGI_Emoji}`, …; the
        // fixed §22.2.1.9 list) contributes multi-code-point members the
        // single-code-point enumerator cannot represent. Refuse loudly rather
        // than silently drop those members (which would make
        // `[\p{Emoji_Keycap_Sequence}\q{…}]` return a wrong answer for the
        // property's strings). #2591 residual.
        throw new RegexUnsupportedError(
          "v-mode class mixes \\q{…} with a property-of-strings (\\p{…}) member — #2591 residual",
        );
      }
    }

    // Order longest-first (spec: try longer strings before shorter ones), with a
    // stable order among equal lengths.
    arms.sort((a, b) => b.len - a.len);
    const options = arms.map((a) => a.node);
    if (options.length === 0) return this.cpClass([]); // never matches
    return options.length === 1 ? options[0]! : { kind: "alt", options };
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
      if (this.unicode) {
        const classSrc = this.extractClassSource();
        if (this.vMode && hasUnicodeStringSetSyntax(classSrc)) {
          // Keep #2591's proven direct-q union path. String properties and
          // top-level algebra use #3665's first-class finite set evaluator.
          if (
            classSrc.includes("\\q{") &&
            !classSrc.includes("\\p{") &&
            !classSrc.includes("&&") &&
            !classSrc.includes("--")
          ) {
            return this.uEnumClassWithStrings(classSrc);
          }
          return this.uStringSet(evaluateUnicodeStringClass(classSrc, this.enumFlags()));
        }
        return this.uEnum(classSrc);
      }
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
          let rawName = "";
          while (this.peek() !== ">" && !this.eof()) rawName += this.next();
          if (this.peek() !== ">") throw new RegexUnsupportedError("unterminated group name");
          this.next();
          name = decodeGroupName(rawName);
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
      let rawName = "";
      while (this.peek() !== undefined && this.peek() !== ">") rawName += this.next();
      if (this.peek() !== ">") throw new RegexUnsupportedError("unterminated \\k<name>");
      this.next();
      const name = decodeGroupName(rawName);
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
        const source = this.extractPropertyEscapeSource();
        const stringSet = this.vMode ? unicodeStringPropertyEscape(source) : null;
        return stringSet === null ? this.uEnum(source) : this.uStringSet(stringSet);
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
  private parseEscapedCodeUnit(inClass = false): number {
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
        // ControlLetter escape: \cA-\cZ \ca-\cz → code % 32. In a character
        // class, Annex B §B.1.4 ClassControlLetter also admits DecimalDigit and
        // `_` (`/[\c1]/` → 0x11, `/[\c_]/` → 0x1f) — non-u mode only.
        const l = this.peek();
        const isCtrlLetter = l !== undefined && ((l >= "A" && l <= "Z") || (l >= "a" && l <= "z"));
        const isClassCtrl = inClass && !this.unicode && l !== undefined && ((l >= "0" && l <= "9") || l === "_");
        if (isCtrlLetter || isClassCtrl) {
          this.next();
          return l!.charCodeAt(0) % 32;
        }
        // Annex B §B.1.4 identity fallback (non-u): a `\c` that does not form a
        // control escape is a literal reverse solidus, and the following char is
        // re-parsed as an ordinary atom (`/\c1/` matches the 3 chars `\`, `c`,
        // `1`). Un-consume the `c` and emit `\`. In u/v mode this is a real
        // SyntaxError — refuse.
        if (!this.unicode) {
          this.pos--; // un-consume the `c`
          return 0x5c;
        }
        throw new RegexUnsupportedError("\\c without a control letter");
      }
      case "x": {
        // \xHH — exactly two hex digits. Annex B §B.1.4: an incomplete `\x`
        // (fewer than two hex digits following) is an IdentityEscape — the
        // literal `x` — with the trailing chars re-parsed (`/\x/` matches `x`).
        // Read without consuming so the fallback leaves the cursor put; u/v mode
        // stays strict (a bad `\x` there is a real SyntaxError).
        const hex = this.src.slice(this.pos, this.pos + 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          this.pos += 2;
          return parseInt(hex, 16);
        }
        if (!this.unicode) return 0x78; // literal 'x'
        throw new RegexUnsupportedError(`bad \\x escape`);
      }
      case "u": {
        if (this.peek() === "{") throw new RegexUnsupportedError("\\u{…} code-point escape — #1539 Phase 2c/2d");
        // \uHHHH — exactly four hex digits. Annex B: an incomplete `\u` is an
        // IdentityEscape for the literal `u` (`/\u/` matches `u`). Same
        // read-without-consume fallback; u/v mode stays strict.
        const hex = this.src.slice(this.pos, this.pos + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          this.pos += 4;
          return parseInt(hex, 16);
        }
        if (!this.unicode) return 0x75; // literal 'u'
        throw new RegexUnsupportedError(`bad \\u escape`);
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
      return { kind: "char", code: this.parseEscapedCodeUnit(true) };
    }
    return { kind: "char", code: this.next().charCodeAt(0) };
  }
}

export function parsePattern(pattern: string, flags = 0): ParsedRegex {
  const p = new Parser(pattern, flags);
  const root = p.parse();
  return { root, numCaptures: p.numCaptures, groupNames: p.groupNames };
}
