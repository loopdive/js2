// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5268 step 2) §7.3.16 SetIntegrityLevel / §7.3.17 TestIntegrityLevel over a
 * `$Proxy` receiver, under `--target standalone`.
 *
 * ## What was missing
 *
 * `__object_freeze` / `__object_seal` are FLAG-SETTING natives: they OR a bit
 * word onto the receiver's `$Object` and clear the per-entry descriptor flags.
 * That is the whole of SetIntegrityLevel for an ordinary object, and none of it
 * for a Proxy — whose integrity is defined entirely in terms of trap calls
 * (`preventExtensions`, then `[[OwnPropertyKeys]]`, then a
 * `[[DefineOwnProperty]]` per key). Worse, a `$Proxy` receiver fell into the
 * #4032 carrier-BAG arm — which does not even own a slot for it
 * (`__integrity_bag` answers null for a `$Proxy`; it covers the vec, closure and
 * Error carriers only) — and the traps never fired: `Object.freeze(new Proxy({}, {preventExtensions(){
 * throw … }}))` completed normally. The predicates `__object_isFrozen` /
 * `__object_isSealed` had the mirror-image gap.
 *
 * ## Shape
 *
 * Two new natives hold the algorithms once — `__proxy_set_integrity(p, frozen)`
 * and `__proxy_test_integrity(p, frozen)` — so each of the SIX call-site fills
 * is an eight-instruction front-guard rather than a copy of the loop. Both are
 * composed from the `__proxy_*_dispatch` helpers `object-runtime-proxy.ts`
 * already registers, so every trap invocation, revoked-proxy check and
 * trap-absent forward is the existing one.
 *
 * ## The key list, and why it is not just one dispatch call
 *
 * `__proxy_ownkeys_names_dispatch` returns the raw `ownKeys` TRAP result when a
 * trap is present — strings and symbols alike, which is what §10.5.11 wants.
 * With NO trap it forwards to `__getOwnPropertyNames(target)`, which is
 * string-keyed only; `freeze/proxy-no-ownkeys-returned-keys-order.js` asserts
 * the symbol key IS visited (expected order `["0", "foo", sym]`). So the
 * trap-absent case appends the target's own symbol keys. Deciding between the
 * two needs the `$ProxyTraps` slot directly, which is why the field indices
 * below are duplicated here rather than imported (the same ESM-cycle-free
 * duplication `native-proto-instance-method-read.ts` documents for
 * `WRAPPER_PRIMITIVE_KEY`).
 *
 * ## Descriptor shape is asserted, not incidental
 *
 * `freeze/proxy-with-defineProperty-handler.js` reads the descriptor the trap
 * received: for a data property `{writable: false, configurable: false}` with
 * `value` and `enumerable` ABSENT, and for an accessor `{configurable: false}`
 * alone. The builder below adds exactly those keys and no others.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/**
 * `$Proxy` / `$ProxyTraps` field indices. MUST equal the constants in
 * `object-runtime-proxy.ts`; duplicated to keep this module import-free of it.
 */
const F_PTARGET = 1;
const F_PTRAPS = 3;
const TRAP_GOPD = 5;
const TRAP_OWNKEYS = 10;
const TRAP_DEFINE = 11;

interface IntegrityProxyDeps {
  isTruthy: number;
  prevext: number;
  isext: number;
  gopd: number;
  define: number;
  ownKeysNames: number;
  proxyGet: number;
  typeofString: number;
  externLength: number;
  externGetIdx: number;
  externGet: number;
  externSet: number;
  externIsUndefined: number;
  newPlainObject: number;
  boxBoolean: number;
  getOwnPropertySymbols: number;
  objVecNew: number;
  objVecPush: number;
}

