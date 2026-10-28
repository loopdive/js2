// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import type {
  PhysicalModuleReservations,
  TypeReservation,
  FunctionReservation,
  TagReservation,
} from "../../src/wasm/physical/module-reservations.js";
import {
  buildNativePromiseResolveValueBody,
  buildPromiseResolveValueLocals,
  buildPromiseThenableJob,
  buildPromiseSettleClosureBody,
} from "../../src/runtime/wasmgc/promise/resolution-bodies.js";
import {
  buildPromisePeelValue,
  buildPromiseThenableClassifier,
  buildPromiseThenableLookup,
} from "../../src/runtime/wasmgc/promise/thenable-bodies.js";
import {
  buildIdentityWrapperBody,
  buildIdentityWrapperLocals,
} from "../../src/runtime/wasmgc/promise/settlement-bodies.js";
import { createBuiltinFunctionMetadataShape } from "../../src/runtime/wasmgc/values/closure-layouts.js";
import {
  createArgumentVectorArrayType,
  createArgumentVectorShape,
  buildArgumentVectorNewBody,
  buildArgumentVectorPushLocals,
  buildArgumentVectorPushBody,
} from "../../src/runtime/wasmgc/values/argument-vector-bodies.js";
import { buildErrorConstructorBody } from "../../src/runtime/wasmgc/values/error-bodies.js";
const ext = { kind: "externref" } as const,
  i32 = { kind: "i32" } as const;
const get = (index: number): Instr => ({ op: "local.get", index });
const num = (value: number): Instr => ({ op: "i32.const", value });
const cast = (typeIdx: number): Instr[] => [{ op: "any.convert_extern" }, { op: "ref.cast", typeIdx }];

