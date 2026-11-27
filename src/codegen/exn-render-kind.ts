// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7453) The error KINDS of a thrown payload, for a JS-side harness that must
 * tell an Error object from any other thrown value.
 *
 * A natively-thrown payload is a WasmGC ref the host cannot inspect, so the
 * harness cannot read the two kinds it reads off a host value — `value.name`
 * and `value.constructor.name`. `__exn_render_kind(payload: externref, slot:
 * i32) -> i32` answers them, one slot each, through the render buffer
 * `__exn_render_char` reads, or -1 when that slot has no string answer:
 *
 *   slot 0 (`name`):
 *     - `$Error_struct`   → its `name` field when it is a string
 *     - any other object  → `[[Get]](o, "name")` through the module's own
 *                           `__extern_get`, when it has one
 *   slot 1 (`constructor.name`):
 *     - `$Error_struct`   → a user subclass's class (its `$userClassId` brand),
 *                           else the builtin constructor its `$tag` names (a
 *                           `Test262Error` sharing the `Error` tag by name)
 *     - a class instance  → its class, by the `__tag` brand: exact for a
 *                           subclass or a same-layout sibling, which a
 *                           structural `ref.test` cannot tell apart
 *     - any other object  → `[[Get]]([[Get]](o, "constructor"), "name")`
 *                           through `__extern_get`; a module without one names
 *                           a `new F()` instance by its `$__fnctor_F` struct
 *                           when no other struct shares that layout
 *
 * A primitive (a string, a number) has no kind in either slot. Published only
 * under the `exceptionKindExport` harness opt-in.
 */
import type { Instr } from "../ir/types.js";
import { BUILTIN_TYPE_TAGS } from "./builtin-tags.js";
import { layoutTwins } from "./class-arm-tag-guard.js";
import type { CodegenContext } from "./context/types.js";
import { storeAndReturnLen } from "./exn-render-lite.js";
import { COLD_TAIL_SUFFIX } from "./fnctor-cold-tail.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { userErrorCtorNames, WASI_ERROR_NAMES } from "./registry/error-names.js";
import { addFuncType } from "./registry/types.js";

const FNCTOR_PREFIX = "__fnctor_";
/** `$Error_struct` fields read here (see `getOrRegisterErrorStructType`). */
const ERROR_TAG_FIELD = 0;
const ERROR_NAME_FIELD = 2;
const ERROR_USER_CLASS_FIELD = 4;

// `__exn_render_kind`'s params and locals.
const L_PAYLOAD = 0;
const L_SLOT = 1;
const L_TMP = 2; // anyref
const L_BRAND = 3; // i32

const payload: Instr[] = [{ op: "local.get", index: L_PAYLOAD }, { op: "any.convert_extern" }];

/** What every arm shares: the store-and-return tail, the helpers it calls, and the nominal structs it names. */
interface KindEmit {
  ctx: CodegenContext;
  store: Instr[];
  flattenIdx: number;
  strEqualsIdx: number;
  externGetIdx: number | undefined;
  classes: { typeIdx: number; tag: number }[];
  fnctors: { typeIdx: number; structName: string; name: string }[];
}

/** `then` when the payload is a `typeIdx` ref. */
function ifPayloadIs(typeIdx: number, then: Instr[]): Instr[] {
  return [...payload, { op: "ref.test", typeIdx }, { op: "if", blockType: { kind: "empty" }, then }];
}

/** Store the anyref on the stack and return, when it is a native string. */
function storeIfString(k: KindEmit): Instr[] {
  const anyStr = k.ctx.anyStrTypeIdx;
  return [
    { op: "local.tee", index: L_TMP },
    { op: "ref.test", typeIdx: anyStr },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: L_TMP }, { op: "ref.cast", typeIdx: anyStr }, ...k.store],
    },
  ];
}

/** Store `name` and return when the i32 on the stack is non-zero. */
function storeNameIf(k: KindEmit, name: string): Instr[] {
  return [{ op: "if", blockType: { kind: "empty" }, then: [...nativeStringLiteralInstrs(k.ctx, name), ...k.store] }];
}

/** Store `name` and return when the i32 on the stack is `tag`. */
function storeIfTag(k: KindEmit, tag: number, name: string): Instr[] {
  return [{ op: "i32.const", value: tag }, { op: "i32.eq" }, ...storeNameIf(k, name)];
}