function resolveDeps(ctx: CodegenContext): IntegrityProxyDeps | undefined {
  const names = [
    "__is_truthy",
    "__proxy_prevext_dispatch",
    "__proxy_isext_dispatch",
    "__proxy_gopd_dispatch",
    "__proxy_define_dispatch",
    "__proxy_ownkeys_names_dispatch",
    "__proxy_get_dispatch",
    "__typeof_string",
    "__extern_length",
    "__extern_get_idx",
    "__extern_get",
    "__extern_set",
    "__extern_is_undefined",
    "__new_plain_object",
    "__box_boolean",
    "__getOwnPropertySymbols",
    "__objvec_new",
    "__objvec_push",
  ] as const;
  const idxs = names.map((name) => ctx.funcMap.get(name));
  if (idxs.some((idx) => idx === undefined)) return undefined;
  const [
    isTruthy,
    prevext,
    isext,
    gopd,
    define,
    ownKeysNames,
    proxyGet,
    typeofString,
    externLength,
    externGetIdx,
    externGet,
    externSet,
    externIsUndefined,
    newPlainObject,
    boxBoolean,
    getOwnPropertySymbols,
    objVecNew,
    objVecPush,
  ] = idxs as number[];
  return {
    isTruthy: isTruthy!,
    prevext: prevext!,
    isext: isext!,
    gopd: gopd!,
    define: define!,
    ownKeysNames: ownKeysNames!,
    proxyGet: proxyGet!,
    typeofString: typeofString!,
    externLength: externLength!,
    externGetIdx: externGetIdx!,
    externGet: externGet!,
    externSet: externSet!,
    externIsUndefined: externIsUndefined!,
    newPlainObject: newPlainObject!,
    boxBoolean: boxBoolean!,
    getOwnPropertySymbols: getOwnPropertySymbols!,
    objVecNew: objVecNew!,
    objVecPush: objVecPush!,
  };
}

/** `(externref) -> i32`: null OR the undefined singleton. */
function absentInstrs(local: number, d: IntegrityProxyDeps): Instr[] {
  return [
    { op: "local.get", index: local },
    { op: "ref.is_null" },
    { op: "local.get", index: local },
    { op: "call", funcIdx: d.externIsUndefined },
    { op: "i32.or" },
  ];
}

/**
 * `__proxy_own_keys_all(p) -> externref` — §10.5.11 [[OwnPropertyKeys]] as a
 * list this module can index. See the module header for why the trap-absent
 * case has to append the target's symbol keys.
 *
 * params: 0=p ; locals: 1=keys 2=syms 3=out 4=n 5=i
 */
function ensureProxyOwnKeysAll(ctx: CodegenContext, proxyTypeIdx: number, proxyTrapsTypeIdx: number): number {
  const cached = ctx.funcMap.get("__proxy_own_keys_all");
  if (cached !== undefined) return cached;
  const d = resolveDeps(ctx);
  if (!d) return -1;

  const P = 0;
  const KEYS = 1;
  const SYMS = 2;
  const OUT = 3;
  const N = 4;
  const I = 5;

  /** Append every element of `srcLocal` to the `$ObjVec` in `OUT`. */
  const appendAll = (srcLocal: number): Instr[] => [
    { op: "local.get", index: srcLocal },
    { op: "call", funcIdx: d.externLength },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: N },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "local.get", index: N },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: OUT },
            { op: "local.get", index: srcLocal },
            { op: "local.get", index: I },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: d.externGetIdx },
            { op: "call", funcIdx: d.objVecPush },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];

  const body: Instr[] = [
    { op: "local.get", index: P },
    { op: "local.get", index: P },
    { op: "call", funcIdx: d.ownKeysNames },
    { op: "local.set", index: KEYS },
    // An `ownKeys` TRAP already answered with the complete key set.
    { op: "local.get", index: P },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: proxyTypeIdx },
    { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        { op: "local.get", index: P },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: proxyTypeIdx },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: TRAP_OWNKEYS },
        { op: "ref.is_null" },
      ],
    },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // No trap: the forward answered string names only. Append the target's
        // own SYMBOL keys so the list is §10.5.11's full key set.
        { op: "local.get", index: P },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: proxyTypeIdx },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: d.getOwnPropertySymbols },
        { op: "local.set", index: SYMS },
        { op: "call", funcIdx: d.objVecNew },
        { op: "local.set", index: OUT },
        ...appendAll(KEYS),
        ...appendAll(SYMS),
        { op: "local.get", index: OUT },
        { op: "local.set", index: KEYS },
      ],
    },
    { op: "local.get", index: KEYS },
  ];

  const typeIdx = addFuncType(ctx, [EXTERNREF], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__proxy_own_keys_all", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__proxy_own_keys_all",
    typeIdx,
    locals: [
      { name: "keys", type: EXTERNREF },
      { name: "syms", type: EXTERNREF },
      { name: "out", type: EXTERNREF },
      { name: "n", type: I32 },
      { name: "i", type: I32 },
    ],
    body,
    exported: false,
  } as WasmFunction);
  return funcIdx;
}

