// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// standalone-link-boundary.ts — (#5383 S2d) the wasm→wasm twin of the #5225
// cross-module struct-owner registry.
//
// THE DEFECT THIS EXISTS FOR (measured 2026-09-08, `.tmp/s2d/probe4`):
// a value minted by a linked PROVIDER and read by the CONSUMER answers nothing
// under `--target standalone` — `Object.keys(NS).length` is 0 where the same
// read inside the provider answers 3, and `NS.a` is `undefined`.
//
// Root cause: standalone puts NO self-describing property bag on a value. Every
// dynamic read is a module-local `ref.test` ladder over the struct types THAT
// module declared, filled at finalize (`__extern_get`, `__object_keys`). A
// provider-minted struct is in the provider's ladder and in no other, so the
// consumer's ladder misses on every arm and falls through to its terminal.
// (Verified from the other side: a module's own generic terminals DO decode its
// own static-shape structs — `.tmp/s2d/probe11`, keys 3 / get 1 / call 1.)
//
// The JS-host lane never sees this because the linker replaces the boundary
// value with a host mirror bound to the provider's `__struct_field_names` /
// `__sget_*` exports, and #5225's `_crossModuleStructs` registry re-points a
// read at the module that can decode it. Neither exists without a JS host.
//
// The fix mirrors that design in pure wasm: the provider EXPORTS its generic
// terminals under stable names, and the consumer calls them when its own ladder
// has already missed. This is deliberately a MISS-PATH mechanism — a receiver
// the consumer can decode never reaches the peer call, so the single-module
// lane and every local read stay byte-identical.
//
// Scope: `--target standalone` only, and only between modules of one linked
// project. The JS-host lane keeps the host mirror and is untouched (byte A/B in
// #5383's S2d notes).

import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { reserveLinkedExnTag } from "./registry/physical-imports.js";
import { ensureReflectIsConstructor } from "./reflect-construct-native.js";
import { CLASS_CONSTRUCT_DISPATCH } from "./standalone-class-construct.js"; // (#5383 S2g)
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { definedFuncAt } from "./func-space.js";
import { LINK_BOUNDARY_TO_STRING_TAG } from "./link-boundary-names.js";
import { STANDALONE_CLASS_INSTANCE_PROTO } from "./standalone-class-instance-proto.js"; // (#6617)
import type { CodegenContext } from "./context/types.js";
import type { Instr, ValType } from "../ir/types.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** `registerNative` as `ensureObjectRuntime` defines it (structural, not imported). */
type RegisterNative = (
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
) => number;

