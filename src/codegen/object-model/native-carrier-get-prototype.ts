// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 U1) `__getPrototypeOf` arms for the native builtin CARRIERS — the
 * generalisation of R1's `arrayGetPrototypeArm` (`object-runtime-prototype.ts`)
 * to every other non-`$Object` instance representation.
 *
 * An Error, a keyed collection, a Date, a Promise or a RegExp is a dedicated
 * WasmGC struct (`$Error_struct`, `$Map`, `__Date`, `$Promise`,
 * `__StandaloneRegExp`), not an `$Object`, so it has no `$proto` field and the
 * dynamic native fell through to its last resort, `null`. Every STATICALLY
 * typed receiver is folded by `expressions/object-get-prototype-of.ts` and never
 * reaches the native, which is why the gap shows only through an `any`
 * binding — measured on base with no realm at all:
 *
 *   function id(x) { return x; }
 *   Object.getPrototypeOf(id(new Map()))                   // null
 *   Object.getPrototypeOf(Reflect.construct(Error, [], NT)) // null (NT.prototype = null)
 *
 * §20.1.2.12 / §28.1.8 → `O.[[GetPrototypeOf]]()`; every one of these objects
 * is ordinary and was created by §10.1.13 OrdinaryCreateFromConstructor with
 * its constructor's intrinsic default prototype (§10.1.14 step 4), which is
 * the answer here.
 *
 * The boxed-primitive WRAPPER (`new String()`/`new Number()`/`new Boolean()`)
 * is the one `$Object` case: it is built with a null `$proto`, which the
 * `$Object` arm resolves to the implicit `%Object.prototype%` terminal. For a
 * wrapper the implicit terminal is its own wrapper prototype (§10.4.3 —
 * the same rule `__protoidx_brand_off` already applies), so the arm answers
 * that instead. An explicitly re-parented wrapper has a non-null `$proto` and
 * is untouched.
 *
 * Contract (R1's): **widens a MISSING answer, never replaces a present one.**
 *  - Only a carrier for which every existing arm answers `null` (or, for the
 *    wrapper, the implicit-terminal default) is claimed.
 *  - An Error answers only for an exact BUILTIN tag with no user-subclass brand
 *    (`$userClassId == -1`), so `class E extends Error` and `Test262Error`
 *    instances keep their current answer.
 *  - Only a brand whose `$NativeProto` singleton the module ALREADY
 *    materialised is answered: building a glue's companion seeder from a
 *    finalize arm can land after the dispatchers are closed (see
 *    `regexp-untyped-receiver.ts`). A program that compares against
 *    `X.prototype` reads it, which materialises it; a module that never names
 *    the intrinsic gets the pre-existing answer and an identical body.
 *  - Answers come from `buildLazyNativeProtoGetInstrs`, the same global a
 *    program's own `X.prototype` read resolves to, so `===` holds by `ref.eq`.
 *
 * Residual, recorded rather than hidden: a native carrier has nowhere to store
 * a re-parented prototype (`Object.setPrototypeOf(map, p)` and a
 * `Reflect.construct(Map, [], NT)` with an object `NT.prototype` are silent
 * no-ops on these structs), and a `class M extends Map` instance shares the
 * `$Map` struct; those answer the intrinsic default here where they answered
 * `null` before.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { BUILTIN_BRAND_TABLE } from "../builtin-brands.js";
import { BUILTIN_TYPE_TAGS } from "../builtin-tags.js";

/** `$Error_struct` fields (`string-layouts.ts::createErrorStructType`). */
const ERROR_TAG_FIELD = 0;
const ERROR_USER_CLASS_FIELD = 4;
/** `$Map.kind` (map-runtime MAP_LAYOUT.M_KIND) and its COLLECTION_KIND values. */
const MAP_KIND_FIELD = 4;
const COLLECTION_BRANDS: readonly (readonly [number, string])[] = [
  [0, "Map"],
  [1, "Set"],
  [2, "WeakMap"],
  [3, "WeakSet"],
];
/** The builtin Error constructors whose instances are a tagged `$Error_struct`. */
const ERROR_BRANDS = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "AggregateError",
  "SuppressedError",
] as const;
/** `$Object` layout (object-runtime.ts): `$proto` and `flags`. */
const OBJECT_PROTO_FIELD = 0;
const OBJECT_FLAGS_FIELD = 4;
/** MUST equal `OBJ_FLAG_NULL_PROTO` in object-runtime.ts. */
const OBJ_FLAG_NULL_PROTO = 0x80;
/** MUST equal `WRAPPER_PRIMITIVE_KEY` in object-runtime.ts (ESM-cycle-free). */
const WRAPPER_PRIMITIVE_KEY = "[[PrimitiveValue]]";
/** `$PropEntry` value / flags fields and the internal-slot flag. */
const ENTRY_VALUE = 1;
const ENTRY_FLAGS = 2;
const FLAG_INTERNAL = 0x10;
const I31_HEAP_TYPE = -20;

