// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Host-free Reflect classifiers and native-target MOP fills. */
import type { Instr } from "../ir/types.js";
import { buildBuiltinConstructorTestArm } from "./builtin-callable-brand.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { protoIndexOwnViewSubstituteInstrs } from "./proto-index-store.js";
import { addFuncType } from "./registry/types.js";

const HELPER = "__reflect_is_constructor";
const NATIVE_TARGET_HELPER = "__is_native_reflect_target";

/**
 * Reserve a stable target-classifier slot while a Reflect call is compiled.
 *
 * `$NativeProto` is registered lazily, so its final heap-type index can still
 * be absent when an earlier source/function compiles its generic Reflect
 * guard. The placeholder is filled after every body has compiled; callers can
 * therefore bake one stable function handle without baking source order into
 * the object admission decision.
 */
export function ensureNativeReflectTargetClassifier(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(NATIVE_TARGET_HELPER);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], NATIVE_TARGET_HELPER);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(NATIVE_TARGET_HELPER, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: NATIVE_TARGET_HELPER,
    typeIdx,
    locals: [],
    body: [{ op: "i32.const", value: 0 }],
    exported: false,
  });
  return funcIdx;
}

/** Fill the source-order-independent native-object Reflect target arms. */
export function fillNativeReflectTargetClassifier(ctx: CodegenContext): void {
  const funcIdx = ctx.funcMap.get(NATIVE_TARGET_HELPER);
  if (funcIdx === undefined) return;
  const fn = definedFuncAt(ctx, funcIdx);
  if (!fn) return;
  const candidates: number[] = [];
  if (ctx.nativeProtoTypeIdx !== undefined) candidates.push(ctx.nativeProtoTypeIdx);
  // A first-class TypedArray constructor is the nominal `$__ta_ctor` carrier,
  // not a `$Object` or closure wrapper. Deno's primordials bootstrap reflects
  // over all of these constructor values after putting them in one dynamic
  // list, so the ordinary target guard must admit this sibling carrier too.
  if (ctx.taCtorTypeIdx >= 0) candidates.push(ctx.taCtorTypeIdx);

  const body: Instr[] = [];
  for (const typeIdx of candidates) {
    body.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
    );
  }
  body.push({ op: "i32.const", value: 0 });
  fn.body = body;
}

/**
 * Finalize the own-property MOP for native Reflect targets.
 *
 * `$NativeProto` delegates to its seeded `$Object` companion, preserving the
 * ordinary descriptor/enumeration implementation and its real flags. A
 * `$__ta_ctor` has no companion: synthesize the four own keys required by
 * ECMA-262 and build their descriptors from the same dynamic getter used by
 * normal property reads.
 */