/** Provider-exported generic terminals. The name is the wasm→wasm ABI. */
export const LINK_BOUNDARY_EXPORTS = Object.freeze({
  memberGet: "__js2wasm_link_member_get",
  objectKeys: "__js2wasm_link_object_keys",
  apply: "__js2wasm_link_apply",
  // (#5383 S2f R12) The two terminals that make a provider-owned CLASS usable.
  // Deliberately the same SHAPE as the JS-host lane's
  // `__boundary_object_callable_kind` / `__boundary_object_construct`, because
  // the consumer-side arms that read them already exist and are already correct
  // (`native-construct.ts`, `typeof-natives-finalize.ts`) — the standalone lane
  // was simply never given anything to put in them.
  callableKind: "__js2wasm_link_callable_kind",
  construct: "__js2wasm_link_construct",
  // (#5383 S2h) `recv.name(args)` where the RECEIVER is provider-owned.
  //
  // Not derivable from `memberGet` + `apply`, which is why it is its own
  // terminal: the read half now crosses correctly (S2h part a), but the value
  // it hands back is the provider's method-closure singleton, whose trampoline
  // resolves `this` from the PROVIDER's `__current_this` global. The consumer
  // has its own copy of that global, so invoking the closure from the consumer
  // side binds nothing — measured: `f = d.sum; f.call(d, 1)` answered **null**,
  // and `d.sum(1)` threw "is not a function". Handing the whole call to the
  // owning module keeps resolution AND receiver binding on the side that owns
  // both.
  methodCall: "__js2wasm_link_method_call",
  // (#6617) `Object.getPrototypeOf(<instance the provider minted>)`.
  //
  // Not derivable from `memberGet`: an instance's [[Prototype]] is not a
  // property of it, and the consumer cannot ask for one — the link is a
  // per-class `__tag` fact over a WasmGC struct the consumer has no type for,
  // exactly the reason `__class_object_of` (#5354) exists on the host lane.
  // Answering it here is what joins the two halves of the object-identity
  // graph across the seam: the value this returns IS the object
  // `NS.C.prototype` already answers (one module global, reached by reference),
  // so `getPrototypeOf(new NS.C()) === NS.C.prototype` holds by `ref.eq`.
  getPrototypeOf: "__js2wasm_link_get_prototype_of",
  // (#5406) `Object.prototype.toString` over a value the consumer cannot
  // decode. The name lives in the leaf `link-boundary-names.ts` because the
  // CONSUMER side of this terminal is emitted by `object-proto-tostring.ts`,
  // which this module may not import (it would close a cycle through
  // `object-runtime`).
  toStringTag: LINK_BOUNDARY_TO_STRING_TAG,
  // (#6624) `Object.isExtensible(<provider-owned value>)` — a class OBJECT
  // (not an instance) the provider exports is a closed struct in the
  // consumer's own carrier ladder (`__is_vec_prop_carrier` /
  // `__is_closure_prop_carrier` / … in `object-integrity-carrier.ts`) only
  // when the consumer happens to have registered a structurally identical
  // type of its own; a genuinely foreign class-object shape (the common case
  // across a real link) matches none of them, so the consumer's own
  // `__object_isExtensible` fell to its non-object terminal (`false`) for a
  // value that IS extensible. Same "ask the owner" shape as `getPrototypeOf`.
  isExtensible: "__js2wasm_link_is_extensible",
  // (#6625) `Object.getPrototypeOf(<provider-owned CLASS VALUE>)` — a BOOLEAN
  // "ask the owner", not a value. Unlike `getPrototypeOf`/`isExtensible`
  // above, the correct answer (`Function.prototype`) must be produced by the
  // CONSUMER's own read of it: a value handed back from the provider would
  // carry the PROVIDER's own `%Function.prototype%` singleton, a DIFFERENT
  // externref from the consumer's, so `=== Function.prototype` in the
  // consumer's own test would fail by identity even though both sides are
  // "correct" in isolation (the same reasoning #6609/S22 used for an ordinary
  // function value, reusing `__is_callable` rather than asking the provider
  // for the value). This terminal only tells the consumer WHICH answer to
  // produce locally.
  isClassObject: "__js2wasm_link_is_class_object",
} as const);

/** The internal terminal each boundary name wraps, and its signature. */
const TERMINALS: ReadonlyArray<{ export: string; internal: string; params: ValType[]; results?: ValType[] }> = [
  { export: LINK_BOUNDARY_EXPORTS.memberGet, internal: "__extern_get", params: [EXTERNREF, EXTERNREF] },
  { export: LINK_BOUNDARY_EXPORTS.objectKeys, internal: "__object_keys", params: [EXTERNREF] },
  { export: LINK_BOUNDARY_EXPORTS.apply, internal: "__apply_closure", params: [EXTERNREF, EXTERNREF, EXTERNREF] },
  {
    export: LINK_BOUNDARY_EXPORTS.callableKind,
    internal: LINK_BOUNDARY_EXPORTS.callableKind,
    params: [EXTERNREF],
    results: [I32],
  },
  {
    export: LINK_BOUNDARY_EXPORTS.construct,
    internal: LINK_BOUNDARY_EXPORTS.construct,
    params: [EXTERNREF, EXTERNREF, EXTERNREF],
  },
  {
    export: LINK_BOUNDARY_EXPORTS.methodCall,
    internal: LINK_BOUNDARY_EXPORTS.methodCall,
    params: [EXTERNREF, EXTERNREF, EXTERNREF],
  },
  {
    export: LINK_BOUNDARY_EXPORTS.toStringTag,
    internal: LINK_BOUNDARY_EXPORTS.toStringTag,
    params: [EXTERNREF],
  },
  {
    export: LINK_BOUNDARY_EXPORTS.getPrototypeOf,
    internal: LINK_BOUNDARY_EXPORTS.getPrototypeOf,
    params: [EXTERNREF],
  },
  {
    export: LINK_BOUNDARY_EXPORTS.isExtensible,
    internal: LINK_BOUNDARY_EXPORTS.isExtensible,
    params: [EXTERNREF],
    results: [I32],
  },
  {
    export: LINK_BOUNDARY_EXPORTS.isClassObject,
    internal: LINK_BOUNDARY_EXPORTS.isClassObject,
    params: [EXTERNREF],
    results: [I32],
  },
];