/** `[[Get]](payload, keys[0])…[[Get]](…, keys[n])`, stored when it is a string. */
function getChainArm(k: KindEmit, externGetIdx: number, keys: string[]): Instr[] {
  const chain: Instr[] = [{ op: "local.get", index: L_PAYLOAD }];
  for (const key of keys)
    chain.push(
      ...nativeStringLiteralInstrs(k.ctx, key),
      { op: "extern.convert_any" },
      { op: "call", funcIdx: externGetIdx },
    );
  return [...chain, { op: "any.convert_extern" }, ...storeIfString(k)];
}

/** Every tagged class struct no non-class struct shares a layout with: its `__tag` field names it exactly. */
function brandedClasses(ctx: CodegenContext): KindEmit["classes"] {
  const isBranded = (name: string) => ctx.classTagMap.has(name) && ctx.structFields.get(name)?.[0]?.name === "__tag";
  const classes: KindEmit["classes"] = [];
  for (const [name, tag] of ctx.classTagMap) {
    const typeIdx = ctx.structMap.get(name);
    if (typeIdx !== undefined && isBranded(name) && [...layoutTwins(ctx, name)].every(isBranded))
      classes.push({ typeIdx, tag });
  }
  return classes;
}

/** The `new F()` structs, as `F`. */
function fnctorStructs(ctx: CodegenContext): KindEmit["fnctors"] {
  const structs: KindEmit["fnctors"] = [];
  for (const [structName, typeIdx] of ctx.structMap)
    if (structName.startsWith(FNCTOR_PREFIX) && !structName.endsWith(COLD_TAIL_SUFFIX))
      structs.push({ typeIdx, structName, name: structName.slice(FNCTOR_PREFIX.length) });
  return structs;
}

/** `then` when the payload is an object `[[Get]]` reads: an open `$Object`, a `new F()` instance or a class instance. */
function ifPayloadIsObject(k: KindEmit, then: Instr[]): Instr[] {
  const types = new Set<number>([...k.fnctors.map((s) => s.typeIdx), ...k.classes.map((c) => c.typeIdx)]);
  const objectTypeIdx = k.ctx.objectRuntimeTypes?.objectTypeIdx;
  if (objectTypeIdx !== undefined) types.add(objectTypeIdx);
  if (types.size === 0) return [];
  const test = [...types].flatMap((typeIdx, i): Instr[] => [
    ...payload,
    { op: "ref.test", typeIdx },
    ...(i === 0 ? [] : [{ op: "i32.or" } as const]),
  ]);
  return [...test, { op: "if", blockType: { kind: "empty" }, then }];
}

/** Slot 0: the payload's `name`. */
function nameSlotArms(k: KindEmit): Instr[] {
  const err = k.ctx.errorStructTypeIdx;
  const arms: Instr[] =
    err < 0
      ? []
      : ifPayloadIs(err, [
          ...payload,
          { op: "ref.cast", typeIdx: err },
          { op: "struct.get", typeIdx: err, fieldIdx: ERROR_NAME_FIELD },
          { op: "any.convert_extern" },
          ...storeIfString(k),
          { op: "i32.const", value: -1 },
          { op: "return" },
        ]);
  if (k.externGetIdx !== undefined) arms.push(...ifPayloadIsObject(k, getChainArm(k, k.externGetIdx, ["name"])));
  return arms;
}

/**
 * An `$Error_struct` no user subclass branded: the builtin constructor its `$tag` names. A user error constructor
 * lowered to an `$Error_struct` (`Test262Error`) shares the `Error` tag, so where the module has one the `name` field
 * tells which constructed it — as `fillExternGetErrorProps` answers `e.constructor`.
 */
