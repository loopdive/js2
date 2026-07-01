// #2878 — Standalone invalid-Wasm residual after #2868: the `externref → eqref`
// coercion produced a bare `any.convert_extern`, leaving the value as ANYREF
// (the SUPERtype of eqref). A consuming `struct.set` / `local.set` into an eqref
// slot then failed Wasm validation ("expected eqref, found anyref"), the
// standalone `__set_member_toString` / `__call_toString` / `__call_valueOf`
// invalid-Wasm bucket.
//
// Two coupled fixes, both narrowing anyref → eqref with a nullable ref.cast to
// the abstract `eq` heap type (-19 signed-LEB):
//
//   1. `coercionPlan` (coercion-plan.ts) — the #1917 single coercion table read
//      by `coercionInstrs` and the stack-balance coercers. This is what the
//      member-write dispatcher (`fillMemberSetDispatch`) uses to coerce the
//      externref value into an eqref struct field.
//   2. `emitToPrimitiveMethodExports` `closure-extern` arm (index.ts) — the
//      ToPrimitive dispatcher recovers an externref-stored method closure via
//      `struct.get → any.convert_extern → local.set eqref`; the missing narrow
//      broke `__call_toString`/`__call_valueOf`.
//
// The unit assertions below pin the coercion-table fix deterministically (the
// authoritative site); the compile assertions exercise the full standalone
// pipeline and guard against a gross regression of the invalid-Wasm class.
import { describe, it, expect } from "vitest";
// Import the compiler barrel FIRST so the codegen module graph initialises in
// order before we reach into the coercion helpers (importing the coercion
// modules standalone trips a module-init cycle).
import { compile } from "../src/index.js";
import { coercionPlan } from "../src/codegen/coercion-plan.js";
import { coercionInstrs } from "../src/codegen/type-coercion.js";

// The abstract `eq` heap type, encoded as -19 in signed LEB128 (matches the
// EQ_HEAP_TYPE constant used across codegen for anyref→eqref narrowing).
const EQ_HEAP_TYPE = -19;

describe("#2878 — externref → eqref coercion narrows to `eq`", () => {
  it("coercionPlan(externref → eqref) narrows anyref to eqref (not a bare any.convert_extern)", () => {
    const plan = coercionPlan(
      { kind: "externref" },
      { kind: "eqref" },
      {
        boxNumberIdx: null,
        unboxNumberIdx: null,
      },
    );
    expect(plan).not.toBeNull();
    expect(plan!.lossy).toBeFalsy();
    expect(plan!.instrs).toEqual([{ op: "any.convert_extern" }, { op: "ref.cast_null", typeIdx: EQ_HEAP_TYPE }]);
  });

  it("coercionPlan(externref → anyref) stays a bare any.convert_extern (no over-narrowing)", () => {
    const plan = coercionPlan(
      { kind: "externref" },
      { kind: "anyref" },
      {
        boxNumberIdx: null,
        unboxNumberIdx: null,
      },
    );
    expect(plan).not.toBeNull();
    expect(plan!.instrs).toEqual([{ op: "any.convert_extern" }]);
  });

  it("coercionInstrs(externref → eqref) delegates the narrowing", () => {
    // coercionInstrs delegates externref→eqref to coercionPlan; the emitted
    // sequence must end with the `eq` ref.cast so an eqref-slot store validates.
    const instrs = coercionInstrs({ funcMap: new Map() } as never, { kind: "externref" }, { kind: "eqref" });
    expect(instrs).toEqual([{ op: "any.convert_extern" }, { op: "ref.cast_null", typeIdx: EQ_HEAP_TYPE }]);
  });

  it("coercionInstrs(externref → anyref) is unchanged", () => {
    const instrs = coercionInstrs({ funcMap: new Map() } as never, { kind: "externref" }, { kind: "anyref" });
    expect(instrs).toEqual([{ op: "any.convert_extern" }]);
  });
});

describe("#2878 — standalone ToPrimitive / member shapes compile to valid Wasm", () => {
  // Broad guard: these object/method/member-write shapes go through the
  // standalone ToPrimitive + dynamic-member codegen that emits the affected
  // helpers. They must produce a module the engine accepts (WebAssembly.compile
  // validates without needing an import object in standalone mode).
  const cases: Record<string, string> = {
    toprimitive_method_object: `
      const o: any = { valueOf: function () { return 42; }, toString: function () { return "x"; } };
      export function test(): string { return "" + (o as any); }
    `,
    dynamic_member_write: `
      const a: any = { valueOf: function () { return 1; } };
      function w(x: any, v: any): void { x.valueOf = v; }
      export function test(): number { w(a, function () { return 9; }); return 1; }
    `,
    string_coerce_object: `
      const o: any = { toString: function () { return "hi"; } };
      export function test(): string { return String(o as any); }
    `,
  };

  for (const [name, src] of Object.entries(cases)) {
    it(`compiles ${name} to valid standalone Wasm`, async () => {
      const r = await compile(src, {
        fileName: "test.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      });
      expect(r.success).toBe(true);
      await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
    });
  }
});
