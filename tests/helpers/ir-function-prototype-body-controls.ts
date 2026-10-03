// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createEmptyModule } from "../../src/ir/types.js";
import { emitBinary } from "../../src/emit/binary.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import { PhysicalModuleReservations } from "../../src/wasm/physical/module-reservations.js";
import { createVectorBaseType } from "../../src/runtime/wasmgc/values/vector-grow-store.js";
import {
  declareNativeArgumentVectorResources,
  reserveNativeArgumentVectorResources,
  fillNativeArgumentVectorResources,
} from "../../src/backend/wasmgc/resources/native-argument-vectors.js";
import { buildCreateListFromArrayLikeDefinition } from "../../src/runtime/wasmgc/values/create-list-from-array-like-body.js";
import { buildFunctionPrototypeInvokerDefinition } from "../../src/runtime/wasmgc/values/function-prototype-invoker-bodies.js";

export interface InvocationRecord {
  target: unknown;
  thisArg: unknown;
  args: unknown[];
}
export type ObserverName =
  | "isObject"
  | "get"
  | "toLength"
  | "indexToString"
  | "isPropertyKey"
  | "isCallable"
  | "isUndefined"
  | "isNull"
  | "undefinedValue"
  | "typeError";
export type ObserverOverrides = Partial<Record<ObserverName, (...args: any[]) => unknown>>;
const reflectGet = Reflect.get,
  reflectApply = Reflect.apply;
