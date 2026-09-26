// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6674) The §20.1.3.6 builtinTag table for the standalone NOMINAL carriers,
 * plus the step-15 `@@toStringTag` consult for the two runtime consumers.
 *
 * ## What was broken (measured on `d76cdfc9b4`, `--target standalone`)
 *
 * moment's standalone-dynamic lane died in module-init with
 * `TypeError: Object.prototype.toString is not yet implemented in --target
 * standalone`. moment's `isFunction(x)` / `isObject(x)` ask
 * `Object.prototype.toString.call(input)` of an `any` receiver, and its locale
 * `set(config)` loop feeds it every config value — including RegExp literals
 * (`dayOfMonthOrdinalParse`, `meridiemParse`). The runtime classifier
 * (`object-proto-tostring.ts`) had no RegExp arm, so the receiver reached the
 * loud refusal. A probe of 24 receivers through an `any` parameter answered:
 *
 * | receiver                                   | base                        |
 * | ------------------------------------------ | --------------------------- |
 * | `/a/`, `new Date(0)`, `new K()` (class)    | THREW the refusal           |
 * | `Symbol()`, `10n`, `new Map`, `new Set`, `Promise.resolve()` | THREW |
 * | `o` with `o[Symbol.toStringTag] = "Zed"`   | `[object Object]` (step 15 ignored) |
 *
 * `new Date(0)` threw although a Date arm exists: that arm is gated on the
 * `ctor:Date` builtin global, which `new Date(…)` does not publish.
 *
 * ## Why a FINALIZE splice
 *
 * The same reason as `fillIterRecObjectProtoToStringArms`: these carriers
 * (`__StandaloneRegExp`, `__Date`, `$Map`, `$Promise`, `$Symbol`, the BigInt
 * box) register lazily at their first use site, which may be compiled after the
 * classifier body is baked. Splicing ahead of each consumer's tail at finalize
 * sees the final type space and shifts no function index.
 *
 * ## The default arm, and what it declines
 *
 * After the exotic arms, a receiver whose `typeof` is `"object"` and which is
 * NOT a `$Object` answers the step-13 default `[object Object]` — the carrier
 * of a user class instance or an object-literal struct. `$Object` itself stays
 * with the existing chain (its `$Proxy` subtype and primitive-wrapper objects
 * must not be answered `Object`). The #5406 link terminal already ships this
 * exact arm; like it, every nominal carrier whose tag is NOT the default and
 * which has no arm here is DECLINED explicitly, so it keeps the loud refusal
 * rather than being silently mis-tagged.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { BUILTIN_BRAND_TABLE } from "./builtin-brands.js";
import { COLLECTION_KIND } from "./collection-kind.js";
import { MAP_LAYOUT } from "./map-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { standaloneRegExpStructTypeIdx } from "./regexp-standalone.js";
import { OBJECT_PROTO_SYMBOL_TAG_FN, ensureObjectProtoSymbolTagFn } from "./object-proto-symbol-tag.js";
import { flushLateImportShifts } from "./shared.js";
import { allocLocal } from "./context/locals.js";
import { LINK_BOUNDARY_TO_STRING_TAG } from "./link-boundary-names.js";

const EXTERNREF: ValType = { kind: "externref" };

/** `$Proxy.callable` (object-runtime.ts: ptag, ptarget, phandler, ptraps, revoked, callable, …). */
const PROXY_CALLABLE_FIELD = 5;

/** The three consumers of the classifier chain, and each one's receiver local. */
const CONSUMERS: ReadonlyArray<readonly [name: string, receiverIndex: number]> = [
  ["__opts_classify", 0],
  ["__object_proto_to_string_runtime", 1],
  [`__proto_method_${BUILTIN_BRAND_TABLE.Object}_toString`, 1],
];

/** Consumers already spliced (a second finalize run must not re-append). */
const filled = new WeakSet<WasmFunction>();

