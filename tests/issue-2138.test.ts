// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2138 — IR-first compile-once inversion (flag-gated investigation).
//
// Behind `JS2WASM_IR_FIRST=1` (+ the default-on `experimentalIR`), the IR
// plan (`planIrOverlay`) runs BEFORE `compileDeclarations`, and legacy body
// emission is skipped for claimed top-level functions that pass
// `computeIrFirstSkipSet`'s gates — each claimed function is compiled ONCE
// (by the IR) instead of twice (legacy body thrown away, IR body kept).
//
// Contract under test:
//   1. Flag OFF (`JS2WASM_IR_FIRST=0` escape hatch — the default is ON as of
//      #3143): behavior unchanged — no skip telemetry, and the pipeline
//      order is literally the pre-#2138 one (plan after body pass).
//   2. Flag ON, fully-claimed closure: legacy bodies skipped, IR bodies
//      ship, results correct.
//   3. Flag ON, partially-claimed program: un-claimed functions keep their
//      legacy bodies; function-slot LAYOUT (names/order) is identical
//      flag-on vs flag-off (the skip is a body-emission change, never an
//      index-layout change).
//   4. Flag ON, post-claim IR failure on a skipped function: HARD compile
//      error (`[IR-FIRST skipped-slot, #2138]`) instead of the silent
//      legacy demote — the placeholder `unreachable` body must never ship.
//      This loud-failure mode is the investigation's purpose: it surfaces
//      selector↔builder capability drift (#2135).
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileFlag(on: boolean, src: string): Promise<CompileResult> {
  // (#3143) IR-first is default-ON: only the explicit "0"/"false" escape
  // hatch disables it, so the off-arm stubs "0" (unset/"" now mean ON).
  vi.stubEnv("JS2WASM_IR_FIRST", on ? "1" : "0");
  try {
    return await compile(src, { fileName: "issue-2138.ts" });
  } finally {
    vi.unstubAllEnvs();
  }
}

async function instantiate(r: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setInstance?.(instance);
  return instance.exports as Record<string, Function>;
}