/** Real coercion oracle, including BigInt/Symbol refusal. Not a production-native conversion owner. */
export function observedToLength(value: unknown): number {
  const numeric = +(value as number);
  if (Number.isNaN(numeric) || numeric <= 0) return 0;
  return Math.min(Math.trunc(numeric), 2 ** 53 - 1);
}
/** Actual Wasm algorithms + issued vectors; host semantic observers are explicit component oracles. */
export function functionPrototypeBodyRuntime(displaced: boolean) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const ext: ValType = { kind: "externref" },
    i32: ValType = { kind: "i32" },
    f64: ValType = { kind: "f64" };
  const signature = (params: ValType[], results: ValType[]) => ({ params, results });
  const offsetFunctions = displaced
    ? [tx.reserveFunctionImport("offset:noop", "offset", "noop", signature([], []))]
    : [];
  if (displaced) {
    tx.reserveType("offset:struct", { kind: "struct", name: "$Offset", fields: [{ name: "x", type: f64 }] });
    tx.reserveType("offset:array", { kind: "array", name: "$OffsetArray", element: i32, mutable: true });
  }
  const params: Record<ObserverName, ValType[]> = {
    isObject: [ext],
    get: [ext, ext, ext],
    toLength: [ext],
    indexToString: [f64],
    isPropertyKey: [ext],
    isCallable: [ext],
    isUndefined: [ext],
    isNull: [ext],
    undefinedValue: [],
    typeError: [ext],
  };
  const predicates = new Set<ObserverName>(["isObject", "isPropertyKey", "isCallable", "isUndefined", "isNull"]);
  const observerNames = Object.keys(params) as ObserverName[];
  const observers = Object.fromEntries(
    observerNames.map((key) => [
      key,
      tx.reserveFunctionImport(
        "observer:" + key,
        "observer",
        key,
        signature(params[key], [predicates.has(key) ? i32 : key === "toLength" ? f64 : ext]),
      ),
    ]),
  ) as Record<ObserverName, ReturnType<typeof tx.reserveFunctionImport>>;
  const lengthKey = tx.reserveFunctionImport("observer:lengthKey", "observer", "lengthKey", signature([], [ext]));
  const errorMessage = tx.reserveFunctionImport(
    "observer:errorMessage",
    "observer",
    "errorMessage",
    signature([], [ext]),
  );
  const begin = tx.reserveFunctionImport("observer:begin", "observer", "begin", signature([ext, ext], []));
  const append = tx.reserveFunctionImport("observer:append", "observer", "append", signature([ext], []));
  const finish = tx.reserveFunctionImport("observer:finish", "observer", "finish", signature([], [ext]));
  if (displaced) tx.reserveTag("offset:tag", signature([], []), { kind: "import", module: "offset", name: "tag" });
  const offsetGlobal = displaced ? tx.reserveGlobal("offset:global", "$offset", i32, true) : undefined;
  if (displaced) tx.reserveTag("offset:defined-tag", signature([i32], []), { kind: "defined", name: "$OffsetTag" });
  const exception = tx.reserveTag("exception", signature([ext], []), { kind: "defined", name: "$Exception" });
  const vectorBase = tx.reserveType("vector-base", createVectorBaseType());
  const vectorPlan = declareNativeArgumentVectorResources({ key: "argv" }, { vectorBaseKey: vectorBase.key });
  const pack = reserveNativeArgumentVectorResources(tx, { key: "argv" }, { vectorBase }, vectorPlan);
  const v: ValType = { kind: "ref", typeIdx: pack.carrier.typeIndex };
  const genericCall = tx.reserveFunction("generic-call-observer", "$ObservedCall", signature([ext, ext, v], [ext]));
  const lists = {
    all: tx.reserveFunction("list:all", "$CreateListAll", signature([ext], [v])),
    "property-key": tx.reserveFunction("list:property-key", "$CreateListPropertyKey", signature([ext], [v])),
  };
  const invokers = {
    call: tx.reserveFunction("body:call", "$FunctionCall", signature([ext, v], [ext])),
    apply: tx.reserveFunction("body:apply", "$FunctionApply", signature([ext, v], [ext])),
  };
  const bridges = {
    call: tx.reserveFunction("bridge:call", "$CallBridge", signature([ext, ext], [ext])),
    apply: tx.reserveFunction("bridge:apply", "$ApplyBridge", signature([ext, ext], [ext])),
    all: tx.reserveFunction("bridge:all", "$ListAllBridge", signature([ext], [ext])),
    "property-key": tx.reserveFunction("bridge:property-key", "$ListKeysBridge", signature([ext], [ext])),
    length: tx.reserveFunction("bridge:length", "$VectorLength", signature([ext], [i32])),
    at: tx.reserveFunction("bridge:at", "$VectorAt", signature([ext, i32], [ext])),
    index: tx.reserveFunction("bridge:index", "$IndexStringContract", signature([f64], [ext])),
  };
  tx.freezeReservations();
  if (offsetGlobal) tx.fillGlobal(offsetGlobal, [{ op: "i32.const", value: 19 }]);
  fillNativeArgumentVectorResources(tx, pack);
  const tagIndex = tx.physicalIndex(exception);
  const handles = Object.fromEntries(observerNames.map((key) => [key, observers[key].handle])) as Record<
    ObserverName,
    number
  >;
  const operands = {
    errorMessage: [{ op: "call" as const, funcIdx: errorMessage.handle }],
    lengthKey: [{ op: "call" as const, funcIdx: lengthKey.handle }],
  };
  const listBindings = {
    ...handles,
    ...operands,
    vector: pack.layout,
    newVector: pack.newVector.handle,
    push: pack.push.handle,
    exceptionTag: tagIndex,
  };
  const invokerBindings = {
    ...listBindings,
    createListFromArrayLike: lists.all.handle,
    genericCall: genericCall.handle,
  };
  const definitions = {
    all: buildCreateListFromArrayLikeDefinition(listBindings),
    "property-key": buildCreateListFromArrayLikeDefinition(listBindings, "property-key"),
    call: buildFunctionPrototypeInvokerDefinition("call", invokerBindings),
    apply: buildFunctionPrototypeInvokerDefinition("apply", invokerBindings),
  };
  for (const mode of ["all", "property-key"] as const) tx.fillFunction(lists[mode], definitions[mode]);
  for (const method of ["call", "apply"] as const) tx.fillFunction(invokers[method], definitions[method]);
  const cast: Instr[] = [{ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: pack.carrier.typeIndex }];
  for (const method of ["call", "apply"] as const)
    tx.fillFunction(bridges[method], {
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        ...structuredClone(cast),
        { op: "return_call", funcIdx: invokers[method].handle },
      ],
    });
  for (const mode of ["all", "property-key"] as const)
    tx.fillFunction(bridges[mode], {
      locals: [],
      body: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: lists[mode].handle }, { op: "extern.convert_any" }],
    });
  tx.fillFunction(bridges.length, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      ...structuredClone(cast),
      { op: "struct.get", typeIdx: pack.carrier.typeIndex, fieldIdx: 0 },
    ],
  });
  tx.fillFunction(bridges.at, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      ...structuredClone(cast),
      { op: "struct.get", typeIdx: pack.carrier.typeIndex, fieldIdx: 1 },
      { op: "local.get", index: 1 },
      { op: "array.get", typeIdx: pack.array.typeIndex },
    ],
  });
  tx.fillFunction(bridges.index, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "return_call", funcIdx: observers.indexToString.handle },
    ],
  });
  tx.fillFunction(genericCall, {
    locals: [
      { name: "$index", type: i32 },
      { name: "$length", type: i32 },
    ],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: begin.handle },
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: pack.carrier.typeIndex, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "struct.get", typeIdx: pack.carrier.typeIndex, fieldIdx: 1 },
              { op: "local.get", index: 3 },
              { op: "array.get", typeIdx: pack.array.typeIndex },
              { op: "call", funcIdx: append.handle },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "return_call", funcIdx: finish.handle },
    ],
  });
  for (const [name, token] of Object.entries(bridges)) tx.defineExport("export:" + name, name, token);
  tx.defineExport("export:new", "new", pack.newVector);
  tx.defineExport("export:push", "push", pack.push);
  tx.defineExport("export:exception", "exception", exception);
  const census = tx.seal();
  const binary = emitBinary(module);
  const wasm = new WebAssembly.Module(binary as BufferSource);
  function instantiate(overrides: ObserverOverrides = {}) {
    const trace: string[] = [],
      records: InvocationRecord[] = [],
      frames: InvocationRecord[] = [];
    const defaults: Record<ObserverName, (...args: any[]) => unknown> = {
      isObject: (value) => +(value !== null && (typeof value === "object" || typeof value === "function")),
      get: (object, key, receiver) => reflectGet(object, key, receiver),
      toLength: observedToLength,
      indexToString: (index: number) => String(index),
      isPropertyKey: (value) => +(typeof value === "string" || typeof value === "symbol"),
      isCallable: (value) => +(typeof value === "function"),
      isUndefined: (value) => +(value === undefined),
      isNull: (value) => +(value === null),
      undefinedValue: () => undefined,
      typeError: (message) => new TypeError(String(message)),
    };
    const observer = Object.fromEntries(
      observerNames.map((key) => [
        key,
        (...args: any[]) => {
          trace.push(
            key === "get" ? "get:" + String(args[1]) : key === "indexToString" ? "index:" + String(args[0]) : key,
          );
          return (overrides[key] ?? defaults[key])(...args);
        },
      ]),
    );
    Object.assign(observer, {
      lengthKey: () => "length",
      errorMessage: () => "function invoker TypeError",
      begin: (target: unknown, thisArg: unknown) => {
        trace.push("call:begin");
        frames.push({ target, thisArg, args: [] });
      },
      append: (value: unknown) => {
        frames.at(-1)!.args.push(value);
      },
      finish: () => {
        // Pop BEFORE executing the target: reentrant algorithm calls get independent frames.
        const record = frames.pop()!;
        records.push(record);
        trace.push("call:target");
        return reflectApply(record.target as (...args: unknown[]) => unknown, record.thisArg, record.args);
      },
    });
    const instance = new WebAssembly.Instance(wasm, {
      observer,
      offset: { noop() {}, tag: new WebAssembly.Tag({ parameters: [] }) },
    });
    const exports = instance.exports as unknown as {
      "new"(): unknown;
      push(vector: unknown, value: unknown): void;
      length(vector: unknown): number;
      at(vector: unknown, index: number): unknown;
      call(target: unknown, input: unknown): unknown;
      apply(target: unknown, input: unknown): unknown;
      all(object: unknown): unknown;
      "property-key"(object: unknown): unknown;
      exception: WebAssembly.Tag;
      index(value: number): unknown;
    };
    const vector = (values: readonly unknown[]) => {
      const v = exports.new();
      for (const value of values) exports.push(v, value);
      return v;
    };
    const read = (v: unknown) => Array.from({ length: exports.length(v) }, (_, index) => exports.at(v, index));
    return { exports, vector, read, trace, records, frames };
  }
  return {
    module,
    binary,
    census,
    pack,
    definitions,
    listBindings,
    invokerBindings,
    tagIndex,
    offsetFunctions,
    instantiate,
  };
}
