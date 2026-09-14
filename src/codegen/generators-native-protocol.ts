// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Ordinary protocol property values for native generator state objects. */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { allocLocal } from "./context/locals.js";
import { nextModuleGlobalIdx } from "./registry/imports.js";
import { ensureStandaloneNativeMethodClosure } from "./native-proto.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { ensureGeneratorPrototypeNativeProtoGlue, emitGeneratorPrototypeSingleton } from "./array-object-proto.js";
import { ensureCurrentThisGlobal } from "./statements/nested-declarations.js";
import { reserveOpaqueNativeGeneratorDispatch } from "./generators-native-consumer.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { ensureExternStrictEqHelper } from "./any-helpers.js";
import { externIsObjectInstrs } from "./iterator-native.js";
import { PROTO_FROM_FUNCTION } from "./proto-function-value.js";
import { UNDEF_F64_BITS } from "./value-tags.js";

const ER: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
export const NATIVE_GENERATOR_PROTO_VIEW = "__native_generator_proto_view";
export const NATIVE_GENERATOR_FACTORY_PROTO = "__native_generator_factory_proto";
export const NATIVE_GENERATOR_INIT_PROTO = "__native_generator_init_proto";
export const NATIVE_GENERATOR_DEFAULT_PROTO = "__native_generator_default_proto";
export const NATIVE_GENERATOR_PROTOCOL_GET = "__native_generator_protocol_get";
export type NativeGeneratorProtocolKey = "iterator" | "next" | "return" | "throw";
const protocolKeys: readonly NativeGeneratorProtocolKey[] = ["iterator", "next", "return", "throw"];
const prepared = new WeakSet<CodegenContext>();
const getterName = (key: NativeGeneratorProtocolKey) => `__native_generator_method_value_${key}`;
const load = (index: number): Instr => ({ op: "local.get", index });
const call = (ctx: CodegenContext, name: string): Instr => {
  const funcIdx = ctx.funcMap.get(name);
  if (funcIdx === undefined) throw new Error(`Missing generator protocol dependency ${name}`);
  return { op: "call", funcIdx };
};
function scratch(name: string): FunctionContext {
  return {
    name,
    params: [],
    locals: [],
    localMap: new Map(),
    returnType: ER,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
}
function reserve(ctx: CodegenContext, name: string, params: ValType[], results: ValType[], body: Instr[]): number {
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, params, results);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: [], body, exported: false });
  return funcIdx;
}

/** Early inert reservation: object-runtime may call this before generators exist. */
export function reserveNativeGeneratorProtocolLookup(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  reserve(ctx, NATIVE_GENERATOR_PROTO_VIEW, [ER], [ER], [load(0)]);
  reserve(
    ctx,
    NATIVE_GENERATOR_PROTOCOL_GET,
    [ER, ER],
    [I32, ER],
    [{ op: "i32.const", value: 0 }, { op: "ref.null.extern" }],
  );
}

function keyInstrs(ctx: CodegenContext, key: NativeGeneratorProtocolKey): Instr[] {
  return key === "iterator"
    ? [{ op: "i32.const", value: 1 }, call(ctx, "__box_symbol")]
    : [...nativeStringLiteralInstrs(ctx, key), { op: "extern.convert_any" }];
}

/** Reserve callable singleton values before closure/iterator finalization. */
export function ensureNativeGeneratorProtocol(ctx: CodegenContext, _caller?: FunctionContext): void {
  if (!(ctx.standalone || ctx.wasi) || prepared.has(ctx)) return;
  prepared.add(ctx); // Opaque dispatch reservation re-enters the iterator runtime.
  reserveNativeGeneratorProtocolLookup(ctx);
  ensureCurrentThisGlobal(ctx);
  ensureExternStrictEqHelper(ctx);
  for (const key of protocolKeys) {
    // Cache closure construction in a FUNCTION body, never in a discarded
    // compiler scratch stream. Each read sees the same intrinsic method.
    const name = `__native_generator_method_${key}`;
    const brand = ensureGeneratorPrototypeNativeProtoGlue(ctx);
    if (brand === undefined) throw new Error("Missing GeneratorPrototype brand");
    const closure = ensureStandaloneNativeMethodClosure(ctx, brand, key === "iterator" ? "@@1" : key, "method");
    if (!closure) throw new Error(`Cannot materialize generator protocol method ${key}`);
    const factory = scratch(getterName(key));
    factory.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure), { op: "extern.convert_any" });
    const cache = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({ name: `${name}_singleton`, type: ER, mutable: true, init: [{ op: "ref.null.extern" }] });
    const body: Instr[] = [
      { op: "global.get", index: cache },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [...factory.body, { op: "global.set", index: cache }], else: [] },
      { op: "global.get", index: cache },
    ];
    const getter = reserve(ctx, getterName(key), [], [ER], body);
    definedFuncAt(ctx, getter)!.locals = factory.locals;
    // Intern keys now, so the final fill only reads existing constants.
    keyInstrs(ctx, key);
  }
  const protoFactory = scratch(NATIVE_GENERATOR_DEFAULT_PROTO);
  if (!emitGeneratorPrototypeSingleton(ctx, protoFactory)) throw new Error("Missing generator default prototype");
  const protoGetter = reserve(ctx, NATIVE_GENERATOR_DEFAULT_PROTO, [], [ER], protoFactory.body);
  definedFuncAt(ctx, protoGetter)!.locals = protoFactory.locals;
  const prototypeKey = () => [...nativeStringLiteralInstrs(ctx, "prototype"), { op: "extern.convert_any" } as Instr];
  const factoryProto = reserve(
    ctx,
    NATIVE_GENERATOR_FACTORY_PROTO,
    [ER],
    [ER],
    [
      load(0),
      ...prototypeKey(),
      call(ctx, "__hasOwnProperty"),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          load(0),
          call(ctx, "__closure_bag_lookup"),
          ...prototypeKey(),
          load(0),
          call(ctx, "__reflect_get_receiver"),
          { op: "return" },
        ],
        else: [],
      },
      call(ctx, NATIVE_GENERATOR_DEFAULT_PROTO),
      call(ctx, "__object_create"),
      { op: "local.set", index: 1 },
      load(0),
      ...prototypeKey(),
      load(1),
      { op: "f64.const", value: 1 },
      call(ctx, "__defineProperty_value"),
      { op: "drop" },
      load(1),
    ],
  );
  definedFuncAt(ctx, factoryProto)!.locals = [{ name: "prototype", type: ER }];
  // Initialize at allocation, capturing the current factory property exactly
  // once. Public property reads retain primitive overrides; only instance
  // creation substitutes %GeneratorPrototype% for a non-object property.
  const isObject = externIsObjectInstrs(ctx, 1);
  if (!isObject) throw new Error("Missing generator prototype object classifier");
  reserve(
    ctx,
    NATIVE_GENERATOR_INIT_PROTO,
    [ER, ER],
    [ER],
    [
      load(0),
      call(ctx, NATIVE_GENERATOR_PROTO_VIEW),
      ...isObject,
      {
        op: "if",
        blockType: { kind: "val", type: ER },
        then: [load(1)],
        else: [call(ctx, NATIVE_GENERATOR_DEFAULT_PROTO)],
      },
      call(ctx, "__object_setPrototypeOf"),
      { op: "drop" },
      load(0),
    ],
  );
}

