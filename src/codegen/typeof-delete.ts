// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * typeof, delete, instanceof, and RegExp literal compilation.
 * Extracted from expressions.ts (issue #688 step 5).
 */
import { ts } from "../ts-api.js";
import { chainRootIsGrowable, runtimeAccessorDescriptorKey } from "./property-access.js";
import { emitHostEqualityFromStack } from "./coercion-engine.js";
import { resolveWidenedVarKey } from "./widened-var-key.js";
import { isBooleanType, isStringType, isSymbolType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { reportError } from "./context/errors.js";
import { elementReadOfRebindWidenedArray } from "./declarations/array-rebind-element-widening.js";
import { moduleGlobalIsDynamicButStaticallyPrimitive } from "./declarations/heterogeneous-scalar-var-widening.js";
import { typeofFoldContradictedByFieldVerdict } from "./fnctor-ctor-param-types.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import { popBody, pushBody } from "./context/bodies.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { isStrictContext } from "./expressions/assignment.js";
import { EVAL_SOURCE_FILENAME } from "./expressions/eval-source.js";
import {
  emitUndefined,
  ensureLateImport,
  flushLateImportShifts,
  shiftLateImportIndices,
} from "./expressions/late-imports.js";
import { resolveStructName } from "./expressions/misc.js";
import { addUnionImports, parseRegExpLiteral, resolveWasmType } from "./index.js";
import { emitExternrefDestructureGuard } from "./destructuring-params.js";
import { buildThrowJsErrorInstrs, type JsErrorKind } from "./js-errors.js";
import { compileStandaloneRegExpLiteral } from "./regexp-standalone.js";
import { addImport, localGlobalIdx } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec } from "./registry/types.js";
import {
  emitArgumentsTypeofComparison,
  emitPropertyDeleteWithUnmappedArgumentsWriteback,
  prepareDynamicArgumentsDeleteIndex, // (#4491) runtime `delete arguments[i]`
  staticTypeofForArgumentsIdentifier,
} from "./arguments-object-mop.js"; // (#4555)
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression, ensureAnyHelpers, isAnyValue, skipTransparentExpressions } from "./shared.js";
import { compileStringLiteral } from "./string-ops.js";
import { emitDynamicWithDelete, findWithBinding, resolveWithBinding } from "./with-scope.js";
import {
  emitGlobalEnvironmentDelete,
  emitRuntimeEvalBindingDelete,
  emitRuntimeEvalBindingRead,
  tryEmitNonConfigurableGlobalObjectDelete,
} from "./global-environment.js";
import { runtimeEvalStateMayShadowBinding } from "./direct-eval-environment.js";

// (#2726 group (b), partial) The only value properties of the global object with
// `[[Configurable]]: false` (ECMA-262 §19.1). `delete <bareIdentifier>` of any of
// these must evaluate to `false`; every OTHER built-in global property
// (`JSON`/`Object`/`Math`/`parseInt`/…) is configurable ⇒ `delete` returns `true`.
const NON_CONFIGURABLE_GLOBALS = new Set(["NaN", "Infinity", "undefined"]);

/**
 * (#2703, #3422) Terminal `throw` for `delete`'s spec error cases (§13.5.1.2):
 * super reference → ReferenceError; null/undefined base or strict-mode
 * non-configurable refusal → TypeError. Emits a REAL error instance via
 * `buildThrowJsErrorInstrs` (host `__new_<Kind>` / standalone in-module ctor),
 * NOT a bare string: the authentic harness (#3370)
 * `propertyHelper.js::isConfigurable()` rethrows unless `e instanceof TypeError`,
 * so the pre-#3422 bare-string throw broke ~313 strict reruns (the `delete`
 * counterpart of #3471). `message` carries no "Kind:" prefix (the ctor adds it);
 * `opts.flush` = fctx applies the late `__new_<Kind>` funcIdx shift to the
 * already-emitted body (#1839). The throw is terminal / stack-polymorphic.
 */
function deleteThrowInstrs(ctx: CodegenContext, fctx: FunctionContext, kind: JsErrorKind, message: string): Instr[] {
  return buildThrowJsErrorInstrs(ctx, kind, message, { flush: fctx });
}

function emitDeleteThrow(ctx: CodegenContext, fctx: FunctionContext, kind: JsErrorKind, message: string): void {
  fctx.body.push(...deleteThrowInstrs(ctx, fctx, kind, message));
}

/**
 * (#2726 group (d)) Emit the OrdinaryDelete refusal for `delete obj.<prop>` of a
 * statically-known NON-configurable accessor (defined via the inline-accessor
 * `Object.defineProperty` fast path, whose `configurable:false` flag never
 * reaches the runtime `__delete_property`). Per §13.5.1.2 + OrdinaryDelete: the
 * receiver is evaluated for side effects, the property is left untouched, and the
 * result is `false` — which in strict mode (§13.5.1.2 step 6.b) is a TypeError.
 * Returns `true` if the refusal was emitted (the caller should `return` the i32),
 * `false` if the key is not a tracked non-configurable accessor (caller proceeds
 * with the normal runtime-driven delete).
 */
function maybeEmitNonConfigurableAccessorDelete(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.DeleteExpression,
  receiver: ts.Expression,
  fieldName: string,
): boolean {
  if (!ts.isIdentifier(receiver)) return false;
  if (!ctx.nonConfigurableAccessorKeys.has(`${receiver.text}:${fieldName}`)) return false;
  // Evaluate the receiver for its side effects, then drop it.
  const recvType = compileExpression(ctx, fctx, receiver);
  if (recvType) fctx.body.push({ op: "drop" });
  // Strict mode: a refused non-configurable delete is a TypeError.
  if (isStrictContext(expr)) {
    emitDeleteThrow(ctx, fctx, "TypeError", "Cannot delete non-configurable property in strict mode");
  }
  // Sloppy mode: the delete expression evaluates to `false`.
  fctx.body.push({ op: "i32.const", value: 0 });
  return true;
}

/**
 * (#2703) Strict-mode wrapper around a `__delete_property` result (an i32 on
 * the stack). In strict mode a `false` result — a non-configurable own
 * property whose delete was refused — is a TypeError (§13.5.1.2 step 6.b); in
 * sloppy mode the boolean result is preserved unchanged. The (truthy) result
 * is left on the stack when no throw occurs. A no-op outside strict context.
 */
