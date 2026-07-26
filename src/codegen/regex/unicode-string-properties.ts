// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3665 — compile-time finite Unicode string sets for RegExp `v` mode.
 *
 * A Unicode set can contain both one-code-point members and finite strings.
 * Keep the former in compact ranges (the existing CPCLASS representation) and
 * the latter in a keyed map. Set algebra is completed before the parser lowers
 * the result to existing CPCLASS/concat/alternation nodes; the Wasm VM does not
 * gain a second string-set engine.
 */
import { RegexUnsupportedError } from "./bytecode.js";
import { UNICODE_STRING_PROPERTY_DATA } from "./unicode-string-data.generated.js";
import { enumerateClassRanges, parseStringDisjunction, type CpRanges } from "./unicode.js";

const PROPERTY_NAMES = [
  "Basic_Emoji",
  "Emoji_Keycap_Sequence",
  "RGI_Emoji",
  "RGI_Emoji_Flag_Sequence",
  "RGI_Emoji_Modifier_Sequence",
  "RGI_Emoji_Tag_Sequence",
  "RGI_Emoji_ZWJ_Sequence",
] as const;

export type UnicodeStringPropertyName = (typeof PROPERTY_NAMES)[number];

/** Invariant: `strings` contains only zero- or multi-code-point sequences.
 * One-code-point members are normalized into `ranges`. */
export interface UnicodeStringSet {
  ranges: CpRanges;
  strings: Map<string, readonly number[]>;
}

const propertyNameSet = new Set<string>(PROPERTY_NAMES);
const propertyCache = new Map<UnicodeStringPropertyName, UnicodeStringSet>();

function sequenceKey(sequence: readonly number[]): string {
  return sequence.join(",");
}

function singletonRanges(codePoints: number[]): CpRanges {
  codePoints.sort((left, right) => left - right);
  const ranges: CpRanges = [];
  for (const cp of codePoints) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && cp <= last[1] + 1) last[1] = Math.max(last[1], cp);
    else ranges.push([cp, cp]);
  }
  return ranges;
}

function fromSequences(sequences: Iterable<readonly number[]>): UnicodeStringSet {
  const singles: number[] = [];
  const strings = new Map<string, readonly number[]>();
  for (const sequence of sequences) {
    if (sequence.length === 1) singles.push(sequence[0]!);
    else strings.set(sequenceKey(sequence), sequence);
  }
  return { ranges: singletonRanges(singles), strings };
}

function unionRanges(left: CpRanges, right: CpRanges): CpRanges {
  const sorted = [...left, ...right].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const result: CpRanges = [];
  for (const [lo, hi] of sorted) {
    const last = result[result.length - 1];
    if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else result.push([lo, hi]);
  }
  return result;
}

function intersectRanges(left: CpRanges, right: CpRanges): CpRanges {
  const result: CpRanges = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const [leftLo, leftHi] = left[leftIndex]!;
    const [rightLo, rightHi] = right[rightIndex]!;
    const lo = Math.max(leftLo, rightLo);
    const hi = Math.min(leftHi, rightHi);
    if (lo <= hi) result.push([lo, hi]);
    if (leftHi < rightHi) leftIndex++;
    else rightIndex++;
  }
  return result;
}

function subtractRanges(left: CpRanges, right: CpRanges): CpRanges {
  const result: CpRanges = [];
  let rightIndex = 0;
  for (const [leftLo, leftHi] of left) {
    let cursor = leftLo;
    while (rightIndex < right.length && right[rightIndex]![1] < cursor) rightIndex++;
    let scan = rightIndex;
    while (scan < right.length && right[scan]![0] <= leftHi) {
      const [rightLo, rightHi] = right[scan]!;
      if (rightLo > cursor) result.push([cursor, Math.min(leftHi, rightLo - 1)]);
      cursor = Math.max(cursor, rightHi + 1);
      if (cursor > leftHi) break;
      scan++;
    }
    if (cursor <= leftHi) result.push([cursor, leftHi]);
  }
  return result;
}

function union(left: UnicodeStringSet, right: UnicodeStringSet): UnicodeStringSet {
  return {
    ranges: unionRanges(left.ranges, right.ranges),
    strings: new Map([...left.strings, ...right.strings]),
  };
}

function intersect(left: UnicodeStringSet, right: UnicodeStringSet): UnicodeStringSet {
  const strings = new Map<string, readonly number[]>();
  for (const [key, sequence] of left.strings) {
    if (right.strings.has(key)) strings.set(key, sequence);
  }
  return { ranges: intersectRanges(left.ranges, right.ranges), strings };
}

function subtract(left: UnicodeStringSet, right: UnicodeStringSet): UnicodeStringSet {
  const strings = new Map(left.strings);
  for (const key of right.strings.keys()) strings.delete(key);
  return { ranges: subtractRanges(left.ranges, right.ranges), strings };
}

function decodeProperty(name: Exclude<UnicodeStringPropertyName, "RGI_Emoji">): UnicodeStringSet {
  const encoded = UNICODE_STRING_PROPERTY_DATA[name];
  const sequences = encoded.split(",").map((item) => item.split(".").map((cp) => Number.parseInt(cp, 36)));
  return fromSequences(sequences);
}

export function isUnicodeStringPropertyName(name: string): name is UnicodeStringPropertyName {
  return propertyNameSet.has(name);
}

/** Decode one Unicode 17 property lazily. RGI_Emoji is the normative union of
 * the six generated source properties and is not duplicated in the table. */
