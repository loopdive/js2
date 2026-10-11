// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#1599 Phase 2) Carrier coverage + cycle detection for the native
 * `JSON.stringify` codec (`__json_stringify_value`, json-codec-native.ts).
 *
 * Two gaps of the codec live here so the 4.5k-line codec only gains call sites:
 *
 *   1. CLOSED USER STRUCTS. A class instance, or an object literal the compiler
 *      lowered to a nominal struct (`const g: {start:number}[] = []; g.push({start: 0})`),
 *      is neither `$Object` nor a vec, so the codec's ladder matched no arm and
 *      rendered the literal `null`. §25.5.2.5 SerializeJSONObject only needs
 *      EnumerableOwnProperties + Get, and the standalone object MOP already
 *      answers both for these carriers (`__object_keys` closed-struct arms,
 *      #3920; `__extern_get`). {@link jsonClosedStructTestInstrs} is the screen:
 *      the finalize-time `__object_assign_closed_struct_source` classifier,
 *      which admits exactly the user-declared shapes the enumeration arms know
 *      (builtin carriers, vecs, strings, proxies and closures stay out).
 *
 *   2. CYCLES. §25.5.2.5 step 1 / §25.5.2.6 step 1: a value already on the
 *      serialisation `stack` throws a TypeError. The codec only had the
 *      512-deep recursion cap, which answered a cycle with a silent `null`.
 *      The stack is depth-indexed: the value serialised at recursion depth `d`
 *      is stored in slot `d`, and a value at depth `d` is compared (`ref.eq`)
 *      against slots `[0, d)` — exactly its ancestor chain, because every
 *      recursion passes `depth + 1` and every value (leaf or container) is
 *      entered, so no slot below `d` can hold a stale non-ancestor. No pop is
 *      needed. Each root call gets a fresh stack (saved/restored around the
 *      call) so a `JSON.stringify` re-entered from a `toJSON`/replacer cannot
 *      clobber its caller's chain.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { classMethodCandidatesForProp, reserveMemberGetDispatch } from "./member-get-dispatch.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";

const EQ_HEAP_TYPE = -19; // abstract `eq` heap type
const CYCLE_MESSAGE = "Converting circular structure to JSON";
const CLOSED_STRUCT_CLASSIFIER = "__object_assign_closed_struct_source";
const TO_JSON_MEMBER_GET = "__get_member_toJSON";

/**
 * `i32` on the stack: is the (non-null) value in `anyLocal` a closed user
 * struct the object MOP can enumerate? `undefined` when the classifier is not
 * registered (non-standalone) — callers then emit no closed-struct arm.
 */
export function jsonClosedStructTestInstrs(ctx: CodegenContext, anyLocal: number): Instr[] | undefined {
  const classifierIdx = ctx.funcMap.get(CLOSED_STRUCT_CLASSIFIER);
  if (classifierIdx === undefined) return undefined;
  return [{ op: "local.get", index: anyLocal }, { op: "extern.convert_any" }, { op: "call", funcIdx: classifierIdx }];
}

/** A replacer argument the type oracle sees as callable (a call signature). */
function jsonReplacerIsCallable(ctx: CodegenContext, replacerArg: ts.Expression | undefined): boolean {
  if (replacerArg === undefined) return false;
  if (ts.isArrowFunction(replacerArg) || ts.isFunctionExpression(replacerArg)) return true;
  return ctx.oracle.signatureOf(replacerArg) !== undefined;
}

/**
 * §25.5.2 step 12: under a callable replacer the ROOT primitive is replaced by
 * the replacer's return, so the primitive fold must not answer. A statically
 * `undefined` root stays on the fold — the codec root cannot yet return JS
 * `undefined` (#6734) and would answer `"null"`.
 */
export function jsonReplacerSeesRoot(
  ctx: CodegenContext,
  value: ts.Expression,
  replacerArg: ts.Expression | undefined,
): boolean {
  const kind = ctx.oracle.typeFactOf(value).kind;
  return kind !== "undefined" && kind !== "void" && jsonReplacerIsCallable(ctx, replacerArg);
}

const PRIMITIVE_FACTS = new Set(["number", "boolean", "string", "null", "undefined"]);

/**
 * A statically primitive stringify value. The codec route compiles it with an
 * externref hint so the number / boolean / string is BOXED — the `anyref` hint
 * drops a number literal to null (why the reverted #5269 G-3 gate answered
 * `JSON.stringify(1, fn) === "null"`).
 */
export function jsonIsPrimitive(ctx: CodegenContext, value: ts.Expression): boolean {
  return PRIMITIVE_FACTS.has(ctx.oracle.typeFactOf(value).kind);
}

/**
 * The `toJSON` lookup (§25.5.2.2 step 2.a `GetV(value, "toJSON")`). A class
 * method lives on the prototype, which the generic `__extern_get` does not see
 * for a closed class-instance struct, so when a `__get_member_toJSON`
 * dispatcher was reserved (see {@link reserveJsonToJson}) it answers
 * instead — it covers class-method arms and falls back to `__extern_get` for
 * everything else. Leaves the method (or a miss value) as externref.
 */
export function jsonToJsonMethodLookupInstrs(ctx: CodegenContext, anyLocal: number, generic: Instr[]): Instr[] {
  const dispatcherIdx = ctx.funcMap.get(TO_JSON_MEMBER_GET);
  if (dispatcherIdx === undefined) return generic;
  return [{ op: "local.get", index: anyLocal }, { op: "extern.convert_any" }, { op: "call", funcIdx: dispatcherIdx }];
}

/**
 * Call-site half of {@link jsonToJsonMethodLookupInstrs}: reserve the
 * `__get_member_toJSON` dispatcher when some class declares a `toJSON` method.
 * Must run before the codec is first emitted (the codec bakes the funcIdx).
 */
export function reserveJsonToJson(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!ctx.standalone || ctx.funcMap.has(TO_JSON_MEMBER_GET)) return;
  if (classMethodCandidatesForProp(ctx, "toJSON").length === 0) return;
  reserveMemberGetDispatch(ctx, "toJSON", fctx);
}