function emitStrictDeleteCheck(ctx: CodegenContext, fctx: FunctionContext, expr: ts.DeleteExpression): void {
  if (!isStrictContext(expr)) return;
  const resLocal = allocLocal(fctx, `__del_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: resLocal });
  fctx.body.push({ op: "local.get", index: resLocal });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: deleteThrowInstrs(ctx, fctx, "TypeError", "Cannot delete non-configurable property in strict mode"),
    else: [],
  });
  fctx.body.push({ op: "local.get", index: resLocal });
}

/**
 * (#2676) Resolve an identifier that aliases a mapped-`arguments` object back to
 * the owning function's live `mappedArgsInfo`. Matches the statically-tractable
 * shape `var <alias> = arguments` (the alias' value declaration is a
 * VariableDeclaration whose initializer is the bare `arguments` identifier). The
 * `arguments` it reads belongs to the nearest enclosing *non-arrow* function;
 * that function's `mappedArgsInfo` is looked up from `ctx.mappedArgsInfoByFunc`
 * (present only for sloppy, simple-parameter functions — exactly the mapped
 * case). Returns `undefined` for anything else (no alias, a strict/unmapped
 * owner, or a transitive alias). Lets an aliased `delete args[i]` in a nested
 * strict closure consult the outer function's per-index non-configurability.
 */
function resolveAliasedMappedArgs(
  ctx: CodegenContext,
  sym: ts.Symbol | undefined,
): NonNullable<FunctionContext["mappedArgsInfo"]> | undefined {
  const decls = sym?.declarations;
  if (!decls) return undefined;
  for (const d of decls) {
    if (!ts.isVariableDeclaration(d)) continue;
    const init = d.initializer;
    if (!init || !ts.isIdentifier(init) || init.text !== "arguments") continue;
    // The aliased `arguments` read resolves to the nearest enclosing non-arrow
    // function (arrows do not bind their own `arguments`, so walk past them).
    let owner: ts.Node | undefined = d.parent;
    while (
      owner &&
      !ts.isFunctionDeclaration(owner) &&
      !ts.isFunctionExpression(owner) &&
      !ts.isMethodDeclaration(owner) &&
      !ts.isConstructorDeclaration(owner) &&
      !ts.isGetAccessorDeclaration(owner) &&
      !ts.isSetAccessorDeclaration(owner)
    ) {
      owner = owner.parent;
    }
    if (!owner) continue;
    const info = ctx.mappedArgsInfoByFunc.get(owner);
    if (info) return info;
  }
  return undefined;
}

// ── Delete expression ─────────────────────────────────────────────────

/**
 * Emit the sentinel (undefined) value for a given Wasm field type.
 * - ref/ref_null: ref.null of the struct's type index
 * - externref: ref.null.extern
 * - f64: NaN (chosen as sentinel since deleted numeric props return undefined -> NaN in numeric context)
 * - i32: 0
 */
function deleteSentinelInstr(fieldType: ValType): Instr {
  switch (fieldType.kind) {
    case "ref":
    case "ref_null":
      return { op: "ref.null", typeIdx: (fieldType as { typeIdx: number }).typeIdx };
    case "f64":
      return { op: "f64.const", value: NaN };
    case "i32":
      return { op: "i32.const", value: 0 };
    // externref and any other shape fall through to the null-extern sentinel.
    default:
      return { op: "ref.null.extern" };
  }
}

/**
 * (#3621) Guard the field-clearing `struct.set` with a runtime `ref.test` when
 * the receiver's STATIC type does not prove it is that struct.
 *
 * The delete lowering resolves `structTypeIdx` from
 * `resolveStructName` over the checker's type at the receiver — the receiver's
 * *declared* shape. For `delete this.x` inside an object-literal accessor that
 * is later invoked REFLECTIVELY (`__call_accessor_get` ← `__extern_get`, e.g.
 * through a `with` scope), `this` is bound to whatever the accessor was called
 * on, which is frequently a different representation than the literal's
 * shape-inferred struct. `clearField` then pushes an externref where
 * `struct.set` wants `(ref null $Shape)`, the coercion emits
 * `any.convert_extern ; ref.cast null (ref null $Shape)`, and the cast traps
 * `illegal cast` — uncatchably, aborting the module.
 *
 * Same invariant as #3610 / #3620: **a `ref.cast` is a claim that the value's
 * runtime representation is known, and a static type is not that evidence.**
 * Unlike #3610 this one is NOT compile-time decidable (whether `this` is the
 * struct depends on the call), so the remedy is the runtime arm: `ref.test`,
 * and skip the field poke on a miss. Nothing is lost on the miss path — the
 * `__delete_property` sidecar call has already performed the semantically
 * meaningful part of the delete; `clearField` only resets a shape-struct field
 * that this receiver does not have.
 */
function guardClearField(
  fctx: FunctionContext,
  recvLocal: number,
  recvType: ValType,
  structTypeIdx: number,
  clearField: Instr[],
): Instr[] {
  // Statically the exact struct (or its nullable form) ⇒ the cast cannot fail;
  // emit byte-identical code to pre-#3621.
  if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx === structTypeIdx) {
    return clearField;
  }
  const probe: Instr[] = [{ op: "local.get", index: recvLocal }];
  if (recvType.kind === "externref") probe.push({ op: "any.convert_extern" });
  probe.push({ op: "ref.test", typeIdx: structTypeIdx });
  return [...probe, { op: "if", blockType: { kind: "empty" }, then: clearField, else: [] }];
}

/**
 * (#2703) Emit the tail of a struct-field `delete` once `__delete_property`'s
 * i32 result is stored in `resLocal`: clear the struct field to its undefined
 * sentinel **only when the delete succeeded** (so a refused non-configurable
 * delete leaves the field — and its value — intact, §13.5.1.2 / OrdinaryDelete),
 * raise a TypeError in strict mode on a refused delete, and leave the boolean
 * result on the stack. `clearField` are the instrs that perform the struct.set.
 */
function emitStructDeleteOutcome(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.DeleteExpression,
  resLocal: number,
  clearField: Instr[],
): void {
  fctx.body.push({ op: "local.get", index: resLocal });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: clearField, else: [] });
  if (isStrictContext(expr)) {
    fctx.body.push({ op: "local.get", index: resLocal });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: deleteThrowInstrs(ctx, fctx, "TypeError", "Cannot delete non-configurable property in strict mode"),
      else: [],
    });
  }
  fctx.body.push({ op: "local.get", index: resLocal });
}

function emitStaticIdentifierDelete(ctx: CodegenContext, fctx: FunctionContext, ident: ts.Identifier): void {
  const identSym = ctx.checker.getSymbolAtLocation(ident);
  const notEvalBody = ident.getSourceFile().fileName !== EVAL_SOURCE_FILENAME;
  if (identSym === undefined && notEvalBody) {
    emitGlobalEnvironmentDelete(ctx, fctx, ident.text);
    return;
  }
  // §13.5.1.2 step 5: configurable ambient globals are deletable. User
  // declarations and the three intrinsic non-configurable globals are not.
  if (identSym !== undefined && notEvalBody && !NON_CONFIGURABLE_GLOBALS.has(ident.text)) {
    const decls = identSym.declarations ?? [];
    if (decls.length > 0 && decls.every((d) => d.getSourceFile().isDeclarationFile)) {
      fctx.body.push({ op: "i32.const", value: 1 });
      return;
    }
  }
  fctx.body.push({ op: "i32.const", value: 0 });
}

/**
 * Compile `delete expr`.
 * - `delete obj.prop` / `delete obj[key]`: set the field to a sentinel (undefined) value, return true
 * - `delete identifier`: return false (i32 0) — variables are not deletable
 * - `delete otherExpr`: compile for side effects, drop, return true (i32 1)
 *
 * WasmGC struct fields cannot be removed at runtime, so we simulate deletion
 * by setting the field to a sentinel value (ref.null for ref types, NaN for f64).
 * Property reads of ref.null / NaN naturally produce undefined-like behavior.
 */
export function compileDeleteExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.DeleteExpression,
): InnerResult {
  const operand = expr.expression;

  // Unwrap parenthesized/type-assertion wrappers to find the underlying expression
  let inner: ts.Expression = operand;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isTypeAssertionExpression(inner)
  ) {
    inner = ts.isParenthesizedExpression(inner)
      ? inner.expression
      : ts.isAsExpression(inner)
        ? inner.expression
        : ts.isNonNullExpression(inner)
          ? inner.expression
          : (inner as ts.TypeAssertion).expression;
  }

  // (#2703) `delete super.x` / `delete super[k]` is ALWAYS a ReferenceError
  // (§13.5.1.2 step 5.b: IsSuperReference(ref) ⇒ throw ReferenceError). It is
  // detectable syntactically, so emit an unconditional throw. The restriction
  // on the super base is enforced here, when the delete is evaluated — not
  // before — so a null / uninitialized super base still reaches this throw
  // (super-property-null-base.js, super-property-uninitialized-this.js).
  if (
    (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) &&
    inner.expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    emitDeleteThrow(ctx, fctx, "ReferenceError", "'super' property cannot be deleted");
    return { kind: "i32" };
  }
  if (ts.isIdentifier(inner)) {
    // (#2663 Slice 3) `delete name` inside a dynamic `with`: if the with-object
    // has the binding ⇒ delete the object property (configurability-aware
    // result); else ⇒ cascade to the next-outer with, then to the bare-variable
    // case (variables are not deletable ⇒ false). §13.5.1.2 / §8.5.2.
    const ident = inner;
    const emitOuterDelete = (): void => {
      const res = resolveWithBinding(fctx, ident.text);
      if (res?.kind === "dynamic") {
        const scopes = fctx.withScopes!;
        const matchedIdx = scopes.lastIndexOf(res.scope);
        emitDynamicWithDelete(ctx, fctx, res.scope, ident.text, () => {
          const saved = fctx.withScopes;
          fctx.withScopes = scopes.slice(0, matchedIdx);
          try {
            emitOuterDelete();
          } finally {
            fctx.withScopes = saved;
          }
        });
        return;
      }
      // A static with-bound name or a plain variable: not deletable ⇒ false.
      fctx.body.push({ op: "i32.const", value: 0 });
    };
    if (resolveWithBinding(fctx, ident.text)?.kind === "dynamic") {
      emitOuterDelete();
      // (#4231 RC-B) §13.5.1.2 evaluates to a BOOLEAN. Returning a bare
      // `{kind:"i32"}` made an externref consumer box the result as a NUMBER, so
      // `del = delete p3` inside a `with` yielded `1` and `del === true` failed.
      return { kind: "i32", boolean: true };
    }
    // (#2726 group (a)) §13.5.1.2 step 4: `delete IdentifierReference` whose
    // reference is UNRESOLVABLE (the name resolves to NO binding anywhere — not
    // a local var/let/const/param/function, nor a real global property)
    // evaluates to `true` in sloppy mode. Strict mode would already be an early
    // SyntaxError (`Delete of an unqualified identifier in strict mode`, see
    // early-errors/node-checks.ts), so this codegen path is reached only in
    // sloppy code — exactly where step 4 applies.
    //
    // Oracle: the TS checker returns NO symbol (`getSymbolAtLocation === undefined`)
    // for a truly unresolvable identifier. The non-configurable intrinsic globals
    // that MUST stay `false` (`undefined`, `arguments`, `globalThis`) and every
    // lib-declared global (`NaN`, `Infinity`, `JSON`, `Object`, …) instead return
    // a symbol (with or without a `valueDeclaration`), so they correctly fall
    // through to the resolvable-binding case below. Using symbol-presence — not
    // the weaker `!valueDeclaration` heuristic — is what keeps those three
    // intrinsics out of the `true` bucket (they have a symbol but no value decl).
    //
    // EXCEPTION — a node inside an inlined `eval("<literal>")` body lives in a
    // foreign `SourceFile` (EVAL_SOURCE_FILENAME) the checker never bound, so
    // `getSymbolAtLocation` is `undefined` for EVERY identifier there — including
    // a name that resolves to an outer binding (`var x = 1; eval('delete x')` ⇒
    // x is a non-deletable var ⇒ `false`). The symbol oracle is meaningless for
    // such nodes, so fall through to the existing `false` (the prior behaviour,
    // correct for the resolvable-outer-binding case `11.4.1-4.a-7.js`). Precise
    // eval-scope delete resolution is out of scope (eval-substrate lane).
    if (runtimeEvalStateMayShadowBinding(ctx, fctx, ident.text)) {
      const savedFallback = pushBody(fctx);
      emitStaticIdentifierDelete(ctx, fctx, ident);
      const fallbackBody = fctx.body;
      popBody(fctx, savedFallback);
      if (emitRuntimeEvalBindingDelete(ctx, fctx, ident.text, fallbackBody)) {
        return { kind: "i32" };
      }
    }
    emitStaticIdentifierDelete(ctx, fctx, ident);
    return { kind: "i32" };
  }
  const globalObjectDelete = tryEmitNonConfigurableGlobalObjectDelete(ctx, fctx, expr);
  if (globalObjectDelete) return globalObjectDelete;
  // (#1511) `delete arguments[i]` on a mapped index severs the param↔arguments
  // mapping for that slot (ECMA-262 §10.4.4.5 step 5.b): after a successful
  // delete the property no longer mirrors the named parameter. Record the
  // statically-resolvable case (literal index on the `arguments` identifier in
  // a mapped-args function) so the mapped-sync emitters skip it from here on.
  // This only updates compile-time bookkeeping; the actual element delete is
  // emitted by the element-access paths below.
  if (
    fctx.mappedArgsInfo &&
    ts.isElementAccessExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === "arguments"
  ) {
    const idxArg = inner.argumentExpression;
    const idxText = ts.isNumericLiteral(idxArg) ? idxArg.text : ts.isStringLiteral(idxArg) ? idxArg.text : undefined;
    const argIndex = idxText !== undefined ? Number(idxText) : NaN;
    if (Number.isInteger(argIndex) && argIndex >= 0 && argIndex < fctx.mappedArgsInfo.paramCount) {
      // (#2667) §10.4.4.5 + OrdinaryDelete: deleting a non-configurable mapped
      // index FAILS — `delete arguments[i]` returns `false`, the property and
      // its param mapping stay intact. Only a *successful* delete severs the
      // map. Detect the statically-known non-configurable case (set earlier in
      // this body by `Object.defineProperty(arguments,"<i>",{configurable:false})`)
      // and emit the spec-correct `false` without touching `unmappedIndices`.
      if (fctx.mappedArgsInfo.nonConfigurableIndices?.has(argIndex)) {
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
      // (#2726 group (e)) A *successful* `delete arguments[i]` on a mapped,
      // configurable index (§10.4.4.5 → OrdinaryDelete) does two things:
      //   1. severs the param↔arguments map so later parameter writes no longer
      //      mirror into `arguments[i]` (`unmappedIndices`), and
      //   2. actually removes the slot — a subsequent `arguments[i]` read
      //      observes `undefined`.
      // The generic `__delete_property` path below reports `true` but never
      // clears the WasmGC-vec-backed slot (indices carry no sidecar
      // descriptor), so the read still returns the original argument. Clear the
      // backing slot here (write the canonical `undefined` externref, mirroring
      // `emitMappedArgParamSync`'s slot write) and report `true`,
      // short-circuiting the generic path.
      const info = fctx.mappedArgsInfo;
      (info.unmappedIndices ??= new Set<number>()).add(argIndex);
      // val = undefined (canonical externref), stashed for the null-guarded slot
      // write below.
      emitUndefined(ctx, fctx);
      const undefLocal = allocLocal(fctx, `__del_arg_undef_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: undefLocal });
      // arguments vec slot write: vec.data[argIndex] = undefined (null-guarded;
      // the slot exists since argIndex < paramCount, so no grow is needed).
      fctx.body.push({ op: "local.get", index: info.argsLocalIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [],
        else: [
          { op: "local.get", index: info.argsLocalIdx },
          { op: "struct.get", typeIdx: info.vecTypeIdx, fieldIdx: 1 },
          { op: "i32.const", value: argIndex },
          { op: "local.get", index: undefLocal },
          { op: "array.set", typeIdx: info.arrTypeIdx },
        ],
      });
      // OrdinaryDelete succeeded → `delete` evaluates to `true`.
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    }
  }

  // (#2676) Aliased mapped-`arguments` strict delete. `var args = arguments;
  // ... delete args[i]` — the delete frequently lives in a nested *strict*
  // closure (e.g. the `assert.throws(TypeError, function(){ "use strict";
  // delete args[0]; })` callback) that captures `args` and has no
  // `mappedArgsInfo` of its own, so the #2667 direct-`arguments[i]` arm above
  // never fires. Resolve the alias through the AST back to the owning
  // function's live `nonConfigurableIndices`. A non-configurable index makes
  // the delete FAIL (OrdinaryDelete ⇒ false): emit `false` and route it through
  // the strict check so a strict caller throws TypeError (§13.5.1.2 step 6.b)
  // while a sloppy caller observes `false` — exactly mirroring the #2667 direct
  // case (which the outer sloppy function takes via the arm above).
  if (ts.isElementAccessExpression(inner) && ts.isIdentifier(inner.expression)) {
    const aliasInfo = resolveAliasedMappedArgs(ctx, ctx.checker.getSymbolAtLocation(inner.expression));
    if (aliasInfo?.nonConfigurableIndices && aliasInfo.nonConfigurableIndices.size > 0) {
      const idxArg = inner.argumentExpression;
      const idxText = ts.isNumericLiteral(idxArg) ? idxArg.text : ts.isStringLiteral(idxArg) ? idxArg.text : undefined;
      const argIndex = idxText !== undefined ? Number(idxText) : NaN;
      if (
        Number.isInteger(argIndex) &&
        argIndex >= 0 &&
        argIndex < aliasInfo.paramCount &&
        aliasInfo.nonConfigurableIndices.has(argIndex)
      ) {
        fctx.body.push({ op: "i32.const", value: 0 });
        emitStrictDeleteCheck(ctx, fctx, expr);
        return { kind: "i32" };
      }
    }
  }

  // Try to resolve struct type and field for property access: delete obj.prop
  if (ts.isPropertyAccessExpression(inner)) {
    const objType = ctx.checker.getTypeAtLocation(inner.expression);
    let typeName = resolveStructName(ctx, objType);
    if (!typeName && ts.isIdentifier(inner.expression)) {
      // (#3364) keyed per-declaration, not by bare name.
      const key = resolveWidenedVarKey(ctx, inner.expression);
      if (key !== undefined) typeName = ctx.widenedVarStructMap.get(key);
    }
    if (typeName) {
      const structTypeIdx = ctx.structMap.get(typeName);
      const fields = ctx.structFields.get(typeName);
      const fieldName = ts.isPrivateIdentifier(inner.name) ? "__priv_" + inner.name.text.slice(1) : inner.name.text;
      if (structTypeIdx !== undefined && fields) {
        const fieldIdx = fields.findIndex((f) => f.name === fieldName);
        if (fieldIdx !== -1 && fields[fieldIdx]!.mutable) {
          const fieldType = fields[fieldIdx]!.type;
          // (#2726 group (d)) Non-configurable accessor → refuse the delete.
          if (maybeEmitNonConfigurableAccessorDelete(ctx, fctx, expr, inner.expression, fieldName)) {
            return { kind: "i32" };
          }
          // (#1334 / #2703) Compile the receiver once, save to a local, then
          //   (a) clear any sidecar descriptor entry via `__delete_property`
          //       (which reports configurability), and
          //   (b) reset the struct field to its undefined sentinel — but ONLY
          //       when the delete actually succeeds, so a refused
          //       non-configurable delete leaves the field's value intact
          //       (§13.5.1.2 / OrdinaryDelete). Without (a), `Object.define-
          //       Property(obj, "x", { configurable: true })` would leave
          //       `obj.hasOwnProperty("x")` true after `delete obj.x`.
          const recvType = compileExpression(ctx, fctx, inner.expression);
          if (!recvType) {
            fctx.body.push({ op: "i32.const", value: 1 });
            return { kind: "i32" };
          }
          // Save the receiver so we can re-push it for the sidecar call.
          const recvLocal = allocLocal(fctx, `__del_recv_${fctx.locals.length}`, recvType);
          fctx.body.push({ op: "local.set", index: recvLocal });

          // Instrs that reset the field to undefined (run only on success).
          // (#3621) `ref.test`-guarded when the static type does not prove the
          // receiver IS this struct — see `guardClearField`.
          const clearField: Instr[] = guardClearField(fctx, recvLocal, recvType, structTypeIdx, [
            { op: "local.get", index: recvLocal },
            deleteSentinelInstr(fieldType),
            { op: "struct.set", typeIdx: structTypeIdx, fieldIdx },
          ]);

          if (recvType.kind !== "ref" && recvType.kind !== "ref_null" && recvType.kind !== "externref") {
            // Non-struct numeric/bool receiver (defensive) — no sidecar applies;
            // just clear the field and report success.
            for (const instr of clearField) fctx.body.push(instr);
            fctx.body.push({ op: "i32.const", value: 1 });
            return { kind: "i32" };
          }

          // (a) Push receiver as externref + key, then call __delete_property.
          fctx.body.push({ op: "local.get", index: recvLocal });
          if (recvType.kind === "ref" || recvType.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          }
          const keyResult = compileStringLiteral(ctx, fctx, fieldName, inner.name);
          if (!keyResult) {
            // String literal failed (shouldn't happen for a static field name);
            // drop the receiver, clear the field, report `true`.
            fctx.body.push({ op: "drop" });
            for (const instr of clearField) fctx.body.push(instr);
            fctx.body.push({ op: "i32.const", value: 1 });
            return { kind: "i32" };
          }
          const delIdx = ensureLateImport(
            ctx,
            "__delete_property",
            [{ kind: "externref" }, { kind: "externref" }],
            [{ kind: "i32" }],
          );
          flushLateImportShifts(ctx, fctx);
          if (delIdx === undefined) {
            // No host import (standalone): drop receiver + key; clear the field
            // unconditionally (no configurability info) and report `true`.
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "drop" });
            for (const instr of clearField) fctx.body.push(instr);
            fctx.body.push({ op: "i32.const", value: 1 });
            return { kind: "i32" };
          }
          fctx.body.push({ op: "call", funcIdx: delIdx });
          // (b) Clear the field on success; strict-mode refusal ⇒ TypeError;
          // leave __delete_property's boolean result as the expression value.
          {
            const resLocal = allocLocal(fctx, `__del_res_${fctx.locals.length}`, { kind: "i32" });
            fctx.body.push({ op: "local.set", index: resLocal });
            emitStructDeleteOutcome(ctx, fctx, expr, resLocal, clearField);
          }
          return { kind: "i32" };
        }
      }
    }
  }

  // Try to resolve struct type and field for element access: delete obj["prop"]
  if (ts.isElementAccessExpression(inner) && ts.isStringLiteral(inner.argumentExpression)) {
    const objType = ctx.checker.getTypeAtLocation(inner.expression);
    let typeName = resolveStructName(ctx, objType);
    if (!typeName && ts.isIdentifier(inner.expression)) {
      // (#3364) keyed per-declaration, not by bare name.
      const key = resolveWidenedVarKey(ctx, inner.expression);
      if (key !== undefined) typeName = ctx.widenedVarStructMap.get(key);
    }
    if (typeName) {
      const structTypeIdx = ctx.structMap.get(typeName);
      const fields = ctx.structFields.get(typeName);
      const fieldName = inner.argumentExpression.text;
      if (structTypeIdx !== undefined && fields) {
        const fieldIdx = fields.findIndex((f) => f.name === fieldName);
        if (fieldIdx !== -1 && fields[fieldIdx]!.mutable) {
          const fieldType = fields[fieldIdx]!.type;
          // (#2726 group (d)) Non-configurable accessor → refuse the delete.
          if (maybeEmitNonConfigurableAccessorDelete(ctx, fctx, expr, inner.expression, fieldName)) {
            return { kind: "i32" };
          }
          // (#1821 / #2703) Mirror the property-access arm: clear the sidecar/
          // descriptor entry via __delete_property, reset the struct field to
          // its sentinel ONLY on a successful delete, and throw in strict mode
          // on a refused non-configurable delete. Returns the boolean result.
          const recvType = compileExpression(ctx, fctx, inner.expression);
          if (!recvType) {
            fctx.body.push({ op: "i32.const", value: 1 });
            return { kind: "i32" };
          }
          const recvLocal = allocLocal(fctx, `__del_recv_${fctx.locals.length}`, recvType);
          fctx.body.push({ op: "local.set", index: recvLocal });

          // (#3621) `ref.test`-guarded — see `guardClearField`.
          const clearField: Instr[] = guardClearField(fctx, recvLocal, recvType, structTypeIdx, [
            { op: "local.get", index: recvLocal },
            deleteSentinelInstr(fieldType),
            { op: "struct.set", typeIdx: structTypeIdx, fieldIdx },
          ]);

          if (recvType.kind !== "ref" && recvType.kind !== "ref_null" && recvType.kind !== "externref") {
            for (const instr of clearField) fctx.body.push(instr);
            fctx.body.push({ op: "i32.const", value: 1 });
            return { kind: "i32" };
          }

          fctx.body.push({ op: "local.get", index: recvLocal });
          if (recvType.kind === "ref" || recvType.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          }
          const keyResult = compileStringLiteral(ctx, fctx, fieldName, inner.argumentExpression);
          if (!keyResult) {
            fctx.body.push({ op: "drop" });
            for (const instr of clearField) fctx.body.push(instr);
            fctx.body.push({ op: "i32.const", value: 1 });
            return { kind: "i32" };
          }
          const delIdx = ensureLateImport(
            ctx,
            "__delete_property",
            [{ kind: "externref" }, { kind: "externref" }],
            [{ kind: "i32" }],
          );
          flushLateImportShifts(ctx, fctx);
          if (delIdx === undefined) {
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "drop" });
            for (const instr of clearField) fctx.body.push(instr);
            fctx.body.push({ op: "i32.const", value: 1 });
            return { kind: "i32" };
          }
          fctx.body.push({ op: "call", funcIdx: delIdx });
          {
            const resLocal = allocLocal(fctx, `__del_res_${fctx.locals.length}`, { kind: "i32" });
            fctx.body.push({ op: "local.set", index: resLocal });
            emitStructDeleteOutcome(ctx, fctx, expr, resLocal, clearField);
          }
          return { kind: "i32" };
        }
      }
    }
  }

  // (#1334) `delete obj.prop` / `delete obj[key]` for non-struct-field
  // receivers — route through `__delete_property` so sidecar-stored
  // properties (added via `Object.defineProperty`) actually get removed
  // and so non-configurable properties report the spec-mandated `false`
  // result. Without this, the legacy `compile + drop + push 1` path
  // returns true unconditionally and leaves the sidecar entry in place,
  // making `obj.hasOwnProperty(prop)` after delete still report `true`
  // (~40+ test262 fails in `built-ins/Object/defineProperty/`).
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
    // Compile the receiver as externref so the runtime helper sees the
    // wrapped struct (sidecar maps are keyed on the externref identity).
    const recvType = compileExpression(ctx, fctx, inner.expression, { kind: "externref" });
    if (recvType === null) {
      // Receiver had no value — fall through to the legacy stub.
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    }
    if (recvType.kind === "ref" || recvType.kind === "ref_null") {
      fctx.body.push({ op: "extern.convert_any" });
    } else if (recvType.kind !== "externref") {
      // Other shapes (f64/i32) — drop and return true; primitives are
      // object-coercible (RequireObjectCoercible passes) and a wrapper has no
      // own property to delete, so the delete vacuously succeeds.
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    }

    // (#2703) Stash the receiver so we can run RequireObjectCoercible
    // (§13.5.1.2 step 5.b) before the property delete and re-push it for the
    // helper call. The base and key are both evaluated first (per the
    // Reference-evaluation order), then the coercibility check throws.
    const recvLocal = allocLocal(fctx, `__del_recv_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: recvLocal });

    // Compile the key as externref. Property access uses the static name;
    // element access uses the bracket expression (any externref).
    if (ts.isPropertyAccessExpression(inner)) {
      const keyName = ts.isPrivateIdentifier(inner.name) ? `__priv_${inner.name.text.slice(1)}` : inner.name.text;
      const keyResult = compileStringLiteral(ctx, fctx, keyName, inner.name);
      if (!keyResult) {
        // Receiver already stashed off-stack — stack is clean.
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
    } else {
      // ElementAccess — compile argumentExpression as externref so the
      // runtime helper can stringify or treat as Symbol.
      const keyType = compileExpression(ctx, fctx, inner.argumentExpression, { kind: "externref" });
      if (keyType === null) {
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
      if (keyType.kind !== "externref") {
        // Primitive key (f64 / i32) — coerce via the runtime path below.
        // Box numbers / booleans through __box_number / __box_boolean would
        // pull in extra imports for a rarely-used shape; since static
        // delete on a numeric key is unusual, fall back to dropping +
        // returning true. Tests that rely on numeric keys via element
        // access will still hit the struct-field arm above when applicable.
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
    }
    const keyLocal = allocLocal(fctx, `__del_key_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: keyLocal });

    // (#4491) Runtime `delete arguments[i]` — derived BEFORE `delIdx` below.
    const dynamicArgsIndex = prepareDynamicArgumentsDeleteIndex(ctx, fctx, inner, keyLocal);

    // (#2703) RequireObjectCoercible(base) — `delete null.x` / `delete
    // undefined[k]` (and any unresolvable base such as `Object[0][0]`) throw a
    // TypeError (§13.5.1.2 step 5.b → ToObject). The guard only fires when the
    // receiver is actually null/undefined, so a normal delete is unaffected.
    // EXCEPTION: a `this` base is excluded — top-level `this` is the global
    // object (object-coercible), but the compiler currently represents it as a
    // null/undefined externref, which would make the guard fire spuriously on
    // `delete this.x` (a legal sloppy-mode delete that returns `true`). Unwrap
    // parens / casts on the receiver so `delete (this).x` / `delete (this as
    // any).x` are excluded too.
    let recvCore: ts.Expression = inner.expression;
    while (
      ts.isParenthesizedExpression(recvCore) ||
      ts.isAsExpression(recvCore) ||
      ts.isNonNullExpression(recvCore) ||
      ts.isTypeAssertionExpression(recvCore)
    ) {
      recvCore = recvCore.expression;
    }
    if (recvCore.kind !== ts.SyntaxKind.ThisKeyword) {
      emitExternrefDestructureGuard(ctx, fctx, recvLocal);
    }

    const delIdx = ensureLateImport(
      ctx,
      "__delete_property",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (delIdx === undefined) {
      // Registration failed for some reason — preserve the legacy stub.
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    }
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    emitPropertyDeleteWithUnmappedArgumentsWriteback(ctx, fctx, inner, delIdx, dynamicArgsIndex);
    // (#2703) Strict mode: a failed delete (result 0 — a non-configurable own
    // property) is a TypeError instead of a `false` result (§13.5.1.2 step 6.b).
    emitStrictDeleteCheck(ctx, fctx, expr);
    return { kind: "i32" };
  }

  // For other expressions (CallExpression, BinaryExpression, etc.):
  // compile the operand for side effects, drop, return true.
  const operandType = compileExpression(ctx, fctx, operand);
  if (operandType !== null) {
    fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "i32.const", value: 1 });
  return { kind: "i32" };
}

