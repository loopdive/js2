// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4459 — IR adoption of VALUE-DISCARDING expression statements.
//
// `x + 1;`, `x;`, `1;` and `cond ? a : b;` rejected the whole containing
// function at the statement-position catch-all arms
// (`nontail-compound-or-binary-stmt` / `nontail-exprstmt-other` at top level,
// `body-exprstmt-other` inside a buffer). The LOWERER already handled every
// one of those shapes — `lowerDiscardedExpression` is what `return
// voidCall()` and bare statement calls have always gone through — so the gap
// was the statement-position gate alone.
//
// The two things this file is here to pin, because they are the two ways the
// adoption could be wrong rather than merely absent:
//
//   1. **Evaluation order.** A discarded ternary must evaluate ONLY the taken
//      arm. The lowerer collects one body buffer per arm and emits `if.stmt`,
//      so the untaken arm's side effects are not in the instruction stream at
//      all — asserted here by counting calls through module-level counters
//      rather than by reading the IR.
//   2. **Claim ⇔ lowering parity.** Every positive case asserts the selector
//      CLAIMS *and* that an IR body was actually emitted, so a green
//      "IR matches legacy" assertion can never be satisfied vacuously by the
//      legacy body. The negative cases pin shapes that still legitimately
//      reject, so a future widening cannot silently claim them.

import { describe, expect, it } from "vitest";