export function fillNativeReflectOwnPropertyMop(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const ownNamesIdx = ctx.funcMap.get("__getOwnPropertyNames");
  const gopdIdx = ctx.funcMap.get("__getOwnPropertyDescriptor");
  const ownNamesFn = ownNamesIdx === undefined ? undefined : definedFuncAt(ctx, ownNamesIdx);
  const gopdFn = gopdIdx === undefined ? undefined : definedFuncAt(ctx, gopdIdx);

  // The helper is filled after the proto store, so this substitution observes
  // the final `$NativeProto` type and forces a seeded companion into existence
  // on the first read. It is identity for every other carrier.
  const ownNamesProtoArm = protoIndexOwnViewSubstituteInstrs(ctx, 0);
  const gopdProtoArm = protoIndexOwnViewSubstituteInstrs(ctx, 0);

  const taCtorTypeIdx = ctx.taCtorTypeIdx >= 0 ? ctx.taCtorTypeIdx : undefined;
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  if (ownNamesFn && taCtorTypeIdx !== undefined && objVecNewIdx !== undefined && objVecPushIdx !== undefined) {
    const vecLocal = 1 + ownNamesFn.locals.length;
    ownNamesFn.locals.push({
      name: "__reflect_tac_keys",
      type: { kind: "externref" },
    });
    const then: Instr[] = [
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: vecLocal },
    ];
    for (const key of ["length", "name", "prototype", "BYTES_PER_ELEMENT"] as const) {
      then.push(
        { op: "local.get", index: vecLocal },
        ...nativeStringLiteralInstrs(ctx, key),
        { op: "extern.convert_any" },
        { op: "call", funcIdx: objVecPushIdx },
      );
    }
    then.push({ op: "local.get", index: vecLocal }, { op: "return" });
    ownNamesFn.body.unshift(
      ...ownNamesProtoArm,
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: taCtorTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then },
    );
  } else if (ownNamesFn && ownNamesProtoArm.length > 0) {
    ownNamesFn.body.unshift(...ownNamesProtoArm);
  }

  const externGetIdx = ctx.funcMap.get("__extern_get");
  const createDescriptorIdx = ctx.funcMap.get("__create_descriptor");
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (
    gopdFn &&
    taCtorTypeIdx !== undefined &&
    externGetIdx !== undefined &&
    createDescriptorIdx !== undefined &&
    flattenIdx !== undefined &&
    equalsIdx !== undefined &&
    ctx.anyStrTypeIdx >= 0 &&
    ctx.nativeStrTypeIdx >= 0
  ) {
    const flatKeyLocal = 2 + gopdFn.locals.length;
    gopdFn.locals.push({
      name: "__reflect_tac_key",
      type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx },
    });
    const descriptorArm = (key: string, flags: number): Instr[] => [
      { op: "local.get", index: flatKeyLocal },
      { op: "ref.as_non_null" },
      ...nativeStringLiteralInstrs(ctx, key),
      { op: "call", funcIdx: equalsIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: externGetIdx },
          { op: "i32.const", value: flags },
          { op: "call", funcIdx: createDescriptorIdx },
          { op: "return" },
        ],
      },
    ];
    const taThen: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index: flatKeyLocal },
          // `name` and `length` are configurable; the other two are not.
          ...descriptorArm("length", 0x04),
          ...descriptorArm("name", 0x04),
          ...descriptorArm("prototype", 0),
          ...descriptorArm("BYTES_PER_ELEMENT", 0),
        ],
      },
    ];
    gopdFn.body.unshift(
      ...gopdProtoArm,
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: taCtorTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: taThen },
    );
  } else if (gopdFn && gopdProtoArm.length > 0) {
    gopdFn.body.unshift(...gopdProtoArm);
  }
}

export function ensureReflectIsConstructor(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(HELPER);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], HELPER);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(HELPER, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: HELPER,
    typeIdx,
    locals: [{ name: "value", type: { kind: "anyref" } }],
    body: [{ op: "i32.const", value: 0 }],
    exported: false,
  });
  return funcIdx;
}

/** Fill after all function values have registered their nominal constructor wrappers. */
export function fillReflectIsConstructor(ctx: CodegenContext): void {
  const funcIdx = ctx.funcMap.get(HELPER);
  const fn = funcIdx === undefined ? undefined : definedFuncAt(ctx, funcIdx);
  if (!fn) return;
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  const candidates = [...ctx.constructibleClosureTypeIdxs].sort((a, b) => a - b);
  if (ctx.taCtorTypeIdx >= 0) candidates.push(ctx.taCtorTypeIdx);
  for (const typeIdx of candidates) {
    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
    );
  }
  // (#4397) A Proxy's [[Construct]] presence is fixed by its target at
  // ProxyCreate time. Read the stored bit instead of accepting every $Proxy;
  // it remains meaningful after revocation (the later operation throws).
  const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
  if (proxyTypeIdx !== undefined) {
    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: proxyTypeIdx },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: 6 },
          { op: "return" },
        ],
      },
    );
  }
  // (#4120) A reified builtin CONSTRUCTOR (`Set`, `Array`, `TypeError`, …) is a
  // brand-marked `$Object` carrier, not a nominal closure wrapper, so no
  // `ref.test` above can see it. Without this arm `Reflect.construct(fn, [], Set)`
  // threw "newTarget is not a constructor" — test262's `isConstructor(Set)`
  // returned false where the spec says true.
  body.push(...buildBuiltinConstructorTestArm(ctx, 1, [{ op: "i32.const", value: 1 }, { op: "return" }]));
  // An actual caller-owned JS constructor remains the same admitted object;
  // the narrow adapter reports only its callable/constructible bits.
  const boundaryKindIdx = ctx.funcMap.get("__boundary_object_callable_kind");
  if (boundaryKindIdx !== undefined) {
    body.push(
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: boundaryKindIdx },
      { op: "i32.const", value: 2 },
      { op: "i32.and" },
      { op: "i32.eqz" },
      { op: "i32.eqz" },
      { op: "return" },
    );
  }
  body.push({ op: "i32.const", value: 0 });
  fn.body = body;
}