/** A `then` block returning the constant `"[object <tag>]"`. */
function returnTag(ctx: CodegenContext, tag: string): Instr[] {
  const text = `[object ${tag}]`;
  addStringConstantGlobal(ctx, text);
  return [...stringConstantExternrefInstrs(ctx, text), { op: "return" } as Instr];
}

/** `(typeIdx, tag)` for every single-tag nominal carrier the module registered. */
function exoticCarrierTags(ctx: CodegenContext): Array<readonly [number, string]> {
  const pairs: Array<readonly [number | undefined, string]> = [
    [ctx.structMap.get("__Date"), "Date"],
    [standaloneRegExpStructTypeIdx(ctx), "RegExp"],
    [ctx.errorStructTypeIdx, "Error"],
    // A standalone primitive-wrapper STRUCT (any-helpers.ts): steps 5-7.
    [ctx.structMap.get("WrapperString"), "String"],
    [ctx.structMap.get("WrapperNumber"), "Number"],
    [ctx.structMap.get("WrapperBoolean"), "Boolean"],
  ];
  return pairs.filter((p): p is readonly [number, string] => p[0] !== undefined && p[0] >= 0);
}

/**
 * Carriers whose tag is NOT a builtinTag: §20.4.3.6 / §21.2.3.7 / §27.2.5.5 /
 * §26.1.3.3 give it to their PROTOTYPE as an own `@@toStringTag`, which step 15
 * reads. The standalone `Get` (`__extern_get`) does not reach the intrinsic
 * prototype of these carriers — measured: the consult returns null for
 * `new Map()` — so the arm answers the value that `Get` would read from an
 * unmodified prototype. Named residual: a user `delete` / overwrite of
 * `Map.prototype[@@toStringTag]` (test262 `symbol-tag-*-builtin.js`) is not
 * observed; those rows threw the refusal before and still fail.
 */
function protoTaggedCarriers(ctx: CodegenContext): Array<readonly [number, string]> {
  const pairs: Array<readonly [number | undefined, string]> = [
    [ctx.symbolTypeIdx, "Symbol"],
    [ctx.nativeBigIntTypeIdx, "BigInt"],
    [ctx.structMap.get("$Promise"), "Promise"],
    [ctx.weakRefTypeIdx, "WeakRef"],
    [ctx.structMap.get("DisposableStack"), "DisposableStack"],
  ];
  return pairs.filter((p): p is readonly [number, string] => p[0] !== undefined && p[0] >= 0);
}

/**
 * Nominal carriers with a non-default tag this module does not answer — they
 * must keep the refusal rather than reach the `[object Object]` default arm.
 */
function declinedCarrierTypeIdxs(ctx: CodegenContext): number[] {
  const named = [
    "__IterRec", // spliced by fillIterRecObjectProtoToStringArms; UNKNOWN family declines
    "__proxy_revoker",
    "$LazyIterHelper", // %IteratorHelperPrototype%[@@toStringTag] = "Iterator Helper"
    "Hole",
  ].map((name) => ctx.structMap.get(name));
  const generatorStates = [...ctx.structMap.entries()]
    .filter(([name]) => name.startsWith("__GenState_") || name.startsWith("$AsyncFrame_"))
    .map(([, typeIdx]) => typeIdx);
  return [...named, ctx.nativeProtoTypeIdx, ...generatorStates].filter(
    (typeIdx): typeIdx is number => typeIdx !== undefined && typeIdx >= 0,
  );
}

/**
 * The arms that name a SPECIFIC tag (builtinTag carriers, prototype-tagged
 * carriers, the `$Map` kind ladder, `$Proxy`). Also used by the provider's
 * link terminal (link-boundary-tostring.ts), so a linked peer answers its own
 * Date / Map / RegExp instead of declining them.
 */