// ── RegExp literal ────────────────────────────────────────────────────

/**
 * Compile a RegExp literal (e.g. /\d+/g) by desugaring it to new RegExp(pattern, flags).
 * The pattern and flags strings are loaded from the string pool, then RegExp_new is called.
 */
export function compileRegExpLiteral(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): ValType | null {
  const { pattern, flags } = parseRegExpLiteral(expr.getText());

  // #682 — standalone mode has a reduced native literal-substring backend.
  // Unsupported syntax still reports #1474-compatible diagnostics rather than
  // falling back to a JS-host RegExp import.
  if (ctx.targetProfile.semanticProviders === "native-first") {
    return compileStandaloneRegExpLiteral(ctx, fctx, pattern, flags, expr);
  }

  // Load pattern string
  const patternResult = compileStringLiteral(ctx, fctx, pattern, expr);
  if (!patternResult) return null;

  // Load flags string (empty string "" if no flags — ref.null.extern would
  // become null in JS, causing "Invalid flags 'null'" at runtime)
  const flagsStr = flags ?? "";
  const flagsResult = compileStringLiteral(ctx, fctx, flagsStr, expr);
  if (!flagsResult) return null;

  // (#3301) Ensure a minimal `externClasses` "RegExp" entry BEFORE the import:
  // the manifest resolver routes `RegExp_new` to the real RegExp constructor
  // only when "RegExp" is in `ctx.externClasses`, else it falls to the "builtin"
  // intent — a no-op returning `undefined`. The pre-codegen scan sets this for a
  // real-AST regex literal, but an eval-spliced regex (`eval("/abc/i")`, #1163)
  // is a FOREIGN node it never walks. Mirrors the calls.ts eval-concat peephole.
  if (!ctx.externClasses.has("RegExp")) {
    ctx.externClasses.set("RegExp", {
      importPrefix: "RegExp",
      namespacePath: [],
      className: "RegExp",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }],
      methods: new Map(),
      properties: new Map(),
    });
  }

  // Call RegExp_new(pattern, flags) -> externref
  let funcIdx = ctx.funcMap.get("RegExp_new");
  if (funcIdx === undefined) {
    // Register RegExp_new import on demand: (externref, externref) -> externref
    const importsBefore = ctx.numImportFuncs;
    const regexpNewType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "RegExp_new", { kind: "func", typeIdx: regexpNewType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    funcIdx = ctx.funcMap.get("RegExp_new");
  }
  if (funcIdx === undefined) {
    reportError(ctx, expr, "Missing RegExp_new import for regex literal");
    return null;
  }
  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}