/**
 * Register the cycle stack global (an `$ObjVecArr` of externrefs) and
 * `__json_cycle_enter(v: anyref, depth: i32)`, which throws the §25.5.2.5
 * TypeError when `v` is `ref.eq` to a slot below `depth`, then stores `v` at
 * slot `depth` (growing the array). Idempotent.
 */
function ensureJsonCycleEnter(ctx: CodegenContext, stackArrTypeIdx: number): { funcIdx: number; globalIdx: number } {
  const existingFn = ctx.funcMap.get("__json_cycle_enter");
  const existingGlobal = ctx.mod.globals.findIndex((g) => g.name === "__json_cycle_stack");
  if (existingFn !== undefined && existingGlobal >= 0) {
    return { funcIdx: existingFn, globalIdx: ctx.numImportGlobals + existingGlobal };
  }

  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__json_cycle_stack",
    type: { kind: "ref_null", typeIdx: stackArrTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: stackArrTypeIdx }],
  });

  emitWasiErrorConstructor(ctx, "TypeError", 1);
  const typeErrCtorIdx = ctx.funcMap.get("__new_TypeError");
  const tagIdx = ensureExnTag(ctx);
  addStringConstantGlobal(ctx, CYCLE_MESSAGE);
  const throwCycle: Instr[] =
    typeErrCtorIdx === undefined
      ? [{ op: "unreachable" }]
      : [
          ...stringConstantExternrefInstrs(ctx, CYCLE_MESSAGE),
          { op: "call", funcIdx: typeErrCtorIdx },
          { op: "throw", tagIdx },
        ];

  // params: 0 v:anyref 1 depth:i32 ; locals: 2 stk 3 grown 4 i
  const P_V = 0;
  const P_DEPTH = 1;
  const L_STK = 2;
  const L_NEW = 3;
  const L_I = 4;
  const stackRef: ValType = { kind: "ref_null", typeIdx: stackArrTypeIdx };
  const body: Instr[] = [
    // Only eq-carriers can be ancestors (containers are structs); anything else
    // is a leaf that needs neither a slot nor a check.
    { op: "local.get", index: P_V },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
    { op: "global.get", index: globalIdx },
    { op: "local.set", index: L_STK },
    // Grow when absent or too short: new length = max(8, 2 * (depth + 1)).
    { op: "local.get", index: L_STK },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        { op: "local.get", index: L_STK },
        { op: "array.len" },
        { op: "local.get", index: P_DEPTH },
        { op: "i32.le_u" },
      ],
    },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: P_DEPTH },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "i32.const", value: 1 },
        { op: "i32.shl" },
        { op: "local.tee", index: L_I },
        { op: "i32.const", value: 8 },
        { op: "local.get", index: L_I },
        { op: "i32.const", value: 8 },
        { op: "i32.gt_s" },
        { op: "select" },
        { op: "array.new_default", typeIdx: stackArrTypeIdx },
        { op: "local.set", index: L_NEW },
        { op: "local.get", index: L_STK },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L_NEW },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: L_STK },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: L_STK },
            { op: "array.len" },
            { op: "array.copy", dstTypeIdx: stackArrTypeIdx, srcTypeIdx: stackArrTypeIdx },
          ],
        },
        { op: "local.get", index: L_NEW },
        { op: "global.set", index: globalIdx },
        { op: "local.get", index: L_NEW },
        { op: "local.set", index: L_STK },
      ],
    },
    // for (i = 0; i < depth; i++) if (stk[i] is eq && stk[i] === v) throw TypeError
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_I },
            { op: "local.get", index: P_DEPTH },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_STK },
            { op: "ref.as_non_null" },
            { op: "local.get", index: L_I },
            { op: "array.get", typeIdx: stackArrTypeIdx },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_STK },
                { op: "ref.as_non_null" },
                { op: "local.get", index: L_I },
                { op: "array.get", typeIdx: stackArrTypeIdx },
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                { op: "local.get", index: P_V },
                { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                { op: "ref.eq" },
                { op: "if", blockType: { kind: "empty" }, then: throwCycle },
              ],
            },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // stk[depth] = v
    { op: "local.get", index: L_STK },
    { op: "ref.as_non_null" },
    { op: "local.get", index: P_DEPTH },
    { op: "local.get", index: P_V },
    { op: "extern.convert_any" },
    { op: "array.set", typeIdx: stackArrTypeIdx },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "anyref" }, { kind: "i32" }], []);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__json_cycle_enter", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__json_cycle_enter",
    typeIdx,
    locals: [
      { name: "stk", type: stackRef }, // L_STK
      { name: "grown", type: stackRef }, // L_NEW
      { name: "i", type: { kind: "i32" } }, // L_I
    ],
    body,
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);
  return { funcIdx, globalIdx };
}

