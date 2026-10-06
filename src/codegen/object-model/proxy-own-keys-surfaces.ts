// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6770 S7) The surfaces of §10.5.11 Proxy `[[OwnPropertyKeys]]`, under
 * `--target standalone`.
 *
 * ## One key list, filtered by its consumer
 *
 * `__proxy_ownkeys_names_dispatch` answers a proxy's `[[OwnPropertyKeys]]`:
 * with an `ownKeys` trap, the trap's validated list (strings AND symbols, in
 * the trap's order); without one, the forward to the target. The forward used
 * to be `__getOwnPropertyNames(target)` — strings only — so
 * `Reflect.ownKeys(new Proxy(t, {}))` dropped `t`'s symbol keys and the
 * §10.5.11 steps 16-23 reconciliation (`__proxy_inv_ownkeys`) never saw a
 * non-configurable SYMBOL key of the target. {@link ensureOwnKeysAllNative}
 * is the full list of an ordinary object (names, then symbols — §10.1.11.1's
 * order), used as that forward and as the reconciliation's target key set.
 *
 * The consumers then take their part of the one list:
 * - `Object.getOwnPropertyNames(p)` — the strings (§20.1.2.10 GetOwnPropertyKeys
 *   type String), {@link emitProxyKeysFilterAfterCall};
 * - `Object.getOwnPropertySymbols(p)` — the symbols; this surface had NO proxy
 *   arm at all, so none of the ownKeys invariants ran through it;
 * - `Object.keys(p)` — §20.1.2.17 EnumerableOwnProperties: each STRING key whose
 *   `p.[[GetOwnProperty]](key)` (the gopd trap, when present) is a descriptor
 *   with `enumerable: true` ({@link ensureEnumerableOwnKeysNative});
 * - `Reflect.ownKeys(p)` — the list as is (unchanged).
 *
 * Each filter builds a FRESH `$ObjVec`: a trap's list is the user's own array.
 */
import type { Instr, ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { addFuncType } from "../registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "../shared.js";
import { bound } from "./ports.js"; // (#6770/#6797) core helpers, injected — keeps this leaf out of the import SCC

const addStringConstantGlobal = bound("addStringConstantGlobal");
const stringConstantExternrefInstrs = bound("stringConstantExternrefInstrs");
const ensureObjVecBuilders = bound("ensureObjVecBuilders");
const compileObjectLiteral = bound("compileObjectLiteral");
const compileObjectLiteralAsExternref = bound("compileObjectLiteralAsExternref");
const objectLiteralForcesHostPath = bound("objectLiteralForcesHostPath");

const EXTERNREF: ValType = { kind: "externref" };
/** ToBoolean of a descriptor's `enumerable` field — the existing native, looked up by name. */
const TO_BOOLEAN_NATIVE = "__is_truthy";
const I32: ValType = { kind: "i32" };

function mintNative(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
): number {
  const typeIdx = addFuncType(ctx, params, [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });
  return funcIdx;
}

/**
 * `for (i = 0; i < len(src); i++) { e = src[i]; <body> }` over locals — `srcLocal`
 * (externref list), `nLocal`/`iLocal` (i32), `elemLocal` (externref). `each`
 * runs with the element in `elemLocal`. Fresh instructions per call.
 */
function forEachElement(
  lengthIdx: number,
  getIdxIdx: number,
  srcLocal: number,
  nLocal: number,
  iLocal: number,
  elemLocal: number,
  each: Instr[],
): Instr[] {
  return [
    { op: "local.get", index: srcLocal },
    { op: "call", funcIdx: lengthIdx },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: nLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: iLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: iLocal },
            { op: "local.get", index: nLocal },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: srcLocal },
            { op: "local.get", index: iLocal },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: getIdxIdx },
            { op: "local.set", index: elemLocal },
            ...each,
            { op: "local.get", index: iLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: iLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

function listDeps(
  ctx: CodegenContext,
): { length: number; getIdx: number; vecNew: number; vecPush: number } | undefined {
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const length = ctx.funcMap.get("__extern_length");
  const getIdx = ctx.funcMap.get("__extern_get_idx");
  if (length === undefined || getIdx === undefined) return undefined;
  return { length, getIdx, vecNew: newIdx, vecPush: pushIdx };
}

/**
 * `__own_keys_all(o) -> externref` — an ordinary object's full own key list,
 * `__getOwnPropertyNames(o)` then `__getOwnPropertySymbols(o)`, in a fresh
 * `$ObjVec`. Registered on demand by the proxy runtime (its only callers).
 *
 * params 0=o ; locals 1=src 2=out 3=n 4=i 5=e
 */
export function ensureOwnKeysAllNative(ctx: CodegenContext): number | undefined {
  const cached = ctx.funcMap.get("__own_keys_all");
  if (cached !== undefined) return cached;
  const d = listDeps(ctx);
  const names = ctx.funcMap.get("__getOwnPropertyNames");
  const symbols = ctx.funcMap.get("__getOwnPropertySymbols");
  if (d === undefined || names === undefined || symbols === undefined) return undefined;
  const push: Instr[] = [
    { op: "local.get", index: 2 },
    { op: "local.get", index: 5 },
    { op: "call", funcIdx: d.vecPush },
  ];
  return mintNative(
    ctx,
    "__own_keys_all",
    [EXTERNREF],
    [
      { name: "src", type: EXTERNREF },
      { name: "out", type: EXTERNREF },
      { name: "n", type: I32 },
      { name: "i", type: I32 },
      { name: "e", type: EXTERNREF },
    ],
    [
      { op: "call", funcIdx: d.vecNew },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: names },
      { op: "local.set", index: 1 },
      ...forEachElement(d.length, d.getIdx, 1, 3, 4, 5, push),
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: symbols },
      { op: "local.set", index: 1 },
      ...forEachElement(d.length, d.getIdx, 1, 3, 4, 5, [...push]),
      { op: "local.get", index: 2 },
    ],
  );
}

