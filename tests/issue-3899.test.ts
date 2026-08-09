// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3899 — gc-native String scan kernels.
 *
 * The affix compares (`startsWith`/`endsWith`), the trim boundary scans and
 * `indexOf`'s candidate scan were rewritten to run through i32 rep kernels
 * (`__str_region_eq`, `__str_ws_start`/`__str_ws_end`, and `__str_indexOf`'s
 * first-code-unit skip). These are pure lowering changes with NO observable
 * semantics, so the tests below are behaviour-equivalence sweeps: every case
 * is compiled in native-strings (fast) mode and checked against the host JS
 * result for the same expression.
 *
 * The sweeps deliberately cover the boundaries the kernels' preconditions rest
 * on — empty needles/receivers, `position` clamps past both ends (#2875),
 * cons-string (rope) receivers AND needles (the kernels' `ref.test`-guarded
 * flatten), the complete §22.1.3.32 whitespace class plus its near-miss
 * neighbours (the ASCII fast path must not swallow or invent a member), and
 * repeated-prefix haystacks where the first-code-unit skip has to fall into
 * the full compare and back out again.
 */
import { describe, it, expect } from "vitest";
import { compile, buildImports, instantiateWasm } from "../src/index.js";

/**
 * Compile one module whose exports are `f0..fN`, each returning a number, and
 * run them all. Native-strings exports cannot take JS strings across the
 * boundary, so every case is baked into the source as a literal.
 */
async function runProbes(bodies: string[]): Promise<number[]> {
  const source = bodies.map((b, i) => `export function f${i}(): number { ${b} }`).join("\n");
  const result = await compile(source, { fast: true });
  if (!result.success) {
    throw new Error("compile failed: " + result.errors.map((e) => e.message).join("; "));
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  const exports = instance.exports as Record<string, () => number>;
  return bodies.map((_, i) => exports[`f${i}`]!() | 0);
}

const q = (s: string) => JSON.stringify(s);

/** Length + content digest, so a view with the right length but wrong `off` fails. */
function digest(s: string): number {
  let h = (s.length * 1000003) | 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
const DIGEST_SRC = (expr: string) =>
  `const r = ${expr}; let h = r.length * 1000003; for (let i = 0; i < r.length; i = i + 1) { h = (h * 31 + r.charCodeAt(i)) | 0; } return h;`;

describe("#3899 gc-native string scan kernels", () => {
  it("startsWith / endsWith match host semantics across clamps and empty affixes", async () => {
    const strings = ["", "a", "ab", "hello", "hello world", "  hello  ", "αβγ", "hello world, this is a test"];
    const positions = [-5, -1, 0, 1, 3, 11, 27, 100, 2147483647];

    const bodies: string[] = [];
    const expected: number[] = [];
    for (const s of strings) {
      for (const n of strings) {
        for (const p of positions) {
          bodies.push(`return ${q(s)}.startsWith(${q(n)}, ${p}) ? 1 : 0;`);
          expected.push(s.startsWith(n, p) ? 1 : 0);
          bodies.push(`return ${q(s)}.endsWith(${q(n)}, ${p}) ? 1 : 0;`);
          expected.push(s.endsWith(n, p) ? 1 : 0);
        }
        bodies.push(`return ${q(s)}.startsWith(${q(n)}) ? 1 : 0;`);
        expected.push(s.startsWith(n) ? 1 : 0);
        bodies.push(`return ${q(s)}.endsWith(${q(n)}) ? 1 : 0;`);
        expected.push(s.endsWith(n) ? 1 : 0);
      }
    }

    const got = await runProbes(bodies);
    const mismatches = bodies.filter((b, i) => got[i] !== expected[i]);
    expect(mismatches).toEqual([]);
    // Guard against a vacuous sweep (all-false would also produce no mismatch).
    expect(expected.filter((v) => v === 1).length).toBeGreaterThan(50);
  }, 120_000);

  it("startsWith / endsWith handle cons-string (rope) receivers and needles", async () => {
    const parts = ["", "a", "abc", "hello ", "world"];
    const bodies: string[] = [];
    const expected: number[] = [];
    for (const a1 of parts) {
      for (const a2 of parts) {
        for (const b1 of parts) {
          for (const b2 of parts) {
            bodies.push(`return (${q(a1)} + ${q(a2)}).startsWith(${q(b1)} + ${q(b2)}) ? 1 : 0;`);
            expected.push((a1 + a2).startsWith(b1 + b2) ? 1 : 0);
            bodies.push(`return (${q(a1)} + ${q(a2)}).endsWith(${q(b1)} + ${q(b2)}) ? 1 : 0;`);
            expected.push((a1 + a2).endsWith(b1 + b2) ? 1 : 0);
          }
        }
      }
    }
    const got = await runProbes(bodies);
    expect(bodies.filter((b, i) => got[i] !== expected[i])).toEqual([]);
  }, 120_000);

  it("trim / trimStart / trimEnd match host semantics over the whole whitespace class", async () => {
    // §22.1.3.32 WhiteSpace + LineTerminator.
    const ws = [
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
      0xfeff,
    ];
    // Near-miss neighbours: the kernel's ASCII fast path must not claim these,
    // and must still defer every code unit > 0x7F to the self-hosted table.
    const near = [
      0x08, 0x0e, 0x1f, 0x21, 0x41, 0x7f, 0x80, 0x9f, 0xa1, 0x167f, 0x1681, 0x1fff, 0x200b, 0x2027, 0x202a, 0x202e,
      0x2030, 0x205e, 0x2060, 0x2fff, 0x3001, 0xfefe,
    ];

    const cases = ["", " ", "   ", "abc", " abc", "abc ", "  abc  ", "\t\n\v\f\r abc \r\f\v\n\t", "a b c"];
    for (const c of [...ws, ...near]) {
      const ch = String.fromCharCode(c);
      cases.push(ch, ch + "x", "x" + ch, ch + ch, ch + "x" + ch, " " + ch + "x" + ch + " ");
    }
    for (const c of ws) cases.push(String.fromCharCode(c).repeat(4));

    const bodies: string[] = [];
    const expected: number[] = [];
    for (const s of cases) {
      for (const method of ["trim", "trimStart", "trimEnd"] as const) {
        bodies.push(DIGEST_SRC(`${q(s)}.${method}()`));
        expected.push(digest(s[method]()));
      }
    }
    const got = await runProbes(bodies);
    const bad = cases.flatMap((s, ci) =>
      (["trim", "trimStart", "trimEnd"] as const)
        .map((m, mi) => (got[ci * 3 + mi] !== expected[ci * 3 + mi] ? `${q(s)}.${m}()` : null))
        .filter((x): x is string => x !== null),
    );
    expect(bad).toEqual([]);
  }, 120_000);

  it("indexOf / lastIndexOf / includes match host semantics incl. repeated-prefix haystacks", async () => {
    const hay = ["", "a", "aa", "aaa", "abab", "ababab", "banana", "the quick brown fox", "aabaabaaab", "αβγαβγ"];
    const needles = ["", "a", "b", "ab", "aab", "aaa", "banana", "nana", "z", "the", "fox", "αβ", "γα"];
    const from = [-3, -1, 0, 1, 2, 5, 10, 100, 2147483647];

    const bodies: string[] = [];
    const expected: number[] = [];
    for (const h of hay) {
      for (const n of needles) {
        for (const f of from) {
          bodies.push(`return ${q(h)}.indexOf(${q(n)}, ${f});`);
          expected.push(h.indexOf(n, f));
          bodies.push(`return ${q(h)}.lastIndexOf(${q(n)}, ${f});`);
          expected.push(h.lastIndexOf(n, f));
        }
        bodies.push(`return ${q(h)}.indexOf(${q(n)});`);
        expected.push(h.indexOf(n));
        bodies.push(`return ${q(h)}.includes(${q(n)}) ? 1 : 0;`);
        expected.push(h.includes(n) ? 1 : 0);
        // cons receiver + cons needle — the kernel's flatten guard
        bodies.push(`return (${q(h)} + "").indexOf(${q(n)} + "");`);
        expected.push(h.indexOf(n));
      }
    }
    const got = await runProbes(bodies);
    expect(bodies.filter((b, i) => got[i] !== expected[i])).toEqual([]);
  }, 120_000);
});