/**
 * The two emit helpers this leaf needs, injected by the caller so the leaf does
 * not import `native-proto` / `native-strings` and stays out of the codegen
 * import-cycle SCC (`check:import-cycles`).
 */
export interface NativeCarrierProtoDeps {
  protoGet: (ctx: CodegenContext, brand: number) => Instr[] | null;
  stringLit: (ctx: CodegenContext, value: string) => Instr[];
  /** Define a function with an existing type index; returns its call index. */
  addFunc: (name: string, typeIdx: number, locals: { name: string; type: ValType }[], body: Instr[]) => number;
}

const BASE_NAME = "__getPrototypeOf_base";

/** Fill-time state: the scratch locals the arms share, plus the injected helpers. */
interface Slots {
  any: number;
  entry: number;
  deps: NativeCarrierProtoDeps;
}

/** The intrinsic prototype read for `name`, or null when not materialised. */
function materializedProtoRead(ctx: CodegenContext, slots: Slots, name: string): Instr[] | null {
  const brand = BUILTIN_BRAND_TABLE[name];
  if (brand === undefined || !ctx.nativeProtoGlobals?.has(brand)) return null;
  return slots.deps.protoGet(ctx, brand);
}

/** `if (<cond>) return <proto>` — the cond leaves an i32 on the stack. */
function answerIf(cond: Instr[], proto: Instr[]): Instr[] {
  return [...cond, { op: "if", blockType: { kind: "empty" }, then: [...proto, { op: "return" }] }];
}

function errorArms(ctx: CodegenContext, slots: Slots): Instr[] {
  const typeIdx = ctx.errorStructTypeIdx;
  if (typeIdx < 0) return [];
  const field = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: slots.any },
    { op: "ref.cast", typeIdx },
    { op: "struct.get", typeIdx, fieldIdx },
  ];
  const inner = ERROR_BRANDS.flatMap((name): Instr[] => {
    const proto = materializedProtoRead(ctx, slots, name);
    const tag = (BUILTIN_TYPE_TAGS as Record<string, number>)[name];
    if (!proto || tag === undefined) return [];
    return answerIf([...field(ERROR_TAG_FIELD), { op: "i32.const", value: tag }, { op: "i32.eq" }], proto);
  });
  if (inner.length === 0) return [];
  return [
    { op: "local.get", index: slots.any },
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // A user `extends Error` subclass brands field 4; its prototype is the
        // subclass's, which this arm cannot name.
        ...field(ERROR_USER_CLASS_FIELD),
        { op: "i32.const", value: -1 },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: inner },
      ],
    },
  ];
}

function collectionArms(ctx: CodegenContext, slots: Slots): Instr[] {
  const typeIdx = ctx.mapTypeIdx;
  if (typeIdx === undefined || typeIdx < 0) return [];
  const inner = COLLECTION_BRANDS.flatMap(([kind, name]): Instr[] => {
    const proto = materializedProtoRead(ctx, slots, name);
    if (!proto) return [];
    return answerIf(
      [
        { op: "local.get", index: slots.any },
        { op: "ref.cast", typeIdx },
        { op: "struct.get", typeIdx, fieldIdx: MAP_KIND_FIELD },
        { op: "i32.const", value: kind },
        { op: "i32.eq" },
      ],
      proto,
    );
  });
  if (inner.length === 0) return [];
  return [
    { op: "local.get", index: slots.any },
    { op: "ref.test", typeIdx },
    { op: "if", blockType: { kind: "empty" }, then: inner },
  ];
}

/** A carrier struct whose instances all share one intrinsic prototype. */
function structArm(ctx: CodegenContext, slots: Slots, typeIdx: number | undefined, name: string): Instr[] {
  if (typeIdx === undefined || typeIdx < 0) return [];
  const proto = materializedProtoRead(ctx, slots, name);
  if (!proto) return [];
  return answerIf(
    [
      { op: "local.get", index: slots.any },
      { op: "ref.test", typeIdx },
    ],
    proto,
  );
}