/** The heap type index `ref.test`/`ref.cast` use for the internal `eq` type —
 * the SAME magic constant `typeof-natives-finalize.ts`'s `classObjectIdentityArms`
 * uses, duplicated here rather than imported to avoid a cross-module cycle
 * through `object-runtime.ts` (this module is itself an input to that one). */
const EQ_HEAP_TYPE = -19;

/** A module compiled as a linked provider whose consumer is wasm, not JS. */
function isWasmConsumedStandaloneProvider(ctx: CodegenContext): boolean {
  return ctx.standalone && ctx.exportsConsumedByWasm === true;
}

/** The provider namespaces this module may route a missed read to. */
function peerNamespaces(ctx: CodegenContext): string[] {
  if (!ctx.standalone || isWasmConsumedStandaloneProvider(ctx)) return [];
  return [...ctx.linkedNamespaces].filter((name) => name.startsWith("js2wasm:npm:")).sort();
}

/**
 * Emit the provider-side boundary terminals.
 *
 * NOT raw re-exports of `__extern_get` / `__object_keys`, and the difference is
 * the whole correctness argument: each wrapper normalises "I do not know this
 * value" to `ref.null.extern`, so the consumer can tell a real answer from a
 * miss and keep its own local answer otherwise. Without that the consumer would
 * have to trust the peer's `undefined` singleton (a DIFFERENT module's global —
 * its `x === undefined` identity is not the consumer's) and the peer's empty
 * key vec would out-rank the consumer's own carrier-bag keys.
 *
 * Both normalisations are answer-preserving: a property that is genuinely
 * `undefined` on a foreign object, and an object with genuinely zero own keys,
 * fall back to the consumer's local miss — which answers `undefined` / empty.
 *
 * `__apply_closure` needs no wrapper: calling a closure the peer does not own
 * cannot be confused with a value, and the consumer only reaches it after its
 * own closure test has already failed.
 */
