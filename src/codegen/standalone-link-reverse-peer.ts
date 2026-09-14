// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// standalone-link-reverse-peer.ts — (#5383 S17 / #6478) the REVERSE half of the
// #5383 S2d standalone link boundary: a CONSUMER-owned carrier read by PROVIDER
// code.
//
// THE DEFECT THIS EXISTS FOR (measured 2026-09-14, `.tmp/s17/c1.out`,
// `.tmp/s17/c2.out`; host-free linked pair, `--target standalone`):
// the consumer builds a plain property bag and hands it to the provider, and
// every dynamic read the provider makes on it answers nothing —
//
//   consumer:  const bag = { year: 1976 };  NS.get(bag, "year")
//   provider:  get: function (o, k) { return o[k]; }      // → undefined
//
// | consumer-built carrier        | provider `o[k]` | `k in o` | `Object.keys` |
// | ----------------------------- | --------------- | -------- | ------------- |
// | object literal `{ year: … }`  | **undefined**   | **false**| **""**        |
// | class instance                | **undefined**   | —        | **""**        |
// | `Object.create(null)` bag     | 1976            | true     | "year,day"    |
// | array / string                | ok              | —        | —             |
//
// The discriminator is the CARRIER, not the key and not the direction of the
// call: a generic `$Object` is a canonical runtime type, so the provider's own
// ladder decodes it; an object literal and a class instance are CLOSED
// static-shape structs the consumer declared, which appear in the consumer's
// finalize-time `__extern_get` field ladder and in no other module's. The
// provider's ladder misses on every arm and falls through to its terminal —
// exactly the S2d defect, with the two modules swapped.
//
// S2d fixed the consumer→provider direction by having the PROVIDER export its
// generic terminals and the CONSUMER import them on a miss. That shape cannot
// be mirrored: wasm module imports may not be cyclic, and the provider is
// compiled (and CACHED) before any consumer exists, so it cannot import from
// one. The channel therefore has to be INSTALLED at runtime rather than linked:
//
//   * the provider defines a nullable typed-funcref global per terminal and
//     exports one setter, `__js2wasm_link_install_peer`;
//   * the consumer imports that setter and calls it from the top of
//     `__module_init` with `ref.func` of its OWN normalising terminals;
//   * the provider's terminal miss path does `call_ref` through the global when
//     it is non-null.
//
// A funcref handed across a wasm→wasm link is the callee itself, so this is a
// pure wiring shim: no copy, no second ABI, and nothing changes for a provider
// whose consumer never installs (the globals stay null and every arm answers
// exactly what it answered before).
//
// ## Why the re-entrancy flag is not optional
//
// Both directions are miss paths, so a carrier NEITHER module can decode would
// bounce forever: consumer misses → asks provider → provider misses → asks
// consumer → … The flag is on the PROVIDER side and guards the reverse hop
// only, which is the minimum that terminates the cycle while leaving the useful
// case intact. That matters: the whole point is that the provider is usually
// ALREADY inside a consumer-initiated call when it reads the bag
// (`Temporal.PlainDate.from(bag)` runs provider code for its entire duration),
// so a "am I serving a consumer request" guard would refuse exactly the reads
// this module exists to serve. Only a hop that started from the reverse channel
// is refused.
//
// The flag is per-instance, not per-call-stack, so a legitimately NESTED
// reverse read — one whose consumer-side hop itself re-enters the provider,
// which then reads a second consumer carrier — is refused. That is a
// conservative miss (the old answer), never a wrong value, and it needs a
// consumer getter that calls provider code to reach at all; a bag whose fields
// are themselves consumer objects is read one hop at a time and is unaffected.
//
// The flag is restored through `try`/`catch_all` + `rethrow` rather than by a
// straight-line reset, because a provider throw propagating out of a reverse
// call is ordinary (#5383 S2m gave the graph a shared exception tag precisely
// so it can). A leaked `1` would silently disable the channel for the rest of
// the instance's life — a wrong ANSWER, not a crash, which no byte A/B shows.
//
// Scope: `--target standalone` only, and only between modules of one linked
// project. The JS-host lane keeps its host mirror and is untouched (every entry
// point returns before emitting anything unless `ctx.standalone`).