export function buildTaggedCarrierArms(ctx: CodegenContext, receiverIndex: number): Instr[] {
  const recvAny = (): Instr[] => [{ op: "local.get", index: receiverIndex }, { op: "any.convert_extern" }];
  const arms: Instr[] = [];
  for (const [typeIdx, tag] of [...exoticCarrierTags(ctx), ...protoTaggedCarriers(ctx)]) {
    arms.push(
      ...recvAny(),
      { op: "ref.test", typeIdx },
      { op: "if", blockType: { kind: "empty" }, then: returnTag(ctx, tag) },
    );
  }

  // Map / Set / WeakMap / WeakSet share `$Map`, branded by its immutable kind.
  if (ctx.mapTypeIdx >= 0) {
    const kindTags: ReadonlyArray<readonly [number, string]> = [
      [COLLECTION_KIND.MAP, "Map"],
      [COLLECTION_KIND.SET, "Set"],
      [COLLECTION_KIND.WEAKMAP, "WeakMap"],
      [COLLECTION_KIND.WEAKSET, "WeakSet"],
    ];
    const ladder: Instr[] = kindTags.flatMap(([kind, tag]): Instr[] => [
      ...recvAny(),
      { op: "ref.cast", typeIdx: ctx.mapTypeIdx },
      { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: MAP_LAYOUT.M_KIND },
      { op: "i32.const", value: kind },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: returnTag(ctx, tag) },
    ]);
    arms.push(
      ...recvAny(),
      { op: "ref.test", typeIdx: ctx.mapTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: ladder },
    );
  }

  // A `$Proxy` (NOT a `$Object` subtype — object-runtime.ts declares it flat):
  // step 4 IsArray unwraps to the target and throws for a revoked proxy
  // (§7.2.2 step 3), which `__extern_is_array` already implements; a proxy has
  // no other internal slot the ladder tests, so it is Function when callable
  // (step 6) and the step-13 default otherwise.
  const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
  const isArrayIdx = ctx.funcMap.get("__extern_is_array");
  if (proxyTypeIdx !== undefined && isArrayIdx !== undefined) {
    arms.push(
      ...recvAny(),
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: receiverIndex },
          { op: "call", funcIdx: isArrayIdx },
          { op: "if", blockType: { kind: "empty" }, then: returnTag(ctx, "Array") },
          ...recvAny(),
          { op: "ref.cast", typeIdx: proxyTypeIdx },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: PROXY_CALLABLE_FIELD },
          { op: "if", blockType: { kind: "empty" }, then: returnTag(ctx, "Function") },
          ...returnTag(ctx, "Object"),
        ],
      },
    );
  }

  return arms;
}

function buildCarrierArms(ctx: CodegenContext, receiverIndex: number): Instr[] {
  const recvAny = (): Instr[] => [{ op: "local.get", index: receiverIndex }, { op: "any.convert_extern" }];
  const arms = buildTaggedCarrierArms(ctx, receiverIndex);
  // Step 13 default for every other object-typed, non-`$Object` carrier. NOT in
  // a linked consumer: the classifier's peer consult (#5406) has already run,
  // and a non-`$Object` carrier the peer declined is one of ITS exotics that no
  // local type test can name — the default would mis-tag it. (The peer answers
  // `[object Object]` for class instances of either module itself.)
  if (ctx.exportsConsumedByWasm !== true && ctx.funcMap.get(LINK_BOUNDARY_TO_STRING_TAG) !== undefined) return arms;
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  if (typeofObjectIdx !== undefined && objectTypeIdx !== undefined) {
    const declines: Instr[] = declinedCarrierTypeIdxs(ctx).flatMap((typeIdx): Instr[] => [
      ...recvAny(),
      { op: "ref.test", typeIdx },
      { op: "i32.eqz" },
      { op: "i32.and" },
    ]);
    arms.push(
      { op: "local.get", index: receiverIndex },
      { op: "call", funcIdx: typeofObjectIdx },
      ...recvAny(),
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      { op: "i32.and" },
      ...declines,
      { op: "if", blockType: { kind: "empty" }, then: returnTag(ctx, "Object") },
    );
  }
  return arms;
}

