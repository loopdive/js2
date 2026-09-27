// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B6) The RUNTIME half of a `$NativeRegExp`'s own
 * `lastIndex` data property (§22.2.3.3: `{writable: true, enumerable: false,
 * configurable: false}`), standalone.
 *
 * ## The carrier, and the defect
 *
 * `lastIndex` lives in THREE `$NativeRegExp` slots (regexp-standalone.ts):
 * the f64 fast slot, a raw externref slot, and a presence bit. A numeric write
 * goes to the f64 slot; any other value is kept OPAQUELY in the raw slot, so
 * `re.lastIndex = {valueOf(){…}}` does not run `valueOf` at assignment time —
 * ToLength is deferred to the next `Get` that needs a number. Only the STATIC
 * spelling knew that:
 *
 * | spelling                               | before                       | spec           |
 * | -------------------------------------- | ---------------------------- | -------------- |
 * | `re.lastIndex = o; re[k]` (k="lastIndex")| the stale f64 slot, boxed  | `o`            |
 * | `re[k] = o; re.lastIndex`              | the stale raw/f64 slots      | `o`            |
 * | `Get(rx,"lastIndex")` in a `@@` method | the f64 slot — no `valueOf`  | `o` → ToLength |
 *
 * `__extern_get`/`__extern_set` reached the carrier through the generic
 * closed-struct field ladder, which knows `lastIndex` only as "an f64 field".
 * §22.2.6.11 step 11.c.iii.2.a (`@@replace/coerce-lastindex{,-err}`) and
 * §22.2.6.8 step 6.e.iii (`@@match/g-match-empty-coerce-lastindex-err`) read
 * `lastIndex` through that `[[Get]]` after the user's `exec` assigned an
 * object, so `valueOf` never ran.
 *
 * ## [[Writable]], which had no runtime representation at all
 *
 * Every `Set(R, "lastIndex", v, true)` in §22.2 throws when the property is
 * non-writable. The only non-writable signal was compile-time
 * (`ctx.nonWritableExternKeys`, a static identifier + a literal descriptor),
 * so `Object.defineProperty(r, 'lastIndex', {writable: false})` inside an
 * `exec` getter — or anywhere the protocol's `[[Set]]` runs — was invisible,
 * and `Object.defineProperty` on a `$NativeRegExp` was a lenient no-op (the
 * `$Object` appliers decline every closed carrier with no bag). The carrier
 * therefore gains ONE bit, `$lastIndexNonWritable` (inverted so a fresh
 * struct's `0` is the spec default), written only by the define arm here.
 *
 * ## What is spliced (FINALIZE, append-only mints, `call`s baked in the same pass)
 *
 * ```
 * __extern_get(o,k)          : if (lastIndexKey(o,k)) return read(o)
 * __extern_set(o,k,v)        : if (lastIndexKey(o,k)) { write(o,v); return }        // sloppy no-op
 * __extern_set_strict(o,k,v) : if (lastIndexKey(o,k)) { if (!write(o,v)) throw TypeError; return }
 * __reflect_set(o,k,v)       : if (lastIndexKey(o,k)) return write(o,v)
 * __defineProperty_value     : if (lastIndexKey(o,k)) return define(o, value, flags) // §10.1.6.3
 * ```
 *
 * `define` is ValidateAndApplyPropertyDescriptor against the one fixed shape
 * the property can have: a non-configurable, non-enumerable DATA property. So
 * `configurable: true` / `enumerable: true` throw, and once non-writable,
 * `writable: true` or a value that is not SameValue to the current one throws;
 * otherwise the value (if present) is stored through the same two-slot
 * encoding as an assignment, and `writable: false` sets the bit.
 *
 * The RegExp `@@` protocol modules issue their `Set(…, true)` through
 * `__extern_set_strict` (regexp-exec-protocol.ts) — spec-required, and what
 * makes the strict arm above observable. RegExpBuiltinExec's own lastIndex
 * write on the protocol route checks the same bit (regexp-standalone.ts).
 *
 * ## Demand gating
 *
 * No `$NativeRegExp` struct ⇒ nothing is minted and every body is untouched.
 * The throwing arms additionally require a module-level `__new_TypeError`
 * (present whenever the object runtime built `__extern_set_strict`); without
 * it the strict arm is simply not spliced.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import {
  RE_FIELD_LASTINDEX,
  RE_FIELD_LASTINDEX_NONWRITABLE,
  RE_FIELD_LASTINDEX_RAW,
  RE_FIELD_LASTINDEX_RAW_PRESENT,
  standaloneRegExpStructTypeIdx,
} from "./regexp-standalone.js";
import { ensureExnTag } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const F64: ValType = { kind: "f64" };

const KEY_FN = "__regexp_lastindex_key";
const READ_FN = "__regexp_lastindex_read";
const WRITE_FN = "__regexp_lastindex_write";
const DEFINE_FN = "__regexp_lastindex_define";

/** Host descriptor-flag encoding of `__defineProperty_value` (object-runtime-descriptors.ts). */
const HOST_WRITABLE = 1 << 0;
const HOST_ENUMERABLE = 1 << 1;
const HOST_CONFIGURABLE = 1 << 2;
const HOST_WRITABLE_SPECIFIED = 1 << 3;
const HOST_ENUMERABLE_SPECIFIED = 1 << 4;
const HOST_CONFIGURABLE_SPECIFIED = 1 << 5;
const HOST_HAS_VALUE = 1 << 7;

interface Deps {
  reTypeIdx: number;
  boxNumberIdx: number;
  boxNumTypeIdx: number;
}

function mint(
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

/** `[] → []` (terminal) — `throw new TypeError(msg)`, or `undefined` when no module TypeError exists. */
function throwTypeErrorInstrs(ctx: CodegenContext, msg: string): Instr[] | undefined {
  const ctorIdx = ctx.funcMap.get("__new_TypeError");
  if (ctorIdx === undefined) return undefined;
  return [
    ...nativeStringLiteralInstrs(ctx, msg),
    { op: "extern.convert_any" },
    { op: "call", funcIdx: ctorIdx },
    { op: "throw", tagIdx: ensureExnTag(ctx) },
  ];
}

/** `(obj, key) -> i32` — 1 iff `obj` is a `$NativeRegExp` and `key` is the string `"lastIndex"`. */
function registerKeyPredicate(ctx: CodegenContext, d: Deps): number | undefined {
  const existing = ctx.funcMap.get(KEY_FN);
  if (existing !== undefined) return existing;
  const anyStr = ctx.anyStrTypeIdx;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (anyStr < 0 || flattenIdx === undefined || equalsIdx === undefined) return undefined;
  const no: Instr[] = [{ op: "i32.const", value: 0 }, { op: "return" }];
  return mint(
    ctx,
    KEY_FN,
    [EXTERNREF, EXTERNREF],
    [I32],
    [],
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: d.reTypeIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: no },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: anyStr },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: no },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: anyStr },
      { op: "call", funcIdx: flattenIdx },
      ...nativeStringLiteralInstrs(ctx, "lastIndex"),
      { op: "call", funcIdx: equalsIdx },
    ],
  );
}

