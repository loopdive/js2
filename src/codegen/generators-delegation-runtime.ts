// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Native yield-star protocol. Ordinary IteratorStep deliberately keeps its ABI. */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext, NativeGeneratorInfo } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType, getOrRegisterVecType, getArrTypeIdxFromVec } from "./registry/types.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { ensureNativeIteratorRuntime, externIsObjectInstrs } from "./iterator-native.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { emitToBoolean } from "./coercion-engine.js";
import {
  ensureNativeGeneratorProtocol,
  fillNativeGeneratorProtocol,
  buildNativeGeneratorProtocolGet,
} from "./generators-native-protocol.js";
import { coerceType, ensureLateImport, flushLateImportShifts } from "./shared.js";

const ER: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const keys = ["iterator", "next", "throw", "return", "done", "value"] as const;
type Key = (typeof keys)[number];
const recordName = "__GenDelegateRecord";
const getName = (key: Key) => `__gen_delegate_get_${key}`;
const load = (index: number): Instr => ({ op: "local.get", index });
const set = (index: number): Instr => ({ op: "local.set", index });
const num = (value: number): Instr => ({ op: "i32.const", value });
const call = (ctx: CodegenContext, name: string): Instr => {
  const funcIdx = ctx.funcMap.get(name);
  if (funcIdx === undefined) throw new Error(`Missing native delegation dependency ${name}`);
  return { op: "call", funcIdx };
};
const branch = (then: Instr[], otherwise: Instr[] = [], type?: ValType): Instr => ({
  op: "if",
  blockType: type ? { kind: "val", type } : { kind: "empty" },
  then: structuredClone(then),
  else: structuredClone(otherwise),
});

/** Validate before mutating resume payloads or entering the completion-catching body. */
export function nativeGeneratorExecutingCheck(ctx: CodegenContext, info: NativeGeneratorInfo, self: Instr[]): Instr[] {
  if (info.executingFieldIdx === undefined) return [];
  return [
    ...self,
    { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.executingFieldIdx },
    branch(buildThrowJsErrorInstrs(ctx, "TypeError", "Invalid iterator protocol")),
  ];
}

/** Canonical conversion is invoked only after the receiver selects a numeric carrier. */
export function ensureNativeGeneratorNumericPayload(ctx: CodegenContext): number {
  const name = "__gen_numeric_payload";
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const fctx: FunctionContext = {
    name,
    params: [{ name: "value", type: ER }],
    locals: [],
    localMap: new Map([["value", 0]]),
    returnType: { kind: "f64" },
    body: [load(0)],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  coerceType(ctx, fctx, ER, { kind: "f64", undefSentinel: true });
  const typeIdx = addFuncType(ctx, [ER], [{ kind: "f64" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: fctx.locals, body: fctx.body, exported: false });
  return funcIdx;
}

/** Reserve before emitting callers; the existing iterator finalization fills bodies. */
export function ensureNativeDelegatedResultHelpers(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__gen_delegate_start")) return;
  ensureNativeIteratorRuntime(ctx);
  ensureObjectRuntime(ctx);
  reserveApplyClosure(ctx);
  for (const name of ["__typeof_object", "__typeof_function"]) {
    ensureLateImport(ctx, name, [ER], [I32]);
  }
  emitToBoolean(ctx, ER, []);
  buildThrowJsErrorInstrs(ctx, "TypeError", "Invalid iterator protocol");
  const recordType = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: recordName,
    fields: [
      { name: "iterator", type: ER, mutable: false },
      { name: "next", type: ER, mutable: false },
      { name: "started", type: I32, mutable: true },
    ],
  });
  ctx.structMap.set(recordName, recordType);
  const reserve = (name: string, params: ValType[], results: ValType[], locals: ValType[]) => {
    const typeIdx = addFuncType(ctx, params, results);
    const idx = mintDefinedFunc(ctx);
    ctx.funcMap.set(name, idx);
    pushDefinedFunc(ctx, idx, {
      name,
      typeIdx,
      exported: false,
      locals: locals.map((type, i) => ({ name: `t${i}`, type })),
      body: [{ op: "unreachable" }],
    });
  };
  for (const key of keys) reserve(getName(key), [ER], [ER], []);
  reserve("__gen_result_unwrap", [ER], [ER], []);
  reserve("__gen_delegate_iter_result", [ER], [I32, ER], [ER, I32]);
  const vec = getOrRegisterVecType(ctx, "externref", ER);
  const array = getArrTypeIdxFromVec(ctx, vec);
  reserve("__gen_delegate_start", [ER], [ER], [ER, ER, ER, { kind: "ref_null", typeIdx: array }]);
  // status 0 = suspend with RAW result, 1 = normal completion, 2 = return completion.
  reserve(
    "__gen_delegate_step",
    [ER, I32, ER],
    [I32, ER],
    [{ kind: "ref", typeIdx: recordType }, ER, ER, ER, { kind: "ref_null", typeIdx: array }, I32],
  );
  ctx.nativeIteratorUserArmPending = true;
  ensureNativeGeneratorProtocol(ctx);
  flushLateImportShifts(ctx, ctx.currentFunc);
}