/**
 * `__proxy_set_integrity(p, frozen) -> externref` (returns `p`) — §7.3.16.
 *
 * params: 0=p 1=frozen ; locals: 2=keys 3=n 4=i 5=k 6=desc(current) 7=out
 *         8=isAccessor
 */
function ensureProxySetIntegrity(
  ctx: CodegenContext,
  ownKeysAllIdx: number,
  proxyTypeIdx: number,
  proxyTrapsTypeIdx: number,
): number {
  const cached = ctx.funcMap.get("__proxy_set_integrity");
  if (cached !== undefined) return cached;
  const d = resolveDeps(ctx);
  if (!d) return -1;

  for (const key of ["configurable", "writable", "get", "set"]) addStringConstantGlobal(ctx, key);
  const throwNotExtensible = buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot freeze or seal this object", {
    forceInModuleCtor: true,
  });

  const P = 0;
  const FROZEN = 1;
  const KEYS = 2;
  const N = 3;
  const I = 4;
  const K = 5;
  const CUR = 6;
  const OUT = 7;
  const IS_ACCESSOR = 8;
  const HAS_DEFINE_TRAP = 9;

  const setFalse = (key: string): Instr[] => [
    { op: "local.get", index: OUT },
    ...stringConstantExternrefInstrs(ctx, key),
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: d.boxBoolean },
    { op: "call", funcIdx: d.externSet },
  ];

  const loopBody: Instr[] = [
    { op: "local.get", index: I },
    { op: "local.get", index: N },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: KEYS },
    { op: "local.get", index: I },
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: d.externGetIdx },
    { op: "local.set", index: K },
    // Advance FIRST, so a `continue` is a bare branch to the loop header.
    { op: "local.get", index: I },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: I },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: IS_ACCESSOR },
    { op: "local.get", index: FROZEN },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // frozen: currentDesc = O.[[GetOwnProperty]](k); absent ⇒ skip the key.
        { op: "local.get", index: P },
        { op: "local.get", index: K },
        { op: "local.get", index: P },
        { op: "call", funcIdx: d.gopd },
        { op: "local.set", index: CUR },
        ...absentInstrs(CUR, d),
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "br", depth: 2 }] },
        // IsAccessorDescriptor — either half present.
        { op: "local.get", index: CUR },
        ...stringConstantExternrefInstrs(ctx, "get"),
        { op: "call", funcIdx: d.externGet },
        { op: "call", funcIdx: d.externIsUndefined },
        { op: "i32.eqz" },
        { op: "local.get", index: CUR },
        ...stringConstantExternrefInstrs(ctx, "set"),
        { op: "call", funcIdx: d.externGet },
        { op: "call", funcIdx: d.externIsUndefined },
        { op: "i32.eqz" },
        { op: "i32.or" },
        { op: "local.set", index: IS_ACCESSOR },
      ],
    },
    // (#5268 review F3) The per-key [[DefineOwnProperty]] is forwarded ONLY
    // when the proxy actually has a `defineProperty` trap. Without one,
    // `__proxy_define_dispatch` forwards to `__obj_define_from_desc` on the
    // TARGET — and on a closed-struct target that APPENDS a duplicate own-key
    // entry instead of updating in place, so `Object.freeze(new Proxy({a:1,
    // b:2}, {}))` left `Reflect.ownKeys(target)` reading `a,b,a,b` (measured;
    // base and node both say `a,b`) while the target was not frozen at all,
    // and a later `Object.isFrozen(proxy)` threw on the duplicate-key
    // invariant. With no trap the define is UNOBSERVABLE — it is an internal
    // operation on the target — so the loop skips it and the tail below
    // applies the ordinary flag mutator to the target ONCE, which is what
    // actually freezes it. The `getOwnPropertyDescriptor` trap above still
    // fires per key in ownKeys order, which is what
    // `proxy-no-ownkeys-returned-keys-order.js` asserts.
    { op: "local.get", index: HAS_DEFINE_TRAP },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "call", funcIdx: d.newPlainObject },
        { op: "local.set", index: OUT },
        ...setFalse("configurable"),
        { op: "local.get", index: FROZEN },
        { op: "local.get", index: IS_ACCESSOR },
        { op: "i32.eqz" },
        { op: "i32.and" },
        { op: "if", blockType: { kind: "empty" }, then: setFalse("writable") },
        { op: "local.get", index: P },
        { op: "local.get", index: K },
        { op: "local.get", index: OUT },
        { op: "call", funcIdx: d.define },
        { op: "drop" },
      ],
    },
    { op: "br", depth: 0 },
  ];

  const body: Instr[] = [
    // 1/2. status = O.[[PreventExtensions]]() ; false ⇒ TypeError. An abrupt
    //      trap completion propagates out of the dispatch itself.
    { op: "local.get", index: P },
    { op: "local.get", index: P },
    { op: "call", funcIdx: d.prevext },
    { op: "call", funcIdx: d.isTruthy },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwNotExtensible },
    // (#5268 review F3) hasDefineTrap = p.ptraps !== null && p.ptraps.define !== null
    { op: "local.get", index: P },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: proxyTypeIdx },
    { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: P },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: proxyTypeIdx },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: TRAP_DEFINE },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
      ],
    },
    { op: "local.set", index: HAS_DEFINE_TRAP },
    { op: "local.get", index: P },
    { op: "call", funcIdx: ownKeysAllIdx },
    { op: "local.set", index: KEYS },
    { op: "local.get", index: KEYS },
    { op: "call", funcIdx: d.externLength },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: N },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
    },
    // (#5268 review F3) Answer `0` = "the caller must ALSO run its ordinary
    // flag path". This helper owns the spec-VISIBLE half of §7.3.16 — the
    // `preventExtensions` abrupt, the `[[OwnPropertyKeys]]` call, the per-key
    // `[[GetOwnProperty]]` and, when a trap exists, the per-key
    // `[[DefineOwnProperty]]`. It deliberately does NOT own where this compiler
    // RECORDS the level. For a `$Proxy` receiver that is NOT the #4032 bag —
    // `__integrity_bag` answers null for one — it is the COMPILE-TIME integrity
    // fold at the call site (`frozenVars` / `sealedVars` / `nonExtensibleVars`,
    // object-ops.ts), with the mutator's non-`$Object` terminal behind it. That
    // is exactly what base answered, so running the ordinary body too keeps
    // base's verdicts instead of replacing them with a per-key one a
    // closed-struct target cannot support. (#5268 review R2-5 corrected this
    // comment: an earlier draft credited the bag.)
    { op: "i32.const", value: 0 },
  ];

  const typeIdx = addFuncType(ctx, [EXTERNREF, I32], [I32]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__proxy_set_integrity", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__proxy_set_integrity",
    typeIdx,
    locals: [
      { name: "keys", type: EXTERNREF },
      { name: "n", type: I32 },
      { name: "i", type: I32 },
      { name: "k", type: EXTERNREF },
      { name: "cur", type: EXTERNREF },
      { name: "out", type: EXTERNREF },
      { name: "isAccessor", type: I32 },
      { name: "hasDefineTrap", type: I32 },
    ],
    body,
    exported: false,
  } as WasmFunction);
  return funcIdx;
}