/** Ordered list of function names from the WAT text — the funcIdx layout. */
function funcLayout(r: CompileResult): string[] {
  const names: string[] = [];
  for (const line of r.wat.split("\n")) {
    const m = /^\s*\(func \$([^\s()]+)/.exec(line);
    if (m) names.push(m[1]!);
  }
  return names;
}

const FIB_SRC = `
function fib(n: number): number {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
export function run(n: number): number {
  return fib(n);
}
`;

// `stringy` uses for-in — a direct-only statement kind the selector rejects
// (see plan/log/ir-adoption.md), so this program has a partially-claimed
// top-level set: {add, run} claimed, {stringy} legacy.
const PARTIAL_SRC = `
function add(a: number, b: number): number {
  return a + b;
}
export function stringy(s: string): string {
  const o: any = { a: 1 };
  let out = "";
  for (const k in o) { out += k; }
  return out + s;
}
export function run(): number {
  return add(2, 3);
}
`;

// KNOWN selector↔builder drift (the #2135 class): the selector claims `%`
// but `from-ast.ts` throws "operator '%' not in slice 11". Flag-off this
// demotes to a warning and the legacy body ships; flag-on the function's
// legacy body was skipped, so the failure MUST be a hard error. If #2135
// (or a slice adding `%` to the IR) retires this drift, the precondition
// check below keeps the test honest instead of failing spuriously.
const MODULO_TRAP_SRC = `
export function m(a: number, b: number): number {
  return a % b;
}
`;

describe("#2138 IR-first compile-once inversion (JS2WASM_IR_FIRST)", () => {
  it("flag OFF (JS2WASM_IR_FIRST=0 escape hatch, #3143): no skip telemetry, program runs", async () => {
    const r = await compileFlag(false, FIB_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.irFirstSkipped).toBeUndefined();
    const exp = await instantiate(r);
    expect((exp.run as (n: number) => number)(10)).toBe(55);
  });

  it("flag ON, fully-claimed closure: legacy bodies skipped, IR result correct", async () => {
    const r = await compileFlag(true, FIB_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.irFirstSkipped).toBeDefined();
    expect(r.irFirstSkipped).toContain("fib");
    expect(r.irFirstSkipped).toContain("run");
    const exp = await instantiate(r);
    expect((exp.run as (n: number) => number)(10)).toBe(55);
  });

  it("flag ON, partial closure: un-claimed function keeps its legacy body and behavior", async () => {
    const r = await compileFlag(true, PARTIAL_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.irFirstSkipped).toContain("add");
    expect(r.irFirstSkipped).toContain("run");
    expect(r.irFirstSkipped).not.toContain("stringy");
    const exp = await instantiate(r);
    expect((exp.run as () => number)()).toBe(5);
    expect((exp.stringy as (s: string) => string)("x")).toBe("ax");
  });

  it("funcIdx layout invariant: function slot names/order identical flag-on vs flag-off", async () => {
    // The skip must be a body-emission change only — pre-allocated
    // funcIdx/typeIdx slots are never removed or reordered. (Programs whose
    // claimed functions contain nested closures can legitimately differ in
    // the auxiliary-function TAIL under the flag — legacy closure lifting
    // vs IR closure lifting — so this invariant is asserted on
    // closure-free programs; see the issue's Implementation Plan.)
    for (const src of [FIB_SRC, PARTIAL_SRC]) {
      const off = await compileFlag(false, src);
      const on = await compileFlag(true, src);
      expect(off.success).toBe(true);
      expect(on.success).toBe(true);
      expect(funcLayout(on)).toEqual(funcLayout(off));
    }
  });

  it("flag ON, post-claim IR failure on a skipped function is a HARD error (fail loud, never trap silently)", async () => {
    const off = await compileFlag(false, MODULO_TRAP_SRC);
    // Precondition: the drift still exists (selector claims `m`, IR build
    // fails post-claim, legacy demote keeps the compile green).
    const driftLives =
      off.success === true && (off.irPostClaimErrors ?? []).some((e) => e.func === "m" && e.kind !== "resolve");
    const on = await compileFlag(true, MODULO_TRAP_SRC);
    if (driftLives) {
      expect(on.success).toBe(false);
      const hard = on.errors.filter((e) => e.severity === "error").map((e) => e.message);
      expect(hard.some((m) => m.includes("[IR-FIRST skipped-slot, #2138]") || m.includes("IR-first (#2138)"))).toBe(
        true,
      );
    } else {
      // Drift retired (e.g. #2135 landed `%` in the IR, or the selector now
      // rejects it): flag-on must then compile as cleanly as flag-off.
      expect(on.success).toBe(off.success);
    }
  });

  it("flag OFF twice: deterministic byte-identical output (diff-harness sanity)", async () => {
    const a = await compileFlag(false, PARTIAL_SRC);
    const b = await compileFlag(false, PARTIAL_SRC);
    expect(a.success).toBe(true);
    expect(Buffer.from(a.binary).equals(Buffer.from(b.binary))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (#3143) Skip-set integration — the allowlist must not disturb the proven
// pure-numeric skip set (guards against over-exclusion collateral).
// ---------------------------------------------------------------------------

describe("#2138 IR-first skip-set integration", () => {
  it("integration: gate 4 does not disturb today's skip set (no over-exclusion collateral)", async () => {
    // FIB_SRC's claimed functions read no host nodes — the flag-on skip set
    // must be unchanged by the gate (guards against a scan that is stricter
    // than the selector's accept surface, which would depress the #2949
    // skip-rate measurement).
    const r = await compileFlag(true, FIB_SRC);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.irFirstSkipped).toContain("fib");
    expect(r.irFirstSkipped).toContain("run");
  });
});