import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { ensureCurrentThisGlobal } from "./statements/nested-declarations.js";
import type { CodegenContext } from "./context/types.js";
import type { Instr, ValType } from "../ir/types.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** The wasm→wasm ABI of the reverse channel. Names ARE the contract. */
export const LINK_REVERSE_PEER = Object.freeze({
  /** Provider export: `(peerGet, peerKeys) -> ()`. */
  install: "__js2wasm_link_install_peer",
  /** Provider-internal: the `memberGet` miss hop. */
  reverseGet: "__js2wasm_link_reverse_get",
  /** Provider-internal: the `objectKeys` miss hop. */
  reverseKeys: "__js2wasm_link_reverse_keys",
  /** Provider-internal: the `has` miss hop — and the null-vs-absent oracle. */
  reverseHas: "__js2wasm_link_reverse_has",
  /** Provider-internal: the `__extern_method_call` miss hop (#6483). */
  reverseMethodCall: "__js2wasm_link_reverse_method_call",
  /** Consumer-internal: the normalising terminals it installs. */
  localGet: "__js2wasm_link_local_member_get",
  localKeys: "__js2wasm_link_local_object_keys",
  localHas: "__js2wasm_link_local_has",
  localIsNull: "__js2wasm_link_local_is_null",
  localMethodCall: "__js2wasm_link_local_method_call",
} as const);

/** The host lane's `__boundary_object_has` tri-state for "mine, and present". */
const PRESENT = 2;

/** The provider-side hop indices the `object-runtime` arms bake. */
export interface ReversePeerHops {
  get?: number;
  keys?: number;
  has?: number;
  /** `__js2wasm_link_reverse_owned` — see `reverseGetArmInstrs`. */
  ownedGlobal?: number;
  /** (#6483) `__js2wasm_link_reverse_method_call`. */
  methodCall?: number;
}

/**
 * The `__js2wasm_link_reverse_owned` global index, per module.
 *
 * Kept in a `WeakMap` rather than on `CodegenContext` deliberately: it is read
 * by exactly one caller, in the same window that reserved it, so putting it on
 * the shared context would widen a god-object for a value with a two-call
 * lifetime.
 */
const reverseOwnedGlobals = new WeakMap<CodegenContext, number>();

/** A module compiled as a linked provider whose consumer is wasm, not JS. */
function isProvider(ctx: CodegenContext): boolean {
  return ctx.standalone && ctx.exportsConsumedByWasm === true;
}

/** The provider namespace this module consumes, if it is a consumer. */
function peerNamespace(ctx: CodegenContext): string | undefined {
  if (!ctx.standalone || isProvider(ctx)) return undefined;
  return [...ctx.linkedNamespaces].filter((name) => name.startsWith("js2wasm:npm:")).sort()[0];
}

interface ReverseTypes {
  getTypeIdx: number;
  keysTypeIdx: number;
  hasTypeIdx: number;
  isNullTypeIdx: number;
  methodCallTypeIdx: number;
  getRef: ValType;
  keysRef: ValType;
  hasRef: ValType;
  isNullRef: ValType;
  methodCallRef: ValType;
}

/**
 * The two funcref types the channel speaks, interned in THIS module.
 *
 * Both sides call `addFuncType` with the same signature, and wasm canonicalises
 * function types structurally, so the consumer's `ref.func` is accepted by the
 * provider's setter without either module knowing the other's type index.
 */