/**
 * `__proxy_test_integrity(p, frozen) -> i32` — §7.3.17.
 *
 * params: 0=p 1=frozen ; locals: 2=keys 3=n 4=i 5=k 6=desc
 */
function ensureProxyTestIntegrity(
  ctx: CodegenContext,
  ownKeysAllIdx: number,
  proxyTypeIdx: number,
  proxyTrapsTypeIdx: number,
): number {
  const cached = ctx.funcMap.get("__proxy_test_integrity");
  if (cached !== undefined) return cached;
  const d = resolveDeps(ctx);
  if (!d) return -1;
  for (const key of ["configurable", "writable", "get", "set"]) addStringConstantGlobal(ctx, key);

  const P = 0;
  const FROZEN = 1;
  const KEYS = 2;
  const N = 3;
  const I = 4;
  const K = 5;
  const CUR = 6;
  const HAS_DEFINE_TRAP = 7;
  const NO_GOPD_TRAP = 8;

  const readTruthy = (key: string): Instr[] => [
    { op: "local.get", index: CUR },
    ...stringConstantExternrefInstrs(ctx, key),
    { op: "call", funcIdx: d.externGet },
    { op: "call", funcIdx: d.isTruthy },
  ];

  const loopBody: Instr[] = [
    { op: "local.get", index: I },
    { op: "local.get", index: N },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: KEYS },
    { op: "local.get", index: I },
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: d.externGetIdx },
    { op: "local.set", index: K },
    { op: "local.get", index: I },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: I },
    { op: "local.get", index: P },
    { op: "local.get", index: K },
    { op: "local.get", index: P },
    { op: "call", funcIdx: d.gopd },
    { op: "local.set", index: CUR },
    ...absentInstrs(CUR, d),
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // A configurable own property means the level was not reached — but
        // only VOTE on it when the level was actually recorded per key, i.e.
        // when a `defineProperty` trap took the writes (#5268 review F3). With
        // no such trap the loop runs purely for its observable trap calls and
        // the verdict is deferred to the ordinary reader below.
        ...readTruthy("configurable"),
        { op: "local.get", index: HAS_DEFINE_TRAP },
        { op: "i32.and" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
        // …and, for `frozen`, a WRITABLE data property.
        { op: "local.get", index: FROZEN },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...readTruthy("get"),
            ...readTruthy("set"),
            { op: "i32.or" },
            { op: "i32.eqz" },
            ...readTruthy("writable"),
            { op: "i32.and" },
            { op: "local.get", index: HAS_DEFINE_TRAP },
            { op: "i32.and" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
          ],
        },
      ],
    },
    { op: "br", depth: 0 },
  ];

  const body: Instr[] = [
    // (#5268 review F3) With NO `getOwnPropertyDescriptor` trap the per-key
    // loop below is unobservable, and its verdict is only as good as the
    // descriptor the forward reports. On a CLOSED-STRUCT target that descriptor
    // still reads `configurable: true` after a freeze — this compiler records a
    // closed carrier's integrity outside its per-entry flags — so the loop
    // answered `false` for a genuinely frozen proxy where base and node both
    // say `true` (measured: all six of the frozen/sealed × isFrozen/isSealed
    // cells flipped to `false`). Defer to the ordinary body instead, whose
    // answer for a `$Proxy` comes from the compile-time integrity fold at the
    // call site. A gopd trap keeps the spec loop, so
    // `isFrozen/proxy-no-ownkeys-returned-keys-order.js` (which asserts the
    // trap fires per key, in ownKeys order) is untouched.
    { op: "local.get", index: P },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: proxyTypeIdx },
    { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        { op: "local.get", index: P },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: proxyTypeIdx },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: TRAP_GOPD },
        { op: "ref.is_null" },
      ],
    },
    // (#5268 review R2-2) Stash the answer instead of returning on it. §7.3.17
    // steps 1 and 3 are OBSERVABLE — `[[IsExtensible]]` and
    // `[[OwnPropertyKeys]]` invoke traps that a program can count, and that can
    // THROW — so returning the "not handled" sentinel here would let
    // `Object.isFrozen(proxy)` skip both. Both calls now happen first, and the
    // sentinel is decided afterwards.
    { op: "local.set", index: NO_GOPD_TRAP },
    // hasDefineTrap — see the two in-loop votes and the tail.
    { op: "local.get", index: P },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: proxyTypeIdx },
    { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: P },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: proxyTypeIdx },
        { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: TRAP_DEFINE },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
      ],
    },
    { op: "local.set", index: HAS_DEFINE_TRAP },
    // 1/2. An extensible object is neither sealed nor frozen. (§7.3.17 step 1 —
    // observable, and it runs even when the verdict will be deferred.)
    { op: "local.get", index: P },
    { op: "local.get", index: P },
    { op: "call", funcIdx: d.isext },
    { op: "call", funcIdx: d.isTruthy },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    // §7.3.17 step 3 — also observable, same reason.
    { op: "local.get", index: P },
    { op: "call", funcIdx: ownKeysAllIdx },
    { op: "local.set", index: KEYS },
    // Only NOW may the deferral be taken: both trap-visible steps have run.
    { op: "local.get", index: NO_GOPD_TRAP },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: -1 }, { op: "return" }],
    },
    { op: "local.get", index: KEYS },
    { op: "call", funcIdx: d.externLength },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: N },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
    },
    // Every key passed — but that verdict is only meaningful when a
    // `defineProperty` trap recorded the level per key. Otherwise the answer
    // belongs to the ordinary body (see R2-5 above: for a `$Proxy` that is the
    // compile-time integrity fold, not the #4032 bag).
    { op: "local.get", index: HAS_DEFINE_TRAP },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 1 }],
      else: [{ op: "i32.const", value: -1 }],
    },
  ];

  const typeIdx = addFuncType(ctx, [EXTERNREF, I32], [I32]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__proxy_test_integrity", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__proxy_test_integrity",
    typeIdx,
    locals: [
      { name: "keys", type: EXTERNREF },
      { name: "n", type: I32 },
      { name: "i", type: I32 },
      { name: "k", type: EXTERNREF },
      { name: "cur", type: EXTERNREF },
      { name: "hasDefineTrap", type: I32 },
      { name: "noGopdTrap", type: I32 },
    ],
    body,
    exported: false,
  } as WasmFunction);
  return funcIdx;
}

