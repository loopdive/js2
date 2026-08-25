// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3265) Standalone Proxy meta-object dispatch subsystem — extracted VERBATIM
 * from `object-runtime.ts` (subtask of #3182, god-file split). Pure relocation:
 * the two top-level functions (`ensureProxyRuntime`, `fillProxyDispatch`) and
 * their 12 `PROXY_CALL_*` driver-name consts moved here unchanged — no logic
 * changes. `object-runtime.ts` re-exports `fillProxyDispatch` (so `index.ts`s
 * `from "./object-runtime.js"` keeps resolving) and imports `ensureProxyRuntime`
 * back (still called from `ensureObjectRuntime`). Byte-identity IDENTICAL across
 * gc/standalone/wasi is the acceptance gate (`scripts/prove-emit-identity.mjs`).
 */
import { inheritedSetAnyDirty } from "./inherited-set-gate.js"; // (#4602) per-key #4504 gate
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import type { ObjectRuntimeTypes } from "./object-runtime.js";
import { reserveApplyClosure } from "./object-runtime.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry } from "./shared.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureReflectIsConstructor } from "./reflect-construct-native.js";

/** (#1100/#1355) Reserved trap-invoke driver names — filled by `fillProxyDispatch`. */
const PROXY_CALL_GET = "__proxy_call_get";
const PROXY_CALL_SET = "__proxy_call_set";
const PROXY_CALL_HAS = "__proxy_call_has";
const PROXY_CALL_DELETE = "__proxy_call_delete"; // (#1355 Slice A)
const PROXY_CALL_GOPD = "__proxy_call_gopd"; // (#1355 Slice B) getOwnPropertyDescriptor
const PROXY_CALL_GPO = "__proxy_call_gpo"; // (#1355 Slice C) getPrototypeOf
const PROXY_CALL_SPO = "__proxy_call_spo"; // (#1355 Slice C) setPrototypeOf
const PROXY_CALL_ISEXT = "__proxy_call_isext"; // (#1355 Slice D) isExtensible
const PROXY_CALL_PREVEXT = "__proxy_call_prevext"; // (#1355 Slice D) preventExtensions
const PROXY_CALL_OWNKEYS = "__proxy_call_ownkeys"; // (#1355 Slice E) ownKeys
const PROXY_CALL_DEFINE = "__proxy_call_define"; // (#1355 Slice F) defineProperty
const PROXY_CALL_APPLY = "__proxy_call_apply"; // (#3031 apply slice) apply — §10.5.12 [[Call]]
const PROXY_CALL_CONSTRUCT = "__proxy_call_construct"; // (#4397) construct — §10.5.13 [[Construct]]

/**
 * (#1100) Standalone Proxy meta-object dispatch runtime — Phase 1.
 *
 * Registers the per-operation dispatch helpers (`__proxy_{get,set,has}_dispatch`),
 * the trap-invoke driver placeholders (`__proxy_call_{get,set,has}`, filled at
 * FINALIZE by `fillProxyDispatch`), the constructor (`__proxy_create`) and the
 * revoker (`__proxy_revoke`), and patches the `ref.test $Proxy` front-guard onto
 * `__extern_get`/`__extern_set`/`__extern_has`.
 *
 * ## Calling convention (the crux)
 * A user trap `(t,k,r) => …` lowers to a GC **closure-wrapper struct** boxed as
 * an externref; its own funcref takes the closure-self as arg0 and carries the
 * captured environment. It therefore CANNOT be `call_ref`-ed with a bare
 * `(target,key,receiver)` signature. So `$ProxyTraps` stores the trap as an
 * externref closure, and the dispatch invokes it through the existing
 * closure-call bridge `__call_fn_method_N(thisVal, closure, arg0…)` — the same
 * path accessors (`fillAccessorDrivers`) and open-`any` method calls
 * (`__apply_closure`) use. Those exports only exist at FINALIZE, so the
 * `__proxy_call_*` drivers are reserved here (placeholder `unreachable`) and
 * filled later (reserve-then-fill, #1719). The trap `this` is the handler
 * (§10.5.x `Call(trap, handler, …)`), threaded as `thisVal`.
 *
 * Each dispatch helper: (1) casts to `$Proxy`, (2) throws a TypeError if the
 * proxy is revoked, (3) reads the relevant trap closure from `$ptraps`,
 * (4) forwards to the ordinary operation on `$ptarget` when the trap is absent,
 * else invokes the trap driver with `(handler, target, key, receiver[, value])`.
 *
 * Phase 1 performs NO §10.5 result-invariant checks (deferred to #1355) — it
 * only enforces the revoked-proxy invariant.
 */