// ── instanceof ────────────────────────────────────────────────────────

/**
 * Collect all class tags that are "instanceof-compatible" with the given class:
 * the class itself plus all its descendants (transitive children).
 */
function collectInstanceOfTags(ctx: CodegenContext, className: string): number[] {
  const ownTag = ctx.classTagMap.get(className);
  if (ownTag === undefined) return [];
  const tags = [ownTag];
  // Walk classParentMap to find all children (classes whose parent is className)
  for (const [child, parent] of ctx.classParentMap) {
    if (parent === className) {
      tags.push(...collectInstanceOfTags(ctx, child));
    }
  }
  return tags;
}

/**
 * Resolve the class name from the right operand of an instanceof expression.
 * Handles identifiers, class expressions, and arbitrary expressions via the type checker.
 */
function resolveInstanceOfClassName(ctx: CodegenContext, rightExpr: ts.Expression): string | undefined {
  // Direct identifier: `x instanceof Foo`
  if (ts.isIdentifier(rightExpr)) {
    const name = rightExpr.text;
    // Check direct name first, then classExprNameMap
    if (ctx.classTagMap.has(name)) return name;
    const mapped = ctx.classExprNameMap.get(name);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
    // Fall through to type checker
  }

  // Use the TypeScript type checker to resolve the type of the right operand
  const tsType = ctx.checker.getTypeAtLocation(rightExpr);
  // For class constructors, get the construct signatures' return type
  const constructSigs = tsType.getConstructSignatures?.();
  if (constructSigs && constructSigs.length > 0) {
    const instanceType = constructSigs[0]!.getReturnType();
    const symbolName = instanceType.getSymbol()?.name;
    if (symbolName) {
      if (ctx.classTagMap.has(symbolName)) return symbolName;
      const mapped = ctx.classExprNameMap.get(symbolName);
      if (mapped && ctx.classTagMap.has(mapped)) return mapped;
    }
  }

  // Try the symbol name directly (for class expressions assigned to variables)
  const symbolName = tsType.getSymbol()?.name;
  if (symbolName) {
    if (ctx.classTagMap.has(symbolName)) return symbolName;
    const mapped = ctx.classExprNameMap.get(symbolName);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
  }

  return undefined;
}

/**
 * Compile `expr instanceof ClassName`.
 * Reads the hidden __tag field (index 0) from the struct and compares
 * it against the class's compile-time tag value (and all descendant tags
 * for class hierarchy support).
 */
