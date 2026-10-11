// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6770 S8) Proxy trap lookup is PER OPERATION — `GetMethod(handler, name)`
 * at the start of every §10.5 internal method — under `--target standalone`.
 *
 * `__proxy_create` used to read all thirteen traps off the handler at
 * construction and freeze them in the `$ProxyTraps` slots. Three things were
 * observably wrong with that snapshot:
 *
 * ```js
 * var h = new Proxy({}, { get(t, k) { log.push(k); } });
 * Object.keys(new Proxy([], h));            // log: all 13 trap names at `new`, none per operation
 * var handler = { get ownKeys() { return () => ["a"]; } };
 * Object.keys(new Proxy({}, handler));      // the accessor ran once, at `new`
 * var hm = {}; var p = new Proxy({}, hm);
 * hm.get = () => 1; p.x;                    // the later trap was invisible
 * ```
 *
 * `__proxy_create` now allocates an EMPTY `$ProxyTraps` (its non-null-ness
 * still encodes "not revoked" for every `ptraps == null` check), and each
 * dispatch reads its trap through {@link proxyTrapReadTail}: one
 * `__extern_get(handler, name)` on that operation — so a `$Proxy` handler takes
 * its own `get` trap (the row's log) and an accessor-defined trap runs its
 * getter with `this` = the handler.
 *
 * A few sites only ask whether a trap is PRESENT to choose a route (the `in`
 * fold, the prototype walk, the strict / receiver-aware `[[Set]]` guards,
 * seal / freeze). {@link proxyTrapAbsentTail} answers that without a second
 * observable lookup where it can: a `$Proxy` handler is conservatively
 * "present", which routes to the dispatch, whose single read is the
 * authoritative one and which forwards a missing trap itself.
 *
 * {@link ensureProxyListFromArrayLike} is §7.3.20 CreateListFromArrayLike for
 * the `ownKeys` trap result: ONE `length` read, ONE `Get` per index (in
 * order), each element checked to be a String or Symbol — into a fresh
 * `$ObjVec` the validation, the invariant check and every consumer then read
 * without re-running the array-like's getters (`keys/proxy-keys.js`).
 *
 * Reusable by #6771: the factories take the trap's `$ProxyTraps` field index
 * and emit FRESH instruction arrays per call (a shared `Instr` reachable from
 * two bodies is remapped twice by the late-import shift, #5140/#5316).
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { isOpenDescriptorShape } from "../property-descriptor-shape.js";
import { addFuncType } from "../registry/types.js";
import { UNDEF_F64_BITS } from "../value-tags.js";
import { allocatedStructTypeIndices } from "../walk-instructions.js";
import { ensureExnTag } from "../registry/physical-imports.js";
import { bound } from "./ports.js"; // (#6770/#6797) core helpers, injected — keeps this leaf out of the import SCC

const undefinedExternInstrs = bound("undefinedExternInstrs");
const stringConstantExternrefInstrs = bound("stringConstantExternrefInstrs");
const addStringConstantGlobal = bound("addStringConstantGlobal");
const ensureObjVecBuilders = bound("ensureObjVecBuilders");

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
/** `$Proxy` field 2 — the handler (anyref). Duplicated from object-runtime-proxy.ts (ESM-cycle-free). */
const F_PHANDLER = 2;

/** `$ProxyTraps` field index → the handler property name §10.5 looks up. */
const PROXY_TRAP_NAMES: readonly string[] = [
  "get",
  "set",
  "has",
  "apply",
  "deleteProperty",
  "getOwnPropertyDescriptor",
  "getPrototypeOf",
  "setPrototypeOf",
  "isExtensible",
  "preventExtensions",
  "ownKeys",
  "defineProperty",
  "construct",
];

function proxyTypeOf(ctx: CodegenContext): number {
  const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
  if (proxyTypeIdx === undefined) throw new Error("proxy-trap-read: object runtime types are not registered");
  return proxyTypeIdx;
}

function mint(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  result: ValType,
  locals: { name: string; type: ValType }[],
  body: Instr[],
): number {
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx: addFuncType(ctx, params, [result]), locals, body, exported: false });
  return funcIdx;
}