export function emitStandaloneLinkBoundaryTerminals(ctx: CodegenContext, registerNative: RegisterNative): void {
  if (!isWasmConsumedStandaloneProvider(ctx)) return;
  const externGet = ctx.funcMap.get("__extern_get");
  const isUndefined = ctx.funcMap.get("__extern_is_undefined");
  if (externGet !== undefined && isUndefined !== undefined && !ctx.funcMap.has(LINK_BOUNDARY_EXPORTS.memberGet)) {
    registerNative(
      LINK_BOUNDARY_EXPORTS.memberGet,
      [EXTERNREF, EXTERNREF],
      [EXTERNREF],
      [{ name: "v", type: EXTERNREF }],
      [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: externGet },
        { op: "local.tee", index: 2 },
        { op: "call", funcIdx: isUndefined },
        {
          op: "if",
          blockType: { kind: "val", type: EXTERNREF },
          then: [{ op: "ref.null.extern" }],
          else: [{ op: "local.get", index: 2 }],
        },
      ],
    );
  }
  // (#5383 S2h) `__js2wasm_link_method_call` is a WRAPPER, not a re-export of
  // `__extern_method_call`, and the difference is the whole reason the terminal
  // works. That native gates its resolve-then-apply on `ref.test $Object`; a
  // provider's own CLASS INSTANCE is a closed `$ClassName` struct, so it takes
  // the non-`$Object` else arm and the provider throws "is not a function" —
  // measured, and it is the same answer the provider gives for a method call on
  // its own instance through a dynamic receiver it has no `__call_m_<name>`
  // dispatcher for (those are reserved per NAME, at a CALL SITE, and a provider
  // has no call site for a method only its consumer calls).
  //
  // Resolve-then-apply directly instead. Both halves are already correct on
  // this side: `__extern_get` reaches the prototype since S2h part (a), and
  // `__apply_closure` binds `this` through the PROVIDER's `__current_this` —
  // the global the consumer cannot write, which is why the call has to happen
  // here rather than on a closure shipped across.
  //
  // A null/undefined resolution answers `ref.null.extern` = "not mine", so the
  // consumer keeps its own local answer, exactly like the `memberGet` wrapper.
  const applyClosure = ctx.funcMap.get("__apply_closure");
  if (
    externGet !== undefined &&
    isUndefined !== undefined &&
    applyClosure !== undefined &&
    !ctx.funcMap.has(LINK_BOUNDARY_EXPORTS.methodCall)
  ) {
    registerNative(
      LINK_BOUNDARY_EXPORTS.methodCall,
      [EXTERNREF, EXTERNREF, EXTERNREF],
      [EXTERNREF],
      [{ name: "m", type: EXTERNREF }],
      [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: externGet },
        { op: "local.tee", index: 3 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "ref.null.extern" }, { op: "return" }],
        },
        { op: "local.get", index: 3 },
        { op: "call", funcIdx: isUndefined },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "ref.null.extern" }, { op: "return" }],
        },
        { op: "local.get", index: 3 },
        { op: "local.get", index: 0 },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: applyClosure },
      ],
    );
  }

  const objectKeys = ctx.funcMap.get("__object_keys");
  const externLength = ctx.funcMap.get("__extern_length");
  if (objectKeys !== undefined && externLength !== undefined && !ctx.funcMap.has(LINK_BOUNDARY_EXPORTS.objectKeys)) {
    registerNative(
      LINK_BOUNDARY_EXPORTS.objectKeys,
      [EXTERNREF],
      [EXTERNREF],
      [{ name: "v", type: EXTERNREF }],
      [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: objectKeys },
        { op: "local.tee", index: 1 },
        { op: "call", funcIdx: externLength },
        { op: "f64.const", value: 0 },
        { op: "f64.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: EXTERNREF },
          then: [{ op: "ref.null.extern" }],
          else: [{ op: "local.get", index: 1 }],
        },
      ],
    );
  }

  // (#5383 S2f R12 / #6420) `callable_kind` and `construct` are RESERVED here (the
  // index space is frozen after `ensureObjectRuntime`, #1984) and FILLED in
  // `publishStandaloneLinkBoundaryExports`, because both read helpers that do
  // not have bodies yet: `__is_callable` is filled by the callable finalize,
  // `__reflect_is_constructor` by its own fill, and `__apply_closure` by
  // `fillApplyClosure`. Reserving with a refusal body (`0` / null) means a
  // provider whose helpers never materialise degrades to today's answer rather
  // than to a broken call.
  ensureLateImport(ctx, "__is_callable", [EXTERNREF], [I32]);
  ensureReflectIsConstructor(ctx);
  if (!ctx.funcMap.has(LINK_BOUNDARY_EXPORTS.callableKind)) {
    registerNative(LINK_BOUNDARY_EXPORTS.callableKind, [EXTERNREF], [I32], [], [{ op: "i32.const", value: 0 }]);
  }
  // (#5406) Reserved with the miss body ("not mine") and filled at finalize by
  // `fillLinkBoundaryToStringTagTerminal` — the §20.1.3.6 classifier it wraps
  // composes `__typeof_*` and the native-proto brand table, neither of which is
  // complete this early. A provider whose fill declines keeps this body, so the
  // consumer simply keeps its own (refusing) answer.
  if (!ctx.funcMap.has(LINK_BOUNDARY_EXPORTS.toStringTag)) {
    registerNative(LINK_BOUNDARY_EXPORTS.toStringTag, [EXTERNREF], [EXTERNREF], [], [{ op: "ref.null.extern" }]);
  }
  // (#6617) Reserved with the miss body ("not mine") for the same reason: the
  // dispatcher it wraps (`__std_class_instance_proto`) is minted at finalize,
  // over the class set and the prototype builders as they end up. A provider
  // with no compiled class keeps this body and the consumer keeps its own
  // (null) answer — which is today's behaviour, unchanged.
  if (!ctx.funcMap.has(LINK_BOUNDARY_EXPORTS.getPrototypeOf)) {
    registerNative(LINK_BOUNDARY_EXPORTS.getPrototypeOf, [EXTERNREF], [EXTERNREF], [], [{ op: "ref.null.extern" }]);
  }
  // (#6624) `__object_isExtensible` (the general, non-`_obj` variant) already
  // has a body by this point — `buildObjectDescriptorHelpers` runs earlier in
  // `ensureObjectRuntime` — so this is a direct forward, not a reserve+fill
  // pair like `callableKind`/`getPrototypeOf` above (which depend on helpers
  // that only materialise at finalize). A module whose own `__object_isExtensible`
  // is absent (host mode; never happens for a standalone provider, since
  // `buildObjectIntegrityPredicates` is unconditional there) keeps the `0`
  // refusal, matching the consumer's own pre-fix answer exactly.
  if (!ctx.funcMap.has(LINK_BOUNDARY_EXPORTS.isExtensible)) {
    const isExtensibleIdx = ctx.funcMap.get("__object_isExtensible");
    registerNative(
      LINK_BOUNDARY_EXPORTS.isExtensible,
      [EXTERNREF],
      [I32],
      [],
      isExtensibleIdx === undefined
        ? [{ op: "i32.const", value: 0 }]
        : [
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: isExtensibleIdx },
          ],
    );
  }
  // (#6625) Reserved with the refusal body ("not one of mine"). Filled at
  // finalize from `ctx.classObjectGlobals` — the SAME per-class singleton
  // registry `STANDALONE_CLASS_INSTANCE_PROTO`'s own class-object arm reads —
  // which is only complete once every class declaration in this module has
  // been compiled.
  if (!ctx.funcMap.has(LINK_BOUNDARY_EXPORTS.isClassObject)) {
    registerNative(LINK_BOUNDARY_EXPORTS.isClassObject, [EXTERNREF], [I32], [], [{ op: "i32.const", value: 0 }]);
  }
  if (!ctx.funcMap.has(LINK_BOUNDARY_EXPORTS.construct)) {
    registerNative(
      LINK_BOUNDARY_EXPORTS.construct,
      [EXTERNREF, EXTERNREF, EXTERNREF],
      [EXTERNREF],
      [
        { name: "self", type: EXTERNREF },
        { name: "result", type: EXTERNREF },
      ],
      [{ op: "ref.null.extern" }],
    );
  }
}

