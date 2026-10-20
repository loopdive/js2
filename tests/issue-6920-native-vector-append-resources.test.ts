// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import * as growth from "../src/ir/program/native-vector-growth-source.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import {
  deriveNativeVectorResourcePlan,
  type NativeVectorResourceInput,
} from "../src/ir/program/native-vector-resources.js";
import {
  NUMERIC_APPEND_DECLARATION,
  NUMERIC_APPEND_RUNTIME_PROVIDERS,
} from "../src/ir/runtime/numeric-vector-callables.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import {
  planPreparedLinearMemory,
  reservePreparedLinearMemory,
  preparedLinearMemoryBindings,
  preparedLinearNumericAppendReservation,
  fillPreparedLinearMemory,
  requireCompletedPreparedLinearMemory,
} from "../src/backend/linear/program/memory.js";
import { collectLinearVectorFlow } from "../src/ir/program/linear-vector-flow.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { reserveNativeVectorTypes } from "../src/backend/wasmgc/resources/native-vectors.js";
import {
  reserveNativeNumericAppend,
  nativeNumericAppendFunction,
  fillNativeNumericAppend,
  requireCompletedNativeNumericAppend,
} from "../src/backend/wasmgc/resources/native-vectors.js";

const sources = [
  "export function run():number{const a=[2,5];return a.push(11)+a.length+a[2];}",
  "const a=[2,5];export function run():number{return a.push(11)+a.length+a[2];}",
  "export function run():number{const a:number[]=[];return a.push(11)+a.length;}",
  "function add(a:number[]):number{return a.push(11);}export function run():number{const a=[2,5];return add(a)+a.push(13)+a.length;}",
  "function inner(a:number[]):number{return a.push(7);}export function run():number{const a=[2,5];return a.push(inner(a))+a.length;}",
  "export function run():number{const a=[2,5];let i=0;while(i<4){a.push(i);i++;}return a.length;}",
];
const fixedSource = "export function run():number{const a=[2,5];return a.length+a[1];}";
function input(backend: "linear" | "wasmgc", text = sources[0]!, target: "standalone" | "wasi" = "standalone") {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  // Genuine raw IR for descriptive/resource tests only. This does not enable source or Program admission.
  const bypass = vi.spyOn(growth, "refuseUnbackedNativeNumericGrowth").mockImplementation(() => {});
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend, target },
    runtimePolicies: [{ backend, target }],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  bypass.mockRestore();
  if (source.kind !== "prepared") throw Error(source.detail);
  const typed = captureTypedIrProgramInput(source);
  const append = text !== fixedSource;
  const result: NativeVectorResourceInput = {
    anchor: source.inventory.sources.find((s) => s.kind === "entry")!.id,
    functions: typed.ir.functions,
    abiEntries: prepareIrProgramAbiEntries(typed, append ? [NUMERIC_APPEND_DECLARATION] : []),
    policy: { backend, target },
    providers: append ? NUMERIC_APPEND_RUNTIME_PROVIDERS : [],
    backend,
    target,
  };
  return { result, module: typed.ir, typed };
}
afterEach(() => vi.restoreAllMocks());
for (const backend of ["linear", "wasmgc"] as const)
  for (const target of ["standalone", "wasi"] as const)
    it(`joins actual raw append demand, canonical ABI/provider and original constructor origins for ${backend}/${target}`, () => {
      for (const text of sources) {
        const { result, module } = input(backend, text, target),
          before = JSON.stringify(result);
        const plan = deriveNativeVectorResourcePlan(result);
        expect(plan.numericAppendHelper).toBeDefined();
        expect(plan.helper).toBeUndefined();
        expect(plan.exceptionRequired).toBe(false);
        expect(plan.layouts).toEqual(backend === "linear" ? [] : ["f64"]);
        const flow = collectLinearVectorFlow(module);
        const calls = plan.demands.flatMap((owner) => owner.uses);
        expect(calls.length).toBeGreaterThan(0);
        expect([...flow.values()].flatMap((values) => [...values.values()]).length).toBeGreaterThan(0);
        expect(JSON.stringify(result)).toBe(before);
        expect(deriveNativeVectorResourcePlan(result)).toEqual(plan);
      }
    });
