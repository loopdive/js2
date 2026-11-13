// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6921 — IR middle-end pass correctness.
//
// D1: `inlineSmall` spliced a callee's `slot.read` / `slot.write` into the
//     caller without remapping slot indices — a helper's mutable `let` (or a
//     reassigned parameter) aliased the caller's slot 0 (silent wrong answer,
//     t10) or indexed a slot the caller never declared (whole-module compile
//     failure, t11).
// D2: `dyn.to_number` and loose `dyn.eq` were classified pure, so DCE dropped
//     an unused `+o` / `o == 1` together with its user `valueOf` call (and its
//     throw); with `JS2WASM_IR_GVN=1`, GVN merged `(+o) + (+o)` into a single
//     ToNumber (D2b).
//
// Every positive case compiles real source through the public `compile()`,
// asserts the unit took the IR path (`kind === "emitted"`, `irBodyEmitted`),
// and compares against node running the SAME source (transpiled here), not a
// hand-typed literal. The probe sources are unchanged from the issue's
// preserved evidence (`plan/log/6921-ir-pass-correctness/t*.ts.txt`).
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compile, type IrObservedOutcome } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";
import { effectsArePure, effectsOf } from "../src/ir/analysis/effects.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irDynamic, irVal } from "../src/ir/core/types.js";
import type { IrFunction } from "../src/ir/nodes.js";
import { deadCode } from "../src/ir/passes/dead-code.js";
import { inlineSmall } from "../src/ir/passes/inline-small.js";
import { irUnitFuncRef } from "../src/ir/core/callable-bindings.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

type Target = "gc" | "standalone";

const T10 = `function g(a: number): number {
  let x = a;
  x = x * 2;
  return x + 1;
}
export function main(): number {
  let s = 100;
  s = s + 5;
  const r = g(3);
  return s * 1000 + r;
}
`;

const T11 = `function g(a: number): number {
  a = a * 2;
  return a + 1;
}
export function main(): number {
  const r = g(3);
  return r * 10;
}
export function loop(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc = acc + g(i);
  }
  return acc;
}
`;

const T12 = `function g(a: number): number {
  a = a * 2;
  return a + 1;
}
export function loop(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc = acc + g(i);
  }
  return acc;
}
`;

const T9 = `export function getr(o: any): number {
  o.x;
  return 1;
}
export function tonum(o: any): number {
  +o;
  return 1;
}
export function eqq(o: any): number {
  o == 1;
  return 1;
}
export function twice(o: any): number {
  return (+o) + (+o);
}
`;

/** Slot-free single-block helper: must still be inlined (negative control). */
const SLOT_FREE = `function h(a: number): number {
  return a * 2 + 1;
}
export function main(): number {
  const r = h(3);
  return r * 10;
}
`;

/** Two inlined copies of a slot-bearing helper must not share state. */
const TWO_SITES = `function g(a: number): number {
  let x = a;
  x = x * 2;
  return x + 1;
}
export function main(): number {
  let s = 7;
  const p = g(3);
  s = s + p;
  const q = g(10);
  return s * 1000 + p * 100 + q;
}
`;

type Exports = Record<string, (...args: unknown[]) => unknown>;

/** Run the same TypeScript source in node: the reference result. */
function nodeExports(source: string): Exports {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Exports = {};
  new Function("exports", js)(exports);
  return exports;
}

interface Compiled {
  readonly exports: Exports;
  readonly units: readonly IrObservedOutcome[];
  readonly wat: string;
}