/** Finite kernel inventory: real resolver/job/vector builders, explicit fixture then methods. */
export function reserveFrameResolutionKernel(
  tx: PhysicalModuleReservations,
  d: {
    promise: TypeReservation;
    reaction: TypeReservation;
    enqueue: FunctionReservation;
    fulfill: FunctionReservation;
    reject: FunctionReservation;
    tag: TagReservation;
  },
) {
  const ref = (type: TypeReservation): ValType => ({ kind: "ref", typeIdx: type.typeIndex });
  const fn = (name: string, params: readonly ValType[], results: readonly ValType[]) =>
    tx.reserveFunction("resolution:function:" + name, name, { params, results });
  const struct = (name: string, fields: { name: string; type: ValType; mutable: boolean }[]) =>
    tx.reserveType("resolution:" + name, { kind: "struct", name, fields });
  const caps = struct("caps", [
    { name: "callback", type: ext, mutable: false },
    { name: "promise", type: ref(d.promise), mutable: false },
  ]);
  const guard = struct("guard", [{ name: "done", type: i32, mutable: true }]);
  const metadata = createBuiltinFunctionMetadataShape("settle", undefined);
  const settle = struct("settle", [
    ...metadata.fields,
    { name: "promise", type: ref(d.promise), mutable: false },
    { name: "guard", type: ref(guard), mutable: false },
  ]);
  const method = struct("thenable", [
    { name: "value", type: ext, mutable: false },
    { name: "mode", type: i32, mutable: false },
  ]);
  const poisoned = struct("poisonedThenable", [{ name: "reason", type: ext, mutable: false }]);
  const argumentArray = tx.reserveType("resolution:array", createArgumentVectorArrayType());
  const vectorShape = createArgumentVectorShape(ref(argumentArray), undefined);
  const vector = struct("argumentVector", vectorShape.fields);
  const stringArray = tx.reserveType("resolution:string", {
    kind: "array",
    name: "kernelString",
    element: i32,
    mutable: false,
  });
  const text = (value: string): Instr[] => [
    ...Array.from(value, (c) => num(c.charCodeAt(0))),
    { op: "array.new_fixed", typeIdx: stringArray.typeIndex, length: value.length },
    { op: "extern.convert_any" },
  ];
  const error = struct(
    "TypeError",
    [i32, ext, ext, ext, i32, ext].map((type, index) => ({ name: "field" + index, type, mutable: true })),
  );
  const errorName = tx.reserveGlobal("resolution:error-name", "errorName", ext, false);
  const getter = tx.reserveGlobal("resolution:getter", "getter", ext, false);
  const reads = tx.reserveGlobal("resolution:reads", "getterCalls", i32, true);
  const observed = tx.reserveGlobal("resolution:observed", "observedState", i32, true);
  const observer = fn("observer", [ext, ext], [ext]);
  const observe = fn("observe", [ext], []);
  const observedState = fn("observedState", [], [i32]);
  const calls = tx.reserveGlobal("resolution:calls", "thenCalls", i32, true);
  const resolveValue = fn("resolveValue", [ref(d.promise), ext], [ext]);
  const identityFulfill = fn("identityFulfill", [ext, ext], [ext]),
    identityReject = fn("identityReject", [ext, ext], [ext]);
  const peel = fn("peel", [ext], [ext]),
    classifier = fn("classifier", [ext], [i32]),
    lookup = fn("lookup", [ext], [i32, ext]);
  const newError = fn("newTypeError", [ext], [ext]),
    job = fn("thenableJob", [ext, ext], [ext]);
  const resolveClosure = fn("resolveClosure", [ref(settle), ext], []),
    rejectClosure = fn("rejectClosure", [ref(settle), ext], []);
  const vectorNew = fn("vectorNew", [], [ext]),
    vectorPush = fn("vectorPush", [ext, ext], []);
  const methodCall = fn("fixtureThenMethod", [ext, ext], [ext]),
    accessor = fn("fixtureThenGetter", [ext, ext], [ext]);
  const makeThenable = fn("thenable", [ext, i32], [ext]),
    makePoisoned = fn("poisoned", [ext], [ext]),
    count = fn("thenCalls", [], [i32]);
  const readCount = fn("getterCalls", [], [i32]);
  const typeError = fn("isTypeError", [ext], [i32]);
  const cap = {
    capTypeIdx: settle.typeIndex,
    capMetaTypeIdx: settle.typeIndex,
    capPromiseFieldIdx: 5,
    guardTypeIdx: guard.typeIndex,
  };
  const vectorLayout = { objVecArrTypeIdx: argumentArray.typeIndex, objVecTypeIdx: vector.typeIndex };
  return {
    resolveValue,
    fill() {
      tx.fillGlobal(errorName, text("TypeError"));
      tx.fillGlobal(getter, text("getter"));
      tx.fillGlobal(calls, [num(0)]);
      tx.fillGlobal(reads, [num(0)]);
      tx.fillGlobal(observed, [num(-1)]);
      tx.fillFunction(observer, {
        locals: [],
        body: [
          get(0),
          ...cast(d.promise.typeIndex),
          { op: "struct.get", typeIdx: d.promise.typeIndex, fieldIdx: 0 },
          { op: "global.set", index: tx.physicalIndex(observed) },
          { op: "ref.null.extern" },
        ],
      });
      tx.fillFunction(observe, {
        locals: [],
        body: [
          { op: "ref.func", funcIdx: observer.handle },
          get(0),
          { op: "ref.null.extern" },
          { op: "call", funcIdx: d.enqueue.handle },
        ],
      });
      tx.fillFunction(observedState, { locals: [], body: [{ op: "global.get", index: tx.physicalIndex(observed) }] });
      tx.fillFunction(newError, {
        locals: [],
        body: buildErrorConstructorBody(error.typeIndex, 1, 1, {
          kind: "global",
          index: tx.physicalIndex(errorName),
          representation: "externref",
        }),
      });
      tx.fillFunction(typeError, {
        locals: [],
        body: [get(0), { op: "any.convert_extern" }, { op: "ref.test", typeIdx: error.typeIndex }],
      });
      tx.fillFunction(peel, buildPromisePeelValue(null));
      // This explicit finite inventory contains no AnyValue boxes, open objects, fields or arrays with then.
      const inventory = {
        finalized: true as const,
        peelFuncIdx: peel.handle,
        methodTypeIdxs: [method.typeIndex],
        accessors: [{ typeIdx: poisoned.typeIndex, getGlobal: tx.physicalIndex(getter) }],
        callAccessorGetIdx: accessor.handle,
        fields: [],
        closureWrapperTypeIdxs: [settle.typeIndex],
        openObject: null,
      };
      tx.fillFunction(classifier, buildPromiseThenableClassifier(inventory));
      tx.fillFunction(lookup, buildPromiseThenableLookup(inventory));
      tx.fillFunction(accessor, {
        locals: [],
        body: [
          { op: "global.get", index: tx.physicalIndex(reads) },
          num(1),
          { op: "i32.add" },
          { op: "global.set", index: tx.physicalIndex(reads) },
          get(0),
          ...cast(poisoned.typeIndex),
          { op: "struct.get", typeIdx: poisoned.typeIndex, fieldIdx: 0 },
          { op: "throw", tagIdx: tx.physicalIndex(d.tag) },
        ],
      });
      tx.fillFunction(resolveValue, {
        locals: buildPromiseResolveValueLocals(d.promise.typeIndex),
        body: buildNativePromiseResolveValueBody({
          target: { standalone: true, wasi: false },
          state: {
            promiseFulfillFuncIdx: d.fulfill.handle,
            promiseRejectFuncIdx: d.reject.handle,
            enqueueFuncIdx: d.enqueue.handle,
            identityFulfillWrapperFuncIdx: identityFulfill.handle,
            identityRejectWrapperFuncIdx: identityReject.handle,
          },
          promiseTypeIdx: d.promise.typeIndex,
          callbackTypeIdx: d.reaction.typeIndex,
          capsTypeIdx: caps.typeIndex,
          promiseFields: { state: 0, value: 1, callbacks: 2 },
          callbackFields: [0, 1, 2, 3, 4],
          capsFields: { callback: 0, chained: 1 },
          thenable: {
            hasCallableThenFuncIdx: classifier.handle,
            lookupThenFuncIdx: lookup.handle,
            thenableJobFuncIdx: job.handle,
            peelValueFuncIdx: peel.handle,
            newTypeErrorFuncIdx: newError.handle,
          },
          exnTagIdx: tx.physicalIndex(d.tag),
          selfResolutionStringInstrs: text("Self resolution"),
          thenStringInstrs: text("then"),
          thenGetStringInstrs: text("then"),
          bagHasIdx: undefined,
          externGetIdx: undefined,
          typeofFunctionIdx: undefined,
          callableRootTypeIdx: undefined,
        }),
      });
      for (const [token, settler] of [
        [identityFulfill, resolveValue],
        [identityReject, d.reject],
      ] as const)
        tx.fillFunction(token, {
          locals: buildIdentityWrapperLocals(caps.typeIndex),
          body: buildIdentityWrapperBody({
            capsTypeIdx: caps.typeIndex,
            settleFuncIdx: settler.handle,
            beforeHook: undefined,
            afterHook: undefined,
          }),
        });
      tx.fillFunction(resolveClosure, { locals: [], body: buildPromiseSettleClosureBody(cap, resolveValue.handle) });
      tx.fillFunction(rejectClosure, { locals: [], body: buildPromiseSettleClosureBody(cap, d.reject.handle) });
      tx.fillFunction(vectorNew, { locals: [], body: buildArgumentVectorNewBody(vectorLayout) });
      tx.fillFunction(vectorPush, {
        locals: buildArgumentVectorPushLocals(vectorLayout),
        body: buildArgumentVectorPushBody(vectorLayout),
      });
      tx.fillFunction(
        job,
        buildPromiseThenableJob({
          target: { standalone: true, wasi: false },
          promiseTypeIdx: d.promise.typeIndex,
          promiseRejectFuncIdx: d.reject.handle,
          capsTypeIdx: caps.typeIndex,
          capsFields: { callback: 0, chained: 1 },
          objVecNewIdx: vectorNew.handle,
          objVecPushIdx: vectorPush.handle,
          execClosures: { ...cap, resolveClFuncIdx: resolveClosure.handle, rejectClFuncIdx: rejectClosure.handle },
          applyClosureIdx: undefined,
          peelValueFuncIdx: peel.handle,
          varargThenFuncIdx: methodCall.handle,
          exnTag: tx.physicalIndex(d.tag),
        }),
      );
      const read = (fieldIdx: number): Instr[] => [
        get(0),
        ...cast(method.typeIndex),
        { op: "struct.get", typeIdx: method.typeIndex, fieldIdx },
      ];
      const invoke = (rejected: boolean): Instr[] => [
        get(1),
        ...cast(vector.typeIndex),
        { op: "struct.get", typeIdx: vector.typeIndex, fieldIdx: 1 },
        num(rejected ? 1 : 0),
        { op: "array.get", typeIdx: argumentArray.typeIndex },
        ...cast(settle.typeIndex),
        ...read(0),
        { op: "call", funcIdx: rejected ? rejectClosure.handle : resolveClosure.handle },
      ];
      const when = (mode: number, body: Instr[]): Instr[] => [
        ...read(1),
        num(mode),
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: body },
      ];
      const raise: Instr[] = [...read(0), { op: "throw", tagIdx: tx.physicalIndex(d.tag) }];
      tx.fillFunction(methodCall, {
        locals: [],
        body: [
          { op: "global.get", index: tx.physicalIndex(calls) },
          num(1),
          { op: "i32.add" },
          { op: "global.set", index: tx.physicalIndex(calls) },
          ...when(3, raise),
          ...read(1),
          num(1),
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "empty" }, then: invoke(true), else: invoke(false) },
          ...when(2, invoke(true)),
          ...when(4, raise),
          { op: "ref.null.extern" },
        ],
      });
      tx.fillFunction(makeThenable, {
        locals: [],
        body: [get(0), get(1), { op: "struct.new", typeIdx: method.typeIndex }, { op: "extern.convert_any" }],
      });
      tx.fillFunction(makePoisoned, {
        locals: [],
        body: [get(0), { op: "struct.new", typeIdx: poisoned.typeIndex }, { op: "extern.convert_any" }],
      });
      tx.fillFunction(readCount, { locals: [], body: [{ op: "global.get", index: tx.physicalIndex(reads) }] });
      tx.fillFunction(count, { locals: [], body: [{ op: "global.get", index: tx.physicalIndex(calls) }] });
      for (const token of [job, identityFulfill, identityReject, resolveClosure, rejectClosure, observer])
        tx.declareFunctionReference(token);
      for (const [name, token] of Object.entries({
        observe,
        observedState,
        thenable: makeThenable,
        poisoned: makePoisoned,
        thenCalls: count,
        getterCalls: readCount,
        isTypeError: typeError,
      }))
        tx.defineExport("resolution:export:" + name, name, token);
    },
  };
}
