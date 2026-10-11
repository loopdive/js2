// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5350 r2) `super.x = v` / `super[k] = v` in standalone.
 *
 * §13.15.2 PutValue on a SuperProperty reference is
 * `base.[[Set]](key, value, thisValue)`: the prototype chain is searched from
 * GetSuperBase() — the [[HomeObject]]'s [[Prototype]] — but a data property is
 * CREATED on the RECEIVER (`this`), and a `false` result throws a TypeError in
 * strict code. Before this the write took the ordinary member-assignment
 * lowering with `super` as the object, which wrote nowhere and never threw
 * (probe p10 bits 2 / 8 / 16).
 *
 * The receiver-threaded [[Set]] is `__reflect_set_receiver` (#5316 r5,
 * `object-runtime-ordinary-set.ts`); the [[HomeObject]] and `actualThis` come
 * from the same emitters the #5350 r1 READ uses
 * (`objectLiteralSuperRefEmitters` / `classSuperRefEmitters` in
 * `new-super.ts`), so the home-object lookup has one implementation.
 *
 * ## Order (§13.15.2, §13.3.7.1, §6.2.5.6 PutValue)
 *
 *   1. GetThisBinding — the derived-constructor uninitialised-`this` check;
 *      `actualThis` is captured into a local here, before any user code runs
 *      (the standalone `__current_this` carrier is a global a nested call can
 *      overwrite).
 *   2. `super[Expression]`: the key expression is evaluated (GetValue only).
 *   3. GetSuperBase — `[[HomeObject]].[[GetPrototypeOf]]()`, spilled.
 *   4. The RHS.
 *   5. PutValue 3.a: ToObject(base) — a null/undefined base throws a TypeError
 *      only NOW, after the RHS (`assignment/target-super-*-reference-null.js`;
 *      node 22 agrees, probe `order.js`: `rTrTkrT`).
 *   6. PutValue 3.c: ToPropertyKey(key) — after GetSuperBase, so a key whose
 *      `toString` re-points the home object's prototype cannot move the base
 *      (`prop-expr-getsuperbase-before-topropertykey-putvalue.js`).
 *   7. `base.[[Set]](key, V, actualThis)`; `false` in strict code ⇒ TypeError.
 *
 * The r2 plan listed ToPropertyKey before the RHS; the spec's PutValue step 3.c
 * puts it after, and so does this lowering. Both orders keep GetSuperBase ahead
 * of ToPropertyKey, which is the property that plan step protects.
 *
 * ## Scope
 *
 * Standalone only, and only where the READ already has a [[HomeObject]]: an
 * object-literal method/accessor, or a NON-STATIC class member whose class
 * owns a #5195 prototype `$Object` (and, if derived, whose parent does too).
 * Everything else — static methods, builtin-parent subclasses, a heritage
 * expression the compiler cannot name, class-field initialisers — returns
 * `undefined` having emitted nothing, and keeps the pre-r2 lowering.
 */
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { nullishExternTestInstrs } from "../any-helpers.js";
import { ensureObjectNativeProtoGlue } from "../array-object-proto.js";
import { standaloneClassProtoObjectApplies } from "../class-proto-object.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { isStrictContext } from "../helpers/is-strict-function.js";
import { emitThrowTypeError } from "../js-errors.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { noteReflectSetReceiverCall, REFLECT_SET_RECEIVER } from "../object-runtime-ordinary-set.js";
import { OBJECT_PROTO_SINGLETON } from "../object-runtime-prototype.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { coerceType, compileExpression, resolveEnclosingClassName, VOID_RESULT, type InnerResult } from "../shared.js";
import { emitToPropertyKeyOnce } from "./computed-member-reference.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { emitSuperUninitializedThisCheck } from "../classes/derived-ctor-this-guard.js"; // (#6772 S1b) moved from new-super
import {
  classSuperRefEmitters,
  enclosingClassExtendsNull,
  objectLiteralSuperRefEmitters,
  type StandaloneSuperRefEmitters,
} from "./new-super.js";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * Where GetSuperBase() comes from:
 *   - `literal` / `derived` — `[[HomeObject]].[[GetPrototypeOf]]()`, which can
 *     be null (a re-pointed prototype), so PutValue's ToObject can throw;
 *   - `base` — a class with no `extends`: the same read, with the implicit
 *     `%Object.prototype%` terminal substituted for a nullish answer;
 *   - `null` — `class C extends null`: the base IS null (§15.7.14), a TypeError.
 */