/** `handler = p.$phandler` → externref local 2 (params 0=p 1=name). */
function handlerInto2(proxyTypeIdx: number): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
    { op: "extern.convert_any" },
    { op: "local.set", index: 2 },
  ];
}

/**
 * `__proxy_trap_read(p: ref null $Proxy, name) -> externref` — §7.3.10
 * GetMethod(handler, name) minus its callable check (each dispatch keeps its
 * own `trapCallableGuard`): `Get(handler, name)`, undefined/null → null.
 * params 0=p 1=name ; locals 2=handler
 */
function ensureTrapReadNative(ctx: CodegenContext): number {
  const cached = ctx.funcMap.get("__proxy_trap_read");
  if (cached !== undefined) return cached;
  const proxyTypeIdx = proxyTypeOf(ctx);
  const externGet = ctx.funcMap.get("__extern_get");
  if (externGet === undefined) throw new Error("proxy-trap-read: __extern_get is not registered");
  const nullishToNull = ctx.funcMap.get("__nullish_to_null");
  return mint(
    ctx,
    "__proxy_trap_read",
    [{ kind: "ref_null", typeIdx: proxyTypeIdx }, EXTERNREF],
    EXTERNREF,
    [{ name: "handler", type: EXTERNREF }],
    [
      ...handlerInto2(proxyTypeIdx),
      // A revoked proxy has a null handler; every caller checked `ptraps` first,
      // so this is only a guard against reading through null.
      { op: "local.get", index: 2 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: externGet },
      ...(nullishToNull !== undefined ? ([{ op: "call", funcIdx: nullishToNull }] satisfies Instr[]) : []),
    ],
  );
}

/**
 * `__proxy_trap_absent(p: ref null $Proxy, name) -> i32` — 1 when the handler
 * provides no trap. A `$Proxy` handler answers 0 ("present") WITHOUT a lookup:
 * the caller then takes the dispatch route, whose own read is the one §10.5
 * performs (and which forwards when that read finds nothing).
 * params 0=p 1=name ; locals 2=handler
 */
function ensureTrapAbsentNative(ctx: CodegenContext): number {
  const cached = ctx.funcMap.get("__proxy_trap_absent");
  if (cached !== undefined) return cached;
  const proxyTypeIdx = proxyTypeOf(ctx);
  const read = ensureTrapReadNative(ctx);
  return mint(
    ctx,
    "__proxy_trap_absent",
    [{ kind: "ref_null", typeIdx: proxyTypeIdx }, EXTERNREF],
    I32,
    [{ name: "handler", type: EXTERNREF }],
    [
      ...handlerInto2(proxyTypeIdx),
      { op: "local.get", index: 2 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: read },
      { op: "ref.is_null" },
    ],
  );
}

function trapNameInstrs(ctx: CodegenContext, trapField: number): Instr[] {
  const name = PROXY_TRAP_NAMES[trapField];
  if (name === undefined) throw new Error(`proxy-trap-read: no trap at $ProxyTraps field ${trapField}`);
  addStringConstantGlobal(ctx, name);
  return stringConstantExternrefInstrs(ctx, name);
}

/**
 * Stack `(ref $Proxy) -> externref`: the trap at `$ProxyTraps` field
 * `trapField`, looked up on the handler NOW. Replaces the slot read
 * `struct.get $Proxy ptraps; ref.as_non_null; struct.get $ProxyTraps <field>`.
 */
export function proxyTrapReadTail(ctx: CodegenContext, trapField: number): Instr[] {
  const read = ensureTrapReadNative(ctx);
  return [...trapNameInstrs(ctx, trapField), { op: "call", funcIdx: read }];
}

