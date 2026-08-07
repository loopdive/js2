import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #4173 — fast tag-pair dispatch in `__extern_strict_eq` + single-convert
// `__is_truthy` (standalone dynamic-eq lowering).
//
// The battery pins §7.2.16 IsStrictlyEqual / §7.1.2 ToBoolean semantics on
// BOXED (any-typed) operands, which route through `__extern_strict_eq` /
// `__is_truthy` in standalone mode, under BOTH flag regimes:
//   - fastStrictEq: false → legacy body (identity → `__any_from_extern` ×2 →
//     `__any_strict_eq`)
//   - fastStrictEq: true (default) → identity → local tag-pair dispatch
//     (f64.eq / `__str_equals` / normalized bool / i64.eq / fast-false), with
//     `$AnyValue` carriers still falling through to the legacy path.
//
// Sacred semantics covered: NaN !== NaN (boxed AND same-box self-compare),
// +0 === -0, string VALUE equality incl. rope-built strings (never identity),
// boxed-number × boxed-number numeric compare, no cross-type truthiness
// (1 !== true, "x" !== object), object/symbol identity, indexOf's use of the
// same helper, and truthiness on every falsy box.

const SRC = `
class Tok { label: string; constructor(label: string) { this.label = label; } }
function anyv(x: any): any { return x; }
export function test(): number {
  const a: any = anyv(new Tok("a"));
  const b: any = anyv(new Tok("b"));
  const a2: any = anyv(a);
  const nan: any = anyv(NaN);
  const zero: any = anyv(0);
  const negzero: any = anyv(-0);
  const one: any = anyv(1);
  const frac: any = anyv(1e9 + 0.5);
  const s1: any = anyv("hel" + "lo");
  const s2: any = anyv("hello");
  const s3: any = anyv("world");
  const t: any = anyv(true);
  const t2: any = anyv(true);
  const f: any = anyv(false);
  const u: any = anyv(undefined);
  const n: any = anyv(null);
  if (!(a === a2)) return 1;
  if (a === b) return 2;
  if (nan === nan) return 3;
  if (!(nan !== nan)) return 4;
  if (!(zero === negzero)) return 5;
  if (!(one === anyv(1))) return 6;
  if (one === anyv(2)) return 7;
  if (!(frac === anyv(1e9 + 0.5))) return 8;
  if (!(s1 === s2)) return 9;
  if (s1 === s3) return 10;
  if (!(t === t2)) return 11;
  if (t === f) return 12;
  if (one === t) return 13;
  if (t === one) return 14;
  if (s2 === a) return 15;
  if (a === s2) return 16;
  if (one === s2) return 17;
  if (s2 === one) return 18;
  if (s2 === t) return 19;
  if (u === n) return 20;
  if (!(u === anyv(undefined))) return 21;
  if (!(n === anyv(null))) return 22;
  if (a === one) return 23;
  if (a === u) return 24;
  if (a === n) return 25;
  const arr: any[] = [a, b];
  if (arr.indexOf(a) !== 0) return 26;
  if (arr.indexOf(b) !== 1) return 27;
  if (arr.indexOf(new Tok("a")) !== -1) return 28;
  if (u) return 29;
  if (n) return 30;
  if (!a) return 31;
  if (!t) return 32;
  if (f) return 33;
  if (!one) return 34;
  if (zero) return 35;
  if (negzero) return 36;
  if (nan) return 37;
  if (!s2) return 38;
  if (anyv("")) return 39;
  return 0;
}`;

async function runStandalone(fastStrictEq: boolean): Promise<unknown> {
  const result = (await compile(SRC, {
    fileName: "issue-4173.ts",
    target: "standalone",
    fastStrictEq,
    // biome-ignore lint/suspicious/noExplicitAny: test harness introspection
  })) as any;
  if (!result.success) {
    // biome-ignore lint/suspicious/noExplicitAny: test harness introspection
    throw new Error(`Compile failed:\n${result.errors.map((e: any) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = result.importObject ?? buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setExports?: (e: object) => void }).__setExports?.(instance.exports as object);
  // biome-ignore lint/suspicious/noExplicitAny: test harness introspection
  return (instance.exports as any).test();
}

describe("#4173 boxed strict-eq / truthiness lowering (standalone)", () => {
  it("legacy body (fastStrictEq: false) answers the full battery", async () => {
    expect(await runStandalone(false)).toBe(0);
  });

  it("fast tag-pair dispatch (fastStrictEq: true, default) answers identically", async () => {
    expect(await runStandalone(true)).toBe(0);
  });
});