function resultType(ctx: CodegenContext): number | undefined {
  return [...ctx.nativeGenerators.values()].find((info) => info.nativeDelegates)?.resultTypeIdx;
}

/** Property reads preserve accessor timing; primitive results are validated by the caller. */
function buildGetter(ctx: CodegenContext, key: Key): { body: Instr[]; locals: FunctionContext["locals"] } {
  const fctx: FunctionContext = {
    name: getName(key),
    params: [{ name: "receiver", type: ER }],
    locals: [],
    localMap: new Map([["receiver", 0]]),
    returnType: ER,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  const property = key === "iterator" ? "@@iterator" : key;
  const keyValue = (): Instr[] =>
    key === "iterator"
      ? [num(1), call(ctx, "__box_symbol")]
      : [...nativeStringLiteralInstrs(ctx, key), { op: "extern.convert_any" }];
  let fallback: Instr[] = [load(0), ...keyValue(), call(ctx, "__extern_get")];
  const sget = ctx.funcMap.get(`__sget_${property}`);
  if (sget !== undefined) {
    const fn = definedFuncAt(ctx, sget);
    const sig = fn && ctx.mod.types[fn.typeIdx];
    if (sig?.kind === "func" && sig.results[0]) {
      fctx.body = [load(0), { op: "call", funcIdx: sget }];
      coerceType(ctx, fctx, sig.results[0], ER);
      const closed = fctx.body;
      const open = ctx.objectRuntimeTypes?.objectTypeIdx;
      if (open !== undefined)
        fallback = [
          load(0),
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: open },
          branch(fallback, closed, ER),
        ];
    }
  }
  // Descriptor accessors on closed shapes live in closure globals, not fields.
  const accessor = ctx.funcMap.get("__call_accessor_get");
  if (accessor !== undefined) {
    for (const [name, entry] of ctx.structAccessorClosure) {
      const suffix = `_${property}`;
      if (!name.endsWith(suffix) || entry.getGlobal === undefined) continue;
      const typeIdx = ctx.structMap.get(name.slice(0, -suffix.length));
      if (typeIdx === undefined) continue;
      fallback = [
        load(0),
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx },
        branch(
          [
            { op: "global.get", index: entry.getGlobal },
            { op: "ref.is_null" },
            branch(
              fallback,
              [load(0), { op: "global.get", index: entry.getGlobal }, { op: "call", funcIdx: accessor }],
              ER,
            ),
          ],
          fallback,
          ER,
        ),
      ];
    }
  }
  if (key === "done" || key === "value") {
    const seen = new Set<number>();
    for (const info of ctx.nativeGenerators.values()) {
      const nativeResult = info.resultTypeIdx;
      if (seen.has(nativeResult)) continue;
      seen.add(nativeResult);
      fctx.body = [
        load(0),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: nativeResult },
        { op: "struct.get", typeIdx: nativeResult, fieldIdx: key === "value" ? 0 : 1 },
      ];
      coerceType(
        ctx,
        fctx,
        key === "done"
          ? { kind: "i32", boolean: true }
          : info.elemValType.kind === "f64"
            ? { kind: "f64", undefSentinel: true }
            : info.elemValType,
        ER,
      );
      fallback = [
        load(0),
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: nativeResult },
        branch(fctx.body, fallback, ER),
      ];
    }
  }
  if (key === "iterator" || key === "next" || key === "throw" || key === "return") {
    fallback = buildNativeGeneratorProtocolGet(ctx, fctx, key, fallback);
  }
  return { body: fallback, locals: fctx.locals };
}