function reverseTypes(ctx: CodegenContext): ReverseTypes {
  const getTypeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF], "$__link_peer_get");
  const keysTypeIdx = addFuncType(ctx, [EXTERNREF], [EXTERNREF], "$__link_peer_keys");
  const hasTypeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [I32], "$__link_peer_has");
  // The same SHAPE as `has`, and deliberately its own type NAME: the two answer
  // different questions and must not land in each other's slot.
  const isNullTypeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [I32], "$__link_peer_is_null");
  // (#6483) `(recv, name, args) -> result`, the shape of `__extern_method_call`.
  const methodCallTypeIdx = addFuncType(
    ctx,
    [EXTERNREF, EXTERNREF, EXTERNREF],
    [EXTERNREF],
    "$__link_peer_method_call",
  );
  return {
    getTypeIdx,
    keysTypeIdx,
    hasTypeIdx,
    isNullTypeIdx,
    methodCallTypeIdx,
    getRef: { kind: "ref_null", typeIdx: getTypeIdx },
    keysRef: { kind: "ref_null", typeIdx: keysTypeIdx },
    hasRef: { kind: "ref_null", typeIdx: hasTypeIdx },
    isNullRef: { kind: "ref_null", typeIdx: isNullTypeIdx },
    methodCallRef: { kind: "ref_null", typeIdx: methodCallTypeIdx },
  };
}

/** Append a mutable global, returning its absolute index. */
function addGlobal(ctx: CodegenContext, name: string, type: ValType, init: Instr[]): number {
  const index = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({ name, type, mutable: true, init });
  return index;
}

/** Register a defined function under `name`, returning its funcIdx. */
function define(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
): number {
  const typeIdx = addFuncType(ctx, params, results);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });
  return funcIdx;
}

/**
 * The reverse hop, as one function per terminal.
 *
 * ```
 * if (peer == null || inReverse) return null;   // nothing installed, or a bounce
 * inReverse = 1;
 * try { result = peer(args…) } catch_all { inReverse = 0; rethrow }
 * inReverse = 0;
 * return result;
 * ```
 *
 * `null` means "not mine either", which is the answer every caller of this arm
 * already handles — it is the same contract the provider's own normalising
 * wrappers give the consumer in the forward direction.
 */
function reverseHopBody(args: {
  peerGlobalIdx: number;
  flagGlobalIdx: number;
  typeIdx: number;
  arity: number;
  resultLocal: number;
  /** What "not mine" looks like for this terminal: a null ref, or `0`. */
  miss: Instr;
  /** Extra work inside the guarded window, after the peer answered. */
  after?: Instr[];
}): Instr[] {
  const call: Instr[] = [];
  for (let i = 0; i < args.arity; i++) call.push({ op: "local.get", index: i });
  call.push({ op: "global.get", index: args.peerGlobalIdx });
  call.push({ op: "call_ref", typeIdx: args.typeIdx });
  call.push({ op: "local.set", index: args.resultLocal });
  for (const instr of args.after ?? []) call.push(instr);
  const clear: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "global.set", index: args.flagGlobalIdx },
  ];
  return [
    { op: "global.get", index: args.peerGlobalIdx },
    { op: "ref.is_null" },
    { op: "global.get", index: args.flagGlobalIdx },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [args.miss, { op: "return" }],
    },
    { op: "i32.const", value: 1 },
    { op: "global.set", index: args.flagGlobalIdx },
    {
      op: "try",
      blockType: { kind: "empty" },
      body: call,
      catches: [],
      catchAll: [...clear, { op: "rethrow", depth: 0 }],
    },
    ...clear,
    { op: "local.get", index: args.resultLocal },
  ];
}

/**
 * PROVIDER side. Define the reverse hops + the installer, and hand back the two
 * funcIdx values the `__extern_get` / `__object_keys` miss arms bake.
 *
 * MUST be called from `ensureObjectRuntime` BEFORE those arms are built and
 * before the #1984 index-space freeze — the same window
 * `standaloneLinkBoundaryPeerIndices` occupies, and for the same reason. A
 * module that is not a wasm-consumed provider gets `{}` and stays
 * byte-identical.
 */