type SuperBaseKind = "literal" | "derived" | "base" | "null";

interface SuperWritePlan {
  refs: StandaloneSuperRefEmitters | undefined;
  base: SuperBaseKind;
}

/** The method / accessor / constructor a `super` reference binds to (arrows are transparent). */
function superOwner(node: ts.Node): ts.Node | undefined {
  for (let cur = node.parent; cur !== undefined; cur = cur.parent) {
    if (ts.isArrowFunction(cur)) continue;
    if (
      ts.isMethodDeclaration(cur) ||
      ts.isGetAccessorDeclaration(cur) ||
      ts.isSetAccessorDeclaration(cur) ||
      ts.isConstructorDeclaration(cur)
    ) {
      return cur;
    }
    if (ts.isFunctionLike(cur) || ts.isClassLike(cur) || ts.isPropertyDeclaration(cur)) return undefined;
  }
  return undefined;
}

function resolveSuperWritePlan(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): SuperWritePlan | undefined {
  const owner = superOwner(target);
  if (owner === undefined) return undefined;
  const className = resolveEnclosingClassName(fctx);
  const home = owner.parent;
  if (ts.isObjectLiteralExpression(home)) {
    // The read dispatches on the same predicate (`!currentClassName`).
    if (className !== undefined) return undefined;
    return {
      refs: objectLiteralSuperRefEmitters(ctx, fctx, target, /* closedLiteralTypedSelf */ true),
      base: "literal",
    };
  }
  if (!ts.isClassDeclaration(home) && !ts.isClassExpression(home)) return undefined;
  const isStatic =
    ts.canHaveModifiers(owner) && ts.getModifiers(owner)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
  if (isStatic || className === undefined) return undefined;
  const heritage = home.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
  if (heritage !== undefined && enclosingClassExtendsNull(target)) return { refs: undefined, base: "null" };
  if (!standaloneClassProtoObjectApplies(ctx, className)) return undefined;
  const selfIdx = fctx.localMap.get("this");
  if (selfIdx === undefined) return undefined;
  const parentClassName = ctx.classParentMap.get(className);
  let base: SuperBaseKind;
  if (heritage === undefined) {
    if (parentClassName !== undefined) return undefined;
    base = "base";
  } else {
    // A parent without a prototype `$Object` (a builtin, or a heritage
    // expression the compiler cannot name) has no chain to walk — the READ
    // declines on the same test (`compileStandaloneClassSuperPropertyRead`).
    if (parentClassName === undefined || !standaloneClassProtoObjectApplies(ctx, parentClassName)) return undefined;
    base = "derived";
  }
  return { refs: classSuperRefEmitters(ctx, fctx, className, selfIdx), base };
}

/** `if (<i32>) throw TypeError(message)` — consumes the condition. */
function emitThrowTypeErrorIf(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  const start = fctx.body.length;
  emitThrowTypeError(ctx, fctx, message);
  const throwInstrs = fctx.body.splice(start);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: [] });
}

/** Push `1` when the externref in `local` is null or the `undefined` singleton. */
function emitNullishTest(ctx: CodegenContext, fctx: FunctionContext, local: number): void {
  const nullishTest = nullishExternTestInstrs(ctx, local);
  if (nullishTest) fctx.body.push(...nullishTest);
  else fctx.body.push({ op: "local.get", index: local }, { op: "ref.is_null" });
}