async function compileRun(source: string, target: Target, emitWat = false): Promise<Compiled> {
  const result = await compile(source, {
    fileName: "issue-6921.ts",
    trackIrOutcomes: true,
    ...(emitWat ? { emitWat: true } : {}),
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
  });
  if (!result.success) {
    throw new Error(`compile failed (${target}): ${result.errors.map((e) => e.message).join(" | ")}`);
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return { exports: instance.exports as unknown as Exports, units: result.irOutcomes ?? [], wat: result.wat };
}

function expectIrEmitted(units: readonly IrObservedOutcome[], ...names: string[]): void {
  for (const name of names) {
    const found = units.find((unit) => unit.displayName === name);
    expect(found, `no IR outcome recorded for ${name}`).toBeDefined();
    expect(found!.kind, `${name} outcome`).toBe("emitted");
    expect((found as { irBodyEmitted?: boolean }).irBodyEmitted, `${name} irBodyEmitted`).toBe(true);
  }
}

/** The body of `$<name>` in the emitted WAT. */
function watFunc(wat: string, name: string): string {
  const match = wat.match(new RegExp(`\\(func \\$${name}\\b[\\s\\S]*?\\n  \\)`));
  expect(match, `no $${name} in WAT`).not.toBeNull();
  return match![0];
}

/** A host object whose ToPrimitive is observable through a counter. */
function countingObject(): { readonly value: object; readonly count: () => number } {
  let calls = 0;
  return {
    value: {
      valueOf() {
        calls++;
        return 10;
      },
    },
    count: () => calls,
  };
}

function throwingObject(): object {
  return {
    valueOf() {
      throw new Error("boom");
    },
  };
}

/** Observable effect of calling `fn(obj)`: the result (or thrown message) plus the valueOf count. */
function observe(fn: (o: object) => unknown): { result: unknown; calls: number } {
  const probe = countingObject();
  return { result: fn(probe.value), calls: probe.count() };
}

function thrownMessage(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#6921 D1 — inlined callee slots are remapped into the caller", () => {
  for (const target of ["gc", "standalone"] as const) {
    it(`t10: helper with a mutable let does not clobber the caller's let (${target})`, async () => {
      const expected = nodeExports(T10).main!();
      const { exports, units, wat } = await compileRun(T10, target, true);
      expectIrEmitted(units, "g", "main");
      expect(exports.main!()).toBe(expected);
      // The fix remaps rather than refusing to inline: `main` keeps no call.
      expect(watFunc(wat, "main")).not.toMatch(/\bcall\b/);
    });

    it(`t11: helper reassigning its parameter compiles and runs (${target})`, async () => {
      const node = nodeExports(T11);
      const { exports, units } = await compileRun(T11, target);
      expectIrEmitted(units, "g", "main", "loop");
      expect(exports.main!()).toBe(node.main!());
      expect(exports.loop!(5)).toBe(node.loop!(5));
    });

    it(`two inlined copies of one slot-bearing helper get separate slots (${target})`, async () => {
      const expected = nodeExports(TWO_SITES).main!();
      const { exports, units, wat } = await compileRun(TWO_SITES, target, true);
      expectIrEmitted(units, "g", "main");
      expect(exports.main!()).toBe(expected);
      expect(watFunc(wat, "main")).not.toMatch(/\bcall\b/);
    });

    it(`negative control: a slot-free helper is still inlined (${target})`, async () => {
      const expected = nodeExports(SLOT_FREE).main!();
      const { exports, units, wat } = await compileRun(SLOT_FREE, target, true);
      expectIrEmitted(units, "h", "main");
      expect(exports.main!()).toBe(expected);
      expect(watFunc(wat, "main")).not.toMatch(/\bcall\b/);
    });

    it(`negative control: t12 loop caller (inliner does not enter it) (${target})`, async () => {
      const expected = nodeExports(T12).loop!(5);
      const { exports, units } = await compileRun(T12, target);
      expectIrEmitted(units, "g", "loop");
      expect(exports.loop!(5)).toBe(expected);
    });
  }
});

