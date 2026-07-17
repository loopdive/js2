// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3142 Slice 1 — module-level (top-level statement) claim assessment.
//
// The selector now reports an `IrModuleInitAssessment` on `IrSelection`
// (`moduleInit`) when `trackFallbacks` is on: the top-level statement
// population is shape-checked with the SAME per-kind rules as a claimed
// function body (constructor-body precedent — void unit, no tail
// requirement, early-return barrier armed), then gated through the same
// external-call / call-graph-closure logic as Step 2.
//
// Slice 1 was selector-only (mirrors #1370 Phase A). Slice 2 makes the
// assessment CLAIM-FEEDING: `compileIrPathFunctions` lowers a claimable
// non-empty unit through from-ast/lower in `moduleInitUnit` mode — top-level
// `let`/`const` bindings write the legacy-allocated `__mod_<name>` globals
// via symbolic refs — and patches the legacy `__module_init` slot in place
// (typeIdx parity guarded). Any build/verify failure demotes the whole unit
// to the legacy body, which is always still emitted. The Slice-2 suites
// below assert genuine emission (`irCompiledFuncs` carries `<module-init>`),
// correct runtime values through the patched init, and the demote guards
// (string/ref bindings, `var`, module-level closures).

import { describe, expect, it } from "vitest";
import ts from "typescript";
import { planIrCompilation } from "../src/ir/select.js";
import { compile } from "../src/index.js";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

function plan(source: string, trackFallbacks = true) {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.ES2022, /* setParentNodes */ true);
  return planIrCompilation(sf, { experimentalIR: true, trackFallbacks });
}