it("keeps fixed-only DATA free of numeric append resources", () => {
  for (const backend of ["linear", "wasmgc"] as const) {
    const { result } = input(backend, fixedSource);
    expect(deriveNativeVectorResourcePlan(result).numericAppendHelper).toBeUndefined();
  }
});
it("rejects contradictory ABI/provider joins without treating names or coordinates as authority", () => {
  const { result } = input("wasmgc");
  const abi = result.abiEntries.find(
    (entry) => entry.contract.kind === "callable" && entry.contract.ref.binding.kind === "intrinsic",
  )!;
  const other = result.abiEntries.filter((entry) => entry !== abi);
  const provider = NUMERIC_APPEND_RUNTIME_PROVIDERS[0]!;
  for (const bad of [
    { ...result, providers: [] },
    { ...result, providers: [provider, provider] },
    { ...result, providers: [{ ...provider, supportedBackends: ["wasmgc"] as const }] },
    { ...result, abiEntries: other },
    { ...result, abiEntries: [...result.abiEntries, abi] },
    { ...result, abiEntries: [...other, { ...abi, plan: { ...abi.plan, structuralReferenceKey: "foreign" } }] },
    { ...result, policy: { backend: "linear" as const, target: "standalone" as const } },
  ])
    expect(() => deriveNativeVectorResourcePlan(bad)).toThrow(/native vector resources/);
});
function reserved() {
  const plan = deriveNativeVectorResourcePlan(input("wasmgc").result),
    module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module),
    types = reserveNativeVectorTypes(tx, plan);
  let live = true;
  const active = () => {
    if (!live) throw Error("whole attempt revoked");
  };
  const resource = reserveNativeNumericAppend(tx, plan, types, active)!;
  expect(resource).toBeDefined();
  return {
    tx,
    types,
    plan,
    module,
    resource,
    active,
    revoke: () => {
      live = false;
    },
    restore: () => {
      live = true;
    },
  };
}
it("executes the exact separately issued f64 helper with real types, aliases and repeated growth", () => {
  const f = reserved(),
    row = f.types.layouts.find((r) => r.element === "f64")!;
  const ref = { kind: "ref_null", typeIdx: row.carrier.typeIndex } as const;
  const make = f.tx.reserveFunction("make", "make", { params: [], results: [ref] });
  const length = f.tx.reserveFunction("length", "length", { params: [ref], results: [{ kind: "i32" }] });
  const value = f.tx.reserveFunction("value", "value", { params: [ref, { kind: "i32" }], results: [{ kind: "f64" }] });
  f.tx.freezeReservations();
  const token = nativeNumericAppendFunction(f.tx, f.resource);
  fillNativeNumericAppend(f.tx, f.resource);
  expect(nativeNumericAppendFunction(f.tx, f.resource)).toBe(token);
  f.tx.fillFunction(make, {
    locals: [],
    body: [
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "array.new_default", typeIdx: row.array.typeIndex },
      { op: "struct.new", typeIdx: row.carrier.typeIndex },
    ],
  });
  f.tx.fillFunction(length, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: row.carrier.typeIndex, fieldIdx: 0 },
    ],
  });
  f.tx.fillFunction(value, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: row.carrier.typeIndex, fieldIdx: 1 },
      { op: "local.get", index: 1 },
      { op: "array.get", typeIdx: row.array.typeIndex },
    ],
  });
  for (const fn of [make, length, value, token]) f.tx.defineExport(`export:${fn.key}`, fn.object.name, fn);
  requireCompletedNativeNumericAppend(f.tx, f.resource);
  requireCompletedNativeNumericAppend(f.tx, f.resource);
  f.tx.seal();
  const bytes = Uint8Array.from(emitBinary(f.module));
  expect(WebAssembly.validate(bytes)).toBe(true);
  const wasm = new WebAssembly.Module(bytes);
  expect(WebAssembly.Module.imports(wasm)).toEqual([]);
  const e = new WebAssembly.Instance(wasm, {}).exports as unknown as {
    make(): unknown;
    length(v: unknown): number;
    value(v: unknown, i: number): number;
    __ir_vec_elem_set_f64(v: unknown, i: number, n: number): void;
  };
  const vector = e.make(),
    alias = vector;
  for (let i = 0; i < 44; i++) e.__ir_vec_elem_set_f64(i % 2 ? alias : vector, e.length(alias), i + 0.5);
  expect(e.length(vector)).toBe(44);
  for (let i = 0; i < 44; i++) expect(e.value(alias, i)).toBe(i + 0.5);
  expect(() => e.__ir_vec_elem_set_f64(null, 0, 3)).toThrow(WebAssembly.RuntimeError);
});
it("rejects prefreeze access and latches the known reservation's failure", () => {
  const f = reserved();
  expect(() => nativeNumericAppendFunction(f.tx, f.resource)).toThrow(/frozen/);
  f.tx.freezeReservations();
  expect(() => fillNativeNumericAppend(f.tx, f.resource)).toThrow(/failed/);
});
it("rejects foreign transactions and cloned identities", () => {
  const f = reserved(),
    other = new PhysicalModuleReservations(createEmptyModule());
  f.tx.freezeReservations();
  other.freezeReservations();
  expect(() => nativeNumericAppendFunction(f.tx, { ...f.resource })).toThrow(/unknown/);
  expect(() => nativeNumericAppendFunction(other, f.resource)).toThrow(/foreign/);
  expect(() => nativeNumericAppendFunction(f.tx, f.resource)).toThrow(/failed/);
});
it("rejects equal-shaped substituted plans and type packs from other transactions", () => {
  const f = reserved(),
    other = reserved();
  expect(() => reserveNativeNumericAppend(f.tx, structuredClone(f.plan), f.types, f.active)).toThrow(/substituted/);
  expect(() => reserveNativeNumericAppend(f.tx, f.plan, other.types, f.active)).toThrow(/foreign/);
});
it("rejects omitted or duplicate fills", () => {
  const absent = reserved();
  absent.tx.freezeReservations();
  expect(() => requireCompletedNativeNumericAppend(absent.tx, absent.resource)).toThrow(/incomplete/);
  expect(() => fillNativeNumericAppend(absent.tx, absent.resource)).toThrow(/failed/);
  const duplicate = reserved();
  duplicate.tx.freezeReservations();
  fillNativeNumericAppend(duplicate.tx, duplicate.resource);
  expect(() => fillNativeNumericAppend(duplicate.tx, duplicate.resource)).toThrow(/duplicate/);
  expect(() => requireCompletedNativeNumericAppend(duplicate.tx, duplicate.resource)).toThrow(/failed/);
});
it("revokes captured append resources on whole-attempt failure and observes physical mutation", () => {
  const f = reserved();
  f.tx.freezeReservations();
  nativeNumericAppendFunction(f.tx, f.resource);
  f.revoke();
  expect(() => nativeNumericAppendFunction(f.tx, f.resource)).toThrow(/revoked/);
  f.restore();
  expect(() => fillNativeNumericAppend(f.tx, f.resource)).toThrow(/failed/);
  const changed = reserved();
  changed.tx.freezeReservations();
  const token = nativeNumericAppendFunction(changed.tx, changed.resource);
  (token.object as { name: string }).name = "foreign";
  expect(() => nativeNumericAppendFunction(changed.tx, changed.resource)).toThrow();
  expect(() => fillNativeNumericAppend(changed.tx, changed.resource)).toThrow(/failed/);
});