/**
 * (#5383 S2f R12) Fill the two late terminals. Runs at finalize, from
 * `publishStandaloneLinkBoundaryExports`, so every helper body it composes is
 * in place. Each fill is independently guarded: a missing helper leaves the
 * refusal body, which is exactly the pre-R12 answer.
 */
function fillStandaloneLinkBoundaryLateTerminals(ctx: CodegenContext): void {
  const isCallableIdx = ctx.funcMap.get("__is_callable");
  const isConstructorIdx = ctx.funcMap.get("__reflect_is_constructor");
  const kindIdx = ctx.funcMap.get(LINK_BOUNDARY_EXPORTS.callableKind);
  const kindFn = kindIdx === undefined ? undefined : definedFuncAt(ctx, kindIdx);
  if (kindFn && isCallableIdx !== undefined && isConstructorIdx !== undefined) {
    // bit 0 = [[Call]], bit 1 = [[Construct]] — the same encoding the host
    // lane's `__boundary_object_callable_kind` uses. Critically, bit 0 is
    // NOT `typeof === "function"`: a class has [[Construct]] but no [[Call]].
    kindFn.body = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isCallableIdx },
      { op: "i32.const", value: 1 },
      { op: "i32.and" },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isConstructorIdx },
      { op: "i32.const", value: 1 },
      { op: "i32.and" },
      { op: "i32.const", value: 1 },
      { op: "i32.shl" },
      { op: "i32.or" },
    ];
  }

  // (#6625) The class-object identity ladder: ref.eq against every one of
  // THIS module's own class-object singletons. Deliberately NOT a `ref.test`
  // over the struct type — a class object and its instances share one struct
  // type AND `__tag` (#3976), so only identity tells them apart, exactly the
  // reasoning `classObjectIdentityArms` (`typeof-natives-finalize.ts`) and the
  // class-object arm in `standalone-class-instance-proto.ts` already use. A
  // singleton that has not been materialised yet holds a null global, which
  // `ref.eq` against a non-null receiver is simply false — the arm degrades to
  // "not one of mine" rather than a wrong match.
  //
  // BASE classes only (no `extends`): a derived class's [[Prototype]] is its
  // PARENT's class-object value (§15.7.14 step 6), not %Function.prototype% —
  // matching this predicate for one would make the CONSUMER answer
  // %Function.prototype%, a NEW wrong answer (worse than today's `null`, which
  // at least keeps `gPO(D) !== Function.prototype` true by accident). The
  // parent-aware answer is an unreduced residual (plan/issues/6625-*.md).
  const isClassObjectIdx = ctx.funcMap.get(LINK_BOUNDARY_EXPORTS.isClassObject);
  const isClassObjectFn = isClassObjectIdx === undefined ? undefined : definedFuncAt(ctx, isClassObjectIdx);
  const classObjectGlobalIdxs = [...ctx.classObjectGlobals.entries()]
    .filter(([className]) => !ctx.classParentMap.has(className))
    .map(([, globalIdx]) => globalIdx)
    .sort((a, b) => a - b);
  if (isClassObjectFn && classObjectGlobalIdxs.length > 0) {
    const anyLocalIdx = 1 + isClassObjectFn.locals.length;
    isClassObjectFn.locals.push({ name: "__any", type: { kind: "anyref" } });
    const arms: Instr[] = [];
    for (const globalIdx of classObjectGlobalIdxs) {
      arms.push(
        { op: "global.get", index: globalIdx },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: anyLocalIdx },
            { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
            { op: "global.get", index: globalIdx },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
            { op: "ref.eq" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
          ],
        },
      );
    }
    isClassObjectFn.body = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: anyLocalIdx },
      { op: "local.get", index: anyLocalIdx },
      { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
      { op: "if", blockType: { kind: "empty" }, then: arms },
      { op: "i32.const", value: 0 },
    ];
  }

  // (#6617) The prototype terminal is a thin forward to the module's own
  // class-instance dispatcher, and deliberately NOT to `__getPrototypeOf`.
  // The consumer reaches this only after its own answer was null, so anything
  // this returns REPLACES a null — and `__getPrototypeOf` would then answer the
  // PROVIDER's `%Object.prototype%` for any provider-owned plain object, a
  // foreign intrinsic the consumer can never name and never compare equal to
  // its own. The dispatcher answers for exactly one shape, a tagged instance of
  // one of this module's classes, which is the shape whose prototype the
  // consumer genuinely cannot reach.
  const prototypeTerminalIdx = ctx.funcMap.get(LINK_BOUNDARY_EXPORTS.getPrototypeOf);
  const prototypeTerminalFn = prototypeTerminalIdx === undefined ? undefined : definedFuncAt(ctx, prototypeTerminalIdx);
  const classInstanceProtoIdx = ctx.funcMap.get(STANDALONE_CLASS_INSTANCE_PROTO);
  if (prototypeTerminalFn && classInstanceProtoIdx !== undefined) {
    prototypeTerminalFn.body = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: classInstanceProtoIdx },
    ];
  }

  const constructIdx = ctx.funcMap.get(LINK_BOUNDARY_EXPORTS.construct);
  const constructFn = constructIdx === undefined ? undefined : definedFuncAt(ctx, constructIdx);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const objectCreateIdx = ctx.funcMap.get("__object_create");
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  if (
    constructFn &&
    externGetIdx !== undefined &&
    objectCreateIdx !== undefined &&
    applyClosureIdx !== undefined &&
    typeofObjectIdx !== undefined
  ) {
    // The ORDINARY §10.2.2 construct tail, byte-for-byte the same shape the
    // module-local `__native_construct_driver_N` uses: proto = target.prototype,
    // self = Object.create(proto), r = target.[[Call]](self, args), and the
    // §10.2.2 step 13 "return r when it is an Object, else self". Written here
    // rather than reusing a driver because the drivers are per-ARITY and only
    // the arities the provider's OWN code constructs are reserved — a consumer
    // may call with any arity, and the args already arrive as a vec.
    // Param 2 (newTarget) is accepted for ABI parity with the host lane's
    // `__boundary_object_construct` and is deliberately unused: null there
    // means "use the constructor itself", which is what this tail does.
    // (#5383 S2g) A CLASS the provider owns is constructed by its own
    // trampoline, keyed by the class-object singleton's identity. The ordinary
    // tail below cannot do it: a class value is a `$ClassName` struct, so
    // `__apply_closure` misses and the consumer receives the bare
    // `Object.create(proto)` — an instance with none of its own fields. A null
    // answer means "not one of my classes" and falls through unchanged.
    const classConstructIdx = ctx.funcMap.get(CLASS_CONSTRUCT_DISPATCH);
    const externLengthIdx = ctx.funcMap.get("__extern_length");
    const classArm: Instr[] =
      classConstructIdx === undefined || externLengthIdx === undefined
        ? []
        : [
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: externLengthIdx },
            { op: "i32.trunc_sat_f64_s" },
            { op: "call", funcIdx: classConstructIdx },
            { op: "local.tee", index: 4 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 4 }, { op: "return" }],
            },
          ];
    constructFn.body = [
      ...classArm,
      { op: "local.get", index: 0 },
      ...stringConstantExternrefInstrs(ctx, "prototype"),
      { op: "call", funcIdx: externGetIdx },
      { op: "call", funcIdx: objectCreateIdx },
      { op: "local.tee", index: 3 },
      { op: "local.get", index: 0 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: applyClosureIdx },
      { op: "local.tee", index: 4 },
      { op: "call", funcIdx: typeofObjectIdx },
      {
        op: "if",
        blockType: { kind: "val", type: EXTERNREF },
        then: [{ op: "local.get", index: 4 }],
        else: [{ op: "local.get", index: 3 }],
      },
      { op: "local.set", index: 3 },
      { op: "drop" },
      { op: "local.get", index: 3 },
    ];
  }
}

