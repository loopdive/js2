// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4471 — IR adoption of the EMPTY object literal `{}`, measure-first.
//
// `{}` rejected at `objectlit-empty` while `{a: 1}` and `{ a }` already
// claimed. The standing reject comment blamed the IR object shape ("zero-
// property objects don't form a usable IrType.object shape"); measurement
// disproved that — a fieldless `object.new` registers as an ordinary struct and
// lowers fine. The real constraint is downstream: a zero-field shape can serve
// NO field access, so every use beyond "the value exists" fails in lowering.
//
// Lifting the reject wholesale turned 6 clean `unsupported` rejects into gated
// post-claim `invariant` demotions, so the adoption is narrow: an empty literal
// initializing an un-annotated local binding that is never REFERENCED.
//
// The zero-reference rule is measured, not a conservative guess. A whitelist of
// "obviously inert" reference forms was tried first and every candidate leaked
// — `if (o)` lowered but `if (o) {…} else {…}` demoted with "if condition must
// be bool" (the IR has no ToBoolean for a ref), and `o ? a : b` demoted too.
// Those leaks are pinned as negative tests below so a future widening cannot
// re-derive the same broken whitelist.
//
// Every positive is CLAIM-BACKED (the selector must actually claim, so a green
// "IR matches legacy" assertion can never be vacuously satisfied by the legacy
// body) and dual-run equality-checked. Every negative asserts BOTH that the
// shape is not claimed AND that it never reaches a post-claim `invariant`.

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

async function outcomeOf(source: string, name: string): Promise<string> {
  const r = await compile(source, { trackIrOutcomes: true });
  return (r.irOutcomes ?? []).find((o) => o.displayName === name)?.kind ?? "none";
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

/**
 * A deferred shape must reject CLEANLY. `invariant` is the failure this issue
 * exists to avoid: it means the selector claimed and lowering then could not
 * deliver, which is a hard error under the IR-only policy. Legacy must still
 * produce the right answer.
 */
async function expectCleanReject(source: string, name: string, args: unknown[], expected: unknown): Promise<void> {
  expect(claims(source, name)).toBe(false);
  expect(await outcomeOf(source, name)).not.toBe("invariant");
  const legacy = await instantiate(source, false);
  const ir = await instantiate(source, true);
  const call = (exports: Record<string, unknown>) => (exports[name] as (...a: unknown[]) => unknown)(...args);
  expect(call(legacy)).toBe(expected);
  expect(call(ir)).toBe(expected);
}

describe("#4471 — inert empty object literals are IR-claimed and lowered", () => {
  it("an unreferenced `const o = {}` no longer drops the function to legacy", async () => {
    await expectIrLegacyParity(`export function f(n: number): number { const o = {}; return n + 1; }`, "f", [41], 42);
  });

  it("two unreferenced empty literals in the same body", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = {}; const p = {}; return n + 1; }`,
      "f",
      [41],
      42,
    );
  });

  it("an empty literal inside a loop body (fresh allocation per iteration)", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { let c = 0; for (let i = 0; i < n; i++) { const o = {}; c++; } return c; }`,
      "f",
      [3],
      3,
    );
  });

  it("an empty literal alongside real work in the same function", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = {}; let acc = 0; for (let i = 0; i < n; i++) { acc += i; } return acc; }`,
      "f",
      [4],
      6,
    );
  });

  it("`let o = {}` that is never referenced is claimable too", async () => {
    await expectIrLegacyParity(`export function f(n: number): number { let o = {}; return n * 2; }`, "f", [21], 42);
  });

  it("the non-empty literal claim is untouched", async () => {
    await expectIrLegacyParity(
      `export function f(n: number): number { const o = { a: 1 }; return o.a + n; }`,
      "f",
      [41],
      42,
    );
  });
});

describe("#4471 — a zero-field shape can serve no field access, so these stay rejected", () => {
  it("a property WRITE through an `as any` escape (the expando shape)", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = {}; (o as any).x = 1; return n; }`,
      "f",
      [41],
      41,
    );
  });

  it("a property READ through an `as any` escape", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = {}; return ((o as any).x as number) + n; }`,
      "f",
      [41],
      NaN,
    );
  });

  it("flow into a `dynamic` (`any`) parameter", async () => {
    await expectCleanReject(
      `function g(x: any): number { return 1; }\nexport function f(n: number): number { const o = {}; return g(o) + n; }`,
      "f",
      [41],
      42,
    );
  });

  it("`typeof o`", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = {}; return typeof o === "object" ? 1 : n; }`,
      "f",
      [41],
      1,
    );
  });

  it("an array-literal element", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = {}; const a = [o]; return n + 1; }`,
      "f",
      [41],
      42,
    );
  });

  it("an identity comparison", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = {}; const p = {}; return o === p ? 1 : n; }`,
      "f",
      [41],
      41,
    );
  });

  it("an alias — `p`'s own uses are not tracked by this arm", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = {}; const p = o; return n + 1; }`,
      "f",
      [41],
      42,
    );
  });

  it("a capture by a nested closure counts as a reference", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = {}; const g = (): number => (o ? 1 : 0); return g() + n; }`,
      "f",
      [41],
      42,
    );
  });
});

