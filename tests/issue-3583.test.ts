// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3583 — IR adoption-matrix re-own, measure-first. The two adoptions this
// issue lands, both found by live measurement (.tmp/ir-adoption-probes.ts,
// 2026-08-15) rather than by reading the matrix notes:
//
//   1. Type-erased assertion wrappers — `x as T`, `<T>x`, `x satisfies T`,
//      `x!`. The matrix listed these `direct-only` and the issue text claimed
//      they were "transparent pass-throughs" already. Measurement disproved
//      that: EVERY such shape rejected at the selector's `expr-unhandled` arm.
//      The `isAsExpression` sites that existed in select.ts (:5744, :6125) are
//      helper-local unwrappers inside `expressionIsProvenNumber` /
//      `unwrapProjectionExpression` — specific analyses, not the shape gate.
//      Adoption: one arm in `isPhase1Expr` + the mirroring arm in `lowerExpr`.
//
//   2. Bare `for (;;)` — an omitted condition is exactly `for (; true; )` per
//      the spec, and the constant-true form was ALREADY claimed and lowered.
//      So the slice-12 `for-missing-cond` reject was a lowering gap, not a
//      semantic one. Adoption: drop the reject, emit the `true` constant
//      directly in the cond buffer (no synthetic AST node — a parentless
//      `ts.factory.createTrue()` has no checker identity, and the downstream
//      cond helpers are AST-position-sensitive).
//
// Every positive case is CLAIM-BACKED (the selector must actually claim, so a
// green "IR matches legacy" assertion can never be vacuously satisfied by the
// legacy body) AND equivalence-checked against the legacy path. The negative
// boundaries pin shapes that are still legitimately rejected, so a future
// widening cannot silently claim them without updating this file.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { buildImports } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

/** The `wasm:js-string` builtins a string-touching probe needs to instantiate. */
const JS_STRING_STUB = {
  concat: (a: string, b: string) => a + b,
  length: (s: string) => s.length,
  equals: (a: string, b: string) => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number) => s.substring(start, end),
  charCodeAt: (s: string, i: number) => s.charCodeAt(i),
  fromCharCode: (c: number) => String.fromCharCode(c),
  cast: (s: unknown) => String(s),
  test: (v: unknown) => (typeof v === "string" ? 1 : 0),
};

async function instantiate(source: string, experimentalIR: boolean): Promise<Record<string, unknown>> {
  const r = await compile(source, { experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
    "wasm:js-string": JS_STRING_STUB,
  });
  return instance.exports as Record<string, unknown>;
}

function claims(source: string, name: string): boolean {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  return new Set(planIrCompilation(sf, { experimentalIR: true }).funcs).has(name);
}

/** Genuine emission, not a mere claim: the slot must carry an IR body. */
async function irEmitted(source: string, name: string): Promise<boolean> {
  const r = await compile(source, { trackIrOutcomes: true });
  const outcome = (r.irOutcomes ?? []).find((o) => o.displayName === name);
  return outcome?.kind === "emitted" && outcome.irBodyEmitted === true;
}

/** Assert IR and legacy agree on the same call, and that IR really ran. */
async function expectIrLegacyParity(source: string, name: string, args: unknown[], expected: unknown): Promise<void> {
  expect(claims(source, name)).toBe(true);
  expect(await irEmitted(source, name)).toBe(true);
  const legacy = await instantiate(source, false);
  const ir = await instantiate(source, true);
  const call = (exports: Record<string, unknown>) => (exports[name] as (...a: unknown[]) => unknown)(...args);
  expect(call(legacy)).toBe(expected);
  expect(call(ir)).toBe(expected);
}