for (const target of ["standalone", "wasi"] as const)
  it(`issues and executes the genuine numeric append token in the complete Linear ${target} resource pack`, () => {
    const source = input("linear", sources[0], target);
    const policy = source.result.policy;
    const program = requireProgram(
      prepareTypedIrProgram(source.typed, { ...typedOptions, policy, runtimePolicies: [policy] }),
    );
    const options = {
      backend: "linear" as const,
      target,
      moduleName: "append-pack",
      sourceMap: false,
      utf8Storage: false,
      sharedExceptionTag: false,
    };
    const outcome = planPreparedLinearMemory({ program, projection: program.runtime[0]!, options });
    expect(outcome.kind).toBe("supported");
    if (outcome.kind !== "supported") throw Error(outcome.detail);
    expect(outcome.plan.functions.map((fn) => fn.role)).toEqual([
      "malloc",
      "array-new",
      "initialize-element",
      "resolve-forwarding",
      "append-f64",
    ]);
    expect(outcome.plan.demand.occurrences.some((at) => at.kind === "call" && at.lookups.includes("append-f64"))).toBe(
      true,
    );
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    let live = true;
    const pack = reservePreparedLinearMemory(tx, outcome.plan, () => {
      if (!live) throw Error("attempt revoked");
    });
    tx.freezeReservations();
    const token = preparedLinearNumericAppendReservation(tx, pack)!;
    const bindings = preparedLinearMemoryBindings(tx, pack);
    expect(bindings.supportFunctions.includes(token)).toBe(true);
    fillPreparedLinearMemory(tx, pack);
    requireCompletedPreparedLinearMemory(tx, pack);
    expect(preparedLinearNumericAppendReservation(tx, pack)).toBe(token);
    for (const fn of bindings.supportFunctions) tx.defineExport(`export:${fn.key}`, fn.object.name, fn);
    tx.seal();
    const bytes = Uint8Array.from(emitBinary(module));
    expect(WebAssembly.validate(bytes)).toBe(true);
    const wasm = new WebAssembly.Module(bytes);
    expect(WebAssembly.Module.imports(wasm)).toEqual([]);
    const e = new WebAssembly.Instance(wasm, {}).exports as unknown as {
      __arr_new(n: number): number;
      __arr_resolve(p: number): number;
      __ir_vec_elem_set_f64(p: number, i: number, n: number): void;
      memory: WebAssembly.Memory;
    };
    const vector = e.__arr_new(2),
      alias = vector;
    for (let i = 0; i < 44; i++) e.__ir_vec_elem_set_f64(i % 2 ? alias : vector, i, i + 0.5);
    const current = e.__arr_resolve(vector),
      view = new DataView(e.memory.buffer);
    expect(current).not.toBe(vector);
    expect(view.getUint32(current + 8, true)).toBe(44);
    for (let i = 0; i < 44; i++) expect(view.getFloat64(current + 16 + i * 8, true)).toBe(i + 0.5);
    live = false;
    expect(() => preparedLinearNumericAppendReservation(tx, pack)).toThrow(/revoked/);
    live = true;
    expect(() => preparedLinearNumericAppendReservation(tx, pack)).toThrow(/failed/);
  });