/**
 * `__own_keys_filter(list, wantSymbols) -> externref` — a fresh `$ObjVec` of
 * the list's String (`wantSymbols = 0`) or Symbol (`1`) entries, in order.
 *
 * params 0=list 1=wantSymbols ; locals 2=out 3=n 4=i 5=e
 */
function ensureOwnKeysFilterNative(ctx: CodegenContext): number | undefined {
  const cached = ctx.funcMap.get("__own_keys_filter");
  if (cached !== undefined) return cached;
  const d = listDeps(ctx);
  if (d === undefined) return undefined;
  const symbolTypeIdx = ctx.symbolTypeIdx;
  // Without the `$Symbol` carrier no list can hold a symbol: every entry is a string.
  const isSymbol: Instr[] =
    symbolTypeIdx >= 0
      ? [{ op: "local.get", index: 5 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: symbolTypeIdx }]
      : [{ op: "i32.const", value: 0 }];
  return mintNative(
    ctx,
    "__own_keys_filter",
    [EXTERNREF, I32],
    [
      { name: "out", type: EXTERNREF },
      { name: "n", type: I32 },
      { name: "i", type: I32 },
      { name: "e", type: EXTERNREF },
    ],
    [
      { op: "call", funcIdx: d.vecNew },
      { op: "local.set", index: 2 },
      ...forEachElement(d.length, d.getIdx, 0, 3, 4, 5, [
        ...isSymbol,
        { op: "local.get", index: 1 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 2 },
            { op: "local.get", index: 5 },
            { op: "call", funcIdx: d.vecPush },
          ],
        },
      ]),
      { op: "local.get", index: 2 },
    ],
  );
}

/**
 * `__proxy_enumerable_keys(p, list) -> externref` — §20.1.2.17
 * EnumerableOwnProperties(p, key): for each STRING key of `list` (p's
 * `[[OwnPropertyKeys]]`), `desc = p.[[GetOwnProperty]](key)` through the gopd
 * dispatch (the trap when present), kept iff `desc` is a descriptor whose
 * `enumerable` is truthy. Registered by the proxy runtime for the
 * `Object.keys` dispatch.
 *
 * params 0=p 1=list ; locals 2=out 3=n 4=i 5=e 6=desc
 */