/** `(obj) -> externref` — the raw value when one is pending, else the boxed f64 slot. */
function registerRead(ctx: CodegenContext, d: Deps): number {
  const existing = ctx.funcMap.get(READ_FN);
  if (existing !== undefined) return existing;
  const RE = 1;
  return mint(
    ctx,
    READ_FN,
    [EXTERNREF],
    [EXTERNREF],
    [{ name: "re", type: { kind: "ref_null", typeIdx: d.reTypeIdx } }],
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.reTypeIdx },
      { op: "local.tee", index: RE },
      { op: "struct.get", typeIdx: d.reTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_RAW_PRESENT },
      {
        op: "if",
        blockType: { kind: "val", type: EXTERNREF },
        then: [
          { op: "local.get", index: RE },
          { op: "struct.get", typeIdx: d.reTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_RAW },
        ],
        else: [
          { op: "local.get", index: RE },
          { op: "struct.get", typeIdx: d.reTypeIdx, fieldIdx: RE_FIELD_LASTINDEX },
          { op: "call", funcIdx: d.boxNumberIdx },
        ],
      },
    ],
  );
}

/**
 * `(re ref, v externref) -> []` — store `v` in the two-slot encoding, ignoring
 * [[Writable]]. A boxed number takes the f64 slot and clears the raw bit;
 * anything else is kept opaquely (no ToPrimitive — §10.1.9 stores the value).
 */