/**
 * Publish the generic terminals of a standalone provider.
 *
 * Called at finalize, when every terminal has been filled. A terminal the
 * module never needed is simply not published: the consumer's import is added
 * only for a namespace it links, and a provider that has no object runtime at
 * all cannot own a value the consumer could ask about.
 */
export function publishStandaloneLinkBoundaryExports(ctx: CodegenContext): void {
  if (!isWasmConsumedStandaloneProvider(ctx)) return;
  fillStandaloneLinkBoundaryLateTerminals(ctx);
  const published = new Set(ctx.mod.exports.map((entry) => entry.name));
  for (const terminal of TERMINALS) {
    if (published.has(terminal.export)) continue;
    // The wrapper (when one was emitted) is registered UNDER the export name;
    // `__apply_closure` is published directly.
    const index = ctx.funcMap.get(terminal.export) ?? ctx.funcMap.get(terminal.internal);
    if (index === undefined) continue;
    ctx.mod.exports.push({ name: terminal.export, desc: { kind: "func", index } });
  }
}

/**
 * The imported peer terminal, or undefined when this module has no standalone
 * provider to ask.
 *
 * ONE peer, deliberately: the export name IS the ABI, and `ensureLateImport`
 * keys `funcMap` by that name, so a second namespace publishing the same name
 * cannot be told apart without a per-namespace alias. #5383's graph is one
 * provider; a multi-provider standalone graph keeps today's behaviour for the
 * namespaces after the first (nothing decodes, exactly as before this module),
 * rather than silently asking the wrong module.
 *
 * MUST be called before the index-space freeze (#1984) — `ensureObjectRuntime`
 * is the caller, alongside the host lane's `__boundary_object_*` twins.
 */
