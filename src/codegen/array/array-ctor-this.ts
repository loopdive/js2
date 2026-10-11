// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6771 S7) `Array.from.call(C, …)` / `Array.of.call(C, …)` results, and
 * `Construct(Object)`, `--target standalone`.
 *
 * ## Array-typed values that are not arrays
 *
 * §23.1.2.1 step 5.a / §23.1.2.3 step 4: with a constructor `this`, the result
 * is `Construct(C)` — an ordinary object linked to `C.prototype`. TypeScript
 * still types the call `T[]`, so three STATIC folds keyed on the checker's
 * Array type answered for an Array that is not there:
 *
 * | read                               | fold                 | value's answer          |
 * | ---------------------------------- | -------------------- | ----------------------- |
 * | `result.constructor`               | `%Array%` carrier     | `C` (inherited)         |
 * | `Array.isArray(result)`            | `true`               | `false`                 |
 * | `Object.getPrototypeOf(result)`    | `%Array.prototype%`   | `C.prototype`           |
 *
 * (`Array/from/iter-cstm-ctor.js`, `source-object-constructor.js`.) The
 * pre-scan notes a `<Array>.{from,of}.{call,apply}(…)` spelling; in such a
 * module the three folds consult the VALUE: `Array.isArray` and
 * `getPrototypeOf` take their runtime paths (`arrayTypedValueMayNotBeArray`),
 * and `.constructor` answers `%Array%` for a genuine array and the ordinary
 * `[[Get]]` otherwise — so every real array keeps its previous answer.
 *
 * ## `Construct(Object)`
 *
 * `Array.from.call(Object, [])` reaches `__native_construct_0` with the reified
 * `Object` carrier, whose ordinary tail reads `Object.prototype` off the
 * carrier (it has none) and builds a null-prototype object. §20.1.1.1 step 3:
 * `new Object()` is OrdinaryObjectCreate(%Object.prototype%) —
 * `__new_plain_object()`. {@link objectConstructArm} is that arm.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { emitArrayIsArrayExternrefPredicate, emitBuiltinNamespaceObject } from "../helpers/core-delegates.js"; // (#6797) late-bound core
import { compileExpression, ensureLateImport, flushLateImportShifts } from "../shared.js";
import { nativeStringLiteralInstrs } from "../native-string-literals.js";

const EXTERNREF: ValType = { kind: "externref" };
const EQ_HEAP_TYPE = -19; // WasmGC `eq` abstract heap type

const armed = new WeakSet<CodegenContext>();

/** Pre-scan hook: `Array.from.call(…)` / `Array.of.apply(…)` & co. (standalone). */
export function noteArrayCtorThisCall(ctx: CodegenContext, node: ts.Node): void {
  if (!ctx.standalone || armed.has(ctx) || !ts.isCallExpression(node)) return;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || (callee.name.text !== "call" && callee.name.text !== "apply")) return;
  const method = callee.expression;
  if (
    ts.isPropertyAccessExpression(method) &&
    (method.name.text === "from" || method.name.text === "of") &&
    ts.isIdentifier(method.expression) &&
    method.expression.text === "Array"
  ) {
    armed.add(ctx);
  }
}

/** Did the pre-scan see a constructor-`this` `Array.from`/`Array.of`? */
export function arrayCtorThisCallSeen(ctx: CodegenContext): boolean {
  return armed.has(ctx);
}

/**
 * `<Array-typed>.constructor` (the static fold's namespace is `"Array"`) in an
 * armed module: compile the receiver, then `IsArray(v) ? %Array% :
 * [[Get]](v, "constructor")`. `undefined` (emitting nothing) otherwise.
 */
export function tryEmitGuardedArrayConstructorRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  nsName: string,
  receiver: ts.Expression,
): ValType | undefined {
  if (nsName !== "Array" || !armed.has(ctx)) return undefined;
  const compileReceiver = (e: ts.Expression): ValType | null => compileExpression(ctx, fctx, e);
  const arrayIdentity = (): ValType | null => emitBuiltinNamespaceObject(ctx, fctx, "Array");
  const externGet = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  if (externGet === undefined) return undefined;
  const recv = allocLocal(fctx, `__actor_recv_${fctx.locals.length}`, EXTERNREF);
  const t = compileReceiver(receiver);
  if (t === null) fctx.body.push({ op: "ref.null.extern" });
  else if (t.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "local.tee", index: recv });
  emitArrayIsArrayExternrefPredicate(ctx, fctx);
  const saved = fctx.body;
  const arrayArm: Instr[] = [];
  fctx.body = arrayArm;
  const identityType = arrayIdentity();
  fctx.body = saved;
  if (identityType === null) return undefined;
  if (identityType.kind !== "externref") arrayArm.push({ op: "extern.convert_any" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: arrayArm,
    else: [
      { op: "local.get", index: recv },
      ...nativeStringLiteralInstrs(ctx, "constructor"),
      { op: "extern.convert_any" },
      { op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? externGet },
    ],
  });
  return EXTERNREF;
}

/**
 * `__native_construct_<N>` arm (callee = param 0): the reified `Object`
 * constructor builds `__new_plain_object()`. Empty when the module never
 * reified `Object` as a value.
 */
export function objectConstructArm(ctx: CodegenContext): Instr[] {
  const newPlainObject = ctx.funcMap.get("__new_plain_object");
  if (newPlainObject === undefined) return [];
  const out: Instr[] = [];
  for (const key of ["ctor:Object", "Object"]) {
    const globalIdx = ctx.builtinObjectGlobals.get(key);
    if (globalIdx === undefined) continue;
    out.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: globalIdx },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
              { op: "global.get", index: globalIdx },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
              { op: "ref.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "call", funcIdx: newPlainObject }, { op: "return" }],
              },
            ],
          },
        ],
      },
    );
  }
  return out;
}

/** §23.1.3.4/7/26/30: these return `O` itself — the receiver, not a new array. */
const RETURNS_RECEIVER = new Set(["copyWithin", "fill", "reverse", "sort"]);
/** These build their result with ArraySpeciesCreate (§10.4.2.3). */
const SPECIES_CREATORS = new Set(["concat", "filter", "flat", "flatMap", "map", "slice", "splice"]);

/**
 * `var r = <call>` whose checker type is an Array but whose VALUE is not a
 * fresh array of the binding's element type (standalone):
 *
 * - `Array.from.call(C, …)` / `Array.of.apply(C, …)` with a `this` other than
 *   `Array` — `Construct(C)`'s object (`Array/of/return-a-custom-instance.js`,
 *   `sets-length.js`);
 * - `Array.prototype.{copyWithin,fill,reverse,sort}.call(O, …)` — `O` itself;
 * - `Array.prototype.{concat,filter,flat,flatMap,map,slice,splice}.call(O, …)`
 *   in a module where ArraySpeciesCreate is observable (`Symbol.species` /
 *   `.constructor` writes) or a Proxy exists — the species constructor's object
 *   (the #6651 H6 `create-proxy.js` shape bound to a `var`).
 *
 * A vec-typed slot MATERIALIZES a copy at the declaration store, so
 * `r instanceof C`, `r === O` and `thisVal === r` went false. The binding keeps
 * the externref the call returned — the #6651 E5 answer for the TypedArray
 * `from`/`of` twins, through the same slot hook.
 */
export function reflectiveArrayCallNeedsExternref(
  ctx: CodegenContext,
  initializer: ts.Expression | undefined,
): boolean {
  if (!ctx.standalone || !initializer || !ts.isCallExpression(initializer)) return false;
  const callee = initializer.expression;
  if (!ts.isPropertyAccessExpression(callee) || (callee.name.text !== "call" && callee.name.text !== "apply")) {
    return false;
  }
  const member = callee.expression;
  if (!ts.isPropertyAccessExpression(member)) return false;
  const owner = member.expression;
  const name = member.name.text;
  if ((name === "from" || name === "of") && ts.isIdentifier(owner) && owner.text === "Array") {
    const thisArg = initializer.arguments[0];
    return thisArg !== undefined && !(ts.isIdentifier(thisArg) && thisArg.text === "Array");
  }
  const speciesObservable = ctx.arraySpeciesDirty || ctx.proxyDirty === true;
  return (
    (RETURNS_RECEIVER.has(name) || (SPECIES_CREATORS.has(name) && speciesObservable)) &&
    ts.isPropertyAccessExpression(owner) &&
    owner.name.text === "prototype" &&
    ts.isIdentifier(owner.expression) &&
    owner.expression.text === "Array"
  );
}