describe("#3142 Slice 1 — module-init claim assessment", () => {
  it("declarations-only module: vacuously claimable with stmtCount 0", () => {
    const sel = plan(`
      function add(a: number, b: number): number { return a + b; }
      function mul(a: number, b: number): number { return a * b; }
    `);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.stmtCount).toBe(0);
    expect(sel.moduleInit!.reason).toBeNull();
  });

  it("claimable init: var decl + assignment + call to a claimed function", () => {
    const sel = plan(`
      function add(a: number, b: number): number { return a + b; }
      let total: number = 0;
      total = add(1, 2);
    `);
    expect(sel.funcs.has("add")).toBe(true);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.stmtCount).toBe(2);
    expect(sel.moduleInit!.reason).toBeNull();
  });

  it("body-shape rejection: a top-level statement kind the IR does not own", () => {
    // `switch` has no isPhase1BodyStatement arm — the unit must reject with
    // the same reason bucket a function body would.
    const sel = plan(`
      function add(a: number, b: number): number { return a + b; }
      switch (1) { default: break; }
    `);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.reason).toBe("body-shape-rejected");
  });

  it("top-level return rejects (early-return barrier armed)", () => {
    // A bare top-level `return` is not claimable; the barrier must reject it
    // rather than treating the void unit like a loop-body early exit.
    const sel = plan(`
      function f(a: number): number { return a; }
      return;
    `);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.reason).toBe("body-shape-rejected");
  });

  it("external-call rejection: top-level call to a non-local identifier", () => {
    const sel = plan(`
      function f(a: number): number { return a; }
      parseInt("42");
    `);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.reason).toBe("external-call");
  });

  it("call-graph-closure rejection: top-level call to an unclaimed local function", () => {
    // `g` has unannotated params and no TypeMap is provided, so it is not
    // individually claimable — the module-init unit calling it must reject
    // with call-graph-closure, exactly like a claimed function would.
    const sel = plan(`
      function g(a): number { return 1; }
      g(1);
    `);
    expect(sel.funcs.has("g")).toBe(false);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.reason).toBe("call-graph-closure");
  });

  it("populated WITHOUT trackFallbacks too (Slice 2 — claim-feeding on production selections)", () => {
    const sel = plan(
      `
      function add(a: number, b: number): number { return a + b; }
      let total: number = 0;
      total = add(1, 2);
    `,
      /* trackFallbacks */ false,
    );
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.stmtCount).toBe(2);
    expect(sel.moduleInit!.reason).toBeNull();
  });

  it("import/export/type declarations are not module-init work", () => {
    const sel = plan(`
      export function add(a: number, b: number): number { return a + b; }
      interface P { x: number }
      type Q = number;
      export default add;
    `);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.stmtCount).toBe(0);
    expect(sel.moduleInit!.reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — lowering + `__module_init` patch (genuine emission + runtime)
// ---------------------------------------------------------------------------

const MI = "<module-init>";

function irCompiled(r: Awaited<ReturnType<typeof compile>>): Set<string> {
  return new Set(r.irCompiledFuncs ?? []);
}

describe("#3142 Slice 2 — module-init lowers via IR and patches __module_init", () => {
  it("numeric module state: decl + assignment + claimed-callee call (genuine emission)", async () => {
    const src = `
      function add(a: number, b: number): number { return a + b; }
      let total: number = 0;
      total = add(1, 2);
      total = total + 4;
      export function readTotal(): number { return total; }
    `;
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    // THE acceptance criterion: the __module_init slot is ACTUALLY patched.
    expect(irCompiled(r).has(MI), "<module-init> should be IR-emitted").toBe(true);
    expect((r.irPostClaimErrors ?? []).filter((e) => e.func === MI)).toEqual([]);
    // The IR-lowered init wrote the SAME `__mod_total` global the legacy
    // reader function observes.
    const exports = await compileAndInstantiate(src);
    expect(Number((exports.readTotal as () => unknown)())).toBe(7);
  });

  it("module-init-only claim (no claimed functions): ++ / += through the module global", async () => {
    const src = `
      let counter: number = 0;
      counter++;
      counter += 2;
      export function readCounter(): number { return counter; }
    `;
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    expect(irCompiled(r).has(MI)).toBe(true);
    const exports = await compileAndInstantiate(src);
    expect(Number((exports.readCounter as () => unknown)())).toBe(3);
  });

  it("boolean (i32-backed) module binding initializes through the IR unit", async () => {
    const src = `
      let ready: boolean = false;
      ready = true;
      export function isReady(): boolean { return ready; }
    `;
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    expect(irCompiled(r).has(MI)).toBe(true);
    const exports = await compileAndInstantiate(src);
    expect(Boolean((exports.isReady as () => unknown)())).toBe(true);
  });
});

describe("#3142 Slice 2 — patched __module_init must FALL THROUGH (PR #3168 merge_group park)", () => {
  // Later passes APPEND epilogue instrs to the __module_init body — most
  // critically finalizeInModuleInitFlag (#2800), which wraps it with
  // `__in_module_init = 1 … = 0`. The IR void-return lowering emitted an
  // explicit trailing `return`, making the appended flag-clear unreachable:
  // the flag stayed 1 forever and every delete-aware read misrouted
  // (language/statements/for-in/order-simple-object.js flipped pass→fail in
  // the merge_group). The patch now strips the trailing return (and demotes
  // on any non-trailing return-class op). This test replicates the failing
  // shape: a CLAIMABLE module-init (numeric lets, like the test262 harness
  // preamble) + a function whose for-in order depends on delete-aware reads
  // gated on the flag being CLEARED after init.
  it("delete/re-add for-in order stays correct with an IR-patched module-init", async () => {
    const src = `
      let __c1: number = 0;
      __c1 = __c1 + 1;
      export function test(): string {
        var o = { p1: 'p1', p2: 'p2', p3: 'p3' };
        delete (o as any).p1;
        (o as any).p1 = 'p1';
        var keys: string[] = [];
        for (var k in o) { keys.push(k); }
        return keys.join(",");
      }
    `;
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true, skipSemanticDiagnostics: true });
    expect(r.success).toBe(true);
    // The unit must be claimed (this is what arms the hazard).
    expect(irCompiled(r).has(MI)).toBe(true);
    const exports = await compileAndInstantiate(src);
    expect(String((exports.test as () => unknown)())).toBe("p2,p3,p1");
  });
});

describe("#3142 Slice 2 — demote guards (unit falls back to the legacy body, output stays correct)", () => {
  it("string module binding is NOT in Slice 2 scope — demotes, runtime stays correct", async () => {
    const src = `
      let greeting: string = "hi";
      greeting = greeting + "!";
      export function readGreeting(): string { return greeting; }
    `;
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    expect(irCompiled(r).has(MI)).toBe(false);
    const exports = await compileAndInstantiate(src);
    expect(String((exports.readGreeting as () => unknown)())).toBe("hi!");
  });

  it("top-level var demotes (function-scoped hoisting not modeled), runtime stays correct", async () => {
    const src = `
      var v: number = 1;
      v = v + 1;
      export function readV(): number { return v; }
    `;
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    expect(irCompiled(r).has(MI)).toBe(false);
    const exports = await compileAndInstantiate(src);
    expect(Number((exports.readV as () => unknown)())).toBe(2);
  });

  it("module-level closure binding demotes (closureMap/global storage stays legacy-owned)", async () => {
    const src = `
      const double = (x: number): number => x * 2;
      let seed: number = 0;
      seed = double(4);
      export function readSeed(): number { return seed; }
    `;
    const r = await compile(src, { fileName: "test.ts", experimentalIR: true });
    expect(r.success).toBe(true);
    expect(irCompiled(r).has(MI)).toBe(false);
    const exports = await compileAndInstantiate(src);
    expect(Number((exports.readSeed as () => unknown)())).toBe(8);
  });
});