/**
 * Lower `super.<name> = value` / `super[<key>] = value` onto
 * `__reflect_set_receiver`. Returns `undefined` — having emitted NOTHING — when
 * the shape is out of scope, and the caller keeps its pre-r2 lowering.
 */
export function tryCompileStandaloneSuperWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  value: ts.Expression,
): InnerResult | undefined {
  if (!ctx.standalone) return undefined;
  if (target.expression.kind !== ts.SyntaxKind.SuperKeyword) return undefined;
  let keyName: string | undefined;
  let keyExpr: ts.Expression | undefined;
  if (ts.isPropertyAccessExpression(target)) {
    if (ts.isPrivateIdentifier(target.name)) return undefined;
    keyName = target.name.text;
  } else {
    const arg = target.argumentExpression;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) keyName = arg.text;
    else if (ts.isNumericLiteral(arg)) keyName = String(Number(arg.text));
    else keyExpr = arg;
  }

  const plan = resolveSuperWritePlan(ctx, fctx, target);
  if (plan === undefined) return undefined;

  // Probe the natives BEFORE any operand is emitted. `__reflect_set_receiver`
  // is an OBJECT_RUNTIME_HELPER_NAMES native, so this binds the DEFINED
  // function (no import, no funcIdx shift) or answers `undefined` when a
  // primitive the walk needs is missing — then the pre-r2 lowering stands.
  ensureObjectRuntime(ctx);
  if (
    ensureLateImport(ctx, REFLECT_SET_RECEIVER, [EXTERNREF, EXTERNREF, EXTERNREF, EXTERNREF], [{ kind: "i32" }]) ===
    undefined
  ) {
    return undefined;
  }
  flushLateImportShifts(ctx, fctx);
  if (ctx.funcMap.get("__getPrototypeOf") === undefined) return undefined;
  if (keyName !== undefined) addStringConstantGlobal(ctx, keyName);
  // An ordinary home object stores no `%Object.prototype%` link — its null
  // `$proto` IS that implicit terminal, which `__getPrototypeOf` answers through
  // the reserve-then-fill `OBJECT_PROTO_SINGLETON`. That singleton is filled
  // only when the `Object` brand's glue is registered; without it the base
  // read null and the ToObject step threw on a valid write (probe c10:
  // "Cannot set properties of null or undefined (super base)").
  ensureObjectNativeProtoGlue(ctx);

  // 1. GetThisBinding (§13.3.7.1 step 2) — the derived-constructor check the
  //    read uses. An unconditional throw leaves nothing to evaluate.
  if (emitSuperUninitializedThisCheck(ctx, fctx, target)) return VOID_RESULT;

  let homeLocal: number | undefined;
  let homeKind: boolean | "base" = true;
  if (plan.refs !== undefined) {
    homeKind = plan.refs.emitHomeObject();
    if (homeKind === false) return undefined;
    homeLocal = allocLocal(fctx, `__super_wr_home_${fctx.locals.length}`, EXTERNREF);
    fctx.body.push({ op: "local.set", index: homeLocal });
  }
  const recvLocal = allocLocal(fctx, `__super_wr_recv_${fctx.locals.length}`, EXTERNREF);
  if (plan.refs !== undefined) plan.refs.emitReceiver();
  else fctx.body.push({ op: "ref.null.extern" }); // `extends null`: the write throws before [[Set]]
  fctx.body.push({ op: "local.set", index: recvLocal });

  // 2. The key expression (GetValue only; ToPropertyKey is PutValue step 3.c).
  let keyLocal: number | undefined;
  if (keyExpr !== undefined) {
    keyLocal = allocLocal(fctx, `__super_wr_key_${fctx.locals.length}`, EXTERNREF);
    const keyType = compileExpression(ctx, fctx, keyExpr, EXTERNREF);
    if (keyType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (keyType.kind !== "externref") coerceType(ctx, fctx, keyType, EXTERNREF);
    fctx.body.push({ op: "local.set", index: keyLocal });
  }

  // 3. GetSuperBase.
  const baseLocal = allocLocal(fctx, `__super_wr_base_${fctx.locals.length}`, EXTERNREF);
  if (plan.base === "null") {
    fctx.body.push({ op: "ref.null.extern" });
  } else {
    fctx.body.push({ op: "local.get", index: homeLocal! });
    // (#6651 A13) "base": the closed-literal emitter pushed GetSuperBase()'s answer itself.
    if (homeKind === true) fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__getPrototypeOf")! });
  }
  fctx.body.push({ op: "local.set", index: baseLocal });
  const objectProtoIdx = ctx.funcMap.get(OBJECT_PROTO_SINGLETON);
  if (plan.base === "base" && objectProtoIdx !== undefined) {
    // A base class's `C.prototype` stores no `%Object.prototype%` link (the
    // #5195 `$Object` keeps `$proto` null), so a nullish answer IS the implicit
    // terminal. The singleton is reserve-then-fill: when the module never
    // materialised the `Object` brand it is still null, and the walk then
    // treats the chain as exhausted — which for an untouched `Object.prototype`
    // is the same answer (CreateDataProperty on the receiver).
    emitNullishTest(ctx, fctx, baseLocal);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "call", funcIdx: objectProtoIdx },
        { op: "local.set", index: baseLocal },
      ],
      else: [],
    });
  }

  // 4. The RHS — the assignment expression's value.
  const rhsType = compileExpression(ctx, fctx, value);
  if (rhsType === null) return null;
  const valueLocal = allocLocal(fctx, `__super_wr_val_${fctx.locals.length}`, rhsType);
  fctx.body.push({ op: "local.set", index: valueLocal });

  // 5. PutValue 3.a: ToObject(base). A base class never reaches a nullish
  //    base here (see above), so only the other kinds test.
  if (plan.base === "null") {
    emitThrowTypeError(ctx, fctx, "Cannot set properties of null (super base)");
    fctx.body.push({ op: "local.get", index: valueLocal });
    return rhsType;
  }
  if (plan.base !== "base") {
    emitNullishTest(ctx, fctx, baseLocal);
    emitThrowTypeErrorIf(ctx, fctx, "Cannot set properties of null or undefined (super base)");
  }

  // 6. PutValue 3.c: ToPropertyKey.
  if (keyLocal !== undefined) {
    fctx.body.push({ op: "local.get", index: keyLocal });
    emitToPropertyKeyOnce(ctx, fctx);
    fctx.body.push({ op: "local.set", index: keyLocal });
  }

  // 7. base.[[Set]](key, V, actualThis).
  fctx.body.push({ op: "local.get", index: baseLocal });
  if (keyLocal !== undefined) fctx.body.push({ op: "local.get", index: keyLocal });
  else fctx.body.push(...stringConstantExternrefInstrs(ctx, keyName!));
  fctx.body.push({ op: "local.get", index: valueLocal });
  if (rhsType.kind !== "externref") coerceType(ctx, fctx, rhsType, EXTERNREF);
  fctx.body.push({ op: "local.get", index: recvLocal });
  flushLateImportShifts(ctx, fctx);
  noteReflectSetReceiverCall(ctx);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(REFLECT_SET_RECEIVER)! });
  if (isStrictContext(target, ctx.inferModuleStrictArguments)) {
    // §6.2.5.6 PutValue 3.e: `succeeded` false in strict code ⇒ TypeError.
    fctx.body.push({ op: "i32.eqz" });
    const what = keyName !== undefined ? `'${keyName}' ` : "";
    emitThrowTypeErrorIf(ctx, fctx, `Cannot assign to read only property ${what}of object`);
  } else {
    fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "local.get", index: valueLocal });
  return rhsType;
}