export function reserveStandaloneLinkReversePeer(ctx: CodegenContext): ReversePeerHops {
  if (!isProvider(ctx)) return {};
  if (ctx.funcMap.has(LINK_REVERSE_PEER.reverseGet)) {
    return {
      get: ctx.funcMap.get(LINK_REVERSE_PEER.reverseGet),
      keys: ctx.funcMap.get(LINK_REVERSE_PEER.reverseKeys),
      has: ctx.funcMap.get(LINK_REVERSE_PEER.reverseHas),
      ownedGlobal: reverseOwnedGlobals.get(ctx),
      methodCall: ctx.funcMap.get(LINK_REVERSE_PEER.reverseMethodCall),
    };
  }
  const types = reverseTypes(ctx);
  const peerGetIdx = addGlobal(ctx, "__js2wasm_link_peer_get", types.getRef, [
    { op: "ref.null", typeIdx: types.getTypeIdx },
  ]);
  const peerKeysIdx = addGlobal(ctx, "__js2wasm_link_peer_keys", types.keysRef, [
    { op: "ref.null", typeIdx: types.keysTypeIdx },
  ]);
  const peerHasIdx = addGlobal(ctx, "__js2wasm_link_peer_has", types.hasRef, [
    { op: "ref.null", typeIdx: types.hasTypeIdx },
  ]);
  const peerIsNullIdx = addGlobal(ctx, "__js2wasm_link_peer_is_null", types.isNullRef, [
    { op: "ref.null", typeIdx: types.isNullTypeIdx },
  ]);
  const peerMethodCallIdx = addGlobal(ctx, "__js2wasm_link_peer_method_call", types.methodCallRef, [
    { op: "ref.null", typeIdx: types.methodCallTypeIdx },
  ]);
  const flagIdx = addGlobal(ctx, "__js2wasm_link_in_reverse", I32, [{ op: "i32.const", value: 0 }]);
  // The null-vs-absent channel — see `reverseGetArmInstrs` for why a second
  // global is the only place the answer can live.
  const ownedIdx = addGlobal(ctx, "__js2wasm_link_reverse_owned", I32, [{ op: "i32.const", value: 0 }]);
  reverseOwnedGlobals.set(ctx, ownedIdx);

  // A `null` ANSWER and a miss are the same value at the arm, so the hop asks
  // the peer's `has` a second time on exactly that path and records the verdict
  // in `__js2wasm_link_reverse_owned`. Without it a bag field whose value IS
  // `null` reads as ABSENT inside the provider — measured (`.tmp/s17/c4.out`):
  // `typeof bag.calendar` answered `"undefined"` for `{ calendar: null }`, and
  // three test262 `*-propertybag-calendar-wrong-type` rows stopped throwing,
  // because the polyfill's `!== undefined` guard then admitted the null.
  const get = define(
    ctx,
    LINK_REVERSE_PEER.reverseGet,
    [EXTERNREF, EXTERNREF],
    [EXTERNREF],
    [{ name: "r", type: EXTERNREF }],
    [
      { op: "i32.const", value: 0 },
      { op: "global.set", index: ownedIdx },
      ...reverseHopBody({
        peerGlobalIdx: peerGetIdx,
        flagGlobalIdx: flagIdx,
        typeIdx: types.getTypeIdx,
        arity: 2,
        resultLocal: 2,
        miss: { op: "ref.null.extern" },
        after: [
          { op: "local.get", index: 2 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "global.get", index: peerIsNullIdx },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 1 },
                  { op: "global.get", index: peerIsNullIdx },
                  { op: "call_ref", typeIdx: types.isNullTypeIdx },
                  { op: "global.set", index: ownedIdx },
                ],
              },
            ],
          },
        ],
      }),
    ],
  );
  const keys = define(
    ctx,
    LINK_REVERSE_PEER.reverseKeys,
    [EXTERNREF],
    [EXTERNREF],
    [{ name: "r", type: EXTERNREF }],
    reverseHopBody({
      peerGlobalIdx: peerKeysIdx,
      flagGlobalIdx: flagIdx,
      typeIdx: types.keysTypeIdx,
      arity: 1,
      resultLocal: 1,
      miss: { op: "ref.null.extern" },
    }),
  );
  // The `in` twin, in the SAME tri-state the host lane's
  // `__boundary_object_has` speaks (0 = not mine · 2 = mine and present), so it
  // drops into that arm with no change to the arm. "Mine but absent" is
  // reported as "not mine": the provider then continues its own miss path and
  // answers `false`, which is what it answers today.
  const has = define(
    ctx,
    LINK_REVERSE_PEER.reverseHas,
    [EXTERNREF, EXTERNREF],
    [I32],
    [{ name: "r", type: I32 }],
    reverseHopBody({
      peerGlobalIdx: peerHasIdx,
      flagGlobalIdx: flagIdx,
      typeIdx: types.hasTypeIdx,
      arity: 2,
      resultLocal: 2,
      miss: { op: "i32.const", value: 0 },
    }),
  );
  // (#6483) `recv.name(args)` where the RECEIVER is the CONSUMER's. The exact
  // mirror of the forward `__js2wasm_link_method_call` terminal (S2h), and it
  // exists for the same reason that one does: resolution and receiver binding
  // both have to happen in the module that OWNS the receiver, because the
  // method closure's trampoline reads `this` from its own module's
  // `__current_this` global. Measured before this arm existed (`.tmp/s18/c7`,
  // linked pair, `--target standalone`): provider code doing `o.m()` on a
  // consumer bag threw `TypeError: called value is not a function` — from
  // `resolved-callee-guard.ts`, which is the terminal miss of
  // `__extern_method_call` and the LAST thing before the throw.
  //
  // A `null` answer is NOT adopted as a value here, and that asymmetry with the
  // `get` hop is deliberate + measured. For `get`, "the peer owns the receiver
  // and the key is present" fully determines that a null read IS the value. For
  // a CALL it does not: the hop also answers null when the consumer resolved the
  // method and its own `__apply_closure` declined to dispatch it. Adopting that
  // null replaces a loud, correct TypeError with a silent wrong value —
  // measured on the first cut of this slice (`.tmp/s18/witness-new.out`), where
  // `o.add(3, 4)` went from a TypeError to `null` and `this.v` to `undefined`.
  // So the arm returns ONLY a non-null answer, and every other case keeps the
  // pre-#6483 miss path byte for byte.
  const methodCall = define(
    ctx,
    LINK_REVERSE_PEER.reverseMethodCall,
    [EXTERNREF, EXTERNREF, EXTERNREF],
    [EXTERNREF],
    [{ name: "r", type: EXTERNREF }],
    reverseHopBody({
      peerGlobalIdx: peerMethodCallIdx,
      flagGlobalIdx: flagIdx,
      typeIdx: types.methodCallTypeIdx,
      arity: 3,
      resultLocal: 3,
      miss: { op: "ref.null.extern" },
    }),
  );
  define(
    ctx,
    LINK_REVERSE_PEER.install,
    [types.getRef, types.keysRef, types.hasRef, types.isNullRef, types.methodCallRef],
    [],
    [],
    [
      { op: "local.get", index: 0 },
      { op: "global.set", index: peerGetIdx },
      { op: "local.get", index: 1 },
      { op: "global.set", index: peerKeysIdx },
      { op: "local.get", index: 2 },
      { op: "global.set", index: peerHasIdx },
      { op: "local.get", index: 3 },
      { op: "global.set", index: peerIsNullIdx },
      { op: "local.get", index: 4 },
      { op: "global.set", index: peerMethodCallIdx },
    ],
  );
  return { get, keys, has, ownedGlobal: ownedIdx, methodCall };
}