/** Index of the consumer's terminal refusal/decline sequence, or -1. */
function tailStart(fn: WasmFunction): number {
  const b = fn.body;
  const n = b.length;
  if (b[n - 1]?.op === "ref.null.extern") return n - 1;
  if (
    n >= 4 &&
    b[n - 1]?.op === "throw" &&
    b[n - 2]?.op === "call" &&
    b[n - 3]?.op === "extern.convert_any" &&
    b[n - 4]?.op === "global.get"
  ) {
    return n - 4;
  }
  return -1;
}

/**
 * FINALIZE: splice the nominal-carrier arms ahead of every classifier
 * consumer's tail. Called at the end of `fillIterRecObjectProtoToStringArms`
 * (both finalize pipelines), so the iterator-record ladder precedes this pass's
 * default arm. Idempotent per
 * consumer body (a second run would only append arms that can never fire).
 */
export function fillObjectProtoToStringCarrierArms(ctx: CodegenContext): void {
  if (!ctx.standalone || !ctx.nativeStrings) return;
  for (const [name, receiverIndex] of CONSUMERS) {
    const fn = ctx.mod.functions.find((f) => (f as { name?: string }).name === name) as WasmFunction | undefined;
    if (!fn || filled.has(fn)) continue;
    const at = tailStart(fn);
    if (at < 0) continue;
    fn.body.splice(at, 0, ...buildCarrierArms(ctx, receiverIndex));
    filled.add(fn);
  }
}

/**
 * §20.1.3.6 steps 14-15 for the two RUNTIME consumers (the `any`-receiver
 * helper and the reflective `Object.prototype.toString` closure): when
 * `Get(ToObject(O), @@toStringTag)` is a String it overrides every builtinTag,
 * so this runs FIRST. Skipped only for null/undefined (steps 1-2 return before
 * any `Get`); a primitive IS read, because `Symbol.prototype` /
 * `BigInt.prototype` carry the tag and a user may set one on
 * `Boolean.prototype` (test262 `symbol-tag-override-primitives.js`).
 *
 * Emitted only when the module ALREADY has the `$Symbol` carrier: without it no
 * code can have stored a `@@toStringTag`, and registering the carrier here
 * would be the late registration `object-runtime.ts`'s `symbolKeysEnabled`
 * snapshot cannot see (its key path would then not recognise the carrier).
 *
 * `__opts_classify` does not take this: its only caller, the fold, already
 * consults `__opts_symbol_tag` itself, and a second `Get` would run a
 * `@@toStringTag` accessor twice.
 */
export function emitObjectProtoToStringSymbolTagConsult(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverIndex: number,
): void {
  if (!ctx.standalone || ctx.symbolTypeIdx < 0) return;
  if (ctx.funcMap.get("__typeof_undefined") === undefined) return;
  if (ensureObjectProtoSymbolTagFn(ctx) === undefined) return;
  flushLateImportShifts(ctx, fctx);
  const typeofUndefinedIdx = ctx.funcMap.get("__typeof_undefined");
  const symbolTagIdx = ctx.funcMap.get(OBJECT_PROTO_SYMBOL_TAG_FN);
  if (typeofUndefinedIdx === undefined || symbolTagIdx === undefined) return;
  const tagLocal = allocLocal(fctx, `__opts_symtag_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push(
    { op: "local.get", index: receiverIndex },
    { op: "ref.is_null" },
    { op: "local.get", index: receiverIndex },
    { op: "call", funcIdx: typeofUndefinedIdx },
    { op: "i32.or" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: receiverIndex },
        { op: "call", funcIdx: symbolTagIdx },
        { op: "local.tee", index: tagLocal },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: tagLocal }, { op: "return" }] },
      ],
    },
  );
}