/**
 * `__proxy_enumerable_own(p, entries) -> externref` — §7.3.25
 * EnumerableOwnProperties over a Proxy: `[[OwnPropertyKeys]]`, then per STRING
 * key `[[GetOwnProperty]]`, skip absent/non-enumerable, then `[[Get]]`.
 * `entries` selects the `[key, value]` pair shape (`Object.entries`) over the
 * bare value (`Object.values`).
 *
 * The trap ORDER is the assertion in `{values,entries}/observable-operations.js`
 * — `ownKeys`, then `getOwnPropertyDescriptor:a`, `get:a`, … — so the two reads
 * are interleaved per key rather than batched.
 *
 * params: 0=p 1=entries ; locals: 2=keys 3=n 4=i 5=k 6=desc 7=out 8=pair
 */
function ensureProxyEnumerableOwn(ctx: CodegenContext, ownKeysAllIdx: number): number {
  const cached = ctx.funcMap.get("__proxy_enumerable_own");
  if (cached !== undefined) return cached;
  const d = resolveDeps(ctx);
  if (!d) return -1;
  addStringConstantGlobal(ctx, "enumerable");

  const P = 0;
  const ENTRIES = 1;
  const KEYS = 2;
  const N = 3;
  const I = 4;
  const K = 5;
  const CUR = 6;
  const OUT = 7;
  const PAIR = 8;

  const loopBody: Instr[] = [
    { op: "local.get", index: I },
    { op: "local.get", index: N },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: KEYS },
    { op: "local.get", index: I },
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: d.externGetIdx },
    { op: "local.set", index: K },
    { op: "local.get", index: I },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: I },
    // §7.3.25 step 4: STRING keys only — a symbol key is skipped outright.
    { op: "local.get", index: K },
    { op: "call", funcIdx: d.typeofString },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: P },
    { op: "local.get", index: K },
    { op: "local.get", index: P },
    { op: "call", funcIdx: d.gopd },
    { op: "local.set", index: CUR },
    ...absentInstrs(CUR, d),
    { op: "br_if", depth: 0 },
    { op: "local.get", index: CUR },
    ...stringConstantExternrefInstrs(ctx, "enumerable"),
    { op: "call", funcIdx: d.externGet },
    { op: "call", funcIdx: d.isTruthy },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    // value = O.[[Get]](k, O)
    { op: "local.get", index: ENTRIES },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "call", funcIdx: d.objVecNew },
        { op: "local.set", index: PAIR },
        { op: "local.get", index: PAIR },
        { op: "local.get", index: K },
        { op: "call", funcIdx: d.objVecPush },
        { op: "local.get", index: PAIR },
        { op: "local.get", index: P },
        { op: "local.get", index: K },
        { op: "local.get", index: P },
        { op: "call", funcIdx: d.proxyGet },
        { op: "call", funcIdx: d.objVecPush },
        { op: "local.get", index: OUT },
        { op: "local.get", index: PAIR },
        { op: "call", funcIdx: d.objVecPush },
      ],
      else: [
        { op: "local.get", index: OUT },
        { op: "local.get", index: P },
        { op: "local.get", index: K },
        { op: "local.get", index: P },
        { op: "call", funcIdx: d.proxyGet },
        { op: "call", funcIdx: d.objVecPush },
      ],
    },
    { op: "br", depth: 0 },
  ];

  const body: Instr[] = [
    { op: "call", funcIdx: d.objVecNew },
    { op: "local.set", index: OUT },
    { op: "local.get", index: P },
    { op: "call", funcIdx: ownKeysAllIdx },
    { op: "local.set", index: KEYS },
    { op: "local.get", index: KEYS },
    { op: "call", funcIdx: d.externLength },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: N },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
    },
    { op: "local.get", index: OUT },
  ];

  const typeIdx = addFuncType(ctx, [EXTERNREF, I32], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__proxy_enumerable_own", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__proxy_enumerable_own",
    typeIdx,
    locals: [
      { name: "keys", type: EXTERNREF },
      { name: "n", type: I32 },
      { name: "i", type: I32 },
      { name: "k", type: EXTERNREF },
      { name: "cur", type: EXTERNREF },
      { name: "out", type: EXTERNREF },
      { name: "pair", type: EXTERNREF },
    ],
    body,
    exported: false,
  } as WasmFunction);
  return funcIdx;
}