function storeInstrs(d: Deps, reLocal: number, vLocal: number): Instr[] {
  return [
    { op: "local.get", index: vLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: d.boxNumTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: reLocal },
        { op: "local.get", index: vLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: d.boxNumTypeIdx },
        { op: "struct.get", typeIdx: d.boxNumTypeIdx, fieldIdx: 0 },
        { op: "struct.set", typeIdx: d.reTypeIdx, fieldIdx: RE_FIELD_LASTINDEX },
        { op: "local.get", index: reLocal },
        { op: "ref.null.extern" },
        { op: "struct.set", typeIdx: d.reTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_RAW },
        { op: "local.get", index: reLocal },
        { op: "i32.const", value: 0 },
        { op: "struct.set", typeIdx: d.reTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_RAW_PRESENT },
      ],
      else: [
        { op: "local.get", index: reLocal },
        { op: "local.get", index: vLocal },
        { op: "struct.set", typeIdx: d.reTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_RAW },
        { op: "local.get", index: reLocal },
        { op: "i32.const", value: 1 },
        { op: "struct.set", typeIdx: d.reTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_RAW_PRESENT },
      ],
    },
  ];
}

/** `(obj, v) -> i32` — OrdinarySet on the own data property: 0 (refused) when non-writable. */
function registerWrite(ctx: CodegenContext, d: Deps): number {
  const existing = ctx.funcMap.get(WRITE_FN);
  if (existing !== undefined) return existing;
  const RE = 2;
  return mint(
    ctx,
    WRITE_FN,
    [EXTERNREF, EXTERNREF],
    [I32],
    [{ name: "re", type: { kind: "ref_null", typeIdx: d.reTypeIdx } }],
    [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: d.reTypeIdx },
      { op: "local.tee", index: RE },
      { op: "struct.get", typeIdx: d.reTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_NONWRITABLE },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
      ...storeInstrs(d, RE, 1),
      { op: "i32.const", value: 1 },
    ],
  );
}

/**
 * `(obj, value, flagsF64) -> externref` — §10.1.6.3 ValidateAndApplyPropertyDescriptor
 * for the fixed current shape `{[[Writable]]: w, [[Enumerable]]: false,
 * [[Configurable]]: false}`. Returns `obj` (the applier's contract).
 */
function registerDefine(ctx: CodegenContext, d: Deps, readIdx: number): number | undefined {
  const existing = ctx.funcMap.get(DEFINE_FN);
  if (existing !== undefined) return existing;
  const objectIsIdx = ctx.funcMap.get("__object_is");
  const reject = throwTypeErrorInstrs(ctx, "Cannot redefine property: lastIndex");
  if (objectIsIdx === undefined || reject === undefined) return undefined;
  const RE = 3;
  const HF = 4;
  const hf = (bit: number): Instr[] => [
    { op: "local.get", index: HF },
    { op: "i32.const", value: bit },
    { op: "i32.and" },
  ];
  // Fresh copies per splice site: a shared Instr object would be remapped once
  // per position by the late-index walks.
  const rejectAt = (): Instr[] => reject.map((instr) => ({ ...instr }) as Instr);
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: d.reTypeIdx },
    { op: "local.set", index: RE },
    { op: "local.get", index: 2 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: HF },
    // step 4 — Configurable false: {configurable: true} or a changed enumerable throw.
    ...hf(HOST_CONFIGURABLE_SPECIFIED),
    ...hf(HOST_CONFIGURABLE),
    { op: "i32.and" },
    ...hf(HOST_ENUMERABLE_SPECIFIED),
    ...hf(HOST_ENUMERABLE),
    { op: "i32.and" },
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: rejectAt() },
    // step 7.a — a non-writable, non-configurable data property.
    { op: "local.get", index: RE },
    { op: "struct.get", typeIdx: d.reTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_NONWRITABLE },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...hf(HOST_WRITABLE_SPECIFIED),
        ...hf(HOST_WRITABLE),
        { op: "i32.and" },
        { op: "if", blockType: { kind: "empty" }, then: rejectAt() },
        ...hf(HOST_HAS_VALUE),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "local.get", index: 0 },
            { op: "call", funcIdx: readIdx },
            { op: "call", funcIdx: objectIsIdx },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: rejectAt() },
          ],
        },
        // Nothing changes on a non-writable property that passed validation.
        { op: "local.get", index: 0 },
        { op: "return" },
      ],
    },
    // step 9 — apply.
    ...hf(HOST_HAS_VALUE),
    { op: "if", blockType: { kind: "empty" }, then: storeInstrs(d, RE, 1) },
    ...hf(HOST_WRITABLE_SPECIFIED),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: RE },
        ...hf(HOST_WRITABLE),
        { op: "i32.eqz" },
        { op: "struct.set", typeIdx: d.reTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_NONWRITABLE },
      ],
    },
    { op: "local.get", index: 0 },
  ];
  return mint(
    ctx,
    DEFINE_FN,
    [EXTERNREF, EXTERNREF, F64],
    [EXTERNREF],
    [
      { name: "re", type: { kind: "ref_null", typeIdx: d.reTypeIdx } },
      { name: "hf", type: I32 },
    ],
    body,
  );
}