/** Native builtin closure ABI: closure self, JavaScript receiver, argument. */
export function emitNativeGeneratorProtocolMethodBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | null {
  if (!(ctx.standalone || ctx.wasi)) return null;
  if (member === "@@1") {
    fctx.body.push(load(1));
    return ER;
  }
  if (member !== "next" && member !== "return" && member !== "throw") return null;
  const dispatch = reserveOpaqueNativeGeneratorDispatch(ctx, fctx, member);
  fctx.body.push(load(1), { op: "any.convert_extern" });
  if (member !== "throw") fctx.body.push({ op: "i64.const", value: UNDEF_F64_BITS }, { op: "f64.reinterpret_i64" });
  fctx.body.push(load(2), { op: "call", funcIdx: dispatch.funcIdx });
  return ER;
}

/** FINAL type ladder; only public bag entries are exposed, never frame fields. */
export function fillNativeGeneratorProtocol(ctx: CodegenContext): void {
  if (!prepared.has(ctx)) return;
  const funcIdx = ctx.funcMap.get(NATIVE_GENERATOR_PROTOCOL_GET)!;
  const fn = definedFuncAt(ctx, funcIdx)!;
  const typeIdxs = [...new Set([...ctx.nativeGenerators.values()].map((info) => info.stateTypeIdx))];
  const body: Instr[] = [];
  for (const typeIdx of typeIdxs) {
    body.push(load(0), { op: "any.convert_extern" }, { op: "ref.test", typeIdx });
    if (body.length > 3) body.push({ op: "i32.or" });
  }
  if (!typeIdxs.length) {
    fn.body = [{ op: "i32.const", value: 0 }, { op: "ref.null.extern" }];
    return;
  }
  body.push(
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "ref.null.extern" }, { op: "return" }],
      else: [],
    },
  );
  // The canonical bag is a prototype view, not a public object. OrdinaryGet
  // walks own entries and the full chain with the source generator receiver.
  body.push(
    { op: "i32.const", value: 1 },
    load(0),
    call(ctx, NATIVE_GENERATOR_PROTO_VIEW),
    load(1),
    load(0),
    call(ctx, "__reflect_get_receiver"),
  );

  fn.body = body;
  const viewBody: Instr[] = [];
  for (const typeIdx of typeIdxs) {
    viewBody.push(
      load(0),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [load(0), call(ctx, PROTO_FROM_FUNCTION), { op: "return" }],
        else: [],
      },
    );
  }
  viewBody.push(load(0));
  definedFuncAt(ctx, ctx.funcMap.get(NATIVE_GENERATOR_PROTO_VIEW)!)!.body = viewBody;
}

/** Canonical property-get prefix. Requires the caller's ER scratch local. */
export function nativeGeneratorProtocolReadPrefix(ctx: CodegenContext, valueLocal: number): Instr[] {
  const funcIdx = ctx.funcMap.get(NATIVE_GENERATOR_PROTOCOL_GET);
  if (funcIdx === undefined) return [];
  return [
    load(0),
    load(1),
    { op: "call", funcIdx },
    { op: "local.set", index: valueLocal },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [load(valueLocal), { op: "return" }],
      else: [],
    },
  ];
}

/** Delegation getter bridge. The receiver is parameter zero of that getter. */
export function buildNativeGeneratorProtocolGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  key: NativeGeneratorProtocolKey,
  fallback: Instr[],
): Instr[] {
  if (!prepared.has(ctx)) return fallback;
  const valueLocal = allocLocal(fctx, "__native_protocol_value", ER);
  return [
    load(0),
    ...keyInstrs(ctx, key),
    call(ctx, NATIVE_GENERATOR_PROTOCOL_GET),
    { op: "local.set", index: valueLocal },
    {
      op: "if",
      blockType: { kind: "val", type: ER },
      then: [load(valueLocal)],
      else: fallback,
    },
  ];
}