/**
 * Prepend the `$Proxy` front-guard to the six integrity natives. Each guard is
 * a FACTORY: the same shape is installed on six different bodies, and one
 * shared `Instr[]` would be remapped once per containing body by the finalize
 * walks (#5188 followUp 4).
 *
 * Called from the object-runtime finalize slot that also fills
 * `fillObjectAssignProxySourceArm`, i.e. after the Proxy dispatch helpers and
 * their front-guards exist.
 */
export function fillObjectIntegrityProxyArms(ctx: CodegenContext, proxyTypeIdx: number): void {
  if (!ctx.standalone) return;
  const proxyTrapsTypeIdx = ctx.objectRuntimeTypes?.proxyTrapsTypeIdx;
  if (proxyTrapsTypeIdx === undefined) return;
  const ownKeysAllIdx = ensureProxyOwnKeysAll(ctx, proxyTypeIdx, proxyTrapsTypeIdx);
  if (ownKeysAllIdx < 0) return;
  const setIdx = ensureProxySetIntegrity(ctx, ownKeysAllIdx, proxyTypeIdx, proxyTrapsTypeIdx);
  const testIdx = ensureProxyTestIntegrity(ctx, ownKeysAllIdx, proxyTypeIdx, proxyTrapsTypeIdx);
  const enumIdx = ensureProxyEnumerableOwn(ctx, ownKeysAllIdx);
  if (setIdx < 0 || testIdx < 0 || enumIdx < 0) return;

  /**
   * A FACTORY, never a shared array: the same guard shape is installed on eight
   * different bodies, and one shared `Instr[]` would be remapped once per
   * containing body by the finalize walks (#5188 followUp 4).
   *
   * `kind` selects the helper's answer protocol (#5268 review F3):
   *
   *  - `"integrity"` — `__proxy_set_integrity` returns `0` = "I did the
   *    spec-visible trap work; now ALSO run your ordinary body". It never
   *    returns non-zero today, but the branch is kept so the helper can claim
   *    a receiver outright later without touching eight call sites.
   *  - `"predicate"` — `__proxy_test_integrity` answers `0`/`1`, or `-1` for
   *    "not handled, fall through to the ordinary body". A proxy with no
   *    `getOwnPropertyDescriptor` trap takes that fall-through, because the
   *    per-key verdict is only as good as the forwarded descriptor and a
   *    closed-struct target reports `configurable: true` even when frozen.
   *  - `"enumerate"` — `__proxy_enumerable_own` always owns the answer.
   */
  const guard = (flag: boolean, targetIdx: number, kind: "integrity" | "predicate" | "enumerate"): Instr[] => {
    const call: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "i32.const", value: flag ? 1 : 0 },
      { op: "call", funcIdx: targetIdx },
    ];
    if (kind === "enumerate") {
      return [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: proxyTypeIdx },
        { op: "if", blockType: { kind: "empty" }, then: [...call, { op: "return" }] },
      ];
    }
    if (kind === "integrity") {
      return [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: proxyTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...call,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 0 }, { op: "return" }],
            },
          ],
        },
      ];
    }
    return [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...call,
          { op: "local.tee", index: PREDICATE_SCRATCH },
          { op: "i32.const", value: -1 },
          { op: "i32.ne" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: PREDICATE_SCRATCH }, { op: "return" }],
          },
        ],
      },
    ];
  };

  /**
   * The predicates need one i32 scratch to hold the helper's three-valued
   * answer across the `-1` test. It is APPENDED, so every existing local index
   * in those bodies is unchanged.
   */
  let PREDICATE_SCRATCH = 0;

  const install = (
    name: string,
    flag: boolean,
    targetIdx: number,
    kind: "integrity" | "predicate" | "enumerate",
  ): void => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return;
    const fn = definedFuncAt(ctx, idx);
    if (!fn) return;
    // Idempotence: a second fill would double the guard.
    const first = fn.body[0];
    if (first?.op === "local.get" && first.index === 0 && fn.body[1]?.op === "any.convert_extern") {
      const test = fn.body[2];
      if (test?.op === "ref.test" && (test as { typeIdx?: number }).typeIdx === proxyTypeIdx) return;
    }
    if (kind === "predicate") {
      PREDICATE_SCRATCH = 1 + fn.locals.length;
      fn.locals.push({ name: "__proxyIntegrityAnswer", type: I32 });
    }
    fn.body.unshift(...guard(flag, targetIdx, kind));
  };

  // The mutators must be guarded ABOVE the #4032 carrier-bag arm, which a
  // `$Proxy` would otherwise fall into silently — `unshift` puts them first.
  install("__object_freeze", true, setIdx, "integrity");
  install("__object_seal", false, setIdx, "integrity");
  install("__object_isFrozen", true, testIdx, "predicate");
  install("__object_isSealed", false, testIdx, "predicate");
  install("__object_isFrozen_obj", true, testIdx, "predicate");
  install("__object_isSealed_obj", false, testIdx, "predicate");
  install("__object_values", false, enumIdx, "enumerate");
  install("__object_entries", true, enumIdx, "enumerate");
}