describe("#4471 — the truthiness whitelist that measurement rejected", () => {
  // These four pin the leak. `if (o)` alone lowers, which is exactly what makes
  // a truthiness whitelist look safe; `if/else` and `?:` demote because the IR
  // has no ToBoolean for a ref. Admitting any of them re-opens the leak.
  it("`if (o)` with no else — lowers in isolation, but is NOT admitted", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = {}; if (o) { return 1; } return n; }`,
      "f",
      [41],
      1,
    );
  });

  it("`if (o) {…} else {…}` — the form that demoted with 'if condition must be bool'", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = {}; if (o) { return 1; } else { return n; } }`,
      "f",
      [41],
      1,
    );
  });

  it("the conditional expression `o ? a : b`", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = {}; return o ? n + 1 : 0; }`,
      "f",
      [41],
      42,
    );
  });

  it("`while (o && …)`", async () => {
    await expectCleanReject(
      `export function f(n: number): number { let c = 0; const o = {}; while (o && c < n) { c++; } return c; }`,
      "f",
      [3],
      3,
    );
  });
});

describe("#4471 — annotated bindings keep legacy's other `{}` representations", () => {
  // Legacy picks an open `$Object` externref or a WIDENED struct for these, not
  // a closed fieldless struct, so the un-annotated form is a precondition.
  it("`const o: any = {}`", async () => {
    await expectCleanReject(`export function f(n: number): number { const o: any = {}; return n + 1; }`, "f", [41], 42);
  });

  it("`const o: object = {}`", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o: object = {}; return n + 1; }`,
      "f",
      [41],
      42,
    );
  });

  it("`const o: {} = {}`", async () => {
    await expectCleanReject(`export function f(n: number): number { const o: {} = {}; return n + 1; }`, "f", [41], 42);
  });
});

describe("#4471 — shapes still deferred, each for a typed reason", () => {
  it("nested property value `{ a: {} }` — safe shallow, but `p.a.x` demotes", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const p = { a: {} }; return n + 1; }`,
      "f",
      [41],
      42,
    );
  });

  it("a deep write through a nested empty — the reason the shallow case is not claimed", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const p = { a: {} }; (p.a as any).x = 1; return n; }`,
      "f",
      [41],
      41,
    );
  });

  it("a `{}` return TypeNode — IrType.object has no zero-field representation", async () => {
    await expectCleanReject(
      `function g(): {} { const o = {}; return o; }\nexport function f(n: number): number { g(); return n + 1; }`,
      "f",
      [41],
      42,
    );
  });

  it("a text-identical property key counts as a reference (TEXT matching over-approximates)", async () => {
    await expectCleanReject(
      `export function f(n: number): number { const o = {}; const p = { o: 1 }; return p.o + n; }`,
      "f",
      [41],
      42,
    );
  });
});
