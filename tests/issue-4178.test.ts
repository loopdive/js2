// #4178 — string-concatenating a value that lives in the boxed-any (`$AnyValue`)
// carrier produced `null` (then a null-pointer trap) or a numerically-folded
// wrong answer.
//
// TWO independent defects, both on the LEGACY AST→Wasm path:
//
//  (A) `coerceType`'s `ref → ref_null` arm was the only one of its four
//      siblings missing the `$AnyValue` UNBOX case. `compileAnyBinaryDispatch`
//      returns exactly `{kind:"ref", typeIdx:$AnyValue}`, so every `any`-operand
//      `+` result assigned to a NULLABLE slot fell through to a generic guarded
//      `ref.cast` — which tests the BOX against the target type, always fails,
//      and stores `ref.null`. The next reader (`__str_concat`, `.length`) then
//      dereferences null and TRAPS.
//
//  (B) `tryStaticToNumber` traced `const` initializers when resolving an
//      operand's VALUE but not when deciding whether `+` is string
//      concatenation, so `const a: any = "1"; const b: any = 2; a + b` folded to
//      `f64.const 3` instead of concatenating to `"12"`.
//
// The reported symptom was a mixed-type ternary (`true ? n : "s"`) whose result
// would not concatenate; that is (A) — the ternary merely produces the
// `$AnyValue`. It is NOT eval-mode-specific and NOT ternary-specific: the same
// break reproduces with no ternary at all (the `any` const rows below), and the
// eval boundary is irrelevant (verified across 30 probes, both with and without
// a `var __F = Function;` line).
//
// NOT fixed here, deliberately: the same mixed-type ternary inside an
// IR-ELIGIBLE function still hard-errors at `lowerConditional`
// (`ir/from-ast: ternary branches have different types`). That is the IR bail
// #4178 names, it is a separate slice, and the `stillDemotes` block at the
// bottom pins its CURRENT behaviour so the next owner sees the boundary.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// Standalone only — a pure-Wasm module needs no imports, so the assertion is
// about the compiler and nothing else. The HOST lane for the same mechanism is
// covered by `tests/equivalence/spec/coercion-arithmetic-add.test.ts`, which has
// the full `buildImports`/`buildRuntimeImports` harness (all four lanes) and
// whose two any-concat rows this change moves from baselined-red to green.
async function run(src: string): Promise<number> {
  const r = await compile(src, { fileName: "t.ts", target: "standalone", hostBridge: "always" } as never);
  expect(r.success, r.success ? undefined : r.errors?.[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as Record<string, () => number>).test!();
}

/**
 * Build `decls` at MODULE scope and concat inside the exported probe.
 *
 * Module scope is deliberate: it is the shape the bug was reported in (test262
 * top-level statements) and the one the legacy path actually owns — an
 * `export function` body containing a mixed-type ternary is IR-eligible and
 * still hits the unrelated `lowerConditional` bail (see `stillDemotes`).
 * Comparison is by TEXT, not by length: `"42"` and any other 2-character
 * string are not the same claim.
 */
const concatIs = (decls: string, expr: string, want: string) =>
  run(
    `${decls}\nexport function test(): number { const __got: string = ${expr}; return __got === ${JSON.stringify(want)} ? 1 : 0; }`,
  );

describe("#4178 — concat of a boxed-any value (standalone)", () => {
  // ── (A) mixed-type ternary: the reported repro. Each of these TRAPPED with
  //    "dereferencing a null pointer in __str_concat()" before the fix.
  it("mixed-type ternary result concatenates (number arm taken)", async () => {
    expect(await concatIs(`const n: number = 42; const v = true ? n : "s";`, `"" + v`, "42")).toBe(1);
  });

  it("mixed-type ternary result concatenates (string arm taken)", async () => {
    expect(await concatIs(`const n: number = 42; const v = false ? n : "str";`, `"" + v`, "str")).toBe(1);
  });

  it("operand order does not matter", async () => {
    expect(await concatIs(`const n: number = 42; const v = true ? n : "s";`, `v + ""`, "42")).toBe(1);
  });

  it("a non-empty prefix concatenates too", async () => {
    expect(await concatIs(`const n: number = 42; const v = true ? n : "s";`, `"x" + v`, "x42")).toBe(1);
  });

  it("boolean|string ternary arms concatenate", async () => {
    expect(await concatIs(`const b: boolean = true; const v = true ? b : "s";`, `"" + v`, "true")).toBe(1);
  });

  // ── (B) the const-traced numeric fold. No ternary involved — this is the
  //    proof that the mechanism is `any`-carrier concat, not conditionals.
  it("`any` string const + `any` number const concatenates, not adds", async () => {
    expect(await concatIs(`const a: any = "1"; const b: any = 2;`, `a + b`, "12")).toBe(1);
  });

  it("`any` string const + `any` string const concatenates", async () => {
    expect(await concatIs(`const a: any = "x"; const b: any = "y";`, `a + b`, "xy")).toBe(1);
  });

  it("a const chain to a string literal still poisons the numeric fold", async () => {
    expect(await concatIs(`const s0 = "1"; const a: any = s0; const b: any = 2;`, `a + b`, "12")).toBe(1);
  });

  // ── NEGATIVE CONTROLS — the fold must still happen where `+` is genuinely
  //    numeric. Without these, a change that simply disabled constant folding
  //    would pass every row above.
  it("numeric const folding is preserved", async () => {
    expect(
      await run(
        `const a: any = 1; const b: any = 2;\nexport function test(): number { return ((a + b) as number) === 3 ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("a numeric const chain still folds", async () => {
    expect(
      await run(
        `const x = 4; const a: any = x; const b: any = 2;\nexport function test(): number { return ((a + b) as number) === 6 ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("`let` is never traced (neither for string-ness nor for value)", async () => {
    expect(await concatIs(`let a: any = "1"; const b: any = 2;`, `a + b`, "12")).toBe(1);
  });

  it("same-type ternary arms still concatenate", async () => {
    expect(await concatIs(`const t: string = "a"; const v = true ? t : "s";`, `"" + v`, "a")).toBe(1);
  });

  // String()/Number()/typeof over the same value were ALREADY correct on main —
  // only concat was broken. Pin them so a fix that shifted the breakage sideways
  // is caught.
  it("String()/Number()/typeof of a mixed-type ternary stay correct", async () => {
    expect(
      await run(
        `const n: number = 42; const v = true ? n : "s";\n` +
          `export function test(): number { return String(v) === "42" && Number(v) === 42 && typeof v === "number" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});

// The boundary of this change, pinned rather than described. When the
// `lowerConditional` bail is retired, this block flips and should be deleted.
describe("#4178 — NOT fixed here: mixed-type ternary in an IR-eligible function", () => {
  it("still demotes with a hard IR-FALLBACK error", async () => {
    const r = await compile(
      `export function test(c: boolean): string { const n: number = 42; const v = c ? n : "s"; return "" + v; }`,
      { fileName: "t.ts", target: "standalone" } as never,
    );
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toContain("ternary branches have different types");
  });
});