/** `if (lastIndexKey(p0, p1)) { <then> }` at the front of `fnName`'s body. */
function unshiftKeyArm(ctx: CodegenContext, fnName: string, keyIdx: number, then: Instr[]): void {
  const fn = ctx.mod.functions.find((candidate) => candidate.name === fnName);
  if (!fn) return;
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: keyIdx },
    { op: "if", blockType: { kind: "empty" }, then },
  );
}

/**
 * Finalize splice (standalone/wasi): route every runtime-keyed `[[Get]]`,
 * `[[Set]]` and `[[DefineOwnProperty]]` of `"lastIndex"` on a `$NativeRegExp`
 * to the carrier's own slots. MUST run after the closed-struct ladders are
 * filled (these arms pre-empt them) and before `unshiftExternGetProtoCacheArm`,
 * which has to stay `__extern_get`'s prefix.
 */
export function installRegExpLastIndexCarrierArms(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  const reTypeIdx = standaloneRegExpStructTypeIdx(ctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const boxNumTypeIdx = ctx.nativeBoxNumberTypeIdx;
  if (reTypeIdx === undefined || boxNumberIdx === undefined || boxNumTypeIdx < 0) return;
  if (!ctx.mod.functions.some((candidate) => candidate.name === "__extern_get")) return;
  const d: Deps = { reTypeIdx, boxNumberIdx, boxNumTypeIdx };
  const keyIdx = registerKeyPredicate(ctx, d);
  if (keyIdx === undefined) return;
  const readIdx = registerRead(ctx, d);
  const writeIdx = registerWrite(ctx, d);
  const defineIdx = registerDefine(ctx, d, readIdx);

  unshiftKeyArm(ctx, "__extern_get", keyIdx, [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: readIdx },
    { op: "return" },
  ]);
  const writeCall: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: writeIdx },
  ];
  // Sloppy [[Set]]: a refused write is a silent no-op (§10.1.9.2 step 2.a).
  unshiftKeyArm(ctx, "__extern_set", keyIdx, [...writeCall, { op: "drop" }, { op: "return" }]);
  unshiftKeyArm(ctx, "__reflect_set", keyIdx, [...writeCall, { op: "return" }]);
  // Strict [[Set]] / Set(O, P, V, true): a refused write throws (§7.3.4 step 2).
  const strictReject = throwTypeErrorInstrs(ctx, "Cannot assign to read only property 'lastIndex'");
  if (strictReject !== undefined) {
    unshiftKeyArm(ctx, "__extern_set_strict", keyIdx, [
      ...writeCall,
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: strictReject },
      { op: "return" },
    ]);
  }
  if (defineIdx !== undefined) {
    unshiftKeyArm(ctx, "__defineProperty_value", keyIdx, [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "call", funcIdx: defineIdx },
      { op: "return" },
    ]);
  }
}