describe("#3583 — type-erased assertion wrappers are IR-claimed and lowered", () => {
  it("`x as T` in return position", async () => {
    await expectIrLegacyParity(`export function f(x: number): number { return (x as number) + 1; }`, "f", [41], 42);
  });

  it("`x as T` in a const initializer", async () => {
    await expectIrLegacyParity(
      `export function f(x: number): number { const y = x as number; return y * 2; }`,
      "f",
      [21],
      42,
    );
  });

  it("`x as T` in a call argument (callee stays in the claim set)", async () => {
    const src = `function dbl(a: number): number { return a * 2; }\nexport function f(x: number): number { return dbl(x as number); }`;
    // Both the caller AND the callee must be claimed — an unclaimed callee
    // would drop `f` via `call-graph-closure` instead.
    expect(claims(src, "dbl")).toBe(true);
    await expectIrLegacyParity(src, "f", [21], 42);
  });

  it("double assertion `x as unknown as T` unwraps to the operand", async () => {
    await expectIrLegacyParity(
      `export function f(x: number): number { return (x as unknown as number) + 1; }`,
      "f",
      [41],
      42,
    );
  });

  it("`x as T` as a property-access receiver", async () => {
    await expectIrLegacyParity(
      `export function f(x: string): number { return (x as string).length; }`,
      "f",
      ["abcd"],
      4,
    );
  });

  // --- `<T>x` and `satisfies`: IR is SPEC-CORRECT, legacy is NOT.
  //
  // Measured 2026-08-15 (.tmp/probe-assert-runtime.ts) — a PRE-EXISTING legacy
  // direct-codegen bug this adoption incidentally fixes for claimed functions:
  //
  //   source                             legacy   IR
  //   `return <number>x;`      (x=41)      0       41   ← 41 is correct
  //   `return (<number>x) + 1;`(x=41)      1       42   ← 42 is correct
  //   `return (x satisfies number) + 1;`   1       42   ← 42 is correct
  //
  // Legacy evaluates the assertion's OPERAND as 0: it has no handler for
  // `TypeAssertionExpression` / `SatisfiesExpression` and silently yields the
  // zero value instead of erroring. `as` / `!` are unaffected (legacy handles
  // those), which is exactly why only these two forms diverge.
  //
  // UPDATE 2026-08-15 (#4458/#4578): the legacy bug was FIXED — the missing
  // `TypeAssertionExpression`/`SatisfiesExpression` dispatcher arms were added,
  // mirroring `AsExpression`. The tripwire below fired exactly as designed
  // (the wrong-answer pins failed loudly when the fix landed), so both cases
  // now assert full IR/legacy PARITY on the spec answer.
  it("`<T>x` — IR and legacy agree on the spec answer (legacy fixed by #4458)", async () => {
    const src = `export function f(x: number): number { return (<number>x) + 1; }`;
    expect(claims(src, "f")).toBe(true);
    expect(await irEmitted(src, "f")).toBe(true);
    expect(((await instantiate(src, true)).f as (n: number) => number)(41)).toBe(42);
    expect(((await instantiate(src, false)).f as (n: number) => number)(41)).toBe(42);
  });

  it("`x satisfies T` — IR and legacy agree on the spec answer (legacy fixed by #4458)", async () => {
    const src = `export function f(x: number): number { return (x satisfies number) + 1; }`;
    expect(claims(src, "f")).toBe(true);
    expect(await irEmitted(src, "f")).toBe(true);
    expect(((await instantiate(src, true)).f as (n: number) => number)(41)).toBe(42);
    expect(((await instantiate(src, false)).f as (n: number) => number)(41)).toBe(42);
  });

  it("non-null assertion `x!`", async () => {
    await expectIrLegacyParity(`export function f(x: number): number { return x! + 1; }`, "f", [41], 42);
  });

  it("assertion inside a loop body still lowers (buffered cond/body path)", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { let s = 0; for (let i = 0; i < n; i++) { s = s + (i as number); } return s; }`,
      "f",
      [5],
      10,
    );
  });

  // --- negative boundaries: the assertion is transparent, so the OPERAND's
  // own rejection must still reject. A regression here would mean the arm is
  // swallowing shapes instead of delegating.
  it("does NOT claim through an assertion onto a still-unsupported operand", () => {
    // `**` is rejected at `expr-binary-op-**`; wrapping it in `as number`
    // must not launder it into the claim set.
    expect(claims(`export function f(x: number): number { return (x ** 2) as number; }`, "f")).toBe(false);
    // Likewise the comma operator.
    expect(claims(`export function f(x: number): number { return (x + 1, x + 2) as number; }`, "f")).toBe(false);
  });

  it("does NOT claim `x!` when the underlying local is union-typed", () => {
    // Rejected at `vardecl-typenode:UnionType` — the union local, not the `!`.
    expect(claims(`export function f(x: string): number { const y: string | null = x; return y!.length; }`, "f")).toBe(
      false,
    );
  });
});

describe("#3583 — bare `for (;;)` is IR-claimed and lowered", () => {
  it("`for (;;)` with a break matches legacy", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { let i = 0; for (;;) { i = i + 1; if (i > n) break; } return i; }`,
      "f",
      [5],
      6,
    );
  });

  it("`for (init; ; incr)` — omitted condition only", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { let r = 0; for (let i = 0; ; i++) { r = i; if (i >= n) break; } return r; }`,
      "f",
      [4],
      4,
    );
  });

  it("`for (;;)` accumulating across iterations matches legacy", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { let s = 0; let i = 0; for (;;) { s = s + i; i = i + 1; if (i >= n) break; } return s; }`,
      "f",
      [5],
      10,
    );
  });

  it("`for (;;)` is byte-equivalent to the already-claimed `for (; true; )`", async () => {
    const bare = `export function f(n: number): number { let i = 0; for (;;) { i = i + 1; if (i > n) break; } return i; }`;
    const explicit = `export function f(n: number): number { let i = 0; for (; true; ) { i = i + 1; if (i > n) break; } return i; }`;
    const a = await compile(bare, { experimentalIR: true });
    const b = await compile(explicit, { experimentalIR: true });
    expect(a.success && b.success).toBe(true);
    // The omitted condition emits the SAME `true` constant the TrueKeyword arm
    // emits, so the two programs must produce identical binaries.
    expect(Buffer.from(a.binary!).equals(Buffer.from(b.binary!))).toBe(true);
  });

  // --- negative boundary: a `for (;;)` in TAIL position is still rejected,
  // by the orthogonal `tail-unhandled` gate (a `return` inside a trailing
  // loop), NOT by the retired `for-missing-cond` arm. Pinning it keeps the
  // two gates from being conflated in a future widening.
  it("does NOT claim a tail-position `for (;;)` that returns from inside", () => {
    expect(
      claims(`export function f(n: number): number { let i = 0; for (;;) { i = i + 1; if (i > n) return i; } }`, "f"),
    ).toBe(false);
  });
});