/**
 * CONSUMER side, step 1 of 2. Define the normalising terminals this module will
 * install into its provider, and register the setter import.
 *
 * The normalisation is the same one `emitStandaloneLinkBoundaryTerminals` does
 * in the forward direction and for the same reason: `null` has to mean "not
 * mine", so the provider can tell a real answer from a miss instead of adopting
 * a foreign module's `undefined` singleton (whose identity is not the
 * provider's) or an empty key vec that would out-rank the provider's own.
 *
 * Called from the end of `ensureObjectRuntime` — every terminal it wraps has
 * just been registered — and before the index-space freeze, which the import
 * needs.
 */
export function emitStandaloneLinkReverseLocalTerminals(ctx: CodegenContext): void {
  const namespace = peerNamespace(ctx);
  if (namespace === undefined) return;
  if (ctx.funcMap.has(LINK_REVERSE_PEER.localGet)) return;
  const externGet = ctx.funcMap.get("__extern_get");
  const isUndefined = ctx.funcMap.get("__extern_is_undefined");
  const objectKeys = ctx.funcMap.get("__object_keys");
  const externLength = ctx.funcMap.get("__extern_length");
  if (externGet === undefined || isUndefined === undefined) return;
  if (objectKeys === undefined || externLength === undefined) return;

  define(
    ctx,
    LINK_REVERSE_PEER.localGet,
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
  define(
    ctx,
    LINK_REVERSE_PEER.localKeys,
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

  // `localHas` answers the host lane's tri-state (`PRESENT` / not-mine), which
  // is what makes a `null` VALUE distinguishable from an absent key on the
  // provider side. `__extern_has` answers 0 both for "not mine" and for "mine
  // and absent"; collapsing those two is sound here because the provider's
  // continuation for either is the same miss path.
  const externHas = ctx.funcMap.get("__extern_has");
  if (externHas !== undefined) {
    define(
      ctx,
      LINK_REVERSE_PEER.localHas,
      [EXTERNREF, EXTERNREF],
      [I32],
      [],
      [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: externHas },
        {
          op: "if",
          blockType: { kind: "val", type: I32 },
          then: [{ op: "i32.const", value: PRESENT }],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
    );
  }

  // The null-vs-absent oracle, and the ONLY place the question can be answered:
  // the raw `__extern_get` answer is `ref.null.extern` exactly for a property
  // whose VALUE is `null` (an absent key answers the undefined singleton), and
  // only this module can see that answer before the wrapper normalises it. The
  // `__extern_has` conjunct is what keeps a receiver NEITHER module owns out —
  // there `has` is 0, so the provider keeps falling through to its own miss
  // path and answers `undefined`, exactly as before.
  if (externHas !== undefined) {
    define(
      ctx,
      LINK_REVERSE_PEER.localIsNull,
      [EXTERNREF, EXTERNREF],
      [I32],
      [],
      [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: externGet },
        { op: "ref.is_null" },
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: externHas },
        { op: "i32.and" },
      ],
    );
  }

  // (#6483) The CALL twin of `localGet` — and it delegates to this module's own
  // `__extern_method_call` rather than composing `__extern_get` +
  // `__apply_closure` by hand.
  //
  // That distinction is measured, not stylistic. The hand-composed version
  // dispatched but did NOT bind the receiver for an object-LITERAL method:
  // `{ v: 42, readSelf() { return this.v; } }` answered `NaN` through the hop
  // and `42` in a single module (`.tmp/s18/c10-new.out`) — a silent wrong value
  // where the base tree threw. A class instance bound correctly either way,
  // which is what localised it to the literal-method closure's `this`, supplied
  // by machinery `__apply_closure` alone does not run. Delegating keeps ONE
  // method-call semantics in this module instead of a second, subtly different
  // copy.
  //
  // The `__extern_get` pre-check stays, and is what preserves the channel's
  // contract: `__extern_method_call` THROWS on an absent member (§7.3.14, the
  // #4221/#4656 guard), and a receiver this module does not own must answer
  // `ref.null.extern` = "not mine" so the PROVIDER keeps its own miss path
  // rather than eating a foreign TypeError. Cost: a member that resolves is
  // resolved twice, so an accessor runs twice on this path — stated rather than
  // hidden, and only on a path that previously always threw.
  const applyClosure = ctx.funcMap.get("__apply_closure");
  if (applyClosure !== undefined) {
    const thisGlobalIdx = ensureCurrentThisGlobal(ctx);
    define(
      ctx,
      LINK_REVERSE_PEER.localMethodCall,
      [EXTERNREF, EXTERNREF, EXTERNREF],
      [EXTERNREF],
      [
        { name: "m", type: EXTERNREF },
        { name: "prevThis", type: EXTERNREF },
        { name: "result", type: EXTERNREF },
      ],
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
        { op: "global.get", index: thisGlobalIdx },
        { op: "local.set", index: 4 },
        { op: "local.get", index: 0 },
        { op: "global.set", index: thisGlobalIdx },
        {
          op: "try",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: 3 },
            { op: "local.get", index: 0 },
            { op: "local.get", index: 2 },
            { op: "call", funcIdx: applyClosure },
            { op: "local.set", index: 5 },
          ],
          catches: [],
          catchAll: [
            { op: "local.get", index: 4 },
            { op: "global.set", index: thisGlobalIdx },
            { op: "rethrow", depth: 0 },
          ],
        },
        { op: "local.get", index: 4 },
        { op: "global.set", index: thisGlobalIdx },
        { op: "local.get", index: 5 },
      ],
    );
  }

  const types = reverseTypes(ctx);
  ensureLateImport(
    ctx,
    LINK_REVERSE_PEER.install,
    [types.getRef, types.keysRef, types.hasRef, types.isNullRef, types.methodCallRef],
    [],
    namespace,
  );
  flushLateImportShifts(ctx, null);
}