export function standaloneLinkBoundaryPeerIndices(ctx: CodegenContext): {
  memberGet?: number;
  objectKeys?: number;
  methodCall?: number;
  getPrototypeOf?: number;
  isExtensible?: number;
} {
  const namespace = peerNamespaces(ctx)[0];
  if (namespace === undefined) return {};
  // (#5383 S2m) Take the peer's exception TAG in the same pre-freeze window.
  // `ensureExnTag` is lazy — it runs at the first `throw`/`try`, which may be
  // after the index space is frozen (#1984), and a tag import cannot be added
  // then. Reserving here makes the graph share one tag for every module that
  // links a provider, which is what lets a provider throw be CAUGHT by the
  // consumer rather than escape as a raw `WebAssembly.Exception`.
  reserveLinkedExnTag(ctx);
  // Register BOTH, then flush, then read the indices back. Each late import
  // SHIFTS the function index space, so an index captured from the first
  // `ensureLateImport` return names a different function once the second lands
  // (measured: the consumer called the 3-parameter apply terminal with 2
  // arguments and the module failed to validate). This is the same
  // register-all-then-flush-then-look-up discipline the `__boundary_object_*`
  // block above follows, and for the same reason.
  for (const terminal of TERMINALS) {
    ensureLateImport(ctx, terminal.export, [...terminal.params], [...(terminal.results ?? [EXTERNREF])], namespace);
  }
  flushLateImportShifts(ctx, null);
  return {
    memberGet: ctx.funcMap.get(LINK_BOUNDARY_EXPORTS.memberGet),
    objectKeys: ctx.funcMap.get(LINK_BOUNDARY_EXPORTS.objectKeys),
    methodCall: ctx.funcMap.get(LINK_BOUNDARY_EXPORTS.methodCall),
    getPrototypeOf: ctx.funcMap.get(LINK_BOUNDARY_EXPORTS.getPrototypeOf),
    isExtensible: ctx.funcMap.get(LINK_BOUNDARY_EXPORTS.isExtensible),
  };
}

/**
 * (#5383 S2f R12) The imported PEER terminal `key`, or undefined when this
 * module is not a consumer of a standalone provider.
 *
 * The provider registers the very same names in its own `funcMap` (that is how
 * they get exported), so a bare `funcMap.get` would make a provider route its
 * own `typeof` / `new` through its own boundary terminal — infinite recursion.
 * The `peerNamespaces` guard is what keeps this a CONSUMER-only lookup, and it
 * is the reason this is a function rather than a lookup at the call sites.
 */
export function standaloneLinkBoundaryPeerIndex(
  ctx: CodegenContext,
  key: "apply" | "callableKind" | "construct" | "isClassObject",
): number | undefined {
  if (peerNamespaces(ctx).length === 0) return undefined;
  return ctx.funcMap.get(LINK_BOUNDARY_EXPORTS[key]);
}