export function ensureEnumerableOwnKeysNative(ctx: CodegenContext): number | undefined {
  const cached = ctx.funcMap.get("__proxy_enumerable_keys");
  if (cached !== undefined) return cached;
  const d = listDeps(ctx);
  const gopd = ctx.funcMap.get("__proxy_gopd_dispatch");
  const externGet = ctx.funcMap.get("__extern_get");
  const isTruthy = ctx.funcMap.get(TO_BOOLEAN_NATIVE);
  const isUndefined = ctx.funcMap.get("__extern_is_undefined");
  const typeofString = ctx.funcMap.get("__typeof_string");
  if (
    d === undefined ||
    gopd === undefined ||
    externGet === undefined ||
    isTruthy === undefined ||
    isUndefined === undefined ||
    typeofString === undefined
  ) {
    return undefined;
  }
  addStringConstantGlobal(ctx, "enumerable");
  return mintNative(
    ctx,
    "__proxy_enumerable_keys",
    [EXTERNREF, EXTERNREF],
    [
      { name: "out", type: EXTERNREF },
      { name: "n", type: I32 },
      { name: "i", type: I32 },
      { name: "e", type: EXTERNREF },
      { name: "desc", type: EXTERNREF },
    ],
    [
      { op: "call", funcIdx: d.vecNew },
      { op: "local.set", index: 2 },
      ...forEachElement(d.length, d.getIdx, 1, 3, 4, 5, [
        { op: "local.get", index: 5 },
        { op: "call", funcIdx: typeofString },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "local.get", index: 5 },
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: gopd },
            { op: "local.tee", index: 6 },
            { op: "ref.is_null" },
            { op: "local.get", index: 6 },
            { op: "call", funcIdx: isUndefined },
            { op: "i32.or" },
            {
              op: "if",
              blockType: { kind: "val", type: I32 },
              then: [{ op: "i32.const", value: 0 }],
              else: [
                { op: "local.get", index: 6 },
                ...stringConstantExternrefInstrs(ctx, "enumerable"),
                { op: "call", funcIdx: externGet },
                { op: "call", funcIdx: isTruthy },
              ],
            },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 2 },
                { op: "local.get", index: 5 },
                { op: "call", funcIdx: d.vecPush },
              ],
            },
          ],
        },
      ]),
      { op: "local.get", index: 2 },
    ],
  );
}

/** Can this module hold a `$Proxy` at all? (It names `Proxy` and has the type.) */
function proxyFilterApplies(ctx: CodegenContext, node: ts.Node): number | undefined {
  const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
  if (!ctx.standalone || proxyTypeIdx === undefined || !node.getSourceFile().text.includes("Proxy")) return undefined;
  return proxyTypeIdx;
}

/**
 * `Object.getOwnPropertyNames(x)` / `Object.getOwnPropertySymbols(x)` over a
 * `$Proxy`: the receiver `x` is on the stack; leaves the answer. For a proxy,
 * `__own_keys_filter(__getOwnPropertyNames(x), wantSymbols)` — the proxy
 * front guard of `__getOwnPropertyNames` answers the whole `[[OwnPropertyKeys]]`
 * list; otherwise the ordinary `ordinaryName` native. Returns `false` (nothing
 * emitted) when the module cannot hold a proxy.
 */
export function emitProxyAwareOwnKeysCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  node: ts.Node,
  wantSymbols: boolean,
): boolean {
  const proxyTypeIdx = proxyFilterApplies(ctx, node);
  if (proxyTypeIdx === undefined) return false;
  const ordinaryName = wantSymbols ? "__getOwnPropertySymbols" : "__getOwnPropertyNames";
  ensureLateImport(ctx, "__getOwnPropertyNames", [EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, ordinaryName, [EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  const filterIdx = ensureOwnKeysFilterNative(ctx);
  flushLateImportShifts(ctx, fctx);
  const namesIdx = ctx.funcMap.get("__getOwnPropertyNames");
  const ordinaryIdx = ctx.funcMap.get(ordinaryName);
  if (filterIdx === undefined || namesIdx === undefined || ordinaryIdx === undefined) return false;
  const recv = allocLocal(fctx, `__okf_recv_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push(
    { op: "local.tee", index: recv },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: proxyTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [
        { op: "local.get", index: recv },
        { op: "call", funcIdx: namesIdx },
        { op: "i32.const", value: wantSymbols ? 1 : 0 },
        { op: "call", funcIdx: ctx.funcMap.get("__own_keys_filter") ?? filterIdx },
      ],
      else: [
        { op: "local.get", index: recv },
        { op: "call", funcIdx: ordinaryIdx },
      ],
    },
  );
  return true;
}

interface ProxyBagDeps {
  names: number;
  gopd: number;
  get: number;
  externGet: number;
  externSet: number;
  isTruthy: number;
  isUndefined: number;
  newObject: number;
  define: number;
}

function proxyBagDeps(ctx: CodegenContext): ProxyBagDeps | undefined {
  const f = (name: string): number | undefined => ctx.funcMap.get(name);
  const deps = {
    names: f("__proxy_ownkeys_names_dispatch"),
    gopd: f("__proxy_gopd_dispatch"),
    get: f("__proxy_get_dispatch"),
    externGet: f("__extern_get"),
    externSet: f("__extern_set"),
    isTruthy: f(TO_BOOLEAN_NATIVE),
    isUndefined: f("__extern_is_undefined"),
    newObject: f("__new_plain_object"),
    define: f("__obj_define_from_desc"),
  };
  return Object.values(deps).some((v) => v === undefined) ? undefined : (deps as ProxyBagDeps);
}

/** `p.[[GetOwnProperty]](key)` into `descLocal`, then `i32`: present? (and, with `enumerable`, enumerable?) */
function ownDescInstrs(
  ctx: CodegenContext,
  d: ProxyBagDeps,
  pLocal: number,
  keyLocal: number,
  descLocal: number,
  enumerable: boolean,
): Instr[] {
  return [
    { op: "local.get", index: pLocal },
    { op: "local.get", index: keyLocal },
    { op: "local.get", index: pLocal },
    { op: "call", funcIdx: d.gopd },
    { op: "local.tee", index: descLocal },
    { op: "ref.is_null" },
    { op: "local.get", index: descLocal },
    { op: "call", funcIdx: d.isUndefined },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 0 }],
      else: enumerable
        ? [
            { op: "local.get", index: descLocal },
            ...stringConstantExternrefInstrs(ctx, "enumerable"),
            { op: "call", funcIdx: d.externGet },
            { op: "call", funcIdx: d.isTruthy },
          ]
        : [{ op: "i32.const", value: 1 }],
    },
  ];
}

/**
 * `__proxy_own_property_descriptors(p) -> externref` — §20.1.2.9 over a
 * proxy: `ownKeys = p.[[OwnPropertyKeys]]()`, then per key
 * `p.[[GetOwnProperty]](key)` (the gopd trap), and a key whose descriptor is
 * `undefined` is SKIPPED (step 4.c) — the self-hosted ordinary body stores it.
 *
 * params 0=p ; locals 1=keys 2=out 3=n 4=i 5=k 6=desc
 */
function ensureProxyOwnPropertyDescriptors(ctx: CodegenContext): number | undefined {
  const cached = ctx.funcMap.get("__proxy_own_property_descriptors");
  if (cached !== undefined) return cached;
  const d = proxyBagDeps(ctx);
  const l = listDeps(ctx);
  if (d === undefined || l === undefined) return undefined;
  addStringConstantGlobal(ctx, "enumerable");
  return mintNative(
    ctx,
    "__proxy_own_property_descriptors",
    [EXTERNREF],
    [
      { name: "keys", type: EXTERNREF },
      { name: "out", type: EXTERNREF },
      { name: "n", type: I32 },
      { name: "i", type: I32 },
      { name: "k", type: EXTERNREF },
      { name: "desc", type: EXTERNREF },
    ],
    [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: d.names },
      { op: "local.set", index: 1 },
      { op: "call", funcIdx: d.newObject },
      { op: "local.set", index: 2 },
      ...forEachElement(l.length, l.getIdx, 1, 3, 4, 5, [
        ...ownDescInstrs(ctx, d, 0, 5, 6, false),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 2 },
            { op: "local.get", index: 5 },
            { op: "local.get", index: 6 },
            { op: "call", funcIdx: d.externSet },
          ],
        },
      ]),
      { op: "local.get", index: 2 },
    ],
  );
}

/**
 * `__proxy_define_properties(o, props) -> externref` (returns `o`) — §20.1.2.3.1
 * ObjectDefineProperties with a PROXY `Properties`: `keys =
 * props.[[OwnPropertyKeys]]()`; per key `props.[[GetOwnProperty]](key)` (the
 * gopd trap); an enumerable one contributes `Get(props, key)` (the get trap);
 * every collected descriptor is then applied in order through the ordinary
 * single-descriptor applier (`__obj_define_from_desc`, which does
 * ToPropertyDescriptor and throws DefinePropertyOrThrow's TypeError). The
 * native's key walk refused a proxy bag outright.
 *
 * params 0=o 1=props ; locals 2=keys 3=descKeys 4=descs 5=n 6=i 7=k 8=desc
 */
function ensureProxyDefineProperties(ctx: CodegenContext): number | undefined {
  const cached = ctx.funcMap.get("__proxy_define_properties");
  if (cached !== undefined) return cached;
  const d = proxyBagDeps(ctx);
  const l = listDeps(ctx);
  if (d === undefined || l === undefined) return undefined;
  addStringConstantGlobal(ctx, "enumerable");
  return mintNative(
    ctx,
    "__proxy_define_properties",
    [EXTERNREF, EXTERNREF],
    [
      { name: "keys", type: EXTERNREF },
      { name: "descKeys", type: EXTERNREF },
      { name: "descs", type: EXTERNREF },
      { name: "n", type: I32 },
      { name: "i", type: I32 },
      { name: "k", type: EXTERNREF },
      { name: "desc", type: EXTERNREF },
    ],
    [
      { op: "local.get", index: 1 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: d.names },
      { op: "local.set", index: 2 },
      { op: "call", funcIdx: l.vecNew },
      { op: "local.set", index: 3 },
      { op: "call", funcIdx: l.vecNew },
      { op: "local.set", index: 4 },
      ...forEachElement(l.length, l.getIdx, 2, 5, 6, 7, [
        ...ownDescInstrs(ctx, d, 1, 7, 8, true),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 3 },
            { op: "local.get", index: 7 },
            { op: "call", funcIdx: l.vecPush },
            { op: "local.get", index: 4 },
            { op: "local.get", index: 1 },
            { op: "local.get", index: 7 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: d.get },
            { op: "call", funcIdx: l.vecPush },
          ],
        },
      ]),
      ...forEachElement(l.length, l.getIdx, 3, 5, 6, 7, [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 7 },
        { op: "local.get", index: 4 },
        { op: "local.get", index: 6 },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: l.getIdx },
        { op: "call", funcIdx: d.define },
        { op: "drop" },
      ]),
      { op: "local.get", index: 0 },
    ],
  );
}

/** `if (local <param> is a $Proxy) return <call>(…)` — a front guard. */
function proxyFrontGuard(proxyTypeIdx: number, param: number, callArgs: number[], funcIdx: number): Instr[] {
  return [
    { op: "local.get", index: param },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: proxyTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...callArgs.map((index): Instr => ({ op: "local.get", index })),
        { op: "call", funcIdx },
        { op: "return" },
      ],
    },
  ];
}

/**
 * Called by the proxy runtime once its dispatches exist: front-guard
 * `Object.getOwnPropertyDescriptors` (param 0) and `Object.defineProperties`'
 * `Properties` (param 1) for a `$Proxy`.
 */
export function installProxyKeyBagGuards(
  ctx: CodegenContext,
  proxyTypeIdx: number,
  findBody: (name: string) => Instr[] | undefined,
): void {
  if (!ctx.standalone) return;
  const gopdsBody = findBody("__object_getOwnPropertyDescriptors");
  const gopdsIdx = gopdsBody ? ensureProxyOwnPropertyDescriptors(ctx) : undefined;
  if (gopdsBody && gopdsIdx !== undefined) gopdsBody.unshift(...proxyFrontGuard(proxyTypeIdx, 0, [0], gopdsIdx));
  const definesBody = findBody("__defineProperties");
  const definesIdx = definesBody ? ensureProxyDefineProperties(ctx) : undefined;
  if (definesBody && definesIdx !== undefined) {
    definesBody.unshift(...proxyFrontGuard(proxyTypeIdx, 1, [0, 1], definesIdx));
  }
  // (#6770 S8) Object.values / Object.entries over a proxy.
  for (const [name, withKeys] of [
    ["__object_values", false],
    ["__object_entries", true],
  ] as const) {
    const body = findBody(name);
    const idx = body ? ensureProxyEnumerableOwnProperties(ctx, withKeys) : undefined;
    if (body && idx !== undefined) body.unshift(...proxyFrontGuard(proxyTypeIdx, 0, [0], idx));
  }
  installProxyCandidateIsPrototypeOf(ctx, proxyTypeIdx);
}

/**
 * (#6770 S8) `__proxy_enumerable_values(p)` / `__proxy_enumerable_entries(p)` —
 * §7.3.23 EnumerableOwnProperties(p, value | key+value) over a proxy:
 * `p.[[OwnPropertyKeys]]()`, then per STRING key, in order,
 * `p.[[GetOwnProperty]](key)` (the gopd trap) and — only for an enumerable
 * descriptor — `Get(p, key)` with Receiver = p (the get trap). Interleaved per
 * key, exactly the trap order `entries|values/observable-operations.js` logs.
 * The ordinary natives answered a proxy through `__object_keys` (every gopd
 * first) and then `__extern_get` per key.
 *
 * params 0=p ; locals 1=keys 2=out 3=n 4=i 5=k 6=desc 7=pair
 */
function ensureProxyEnumerableOwnProperties(ctx: CodegenContext, withKeys: boolean): number | undefined {
  const name = withKeys ? "__proxy_enumerable_entries" : "__proxy_enumerable_values";
  const cached = ctx.funcMap.get(name);
  if (cached !== undefined) return cached;
  const d = proxyBagDeps(ctx);
  const l = listDeps(ctx);
  const typeofString = ctx.funcMap.get("__typeof_string");
  if (d === undefined || l === undefined || typeofString === undefined) return undefined;
  addStringConstantGlobal(ctx, "enumerable");
  const value: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 5 },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: d.get },
  ];
  const push: Instr[] = withKeys
    ? [
        { op: "call", funcIdx: l.vecNew },
        { op: "local.tee", index: 7 },
        { op: "local.get", index: 5 },
        { op: "call", funcIdx: l.vecPush },
        { op: "local.get", index: 7 },
        ...value,
        { op: "call", funcIdx: l.vecPush },
        { op: "local.get", index: 2 },
        { op: "local.get", index: 7 },
        { op: "call", funcIdx: l.vecPush },
      ]
    : [{ op: "local.get", index: 2 }, ...value, { op: "call", funcIdx: l.vecPush }];
  return mintNative(
    ctx,
    name,
    [EXTERNREF],
    [
      { name: "keys", type: EXTERNREF },
      { name: "out", type: EXTERNREF },
      { name: "n", type: I32 },
      { name: "i", type: I32 },
      { name: "k", type: EXTERNREF },
      { name: "desc", type: EXTERNREF },
      { name: "pair", type: EXTERNREF },
    ],
    [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: d.names },
      { op: "local.set", index: 1 },
      { op: "call", funcIdx: l.vecNew },
      { op: "local.set", index: 2 },
      ...forEachElement(l.length, l.getIdx, 1, 3, 4, 5, [
        { op: "local.get", index: 5 },
        { op: "call", funcIdx: typeofString },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...ownDescInstrs(ctx, d, 0, 5, 6, true), { op: "if", blockType: { kind: "empty" }, then: push }],
        },
      ]),
      { op: "local.get", index: 2 },
    ],
  );
}

/**
 * `Object.defineProperties(O, <closed user struct>)` — e.g. a `Properties` map
 * returned by a call (`defineProperties({}, mk())`). §20.1.2.3.1 needs only
 * `props.[[OwnPropertyKeys]]`, `[[GetOwnProperty]]` and `Get`, which the object
 * MOP already answers for a closed struct (`__object_keys` / `__extern_get`
 * closed-struct arms, filled at finalize). The applier's walk reads `$PropEntry`s
 * though, and a struct has none; its non-`$Object` ladder then classified the
 * struct as a primitive and defined NOTHING. Front guard: a struct the
 * finalize-time classifier admits (the JSON / `Object.assign` screen) is
 * snapshotted into a fresh `$Object` — every field of a closed struct is an
 * enumerable own data property, so the snapshot's key walk is the struct's —
 * and the applier re-enters with it. Called once `__defineProperties` exists.
 *
 * `__props_struct_snapshot(props) -> externref` params 0=props ; locals 1=keys
 * 2=out 3=n 4=i 5=k
 */
export function installClosedStructPropertiesGuard(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const fn = ctx.mod.functions.find((f) => f.name === "__defineProperties");
  const selfIdx = ctx.funcMap.get("__defineProperties");
  const classifier = ctx.funcMap.get("__object_assign_closed_struct_source");
  const keys = ctx.funcMap.get("__object_keys");
  const get = ctx.funcMap.get("__extern_get");
  const set = ctx.funcMap.get("__extern_set");
  const newObject = ctx.funcMap.get("__new_plain_object");
  const l = listDeps(ctx);
  if (!fn || selfIdx === undefined || classifier === undefined || l === undefined) return;
  if (keys === undefined || get === undefined || set === undefined || newObject === undefined) return;
  const snapshot = mintNative(
    ctx,
    "__props_struct_snapshot",
    [EXTERNREF],
    [
      { name: "keys", type: EXTERNREF },
      { name: "out", type: EXTERNREF },
      { name: "n", type: I32 },
      { name: "i", type: I32 },
      { name: "k", type: EXTERNREF },
    ],
    [
      { op: "call", funcIdx: newObject },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: keys },
      { op: "local.set", index: 1 },
      ...forEachElement(l.length, l.getIdx, 1, 3, 4, 5, [
        { op: "local.get", index: 2 },
        { op: "local.get", index: 5 },
        { op: "local.get", index: 0 },
        { op: "local.get", index: 5 },
        { op: "call", funcIdx: get },
        { op: "call", funcIdx: set },
      ]),
      { op: "local.get", index: 2 },
    ],
  );
  fn.body.unshift(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: classifier },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: snapshot },
        { op: "call", funcIdx: selfIdx },
        { op: "return" },
      ],
    },
  );
}

/** WasmGC `eq` abstract heap type. */
const EQ_HEAP = -19;

/**
 * §20.1.3.3 `O.isPrototypeOf(V)` with a PROXY `V`: step 3.a is
 * `V = ? V.[[GetPrototypeOf]]()` — for a proxy, its `getPrototypeOf` trap. The
 * walk read `V.$proto` off a `$Object` only, so a proxy candidate answered
 * `false` without asking (`isPrototypeOf/arg-is-proxy.js`, whose handler
 * throws on every OTHER trap). This guard takes the first hop through
 * `__getPrototypeOf` (the proxy front guard → gpo dispatch), compares that
 * value with `O`, and continues with the ordinary walk from it — a later proxy
 * hop re-enters the guard; a proxy LINK inside a `$Object` chain is #6766's
 * `fillProtoLinkArms` arm.
 */
function installProxyCandidateIsPrototypeOf(ctx: CodegenContext, proxyTypeIdx: number): void {
  const fn = ctx.mod.functions.find((f) => f.name === "__isPrototypeOf");
  const selfIdx = ctx.funcMap.get("__isPrototypeOf");
  const gpo = ctx.funcMap.get("__getPrototypeOf");
  if (fn === undefined || selfIdx === undefined || gpo === undefined) return;
  const P = 2 + fn.locals.length; // two params
  fn.locals.push({ name: "__ipo_proto", type: EXTERNREF });
  const eqTest = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: EQ_HEAP },
  ];
  const asEq = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: EQ_HEAP },
  ];
  fn.body.unshift(
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: proxyTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: gpo },
        { op: "local.tee", index: P },
        { op: "ref.is_null" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
        ...eqTest(P),
        ...eqTest(0),
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...asEq(P),
            ...asEq(0),
            { op: "ref.eq" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
          ],
        },
        { op: "local.get", index: 0 },
        { op: "local.get", index: P },
        { op: "call", funcIdx: selfIdx },
        { op: "return" },
      ],
    },
  );
}

/**
 * A `new Proxy(<literal>, <literal>)` operand, built as the OPEN `$Object`
 * `__proxy_create` and every dispatch read with `__extern_get` /
 * `__getOwnPropertyNames`. An accessor or computed-key literal takes the open
 * builder that KEEPS those members; the plain one skips them, so a Proxy
 * target `{ [sym]: 1, get foo() {} }` had no own keys for seal / freeze to
 * visit (`seal|freeze/proxy-with-defineProperty-handler.js`).
 */
export function compileOpenProxyOperandLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  literal: ts.ObjectLiteralExpression,
): ValType | null {
  return objectLiteralForcesHostPath(ctx, literal)
    ? compileObjectLiteral(ctx, fctx, literal)
    : compileObjectLiteralAsExternref(ctx, fctx, literal);
}