/**
 * The `__extern_get` miss arm for the PROVIDER side.
 *
 * Deliberately NOT the shape the host/forward arm uses. That arm reads a null
 * answer as "the peer does not own this receiver" — and on this side a null
 * answer is ambiguous, because a bag field whose VALUE is `null` comes back as
 * the same `ref.null.extern`. Collapsing the two made `{ calendar: null }` read
 * as an absent `calendar` inside the provider, which is a WRONG ANSWER rather
 * than a missing one: the polyfill's `!== undefined` guard admitted it and
 * three `*-propertybag-calendar-wrong-type` rows stopped throwing.
 *
 * So the null case is decided by the second channel the hop just filled:
 * `owned == 1` means the consumer owns the receiver AND the key is present, so
 * the null IS the answer and the arm returns it; `owned == 0` falls through to
 * this module's own miss path exactly as before.
 *
 * The forward arm is left untouched, so the JS-host and consumer lanes are
 * byte-identical.
 */
export function reverseGetArmInstrs(hops: ReversePeerHops, resultLocal: number): Instr[] {
  if (hops.get === undefined || hops.ownedGlobal === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: hops.get },
    { op: "local.tee", index: resultLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "global.get", index: hops.ownedGlobal },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: resultLocal }, { op: "return" }],
        },
      ],
      else: [{ op: "local.get", index: resultLocal }, { op: "return" }],
    },
  ];
}