function fillProtocol(ctx: CodegenContext): void {
  const recordType = ctx.structMap.get(recordName)!;
  const vec = getOrRegisterVecType(ctx, "externref", ER);
  const array = getArrTypeIdxFromVec(ctx, vec);
  const undef = () => canonicalUndefinedExternInstrs(ctx);
  const fail = () => buildThrowJsErrorInstrs(ctx, "TypeError", "Invalid iterator protocol");
  const nullish = (local: number): Instr[] => {
    const check = ctx.funcMap.get("__extern_is_nullish");
    return check !== undefined
      ? [load(local), { op: "call", funcIdx: check }]
      : [load(local), { op: "ref.is_null" }, load(local), call(ctx, "__extern_is_undefined"), { op: "i32.or" }];
  };
  const requireCallable = (local: number): Instr[] => [
    load(local),
    call(ctx, "__typeof_function"),
    { op: "i32.eqz" },
    branch(fail()),
  ];
  const requireObject = (local: number): Instr[] => [
    ...externIsObjectInstrs(ctx, local)!,
    { op: "i32.eqz" },
    branch(fail()),
  ];
  const args = (scratch: number, value?: Instr[]): Instr[] => [
    num(value ? 1 : 0),
    { op: "array.new_default", typeIdx: array },
    set(scratch),
    ...(value ? [load(scratch), num(0), ...value, { op: "array.set", typeIdx: array } as Instr] : []),
    num(value ? 1 : 0),
    load(scratch),
    { op: "struct.new", typeIdx: vec },
    { op: "extern.convert_any" },
  ];
  const start = definedFuncAt(ctx, ctx.funcMap.get("__gen_delegate_start")!)!;
  start.body = [
    load(0),
    call(ctx, getName("iterator")),
    set(1),
    ...requireCallable(1),
    load(1),
    load(0),
    ...args(4),
    call(ctx, "__apply_closure"),
    set(2),
    ...requireObject(2),
    load(2),
    call(ctx, getName("next")),
    set(3),
    // GetIterator captures next; IsCallable is checked when it is invoked.
    load(2),
    load(3),
    num(0),
    { op: "struct.new", typeIdx: recordType },
    { op: "extern.convert_any" },
  ];
  const recGet = (fieldIdx: number): Instr[] => [load(3), { op: "struct.get", typeIdx: recordType, fieldIdx }];
  const invoke = (value?: Instr[]): Instr[] => [
    ...requireCallable(5),
    load(5),
    load(4),
    ...args(7, value),
    call(ctx, "__apply_closure"),
    set(6),
    ...requireObject(6),
  ];
  const missingThrow: Instr[] = [
    load(4),
    call(ctx, getName("return")),
    set(5),
    ...nullish(5),
    branch([], invoke()),
    ...fail(),
  ];
  const step = definedFuncAt(ctx, ctx.funcMap.get("__gen_delegate_step")!)!;
  step.body = [
    load(0),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: recordType },
    set(3),
    ...recGet(0),
    set(4),
    load(1),
    { op: "i32.eqz" },
    branch(
      [
        ...recGet(1),
        set(5),
        ...recGet(2),
        { op: "i32.eqz" },
        branch([...undef(), set(2)]),
        load(3),
        num(1),
        { op: "struct.set", typeIdx: recordType, fieldIdx: 2 },
      ],
      [
        load(1),
        num(2),
        { op: "i32.eq" },
        branch(
          [load(4), call(ctx, getName("throw")), set(5), ...nullish(5), branch(missingThrow)],
          [load(4), call(ctx, getName("return")), set(5), ...nullish(5), branch([num(2), load(2), { op: "return" }])],
        ),
      ],
    ),
    ...invoke([load(2)]),
    load(6),
    call(ctx, getName("done")),
    ...emitToBoolean(ctx, ER, []),
    set(8),
    load(8),
    branch(
      [
        load(1),
        num(1),
        { op: "i32.eq" },
        branch([num(2)], [num(1)], I32),
        load(6),
        call(ctx, getName("value")),
        { op: "return" },
      ],
      [num(0), load(6), { op: "return" }],
    ),
    { op: "unreachable" },
  ];
}

/** Called only after struct methods/accessors are emitted, before closure dispatch fill. */
export function fillNativeDelegationRuntime(ctx: CodegenContext): void {
  if (!ctx.funcMap.has("__gen_delegate_start")) return;
  fillNativeGeneratorProtocol(ctx);
  for (const key of keys) {
    const fn = definedFuncAt(ctx, ctx.funcMap.get(getName(key))!)!;
    const built = buildGetter(ctx, key);
    fn.body = built.body;
    fn.locals = built.locals;
  }
  const typeIdx = resultType(ctx);
  const fn = definedFuncAt(ctx, ctx.funcMap.get("__gen_result_unwrap")!)!;
  fn.body =
    typeIdx === undefined
      ? [load(0)]
      : [
          load(0),
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx },
          branch(
            [
              load(0),
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx },
              { op: "struct.get", typeIdx, fieldIdx: 1 },
              num(-1),
              { op: "i32.eq" },
              branch(
                [
                  load(0),
                  { op: "any.convert_extern" },
                  { op: "ref.cast", typeIdx },
                  { op: "struct.get", typeIdx, fieldIdx: 0 },
                ],
                [load(0)],
                ER,
              ),
            ],
            [load(0)],
            ER,
          ),
        ];
  const iteration = definedFuncAt(ctx, ctx.funcMap.get("__gen_delegate_iter_result")!)!;
  iteration.body = [
    load(0),
    call(ctx, "__gen_result_unwrap"),
    set(1),
    load(1),
    call(ctx, getName("done")),
    ...emitToBoolean(ctx, ER, []),
    set(2),
    load(2),
    load(2),
    branch(canonicalUndefinedExternInstrs(ctx), [load(1), call(ctx, getName("value"))], ER),
  ];
  fillProtocol(ctx);
}
