// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 W8) The run-time `[[Prototype]]` of a sync generator FUNCTION value
 * under `--target standalone`: `%GeneratorFunction.prototype%` (§27.3.3;
 * §15.5.3 InstantiateGeneratorFunctionObject; §20.2.1.1.1 step 23 for
 * `GeneratorFunction(…)`).
 *
 * ## The gap
 *
 * `Object.getPrototypeOf(g)` answered `%GeneratorFunction.prototype%` only where
 * the compiler could see that the operand was a generator (the static arms in
 * `call-builtin-static.ts`). A generator value that reached the prototype
 * natives at run time got no answer — and the decisive consumer is
 * `OrdinaryHasInstance` (§7.3.19), whose chain walk runs in `__isPrototypeOf`.
 * So `function* g() {}; g instanceof GeneratorFunction` was `false`
 * (`built-ins/GeneratorFunction/has-instance.js`).
 *
 * ## How a generator function is recognised — by IDENTITY, never by shape
 *
 * A generator closure shares its WasmGC struct type with every ordinary closure
 * of the same signature, so no `ref.test` can tell them apart. Two identities
 * can:
 *
 *  1. **The `$fnmeta` instance** (#4437). Every closure created from one
 *     declaration stores one interned `$__fn_instance_meta` object, and a sync
 *     generator declaration/expression is interned under its own key
 *     (`GENERATOR_META_KEY_PREFIX`, `function-instance-meta.ts`). So
 *     `__fninst_meta(v)` being `ref.eq` to a generator-keyed global proves `v`
 *     was created from a generator function; the metadata type is nominal and
 *     unreachable from user source.
 *  2. **The A9 products.** `GeneratorFunction(…)` / `new GeneratorFunction(…)`
 *     return a runtime-eval callable carrier with no `$fnmeta`. Each one is
 *     pushed onto a module list at creation
 *     ({@link emitRegisterDynamicGeneratorFunction}) and compared by `ref.eq`.
 *
 * ## The natives
 *
 * `__genfn_proto_of(v) -> externref` answers `%GeneratorFunction.prototype%`
 * for an identified value, else `null`. It is RESERVED (null body) where the
 * intrinsic is first reified (`emitGeneratorFunctionPrototypeSingleton`) and
 * FILLED at finalize, once every generator metadata global exists — nothing is
 * minted at finalize (the #4221 hazard). Two front arms consult it:
 *
 *  - `__getPrototypeOf`: a non-null answer is returned;
 *  - `__isPrototypeOf(O, V)`: for an identified V, `O === P || O.isPrototypeOf(P)`
 *    with P = `%GeneratorFunction.prototype%` — the walk continues from the
 *    first link like the fnctor / class seeds. This arm must precede them: the
 *    fnctor ladder answers `%Function.prototype%` for a callable once the
 *    module names `Function`, which skips a level of the chain.
 *
 * Both are inserted BEFORE `fillClosedObjectPrototypeEdges` prepends its
 * side-table read, so an explicit `Object.setPrototypeOf(g, X)` recorded there
 * still answers first.
 *
 * ## Why this cannot answer a wrong object
 *
 * The answer is the intrinsic's own lazy global, read only when non-null: the
 * same object a program's `GeneratorFunction.prototype` read yields, so `===`
 * holds by `ref.eq`, and a module that never reified it answers as before.
 * Residual: when nothing has reified it yet, `__getPrototypeOf` declines rather
 * than building it — every consumer that can COMPARE against the object
 * (`instanceof GeneratorFunction`, `GeneratorFunction.prototype.isPrototypeOf`,
 * a static `Object.getPrototypeOf(function* () {})`) has reified it first.
 *
 * Standalone only; in gc/host mode nothing here is emitted.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { allocLocal } from "../context/locals.js";
import { addFuncType } from "../registry/types.js";
import { FNINST_META } from "../function-instance-props.js";
import { GENERATOR_META_KEY_PREFIX } from "../function-instance-meta.js";

/** The lazy global `generator-function-intrinsic.ts` sets to `%GeneratorFunction.prototype%`. */
export const GENERATOR_FUNCTION_PROTOTYPE_GLOBAL = "__native_generator_function_prototype";

const GENFN_PROTO_OF = "__genfn_proto_of";
const LIST_GLOBAL = "__dyn_generator_functions";

/** WasmGC abstract `eq` heap type (signed LEB). */
const EQ_HEAP = -19;

const listNodeTypes = new WeakMap<CodegenContext, number>();

/** Current absolute index of a module global by name (late imported globals shift indices). */
function globalByName(ctx: CodegenContext, name: string): number | undefined {
  const at = ctx.mod.globals.findIndex((g) => g.name === name);
  return at < 0 ? undefined : ctx.numImportGlobals + at;
}

/** Reserve `__genfn_proto_of` with a `null` body. Idempotent; standalone only. */
export function reserveGeneratorFunctionProtoOf(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.funcMap.has(GENFN_PROTO_OF)) return;
  const externref: ValType = { kind: "externref" };
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: GENFN_PROTO_OF,
    typeIdx: addFuncType(ctx, [externref], [externref], `$${GENFN_PROTO_OF}_type`),
    locals: [],
    body: [{ op: "ref.null.extern" }],
    exported: false,
  });
  ctx.funcMap.set(GENFN_PROTO_OF, funcIdx);
}