/**
 * (#6483) The `__extern_method_call` miss arm for the PROVIDER side.
 *
 * DELIBERATELY NOT shaped like `reverseGetArmInstrs`. That arm adopts a null
 * answer as the value when the peer says it owns the receiver and the key is
 * present, because for a READ those two facts settle it. For a CALL they do
 * not: the hop also answers null when the consumer resolved the method and its
 * own `__apply_closure` declined to dispatch it, and adopting THAT null turns a
 * correct TypeError into a silent wrong value. Measured on the first cut of this
 * slice (`.tmp/s18/witness-new.out`): `o.add(3, 4)` became `null` and
 * `this.v` became `undefined` where both had thrown.
 *
 * So only a NON-NULL answer returns here; every other case falls through to the
 * pre-#6483 miss path unchanged. That makes this arm strictly throw-reducing and
 * never answer-changing.
 *
 * Takes the SAME slot as the forward peer / host-boundary call arm, so a module
 * that has one of those never emits this one (a provider has no peer to ask and
 * a consumer has no reverse channel — `isProvider` and `peerNamespace` are
 * mutually exclusive by construction).
 */
export function reverseMethodCallArmInstrs(hops: ReversePeerHops, resultLocal: number): Instr[] {
  if (hops.methodCall === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: hops.methodCall },
    { op: "local.tee", index: resultLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: resultLocal }, { op: "return" }],
    },
  ];
}