/**
 * Instructions for the codec's dispatch: `__json_cycle_enter(any, depth)`.
 * Emitted after the toJSON/rawJSON steps (the stack holds the value that is
 * actually serialised, §25.5.2.5 step 1) and before any container arm.
 */
export function jsonCycleEnterInstrs(
  ctx: CodegenContext,
  stackArrTypeIdx: number,
  anyLocal: number,
  depthParam: number,
): Instr[] {
  const { funcIdx } = ensureJsonCycleEnter(ctx, stackArrTypeIdx);
  return [
    { op: "local.get", index: anyLocal },
    { op: "local.get", index: depthParam },
    { op: "call", funcIdx },
  ];
}

function containsReturn(instrs: readonly Instr[]): boolean {
  for (const instr of instrs) {
    const node = instr as unknown as Record<string, unknown>;
    if (node.op === "return" || node.op === "return_call" || node.op === "return_call_ref") return true;
    for (const key of ["then", "else", "body"]) {
      const nested = node[key];
      if (Array.isArray(nested) && containsReturn(nested as Instr[])) return true;
    }
  }
  return false;
}

/**
 * Give each named root entry a fresh cycle stack for the duration of its call:
 * `saved = stack; stack = null; <body>; stack = saved`. The body's result stays
 * on the operand stack across the restore. A root whose body can `return` early
 * would skip the restore, so it is left unwrapped (none of the current roots do).
 */
export function scopeJsonCycleStackToRoots(ctx: CodegenContext, stackArrTypeIdx: number, rootNames: string[]): void {
  const globalIdx = ctx.mod.globals.findIndex((g) => g.name === "__json_cycle_stack");
  if (globalIdx < 0) return;
  const absGlobalIdx = ctx.numImportGlobals + globalIdx;
  for (const name of rootNames) {
    const fn = ctx.mod.functions.find((candidate) => candidate.name === name);
    if (!fn || containsReturn(fn.body)) continue;
    const funcType = ctx.mod.types[fn.typeIdx] as { kind: string; params?: ValType[]; results?: ValType[] };
    if (funcType?.kind !== "func" || !funcType.params || funcType.results?.length !== 1) continue;
    const savedLocal = funcType.params.length + fn.locals.length;
    fn.locals.push({ name: "__json_saved_stack", type: { kind: "ref_null", typeIdx: stackArrTypeIdx } });
    fn.body = [
      { op: "global.get", index: absGlobalIdx },
      { op: "local.set", index: savedLocal },
      { op: "ref.null", typeIdx: stackArrTypeIdx },
      { op: "global.set", index: absGlobalIdx },
      { op: "block", blockType: { kind: "val", type: funcType.results[0]! }, body: fn.body },
      { op: "local.get", index: savedLocal },
      { op: "global.set", index: absGlobalIdx },
    ];
  }
}
