// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7168) Re-shape optimizer-introduced `try_table`s whose block type V8 12.4
 * (Node 22, a supported engine) executes as `unreachable`.
 *
 * The engine bug is V8 12.4's alone (Node 22 — `engines` is `node >=20`,
 * and Node 20 has no try_table). Node 23.11 / 24 / 25 run the same bytes
 * correctly. V8 12.4 mis-decodes a `try_table` block type written with the
 * ref prefix (`0x63` / `0x64`): `(ref $T)`, `(ref null $T)`, `(ref extern)`,
 * `(ref any)`. Such a try_table traps `RuntimeError: unreachable` on entry
 * with nothing thrown, and some type indices make the module fail to compile
 * instead ("block type index N is not a signature definition"). Empty, `i32`,
 * `externref` / `anyref` and multi-value (type-index) block types run fine.
 * Binaryen prints multi-value ones as `(type $N) (result ...)`, and the parser
 * below leaves those alone on purpose.
 *
 * Codegen avoids the shape (empty try_tables, values parked in locals; #4620,
 * #5141), but Binaryen re-creates it: `remove-unused-brs` turns a `throw $tag
 * X` caught by an enclosing `try_table (catch $tag $b)` in the same function
 * into `br $b X`. When the try_table is the last child of `$b`, a later round
 * drops that branch so `X` falls through, and refinalize types the try_table
 * with X's refined type, e.g. `try_table (result (ref extern))`. Every
 * native-first `try { throw new Error(..) } catch {}` hits it after `-O3`.
 *
 * The rewrite operates on Binaryen's printed text (names, not depths, so no
 * branch retargeting is needed):
 *
 *   (try_table $l? (result R) CATCHES BODY...)
 * →
 *   (block $__js2_ttN (result R)
 *    (try_table CATCHES (br $__js2_ttN (block $l? (result R) BODY...)))
 *    (unreachable))
 *
 * The try_table becomes empty-typed; a branch to its old label now targets the
 * inner block (same value, same continuation); catch labels resolve outside
 * the try_table exactly as before. Semantics are identical.
 */

/**
 * Byte pre-scan: true when `binary` holds a `try_table` opcode (`0x1f`)
 * followed by a ref-prefixed block type (`0x63` / `0x64`). Every unsafe
 * try_table produces this pair. Other bytes can produce it by accident, and a
 * false positive only costs one extra print.
 */
export function mayContainUnsafeTryTable(binary: Uint8Array): boolean {
  for (let i = binary.indexOf(0x1f); i >= 0 && i + 1 < binary.length; i = binary.indexOf(0x1f, i + 1)) {
    const next = binary[i + 1];
    if (next === 0x63 || next === 0x64) return true;
  }
  return false;
}

/** Single-byte block types V8 12.4 executes correctly. */
const SAFE_RESULT =
  /^\(result\s+(?:i32|i64|f32|f64|v128|anyref|eqref|i31ref|structref|arrayref|funcref|externref|exnref|nullref|nullfuncref|nullexternref|nullexnref)\s*\)$/;

/** Index just past the end of the string literal that opens at `i`. */
function skipString(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** Index just past a `;;` line comment or `(; ;)` block comment at `i`, or `i`. */
function skipComment(text: string, i: number): number {
  if (text.startsWith(";;", i)) {
    const nl = text.indexOf("\n", i);
    return nl < 0 ? text.length : nl;
  }
  if (text.startsWith("(;", i)) {
    const end = text.indexOf(";)", i + 2);
    return end < 0 ? text.length : end + 2;
  }
  return i;
}

/** Index just past the s-expression or atom starting at `i` (no leading space). */
function skipItem(text: string, i: number): number {
  if (text[i] === '"') return skipString(text, i);
  if (text[i] !== "(") {
    let j = i;
    while (j < text.length && !/[\s()]/.test(text[j]!)) j = text[j] === '"' ? skipString(text, j) : j + 1;
    return j;
  }
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j]!;
    const past = skipComment(text, j);
    if (past !== j) {
      j = past;
      continue;
    }
    if (c === '"') {
      j = skipString(text, j);
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j + 1;
    j++;
  }
  return j;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

interface TryTableHeader {
  label: string;
  result: string;
  catches: string[];
  /** Index of the first body item (or of the closing paren). */
  bodyStart: number;
}

/** Parse the header of the `(try_table` that opens at `open`, or null if it has no unsafe result. */
function parseUnsafeHeader(text: string, open: number): TryTableHeader | null {
  let i = skipSpace(text, open + "(try_table".length);
  let label = "";
  if (text[i] === "$") {
    const end = skipItem(text, i);
    label = text.slice(i, end);
    i = skipSpace(text, end);
  }
  if (!text.startsWith("(result", i)) return null;
  const resultEnd = skipItem(text, i);
  const result = text.slice(i, resultEnd).replace(/\s+/g, " ");
  if (SAFE_RESULT.test(result)) return null;
  i = skipSpace(text, resultEnd);
  const catches: string[] = [];
  while (/^\(catch(?:_ref|_all|_all_ref)?[\s)]/.test(text.slice(i, i + 16))) {
    const end = skipItem(text, i);
    catches.push(text.slice(i, end));
    i = skipSpace(text, end);
  }
  return { label, result, catches, bodyStart: i };
}

/**
 * Rewrite every unsafe result-typed `try_table` in Binaryen-printed WAT.
 * Returns null when the module has none (the caller keeps its binary as-is).
 */
export function reshapeUnsafeTryTables(wat: string): string | null {
  if (!/\(try_table[^\n]*\(result/.test(wat)) return null;
  const out: string[] = [];
  // One entry per open paren: the text that replaces its closing paren.
  const closers: string[] = [];
  let copied = 0;
  let counter = 0;
  let i = 0;
  while (i < wat.length) {
    const c = wat[i]!;
    const past = skipComment(wat, i);
    if (past !== i) {
      i = past;
      continue;
    }
    if (c === '"') {
      i = skipString(wat, i);
      continue;
    }
    if (c === ")") {
      const closer = closers.pop() ?? ")";
      if (closer !== ")") {
        out.push(wat.slice(copied, i), closer);
        copied = i + 1;
      }
      i++;
      continue;
    }
    if (c !== "(") {
      i++;
      continue;
    }
    const header = wat.startsWith("(try_table", i) ? parseUnsafeHeader(wat, i) : null;
    if (!header) {
      closers.push(")");
      i++;
      continue;
    }
    const outer = `$__js2_tt${counter++}`;
    const inner = header.label ? `(block ${header.label} ${header.result}` : `(block ${header.result}`;
    out.push(
      wat.slice(copied, i),
      `(block ${outer} ${header.result} (try_table ${header.catches.join(" ")} (br ${outer} ${inner} `,
    );
    copied = header.bodyStart;
    i = header.bodyStart;
    closers.push("))) (unreachable))");
  }
  if (counter === 0) return null;
  out.push(wat.slice(copied));
  return out.join("");
}

/** Read the custom sections (id 0) of a Wasm binary, as raw section bytes keyed by name. */
function customSections(binary: Uint8Array): Map<string, Uint8Array> {
  const sections = new Map<string, Uint8Array>();
  const leb = (at: number): [number, number] => {
    let value = 0;
    let shift = 0;
    let p = at;
    for (;;) {
      const b = binary[p++]!;
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if ((b & 0x80) === 0) return [value, p];
    }
  };
  let p = 8;
  while (p < binary.length) {
    const start = p;
    const id = binary[p++]!;
    const [size, contentStart] = leb(p);
    const end = contentStart + size;
    if (id === 0) {
      const [nameLen, nameStart] = leb(contentStart);
      const name = new TextDecoder().decode(binary.subarray(nameStart, nameStart + nameLen));
      sections.set(name, binary.subarray(start, end));
    }
    p = end;
  }
  return sections;
}

/**
 * Re-append custom sections of `original` that re-assembling from text dropped
 * (Binaryen prints them as comments). The name section is regenerated by the
 * assembler itself when names are preserved, so it is never duplicated.
 */
export function restoreCustomSections(original: Uint8Array, reassembled: Uint8Array): Uint8Array {
  const kept = customSections(reassembled);
  const missing = [...customSections(original)].filter(([name]) => !kept.has(name)).map(([, bytes]) => bytes);
  if (missing.length === 0) return reassembled;
  const total = missing.reduce((n, s) => n + s.length, reassembled.length);
  const merged = new Uint8Array(total);
  merged.set(reassembled, 0);
  let at = reassembled.length;
  for (const s of missing) {
    merged.set(s, at);
    at += s.length;
  }
  return merged;
}