export function ensureProxyRuntime(
  ctx: CodegenContext,
  types: ObjectRuntimeTypes,
  registerNative: (
    name: string,
    paramTypes: ValType[],
    resultTypes: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ) => number,
): void {
  if (ctx.funcMap.has("__proxy_get_dispatch")) return;

  const { objectTypeIdx, proxyTypeIdx, proxyTrapsTypeIdx } = types;
  const externref: ValType = { kind: "externref" };

  // The dispatch helpers depend on `__box_boolean` (has-trap-absent arm boxes
  // the i32 __extern_has result) and `__is_truthy` (the __extern_has front-guard
  // coerces the trap's booleanish externref result back to i32). Both are
  // registered via the union-import registry; ensure they exist before we bake
  // their funcIdx into the proxy bodies (idempotent).
  addUnionImportsViaRegistry(ctx);

  // Revoked-proxy TypeError. Reuse the WASI error constructor + exn tag like
  // the ToPrimitive path does (object-runtime.ts ~1695).
  const revokedMsg = "Cannot perform operation on a proxy that has been revoked";
  addStringConstantGlobal(ctx, revokedMsg);
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError")!;
  const exnTagIdx = ensureExnTag(ctx);
  // FRESH Instr array per use. The same throw block is embedded in three
  // dispatch helpers; a SHARED array would be visited once per containing-body
  // pass AND, when reused twice in one body, double-remapped by the FINALIZE
  // dead-code `remapFuncIdxInBody` walk (no dedup Set) — over-shifting the baked
  // `call __new_TypeError` funcIdx. Build a new array each time.
  const throwRevoked = (): Instr[] => [
    ...stringConstantExternrefInstrs(ctx, revokedMsg),
    { op: "call", funcIdx: typeErrorCtorIdx },
    { op: "throw", tagIdx: exnTagIdx },
  ];

  // (#1355 Slice E) §10.5.11 step 8 / CreateListFromArrayLike (§7.3.18 step 2):
  // the `ownKeys` trap result must be an Object — otherwise a TypeError. FRESH
  // Instr array per use, same rationale as `throwRevoked` (avoids the FINALIZE
  // double-remap of a shared, baked `call __new_TypeError` funcIdx).
  const notListObjectMsg = "Proxy ownKeys trap result must be an object";
  addStringConstantGlobal(ctx, notListObjectMsg);
  const throwNotListObject = (): Instr[] => [
    ...stringConstantExternrefInstrs(ctx, notListObjectMsg),
    { op: "call", funcIdx: typeErrorCtorIdx },
    { op: "throw", tagIdx: exnTagIdx },
  ];

  // Reserve the open-`any` closure-call bridge `__apply_closure` (filled at
  // FINALIZE by `fillApplyClosure`). The proxy trap-invoke drivers
  // (`fillProxyDispatch`) call it to run the user trap closure with the handler
  // bound as `this` — the same bridge `__extern_method_call` uses. Reserving here
  // guarantees the bridge + its `__call_fn_method_N` arms exist when a standalone
  // `new Proxy` is the only closure-call site in the module. (#3031) The apply
  // dispatch below bakes this reserved funcIdx for its trap-absent forward arm
  // (§10.5.12 step 6 `Call(target, thisArgument, argumentsList)`).
  const applyClosureIdx = reserveApplyClosure(ctx);

  // Field indices on the standalone $Proxy struct:
  // ptag(0) ptarget(1) phandler(2) ptraps(3) revoked(4).
  const F_PTARGET = 1;
  const F_PHANDLER = 2;
  const F_PTRAPS = 3;
  const F_REVOKED = 4;
  const F_CONSTRUCTIBLE = 6;
  // Field indices on $ProxyTraps: get(0) set(1) has(2) apply(3) deleteProperty(4).
  const TRAP_GET = 0;
  const TRAP_SET = 1;
  const TRAP_HAS = 2;
  const TRAP_APPLY = 3; // (#3031 apply slice) wired at __proxy_create since #1100; dispatched here
  const TRAP_DELETE = 4; // (#1355 Slice A)
  const TRAP_GOPD = 5; // (#1355 Slice B) getOwnPropertyDescriptor
  const TRAP_GPO = 6; // (#1355 Slice C) getPrototypeOf
  const TRAP_SPO = 7; // (#1355 Slice C) setPrototypeOf
  const TRAP_ISEXT = 8; // (#1355 Slice D) isExtensible
  const TRAP_PREVEXT = 9; // (#1355 Slice D) preventExtensions
  const TRAP_OWNKEYS = 10; // (#1355 Slice E) ownKeys
  const TRAP_DEFINE = 11; // (#1355 Slice F) defineProperty
  const TRAP_CONSTRUCT = 12; // (#4397) construct

  // ── Reserve the trap-invoke driver placeholders (filled by fillProxyDispatch) ──
  //
  // Each driver forwards to the closure-call bridge __call_fn_method_N. The
  // bodies are filled at FINALIZE once those exports exist; here we only reserve
  // the funcIdx (append position) so the dispatch helpers can bake a stable
  // `call <reserved funcIdx>`. Signatures match the spec trap arities:
  //   get(handler, trap, target, key, receiver)        → __call_fn_method_3
  //   set(handler, trap, target, key, value, receiver) → __call_fn_method_4
  //   has(handler, trap, target, key)                  → __call_fn_method_2
  const reserveDriver = (name: string, params: ValType[]): number => {
    const existing = ctx.funcMap.get(name);
    if (existing !== undefined) return existing;
    const typeIdx = addFuncType(ctx, params, [externref]);
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: [],
      // Placeholder; filled by fillProxyDispatch. A bare `unreachable` keeps the
      // stub valid (externref result) if the fill is ever skipped (no closure of
      // the needed arity ⇒ no real trap could have been installed ⇒ unused).
      body: [{ op: "unreachable" }],
      exported: false,
    });
    ctx.funcMap.set(name, funcIdx);
    return funcIdx;
  };
  const callGetIdx = reserveDriver(PROXY_CALL_GET, [externref, externref, externref, externref, externref]);
  const callSetIdx = reserveDriver(PROXY_CALL_SET, [externref, externref, externref, externref, externref, externref]);
  const callHasIdx = reserveDriver(PROXY_CALL_HAS, [externref, externref, externref, externref]);
  // (#1355 Slice A) deleteProperty driver — same arity as has: (handler, trap,
  // target, key) → __call_fn_method_2 (§10.5.10 step 8 `Call(trap, handler, «O, P»)`).
  const callDeleteIdx = reserveDriver(PROXY_CALL_DELETE, [externref, externref, externref, externref]);
  // (#1355 Slice B) getOwnPropertyDescriptor driver — 2-arg like has/delete:
  // (handler, trap, target, key) → __call_fn_method_2 (§10.5.5 step 8
  // `Call(trap, handler, «target, P»)`). Returns the trap's descriptor externref.
  const callGopdIdx = reserveDriver(PROXY_CALL_GOPD, [externref, externref, externref, externref]);
  // (#1355 Slice C) getPrototypeOf driver — 1 trap arg: (handler, trap, target)
  // → __call_fn_method_1 (§10.5.1 step 5 `Call(trap, handler, «target»)`).
  const callGpoIdx = reserveDriver(PROXY_CALL_GPO, [externref, externref, externref]);
  // (#1355 Slice C) setPrototypeOf driver — 2 trap args: (handler, trap, target,
  // proto) → __call_fn_method_2 (§10.5.2 step 7 `Call(trap, handler, «target, V»)`).
  const callSpoIdx = reserveDriver(PROXY_CALL_SPO, [externref, externref, externref, externref]);
  // (#1355 Slice D) isExtensible / preventExtensions drivers — 1 trap arg each:
  // (handler, trap, target) → __call_fn_method_1 (§10.5.3 step 5 / §10.5.4 step 5
  // `Call(trap, handler, «target»)`). Both return a booleanish externref.
  const callIsextIdx = reserveDriver(PROXY_CALL_ISEXT, [externref, externref, externref]);
  const callPrevextIdx = reserveDriver(PROXY_CALL_PREVEXT, [externref, externref, externref]);
  // (#1355 Slice E) ownKeys driver — 1 trap arg: (handler, trap, target) →
  // __call_fn_method_1 (§10.5.11 step 7 `Call(trap, handler, «target»)`). Returns
  // the trap's array-like result externref.
  const callOwnKeysIdx = reserveDriver(PROXY_CALL_OWNKEYS, [externref, externref, externref]);
  // (#1355 Slice F) defineProperty driver — 3 trap args: (handler, trap, target,
  // key, desc) → __call_fn_method_3 (§10.5.6 step 9 `Call(trap, handler, «target,
  // P, descObj»)`). Returns the trap's booleanish result externref.
  const callDefineIdx = reserveDriver(PROXY_CALL_DEFINE, [externref, externref, externref, externref, externref]);
  // (#3031 apply slice) apply driver — 3 trap args: (handler, trap, target,
  // thisArg, argArray) → __call_fn_method_3 (§10.5.12 step 8 `Call(trap,
  // handler, «target, thisArgument, argArray»)`). Returns the trap's result
  // externref unchanged (a [[Call]] result is any language value — no invariant
  // to enforce, unlike [[Construct]]'s must-be-Object).
  const callApplyIdx = reserveDriver(PROXY_CALL_APPLY, [externref, externref, externref, externref, externref]);
  // (#4397) construct driver — 3 trap args: (handler, trap, target,
  // argumentsList, newTarget), matching §10.5.13 step 9.
  const callConstructIdx = reserveDriver(PROXY_CALL_CONSTRUCT, [externref, externref, externref, externref, externref]);
  ctx.proxyDispatchReserved = true;

  // Builds a dispatch helper body. `trapFieldIdx` selects the trap closure;
  // `forwardName` is the ordinary operation to call when the trap is absent;
  // `isSet` switches the 3-arg (set) / 2-arg (get/has) forward + arg shape.
  // params: 0=proxyExtern 1=key 2=receiver(get/has)/value(set)
  // locals: 3=p (ref $Proxy)  4=trap (externref)
  const buildDispatch = (trapFieldIdx: number, forwardName: string, isSet: boolean): Instr[] => {
    const forwardIdx =
      trapFieldIdx === TRAP_GET ? ctx.funcMap.get("__reflect_get_receiver")! : ctx.funcMap.get(forwardName)!;
    // The trap-invoke arm: read handler + target, then call the reserved driver.
    // get:  driver(handler, trap, target, key, receiver=param2)
    // has:  driver(handler, trap, target, key)
    // set:  driver(handler, trap, target, key, value=param2, receiver=proxy)
    const trapArm: Instr[] = [
      // handler
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
      { op: "extern.convert_any" },
      // trap closure
      { op: "local.get", index: 4 },
      // target
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" },
      // key
      { op: "local.get", index: 1 },
    ];
    if (isSet) {
      // value, then receiver (= the proxy itself, param 0)
      trapArm.push({ op: "local.get", index: 2 });
      trapArm.push({ op: "local.get", index: 0 });
      trapArm.push({ op: "call", funcIdx: callSetIdx });
    } else if (trapFieldIdx === TRAP_HAS) {
      trapArm.push({ op: "call", funcIdx: callHasIdx });
    } else if (trapFieldIdx === TRAP_DELETE) {
      // (#1355) deleteProperty: driver(handler, trap, target, key) — same 2-arg
      // shape as has (§10.5.10 step 8 `Call(trap, handler, «O, P»)`).
      trapArm.push({ op: "call", funcIdx: callDeleteIdx });
    } else if (trapFieldIdx === TRAP_GOPD) {
      // (#1355) getOwnPropertyDescriptor: driver(handler, trap, target, key) —
      // 2-arg, no receiver (§10.5.5 step 8 `Call(trap, handler, «target, P»)`).
      trapArm.push({ op: "call", funcIdx: callGopdIdx });
    } else {
      // get: receiver = param 2
      trapArm.push({ op: "local.get", index: 2 });
      trapArm.push({ op: "call", funcIdx: callGetIdx });
    }

    const body: Instr[] = [
      // p = ref.cast $Proxy(any.convert_extern(proxyExtern))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: proxyTypeIdx },
      { op: "local.set", index: 3 },
      // if p.revoked: throw TypeError
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
      { op: "if", blockType: { kind: "empty" }, then: throwRevoked() },
      // trap = p.ptraps==null ? null : p.ptraps.<field>
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: [{ op: "ref.null.extern" }],
        else: [
          { op: "local.get", index: 3 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: trapFieldIdx },
        ],
      },
      { op: "local.set", index: 4 },
      // if trap == null: forward to ordinary op on target
      { op: "local.get", index: 4 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: isSet
          ? [
              // __extern_set(target, key, value) -> (void) ; push undefined
              { op: "local.get", index: 3 },
              { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
              { op: "extern.convert_any" },
              { op: "local.get", index: 1 },
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: forwardIdx },
              // The outer __extern_set proxy guard distinguishes this
              // trap-absent forward from a real set-trap result. In #4504 it
              // must leave the target's result channel untouched, including
              // UNADMITTED; this placeholder is dropped by that guard.
              { op: "ref.null.extern" },
            ]
          : trapFieldIdx === TRAP_HAS || trapFieldIdx === TRAP_DELETE
            ? [
                // has:    __extern_has(target, key)     -> i32
                // delete: __delete_property(target, key) -> i32
                // Both are 2-arg `(target,key) -> i32`; box back to a boolean any
                // so the dispatch result stays uniform externref.
                { op: "local.get", index: 3 },
                { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
                { op: "extern.convert_any" },
                { op: "local.get", index: 1 },
                { op: "call", funcIdx: forwardIdx },
                { op: "call", funcIdx: ctx.funcMap.get("__box_boolean")! },
              ]
            : [
                // [[Get]](target, key, receiver) -> externref. Other
                // two-argument dispatch operations retain their original
                // forward helper.
                { op: "local.get", index: 3 },
                { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
                { op: "extern.convert_any" },
                { op: "local.get", index: 1 },
                ...(trapFieldIdx === TRAP_GET ? ([{ op: "local.get", index: 2 }] satisfies Instr[]) : []),
                { op: "call", funcIdx: forwardIdx },
              ],
        // trap present → invoke it through the closure-call bridge driver.
        else: trapArm,
      },
    ];
    return body;
  };

  // (#1355 Slice C) Prototype-trap dispatch builder. getPrototypeOf /
  // setPrototypeOf don't take a property key, so they don't fit `buildDispatch`'s
  // key-centric shape (param 1 = key). This builds a parallel body for them:
  //   §10.5.1 [[GetPrototypeOf]]: forward __getPrototypeOf(target); trap arm
  //     driver(handler, trap, target).
  //   §10.5.2 [[SetPrototypeOf]]: forward __object_setPrototypeOf(target, proto)
  //     (drop its externref result, push the proxy as a truthy success token);
  //     trap arm driver(handler, trap, target, proto). The front-guard coerces
  //     the trap's booleanish result via __is_truthy.
  // params: 0=proxyExtern, 1=(setPrototypeOf only) proto. locals: 2=p 3=trap.
  // Phase-C scope: NO §10.5.1/2 result-invariant checks (non-extensible target →
  // trap result must equal the target's actual prototype) — deferred to the
  // invariant slice; the trap result is returned as-is.
  const buildProtoDispatch = (trapFieldIdx: number, forwardName: string, isSet: boolean): Instr[] => {
    const forwardIdx = ctx.funcMap.get(forwardName)!;
    const driverIdx = isSet ? callSpoIdx : callGpoIdx;
    const trapArm: Instr[] = [
      // handler
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
      { op: "extern.convert_any" },
      // trap closure
      { op: "local.get", index: 3 },
      // target
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" },
    ];
    if (isSet) {
      trapArm.push({ op: "local.get", index: 1 }); // proto arg
    }
    trapArm.push({ op: "call", funcIdx: driverIdx });

    const forwardArm: Instr[] = isSet
      ? [
          // __object_setPrototypeOf(target, proto) -> externref ; drop, push the
          // proxy itself as a truthy boolean-ish success token (no trap → spec
          // OrdinarySetPrototypeOf, which succeeded since we just performed it).
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
          { op: "extern.convert_any" },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: forwardIdx },
          { op: "drop" },
          { op: "local.get", index: 0 }, // truthy success token (the proxy externref)
        ]
      : [
          // __getPrototypeOf(target) -> externref
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
          { op: "extern.convert_any" },
          { op: "call", funcIdx: forwardIdx },
        ];

    return [
      // p = ref.cast $Proxy(any.convert_extern(proxyExtern))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: proxyTypeIdx },
      { op: "local.set", index: 2 },
      // if p.revoked: throw TypeError
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
      { op: "if", blockType: { kind: "empty" }, then: throwRevoked() },
      // trap = p.ptraps==null ? null : p.ptraps.<field>
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: [{ op: "ref.null.extern" }],
        else: [
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: trapFieldIdx },
        ],
      },
      { op: "local.set", index: 3 },
      // if trap == null: forward to ordinary op on target ; else invoke trap.
      { op: "local.get", index: 3 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: forwardArm,
        else: trapArm,
      },
    ];
  };

  // (#1355 Slice D) isExtensible / preventExtensions dispatch builder. Both take
  // only the target (no key, no value) and return a booleanish result, so they
  // share a shape but differ in the trap-absent forward:
  //   §10.5.3 [[IsExtensible]]:      forward __object_isExtensible(target) -> i32
  //     → box via __box_boolean to keep the dispatch externref-uniform.
  //   §10.5.4 [[PreventExtensions]]: forward __object_preventExtensions(target)
  //     -> externref (returns the object) ; drop it, push the proxy as a truthy
  //     success token (OrdinaryPreventExtensions always succeeds).
  // Both invoke driver(handler, trap, target). params: 0=proxyExtern, 1=unused.
  // locals: 2=p 3=trap. The front-guard coerces the dispatch's booleanish
  // externref back to the native helper's i32/externref return via __is_truthy /
  // direct. Phase-D scope: NO §10.5.3/4 result-invariants (e.g. preventExtensions
  // reporting success while the target stays extensible → TypeError) — deferred.
  const buildExt1Dispatch = (trapFieldIdx: number, forwardName: string, forwardReturnsI32: boolean): Instr[] => {
    const forwardIdx = ctx.funcMap.get(forwardName)!;
    const driverIdx = trapFieldIdx === TRAP_ISEXT ? callIsextIdx : callPrevextIdx;
    const trapArm: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
      { op: "extern.convert_any" },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" },
      { op: "call", funcIdx: driverIdx },
    ];
    const forwardArm: Instr[] = forwardReturnsI32
      ? [
          // __object_isExtensible(target) -> i32 ; box to a boolean any.
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
          { op: "extern.convert_any" },
          { op: "call", funcIdx: forwardIdx },
          { op: "call", funcIdx: ctx.funcMap.get("__box_boolean")! },
        ]
      : [
          // __object_preventExtensions(target) -> externref ; drop, push the proxy
          // as a truthy success token.
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
          { op: "extern.convert_any" },
          { op: "call", funcIdx: forwardIdx },
          { op: "drop" },
          { op: "local.get", index: 0 },
        ];
    return [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: proxyTypeIdx },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
      { op: "if", blockType: { kind: "empty" }, then: throwRevoked() },
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: [{ op: "ref.null.extern" }],
        else: [
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: trapFieldIdx },
        ],
      },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: forwardArm,
        else: trapArm,
      },
    ];
  };

  // (#1355 Slice E) ownKeys dispatch builder. §10.5.11 [[OwnPropertyKeys]] takes
  // only the target (no key, no value) and returns the trap's array-like result
  // externref. It shares the 1-arg target-only shape of getPrototypeOf /
  // isExtensible but differs in two ways:
  //   1. The trap-absent forward target differs PER CALL SITE — `Object.keys`
  //      forwards to `__object_keys` (own enumerable string keys), whereas
  //      `Object.getOwnPropertyNames` / `Reflect.ownKeys` forward to
  //      `__getOwnPropertyNames` (all own string keys). So `forwardName` is a
  //      builder parameter (a separate dispatch helper is registered per forward
  //      target, both reading the SAME `ownKeys` trap field).
  //   2. When the trap IS present, §10.5.11 step 8 / CreateListFromArrayLike
  //      (§7.3.18 step 2) requires the trap result to be an Object — otherwise a
  //      TypeError. This is acceptance criterion #3 of #1355
  //      (`ownKeys/return-not-list-object-throws.js`: `ownKeys` returning
  //      `undefined`). We implement the top-level Object-type check here: the
  //      result is an Object iff it is non-null and not a boxed primitive
  //      (number / boolean / string) — exactly the complement of ToObject's
  //      primitive cases. The PER-ELEMENT String|Symbol check (CreateListFromArrayLike
  //      element-type step) and the §10.5.11 result-invariants (no duplicate keys;
  //      non-extensible target → result must equal the target's exact own keys)
  //      stay deferred to the dedicated invariant slice.
  // params: 0=proxyExtern, 1=unused. locals: 2=p, 3=trap.
  const buildOwnKeysDispatch = (forwardName: string): Instr[] => {
    const forwardIdx = ctx.funcMap.get(forwardName)!;
    const isObjectNumIdx = ctx.funcMap.get("__typeof_number")!;
    const isObjectBoolIdx = ctx.funcMap.get("__typeof_boolean")!;
    const isObjectStrIdx = ctx.funcMap.get("__typeof_string")!;
    // The trap arm: invoke driver(handler, trap, target), then enforce the
    // CreateListFromArrayLike Object-type check on the result before returning.
    const trapArm: Instr[] = [
      // result = driver(handler, trap, target)
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
      { op: "extern.convert_any" },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" },
      { op: "call", funcIdx: callOwnKeysIdx },
      // Stash the result in the trap local (reused — its prior value is dead here)
      // so we can both type-check and return it. trap local (3) is externref.
      { op: "local.set", index: 3 },
      // §7.3.18 step 2 / §10.5.11: if Type(result) is not Object → TypeError.
      // not-Object ⇔ is_null OR __typeof_number OR __typeof_boolean OR
      // __typeof_string. Compute (isNumber | isBoolean | isString), OR with
      // is_null, and throw if set.
      { op: "local.get", index: 3 },
      { op: "ref.is_null" },
      { op: "local.get", index: 3 },
      { op: "call", funcIdx: isObjectNumIdx },
      { op: "i32.or" },
      { op: "local.get", index: 3 },
      { op: "call", funcIdx: isObjectBoolIdx },
      { op: "i32.or" },
      { op: "local.get", index: 3 },
      { op: "call", funcIdx: isObjectStrIdx },
      { op: "i32.or" },
      { op: "if", blockType: { kind: "empty" }, then: throwNotListObject() },
      // result is an Object → return it.
      { op: "local.get", index: 3 },
    ];
    const forwardArm: Instr[] = [
      // __object_keys / __getOwnPropertyNames (target) -> externref ($ObjVec)
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" },
      { op: "call", funcIdx: forwardIdx },
    ];
    return [
      // p = ref.cast $Proxy(any.convert_extern(proxyExtern))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: proxyTypeIdx },
      { op: "local.set", index: 2 },
      // if p.revoked: throw TypeError
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
      { op: "if", blockType: { kind: "empty" }, then: throwRevoked() },
      // trap = p.ptraps==null ? null : p.ptraps.ownKeys
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: [{ op: "ref.null.extern" }],
        else: [
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: TRAP_OWNKEYS },
        ],
      },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: forwardArm,
        else: trapArm,
      },
    ];
  };

  // (#1355 Slice F) defineProperty-trap dispatch builder. §10.5.6
  // [[DefineOwnProperty]] takes (P, Desc) — a property key AND a descriptor — so
  // it has a 3-arg trap shape that doesn't fit the key-only `buildDispatch`. This
  // builds `__proxy_define_dispatch(proxyExtern, key, desc) -> externref`
  // (booleanish):
  //   revoked → throw; read defineProperty trap; null → forward
  //   `__obj_define_from_desc(target, key, desc)` on the target (the native
  //   single-descriptor applier — the same helper the non-proxy standalone path
  //   uses; returns an externref); else invoke the trap with `(target, key, desc)`
  //   and the handler as `this` (§10.5.6 step 9 `Call(trap, handler, «target, P,
  //   descObj»)`). The descriptor is passed through to the user trap UNCHANGED (an
  //   opaque externref) — the trap's own body reads it; we do not decompose it.
  // params: 0=proxyExtern, 1=key, 2=desc. locals: 3=p, 4=trap.
  // Phase-F scope: NO §10.5.6 result-invariants (a present non-callable trap →
  // TypeError; reconciling the returned definition against the target's existing
  // non-configurable / non-extensible descriptor) — those need the standalone
  // descriptor-attribute model (#797/#1460/#1462) and are deferred to the
  // invariant slice (G), mirroring slices A–E. The trap result is returned as-is.
  const buildDefineDispatch = (): Instr[] => {
    const forwardIdx = ctx.funcMap.get("__obj_define_from_desc")!;
    const trapArm: Instr[] = [
      // handler
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
      { op: "extern.convert_any" },
      // trap closure
      { op: "local.get", index: 4 },
      // target
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" },
      // key
      { op: "local.get", index: 1 },
      // desc (unchanged externref)
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: callDefineIdx },
    ];
    const forwardArm: Instr[] = [
      // __obj_define_from_desc(target, key, desc) -> externref
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: forwardIdx },
    ];
    return [
      // p = ref.cast $Proxy(any.convert_extern(proxyExtern))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: proxyTypeIdx },
      { op: "local.set", index: 3 },
      // if p.revoked: throw TypeError
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
      { op: "if", blockType: { kind: "empty" }, then: throwRevoked() },
      // trap = p.ptraps==null ? null : p.ptraps.defineProperty
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: [{ op: "ref.null.extern" }],
        else: [
          { op: "local.get", index: 3 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: TRAP_DEFINE },
        ],
      },
      { op: "local.set", index: 4 },
      // if trap == null: forward; else invoke trap
      { op: "local.get", index: 4 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: forwardArm,
        else: trapArm,
      },
    ];
  };

  // FRESH locals array + ValType objects per dispatch function. `registerNative`
  // stores `locals` by reference, and the FINALIZE dead-type-elimination pass
  // (`eliminateDeadImports`) mutates `func.locals[i]` in place when renumbering
  // surviving types — a SHARED array would be remapped once per owning function,
  // desyncing the local's type index from the (separately-remapped) body
  // instructions and yielding "struct.get expected (ref null A) found (ref null
  // B)". Build a new array each time so each function owns its locals.
  const dispatchLocals = (): { name: string; type: ValType }[] => [
    { name: "p", type: { kind: "ref", typeIdx: proxyTypeIdx } as ValType },
    { name: "trap", type: { kind: "externref" } as ValType },
  ];

  registerNative(
    "__proxy_get_dispatch",
    [externref, externref, externref],
    [externref],
    dispatchLocals(),
    buildDispatch(TRAP_GET, "__extern_get", false),
  );
  registerNative(
    "__proxy_set_dispatch",
    [externref, externref, externref],
    [externref],
    dispatchLocals(),
    buildDispatch(TRAP_SET, "__extern_set", true),
  );
  registerNative(
    "__proxy_has_dispatch",
    [externref, externref, externref],
    [externref],
    dispatchLocals(),
    buildDispatch(TRAP_HAS, "__extern_has", false),
  );
  // (#1355 Slice A) __proxy_delete_dispatch(proxyExtern, key, _recv) -> externref
  // (booleanish). §10.5.10 [[Delete]]: revoked→throw; read deleteProperty trap;
  // null→forward __delete_property on target (boxed boolean); else invoke trap
  // with `(target, key)` and the handler as `this`. The `__delete_property`
  // front-guard coerces the result back to i32 via `__is_truthy`. Phase-A scope:
  // NO §10.5.10 result-invariant check (a trap may not report a delete of a
  // non-configurable own property as successful) — that is a later invariant
  // slice. Takes 3 params to match `buildDispatch`'s hardcoded local layout
  // (p=local 3, trap=local 4 after the 3 params); the [[Delete]] trap signature
  // has no receiver, so param 2 is an unused placeholder (the front-guard passes
  // the proxy itself, never read on the delete path).
  registerNative(
    "__proxy_delete_dispatch",
    [externref, externref, externref],
    [externref],
    dispatchLocals(),
    buildDispatch(TRAP_DELETE, "__delete_property", false),
  );
  // (#1355 Slice B) __proxy_gopd_dispatch(proxy, key, _recv) -> externref.
  // §10.5.5 [[GetOwnProperty]]: revoked→throw; read getOwnPropertyDescriptor
  // trap; null→forward __getOwnPropertyDescriptor on target (returns the
  // descriptor object or undefined externref directly — like get, no boxing);
  // else invoke trap with `(target, key)` and the handler as `this`. Takes 3
  // params to match buildDispatch's local layout; the [[GetOwnProperty]] trap
  // signature has no receiver, so param 2 is an unused placeholder. Phase-B
  // scope: NO §10.5.5 result-invariant checks (trap must return an Object or
  // undefined; non-configurable/non-extensible consistency) — deferred to the
  // invariant slice; the trap result is returned as-is.
  registerNative(
    "__proxy_gopd_dispatch",
    [externref, externref, externref],
    [externref],
    dispatchLocals(),
    buildDispatch(TRAP_GOPD, "__getOwnPropertyDescriptor", false),
  );
  // (#1355 Slice C) __proxy_gpo_dispatch(proxy, _unused) -> externref.
  // §10.5.1 [[GetPrototypeOf]]. 2 params (the second unused) so the local layout
  // (p=local 2, trap=local 3) matches `buildProtoDispatch` / the setPrototypeOf
  // dispatch; the [[GetPrototypeOf]] trap takes only the target.
  registerNative(
    "__proxy_gpo_dispatch",
    [externref, externref],
    [externref],
    dispatchLocals(),
    buildProtoDispatch(TRAP_GPO, "__getPrototypeOf", false),
  );
  // (#1355 Slice C) __proxy_spo_dispatch(proxy, proto) -> externref (booleanish).
  // §10.5.2 [[SetPrototypeOf]]. The __object_setPrototypeOf front-guard coerces
  // the result via __is_truthy.
  registerNative(
    "__proxy_spo_dispatch",
    [externref, externref],
    [externref],
    dispatchLocals(),
    buildProtoDispatch(TRAP_SPO, "__object_setPrototypeOf", true),
  );
  // (#1355 Slice D) __proxy_isext_dispatch(proxy, _unused) -> externref
  // (booleanish). §10.5.3 [[IsExtensible]]. Front-guard coerces via __is_truthy.
  registerNative(
    "__proxy_isext_dispatch",
    [externref, externref],
    [externref],
    dispatchLocals(),
    buildExt1Dispatch(TRAP_ISEXT, "__object_isExtensible", true),
  );
  // (#1355 Slice D) __proxy_prevext_dispatch(proxy, _unused) -> externref
  // (booleanish). §10.5.4 [[PreventExtensions]]. The __object_preventExtensions
  // front-guard returns the dispatch externref directly (helper returns externref).
  registerNative(
    "__proxy_prevext_dispatch",
    [externref, externref],
    [externref],
    dispatchLocals(),
    buildExt1Dispatch(TRAP_PREVEXT, "__object_preventExtensions", false),
  );
  // (#1355 Slice E) ownKeys — TWO dispatch helpers reading the SAME `ownKeys`
  // trap field but with different trap-absent forwards (§10.5.11 [[OwnPropertyKeys]]):
  //   __proxy_ownkeys_keys_dispatch  — forwards __object_keys (Object.keys path)
  //   __proxy_ownkeys_names_dispatch — forwards __getOwnPropertyNames
  //                                    (Object.getOwnPropertyNames / Reflect.ownKeys)
  // Both run the same trap + CreateListFromArrayLike Object-type check when the
  // trap is present; they diverge only in the absent-trap forward target.
  registerNative(
    "__proxy_ownkeys_keys_dispatch",
    [externref, externref],
    [externref],
    dispatchLocals(),
    buildOwnKeysDispatch("__object_keys"),
  );
  registerNative(
    "__proxy_ownkeys_names_dispatch",
    [externref, externref],
    [externref],
    dispatchLocals(),
    buildOwnKeysDispatch("__getOwnPropertyNames"),
  );
  // (#1355 Slice F) __proxy_define_dispatch(proxy, key, desc) -> externref
  // (booleanish). §10.5.6 [[DefineOwnProperty]]: revoked→throw; read
  // defineProperty trap; null→forward __obj_define_from_desc on the target; else
  // invoke trap with `(target, key, desc)` and the handler as `this`. 3 params
  // (proxy, key, desc) so locals p=3, trap=4. The __obj_define_from_desc
  // front-guard returns the dispatch externref directly (the helper returns
  // externref). Phase-F scope: NO §10.5.6 result-invariants (deferred to the
  // descriptor-model invariant slice G).
  registerNative(
    "__proxy_define_dispatch",
    [externref, externref, externref],
    [externref],
    dispatchLocals(),
    buildDefineDispatch(),
  );

  // (#3031 apply slice) __proxy_apply_dispatch(proxyExtern, thisArg, argsVec)
  // -> externref. §10.5.12 [[Call]] — the 12th trap, wired at `__proxy_create`
  // since #1100 (field 3) but never dispatched (#3099 pinned it as the one dark
  // trap after handler materialization landed):
  //   revoked → throw TypeError (§10.5.12 step 2-3 via the null handler);
  //   trap absent → step 6 `Call(target, thisArgument, argumentsList)` through
  //     the `__apply_closure` bridge. That bridge carries the $Proxy front-guard
  //     (fillApplyClosure), so a proxy-of-proxy target re-enters this dispatch
  //     one hop at a time, and a non-callable target resolves to the bridge's S1
  //     undefined sentinel (no-throw discipline, same as fillApplyClosure);
  //   trap present → step 8 `Call(trap, handler, «target, thisArgument,
  //     argArray»)` via the reserved 3-arg driver.
  // `argsVec` is the native `$ObjVec` args carrier every closure-call consumer
  // uses (`__apply_closure` reads it via `__extern_length`/`__extern_get_idx`).
  // The trap receives that vec as its argArray — a CreateArrayFromList
  // array-exotic COPY (§10.5.12 step 7) is a documented boundary for the
  // invariant slice (G), like the other traps' raw-value key passing.
  // params: 0=proxyExtern 1=thisArg 2=argsVec ; locals: 3=p 4=trap.
  registerNative("__proxy_apply_dispatch", [externref, externref, externref], [externref], dispatchLocals(), [
    // p = ref.cast $Proxy(any.convert_extern(proxyExtern))
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: proxyTypeIdx },
    { op: "local.set", index: 3 },
    // if p.revoked: throw TypeError
    { op: "local.get", index: 3 },
    { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
    { op: "if", blockType: { kind: "empty" }, then: throwRevoked() },
    // trap = p.ptraps==null ? null : p.ptraps.apply
    { op: "local.get", index: 3 },
    { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: [{ op: "ref.null.extern" }],
      else: [
        { op: "local.get", index: 3 },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: TRAP_APPLY },
      ],
    },
    { op: "local.set", index: 4 },
    // if trap == null: forward Call(target, thisArg, args); else invoke trap
    { op: "local.get", index: 4 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: [
        // __apply_closure(target, thisArg, argsVec)
        { op: "local.get", index: 3 },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
        { op: "extern.convert_any" },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: applyClosureIdx },
      ],
      else: [
        // driver(handler, trap, target, thisArg, argArray)
        { op: "local.get", index: 3 },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
        { op: "extern.convert_any" },
        { op: "local.get", index: 4 },
        { op: "local.get", index: 3 },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
        { op: "extern.convert_any" },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: callApplyIdx },
      ],
    },
  ]);

  // (#4397) §10.5.13 [[Construct]] trap half. The fixed-arity native
  // constructor driver owns the trap-absent forward because it already has the
  // evaluated positional arguments. This helper owns everything intrinsic to
  // the Proxy: revocation, the target's stable [[Construct]] bit, GetMethod
  // callability, trap invocation, and the must-return-Object invariant. A null
  // result is therefore an unambiguous "trap absent; forward" sentinel.
  {
    const typeofFunctionIdx = ctx.funcMap.get("__typeof_function")!;
    const typeofObjectIdx = ctx.funcMap.get("__typeof_object")!;
    const typeofSymbolIdx = ctx.funcMap.get("__typeof_symbol");
    const boundaryCallableKindIdx = ctx.funcMap.get("__boundary_object_callable_kind");
    const notConstructorMsg = "Proxy target is not a constructor";
    const trapNotCallableMsg = "Proxy construct trap is not callable";
    const resultNotObjectMsg = "Proxy construct trap must return an object";
    for (const message of [notConstructorMsg, trapNotCallableMsg, resultNotObjectMsg]) {
      addStringConstantGlobal(ctx, message);
    }
    const throwTypeError = (message: string): Instr[] => [
      ...stringConstantExternrefInstrs(ctx, message),
      { op: "call", funcIdx: typeErrorCtorIdx },
      { op: "throw", tagIdx: exnTagIdx },
    ];
    const callableTest = (local: number): Instr[] => [
      { op: "local.get", index: local },
      { op: "call", funcIdx: typeofFunctionIdx },
      ...(boundaryCallableKindIdx === undefined
        ? []
        : ([
            { op: "local.get", index: local },
            { op: "call", funcIdx: boundaryCallableKindIdx },
            { op: "i32.const", value: 1 },
            { op: "i32.and" },
            { op: "i32.or" },
          ] satisfies Instr[])),
    ];
    const objectTest = (local: number): Instr[] => [
      { op: "local.get", index: local },
      { op: "call", funcIdx: typeofObjectIdx },
      ...callableTest(local),
      { op: "i32.or" },
      ...(typeofSymbolIdx === undefined
        ? []
        : ([
            { op: "local.get", index: local },
            { op: "call", funcIdx: typeofSymbolIdx },
            { op: "i32.eqz" },
            { op: "i32.and" },
          ] satisfies Instr[])),
    ];
    registerNative(
      "__proxy_construct_dispatch",
      [externref, externref, externref],
      [externref],
      [
        { name: "p", type: { kind: "ref", typeIdx: proxyTypeIdx } as ValType },
        { name: "trap", type: externref },
        { name: "result", type: externref },
      ],
      [
        // p = cast(proxy); revoked proxies always throw.
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: proxyTypeIdx },
        { op: "local.set", index: 3 },
        { op: "local.get", index: 3 },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
        { op: "if", blockType: { kind: "empty" }, then: throwRevoked() },
        // Proxy objects only carry [[Construct]] when their target did at
        // ProxyCreate time. The bit survives revocation, like the JS slot.
        { op: "local.get", index: 3 },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_CONSTRUCTIBLE },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: throwTypeError(notConstructorMsg) },
        // trap = p.ptraps?.construct
        { op: "local.get", index: 3 },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: externref },
          then: [{ op: "ref.null.extern" }],
          else: [
            { op: "local.get", index: 3 },
            { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: TRAP_CONSTRUCT },
          ],
        },
        { op: "local.tee", index: 4 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          // Null is reserved for the fixed-arity driver's forward arm.
          then: [{ op: "ref.null.extern" }, { op: "return" }],
        },
        // GetMethod must reject a present non-callable trap.
        ...callableTest(4),
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: throwTypeError(trapNotCallableMsg) },
        // Call(trap, handler, «target, argumentsList, newTarget»).
        { op: "local.get", index: 3 },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
        { op: "extern.convert_any" },
        { op: "local.get", index: 4 },
        { op: "local.get", index: 3 },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
        { op: "extern.convert_any" },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: callConstructIdx },
        { op: "local.tee", index: 5 },
        { op: "ref.is_null" },
        { op: "if", blockType: { kind: "empty" }, then: throwTypeError(resultNotObjectMsg) },
        ...objectTest(5),
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: throwTypeError(resultNotObjectMsg) },
        { op: "local.get", index: 5 },
      ],
    );
  }

  // ── __proxy_create(target, handler) -> externref ──────────────────────────
  //
  // §28.2.1.1 ProxyCreate. Reads get/set/has/apply off `handler` via
  // `__extern_get`. CONTRACT: the call site (new-super.ts) builds the handler as
  // an OPEN `$Object` (`compileObjectLiteralAsExternref`) so these reads resolve
  // — a closed typed struct would hide its fields from the open-object prop-map
  // walk and every trap would read null. Each read yields the trap **closure
  // externref** (or undefined → stored null → dispatch forwards to the target).
  //  1. target/handler null/undefined → TypeError (§28.2.1.1 step 1/2; full
  //     object-ness is Phase 2 / #1355).
  //  2. build `$ProxyTraps` from the 4 reads; build `$Proxy` (phandler kept for
  //     the trap `this`).
  //
  // params: 0=target 1=handler ; locals: 2=getT 3=setT 4=hasT 5=applyT (externref)
  {
    const externGetIdx = ctx.funcMap.get("__extern_get")!;
    const typeofFunctionIdx = ctx.funcMap.get("__typeof_function")!;
    const isConstructorIdx = ensureReflectIsConstructor(ctx);
    const notObjectMsg = "Cannot create proxy with a non-object as target or handler";
    addStringConstantGlobal(ctx, notObjectMsg);
    // FRESH array per use (this block is embedded in BOTH the target-null and
    // handler-null checks of the SAME `__proxy_create` body — a shared array gets
    // double-remapped by the FINALIZE dead-code funcIdx walk, corrupting the
    // baked `call __new_TypeError`).
    const throwNotObject = (): Instr[] => [
      ...stringConstantExternrefInstrs(ctx, notObjectMsg),
      { op: "call", funcIdx: typeErrorCtorIdx },
      { op: "throw", tagIdx: exnTagIdx },
    ];
    // readTrap(name) → __extern_get(handler, "name") (undefined → dispatch nulls).
    const readTrap = (name: string): Instr[] => [
      { op: "local.get", index: 1 },
      ...stringConstantExternrefInstrs(ctx, name),
      { op: "call", funcIdx: externGetIdx },
      // (#2106 S1) a missing trap resolves to the undefined singleton —
      // normalize to null so the trap-dispatch null checks keep working.
      ...(ctx.funcMap.has("__nullish_to_null")
        ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
        : []),
    ];
    const primitiveTypeofIndices = [
      "__typeof_number",
      "__typeof_boolean",
      "__typeof_string",
      "__typeof_bigint",
      "__typeof_symbol",
      "__extern_is_undefined",
    ]
      .map((name) => ctx.funcMap.get(name))
      .filter((idx): idx is number => idx !== undefined);
    const requireObject = (local: number): Instr[] => {
      const primitiveTest: Instr[] = [];
      for (const funcIdx of primitiveTypeofIndices) {
        primitiveTest.push({ op: "local.get", index: local }, { op: "call", funcIdx });
        if (primitiveTest.length > 2) primitiveTest.push({ op: "i32.or" });
      }
      if (primitiveTest.length === 0) primitiveTest.push({ op: "i32.const", value: 0 });
      return [...primitiveTest, { op: "if", blockType: { kind: "empty" }, then: throwNotObject() }];
    };
    const proxyCreateBody: Instr[] = [
      // if target == null → throw
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: throwNotObject() },
      // if handler == null → throw
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: throwNotObject() },
      // ProxyCreate requires actual Object values, including callable objects.
      // Primitive boxes remain primitives here; admitted JS objects/functions
      // are recognized by the finalized typeof classifiers without changing
      // their identity or representation.
      ...requireObject(0),
      ...requireObject(1),
      // read the traps off the (open) handler. (#1355) deleteProperty appended.
      ...readTrap("get"),
      { op: "local.set", index: 2 },
      ...readTrap("set"),
      { op: "local.set", index: 3 },
      ...readTrap("has"),
      { op: "local.set", index: 4 },
      ...readTrap("apply"),
      { op: "local.set", index: 5 },
      ...readTrap("deleteProperty"),
      { op: "local.set", index: 6 },
      ...readTrap("getOwnPropertyDescriptor"),
      { op: "local.set", index: 7 },
      ...readTrap("getPrototypeOf"),
      { op: "local.set", index: 8 },
      ...readTrap("setPrototypeOf"),
      { op: "local.set", index: 9 },
      ...readTrap("isExtensible"),
      { op: "local.set", index: 10 },
      ...readTrap("preventExtensions"),
      { op: "local.set", index: 11 },
      ...readTrap("ownKeys"),
      { op: "local.set", index: 12 },
      ...readTrap("defineProperty"),
      { op: "local.set", index: 13 },
      ...readTrap("construct"),
      { op: "local.set", index: 14 },
      // proxy fields (standalone $Proxy struct):
      { op: "i32.const", value: 1 }, // ptag = PROXY_TAG (1; bare ref.test $Proxy is the real discriminator)
      { op: "local.get", index: 0 }, // ptarget (externref → anyref)
      { op: "any.convert_extern" },
      { op: "local.get", index: 1 }, // phandler (externref → anyref; trap `this`)
      { op: "any.convert_extern" },
      // ptraps = struct.new $ProxyTraps
      //   (getT,setT,hasT,applyT,delT,gopdT,gpoT,spoT,isextT,prevextT,ownKeysT)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 4 },
      { op: "local.get", index: 5 },
      { op: "local.get", index: 6 },
      { op: "local.get", index: 7 },
      { op: "local.get", index: 8 },
      { op: "local.get", index: 9 },
      { op: "local.get", index: 10 },
      { op: "local.get", index: 11 },
      { op: "local.get", index: 12 },
      { op: "local.get", index: 13 },
      { op: "local.get", index: 14 },
      { op: "struct.new", typeIdx: proxyTrapsTypeIdx },
      { op: "i32.const", value: 0 }, // revoked = 0
      // [[Call]]/[[Construct]] slots are fixed by the target at ProxyCreate
      // time and survive revocation. The finalize-filled classifiers include
      // native carriers, nested Proxies, branded builtins, and admitted JS
      // boundary callables without replacing their identities.
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: typeofFunctionIdx },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isConstructorIdx },
      { op: "struct.new", typeIdx: proxyTypeIdx },
      { op: "extern.convert_any" },
    ];
    registerNative(
      "__proxy_create",
      [externref, externref],
      [externref],
      [
        { name: "getT", type: externref },
        { name: "setT", type: externref },
        { name: "hasT", type: externref },
        { name: "applyT", type: externref },
        { name: "delT", type: externref }, // (#1355 Slice A)
        { name: "gopdT", type: externref }, // (#1355 Slice B)
        { name: "gpoT", type: externref }, // (#1355 Slice C) getPrototypeOf
        { name: "spoT", type: externref }, // (#1355 Slice C) setPrototypeOf
        { name: "isextT", type: externref }, // (#1355 Slice D) isExtensible
        { name: "prevextT", type: externref }, // (#1355 Slice D) preventExtensions
        { name: "ownKeysT", type: externref }, // (#1355 Slice E) ownKeys
        { name: "defineT", type: externref }, // (#1355 Slice F) defineProperty
        { name: "constructT", type: externref }, // (#4397) construct
      ],
      proxyCreateBody,
    );
  }

  // ── __proxy_revoke(proxyExtern) -> () : set revoked=1, null target/handler/traps ──
  // params: 0=proxyExtern(externref) ; locals: 1=p(ref $Proxy)
  {
    const revokeBody: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: proxyTypeIdx },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 1 },
      { op: "struct.set", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
      // null out target/handler/traps (§28.2.2.1.1 RevocableProxy revoke).
      { op: "local.get", index: 1 },
      { op: "ref.null.extern" },
      { op: "any.convert_extern" },
      { op: "struct.set", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "local.get", index: 1 },
      { op: "ref.null.extern" },
      { op: "any.convert_extern" },
      { op: "struct.set", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
      { op: "local.get", index: 1 },
      { op: "ref.null", typeIdx: proxyTrapsTypeIdx },
      { op: "struct.set", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
    ];
    registerNative(
      "__proxy_revoke",
      [externref],
      [],
      [{ name: "p", type: { kind: "ref", typeIdx: proxyTypeIdx } as ValType }],
      revokeBody,
    );
  }

  // ── __proxy_revocable(target, handler) -> externref ─────────────────────
  //
  // §28.2.2.1 returns an ordinary object with a live proxy and a zero-argument
  // revoker. The revoker is a tiny Wasm-owned callable carrier holding the
  // proxy; `fillApplyClosure` recognizes the carrier and calls
  // `__proxy_revoke`. This keeps both proxy semantics and revocation in Wasm —
  // JavaScript only ever sees the result through the normal export-boundary
  // live view when it actually crosses that boundary.
  {
    const revokerName = "__proxy_revoker";
    let revokerTypeIdx = ctx.structMap.get(revokerName);
    if (revokerTypeIdx === undefined) {
      revokerTypeIdx = ctx.mod.types.length;
      const fields = [{ name: "proxy", type: externref, mutable: false }];
      ctx.mod.types.push({ kind: "struct", name: revokerName, fields });
      ctx.structMap.set(revokerName, revokerTypeIdx);
      ctx.typeIdxToStructName.set(revokerTypeIdx, revokerName);
      ctx.structFields.set(revokerName, fields);
    }

    addStringConstantGlobal(ctx, "proxy");
    addStringConstantGlobal(ctx, "revoke");
    const proxyCreateIdx = ctx.funcMap.get("__proxy_create")!;
    const newObjectIdx = ctx.funcMap.get("__new_plain_object")!;
    const externSetIdx = ctx.funcMap.get("__extern_set")!;
    const proxyLocal = 2;
    const revokerLocal = 3;
    const resultLocal = 4;
    registerNative(
      "__proxy_revocable",
      [externref, externref],
      [externref],
      [
        { name: "proxy", type: externref },
        { name: "revoker", type: externref },
        { name: "result", type: externref },
      ],
      [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: proxyCreateIdx },
        { op: "local.set", index: proxyLocal },
        { op: "local.get", index: proxyLocal },
        { op: "struct.new", typeIdx: revokerTypeIdx },
        { op: "extern.convert_any" },
        { op: "local.set", index: revokerLocal },
        { op: "call", funcIdx: newObjectIdx },
        { op: "local.set", index: resultLocal },
        { op: "local.get", index: resultLocal },
        ...stringConstantExternrefInstrs(ctx, "proxy"),
        { op: "local.get", index: proxyLocal },
        { op: "call", funcIdx: externSetIdx },
        { op: "local.get", index: resultLocal },
        ...stringConstantExternrefInstrs(ctx, "revoke"),
        { op: "local.get", index: revokerLocal },
        { op: "call", funcIdx: externSetIdx },
        { op: "local.get", index: resultLocal },
      ],
    );
  }

  // ── Patch the `ref.test $Proxy` guard onto the FRONT of __extern_get/set/has ──
  //
  // Every standalone property read/write/has routes through these helpers, so a
  // single front-guard covers `p.x`, `p[k]`, `k in p`, etc. uniformly (the
  // architect's "branch at the helper" approach — far less churn than editing
  // every property-access.ts call site). The guard tests the RAW externref param
  // 0 (any.convert_extern → ref.test $Proxy) BEFORE the ordinary body's
  // `ref.cast $Object` runs; a proxy IS-A $Object so it would otherwise take the
  // plain-object path and miss its traps.
  const getDispatchIdx = ctx.funcMap.get("__proxy_get_dispatch")!;
  const setDispatchIdx = ctx.funcMap.get("__proxy_set_dispatch")!;
  const hasDispatchIdx = ctx.funcMap.get("__proxy_has_dispatch")!;
  const deleteDispatchIdx = ctx.funcMap.get("__proxy_delete_dispatch")!; // (#1355 Slice A)
  const gopdDispatchIdx = ctx.funcMap.get("__proxy_gopd_dispatch")!; // (#1355 Slice B)
  const gpoDispatchIdx = ctx.funcMap.get("__proxy_gpo_dispatch")!; // (#1355 Slice C)
  const spoDispatchIdx = ctx.funcMap.get("__proxy_spo_dispatch")!; // (#1355 Slice C)
  const isextDispatchIdx = ctx.funcMap.get("__proxy_isext_dispatch")!; // (#1355 Slice D)
  const prevextDispatchIdx = ctx.funcMap.get("__proxy_prevext_dispatch")!; // (#1355 Slice D)
  const ownKeysKeysDispatchIdx = ctx.funcMap.get("__proxy_ownkeys_keys_dispatch")!; // (#1355 Slice E)
  const ownKeysNamesDispatchIdx = ctx.funcMap.get("__proxy_ownkeys_names_dispatch")!; // (#1355 Slice E)
  const defineDispatchIdx = ctx.funcMap.get("__proxy_define_dispatch")!; // (#1355 Slice F)

  const findBody = (name: string): Instr[] | undefined => ctx.mod.functions.find((f) => f.name === name)?.body;

  // __extern_get(obj, key) -> externref : if proxy → return get_dispatch(obj,key,obj)
  const getBody = findBody("__extern_get");
  if (getBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 0 }, // receiver = the proxy itself
          { op: "call", funcIdx: getDispatchIdx },
          { op: "return" },
        ],
      },
    ];
    getBody.unshift(...guard);
  }

  // Reflect.get(target,key,receiver) has a separate receiver-aware wrapper.
  // A Proxy target must see that receiver in both its trap and trap-absent
  // forwarding paths.
  const reflectGetReceiverBody = findBody("__reflect_get_receiver");
  if (reflectGetReceiverBody) {
    reflectGetReceiverBody.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: getDispatchIdx },
          { op: "return" },
        ],
      },
    );
  }

  // __extern_set(obj, key, value) -> () : if proxy → set_dispatch(obj,key,value); drop; return
  const setBody = findBody("__extern_set");
  if (setBody) {
    const setResultGlobalIdx = ctx.externSetResultGlobalIdx;
    const inheritedSetRuntimeActive = ctx.standalone && inheritedSetAnyDirty(ctx) && setResultGlobalIdx !== undefined;
    const isTruthyIdx = ctx.funcMap.get("__is_truthy");
    const resultAwareGuard = inheritedSetRuntimeActive && isTruthyIdx !== undefined;
    const callSetDispatch = (): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: setDispatchIdx },
    ];
    const noSetTrap = (): Instr[] => [
      // This guard runs only after the outer `ref.test $Proxy`. Do not infer a
      // boolean from the dispatch result: a trap-absent forward can complete
      // with SUCCESS, REFUSED, or UNADMITTED, all of which the target already
      // published in the shared channel.
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: proxyTypeIdx },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 1 }],
        else: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: proxyTypeIdx },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: TRAP_SET },
          { op: "ref.is_null" },
        ],
      },
    ];
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: resultAwareGuard
          ? [
              ...noSetTrap(),
              {
                op: "if",
                blockType: { kind: "empty" },
                // A trap-absent forward owns no Proxy boolean result. Drop
                // the dispatch placeholder and preserve exactly whatever the
                // target's __extern_set wrote (including UNADMITTED).
                then: [...callSetDispatch(), { op: "drop" }, { op: "return" }],
                // Only an actual trap return is boolean-coerced into the
                // #4504 result channel.
                else: [
                  ...callSetDispatch(),
                  { op: "call", funcIdx: isTruthyIdx! },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "i32.const", value: 1 },
                      { op: "global.set", index: setResultGlobalIdx! },
                    ],
                    else: [
                      { op: "i32.const", value: 2 },
                      { op: "global.set", index: setResultGlobalIdx! },
                    ],
                  },
                  { op: "return" },
                ],
              },
            ]
          : [...callSetDispatch(), { op: "drop" }, { op: "return" }],
      },
    ];
    setBody.unshift(...guard);
  }

  // __extern_has(obj, key) -> i32 : if proxy → ToBoolean(has_dispatch(obj,key,obj))
  // The dispatch returns the trap's booleanish result as an externref; coerce to
  // i32 via `__is_truthy` (reliably present in the standalone runtime — same
  // helper the accessor/array-callback truthiness sites use).
  const hasBody = findBody("__extern_has");
  if (hasBody) {
    const isTruthyIdx = ctx.funcMap.get("__is_truthy")!;
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 0 }, // receiver = the proxy itself
          { op: "call", funcIdx: hasDispatchIdx },
          { op: "call", funcIdx: isTruthyIdx },
          { op: "return" },
        ],
      },
    ];
    hasBody.unshift(...guard);
  }

  // (#1355 Slice A) __delete_property(obj, key) -> i32 : if proxy →
  // ToBoolean(delete_dispatch(obj,key)). `delete p.x` / `Reflect.deleteProperty`
  // both route through __delete_property, so this single front-guard covers both.
  // The dispatch returns the deleteProperty trap's booleanish externref result;
  // coerce to i32 via `__is_truthy` (same as the has guard).
  const deleteBody = findBody("__delete_property");
  if (deleteBody) {
    const isTruthyIdx = ctx.funcMap.get("__is_truthy")!;
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 0 }, // unused receiver placeholder (3-param dispatch)
          { op: "call", funcIdx: deleteDispatchIdx },
          { op: "call", funcIdx: isTruthyIdx },
          { op: "return" },
        ],
      },
    ];
    deleteBody.unshift(...guard);
  }

  // (#1355 Slice B) __getOwnPropertyDescriptor(obj, key) -> externref : if proxy
  // → gopd_dispatch(obj,key,obj). `Object.getOwnPropertyDescriptor(p, k)` and
  // `Reflect.getOwnPropertyDescriptor(p, k)` both fall back to this helper for
  // dynamic receivers (calls.ts). The dispatch returns the trap's descriptor
  // externref (or undefined) directly — no coercion, like the get guard.
  const gopdBody = findBody("__getOwnPropertyDescriptor");
  if (gopdBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 0 }, // unused receiver placeholder (3-param dispatch)
          { op: "call", funcIdx: gopdDispatchIdx },
          { op: "return" },
        ],
      },
    ];
    gopdBody.unshift(...guard);
  }

  // (#1355 Slice C) __getPrototypeOf(obj) -> externref : if proxy →
  // gpo_dispatch(obj, obj). `Object.getPrototypeOf(p)` / `Reflect.getPrototypeOf`
  // and `p.__proto__` reads fall back to this helper for dynamic receivers. The
  // dispatch returns the trap's prototype externref (or the target's, when the
  // trap is absent) directly — same return type, no coercion.
  const gpoBody = findBody("__getPrototypeOf");
  if (gpoBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 0 }, // unused 2nd param placeholder
          { op: "call", funcIdx: gpoDispatchIdx },
          { op: "return" },
        ],
      },
    ];
    gpoBody.unshift(...guard);
  }

  // (#1355 Slice C) __object_setPrototypeOf(obj, proto) -> externref : if proxy →
  // spo_dispatch(obj, proto). `Object.setPrototypeOf(p, v)` /
  // `Reflect.setPrototypeOf` and `p.__proto__ = v` writes route here for dynamic
  // receivers. The dispatch returns the trap's booleanish externref (or a truthy
  // success token when the trap is absent and the ordinary set succeeded); we
  // return it as-is — the native helper's contract is also "returns an externref"
  // (it returns the object), so the booleanish externref is type-compatible and
  // the caller (Object.setPrototypeOf returns its first arg) ignores the value.
  const spoBody = findBody("__object_setPrototypeOf");
  if (spoBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: spoDispatchIdx },
          { op: "return" },
        ],
      },
    ];
    spoBody.unshift(...guard);
  }

  // (#1355 Slice D) __object_isExtensible(obj) -> i32 : if proxy →
  // ToBoolean(isext_dispatch(obj)). `Object.isExtensible(p)` /
  // `Reflect.isExtensible` route here for dynamic receivers. The dispatch returns
  // the trap's booleanish externref; coerce to i32 via `__is_truthy`.
  const isextBody = findBody("__object_isExtensible");
  if (isextBody) {
    const isTruthyIdx = ctx.funcMap.get("__is_truthy")!;
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 0 }, // unused 2nd param placeholder
          { op: "call", funcIdx: isextDispatchIdx },
          { op: "call", funcIdx: isTruthyIdx },
          { op: "return" },
        ],
      },
    ];
    isextBody.unshift(...guard);
  }

  // (#1355 Slice D) __object_preventExtensions(obj) -> externref : if proxy →
  // prevext_dispatch(obj). `Object.preventExtensions(p)` / `Reflect.*` /
  // `Object.seal`/`Object.freeze` (which call preventExtensions) route here. The
  // dispatch returns a booleanish externref (or the proxy success token); we
  // return it directly — the helper's contract is "returns an externref" (the
  // object), type-compatible, and the JS-level caller ignores the value.
  const prevextBody = findBody("__object_preventExtensions");
  if (prevextBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 0 }, // unused 2nd param placeholder
          { op: "call", funcIdx: prevextDispatchIdx },
          { op: "return" },
        ],
      },
    ];
    prevextBody.unshift(...guard);
  }

  // (#1355 Slice E) __object_keys(obj) -> externref : if proxy →
  // ownkeys_keys_dispatch(obj). `Object.keys(p)` lowers to `__object_keys` for a
  // dynamic receiver, so this single front-guard covers the Object.keys path. The
  // dispatch reads the ownKeys trap, runs it (with the CreateListFromArrayLike
  // Object-type check) or forwards to the ordinary `__object_keys` on the target;
  // it returns the result externref ($ObjVec or the trap's array) directly.
  const objectKeysBody = findBody("__object_keys");
  if (objectKeysBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 0 }, // unused 2nd param placeholder
          { op: "call", funcIdx: ownKeysKeysDispatchIdx },
          { op: "return" },
        ],
      },
    ];
    objectKeysBody.unshift(...guard);
  }

  // (#1355 Slice E) __getOwnPropertyNames(obj) -> externref : if proxy →
  // ownkeys_names_dispatch(obj). `Object.getOwnPropertyNames(p)` /
  // `Reflect.ownKeys(p)` route here for a dynamic receiver. Same ownKeys trap,
  // but the trap-absent forward is `__getOwnPropertyNames` (all own string keys,
  // no enumerable filter) rather than `__object_keys`. Returns the result
  // externref directly.
  const ownNamesBody = findBody("__getOwnPropertyNames");
  if (ownNamesBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 0 }, // unused 2nd param placeholder
          { op: "call", funcIdx: ownKeysNamesDispatchIdx },
          { op: "return" },
        ],
      },
    ];
    ownNamesBody.unshift(...guard);
  }

  // (#1355 Slice F) __obj_define_from_desc(obj, key, desc) -> externref : if proxy
  // → define_dispatch(obj, key, desc). `Object.defineProperty(p, k, desc)` and
  // `Reflect.defineProperty(p, k, desc)` route here for a dynamic receiver (the
  // standalone single-descriptor applier funnel — the call site routes inline
  // `{...}` literals on a non-static-struct receiver through here too, see
  // object-ops.ts, so this single front-guard covers both descriptor forms). The
  // dispatch reads the defineProperty trap, runs it with `(target, key, desc)` (the
  // descriptor passed through UNCHANGED) or forwards to the ordinary
  // `__obj_define_from_desc` on the target; it returns the result externref
  // directly (the helper's contract is "returns an externref").
  const objDefineBody = findBody("__obj_define_from_desc");
  if (objDefineBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: defineDispatchIdx },
          { op: "return" },
        ],
      },
    ];
    objDefineBody.unshift(...guard);
  }

  void objectTypeIdx;
}