/** The boxed-primitive wrapper: a null-`$proto` `$Object` with an internal slot. */
function wrapperArm(ctx: CodegenContext, slots: Slots): Instr[] {
  const types = ctx.objectRuntimeTypes;
  const findIdx = ctx.funcMap.get("__obj_find");
  if (!types || findIdx === undefined || ctx.anyStrTypeIdx < 0) return [];
  const { objectTypeIdx, propEntryTypeIdx } = types;
  const slotValue = (): Instr[] => [
    { op: "local.get", index: slots.entry },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: ENTRY_VALUE },
  ];
  const kinds: [Instr[], string][] = [[[...slotValue(), { op: "ref.test", typeIdx: ctx.anyStrTypeIdx }], "String"]];
  if (ctx.nativeBoxBooleanTypeIdx >= 0) {
    kinds.push([[...slotValue(), { op: "ref.test", typeIdx: ctx.nativeBoxBooleanTypeIdx }], "Boolean"]);
  }
  const numberTest: Instr[] = [...slotValue(), { op: "ref.test", typeIdx: I31_HEAP_TYPE }];
  if (ctx.nativeBoxNumberTypeIdx >= 0) {
    numberTest.push(...slotValue(), { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx }, { op: "i32.or" });
  }
  kinds.push([numberTest, "Number"]);
  const inner = kinds.flatMap(([test, name]): Instr[] => {
    const proto = materializedProtoRead(ctx, slots, name);
    return proto ? answerIf(test, proto) : [];
  });
  if (inner.length === 0) return [];
  const obj = (): Instr[] => [
    { op: "local.get", index: slots.any },
    { op: "ref.cast", typeIdx: objectTypeIdx },
  ];
  return [
    { op: "local.get", index: slots.any },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // Only the implicit terminal: a stored `$proto` (re-parented wrapper)
        // or an explicit null prototype keeps the `$Object` arm's answer.
        ...obj(),
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: OBJECT_PROTO_FIELD },
        { op: "ref.is_null" },
        ...obj(),
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: OBJECT_FLAGS_FIELD },
        { op: "i32.const", value: OBJ_FLAG_NULL_PROTO },
        { op: "i32.and" },
        { op: "i32.eqz" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...obj(),
            ...slots.deps.stringLit(ctx, WRAPPER_PRIMITIVE_KEY),
            { op: "extern.convert_any" },
            { op: "call", funcIdx: findIdx },
            { op: "local.tee", index: slots.entry },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // A user-written `"[[PrimitiveValue]]"` key is not the slot.
                { op: "local.get", index: slots.entry },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: ENTRY_FLAGS },
                { op: "i32.const", value: FLAG_INTERNAL },
                { op: "i32.and" },
                { op: "if", blockType: { kind: "empty" }, then: inner },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/**
 * Prepend the carrier arms to `__getPrototypeOf`. Called at finalize after
 * every other `__getPrototypeOf` fill, once the native-proto globals are known.
 * Standalone/WASI only; a module with none of the carriers (or none of their
 * intrinsics materialised) is left byte-identical.
 */
export function fillNativeCarrierGetPrototypeOfArms(ctx: CodegenContext, deps: NativeCarrierProtoDeps): void {
  if (!ctx.standalone && !ctx.wasi) return;
  if (!ctx.nativeProtoGlobals || ctx.nativeProtoGlobals.size === 0) return;
  const fn = ctx.mod.functions.find((f) => f.name === "__getPrototypeOf");
  if (!fn?.body || ctx.funcMap.has(BASE_NAME)) return; // idempotent
  // The wrapper arm stays IN FRONT of the original body: a boxed primitive is
  // an `$Object` the original answers with `%Object.prototype%` (present but
  // wrong), and the arm's own test (null `$proto`, no null-proto flag, the
  // internal primitive slot) matches nothing else.
  // Params: 0 = value. Locals are APPENDED so every baked index stays valid.
  const front: Slots = { any: 1 + fn.locals.length, entry: 2 + fn.locals.length, deps };
  const wrapper = wrapperArm(ctx, front);
  // Every other arm is a FALLBACK, consulted only when the original body
  // answers null. Prepending them (the first cut) replaced PRESENT answers too —
  // a user `class X extends Map` instance answered `%Map.prototype%`, which the
  // Temporal polyfill then called methods through (158 standalone rows trapped
  // with illegal_cast in the merge group). The original body moves into
  // `__getPrototypeOf_base`; this function calls it first.
  const tail: Slots = { any: 1, entry: 2, deps };
  const fallback: Instr[] = [
    ...errorArms(ctx, tail),
    ...collectionArms(ctx, tail),
    ...structArm(ctx, tail, ctx.structMap.get("__Date"), "Date"),
    ...structArm(ctx, tail, ctx.structMap.get("$Promise"), "Promise"),
    ...structArm(ctx, tail, ctx.structMap.get("__StandaloneRegExp"), "RegExp"),
  ];
  if (wrapper.length === 0 && fallback.length === 0) return;
  const entryType: ValType = ctx.objectRuntimeTypes
    ? { kind: "ref_null", typeIdx: ctx.objectRuntimeTypes.propEntryTypeIdx }
    : { kind: "anyref" };
  if (wrapper.length > 0) {
    fn.locals.push({ name: "__carrierAny", type: { kind: "anyref" } }, { name: "__carrierEntry", type: entryType });
    fn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: front.any },
      ...wrapper,
    );
  }
  if (fallback.length === 0) return;
  const baseIdx = deps.addFunc(BASE_NAME, fn.typeIdx, fn.locals, fn.body);
  const answer = 3; // locals: 1 = any, 2 = entry, 3 = the base answer
  fn.locals = [
    { name: "__carrierAny", type: { kind: "anyref" } },
    { name: "__carrierEntry", type: entryType },
    { name: "__carrierBase", type: { kind: "externref" } },
  ];
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: baseIdx },
    { op: "local.tee", index: answer },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.set", index: tail.any },
        ...fallback,
      ],
    },
    { op: "local.get", index: answer },
  ];
}