/**
 * Record the generator function value on top of the stack (an externref) as an
 * A9 product. Leaves it on the stack. A non-`eq` value is not recorded.
 */
export function emitRegisterDynamicGeneratorFunction(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!ctx.standalone) return;
  let nodeTypeIdx = listNodeTypes.get(ctx);
  if (nodeTypeIdx === undefined) {
    nodeTypeIdx = ctx.mod.types.length;
    const nodeRef: ValType = { kind: "ref_null", typeIdx: nodeTypeIdx };
    ctx.mod.types.push({
      kind: "struct",
      name: "$DynGeneratorFunctionNode",
      fields: [
        { name: "next", type: nodeRef, mutable: false },
        { name: "fn", type: { kind: "eqref" }, mutable: false },
      ],
    });
    ctx.mod.globals.push({
      name: LIST_GLOBAL,
      type: nodeRef,
      mutable: true,
      init: [{ op: "ref.null", typeIdx: nodeTypeIdx }],
    });
    listNodeTypes.set(ctx, nodeTypeIdx);
  }
  const head = globalByName(ctx, LIST_GLOBAL)!;
  const valueLocal = allocLocal(fctx, `__genfn_registered_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push(
    { op: "local.tee", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: EQ_HEAP },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "global.get", index: head },
        { op: "local.get", index: valueLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: EQ_HEAP },
        { op: "struct.new", typeIdx: nodeTypeIdx },
        { op: "global.set", index: head },
      ],
    },
    { op: "local.get", index: valueLocal },
  );
}

/** `local.get <a>` as an `eqref` — the caller has proven `ref.test eq`. */
const asEq = (local: number): Instr[] => [
  { op: "local.get", index: local },
  { op: "any.convert_extern" },
  { op: "ref.cast", typeIdx: EQ_HEAP },
];

/** The `__genfn_proto_of` body: param 0 = value; locals 1 = meta, 2 = list cursor. */
function protoOfBody(
  ctx: CodegenContext,
  protoGlobal: number,
): { body: Instr[]; locals: { name: string; type: ValType }[] } {
  const answer = (): Instr[] => [{ op: "global.get", index: protoGlobal }, { op: "return" }];
  const body: Instr[] = [];
  const locals: { name: string; type: ValType }[] = [{ name: "meta", type: { kind: "externref" } }];
  const metaIdx = ctx.funcMap.get(FNINST_META);
  const metaGlobals = [...(ctx.fnInstanceMetaGlobalByKey ?? [])]
    .filter(([key]) => key.startsWith(GENERATOR_META_KEY_PREFIX))
    .map(([, globalIdx]) => globalIdx);
  if (metaIdx !== undefined && metaGlobals.length > 0) {
    body.push(
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: metaIdx },
      { op: "local.tee", index: 1 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: metaGlobals.flatMap((g): Instr[] => [
          ...asEq(1),
          { op: "global.get", index: g },
          { op: "ref.eq" },
          { op: "if", blockType: { kind: "empty" }, then: answer() },
        ]),
      },
    );
  }
  const nodeTypeIdx = listNodeTypes.get(ctx);
  const head = globalByName(ctx, LIST_GLOBAL);
  if (nodeTypeIdx !== undefined && head !== undefined) {
    locals.push({ name: "cursor", type: { kind: "ref_null", typeIdx: nodeTypeIdx } });
    const cursor = (): Instr[] => [{ op: "local.get", index: 2 }, { op: "ref.as_non_null" }];
    body.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: EQ_HEAP },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: head },
          { op: "local.set", index: 2 },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: 2 },
                  { op: "ref.is_null" },
                  { op: "br_if", depth: 1 },
                  ...cursor(),
                  { op: "struct.get", typeIdx: nodeTypeIdx, fieldIdx: 1 },
                  ...asEq(0),
                  { op: "ref.eq" },
                  { op: "if", blockType: { kind: "empty" }, then: answer() },
                  ...cursor(),
                  { op: "struct.get", typeIdx: nodeTypeIdx, fieldIdx: 0 },
                  { op: "local.set", index: 2 },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
        ],
      },
    );
  }
  body.push({ op: "ref.null.extern" });
  return { body, locals };
}

/**
 * FINALIZE: fill `__genfn_proto_of` and splice its two consumer arms. MUST run
 * before `fillClosedObjectPrototypeEdges` (see the module note). Only appends
 * locals and swaps/prepends bodies; nothing is minted.
 */
export function fillGeneratorFunctionPrototypeArms(ctx: CodegenContext): void {
  const protoOfIdx = ctx.funcMap.get(GENFN_PROTO_OF);
  const protoGlobal = globalByName(ctx, GENERATOR_FUNCTION_PROTOTYPE_GLOBAL);
  if (protoOfIdx === undefined || protoGlobal === undefined) return;
  const protoOf = definedFuncAt(ctx, protoOfIdx);
  if (!protoOf) return;
  const filled = protoOfBody(ctx, protoGlobal);
  if (filled.body.length === 1) return; // nothing identifiable: keep the null placeholder
  protoOf.body = filled.body;
  protoOf.locals = filled.locals;

  // Both natives take their candidate in a known slot; the scratch is appended.
  const getProto = ctx.funcMap.get("__getPrototypeOf");
  const getProtoFn = getProto === undefined ? undefined : definedFuncAt(ctx, getProto);
  if (getProtoFn) {
    const scratch = 1 + getProtoFn.locals.length;
    getProtoFn.locals.push({ name: "__genfnProto", type: { kind: "externref" } });
    getProtoFn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: protoOfIdx },
      { op: "local.tee", index: scratch },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: scratch }, { op: "return" }] },
    );
  }
  const isProto = ctx.funcMap.get("__isPrototypeOf");
  const isProtoFn = isProto === undefined ? undefined : definedFuncAt(ctx, isProto);
  if (isProto !== undefined && isProtoFn) {
    const scratch = 2 + isProtoFn.locals.length;
    isProtoFn.locals.push({ name: "__genfnProto", type: { kind: "externref" } });
    isProtoFn.body.unshift(
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: protoOfIdx },
      { op: "local.tee", index: scratch },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // O === P (P is an `$Object`, so it is `eq`; O may be anything)
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: EQ_HEAP },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...asEq(0),
              ...asEq(scratch),
              { op: "ref.eq" },
              { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
            ],
          },
          // …else continue the walk from P.
          { op: "local.get", index: 0 },
          { op: "local.get", index: scratch },
          { op: "call", funcIdx: isProto },
          { op: "return" },
        ],
      },
    );
  }
}