/**
 * Stack `(ref $Proxy) -> i32`: 1 when the trap is absent. Replaces
 * `struct.get $Proxy ptraps; ref.as_non_null; struct.get $ProxyTraps <field>; ref.is_null`.
 */
export function proxyTrapAbsentTail(ctx: CodegenContext, trapField: number): Instr[] {
  const absent = ensureTrapAbsentNative(ctx);
  return [...trapNameInstrs(ctx, trapField), { op: "call", funcIdx: absent }];
}

/**
 * `__proxy_list_from_array_like(obj) -> externref` — §7.3.20
 * CreateListFromArrayLike(obj, « String, Symbol ») for the `ownKeys` trap
 * result (already known to be an Object): `len = LengthOfArrayLike(obj)`, then
 * for each index in order `next = Get(obj, i)`, a TypeError unless `next` is a
 * String or Symbol, appended to a fresh `$ObjVec`.
 * params 0=obj ; locals 1=out 2=n 3=i 4=e
 */
export function ensureProxyListFromArrayLike(ctx: CodegenContext, notListMessage: string): number | undefined {
  const cached = ctx.funcMap.get("__proxy_list_from_array_like");
  if (cached !== undefined) return cached;
  const length = ctx.funcMap.get("__extern_length");
  const getIdx = ctx.funcMap.get("__extern_get_idx");
  const typeofString = ctx.funcMap.get("__typeof_string");
  const typeErrorCtor = ctx.funcMap.get("__new_TypeError");
  if (length === undefined || getIdx === undefined || typeofString === undefined || typeErrorCtor === undefined) {
    return undefined;
  }
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  addStringConstantGlobal(ctx, notListMessage);
  const symbolTypeIdx = ctx.symbolTypeIdx;
  return mint(
    ctx,
    "__proxy_list_from_array_like",
    [EXTERNREF],
    EXTERNREF,
    [
      { name: "out", type: EXTERNREF },
      { name: "n", type: I32 },
      { name: "i", type: I32 },
      { name: "e", type: EXTERNREF },
    ],
    [
      { op: "call", funcIdx: newIdx },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: length },
      { op: "i32.trunc_sat_f64_s" },
      { op: "local.set", index: 2 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 3 },
              { op: "local.get", index: 2 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 0 },
              { op: "local.get", index: 3 },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: getIdx },
              { op: "local.tee", index: 4 },
              { op: "call", funcIdx: typeofString },
              ...(symbolTypeIdx >= 0
                ? ([
                    { op: "local.get", index: 4 },
                    { op: "any.convert_extern" },
                    { op: "ref.test", typeIdx: symbolTypeIdx },
                    { op: "i32.or" },
                  ] satisfies Instr[])
                : []),
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...stringConstantExternrefInstrs(ctx, notListMessage),
                  { op: "call", funcIdx: typeErrorCtor },
                  { op: "throw", tagIdx: ensureExnTag(ctx) },
                ],
              },
              { op: "local.get", index: 1 },
              { op: "local.get", index: 4 },
              { op: "call", funcIdx: pushIdx },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 1 },
    ],
  );
}

/** §6.2.6.5 ToPropertyDescriptor reads exactly these six fields. */
const DESCRIPTOR_FIELDS: readonly string[] = ["value", "writable", "enumerable", "configurable", "get", "set"];