export function unicodeStringProperty(name: UnicodeStringPropertyName): UnicodeStringSet {
  const cached = propertyCache.get(name);
  if (cached !== undefined) return cached;
  let value: UnicodeStringSet;
  if (name === "RGI_Emoji") {
    value = PROPERTY_NAMES.filter((part) => part !== "RGI_Emoji")
      .map((part) => unicodeStringProperty(part))
      .reduce(union);
  } else {
    value = decodeProperty(name);
  }
  propertyCache.set(name, value);
  return value;
}

/** Whether source contains a finite-string operand which the code-point-only
 * host enumerator cannot fully represent. */
export function hasUnicodeStringSetSyntax(source: string): boolean {
  if (source.includes("\\q{")) return true;
  for (const name of PROPERTY_NAMES) {
    if (source.includes(`\\p{${name}}`)) return true;
  }
  return false;
}

/** Resolve an exact positive property escape, or null for a code-point
 * property. Negative properties of strings are host SyntaxErrors. */
export function unicodeStringPropertyEscape(source: string): UnicodeStringSet | null {
  const match = /^\\p\{([^}]+)\}$/.exec(source);
  if (match === null || !isUnicodeStringPropertyName(match[1]!)) return null;
  return unicodeStringProperty(match[1]!);
}

function findClosingBrace(source: string, start: number): number {
  for (let index = start; index < source.length; index++) {
    if (source[index] !== "\\") {
      if (source[index] === "}") return index;
      continue;
    }
    if (source[index + 1] === "u" && source[index + 2] === "{") {
      index += 3;
      while (index < source.length && source[index] !== "}") index++;
    } else {
      index++;
    }
  }
  throw new RegexUnsupportedError("unterminated \\q{…} string disjunction");
}

function findClosingClass(source: string, start: number): number {
  let depth = 1;
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") {
      if (source[index + 1] === "q" && source[index + 2] === "{") {
        index = findClosingBrace(source, index + 3);
      } else {
        index++;
      }
      continue;
    }
    if (source[index] === "[") depth++;
    else if (source[index] === "]" && --depth === 0) return index;
  }
  throw new RegexUnsupportedError("unterminated nested v-mode class");
}

function splitTopLevel(source: string, operator: "&&" | "--"): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let found = false;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\\") {
      if (source[index + 1] === "q" && source[index + 2] === "{") {
        index = findClosingBrace(source, index + 3);
      } else if ((source[index + 1] === "p" || source[index + 1] === "P") && source[index + 2] === "{") {
        index = source.indexOf("}", index + 3);
        if (index < 0) throw new RegexUnsupportedError("unterminated Unicode property escape");
      } else {
        index++;
      }
      continue;
    }
    if (source[index] === "[") {
      index = findClosingClass(source, index);
      continue;
    }
    if (source.startsWith(operator, index)) {
      parts.push(source.slice(start, index));
      start = index + operator.length;
      index++;
      found = true;
    }
  }
  if (!found) return null;
  parts.push(source.slice(start));
  return parts;
}

function evalUnionBody(source: string, flagStr: string): UnicodeStringSet {
  let result: UnicodeStringSet = { ranges: [], strings: new Map() };
  let ordinary = "";
  const flushOrdinary = (): void => {
    if (ordinary === "") return;
    result = union(result, { ranges: enumerateClassRanges(`[${ordinary}]`, flagStr), strings: new Map() });
    ordinary = "";
  };

  for (let index = 0; index < source.length; ) {
    if (source[index] === "[") {
      flushOrdinary();
      const end = findClosingClass(source, index);
      result = union(result, evaluateUnicodeStringClass(source.slice(index, end + 1), flagStr));
      index = end + 1;
      continue;
    }
    if (source.startsWith("\\q{", index)) {
      flushOrdinary();
      const end = findClosingBrace(source, index + 3);
      result = union(result, fromSequences(parseStringDisjunction(source.slice(index + 3, end))));
      index = end + 1;
      continue;
    }
    if ((source.startsWith("\\p{", index) || source.startsWith("\\P{", index)) && source.indexOf("}", index + 3) >= 0) {
      const end = source.indexOf("}", index + 3);
      const propertySource = source.slice(index, end + 1);
      const property = unicodeStringPropertyEscape(propertySource);
      if (property !== null) {
        flushOrdinary();
        result = union(result, property);
      } else {
        ordinary += propertySource;
      }
      index = end + 1;
      continue;
    }
    if (source[index] === "\\") {
      ordinary += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    const cp = source.codePointAt(index)!;
    ordinary += String.fromCodePoint(cp);
    index += cp > 0xffff ? 2 : 1;
  }
  flushOrdinary();
  return result;
}

/** Evaluate a full `[…]` v-mode class which contains at least one finite
 * string operand. Operators are found only at the current nesting level;
 * nested classes are recursively evaluated. */
export function evaluateUnicodeStringClass(source: string, flagStr: string): UnicodeStringSet {
  if (!source.startsWith("[") || !source.endsWith("]")) {
    throw new RegexUnsupportedError(`expected a complete v-mode class, got ${JSON.stringify(source)}`);
  }
  const body = source.slice(1, -1);
  if (body.startsWith("^")) {
    throw new RegexUnsupportedError("negated v-mode class may not contain strings");
  }
  const intersections = splitTopLevel(body, "&&");
  if (intersections !== null) {
    return intersections.map((part) => evalUnionBody(part, flagStr)).reduce(intersect);
  }
  const differences = splitTopLevel(body, "--");
  if (differences !== null) {
    return differences.map((part) => evalUnionBody(part, flagStr)).reduce(subtract);
  }
  return evalUnionBody(body, flagStr);
}