function builtinConstructorArms(k: KindEmit, errField: (fieldIdx: number) => Instr[]): Instr[] {
  const sharingError = userErrorCtorNames(k.ctx);
  const nameFieldIs = (name: string): Instr[] => [
    ...errField(ERROR_NAME_FIELD),
    { op: "any.convert_extern" },
    { op: "local.tee", index: L_TMP },
    { op: "ref.test", typeIdx: k.ctx.anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: L_TMP },
        { op: "ref.cast", typeIdx: k.ctx.anyStrTypeIdx },
        { op: "call", funcIdx: k.flattenIdx },
        ...nativeStringLiteralInstrs(k.ctx, name),
        { op: "call", funcIdx: k.strEqualsIdx },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
    ...storeNameIf(k, name),
  ];
  const arms: Instr[] = [];
  for (const name of WASI_ERROR_NAMES) {
    arms.push(...errField(ERROR_TAG_FIELD));
    if (name !== "Error" || sharingError.length === 0) arms.push(...storeIfTag(k, BUILTIN_TYPE_TAGS[name], name));
    else
      arms.push(
        { op: "i32.const", value: BUILTIN_TYPE_TAGS.Error },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...sharingError, "Error"].flatMap(nameFieldIs),
        },
      );
  }
  return arms;
}

/**
 * Leave the payload's class brand on the stack: an `$Error_struct`'s `$userClassId` (answering its builtin
 * constructor first when it has none), a class instance's `__tag`, else -1.
 */
function classBrand(k: KindEmit): Instr[] {
  let brand: Instr[] = [{ op: "i32.const", value: -1 }];
  for (const { typeIdx } of k.classes)
    brand = [
      ...payload,
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [...payload, { op: "ref.cast", typeIdx }, { op: "struct.get", typeIdx, fieldIdx: 0 }],
        else: brand,
      },
    ];
  const err = k.ctx.errorStructTypeIdx;
  if (err < 0) return brand;
  const errField = (fieldIdx: number): Instr[] => [
    ...payload,
    { op: "ref.cast", typeIdx: err },
    { op: "struct.get", typeIdx: err, fieldIdx },
  ];
  return [
    ...payload,
    { op: "ref.test", typeIdx: err },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        ...errField(ERROR_USER_CLASS_FIELD),
        { op: "local.tee", index: L_BRAND },
        { op: "i32.const", value: -1 },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: builtinConstructorArms(k, errField) },
        { op: "local.get", index: L_BRAND },
      ],
      else: brand,
    },
  ];
}

/** Slot 1: the payload's `constructor.name`. */
function constructorSlotArms(k: KindEmit): Instr[] {
  const arms: Instr[] = [...classBrand(k), { op: "local.set", index: L_BRAND }];
  for (const [name, tag] of k.ctx.classTagMap)
    arms.push({ op: "local.get", index: L_BRAND }, ...storeIfTag(k, tag, name));
  if (k.externGetIdx !== undefined)
    return [...arms, ...ifPayloadIsObject(k, getChainArm(k, k.externGetIdx, ["constructor", "name"]))];
  for (const { typeIdx, structName, name } of k.fnctors)
    if (layoutTwins(k.ctx, structName).next().done)
      arms.push(...ifPayloadIs(typeIdx, [...nativeStringLiteralInstrs(k.ctx, name), ...k.store]));
  return arms;
}

/**
 * The `__exn_render_kind` body. Built BEFORE any export function is minted
 * (the index-shift-safety contract of `emitExceptionRenderExports`): it only
 * interns literal globals.
 */
export function exnRenderKindBody(
  ctx: CodegenContext,
  bufGlobalIdx: number,
  flattenIdx: number,
  flatTypeIdx: number,
): Instr[] {
  const k: KindEmit = {
    ctx,
    store: storeAndReturnLen(flattenIdx, bufGlobalIdx, flatTypeIdx),
    flattenIdx,
    // Emitted with the string runtime `emitExceptionRenderExports` requires.
    strEqualsIdx: ctx.nativeStrHelpers.get("__str_equals")!,
    externGetIdx: ctx.funcMap.get("__extern_get"),
    classes: brandedClasses(ctx),
    fnctors: fnctorStructs(ctx),
  };
  return [
    { op: "local.get", index: L_SLOT },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: nameSlotArms(k), else: constructorSlotArms(k) },
    { op: "i32.const", value: -1 },
  ];
}

/** Mint and export `__exn_render_kind` with a body from `exnRenderKindBody`. */
export function pushExnRenderKindExport(ctx: CodegenContext, body: Instr[]): void {
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__exn_render_kind", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__exn_render_kind",
    typeIdx,
    locals: [
      { name: "tmp", type: { kind: "anyref" } },
      { name: "brand", type: { kind: "i32" } },
    ],
    body,
    exported: true,
  });
  ctx.mod.exports.push({ name: "__exn_render_kind", desc: { kind: "func", index: funcIdx } });
}