/**
 * `__proxy_gopd_result_reify(res) -> externref` — the getOwnPropertyDescriptor
 * trap result as something `__extern_get` / `__extern_has` can read.
 *
 * A trap written `return { value: t[k], writable: true, … }` returns an
 * ANONYMOUS open-descriptor struct (`isOpenDescriptorShape`: an `any` value
 * slot), which by design gets no closed-struct `__extern_get` arm — every
 * other boundary it can cross reifies it to a `$Object` first
 * (`structMustReifyAtExternrefBoundary`). The closure dispatcher's
 * `extern.convert_any` was the one crossing that did not, so the §10.5.5
 * validator read `configurable` as `undefined` and threw the step-17
 * invariant over a configurable target property. Measured on main
 * (standalone): `Object.getOwnPropertyDescriptor(new Proxy({a: 1},
 * {getOwnPropertyDescriptor(t, k) { return {value: t[k], writable: true,
 * enumerable: true, configurable: true}; }}), "a")` threw; `value: 1` (an f64
 * slot, which HAS an arm) answered. #6770 S7 made `Object.keys(proxy)` consult
 * this trap per key, so the same program reached it through `Object.keys`
 * (#6637's pin).
 *
 * Built LATE (from the trap-driver fill, after every closure body compiled) so
 * the struct list is complete. `undefined` when the module has no such struct.
 * params 0=res ; locals 1=obj 2=f64 scratch
 */
export function ensureGopdResultReify(ctx: CodegenContext): number | undefined {
  const cached = ctx.funcMap.get("__proxy_gopd_result_reify");
  if (cached !== undefined) return cached;
  const newPlain = ctx.funcMap.get("__new_plain_object");
  const externSet = ctx.funcMap.get("__extern_set");
  const boxNumber = ctx.funcMap.get("__box_number");
  const boxBoolean = ctx.funcMap.get("__box_boolean");
  if (newPlain === undefined || externSet === undefined) return undefined;
  const allocated = allocatedStructTypeIndices(ctx.mod);
  const arms: Instr[] = [];
  for (const [structName, fields] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined || !allocated.has(typeIdx) || !isOpenDescriptorShape(structName, fields)) continue;
    const copy: Instr[] = [
      { op: "call", funcIdx: newPlain },
      { op: "local.set", index: 1 },
    ];
    fields.forEach((field, fieldIdx) => {
      if (!DESCRIPTOR_FIELDS.includes(field.name)) return;
      const box = fieldBox(ctx, field.type, field.jsBoolean === true, boxNumber, boxBoolean);
      if (box === null) return;
      addStringConstantGlobal(ctx, field.name);
      copy.push(
        { op: "local.get", index: 1 },
        ...stringConstantExternrefInstrs(ctx, field.name),
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx },
        { op: "struct.get", typeIdx, fieldIdx },
        ...box,
        { op: "call", funcIdx: externSet },
      );
    });
    copy.push({ op: "local.get", index: 1 }, { op: "return" });
    arms.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx },
      { op: "if", blockType: { kind: "empty" }, then: copy },
    );
  }
  if (arms.length === 0) return undefined;
  return mint(
    ctx,
    "__proxy_gopd_result_reify",
    [EXTERNREF],
    EXTERNREF,
    [
      { name: "obj", type: EXTERNREF },
      { name: "f", type: { kind: "f64" } },
    ],
    [...arms, { op: "local.get", index: 0 }],
  );
}

/** Box one struct slot (on the stack) to externref; `null` = not representable. */
function fieldBox(
  ctx: CodegenContext,
  type: ValType,
  jsBoolean: boolean,
  boxNumber: number | undefined,
  boxBoolean: number | undefined,
): Instr[] | null {
  if (type.kind === "externref" || type.kind === "ref_extern") return [];
  if (type.kind === "ref" || type.kind === "ref_null" || type.kind === "anyref" || type.kind === "eqref") {
    return [{ op: "extern.convert_any" }];
  }
  if (type.kind === "i32" && (jsBoolean || type.boolean === true)) {
    return boxBoolean === undefined ? null : [{ op: "call", funcIdx: boxBoolean }];
  }
  if (boxNumber === undefined) return null;
  if (type.kind === "i32") return [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumber }];
  if (type.kind !== "f64") return null;
  // The identity-preserving undefined sentinel stays `undefined`.
  return [
    { op: "local.tee", index: 2 },
    { op: "i64.reinterpret_f64" },
    { op: "i64.const", value: UNDEF_F64_BITS },
    { op: "i64.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }],
      else: [
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: boxNumber },
      ],
    },
  ];
}