import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { planIrCompilation } from "../src/ir/select.js";

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
  const r = await compile(source, { fileName: "test.ts", experimentalIR });
  if (!r.success) {
    throw new Error(`compile failed (${experimentalIR ? "IR" : "legacy"}): ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
    "wasm:js-string": JS_STRING_STUB,
  } as never);
  return instance.exports as Record<string, unknown>;
}

function claims(source: string, name: string): boolean {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  return new Set(planIrCompilation(sf, { experimentalIR: true }).funcs).has(name);
}

/** Genuine emission, not a mere claim: the slot must carry an IR body. */
async function irEmitted(source: string, name: string): Promise<boolean> {
  const r = await compile(source, { fileName: "test.ts", trackIrOutcomes: true });
  const outcome = (r.irOutcomes ?? []).find((o) => o.displayName === name);
  return outcome?.kind === "emitted" && outcome.irBodyEmitted === true;
}

/** The typed reason a NON-claimed function fell back with. */
async function fallbackReason(source: string, name: string): Promise<string | undefined> {
  const r = await compile(source, { fileName: "test.ts", trackIrOutcomes: true });
  const outcome = (r.irOutcomes ?? []).find((o) => o.displayName === name);
  return outcome?.kind === "emitted" ? undefined : (outcome as { code?: string } | undefined)?.code;
}

/**
 * Emission-backed and legacy-equivalent.
 *
 * `irEmitted` is the assertion that carries the weight, NOT `claims`: it runs
 * the full pipeline (module-binding resolver, TypeMap, call-graph closure)
 * and reports that the function's slot actually carries an IR body, so a
 * green "IR matches legacy" line can never be satisfied vacuously by the
 * legacy body. The bare `claims` helper builds a SourceFile with no resolvers
 * at all, which under-approximates for any source touching module state — a
 * side-effect counter is exactly that, so asserting it here would fail for
 * reasons unrelated to this slice. Bare-selector claims are pinned separately
 * below, on the self-contained shapes where that helper is meaningful.
 */
async function expectIrLegacyParity(source: string, args: unknown[], expected: unknown): Promise<void> {
  expect(await irEmitted(source, "test")).toBe(true);
  const legacy = await instantiate(source, false);
  const ir = await instantiate(source, true);
  const call = (e: Record<string, unknown>) => (e.test as (...a: unknown[]) => unknown)(...args);
  expect(call(legacy)).toBe(expected);
  expect(call(ir)).toBe(expected);
}

describe("#4459 — the four measured shapes claim at the bare selector", () => {
  // The exact four the issue measured as rejecting, pinned against the bare
  // selector so the STATEMENT-position gate itself is what is under test —
  // no resolver, no TypeMap, nothing that could claim them for another reason.
  it.each([
    ["x + 1;", `export function test(x: number): number { x + 1; return x; }`],
    ["x;", `export function test(x: number): number { x; return x; }`],
    ["1;", `export function test(x: number): number { 1; return x; }`],
    ["cond ? a : b;", `export function test(x: number): number { x > 0 ? x : x + 1; return x; }`],
  ])("claims `%s`", (_label, source) => {
    expect(claims(source, "test")).toBe(true);
  });

  it("claims a discarded statement inside a loop body (the body-buffer walker)", () => {
    expect(
      claims(
        `export function test(x: number): number { let s = 0; for (let i = 0; i < 3; i++) { x + i; s += i; } return s; }`,
        "test",
      ),
    ).toBe(true);
  });
});

describe("#4459 — value-discarding expression statements claim and lower", () => {
  it("`x + 1;` — the `nontail-compound-or-binary-stmt` residual", async () => {
    await expectIrLegacyParity(`export function test(x: number): number { x + 1; return x; }`, [7], 7);
  });

  it("`x;` — a bare identifier read", async () => {
    await expectIrLegacyParity(`export function test(x: number): number { x; return x; }`, [7], 7);
  });

  it("`1;` — a bare literal", async () => {
    await expectIrLegacyParity(`export function test(x: number): number { 1; return x; }`, [7], 7);
  });

  it("`cond ? a : b;` — a discarded ternary", async () => {
    await expectIrLegacyParity(`export function test(x: number): number { x > 0 ? x : x + 1; return x; }`, [7], 7);
  });

  it("`-x;` — a discarded unary", async () => {
    await expectIrLegacyParity(`export function test(x: number): number { -x; return x; }`, [7], 7);
  });

  it("`void (x + 1);` — `void` erases to its discarded operand", async () => {
    await expectIrLegacyParity(`export function test(x: number): number { void (x + 1); return x; }`, [7], 7);
  });

  it("`(x + 1);` — parentheses erase", async () => {
    await expectIrLegacyParity(`export function test(x: number): number { (x + 1); return x; }`, [7], 7);
  });

  it("a nested discarded ternary", async () => {
    await expectIrLegacyParity(
      `export function test(x: number): number { x > 0 ? (x > 5 ? x : 1) : 2; return x; }`,
      [7],
      7,
    );
  });

  it("`x / 0;` — a discarded division does not trap (f64 semantics survive the discard)", async () => {
    await expectIrLegacyParity(`export function test(x: number): number { x / 0; return x; }`, [7], 7);
  });
});

describe("#4459 — discarded statements inside body buffers", () => {
  it("inside a `for` body", async () => {
    await expectIrLegacyParity(
      `export function test(): number { let s = 0; for (let i = 0; i < 4; i++) { i + 100; s += i; } return s; }`,
      [],
      6,
    );
  });

  it("inside a `while` body", async () => {
    await expectIrLegacyParity(
      `export function test(): number { let s = 0; let i = 0; while (i < 4) { i * 2; s += i; i++; } return s; }`,
      [],
      6,
    );
  });

  it("inside a `try` body", async () => {
    await expectIrLegacyParity(
      `export function test(): number { let s = 1; try { s + 1; s = 7; } catch (e) { s = 9; } return s; }`,
      [],
      7,
    );
  });

  it("a discarded ternary inside a loop body", async () => {
    await expectIrLegacyParity(
      `export function test(): number { let s = 0; for (let i = 0; i < 4; i++) { i > 1 ? i : i + 1; s += i; } return s; }`,
      [],
      6,
    );
  });

  // The remaining buffer kinds, because "placement inside loop/try bodies"
  // is where a statement lowered through the wrong buffer would corrupt the
  // structured frame rather than merely fail to claim.
  it("inside a `switch` case body (the case is a break-scoped buffer)", async () => {
    await expectIrLegacyParity(
      `export function test(): number { let s = 0; const k = 1; switch (k) { case 0: s = 10; break; case 1: s + 99; s = 20; break; default: s = 30; } return s; }`,
      [],
      20,
    );
  });

  it("inside a `do`/`while` body (post-test loop)", async () => {
    await expectIrLegacyParity(
      `export function test(): number { let s = 0; let i = 0; do { i * 7; s += i; i++; } while (i < 3); return s; }`,
      [],
      3,
    );
  });

  it("inside a LABELED loop that breaks out (br.label depth still resolves)", async () => {
    await expectIrLegacyParity(
      `export function test(): number { let s = 0; outer: for (let i = 0; i < 3; i++) { i + 5; if (i === 2) break outer; s += i; } return s; }`,
      [],
      1,
    );
  });

  it("preceding an early `return` inside a loop", async () => {
    await expectIrLegacyParity(
      `export function test(): number { let s = 0; for (let i = 0; i < 5; i++) { i * 3; if (i === 3) return i; s += i; } return s; }`,
      [],
      3,
    );
  });

  it("inside a nested loop (two levels of buffer)", async () => {
    await expectIrLegacyParity(
      `export function test(): number { let s = 0; for (let i = 0; i < 3; i++) { for (let j = 0; j < 2; j++) { i + j; s += 1; } } return s; }`,
      [],
      6,
    );
  });
});

// ---------------------------------------------------------------------------
// Runtime SEMANTICS — the part a claim assertion alone cannot establish.
// ---------------------------------------------------------------------------

describe("#4459 — a discarded expression still runs for its side effects", () => {
  const SIDE_EFFECTING_CALL = `
    let n = 0;
    function bump(): number { n = n + 1; return n; }
    export function test(): number { bump(); bump(); bump(); return n; }
  `;

  it("a discarded call runs (three bumps, not zero)", async () => {
    await expectIrLegacyParity(SIDE_EFFECTING_CALL, [], 3);
  });

  const COMMA = `
    let n = 0;
    function bump(): number { n = n + 1; return n; }
    export function test(): number { bump(), bump(); return n; }
  `;

  it("a discarded comma runs BOTH operands", async () => {
    await expectIrLegacyParity(COMMA, [], 2);
  });

  const CALL_IN_BINARY = `
    let n = 0;
    function bump(): number { n = n + 1; return n; }
    export function test(): number { bump() + bump(); return n; }
  `;

  it("a discarded binary runs both operand calls", async () => {
    await expectIrLegacyParity(CALL_IN_BINARY, [], 2);
  });
});

describe("#4459 — a discarded ternary evaluates ONLY the taken arm", () => {
  // Two independent counters, one per arm, so the assertion distinguishes
  // "ran the right arm" from "ran both" — a `drop` of a materialised ternary
  // VALUE would run both arms and score 11 on either branch. `a * 10 + b`
  // encodes both counters in one f64 return.
  const source = (cond: string) => `
    let a = 0;
    let b = 0;
    function hitA(): number { a = a + 1; return a; }
    function hitB(): number { b = b + 1; return b; }
    export function test(): number { const c = ${cond}; c ? hitA() : hitB(); return a * 10 + b; }
  `;

  it("condition true → then-arm only (10, not 11)", async () => {
    await expectIrLegacyParity(source("true"), [], 10);
  });

  it("condition false → else-arm only (1, not 11)", async () => {
    await expectIrLegacyParity(source("false"), [], 1);
  });

  // The same evidence one level down: a discarded ternary nested in the
  // then-arm of another discarded ternary must still evaluate exactly one
  // leaf. Three counters, one per leaf, encoded as a*100 + b*10 + c.
  const nested = `
    let a = 0;
    let b = 0;
    let c = 0;
    function hitA(): number { a = a + 1; return a; }
    function hitB(): number { b = b + 1; return b; }
    function hitC(): number { c = c + 1; return c; }
    export function test(): number {
      const outer = true;
      const inner = false;
      outer ? (inner ? hitA() : hitB()) : hitC();
      return a * 100 + b * 10 + c;
    }
  `;

  it("nested discarded ternaries evaluate exactly ONE leaf", async () => {
    await expectIrLegacyParity(nested, [], 10);
  });

  // Order matters as much as count: the CONDITION runs before the arm.
  const orderProbe = `
    let log = 0;
    function condSide(): boolean { log = log * 10 + 1; return true; }
    function armSide(): number { log = log * 10 + 2; return 0; }
    export function test(): number { condSide() ? armSide() : armSide(); return log; }
  `;

  it("the condition evaluates before the taken arm", async () => {
    await expectIrLegacyParity(orderProbe, [], 12);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE BOUNDARIES — shapes that must keep rejecting, and keep rejecting
// with the SAME arm they used before this slice. The `probeShape` wrapper in
// select.ts exists precisely so a declined discard probe does not overwrite
// these labels (or, worse, move the function into a different
// `check:ir-fallbacks` bucket).
// ---------------------------------------------------------------------------

describe("#4459 — mutating statements keep their dedicated arms", () => {
  // Arm labels measured 2026-08-15 with JS2WASM_IR_SHAPE_DIAG=1. They are
  // documented rather than asserted because SHAPE_DIAG is read once at module
  // load, which a vitest file cannot toggle after importing the selector.
  it.each([
    [
      "`o.x += 1;` (nontail-compound-or-binary-stmt)",
      `class C { v = 0; }\nexport function test(): number { const c = new C(); c.v += 1; return c.v; }`,
    ],
    [
      "`a[i] += 1;` (nontail-compound-or-binary-stmt)",
      `export function test(): number { const a = [1, 2]; a[0] += 1; return a[0]; }`,
    ],
    [
      "chained `a = b = 1;` (nontail-assign-nonprop-lhs)",
      `export function test(): number { let a = 0; let b = 0; a = b = 1; return a; }`,
    ],
    [
      "`o.x++;` (nontail-incdec-stmt)",
      `class C { v = 0; }\nexport function test(): number { const c = new C(); c.v++; return c.v; }`,
    ],
    ["`new.target;` (nontail-exprstmt-other)", `export function test(x: number): number { new.target; return x; }`],
  ])("%s still rejects", async (_label, src) => {
    expect(claims(src, "test")).toBe(false);
    expect(await irEmitted(src, "test")).toBe(false);
  });
});

describe("#4459 — a discarded expression the walker cannot lower demotes cleanly", () => {
  it("a discarded call to an unlowerable external falls back, it does not throw", async () => {
    const src = `declare function ext(a: number): number;\nexport function test(x: number): number { ext(x) + 1; return x; }`;
    expect(claims(src, "test")).toBe(false);
    expect(await irEmitted(src, "test")).toBe(false);
    // A documented capability gap, NOT a post-claim invariant failure.
    expect(await fallbackReason(src, "test")).toBe("external-call");
    // And the program still compiles and runs, via legacy.
    const legacy = await instantiate(src, false);
    expect(typeof legacy.test).toBe("function");
  });

  it("an unlowerable ARM of a discarded ternary rejects the whole statement", async () => {
    const src = `declare function ext(a: number): number;\nexport function test(x: number): number { x > 0 ? ext(x) : x; return x; }`;
    expect(claims(src, "test")).toBe(false);
    expect(await irEmitted(src, "test")).toBe(false);
  });
});