/**
 * (#1100) Fill the reserved Proxy trap-invoke driver bodies at FINALIZE, AFTER
 * `emitClosureMethodCallExportN(2..4)` have registered `__call_fn_method_2/3/4`
 * in `funcMap`. Each driver is a thin wrapper around the closure-call bridge
 * that threads the handler as `this` and forwards the spec trap args:
 *
 *   __proxy_call_get(handler, trap, target, key, receiver)
 *       = __call_fn_method_3(handler, trap, target, key, receiver)
 *   __proxy_call_set(handler, trap, target, key, value, receiver)
 *       = __call_fn_method_4(handler, trap, target, key, value, receiver)
 *   __proxy_call_has(handler, trap, target, key)
 *       = __call_fn_method_2(handler, trap, target, key)
 *
 * No-op when the proxy runtime was never reserved (`ctx.proxyDispatchReserved`).
 * When a driver WAS reserved but the matching dispatcher was never emitted (no
 * closure of that arity exists — so no real trap of that arity could have been
 * installed either), the body is filled with `ref.null.extern` so the module
 * still verifies — mirrors `fillAccessorDrivers` / `fillApplyClosure`.
 */
export function fillProxyDispatch(ctx: CodegenContext): void {
  if (!ctx.proxyDispatchReserved) return;

  // The trap is invoked through the proven open-`any` closure bridge
  // `__apply_closure(fn, recv, argsVec)` — the SAME path `__extern_method_call`
  // uses for `o.m(...)` on an open receiver — NOT `__call_fn_method_N`. Rationale:
  // `__apply_closure` reads its args from a `$ObjVec` via `__extern_get_idx` and
  // re-dispatches by runtime arity, so it tolerates ANY user trap closure
  // signature (the `__call_fn_method_N` exports bind a single per-arity wrapper
  // type + box the result by the wrapper's declared return type, which mismatched
  // the trap closure's ABI). `recv` is the handler (trap `this`, §10.5.x).
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const externref: ValType = { kind: "externref" };

  // Build the args $ObjVec from the driver's trap-arg params (indices 2..2+argc)
  // and call __apply_closure(trap=param1, handler=param0, vec). Uses a `$vec`
  // local appended after the driver's params.
  const fill = (name: string, argCount: number): void => {
    const driverIdx = ctx.funcMap.get(name);
    if (driverIdx === undefined) return;
    const driverFn = definedFuncAt(ctx, driverIdx);
    if (!driverFn) return;
    if (applyClosureIdx === undefined || objVecNewIdx === undefined || objVecPushIdx === undefined) {
      // Closure bridge / objvec builders absent (no standalone closure in the
      // module) → no trap could have been installed; keep a valid stub body.
      driverFn.body = [{ op: "ref.null.extern" }];
      return;
    }
    // params: 0=handler 1=trap 2..(argCount+1)=trap args. vec local index =
    // argCount + 2 (after all params).
    const vecLocal = argCount + 2;
    driverFn.locals = [{ name: "vec", type: externref }];
    const body: Instr[] = [
      { op: "call", funcIdx: objVecNewIdx }, // vec = __objvec_new()
      { op: "local.set", index: vecLocal },
    ];
    for (let a = 0; a < argCount; a++) {
      body.push({ op: "local.get", index: vecLocal });
      body.push({ op: "local.get", index: 2 + a });
      body.push({ op: "call", funcIdx: objVecPushIdx }); // __objvec_push(vec, arg_a)
    }
    // return __apply_closure(trap, handler, vec)
    body.push({ op: "local.get", index: 1 }); // trap
    body.push({ op: "local.get", index: 0 }); // handler (recv → this)
    body.push({ op: "local.get", index: vecLocal }); // args vec
    body.push({ op: "call", funcIdx: applyClosureIdx });
    driverFn.body = body;
  };
  fill(PROXY_CALL_GET, 3); // (target, key, receiver)
  fill(PROXY_CALL_SET, 4); // (target, key, value, receiver)
  fill(PROXY_CALL_HAS, 2); // (target, key)
  fill(PROXY_CALL_DELETE, 2); // (#1355 Slice A) deleteProperty (target, key)
  fill(PROXY_CALL_GOPD, 2); // (#1355 Slice B) getOwnPropertyDescriptor (target, key)
  fill(PROXY_CALL_GPO, 1); // (#1355 Slice C) getPrototypeOf (target)
  fill(PROXY_CALL_SPO, 2); // (#1355 Slice C) setPrototypeOf (target, proto)
  fill(PROXY_CALL_ISEXT, 1); // (#1355 Slice D) isExtensible (target)
  fill(PROXY_CALL_PREVEXT, 1); // (#1355 Slice D) preventExtensions (target)
  fill(PROXY_CALL_OWNKEYS, 1); // (#1355 Slice E) ownKeys (target)
  fill(PROXY_CALL_DEFINE, 3); // (#1355 Slice F) defineProperty (target, key, desc)
  fill(PROXY_CALL_APPLY, 3); // (#3031 apply slice) apply (target, thisArg, argArray)
  fill(PROXY_CALL_CONSTRUCT, 3); // (#4397) construct (target, argumentsList, newTarget)
}
