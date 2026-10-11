// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import { buildBuiltinClosureValueInstrs } from "../../src/runtime/wasmgc/values/closure-layouts.js";
import {
  declareNativeStringOwnKeysResources,
  reserveNativeStringOwnKeysResources,
  fillNativeStringOwnKeysResources,
  requireCompletedNativeStringOwnKeys,
} from "../../src/backend/wasmgc/resources/native-string-own-keys.js";
import {
  stringDefineFixture,
  stringDefineRuntimePhases,
  type StringDefineFixture,
  type StringDefineRuntime,
} from "./native-string-define-fixture.js";

export function reserveKeys(f: StringDefineFixture, mutablePlan = false) {
  const dependencies = { own: f.pack, ownDependencies: f.dependencies };
  const recipe = declareNativeStringOwnKeysResources("own-keys", {
    stringObject: f.layouts.types.String.key,
    propEntry: f.objects.propEntry.key,
  });
  const plan = mutablePlan ? structuredClone(recipe) : recipe;
  const keys = reserveNativeStringOwnKeysResources(f.tx, "own-keys", plan, dependencies);
  return { ...f, keys, keyDependencies: dependencies, keyPlan: plan };
}
export function stringKeysFixture(utf8 = false, shifted = false, mutablePlan = false) {
  return reserveKeys(stringDefineFixture(utf8, shifted), mutablePlan);
}
export interface StringKeysRuntime extends StringDefineRuntime {
  ownKeys(object: object): object;
  listLength(list: object): number;
  listAt(list: object, index: number): object;
  isSymbol(value: object): number;
  textLength(value: object): number;
  indexKey(index: number): object;
  symbol(id: number): object;
  markDeleted(object: object, key: object): void;
  setSeq(object: object, key: object, sequence: number): void;
  observedClosure(): object;
  getterCalls(): number;
  invokeObservedGetter(): number;
}
export function* stringKeysRuntimePhases(utf8 = false, shifted = false) {
  let fixture: ReturnType<typeof reserveKeys> | undefined;
  const result = yield* stringDefineRuntimePhases(utf8, shifted, (base) => {
    const f = reserveKeys(base);
    fixture = f;
    const ext: ValType = { kind: "externref" },
      i32: ValType = { kind: "i32" },
      get = (index: number): Instr => ({ op: "local.get", index });
    const signatures: Record<string, { params: ValType[]; results: ValType[] }> = {
      ownKeys: { params: [ext], results: [ext] },
      listLength: { params: [ext], results: [i32] },
      listAt: { params: [ext, i32], results: [ext] },
      isSymbol: { params: [ext], results: [i32] },
      textLength: { params: [ext], results: [i32] },
      symbol: { params: [i32], results: [ext] },
      markDeleted: { params: [ext, ext], results: [] },
      setSeq: { params: [ext, ext, i32], results: [] },
      observedClosure: { params: [], results: [ext] },
      getterCalls: { params: [], results: [i32] },
      invokeObservedGetter: { params: [], results: [{ kind: "f64" }] },
    };
    const observers = Object.fromEntries(
      Object.entries(signatures).map(([name, signature]) => [
        name,
        f.tx.reserveFunction("key-observer:" + name, name, signature),
      ]),
    );
    const calls = f.tx.reserveGlobal("key-observer:getter-calls", "getterCalls", i32, true);
    const lifted = f.tx.reserveFunction("key-observer:observed-getter", "observedGetter", {
      params: [{ kind: "ref", typeIdx: f.closures.root.typeIndex }],
      results: [{ kind: "f64" }],
    });
    const closureBody = () =>
      buildBuiltinClosureValueInstrs(f.closures.signatures[0]!.binding.type.typeIndex, lifted.handle, 0, false);
    return function* () {
      fillNativeStringOwnKeysResources(f.tx, f.keys);
      requireCompletedNativeStringOwnKeys(f.tx, f.keys, f.keyDependencies);
      yield "String key-list bodies";
      const fill = (name: string, body: Instr[]) => f.tx.fillFunction(observers[name]!, { locals: [], body });
      const list = [
        get(0),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: f.keys.list.typeIndex },
      ] satisfies Instr[];
      fill("ownKeys", [
        get(0),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: f.layouts.types.String.typeIndex },
        { op: "call", funcIdx: f.keys.ownKeys.handle },
        { op: "extern.convert_any" },
      ]);
      fill("listLength", [...list, { op: "array.len" }]);
      fill("listAt", [...list, get(1), { op: "array.get", typeIdx: f.keys.list.typeIndex }]);
      fill("isSymbol", [
        get(0),
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: f.symbols.types.symbol.typeIndex },
      ]);
      fill("textLength", [
        get(0),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: f.anyString },
        { op: "struct.get", typeIdx: f.anyString, fieldIdx: 0 },
      ]);
      fill("symbol", [get(0), { op: "call", funcIdx: f.symbols.functions.box.handle }]);
      f.tx.fillGlobal(calls, [{ op: "i32.const", value: 0 }]);
      f.tx.fillFunction(lifted, {
        locals: [],
        body: [
          { op: "global.get", index: f.tx.physicalIndex(calls) },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "global.set", index: f.tx.physicalIndex(calls) },
          { op: "f64.const", value: 7 },
        ],
      });
      f.tx.declareFunctionReference(lifted);
      fill("observedClosure", [...closureBody(), { op: "extern.convert_any" }]);
      fill("getterCalls", [{ op: "global.get", index: f.tx.physicalIndex(calls) }]);
      fill("invokeObservedGetter", [...closureBody(), { op: "call", funcIdx: lifted.handle }]);
      const object = [
        get(0),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: f.objects.object.typeIndex },
      ] satisfies Instr[];
      const find = [
        ...object,
        get(1),
        { op: "call", funcIdx: f.lookup.findOwn.handle },
        { op: "ref.as_non_null" },
      ] satisfies Instr[];
      fill("setSeq", [...find, get(2), { op: "struct.set", typeIdx: f.objects.propEntry.typeIndex, fieldIdx: 3 }]);
      // Deliberate fixture transition to a canonical tombstone, not a public Delete implementation.
      f.tx.fillFunction(observers.markDeleted!, {
        locals: [{ name: "entry", type: { kind: "ref", typeIdx: f.objects.propEntry.typeIndex } }],
        body: [
          ...find,
          { op: "local.set", index: 2 },
          get(2),
          get(2),
          { op: "struct.get", typeIdx: f.objects.propEntry.typeIndex, fieldIdx: 2 },
          { op: "i32.const", value: 128 },
          { op: "i32.or" },
          { op: "struct.set", typeIdx: f.objects.propEntry.typeIndex, fieldIdx: 2 },
          ...object,
          ...object,
          { op: "struct.get", typeIdx: f.objects.object.typeIndex, fieldIdx: 2 },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          { op: "struct.set", typeIdx: f.objects.object.typeIndex, fieldIdx: 2 },
          ...object,
          ...object,
          { op: "struct.get", typeIdx: f.objects.object.typeIndex, fieldIdx: 3 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "struct.set", typeIdx: f.objects.object.typeIndex, fieldIdx: 3 },
        ],
      });
      for (const [name, token] of Object.entries({ ...observers, indexKey: f.keys.indexKey }))
        f.tx.defineExport("key-export:" + name, name, token);
      yield "String key-list observers";
    };
  });
  if (!fixture) throw Error("missing key-list fixture");
  return { ...result, f: fixture, runtime: result.runtime as StringKeysRuntime };
}

export function stringKeysRuntime(...args: Parameters<typeof stringKeysRuntimePhases>) {
  const phases = stringKeysRuntimePhases(...args);
  let step = phases.next();
  while (!step.done) step = phases.next();
  return step.value;
}