export function compileInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType | null {
  // Resolve the right operand class name (supports identifiers, expressions, class expressions)
  const className = resolveInstanceOfClassName(ctx, expr.right);
  if (className === undefined) {
    const dynIdx = ensureLateImport(
      ctx,
      "__instanceof_dyn",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (dynIdx !== undefined) {
      const leftType = compileExpression(ctx, fctx, expr.left, { kind: "externref" });
      if (leftType && leftType.kind !== "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }
      if (leftType === null) fctx.body.push({ op: "ref.null.extern" });

      const rightType = compileExpression(ctx, fctx, expr.right, { kind: "externref" });
      if (rightType && rightType.kind !== "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }
      if (rightType === null) fctx.body.push({ op: "ref.null.extern" });

      const finalDynIdx = ctx.funcMap.get("__instanceof_dyn") ?? dynIdx;
      fctx.body.push({ op: "call", funcIdx: finalDynIdx });
      return { kind: "i32" };
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Collect all compatible tags (this class + all descendants)
  const compatibleTags = collectInstanceOfTags(ctx, className);
  if (compatibleTags.length === 0) {
    // No tags found — emit false
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Compile left operand (the value to test) — must be a ref to a class struct
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) return null;

  // Resolve the struct type index for the right-side class (the target we test against)
  const rightStructTypeIdx = ctx.structMap.get(className);

  // Find the root ancestor of the right class (for casting externref values)
  let rootClass = className;
  while (ctx.classParentMap.has(rootClass)) {
    rootClass = ctx.classParentMap.get(rootClass)!;
  }
  const rootStructTypeIdx = ctx.structMap.get(rootClass) ?? rightStructTypeIdx;

  // --- Handle externref left operand (any type) ---
  // When the left operand is externref, we cannot do struct.get directly.
  // Convert externref -> anyref, try to cast to the root struct type,
  // then read the __tag field and compare against compatible tags.
  // We use ref.test first to avoid trapping on non-struct values (null, primitives).
  if (leftType.kind === "externref") {
    if (rootStructTypeIdx === undefined) {
      // Cannot resolve any struct type — drop and emit false
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }

    // Convert externref -> anyref, store in local
    fctx.body.push({ op: "any.convert_extern" });
    const anyLocalIdx = allocTempLocal(fctx, { kind: "anyref" });
    fctx.body.push({ op: "local.set", index: anyLocalIdx });

    // Build the "then" branch: value is NOT a struct of the right root type -> false
    const thenBody: Instr[] = [{ op: "i32.const", value: 0 }];

    // Build the "else" branch: value IS a struct -> read __tag and compare
    const elseBody: Instr[] = [
      { op: "local.get", index: anyLocalIdx },
      { op: "ref.cast", typeIdx: rootStructTypeIdx },
      { op: "struct.get", typeIdx: rootStructTypeIdx, fieldIdx: 0 },
    ];

    if (compatibleTags.length === 1) {
      elseBody.push({ op: "i32.const", value: compatibleTags[0]! });
      elseBody.push({ op: "i32.eq" });
    } else {
      const tagLocalIdx = allocLocal(fctx, `__instanceof_tag_${fctx.locals.length}`, { kind: "i32" });
      elseBody.push({ op: "local.set", index: tagLocalIdx });
      elseBody.push({ op: "local.get", index: tagLocalIdx });
      elseBody.push({ op: "i32.const", value: compatibleTags[0]! });
      elseBody.push({ op: "i32.eq" });
      for (let i = 1; i < compatibleTags.length; i++) {
        elseBody.push({ op: "local.get", index: tagLocalIdx });
        elseBody.push({ op: "i32.const", value: compatibleTags[i]! });
        elseBody.push({ op: "i32.eq" });
        elseBody.push({ op: "i32.or" });
      }
    }

    // Emit: (local.get $any) (ref.test (ref $rootStruct))
    //        (if (result i32) (then i32.const 0) (else ...read tag...))
    // Note: ref.test returns 0 for non-struct values and null, 1 for matching struct.
    // We invert the condition: if ref.test FAILS -> 0, if PASSES -> check tag.
    fctx.body.push({ op: "local.get", index: anyLocalIdx });
    fctx.body.push({ op: "ref.test", typeIdx: rootStructTypeIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: elseBody, // ref.test passed -> check tag
      else: thenBody, // ref.test failed -> false
    });
    releaseTempLocal(fctx, anyLocalIdx);

    return { kind: "i32" };
  }

  // --- Handle i32 or f64 left operand (primitive types) ---
  // Primitives are never instances of a class — drop and emit false
  if (leftType.kind === "i32" || leftType.kind === "f64") {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // --- Resolve the struct type index from the left operand's type ---
  const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
  let leftClassName = leftTsType.getSymbol()?.name;
  if (leftClassName && !ctx.structMap.has(leftClassName)) {
    leftClassName = ctx.classExprNameMap.get(leftClassName) ?? leftClassName;
  }
  let leftStructTypeIdx = leftClassName ? ctx.structMap.get(leftClassName) : undefined;

  // If the left operand type is not directly resolvable, try to find any struct
  // that could be the base type. For union types or 'any', we try the right class's struct.
  if (leftStructTypeIdx === undefined) {
    leftStructTypeIdx = rootStructTypeIdx;
  }

  if (leftStructTypeIdx === undefined) {
    // Still cannot resolve — drop left value and emit false
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // --- Handle nullable ref (ref_null) — null instanceof X must be false ---
  // For nullable refs, emit: if (ref.is_null) then 0 else (tag check)
  const isNullable = leftType.kind === "ref_null";
  if (isNullable) {
    // Store the ref in a local so we can test it for null and re-use it
    const refLocalIdx = allocLocal(fctx, `__instanceof_ref_${fctx.locals.length}`, leftType);
    fctx.body.push({ op: "local.set", index: refLocalIdx });

    // Build the "then" branch (null case -> false)
    const thenBody: Instr[] = [{ op: "i32.const", value: 0 }];

    // Build the "else" branch (non-null case -> guard with ref.test then read tag)
    // Use ref.test to avoid trapping on wrong struct type (illegal cast)
    const tagCheckBody: Instr[] = [
      { op: "local.get", index: refLocalIdx },
      { op: "ref.cast", typeIdx: leftStructTypeIdx },
      { op: "struct.get", typeIdx: leftStructTypeIdx, fieldIdx: 0 },
    ];

    if (compatibleTags.length === 1) {
      tagCheckBody.push({ op: "i32.const", value: compatibleTags[0]! });
      tagCheckBody.push({ op: "i32.eq" });
    } else {
      const tagLocalIdx = allocLocal(fctx, `__instanceof_tag_${fctx.locals.length}`, { kind: "i32" });
      tagCheckBody.push({ op: "local.set", index: tagLocalIdx });
      tagCheckBody.push({ op: "local.get", index: tagLocalIdx });
      tagCheckBody.push({ op: "i32.const", value: compatibleTags[0]! });
      tagCheckBody.push({ op: "i32.eq" });
      for (let i = 1; i < compatibleTags.length; i++) {
        tagCheckBody.push({ op: "local.get", index: tagLocalIdx });
        tagCheckBody.push({ op: "i32.const", value: compatibleTags[i]! });
        tagCheckBody.push({ op: "i32.eq" });
        tagCheckBody.push({ op: "i32.or" });
      }
    }

    // Guarded: ref.test before ref.cast to avoid illegal cast traps
    const elseBody: Instr[] = [
      { op: "local.get", index: refLocalIdx },
      { op: "ref.test", typeIdx: leftStructTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: tagCheckBody,
        else: [{ op: "i32.const", value: 0 }], // wrong struct type → false
      },
    ];

    // Emit: (local.get $ref) (ref.is_null) (if (result i32) (then ...) (else ...))
    fctx.body.push({ op: "local.get", index: refLocalIdx });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: thenBody,
      else: elseBody,
    });

    return { kind: "i32" };
  }

  // --- Non-nullable ref path: read __tag field directly ---
  // Read the __tag field (field index 0) from the struct
  fctx.body.push({ op: "struct.get", typeIdx: leftStructTypeIdx, fieldIdx: 0 });

  if (compatibleTags.length === 1) {
    // Simple case: exact match only (no subclasses)
    fctx.body.push({ op: "i32.const", value: compatibleTags[0]! });
    fctx.body.push({ op: "i32.eq" });
  } else {
    // Multiple tags: emit (tag == t1) || (tag == t2) || ...
    // We need to store the tag value in a local to avoid re-reading it
    const tagLocalIdx = allocLocal(fctx, `__instanceof_tag_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.set", index: tagLocalIdx });

    // First comparison
    fctx.body.push({ op: "local.get", index: tagLocalIdx });
    fctx.body.push({ op: "i32.const", value: compatibleTags[0]! });
    fctx.body.push({ op: "i32.eq" });

    // Remaining comparisons, OR'd together
    for (let i = 1; i < compatibleTags.length; i++) {
      fctx.body.push({ op: "local.get", index: tagLocalIdx });
      fctx.body.push({ op: "i32.const", value: compatibleTags[i]! });
      fctx.body.push({ op: "i32.eq" });
      fctx.body.push({ op: "i32.or" });
    }
  }

  return { kind: "i32" };
}

// ── typeof ────────────────────────────────────────────────────────────

/**
 * Determine the typeof result string for a TS type at compile time.
 * Returns null if the type cannot be statically resolved (e.g., any/unknown).
 */
function staticTypeofForType(ctx: CodegenContext, tsType: ts.Type): string | null {
  if (tsType.flags & ts.TypeFlags.Null) return "object";
  if (tsType.flags & ts.TypeFlags.Undefined || tsType.flags & ts.TypeFlags.Void) return "undefined";
  if (tsType.flags & ts.TypeFlags.BigInt || tsType.flags & ts.TypeFlags.BigIntLiteral) return "bigint";

  // (#2051) Resolve unions BEFORE the `resolveWasmType` collapse below. A
  // nullable primitive like `number | undefined` (the static type of `o?.v`)
  // collapses to a bare f64 under `resolveWasmType`, which would mis-fold
  // `typeof o?.v` to the constant "number" — wrong when the chain short-circuits
  // to `undefined`. Per §13.5.3 the union's typeof is only statically known if
  // every member agrees; `number` + `undefined` disagree (size 2) → dynamic
  // (`null`), so it reaches the runtime `__typeof` which reads host undefined.
  if (tsType.isUnion?.()) {
    const results = new Set<string>();
    for (const member of (tsType as ts.UnionType).types) {
      const r = staticTypeofForType(ctx, member);
      if (r === null) return null;
      results.add(r);
    }
    return results.size === 1 ? [...results][0]! : null;
  }

  // Wrapper objects (new String/Number/Boolean) are "object" not their primitive type (#929)
  if (tsType.flags & ts.TypeFlags.Object) {
    const sym = tsType.getSymbol?.();
    if (sym && (sym.name === "String" || sym.name === "Number" || sym.name === "Boolean")) {
      return "object";
    }
    // (#1304) Global `Function` interface — TS infers this for params used
    // as `p.call(...)` / `p.apply(...)` etc. Without this branch the value
    // falls into the generic "Object flag → object" path below and idiomatic
    // guards like `if (typeof predicate != 'function')` const-fold to
    // unconditional throws (lodash `negate`, `bind`, similar).
    if (sym && sym.name === "Function") {
      return "function";
    }
  }
  // Check string before wasm type mapping (native strings map to ref)
  if (isStringType(tsType)) return "string";

  const wasmType = resolveWasmType(ctx, tsType);
  if (wasmType.kind === "f64") return "number";
  if (wasmType.kind === "i32") {
    if (isSymbolType(tsType)) return "symbol";
    if (isBooleanType(tsType)) return "boolean";
    return "number";
  }
  if (wasmType.kind === "ref" || wasmType.kind === "ref_null") {
    if (isAnyValue(wasmType, ctx)) return null; // truly dynamic
    const callSigs = tsType.getCallSignatures?.();
    if (callSigs && callSigs.length > 0) return "function";
    const ctorSigs = tsType.getConstructSignatures?.();
    if (ctorSigs && ctorSigs.length > 0) return "function";
    return "object";
  }
  if (wasmType.kind === "externref") {
    const callSigs = tsType.getCallSignatures?.();
    if (callSigs && callSigs.length > 0) return "function";
    const ctorSigs = tsType.getConstructSignatures?.();
    if (ctorSigs && ctorSigs.length > 0) return "function";
    if (tsType.flags & ts.TypeFlags.Object) return "object";
  }

  // (Unions are resolved up-front above, before the resolveWasmType collapse.)
  return null;
}

/**
 * (#2200 Phase 2) Emit the runtime `typeof F` branch for an Annex B B.3.3
 * block-nested function whose outer var-binding is pre-allocated with a TDZ
 * flag: flag set ⇒ the function's `"function"`, flag 0 (uninitialised / block
 * not yet run) ⇒ `"undefined"`. Returns the result ValType, or `null` when `F`
 * is not such a binding (caller falls through to its normal path). Shared by the
 * undeclared-identifier branch AND the late guard so both honor Annex B
 * identically.
 *
 * The TS checker reports the outer-binding symbol with NO `valueDeclaration` at
 * the reference site (the binding is synthetic), so the undeclared-identifier
 * branch would otherwise const-fold `typeof F` to `"undefined"` even after the
 * block ran — this is the bypass that left the binding looking unresolvable.
 */
function emitAnnexBTypeofFlagBranch(ctx: CodegenContext, fctx: FunctionContext, name: string): ValType | null {
  if (!fctx.annexBOuterBindings?.has(name)) return null;
  const flagLocal = fctx.tdzFlagLocals?.get(name);
  if (flagLocal === undefined) return null;
  // Materialise BOTH string constants into the MAIN body first (so any lazy
  // NativeString global-setup / late-import shifts compileStringLiteral emits
  // land in the main stream, not inside an if-arm), stash each in a temp local,
  // then select on the TDZ flag.
  const strType = compileStringLiteral(ctx, fctx, "function") ?? { kind: "externref" };
  const fnStrLocal = allocLocal(fctx, `__typeof_fn_${fctx.locals.length}`, strType);
  fctx.body.push({ op: "local.set", index: fnStrLocal });
  compileStringLiteral(ctx, fctx, "undefined");
  const undefStrLocal = allocLocal(fctx, `__typeof_undef_${fctx.locals.length}`, strType);
  fctx.body.push({ op: "local.set", index: undefStrLocal });
  fctx.body.push({ op: "local.get", index: flagLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: strType },
    then: [{ op: "local.get", index: fnStrLocal }],
    else: [{ op: "local.get", index: undefStrLocal }],
  });
  return strType;
}

/** The nearest enclosing function-like body (or the SourceFile) around `node`. */
function enclosingCodeUnit(node: ts.Node): ts.Node {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (
      ts.isSourceFile(cur) ||
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isConstructorDeclaration(cur) ||
      ts.isGetAccessorDeclaration(cur) ||
      ts.isSetAccessorDeclaration(cur)
    ) {
      return cur;
    }
  }
  return node.getSourceFile();
}

/** True when any iteration statement encloses `node` before `stop`. */
function insideLoopWithin(node: ts.Node, stop: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur && cur !== stop; cur = cur.parent) {
    if (ts.isIterationStatement(cur, /*lookInLabeledStatements*/ true)) return true;
  }
  return false;
}

/**
 * (#4491) True when `ident` is read TEXTUALLY BEFORE its own
 * `var ident = <initializer>` — the `var` binding hoists, its VALUE does not, so
 * §13.5.3 must answer `"undefined"` for that window. The checker types the symbol
 * from its initializer, so `staticTypeofForType` folds the EVENTUAL type forever:
 *
 *     typeof __func;                   // observed "function", spec "undefined"
 *     var __func = function () {};
 *
 *     typeof __ref;                    // observed "object",   spec "undefined"
 *     var obj = new Object(); var __ref = obj;
 *
 * Callers use it only to KILL the fold; the runtime `__typeof*` path then reads
 * the backing module global, which `__module_init` seeds with the `$undefined`
 * singleton before any statement runs and overwrites in declaration order — so
 * both sides of the window answer correctly with no new emission of our own.
 * (An earlier cut tested `ref.is_null` on that global instead; the seed is the
 * singleton, never a null extern, so the guard silently never fired.)
 *
 * Deliberately narrow, because "textually before" only implies "temporally
 * before" under both of these:
 *   - the read and the declaration share one enclosing code unit (otherwise
 *     `function f(){ return typeof x } ; var x = 1; f()` would be mis-guarded —
 *     it runs AFTER the declaration despite reading earlier in the text);
 *   - no loop encloses the read inside that unit (a backward edge can revisit
 *     the read after the declaration already ran).
 * `let`/`const` are excluded: their pre-declaration read is a TDZ ReferenceError,
 * a different answer owned by the boxed-TDZ path above. Standalone/WASI-gated —
 * the host lane keeps its existing fold byte-for-byte.
 */
function readPrecedesVarInitializer(ctx: CodegenContext, fctx: FunctionContext, operand: ts.Expression): boolean {
  if (!(ctx.standalone || ctx.wasi)) return false;
  const ident = skipTransparentExpressions(operand);
  if (!ts.isIdentifier(ident)) return false;
  if (fctx.localMap.get(ident.text) !== undefined) return false;
  if (!ctx.moduleGlobals.has(ident.text)) return false;
  const decl = ctx.oracle.valueDeclarationOf(ident);
  if (!decl || !ts.isVariableDeclaration(decl) || decl.initializer === undefined) return false;
  if (!ts.isVariableDeclarationList(decl.parent)) return false;
  if ((decl.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) return false;
  if (decl.getSourceFile() !== ident.getSourceFile()) return false;
  if (ident.getStart() >= decl.getStart()) return false;
  const unit = enclosingCodeUnit(ident);
  if (unit !== enclosingCodeUnit(decl)) return false;
  return !insideLoopWithin(ident, unit);
}

/**
 * (#2623 P-7) True when SOME assignment expression in `sf` targets a bare
 * identifier named `name`. Used to detect null/undefined flow-narrowing the
 * checker could not invalidate (assignments inside nested closures are not
 * applied to the outer flow), so `typeof x` must take the runtime path instead
 * of const-folding. NAME-based (checker-free, per the #1930 oracle ratchet) —
 * a same-named different binding over-approximates, which only ever trades a
 * fold for a correct runtime `__typeof` call. One walk per source file,
 * cached (source is immutable during a compile).
 */
const _typeofAssignedNamesCache = new WeakMap<ts.SourceFile, ReadonlySet<string>>();
function sourceHasIdentifierAssignment(sf: ts.SourceFile, name: string): boolean {
  let names = _typeofAssignedNamesCache.get(sf);
  if (names === undefined) {
    const collected = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(node.left)
      ) {
        collected.add(node.left.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    names = collected;
    _typeofAssignedNamesCache.set(sf, names);
  }
  return names.has(name);
}

/**
 * Compile `typeof x` as a standalone expression that returns a type string (externref).
 * For statically known types, emits the string constant directly.
 * For externref/union types, calls the __typeof host helper.
 */
/**
 * (#4182) `typeof f` where `f` is a module-scope Annex B B.3.3.2 live binding:
 * read the backing externref global and dispatch `__typeof` at runtime (null
 * extern → "undefined" before the declaration evaluates, closure → "function"
 * after). Gated on the normally-empty `annexBModuleBindings` set and on the
 * name not being locally shadowed, so every other typeof path is byte-identical.
 */
function emitAnnexBModuleTypeofRead(ctx: CodegenContext, fctx: FunctionContext, name: string): ValType | null {
  if (ctx.annexBModuleBindings?.has(name) !== true) return null;
  if (fctx.localMap.get(name) !== undefined) return null;
  const globalIdx = ctx.moduleGlobals.get(name);
  if (globalIdx === undefined) return null;
  addUnionImports(ctx);
  const typeofIdx = ctx.funcMap.get("__typeof");
  if (typeofIdx === undefined) return null;
  // Materialise the "undefined" constant into the MAIN stream first (any lazy
  // NativeString setup must not land inside an if-arm — mirrors
  // emitAnnexBTypeofFlagBranch), then branch on ref.is_null: a null-extern
  // binding is the HOST-lane pre-evaluation state, and the host `__typeof`
  // would answer `typeof null` = "object" for it. Standalone seeds the
  // `$undefined` singleton, whose tag `__typeof` reports as "undefined", so
  // the null arm is simply never taken there.
  const strType = compileStringLiteral(ctx, fctx, "undefined") ?? { kind: "externref" };
  const undefStrLocal = allocLocal(fctx, `__typeof_undef_${fctx.locals.length}`, strType);
  fctx.body.push({ op: "local.set", index: undefStrLocal });
  const valLocal = allocLocal(fctx, `__typeof_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "global.get", index: globalIdx });
  fctx.body.push({ op: "local.tee", index: valLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [
      { op: "local.get", index: undefStrLocal },
      ...(strType.kind === "externref" ? [] : [{ op: "extern.convert_any" } as const]),
    ],
    else: [
      { op: "local.get", index: valLocal },
      { op: "call", funcIdx: typeofIdx },
    ],
  });
  return { kind: "externref" };
}

function runtimeEvalMayRebindIdentifier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expression: ts.Expression,
): boolean {
  if (!(ctx.standalone || ctx.wasi) || !ctx.runtimeEvalGlobalFunctionBindings) return false;
  let bare = expression;
  while (
    ts.isParenthesizedExpression(bare) ||
    ts.isAsExpression(bare) ||
    ts.isTypeAssertionExpression(bare) ||
    ts.isNonNullExpression(bare)
  ) {
    bare = bare.expression;
  }
  if (!ts.isIdentifier(bare)) return false;
  if (runtimeEvalStateMayShadowBinding(ctx, fctx, bare.text)) return true;
  if (!ctx.moduleGlobals.has(bare.text)) return false;
  return (
    (ctx.globalObjectVarBindings?.has(bare.text) ?? false) || (ctx.liveFuncBindingGlobals?.has(bare.text) ?? false)
  );
}

/**
 * (#4394) Unsound-fold guard: a PARAMETER in a JavaScript source file whose
 * type comes only from JSDoc (`@param {Function} testFunc`) has no runtime
 * enforcement whatsoever — `asyncTest(null)` flows null straight into a
 * `{Function}` param, and the harness's `typeof testFunc !== "function"` guard
 * exists precisely to catch that. Folding typeof from the JSDoc type turns the
 * guard into a compile-time constant and silently takes the wrong branch
 * (every asyncHelpers `asyncTest`/`throwsAsync` non-callable rejection path).
 * Kill the fold for annotation-free parameters in JS files; the runtime
 * `__typeof_*` predicates / `$AnyValue` tag path answer correctly standalone.
 * TypeScript parameters keep the #1304 fold (an explicit annotation is a
 * compiler-enforced contract there), and the standalone/wasi gate keeps the
 * host/gc lanes byte-identical.
 */
function typeofFoldUnsoundForJsParam(ctx: CodegenContext, operand: ts.Expression): boolean {
  if (ctx.standalone !== true && ctx.wasi !== true) return false;
  let bare: ts.Expression = operand;
  while (
    ts.isParenthesizedExpression(bare) ||
    ts.isAsExpression(bare) ||
    ts.isTypeAssertionExpression(bare) ||
    ts.isNonNullExpression(bare)
  ) {
    bare = (bare as ts.ParenthesizedExpression | ts.AsExpression).expression;
  }
  if (!ts.isIdentifier(bare)) return false;
  const decl = ctx.oracle.valueDeclarationOf(bare);
  if (decl === undefined || !ts.isParameter(decl)) return false;
  if (decl.type !== undefined) return false; // explicit TS annotation → trusted
  const fileName = decl.getSourceFile().fileName;
  return /\.(js|mjs|cjs|jsx)$/.test(fileName);
}

export function compileTypeofExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TypeOfExpression,
): ValType | null {
  const operand = expr.expression;

  // typeof Math.<constant> -> "number", typeof Math.<method> -> "function"
  if (
    ts.isPropertyAccessExpression(operand) &&
    ts.isIdentifier(operand.expression) &&
    operand.expression.text === "Math"
  ) {
    const mathConstants = new Set(["PI", "E", "LN2", "LN10", "SQRT2", "SQRT1_2", "LOG2E", "LOG10E"]);
    if (mathConstants.has(operand.name.text)) {
      return compileStringLiteral(ctx, fctx, "number");
    }
    return compileStringLiteral(ctx, fctx, "function");
  }

  // typeof import.meta -> "object"
  if (
    ts.isMetaProperty(operand) &&
    operand.keywordToken === ts.SyntaxKind.ImportKeyword &&
    operand.name.text === "meta"
  ) {
    return compileStringLiteral(ctx, fctx, "object");
  }

  // typeof new.target -> "function" inside constructors, "undefined" outside
  if (
    ts.isMetaProperty(operand) &&
    operand.keywordToken === ts.SyntaxKind.NewKeyword &&
    operand.name.text === "target"
  ) {
    if (fctx.isConstructor) {
      return compileStringLiteral(ctx, fctx, "function");
    } else {
      return compileStringLiteral(ctx, fctx, "undefined");
    }
  }

  // typeof UndeclaredIdentifier -> "undefined" (per ES spec: typeof on an
  // unresolvable Reference returns "undefined" instead of throwing). Without
  // this, accessing an undeclared identifier would emit a ref.cast or host
  // call that throws at runtime. (#1050)
  //
  // We detect "undeclared" as: bare Identifier whose symbol at location has
  // no value declaration AND whose parent in source is not a let/const TDZ
  // binding. We conservatively unwrap `as`/parenthesized casts used in tests.
  {
    let ident: ts.Expression = operand;
    while (
      ts.isParenthesizedExpression(ident) ||
      ts.isAsExpression(ident) ||
      ts.isTypeAssertionExpression(ident) ||
      ts.isNonNullExpression(ident)
    ) {
      ident = (ident as ts.ParenthesizedExpression | ts.AsExpression).expression;
    }
    if (ts.isIdentifier(ident)) {
      const argumentsTypeof = staticTypeofForArgumentsIdentifier(ctx, fctx, ident);
      if (argumentsTypeof !== null) return compileStringLiteral(ctx, fctx, argumentsTypeof);
      // (#2200 Phase 2) An Annex B B.3.3 block-fn outer binding must be handled
      // BEFORE the `!hasValueDecl` const-fold below: the checker reports its
      // symbol with no `valueDeclaration` at the reference site (the binding is
      // synthetic), so the undeclared-path would wrongly fold `typeof F` to
      // "undefined" even after the block ran. Emit the runtime TDZ-flag branch
      // instead. Gated on the normally-empty `annexBOuterBindings` set, so every
      // other typeof path is byte-identical.
      const annexB = emitAnnexBTypeofFlagBranch(ctx, fctx, ident.text);
      if (annexB) return annexB;
      // (#4182) Module-scope Annex B live binding: `typeof f` must observe the
      // live global (`undefined` before the declaration evaluates, "function"
      // after), never a static fold. Must run before BOTH the `!hasValueDecl`
      // fold below (for a Block-nested decl the checker reports no
      // valueDeclaration at an outer read → wrongly "undefined" forever) and
      // the static type fold (for `if`-nested decls the checker resolves the
      // hoisted symbol → wrongly "function" before the block runs).
      const annexBModule = emitAnnexBModuleTypeofRead(ctx, fctx, ident.text);
      if (annexBModule) return annexBModule;
      const withBinding = findWithBinding(fctx, ident.text);
      if (withBinding) {
        return compileStringLiteral(ctx, fctx, staticTypeofForWasmType(ctx, withBinding.field.type));
      }
      const sym = ctx.checker.getSymbolAtLocation(ident);
      const hasValueDecl = !!sym?.valueDeclaration;
      // (#3436) In standalone / WASI mode `structuredClone` is deliberately NOT
      // provided — its host import is skipped in extern-declarations, so the
      // global genuinely does not exist and `typeof structuredClone` must be
      // "undefined" (§13.5.3: typeof of an unresolvable Reference). The TS lib
      // gives it an ambient `valueDeclaration`, so the static fold below would
      // otherwise wrongly yield "function", defeating the universal test262
      // prelude's own `typeof structuredClone !== "function"` guard (which must
      // throw the honest "$262.detachArrayBuffer is unsupported by this host"
      // error). Restricted to standalone/WASI + the exact unprovided name +
      // an ambient-lib-only symbol (a user-declared `structuredClone` lives in a
      // non-declaration file and keeps "function"), so host mode is byte-inert.
      if (
        (ctx.standalone || ctx.wasi) &&
        ident.text === "structuredClone" &&
        !runtimeEvalStateMayShadowBinding(ctx, fctx, ident.text) &&
        !!sym?.declarations?.length &&
        sym.declarations.every((d) => d.getSourceFile().isDeclarationFile)
      ) {
        return compileStringLiteral(ctx, fctx, "undefined");
      }
      if (!hasValueDecl) {
        if ((ctx.standalone || ctx.wasi) && ctx.runtimeEvalGlobalFunctionBindings) {
          addUnionImports(ctx);
          const typeofIdx = ctx.funcMap.get("__typeof");
          const valueType = emitRuntimeEvalBindingRead(ctx, fctx, ident.text, true);
          if (typeofIdx !== undefined && valueType !== null) {
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__typeof") ?? typeofIdx });
            return { kind: "externref" };
          }
        }
        return compileStringLiteral(ctx, fctx, "undefined");
      }
    }
  }

  // (#2200 Phase 2) `typeof F` where F is an Annex B block-nested function with a
  // pre-allocated TDZ outer var-binding. The TS checker reports F's symbol as a
  // function type (it models the hoist), so the static-fold below would wrongly
  // yield "function" even before the block runs. Override with a runtime branch
  // on the TDZ flag: flag set ⇒ "function", flag 0 (uninitialised / block not yet
  // run) ⇒ "undefined". Gated on the normally-empty annexBOuterBindings set →
  // every other typeof path is byte-identical.
  {
    let bare: ts.Expression = operand;
    while (
      ts.isParenthesizedExpression(bare) ||
      ts.isAsExpression(bare) ||
      ts.isTypeAssertionExpression(bare) ||
      ts.isNonNullExpression(bare)
    ) {
      bare = (bare as ts.ParenthesizedExpression | ts.AsExpression).expression;
    }
    if (ts.isIdentifier(bare)) {
      // (#2200 Phase 2) Late fallback for an Annex B outer binding that reached
      // here (the undeclared-identifier branch above already handles the common
      // `typeof F` case; this covers any path where the operand resolved past it).
      const annexB = emitAnnexBTypeofFlagBranch(ctx, fctx, bare.text);
      if (annexB) return annexB;
      // (#4182) Same late fallback for a module-scope Annex B live binding.
      const annexBModule = emitAnnexBModuleTypeofRead(ctx, fctx, bare.text);
      if (annexBModule) return annexBModule;
    }
  }

  const tsType = ctx.checker.getTypeAtLocation(operand);

  // (#2705) `typeof x` where x is a let/const binding boxed for closure capture
  // (so it carries a boxed TDZ flag) must NOT static-fold to a type string — if
  // the binding is in its temporal dead zone the read must throw a
  // ReferenceError (§13.5.3.1 / §14.7.5.6). Force the runtime path so
  // `compileExpression(operand)` emits the boxed TDZ check. This fires for a
  // closure built inside a `for (let x in …)` head's receiver that captures the
  // never-initialized head binding (scope-head/​body-lex-open/close).
  let forceRuntimeTypeof = false;
  {
    let bareTdz: ts.Expression = operand;
    while (
      ts.isParenthesizedExpression(bareTdz) ||
      ts.isAsExpression(bareTdz) ||
      ts.isTypeAssertionExpression(bareTdz) ||
      ts.isNonNullExpression(bareTdz)
    ) {
      bareTdz = (bareTdz as ts.ParenthesizedExpression | ts.AsExpression).expression;
    }
    if (ts.isIdentifier(bareTdz) && fctx.boxedTdzFlags?.has(bareTdz.text)) {
      forceRuntimeTypeof = true;
    }
    // A script global synchronized around runtime eval is mutable in the JS
    // sense, irrespective of the checker's flow type at this source position.
    // Eval may have replaced `var initial` (statically `undefined`) with an
    // interpreted function, so folding `typeof initial` is unsound.
    if (runtimeEvalMayRebindIdentifier(ctx, fctx, bareTdz)) {
      forceRuntimeTypeof = true;
    }
    // (#4204) Slot is externref, checker still says primitive — folding
    // `typeof x` would report the initializer's type forever.
    if (ts.isIdentifier(bareTdz) && moduleGlobalIsDynamicButStaticallyPrimitive(ctx, bareTdz)) {
      forceRuntimeTypeof = true;
    }
    // (#4428) Same disagreement one level down: `typeof x[0]` on an array whose
    // element representation was widened must read the value, not the type.
    if (elementReadOfRebindWidenedArray(ctx, bareTdz)) {
      forceRuntimeTypeof = true;
    }
    // (#4394) JSDoc-typed JS parameter — the declared type is not enforced at
    // runtime, so the fold is unsound (see typeofFoldUnsoundForJsParam).
    if (!forceRuntimeTypeof && typeofFoldUnsoundForJsParam(ctx, bareTdz)) {
      forceRuntimeTypeof = true;
    }
    // (#4491) Read before the binding's own `var x = <init>` statement runs —
    // the hoisted binding still holds `undefined` (see readPrecedesVarInitializer).
    if (!forceRuntimeTypeof && readPrecedesVarInitializer(ctx, fctx, bareTdz)) {
      forceRuntimeTypeof = true;
    }
    // (#4491) A member read whose (receiver, key) is RUNTIME accessor-descriptor
    // state: the getter may be redefined at runtime — even to undefined
    // (§6.2.5.6 present-undefined) — so the checker's member-type fold
    // ("number" from the original getter) is unsound. Take the runtime path;
    // the descriptor read returns the honest externref.
    if (
      !forceRuntimeTypeof &&
      ts.isPropertyAccessExpression(bareTdz) &&
      !ts.isPrivateIdentifier(bareTdz.name) &&
      runtimeAccessorDescriptorKey(ctx, bareTdz.expression, bareTdz.name.text) !== undefined
    ) {
      forceRuntimeTypeof = true;
    }
    // (#2623 P-7) `typeof x` where x's FLOW-narrowed type is null/undefined but
    // the binding is ASSIGNED elsewhere in the source must NOT const-fold: TS
    // does not apply assignments made inside nested closures to the outer flow,
    // so
    //   var resolve = null;
    //   target.then = function(a, b) { resolve = a; };
    //   …; typeof resolve   // narrowed `null` → folded "object"
    // while the runtime value is a host function (test262
    // `finally/invokes-then-with-function.js` assert #4). Host lane only — the
    // standalone `__typeof` native is a null stub (#2107), so the fold remains
    // preferable there. Assignments the SAME function's flow already tracked
    // re-narrow the type away from null, so this only fires where the fold is
    // genuinely unsound (closure-crossing or branch-dependent writes) — those
    // sites trade the fold for a correct runtime `__typeof` call.
    if (
      !forceRuntimeTypeof &&
      ctx.standalone !== true &&
      ctx.wasi !== true &&
      ts.isIdentifier(bareTdz) &&
      (tsType.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0 &&
      sourceHasIdentifierAssignment(bareTdz.getSourceFile(), bareTdz.text)
    ) {
      forceRuntimeTypeof = true;
    }
  }

  // Try static resolution first via the shared helper
  if (!forceRuntimeTypeof) {
    const staticResult = staticTypeofForType(ctx, tsType);
    // (#4250) Unsound-fold guard: the checker types a fnctor field from the
    // constructor's write, so the fold ignores every OTHER write reaching the
    // field. Killed on a PROVEN write-kind contradiction only.
    if (staticResult !== null && !typeofFoldContradictedByFieldVerdict(ctx, operand, staticResult)) {
      return compileStringLiteral(ctx, fctx, staticResult);
    }
  }

  // $AnyValue operand → runtime typeof via __any_typeof, which tag-dispatches
  // and returns a native `ref $AnyString`. This fires for fast mode AND for
  // standalone/WASI: the latter previously fell through to the `__typeof` host
  // helper below, whose standalone native form is a `ref.null.extern` stub
  // (index.ts registerNative), so `typeof (v: any)` returned null and every
  // `typeof v === "…"` string compare failed (#2107). __any_typeof needs the
  // native-string machinery (nativeStrings + a registered $AnyString type), so
  // it's only consulted when those are present; otherwise we keep the legacy
  // __typeof path so non-native-string builds stay byte-identical.
  const wasmType = resolveWasmType(ctx, tsType);
  if (
    (wasmType.kind === "ref" || wasmType.kind === "ref_null") &&
    isAnyValue(wasmType, ctx) &&
    ctx.nativeStrings &&
    ctx.anyStrTypeIdx >= 0
  ) {
    ensureAnyHelpers(ctx);
    const typeofIdx = ctx.funcMap.get("__any_typeof");
    if (typeofIdx !== undefined) {
      const operandType = compileExpression(ctx, fctx, operand);
      if (operandType === null) return null;
      fctx.body.push({ op: "call", funcIdx: typeofIdx });
      return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
    }
  }

  // For union/unknown externref types, call the __typeof host helper at runtime
  addUnionImports(ctx);
  const funcIdx = ctx.funcMap.get("__typeof");
  if (funcIdx === undefined) return null;

  // Compile the operand to push its value onto the stack
  const operandType = compileExpression(ctx, fctx, operand);
  if (operandType === null) return null;

  // Coerce to externref if needed (e.g. f64 -> boxed number, ref -> extern.convert_any)
  if (operandType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else if (operandType.kind === "i32") {
    const boxIdx = ctx.funcMap.get(operandType.symbol === true ? "__box_symbol" : "__box_boolean");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else if (operandType.kind === "ref" || operandType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  }

  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}

function staticTypeofForWasmType(ctx: CodegenContext, type: ValType): string {
  if (type.kind === "i32") return type.symbol === true ? "symbol" : "boolean";
  if (type.kind === "f32" || type.kind === "f64" || type.kind === "i64") return "number";
  // (#4231 RC-D) A `with`-bound STRING field is a ref to one of the native
  // string types, not an object. Without this it fell into the `"object"`
  // catch-all below and `with ({s:'a'}) { typeof s }` answered "object".
  if ((type.kind === "ref" || type.kind === "ref_null") && isNativeStringTypeIdx(ctx, type.typeIdx)) {
    return "string";
  }
  return "object";
}

/** True for the WasmGC type indices that carry a JS string value. */
function isNativeStringTypeIdx(ctx: CodegenContext, typeIdx: number): boolean {
  return typeIdx === ctx.anyStrTypeIdx || typeIdx === ctx.nativeStrTypeIdx;
}

/**
 * Compile `typeof x === "number"` / `typeof x !== "string"` etc.
 * Returns i32 result, or null if the expression is not a typeof comparison.
 */
export function compileTypeofComparison(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType | null {
  const op = expr.operatorToken.kind;
  const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEq && !isNeq) return null;

  // Detect typeof on left or right
  let typeofExpr: ts.TypeOfExpression | null = null;
  let stringLiteral: string | null = null;

  if (ts.isTypeOfExpression(expr.left) && ts.isStringLiteral(expr.right)) {
    typeofExpr = expr.left;
    stringLiteral = expr.right.text;
  } else if (ts.isTypeOfExpression(expr.right) && ts.isStringLiteral(expr.left)) {
    typeofExpr = expr.right;
    stringLiteral = expr.left.text;
  }

  if (!typeofExpr || !stringLiteral) return null;

  // Static resolution: if the typeof result is known at compile time,
  // emit a constant comparison result without any runtime call.
  const operand = typeofExpr.expression;

  // typeof UndeclaredIdentifier -> "undefined" (#1050)
  {
    let ident: ts.Expression = operand;
    while (
      ts.isParenthesizedExpression(ident) ||
      ts.isAsExpression(ident) ||
      ts.isTypeAssertionExpression(ident) ||
      ts.isNonNullExpression(ident)
    ) {
      ident = (ident as ts.ParenthesizedExpression | ts.AsExpression).expression;
    }
    if (ts.isIdentifier(ident)) {
      // (#4555) §10.6 — see isArgumentsObjectIdentifier.
      if (emitArgumentsTypeofComparison(ctx, fctx, ident, stringLiteral, isEq)) return { kind: "i32" };
      const withBinding = findWithBinding(fctx, ident.text);
      if (withBinding) {
        const actual = staticTypeofForWasmType(ctx, withBinding.field.type);
        const matches = actual === stringLiteral;
        const result = isEq ? (matches ? 1 : 0) : matches ? 0 : 1;
        fctx.body.push({ op: "i32.const", value: result });
        return { kind: "i32" };
      }
      const sym = ctx.checker.getSymbolAtLocation(ident);
      if (!sym?.valueDeclaration) {
        const annexB = emitAnnexBTypeofFlagBranch(ctx, fctx, ident.text);
        if (annexB) {
          const actual = annexB;
          if (actual.kind !== "externref") return null;
          const literalType = compileStringLiteral(ctx, fctx, stringLiteral);
          if (!literalType) return null;
          return emitHostEqualityFromStack(ctx, fctx, actual, literalType, true, isNeq);
        }
        if ((ctx.standalone || ctx.wasi) && ctx.runtimeEvalGlobalFunctionBindings) {
          addUnionImports(ctx);
          let helperName: string | null = null;
          if (stringLiteral === "number") helperName = "__typeof_number";
          else if (stringLiteral === "string") helperName = "__typeof_string";
          else if (stringLiteral === "boolean") helperName = "__typeof_boolean";
          else if (stringLiteral === "bigint") helperName = "__typeof_bigint";
          else if (stringLiteral === "undefined") helperName = "__typeof_undefined";
          else if (stringLiteral === "object") helperName = "__typeof_object";
          else if (stringLiteral === "function") helperName = "__typeof_function";
          const helperIdx = helperName === null ? undefined : ctx.funcMap.get(helperName);
          const valueType = emitRuntimeEvalBindingRead(ctx, fctx, ident.text, true);
          if (helperIdx !== undefined && valueType !== null) {
            fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(helperName!) ?? helperIdx });
            if (isNeq) fctx.body.push({ op: "i32.eqz" });
            return { kind: "i32" };
          }
        }
        const matches = "undefined" === stringLiteral;
        const result = isEq ? (matches ? 1 : 0) : matches ? 0 : 1;
        fctx.body.push({ op: "i32.const", value: result });
        return { kind: "i32" };
      }
      // (#3436) standalone/WASI: `structuredClone` is deliberately unprovided
      // (host import skipped in extern-declarations), so `typeof structuredClone`
      // is "undefined". The lib's ambient `valueDeclaration` would otherwise fold
      // it to "function" below, defeating the universal test262 prelude's own
      // `$262.detachArrayBuffer` guard (which must throw the honest "unsupported
      // by this host"). Ambient-lib-only symbol + exact name + standalone/WASI,
      // so a user-declared `structuredClone` and host mode are byte-inert.
      if (
        (ctx.standalone || ctx.wasi) &&
        ident.text === "structuredClone" &&
        !runtimeEvalStateMayShadowBinding(ctx, fctx, ident.text) &&
        !!sym.declarations?.length &&
        sym.declarations.every((d) => d.getSourceFile().isDeclarationFile)
      ) {
        const matches = "undefined" === stringLiteral;
        const result = isEq ? (matches ? 1 : 0) : matches ? 0 : 1;
        fctx.body.push({ op: "i32.const", value: result });
        return { kind: "i32" };
      }
    }
  }

  const tsType = ctx.checker.getTypeAtLocation(operand);
  let staticTypeof: string | null = null;
  // Math.<constant> -> "number", Math.<method> -> "function"
  if (
    ts.isPropertyAccessExpression(operand) &&
    ts.isIdentifier(operand.expression) &&
    operand.expression.text === "Math"
  ) {
    const mathConstants = new Set(["PI", "E", "LN2", "LN10", "SQRT2", "SQRT1_2", "LOG2E", "LOG10E"]);
    staticTypeof = mathConstants.has(operand.name.text) ? "number" : "function";
  } else {
    staticTypeof = staticTypeofForType(ctx, tsType);
  }
  if (staticTypeof !== null && runtimeEvalMayRebindIdentifier(ctx, fctx, operand)) {
    staticTypeof = null;
  }
  // (#4204) Same unsound-fold guard as compileTypeofExpression.
  if (staticTypeof !== null && ts.isIdentifier(operand) && moduleGlobalIsDynamicButStaticallyPrimitive(ctx, operand)) {
    staticTypeof = null;
  }
  // (#4491) `typeof x <cmp> "…"` read before `var x = <init>` runs — the hoisted
  // binding still holds `undefined`, so the checker's initializer-derived fold is
  // wrong for that window. Emit the same one-sided live-ness guard the plain
  // `typeof` arm uses: a NULL backing global answers "undefined", anything else
  // keeps the folded verdict.
  // (#4491) Read before the binding's own `var x = <init>` runs — the hoisted
  // binding still holds `undefined` (see readPrecedesVarInitializer).
  if (staticTypeof !== null && staticTypeof !== "undefined" && readPrecedesVarInitializer(ctx, fctx, operand)) {
    staticTypeof = null;
  }
  // (#4428) Element read off an array whose ELEMENT representation was widened
  // — the checker still reports the first declaration's element type.
  if (staticTypeof !== null && elementReadOfRebindWidenedArray(ctx, operand)) {
    staticTypeof = null;
  }
  // (#2623 P-7) Same unsound-fold guard as compileTypeofExpression: a
  // null/undefined FLOW narrowing over a binding assigned elsewhere (closure-
  // crossing writes the checker can't apply) must not const-fold the
  // comparison — take the runtime `__typeof_*` helper path below instead.
  if (
    staticTypeof !== null &&
    ctx.standalone !== true &&
    ctx.wasi !== true &&
    ts.isIdentifier(operand) &&
    (tsType.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0 &&
    sourceHasIdentifierAssignment(operand.getSourceFile(), operand.text)
  ) {
    staticTypeof = null;
  }
  // (#2992 S6, standalone) A member/element read off a growable-object-literal
  // receiver rides the dynamic `$Object` — a shape key may be DELETED at
  // runtime, so the checker-type fold ("number") is unsound. Take the runtime
  // path: the S6 read arm returns the raw externref (real undefined when
  // tombstoned) and the dynamic typeof answers correctly.
  if (
    staticTypeof !== null &&
    ctx.standalone &&
    (ts.isPropertyAccessExpression(operand) || ts.isElementAccessExpression(operand)) &&
    chainRootIsGrowable(ctx, operand.expression)
  ) {
    staticTypeof = null;
  }
  // (#4250) Same unsound-fold guard as compileTypeofExpression: a fnctor field
  // read whose write-kind verdict PROVES a write of a different kind reaches
  // the field must not const-fold the comparison.
  if (staticTypeof !== null && typeofFoldContradictedByFieldVerdict(ctx, operand, staticTypeof)) {
    staticTypeof = null;
  }
  // (#4394) JSDoc-typed JS parameter — no runtime enforcement, fold unsound
  // (`typeof testFunc !== "function"` in asyncHelpers must observe the value).
  if (staticTypeof !== null && typeofFoldUnsoundForJsParam(ctx, operand)) {
    staticTypeof = null;
  }
  // (#4491) Runtime accessor-descriptor member read — same guard as
  // compileTypeofExpression: the getter may be redefined at runtime, the
  // checker's member type is not evidence.
  if (
    staticTypeof !== null &&
    ts.isPropertyAccessExpression(operand) &&
    !ts.isPrivateIdentifier(operand.name) &&
    runtimeAccessorDescriptorKey(ctx, operand.expression, operand.name.text) !== undefined
  ) {
    staticTypeof = null;
  }
  if (staticTypeof !== null) {
    const matches = staticTypeof === stringLiteral;
    const result = isEq ? (matches ? 1 : 0) : matches ? 0 : 1;
    fctx.body.push({ op: "i32.const", value: result });
    return { kind: "i32" };
  }

  // Any-typed typeof comparison via tag check
  // Instead of calling __any_typeof + string comparison, we can directly check the tag
  // on the $AnyValue struct. This avoids pulling in the full native string helpers.
  if (isAnyValue(resolveWasmType(ctx, tsType), ctx)) {
    ensureAnyHelpers(ctx);
    // Map the string literal to canonical JsTag (#2104) tag check(s):
    //   0 Null · 1 Undefined · 2 NumberI32 · 3 NumberF64 · 4 Boolean ·
    //   5 String · 6 Object · 7 Function.
    // (#2107) Pre-canonical this used `string -> [5,6]` and `object -> [0]`,
    // which conflated tag 6 (Object) with strings and dropped real objects
    // from the `object` arm — so `typeof (s: any-string) === "object"` was
    // true and `typeof (o: any-object) === "object"` was false. Corrected:
    // string is tag 5 only; object is null (0) or Object (6); function is 7.
    let tagChecks: number[] | null = null;
    if (stringLiteral === "number")
      tagChecks = [2, 3]; // i32 or f64
    else if (stringLiteral === "boolean") tagChecks = [4];
    else if (stringLiteral === "string") tagChecks = [5];
    else if (stringLiteral === "undefined") tagChecks = [1];
    else if (stringLiteral === "object")
      tagChecks = [0, 6]; // null -> "object", plain object ref
    else if (stringLiteral === "function") tagChecks = [7];

    if (tagChecks !== null) {
      // Compile the operand
      const operandType = compileExpression(ctx, fctx, operand);
      if (!operandType) return null;
      // Get the tag field
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 0 });
      // Check if tag matches any of the expected values
      if (tagChecks.length === 1) {
        fctx.body.push({ op: "i32.const", value: tagChecks[0]! });
        fctx.body.push({ op: "i32.eq" });
      } else {
        // Multiple tags: (tag == t1) || (tag == t2)
        const tagLocal = allocTempLocal(fctx, { kind: "i32" });
        fctx.body.push({ op: "local.set", index: tagLocal });
        fctx.body.push({ op: "local.get", index: tagLocal });
        fctx.body.push({ op: "i32.const", value: tagChecks[0]! });
        fctx.body.push({ op: "i32.eq" });
        for (let i = 1; i < tagChecks.length; i++) {
          fctx.body.push({ op: "local.get", index: tagLocal });
          fctx.body.push({ op: "i32.const", value: tagChecks[i]! });
          fctx.body.push({ op: "i32.eq" });
          fctx.body.push({ op: "i32.or" });
        }
        releaseTempLocal(fctx, tagLocal);
      }
      if (isNeq) {
        fctx.body.push({ op: "i32.eqz" });
      }
      return { kind: "i32" };
    }
  }

  // Ensure union imports are registered
  addUnionImports(ctx);

  // Determine the helper function name
  let helperName: string | null = null;
  if (stringLiteral === "number") helperName = "__typeof_number";
  else if (stringLiteral === "string") helperName = "__typeof_string";
  else if (stringLiteral === "boolean") helperName = "__typeof_boolean";
  else if (stringLiteral === "bigint") helperName = "__typeof_bigint";
  else if (stringLiteral === "undefined") helperName = "__typeof_undefined";
  else if (stringLiteral === "object") helperName = "__typeof_object";
  else if (stringLiteral === "function") helperName = "__typeof_function";

  if (!helperName) return null;

  const funcIdx = ctx.funcMap.get(helperName);
  if (funcIdx === undefined) return null;

  // Compile the operand of typeof — need to get the raw externref value
  // The operand should be loaded without narrowing (use the declared type)
  // (#2623 P-7) A BOXED-CAPTURE binding must NOT take the raw `local.get` fast
  // path: the local holds the mutable ref CELL, not the value, so the
  // `typeof_check` host shim received the cell struct (`[object Object]`) and
  // `typeof resolve === "function"` was false for a stored host function.
  // Route through compileExpression, whose identifier path derefs the cell.
  if (ts.isIdentifier(operand)) {
    const localIdx =
      fctx.boxedCaptures?.has(operand.text) || runtimeEvalStateMayShadowBinding(ctx, fctx, operand.text)
        ? undefined
        : fctx.localMap.get(operand.text);
    if (localIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: localIdx });
    } else {
      // Try other resolution paths. (#2623 P-7) Request externref explicitly:
      // an `$AnyValue`-rep module global read without an expected type crossed
      // to the `typeof_check` host shim as the RAW box via a bare
      // `extern.convert_any` (host saw `[object Object]` → `typeof resolve ===
      // "function"` was false for a stored host function); the expected-type
      // path routes through coerceType's AnyValue→externref unboxing arms.
      const valType = compileExpression(ctx, fctx, operand, { kind: "externref" });
      if (!valType) return null;
      if (valType.kind !== "externref") coerceType(ctx, fctx, valType, { kind: "externref" });
    }
  } else {
    const valType = compileExpression(ctx, fctx, operand, { kind: "externref" });
    if (!valType) return null;
    if (valType.kind !== "externref") coerceType(ctx, fctx, valType, { kind: "externref" });
  }

  // Call the typeof helper
  fctx.body.push({ op: "call", funcIdx });

  // If !== comparison, negate the result
  if (isNeq) {
    fctx.body.push({ op: "i32.eqz" });
  }

  return { kind: "i32" };
}