/**
 * FINALIZE, both sides.
 *
 * Provider: publish the setter under its ABI name, resolving the index through
 * `funcMap` because every late import shifted it since registration.
 *
 * Consumer: prepend `install(ref.func localGet, ref.func localKeys)` to
 * `__module_init`. `applyModuleInitGuard` prepends `call __module_init` to every
 * exported function on this lane, so the channel is live before any consumer
 * entry point runs — and the provider's own init cannot need it (nothing of the
 * consumer's exists yet when the provider is instantiated).
 *
 * A consumer with no module initializer at all installs nothing and keeps
 * today's answer, rather than installing somewhere unordered.
 */
export function finalizeStandaloneLinkReversePeer(ctx: CodegenContext): void {
  if (isProvider(ctx)) {
    const index = ctx.funcMap.get(LINK_REVERSE_PEER.install);
    if (index === undefined) return;
    if (ctx.mod.exports.some((entry) => entry.name === LINK_REVERSE_PEER.install)) return;
    ctx.mod.exports.push({ name: LINK_REVERSE_PEER.install, desc: { kind: "func", index } });
    return;
  }
  if (peerNamespace(ctx) === undefined) return;
  const installIdx = ctx.funcMap.get(LINK_REVERSE_PEER.install);
  const localGetIdx = ctx.funcMap.get(LINK_REVERSE_PEER.localGet);
  const localKeysIdx = ctx.funcMap.get(LINK_REVERSE_PEER.localKeys);
  const localHasIdx = ctx.funcMap.get(LINK_REVERSE_PEER.localHas);
  const localIsNullIdx = ctx.funcMap.get(LINK_REVERSE_PEER.localIsNull);
  const localMethodCallIdx = ctx.funcMap.get(LINK_REVERSE_PEER.localMethodCall);
  if (installIdx === undefined || localGetIdx === undefined || localKeysIdx === undefined) return;
  if (localHasIdx === undefined || localIsNullIdx === undefined || localMethodCallIdx === undefined) return;
  const initFn = ctx.programAbiModuleInitCallables?.firstFunction();
  if (!initFn) return;
  for (const handle of [localGetIdx, localKeysIdx, localHasIdx, localIsNullIdx, localMethodCallIdx]) {
    if (!ctx.mod.declaredFuncRefs.includes(handle)) ctx.mod.declaredFuncRefs.push(handle);
  }
  // A consumer that could not build BOTH terminals installs neither (the guard
  // above), so the provider keeps answering exactly what it answered before this
  // module existed.
  initFn.body = [
    { op: "ref.func", funcIdx: localGetIdx },
    { op: "ref.func", funcIdx: localKeysIdx },
    { op: "ref.func", funcIdx: localHasIdx },
    { op: "ref.func", funcIdx: localIsNullIdx },
    { op: "ref.func", funcIdx: localMethodCallIdx },
    { op: "call", funcIdx: installIdx },
    ...initFn.body,
  ];
}