describe("#6921 D2 — ToNumber / loose == run user code (gc host objects)", () => {
  it("t9 tonum: unused +o still calls valueOf exactly once", async () => {
    const node = nodeExports(T9);
    const { exports, units } = await compileRun(T9, "gc");
    expectIrEmitted(units, "tonum");
    expect(observe((o) => exports.tonum!(o))).toEqual(observe((o) => node.tonum!(o)));
  });

  it("t9 eqq: unused o == 1 still calls valueOf exactly once", async () => {
    const node = nodeExports(T9);
    const { exports, units } = await compileRun(T9, "gc");
    expectIrEmitted(units, "eqq");
    expect(observe((o) => exports.eqq!(o))).toEqual(observe((o) => node.eqq!(o)));
  });

  it("t9 tonum: a throwing valueOf propagates", async () => {
    const node = nodeExports(T9);
    const { exports } = await compileRun(T9, "gc");
    const expected = thrownMessage(() => node.tonum!(throwingObject()));
    expect(expected).toBe("boom");
    expect(thrownMessage(() => exports.tonum!(throwingObject()))).toBe(expected);
  });

  it("t9 twice: (+o) + (+o) calls valueOf twice (GVN off)", async () => {
    const node = nodeExports(T9);
    const { exports, units } = await compileRun(T9, "gc");
    expectIrEmitted(units, "twice");
    expect(observe((o) => exports.twice!(o))).toEqual(observe((o) => node.twice!(o)));
  });

  it("t9 twice: GVN does not merge the two ToNumber calls (JS2WASM_IR_GVN=1)", async () => {
    vi.stubEnv("JS2WASM_IR_GVN", "1");
    const node = nodeExports(T9);
    const { exports, units } = await compileRun(T9, "gc");
    expectIrEmitted(units, "twice");
    expect(observe((o) => exports.twice!(o))).toEqual(observe((o) => node.twice!(o)));
  });

  it("GVN liveness control: the stubbed env reaches compile (poison changes a pure duplicate)", async () => {
    const source = `export function pure(x: number): number { return (x * 3) + (x * 3); }\n`;
    const expected = nodeExports(source).pure!(7);
    const off = await compileRun(source, "gc");
    expect(off.exports.pure!(7)).toBe(expected);
    vi.stubEnv("JS2WASM_IR_GVN", "poison");
    const poisoned = await compileRun(source, "gc");
    expect(poisoned.exports.pure!(7)).not.toBe(expected);
  });

  it("standalone: tonum / eqq / twice stay IR-emitted and keep their base results", async () => {
    // The host object's valueOf is not an observable on standalone (no host
    // ToPrimitive); this is the non-regression arm. Base 8452732f0b returned
    // 1 / NaN for tonum / twice on a host-object carrier
    // (plan/log/6921-ir-pass-correctness/base-*.txt).
    //
    // `eqq` is exercised with a number only. A JS host object or string
    // passed into a standalone `any` parameter traps `illegal cast` inside
    // loose `==` — on base too, whenever the result is used
    // (`return o == 1 ? 1 : 0`). Base's `eqq(obj) === 1` came only from DCE
    // deleting that `==`; it is a standalone boundary/lowering defect outside
    // the middle-end, reported as a #6921 follow-up.
    const { exports, units } = await compileRun(T9, "standalone");
    expectIrEmitted(units, "tonum", "eqq", "twice");
    const node = nodeExports(T9);
    expect(exports.tonum!(countingObject().value)).toBe(1);
    expect(exports.twice!(countingObject().value)).toBeNaN();
    expect(exports.eqq!(5)).toBe(node.eqq!(5));
    expect(exports.twice!(5)).toBe(node.twice!(5));
  });
});

