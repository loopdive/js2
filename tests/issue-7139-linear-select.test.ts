// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterAll, expect, it, vi } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { generateLinearModule } from "../src/codegen-linear/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import {
  consumeFrozenIrBodyBatchWithFactories,
  type FrozenIrBackendPlanFactories,
} from "../src/ir/backend/frozen-body-consumer.js";
import { prepareLinearIrBodyBatch } from "../src/ir/frozen-body-batch.js";
import { prepareLinearAllocationFacts } from "../src/ir/analysis/linear-memory-plan.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { emitBinary } from "../src/emit/binary.js";
import { mintDefinedFunc, commitDefinedFuncOrdinal, appendDefinedFunc } from "../src/wasm/physical/function-handles.js";
import type { Instr, ValType } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const observed = vi.hoisted(() => ({
  factories: undefined as FrozenIrBackendPlanFactories<Instr[], ValType> | undefined,
  calls: 0,
  restore: undefined as (() => void) | undefined,
}));
vi.mock("../src/ir/backend/frozen-body-consumer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/backend/frozen-body-consumer.js")>();
  const original = actual.consumeFrozenIrBodyBatchWithFactories;
  const spy = vi.spyOn(actual, "consumeFrozenIrBodyBatchWithFactories").mockImplementation(function <S, V>(
    this: unknown,
    ...args: Parameters<typeof original<S, V>>
  ) {
    if (args[0].backend === "linear") {
      observed.factories = args[0].factories as unknown as FrozenIrBackendPlanFactories<Instr[], ValType>;
      observed.calls++;
    }
    return Reflect.apply(original<S, V>, this, args);
  });
  observed.restore = () => spy.mockRestore();
  return { ...actual, consumeFrozenIrBodyBatchWithFactories: spy };
});
afterAll(() => {
  observed.restore?.();
  vi.unstubAllEnvs();
});

it("uses the actual production linear converter to select genuine string handles without reference scratch", async () => {
  vi.stubEnv("JS2WASM_LINEAR_IR", "1");
  const original = generateLinearModule(
    analyzeSource(`export function warm(n:number):number{return n+1;}
    export function measure(s:string):number{return s.length;}
    export function left():string{return "alpha";}
    export function right():string{return "beta";}`),
  );
  const report = getLastLinearIrReport()!;
  const warm = report.irModule.functions.find((fn) => fn.name === "warm")!;
  expect(warm).toBeDefined();
  expect(report.ownerEvidence).toContainEqual({ outcome: "compiled", ownerUnitId: warm.unitId, legacyName: "warm" });
  expect(observed.calls).toBeGreaterThan(0);
  const factories = observed.factories!;
  expect(factories.moduleSession).toBe(original);
  const originalBytes = new Uint8Array(emitBinary(original));
  const first = (await WebAssembly.instantiate(originalBytes, {})).instance.exports as Record<string, Function>;
  const p = first.left!(),
    q = first.right!();
  expect(p).not.toBe(q);
  expect(first.warm!(41)).toBe(42);
  expect(first.measure!(p)).toBe(5);
  expect(first.measure!(q)).toBe(4);
  const identities = createTestIrFunctionIdentityFactory("7139-linear-select"),
    registry = new AllocSiteRegistry();
  const logicalString = { kind: "string" } as const;
  const b = new IrFunctionBuilder(identities.next("choose"), [logicalString], true, registry);
  const cond = b.addParam("condition", { kind: "val", val: { kind: "i32" } }),
    a = b.addParam("a", logicalString),
    other = b.addParam("b", logicalString);
  b.openBlock();
  const selected = b.emitSelect(cond, a, other, logicalString);
  b.terminate({ kind: "return", values: [selected] });
  const fn = b.finish(),
    module = { functions: [fn] };
  const batch = prepareLinearIrBodyBatch({
    module,
    allocationFacts: prepareLinearAllocationFacts(module, registry),
    owners: [
      {
        ownerUnitId: fn.unitId,
        sourceId: identities.sourceId,
        sourceKey: "@test/7139-linear-select",
        legacyName: fn.name,
        terminalKind: "synthetic-support",
        observedKind: "function",
        outcome: "built",
      },
    ],
    producer: {
      backend: "linear",
      policy: "arena-v1",
      source: { sourceId: identities.sourceId, sourceKey: "@test/7139-linear-select", fileName: "select.ts" },
      version: "l0-p1-v1",
      representation: "linear-ir",
      boundaries: [],
    },
  });
  const [output] = consumeFrozenIrBodyBatchWithFactories({ batch, backend: "linear", factories });
  const body = output!.lowered;
  expect(body.params.flatMap((param) => param.slots)).toEqual([{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }]);
  expect(body.results).toEqual([[{ kind: "i32" }]]);
  expect(body.locals).toEqual([]);
  expect(body.body).toEqual([
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "local.get", index: 0 },
    { op: "select" },
    { op: "return" },
  ]);
  // Only the test copy receives the additional consumed body, after the real artifact executed.
  const copy = {
    ...original,
    types: [...original.types],
    functions: [...original.functions],
    exports: [...original.exports],
    funcOrdinalToPosition: [...original.funcOrdinalToPosition],
  };
  const typeIdx = copy.types.length;
  copy.types.push({
    kind: "func",
    name: "choose",
    params: body.params.flatMap((param) => [...param.slots]),
    results: body.results.flatMap((result) => [...result]),
  });
  const handle = mintDefinedFunc(copy);
  commitDefinedFuncOrdinal(copy, handle);
  appendDefinedFunc(copy, { name: "choose", typeIdx, locals: [], body: body.body, exported: true });
  copy.exports.push({ name: "choose", desc: { kind: "func", index: handle } });
  const result = (await WebAssembly.instantiate(new Uint8Array(emitBinary(copy)), {})).instance.exports as Record<
    string,
    Function
  >;
  const left = result.left!(),
    right = result.right!();
  expect(result.choose!(1, left, right)).toBe(left);
  expect(result.choose!(0, left, right)).toBe(right);
  expect(result.measure!(result.choose!(1, left, right))).toBe(5);
  expect(result.measure!(result.choose!(0, left, right))).toBe(4);
  expect(emitBinary(original)).toEqual(originalBytes);
});