describe("#6921 D2 — effect classification and deadCode (pass level)", () => {
  const identities = createTestIrFunctionIdentityFactory("issue-6921");
  const F64 = irVal({ kind: "f64" });
  type Emit = "to_number" | "loose_eq" | "strict_eq" | "truthy";

  /** `(o: dynamic) => { <unused dyn op on o>; return 1 }`. */
  function unusedDynOp(emit: Emit): IrFunction {
    const builder = new IrFunctionBuilder(identities.next(`unused_${emit}`), [F64], true);
    const o = builder.addParam("o", irDynamic());
    builder.openBlock();
    if (emit === "to_number") builder.emitDynToNumber(o);
    else if (emit === "truthy") builder.emitDynTruthy(o);
    else builder.emitDynEq(o, o, { loose: emit === "loose_eq", negate: false });
    const one = builder.emitConst({ kind: "f64", value: 1 }, F64);
    builder.terminate({ kind: "return", values: [one] });
    return builder.finish();
  }

  const instrCount = (fn: IrFunction) => fn.blocks.reduce((n, block) => n + block.instrs.length, 0);
  const firstInstr = (fn: IrFunction) => fn.blocks[0]!.instrs[0]!;

  it("effectsOf: strict dyn.eq and dyn.truthy pure; dyn.to_number and loose dyn.eq not", () => {
    expect(effectsArePure(effectsOf(firstInstr(unusedDynOp("strict_eq"))))).toBe(true);
    expect(effectsArePure(effectsOf(firstInstr(unusedDynOp("truthy"))))).toBe(true);
    expect(effectsArePure(effectsOf(firstInstr(unusedDynOp("to_number"))))).toBe(false);
    expect(effectsArePure(effectsOf(firstInstr(unusedDynOp("loose_eq"))))).toBe(false);
  });

  it("deadCode keeps an unused dyn.to_number and an unused loose dyn.eq", () => {
    for (const emit of ["to_number", "loose_eq"] as const) {
      const fn = unusedDynOp(emit);
      expect(instrCount(fn), emit).toBe(2);
      const after = deadCode(fn);
      expect(instrCount(after), emit).toBe(2);
      expect(
        after.blocks[0]!.instrs.map((i) => i.kind),
        emit,
      ).toContain(emit === "to_number" ? "dyn.to_number" : "dyn.eq");
    }
  });

  it("negative control: deadCode still removes an unused strict dyn.eq and dyn.truthy", () => {
    for (const emit of ["strict_eq", "truthy"] as const) {
      const fn = unusedDynOp(emit);
      expect(instrCount(fn), emit).toBe(2);
      expect(instrCount(deadCode(fn)), emit).toBe(1);
    }
  });
});

describe("#6921 D1 — composed #5748 guard: asyncRuntime attachment (pass level)", () => {
  const identities = createTestIrFunctionIdentityFactory("issue-6921-async-runtime");
  const F64 = irVal({ kind: "f64" });

  /** One-block regular `const/return` callee plus a caller that calls it once. */
  function pair(withAttachment: boolean) {
    const calleeBuilder = new IrFunctionBuilder(identities.next("leaf"), [F64], false);
    calleeBuilder.openBlock();
    const seven = calleeBuilder.emitConst({ kind: "f64", value: 7 }, F64);
    calleeBuilder.terminate({ kind: "return", values: [seven] });
    const built = calleeBuilder.finish();
    // Legacy pre-manifest placeholder, allowed for generic-pass fixtures
    // (src/ir/runtime/contracts/prepared.ts, PreparedIrAsyncRuntimeBase).
    const callee: IrFunction = withAttachment
      ? ({ ...built, asyncRuntime: { kind: "standalone-native-wasmgc", adapters: [], states: [] } } as IrFunction)
      : built;
    const callerBuilder = new IrFunctionBuilder(identities.next("root"), [F64], true);
    callerBuilder.openBlock();
    const result = callerBuilder.emitCall(irUnitFuncRef(callee), [], F64);
    if (result === null) throw new Error("call must return a value");
    callerBuilder.terminate({ kind: "return", values: [result] });
    return { callee, caller: callerBuilder.finish() };
  }

  const callCount = (fn: IrFunction) =>
    fn.blocks.reduce((n, block) => n + block.instrs.filter((i) => i.kind === "call").length, 0);

  it("inlines the ordinary callee but keeps the call to an asyncRuntime-attached one", () => {
    const plain = pair(false);
    const plainOut = inlineSmall({ functions: [plain.callee, plain.caller] });
    expect(callCount(plain.caller)).toBe(1);
    expect(callCount(plainOut.functions.find((f) => f.unitId === plain.caller.unitId)!)).toBe(0);

    const attached = pair(true);
    const attachedOut = inlineSmall({ functions: [attached.callee, attached.caller] });
    expect(callCount(attachedOut.functions.find((f) => f.unitId === attached.caller.unitId)!)).toBe(1);
  });
});
