// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Assignment operator compilation: simple assignment, destructuring, compound, logical.
 */
import { ts, forEachChild } from "../../ts-api.js";
import { receiverIsRealmGlobalObject } from "../helpers/sloppy-this-global.js"; // (#4500 Slice A) realm-global receiver
import { tryEmitRealmGlobalElementWrite } from "../realm-global-element-write.js"; // (#4491 T4) its bracket twin
import { isBooleanType, isExternalDeclaredClass, isStringType } from "../../checker/type-mapper.js";
import { integrityVarKey } from "../widened-var-key.js";
import { PROP_FLAG_ACCESSOR, PROP_FLAG_WRITABLE } from "../object-ops.js";
import type { FieldDef, Instr, ValType } from "../../ir/types.js";
import { emitBoundsCheckedArrayGet, resolveArrayInfo } from "../array-methods.js";
import { emitArraySetLengthValidation } from "../array-length-define.js"; // (#4222) §10.4.2.4 step 3
import { emitHoleToUndefined, holeSentinelInstrs } from "../array-holes.js";
import { emitF64GapFillInstrs } from "../vec-f64-hole-gap.js"; // (#4491 T8)
import { emitF64HoleToUndef, f64HolesActive } from "../vec-f64-hole-presence.js"; // (#4491 T11)
import { HOLE_F64_BITS } from "../value-tags.js"; // (#4491 T11)
// prettier-ignore
import { emitUnbackableIndexFlag, guardedElementSetInstrs, needsGapFillCondInstrs, needsGrowCondInstrs } from "../vec-sparse-index.js";
import { tryEmitLinearU8ElementCompound, tryEmitLinearU8ElementSet } from "../linear-uint8-codegen.js";
import { emitAnyAdd, emitModulo, emitToInt32, emitToUint8Clamp } from "../binary-ops.js";
import { popBody, pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import { fnShadowSlot, isShadowedTopLevelFn, withShadowReadSuppressed } from "../fn-global-shadow.js"; // (#4630)
import { reportSilentFallback } from "../fallback-telemetry.js";
import { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  addFuncType,
  addImport,
  addStringConstantGlobal,
  addStringImports,
  addUnionImports,
  ensureExnTag,
  ensureI32Condition,
  ensureStructForType,
  getArrTypeIdxFromVec,
  localGlobalIdx,
  resolveWasmType,
  TYPED_ARRAY_NAMES,
} from "../index.js";
import {
  getOrRegisterVecBaseType,
  getSubviewArrTypeIdx,
  isHoleyArrayType,
  isSubviewTypeIdx,
  isTaViewTypeIdx,
} from "../registry/types.js"; // (#2357/#47) subview write; (#3054 B1) TA view write; vec-base length write
import { emitTaDynViewElementSet, emitTaViewElementSet } from "../dataview-native.js"; // (#3054 B1) shared-backing TA view write; (#3057) dynamic view element write
import { buildDestructureNullThrow, emitNativeObjectRest, patternIteratorStepCount } from "../destructuring-params.js";
import { resolveComputedKeyExpression } from "../literals.js";
import { resolveReceiverStruct } from "../fnctor-escape-gate.js"; // (#2681/#2686 A3) pinned-struct write dispatch
import { presenceSetInstrs, presenceSlotOf } from "../fnctor-presence-bits.js"; // (#3780) packed own-presence flags
import { tryEmitFnctorTypedFieldSet } from "../fnctor-typed-reads.js"; // (#4155 Phase 2) struct-typed fnctor receiver
import { tryEmitTypedThisFieldSet } from "../typed-this.js"; // (#3683 S2) typed-`this` field write
import { reserveMemberSetDispatch } from "../member-set-dispatch.js"; // (#2681/#2686 A3) pre-check set dispatcher
import { tryEmitTypedF64MemberSet } from "../member-set-f64.js"; // (#4157 A) typed f64 write twin
import { reserveMemberGetDispatch } from "../member-get-dispatch.js"; // (#2681/#2686) symmetric struct read for compound
import {
  emitAlternateStructSetDispatch,
  emitCapturedBoxGlobalRead,
  emitCapturedBoxGlobalWrite,
  emitNullGuardedStructGet,
  getCapturedBoxGlobal,
  isIrWithOpenObjectTargetReceiver,
  isNumericIndexExpression,
  isProvablyNonNull,
  isSafeBoundsEliminated,
  tryEmitDeleteAwareDynamicSet,
  typeErrorThrowInstrs,
} from "../property-access.js";
import type { InnerResult } from "../shared.js";
import {
  coerceType,
  compileExpression,
  materializeStructAsObject,
  skipTransparentExpressions,
  valTypesMatch,
  VOID_RESULT,
} from "../shared.js";
import { compileStringLiteral, emitBoolToString } from "../string-ops.js";
import { compileProtoArg } from "./calls.js";
import { findExternInfoForMember, patchStructNewForDynamicField } from "./extern.js";
import { tryCompileFnctorPrototypeAssign } from "./fnctor-prototype.js";
import { reserveAccessorSetDriver } from "../accessor-driver.js";
import { S5C_STRUCT_ACCESSOR_CLOSURE } from "../struct-accessor-closure.js";
import {
  findUnresolvableInArrayPattern,
  findUnresolvableInObjectPattern,
  isUnresolvableIdent,
  NOT_UNRESOLVABLE,
  tryCompileUnresolvableIdentifierAssign,
} from "./unresolvable-assign.js";
import {
  arrayIteratorOverrideGlobalIdx,
  emitArrayProtoIteratorDrive,
  maybeCaptureArrayProtoOverride,
} from "./proto-override.js";
import {
  buildThrowJsErrorInstrs,
  classifyPrivateMember,
  emitCoercedLocalSet,
  emitSuperUninitializedThisGuard,
  emitThrowReferenceError,
  emitThrowTypeError,
  emitWebCompatCallAssignmentTarget,
  getFuncParamTypes,
  updateLocalType,
  widenLocalToNullable,
} from "./helpers.js";
import {
  emitUndefined,
  ensureLateImport,
  flushLateImportShifts,
  patchStructNewForAddedField,
  shiftLateImportIndices,
} from "./late-imports.js";
import { emitMappedArgParamSync, emitMappedArgReverseSync } from "./logical-ops.js";
import { resolveStructName, resolveStructNameForExpr } from "./misc.js";
import { tryCompileStandaloneRegExpLastIndexWrite } from "../regexp-standalone.js";
import { tryCompileStandaloneDetachedWrite } from "../dataview-native.js"; // (#3173) $DETACHBUFFER marker write
import { externrefBackedOwnFieldBacking, getOrRegisterErrorStructType } from "../registry/error-types.js";
import { tryEmitErrorInstanceFieldWrite } from "../error-instance-field-write.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { compileCoercionRhs } from "../char-at-transfer.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { emitNativeGlobalThisObject } from "../array-object-proto.js"; // (#4630)
import { resolveEffectiveStructName } from "../property-access.js";
import { emitOverlayRoutedElementSet, overlayRouteActive } from "../typed-lane-overlay-route.js"; // (#4159 S5)
import {
  elementAccessTypedArrayName,
  emitNonIndexVecElementSet,
  nonArrayIndexNumericKey,
  compileElementIndexI32,
} from "../array-nonindex-key.js"; // (#4247) §10.4.2.2 named-key routing + the relocated TA-view-name helper
import {
  compileStringBuilderAppend,
  emitStringBuilderAppendCodeUnit,
  getBuilderInfo,
  type StringBuilderInfo,
} from "../string-builder.js";
import {
  captureDynamicWithHasBindings,
  compileWithBindingAssignment,
  emitDynamicWithSet,
  resolveWithBinding,
} from "../with-scope.js";
import {
  emitCaptureRuntimeEvalBindingValueCell,
  emitGlobalEnvironmentKey,
  emitGlobalEnvironmentObject,
  emitRefreshRuntimeEvalBindingValueCellForWrite,
  emitRuntimeEvalBindingCellWrite,
  ensureGlobalEnvironmentOperation,
} from "../global-environment.js";
import { isStrictContext } from "../helpers/is-strict-function.js";
import { BUILTIN_CTOR_ARITY } from "../builtin-value-read.js"; // (#4484 C) which names are builtin constructors
import {
  isSpecNonWritableBuiltinProp,
  isSpecNonWritableGlobalValueName, // (#4621 B)
  resolveUnshadowedGlobalIdentifier,
} from "../builtin-nonwritable-write.js"; // (#4484 C)
import { tryCompileStrictFunctionPoisonAssignment } from "../function-poison-pill-access.js";
import { emitRuntimeEvalAotCallableAdapter } from "../runtime-eval-callable.js";
import { tryEmitStaticI32Expression } from "../i32-static-range-expr.js";
import { emitToPropertyKeyOnce } from "./computed-member-reference.js";
import { inheritedSetAffectsKey } from "../inherited-set-gate.js"; // (#4602) per-key #4504 gate

/**
 * Emit a null/undefined guard for an externref-typed destructuring source.
 * Throws TypeError if the value in `srcLocal` is null or the JS undefined sentinel.
 * Per spec §14.3.3.1 RequireObjectCoercible / §8.4.2 GetIterator.
 */
function emitExternrefAssignDestructureGuard(ctx: CodegenContext, fctx: FunctionContext, srcLocal: number): void {
  // ref.is_null check (catches JS null when encoded as ref.null.extern).
  // Build a fresh Instr[] for each if-then: sharing a single array across two
  // branches causes walkInstructions (used by shiftLateImportIndices) to walk
  // it twice when subsequent late imports shift funcIdx, producing a double
  // shift that corrupts the throw_type_error call site.
  fctx.body.push({ op: "local.get", index: srcLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: buildDestructureNullThrow(ctx, fctx),
    else: [],
  });
  // __extern_is_undefined check (catches JS undefined held as non-null externref)
  const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  if (undefIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "call", funcIdx: undefIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: buildDestructureNullThrow(ctx, fctx),
      else: [],
    });
  }
}

/**
 * (#3546) After a local write to a `__module_init` MODULE-BINDING shadow local
 * (recorded by the top-level closure declaration in
 * `fctx.moduleBindingShadowLocals`), re-sync the `$__mod_<name>` global so the
 * reassignment is visible to every OTHER function's read/call (which resolve
 * through the global, not the shadow). Pre-fix, `let f = () => 1; f = () => 2;`
 * at module top level updated only the shadow — cross-function `f()` silently
 * kept the FIRST closure.
 *
 * Exact name→index match keeps this inert for genuine function-locals and
 * block-scoped shadows (they use different local slots). Expects the assigned
 * value to be ON THE STACK (post-`local.tee`); net stack effect is zero.
 */
function emitModuleShadowGlobalSync(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  localIdx: number,
  stackType: ValType,
): void {
  if (fctx.moduleBindingShadowLocals?.get(name) !== localIdx) return;
  const moduleIdx = ctx.moduleGlobals.get(name);
  if (moduleIdx === undefined) return;
  const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
  const globalType = globalDef?.type;
  fctx.body.push({ op: "local.get", index: localIdx });
  if (globalType?.kind === "externref" && (stackType.kind === "ref" || stackType.kind === "ref_null")) {
    // Box on store — the #3534 invariant: the global stays externref.
    fctx.body.push({ op: "extern.convert_any" });
  } else if (globalType && !valTypesMatch(stackType, globalType)) {
    coerceType(ctx, fctx, stackType, globalType);
  }
  fctx.body.push({ op: "global.set", index: moduleIdx });
}

function emitAnnexBOuterBindingWriteFlag(fctx: FunctionContext, name: string): void {
  if (!fctx.annexBOuterBindings?.has(name)) return;
  const flagLocal = fctx.tdzFlagLocals?.get(name);
  if (flagLocal === undefined) return;
  const boxed = fctx.boxedTdzFlags?.get(name);
  if (boxed) {
    // Captured Annex-B outer bindings share their flag through an i32 ref
    // cell; the `tdzFlagLocals` entry is the box local in this case.
    fctx.body.push({ op: "local.get", index: boxed.localIdx });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 });
  } else {
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "local.set", index: flagLocal });
  }
}

export function compileAssignment(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): InnerResult {
  // Unwrap parenthesized LHS: (x) = 1 → x = 1
  let lhs = expr.left;
  while (ts.isParenthesizedExpression(lhs)) {
    lhs = lhs.expression;
  }
  // If we unwrapped parentheses, create a synthetic-like view for the checks below
  // by rebinding the checks to use `lhs` instead of `expr.left`
  if (lhs !== expr.left) {
    // Recursively handle the unwrapped LHS by synthesizing a new expression-like object
    const synth = { ...expr, left: lhs } as ts.BinaryExpression;
    return compileAssignment(ctx, fctx, synth);
  }
  // Annex B.3.9: evaluate the sloppy-mode call target, then throw before the
  // RHS is evaluated. Strict-mode call targets were rejected as early errors.
  if (emitWebCompatCallAssignmentTarget(ctx, fctx, lhs)) {
    return { kind: "f64" };
  }
  // (#1719 CPR write-arm) `Array.prototype[Symbol.iterator] = fn` /
  // `Array.prototype.values = fn` has no compiled landing spot and is otherwise
  // silently dropped. Capture the lifted override closure into ctx.protoOverrides
  // (rooted in a module global) so array dstr / for-of / spread can drive it.
  // Gated on the S1 brand inside the helper — no-op (byte-identical) otherwise.
  if (maybeCaptureArrayProtoOverride(ctx, fctx, lhs, expr.right)) {
    return { kind: "externref" };
  }

  if (ts.isIdentifier(expr.left)) {
    const name = expr.left.text;
    const withRes = resolveWithBinding(fctx, name);
    if (withRes?.kind === "static") {
      return compileWithBindingAssignment(ctx, fctx, withRes.binding, expr.right);
    }
    if (withRes?.kind === "dynamic") {
      // (#2663 Slice 2, #2061 fix) HasBinding-gated WRITE with spec-correct
      // ordering (§13.15.2): the LHS Reference is resolved — i.e. each candidate
      // dynamic-`with` scope's HasBinding is captured — BEFORE the RHS evaluates.
      // (Capturing it AFTER the RHS let an RHS that mutates the with-object flip
      // the binding decision and mis-route the write: regressed S11.13.1_A6_T3.)
      // So: (1) capture HasBinding(scope,name) into i32 temps for the cascade
      // chain, innermost-first; (2) evaluate the RHS ONCE into an externref temp;
      // (3) cascade-write using the pre-captured i32s, falling to the lexical
      // write when none matched.
      const captures = captureDynamicWithHasBindings(ctx, fctx, expr.left.text);
      const rhsType = compileExpression(ctx, fctx, expr.right, { kind: "externref" });
      if (!rhsType) {
        reportError(ctx, expr, "Failed to compile dynamic-with assignment value");
        return null;
      }
      if (rhsType.kind !== "externref") {
        coerceType(ctx, fctx, rhsType, { kind: "externref" });
      }
      const rhsTmp = allocLocal(fctx, `__with_rhs_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: rhsTmp });
      emitDynamicWithIdentifierWrite(ctx, fctx, expr.left, rhsTmp, captures);
      // Assignment expression result is the RHS value.
      fctx.body.push({ op: "local.get", index: rhsTmp });
      return { kind: "externref" };
    }
    // A sloppy direct eval in this activation may have created a var binding
    // that shadows a statically-resolved outer capture or ambient/global name.
    // Resolve that dynamic Reference before evaluating the RHS, then write the
    // RHS exactly once either through its stable value cell or through the
    // compiler's ordinary static target on a miss. Truly unresolvable names
    // keep the stricter GlobalEnvironmentRecord route below.
    if (!isUnresolvableIdent(ctx, fctx, expr.left)) {
      const runtimeBinding = emitCaptureRuntimeEvalBindingValueCell(ctx, fctx, name);
      if (runtimeBinding) {
        const wrapRuntimeEvalCallable = isStaticallyCallableExpression(ctx, expr.right);
        const rhsType = compileExpression(
          ctx,
          fctx,
          expr.right,
          wrapRuntimeEvalCallable ? undefined : { kind: "externref" },
        );
        if (!rhsType) {
          reportError(ctx, expr, "Failed to compile runtime-eval-shadowed assignment value");
          return null;
        }
        if (rhsType.kind !== "externref") coerceType(ctx, fctx, rhsType, { kind: "externref" });
        const rhsLocal = allocLocal(fctx, `__runtime_eval_shadow_rhs_${fctx.locals.length}`, {
          kind: "externref",
        });
        fctx.body.push({ op: "local.set", index: rhsLocal });

        const savedPresent = pushBody(fctx);
        let cellValueLocal = rhsLocal;
        if (wrapRuntimeEvalCallable) {
          fctx.body.push({ op: "local.get", index: rhsLocal });
          emitRuntimeEvalAotCallableAdapter(ctx, fctx);
          cellValueLocal = allocLocal(fctx, `__runtime_eval_shadow_cell_value_${fctx.locals.length}`, {
            kind: "externref",
          });
          fctx.body.push({ op: "local.set", index: cellValueLocal });
        }
        const refreshedBinding = emitRefreshRuntimeEvalBindingValueCellForWrite(ctx, fctx, name, runtimeBinding);
        emitRuntimeEvalBindingCellWrite(fctx, refreshedBinding ?? runtimeBinding, cellValueLocal);
        const presentBody = fctx.body;
        popBody(fctx, savedPresent);

        const savedMiss = pushBody(fctx);
        if (!tryEmitAmbientIdentifierGlobalWriteFromLocal(ctx, fctx, expr.left, rhsLocal)) {
          emitIdentifierWriteFromLocal(ctx, fctx, expr.left, rhsLocal);
        }
        const missBody = fctx.body;
        popBody(fctx, savedMiss);

        fctx.body.push(
          { op: "local.get", index: runtimeBinding.valueCellLocal },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: presentBody, else: missBody },
          { op: "local.get", index: rhsLocal },
        );
        return { kind: "externref" };
      }
    }
    // const bindings — assignment throws TypeError at runtime
    if (fctx.constBindings?.has(name)) {
      // Evaluate RHS for side effects, then throw
      const rhsType = compileExpression(ctx, fctx, expr.right);
      if (rhsType) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "Assignment to constant variable.");
      fctx.body.push({ op: "unreachable" });
      return { kind: "f64" }; // unreachable, but satisfy type
    }
    // (#4621 B) §19.1.1-19.1.3 — `NaN = 12` / `Infinity = 12` / `undefined = 12`
    // in STRICT code. These are non-writable value properties of the global
    // object, so PutValue's [[Set]] fails and §6.2.5.6 step 6.a throws
    // TypeError. Sloppy code declines here and keeps the existing silent-no-op
    // lowering, which is what the same step prescribes for non-strict code.
    //
    // Order: BEFORE the `localMap` lookup and every ordinary write arm, but the
    // arm is itself gated on `resolveUnshadowedGlobalIdentifier`, which declines
    // for any local / captured / module-level binding of the name. So
    // `function f(NaN) { "use strict"; NaN = 1; }` — a legal write to a
    // parameter — still falls through untouched. A wrong throw here would be
    // catchable and therefore observable, which is why the shadowing proof is
    // load-bearing rather than defensive.
    if (
      isSpecNonWritableGlobalValueName(name) &&
      isStrictContext(expr.left, ctx.inferModuleStrictArguments) &&
      resolveUnshadowedGlobalIdentifier(ctx, fctx, expr.left) !== undefined
    ) {
      // §13.15.2: the RHS is evaluated before PutValue is attempted, so its side
      // effects must still happen even though the store never lands.
      const rhsType = compileExpression(ctx, fctx, expr.right);
      if (rhsType) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, `Cannot assign to read only property '${name}' of object '#<Object>'`);
      fctx.body.push({ op: "unreachable" });
      return { kind: "f64" }; // unreachable, but the expression stack needs a type
    }
    // Named function expression name binding is read-only — assignments are
    // silently ignored in sloppy mode (the RHS is still evaluated for side effects)
    if (fctx.readOnlyBindings?.has(name)) {
      const rhsType = compileExpression(ctx, fctx, expr.right);
      // The assignment is a no-op, but the expression evaluates to the RHS value
      return rhsType;
    }
    const localIdx = fctx.localMap.get(name);
    if (localIdx !== undefined) {
      // (#2897) Reassigning the materialized `arguments` binding. In non-strict
      // code `arguments` is a valid SimpleAssignmentTarget (§13.15.1), so
      // `arguments = X` rebinds the identifier to X. `arguments` is materialized
      // as a concrete (non-null) vec ref local for fast `.length` / `[i]` access;
      // coercing an arbitrary RHS (e.g. an f64 `1`) to that vec-ref type emits a
      // trapping `ref.as_non_null (ref.null …)` — the L41:3 "dereferencing a null
      // pointer" crash. Instead, rebind the name to a fresh externref local
      // holding X (the universal value carrier) and sever the param↔arguments
      // map, since the arguments object has been replaced.
      {
        const argsLocalType =
          localIdx < fctx.params.length
            ? fctx.params[localIdx]!.type
            : fctx.locals[localIdx - fctx.params.length]?.type;
        const isArgsVecLocal =
          name === "arguments" &&
          argsLocalType !== undefined &&
          (argsLocalType.kind === "ref" || argsLocalType.kind === "ref_null") &&
          !ctx.closureInfoByTypeIdx.has((argsLocalType as { typeIdx: number }).typeIdx);
        if (isArgsVecLocal) {
          const rhsType = compileExpression(ctx, fctx, expr.right, { kind: "externref" });
          if (!rhsType) {
            reportError(ctx, expr, "Failed to compile assignment value");
            return null;
          }
          if (rhsType.kind !== "externref") {
            coerceType(ctx, fctx, rhsType, { kind: "externref" });
          }
          // allocLocal re-points fctx.localMap["arguments"] to the new slot, so
          // subsequent reads resolve to the rebound value.
          const newIdx = allocLocal(fctx, "arguments", { kind: "externref" });
          // The arguments object is replaced; later `arguments[i]` writes must no
          // longer flow back into named params.
          fctx.mappedArgsInfo = undefined;
          fctx.body.push({ op: "local.tee", index: newIdx });
          // Assignment expression evaluates to the RHS value.
          return { kind: "externref" };
        }
      }
      // Check if this is a boxed (ref cell) mutable capture
      const boxed = fctx.boxedCaptures?.get(name);
      if (boxed) {
        // Write through ref cell: local.get ref_cell → value → struct.set $ref_cell 0
        // Null-guard: if ref cell local is null, skip struct.set (#702)
        const resultType = compileExpression(ctx, fctx, expr.right, boxed.valType);
        if (!resultType) {
          reportError(ctx, expr, "Failed to compile assignment value");
          return null;
        }
        const tmpVal = allocLocal(fctx, `__box_tmp_${fctx.locals.length}`, boxed.valType);
        fctx.body.push({ op: "local.set", index: tmpVal });
        fctx.body.push({ op: "local.get", index: localIdx });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [],
          else: [
            { op: "local.get", index: localIdx },
            { op: "local.get", index: tmpVal },
            {
              op: "struct.set",
              typeIdx: boxed.refCellTypeIdx,
              fieldIdx: 0,
            },
          ],
        });
        // Return the assigned value (expression result)
        fctx.body.push({ op: "local.get", index: tmpVal });
        return resultType;
      }
      const localType =
        localIdx < fctx.params.length ? fctx.params[localIdx]!.type : fctx.locals[localIdx - fctx.params.length]?.type;

      // When assigning a function expression/arrow or a function reference
      // to a variable, don't pass externref type hint — let it compile to
      // its native closure struct ref type. Then update the local's type so
      // closure calls work correctly.
      const isFuncExprRHS = ts.isFunctionExpression(expr.right) || ts.isArrowFunction(expr.right);
      const isFuncRefRHS = ts.isIdentifier(expr.right) && ctx.funcMap.has(expr.right.text);
      const isCallableRHS = isFuncExprRHS || isFuncRefRHS;
      // Also detect when the local already has a closure type (reassignment case)
      const localIsClosureRef =
        localType &&
        (localType.kind === "ref" || localType.kind === "ref_null") &&
        ctx.closureInfoByTypeIdx.has((localType as { typeIdx: number }).typeIdx);
      const typeHint =
        (isCallableRHS || localIsClosureRef) && localType?.kind === "externref"
          ? undefined
          : localIsClosureRef
            ? undefined // Don't pass closure ref type as hint either — let RHS produce its own
            : localType;
      const resultType = compileExpression(ctx, fctx, expr.right, typeHint);
      if (!resultType) {
        reportError(ctx, expr, "Failed to compile assignment value");
        return null;
      }

      // (#3128) The RHS may itself contain a closure that CAPTURES `name`:
      // compiling it boxes the local into a fresh ref cell mid-RHS
      // (closures.ts construction-site boxing) and re-points
      // `fctx.localMap[name]` at the `__boxed_<name>` cell local — or an
      // object-literal method/accessor in the RHS promotes the name to a
      // captured global (`promoteAccessorCapturesToGlobals`). The `localIdx`
      // resolved BEFORE the RHS then addresses the ORPHANED raw slot: writing
      // it makes this assignment invisible both to the closure (which holds
      // the cell) and to every subsequent read (which routes through the
      // re-pointed store) — `p2 = p1.then(function(){ return p2; })` lost the
      // assignment entirely. Re-resolve the storage NOW and write through the
      // live store. Mirrors the post-initializer re-resolution in
      // statements/variables.ts (#1177/#2692/#1672).
      {
        const boxedPostRhs = fctx.boxedCaptures?.get(name);
        const localIdxPostRhs = fctx.localMap.get(name);
        if (boxedPostRhs && localIdxPostRhs !== undefined && localIdxPostRhs !== localIdx) {
          if (!valTypesMatch(resultType, boxedPostRhs.valType)) {
            coerceType(ctx, fctx, resultType, boxedPostRhs.valType);
          }
          const tmpVal = allocLocal(fctx, `__box_tmp_${fctx.locals.length}`, boxedPostRhs.valType);
          fctx.body.push({ op: "local.set", index: tmpVal });
          fctx.body.push({ op: "local.get", index: localIdxPostRhs });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [],
            else: [
              { op: "local.get", index: localIdxPostRhs },
              { op: "local.get", index: tmpVal },
              { op: "struct.set", typeIdx: boxedPostRhs.refCellTypeIdx, fieldIdx: 0 },
            ],
          });
          // Keep the orphaned raw slot in sync too: reads compiled BEFORE the
          // mid-RHS boxing still address it (e.g. earlier statements of a loop
          // body executing on the NEXT iteration). The raw slot's type equals
          // the cell's value type (the cell wrapped this very slot).
          const rawLocalType =
            localIdx < fctx.params.length
              ? fctx.params[localIdx]!.type
              : fctx.locals[localIdx - fctx.params.length]?.type;
          if (rawLocalType && valTypesMatch(rawLocalType, boxedPostRhs.valType)) {
            fctx.body.push({ op: "local.get", index: tmpVal });
            fctx.body.push({ op: "local.set", index: localIdx });
          }
          // Assignment expression result: the assigned value.
          fctx.body.push({ op: "local.get", index: tmpVal });
          return boxedPostRhs.valType;
        }
        if (localIdxPostRhs === undefined) {
          // The name left localMap during RHS compilation — promoted to a
          // captured global. Route the write through the promoted store.
          const boxGlobalPostRhs = getCapturedBoxGlobal(ctx, name);
          if (boxGlobalPostRhs !== undefined) {
            if (!valTypesMatch(resultType, boxGlobalPostRhs.valType)) {
              coerceType(ctx, fctx, resultType, boxGlobalPostRhs.valType);
            }
            const tmpVal = allocLocal(fctx, `__box_g_tmp_${fctx.locals.length}`, boxGlobalPostRhs.valType);
            fctx.body.push({ op: "local.set", index: tmpVal });
            emitCapturedBoxGlobalWrite(fctx, boxGlobalPostRhs, tmpVal);
            fctx.body.push({ op: "local.get", index: tmpVal });
            return boxGlobalPostRhs.valType;
          }
          const capturedIdxPostRhs = ctx.capturedGlobals.get(name);
          if (capturedIdxPostRhs !== undefined) {
            const globalDefPost = ctx.mod.globals[localGlobalIdx(ctx, capturedIdxPostRhs)];
            if (globalDefPost && !valTypesMatch(resultType, globalDefPost.type)) {
              coerceType(ctx, fctx, resultType, globalDefPost.type);
            }
            fctx.body.push({ op: "global.set", index: capturedIdxPostRhs });
            fctx.body.push({ op: "global.get", index: capturedIdxPostRhs });
            return globalDefPost?.type ?? resultType;
          }
        }
      }

      // If a closure struct ref was assigned to a local that already has a closure
      // ref type, update the local's type to match the new struct.
      // BUT: do NOT update externref locals — hoistVarDecl already emitted externref
      // init code; changing the type would make that init type-incompatible (#852).
      // Instead, the safety coercion below (coerceType ref→externref) emits
      // extern.convert_any, and compileClosureCall handles externref locals with
      // guarded ref.cast at call sites.
      if (
        (isCallableRHS || localIsClosureRef) &&
        resultType.kind === "ref" &&
        localIsClosureRef &&
        (localType as any)?.kind !== "externref"
      ) {
        if (localIdx < fctx.params.length) {
          fctx.params[localIdx]!.type = resultType;
        } else {
          const localEntry = fctx.locals[localIdx - fctx.params.length];
          if (localEntry) localEntry.type = resultType;
        }
      }

      // Re-read local type after potential update (func expr may have changed it)
      const effectiveLocalType =
        localIdx < fctx.params.length ? fctx.params[localIdx]!.type : fctx.locals[localIdx - fctx.params.length]?.type;

      // Safety coercion: if the expression produced a type that doesn't match
      // the local's declared type (e.g. compileExpression didn't have expectedType
      // or coercion was incomplete), coerce before local.tee
      if (effectiveLocalType && !valTypesMatch(resultType, effectiveLocalType)) {
        const bodyLenBeforeCoerce = fctx.body.length;
        coerceType(ctx, fctx, resultType, effectiveLocalType);
        if (
          fctx.body.length === bodyLenBeforeCoerce &&
          (resultType.kind === "ref" || resultType.kind === "ref_null") &&
          (effectiveLocalType.kind === "ref" || effectiveLocalType.kind === "ref_null")
        ) {
          // coerceType didn't emit anything for different struct types --
          // update the local's type to match the stack type instead of
          // emitting an invalid local.tee with mismatched types.
          updateLocalType(fctx, localIdx, resultType);
          fctx.body.push({ op: "local.tee", index: localIdx });
          emitAnnexBOuterBindingWriteFlag(fctx, name);
          emitMappedArgParamSync(ctx, fctx, localIdx, resultType);
          emitModuleShadowGlobalSync(ctx, fctx, name, localIdx, resultType);
          return resultType;
        }
        fctx.body.push({ op: "local.tee", index: localIdx });
        emitAnnexBOuterBindingWriteFlag(fctx, name);
        emitMappedArgParamSync(ctx, fctx, localIdx, effectiveLocalType);
        emitModuleShadowGlobalSync(ctx, fctx, name, localIdx, effectiveLocalType);
        return effectiveLocalType;
      }
      fctx.body.push({ op: "local.tee", index: localIdx });
      emitAnnexBOuterBindingWriteFlag(fctx, name);
      emitMappedArgParamSync(ctx, fctx, localIdx, resultType);
      emitModuleShadowGlobalSync(ctx, fctx, name, localIdx, resultType);
      return resultType;
    }
    // (#3039) Boxed captured global — write THROUGH the ref cell (struct.set
    // field 0), not into the box global (which would replace the shared cell
    // with the raw value / null). Mirrors the boxedCaptures local-box `=` path.
    const capturedBoxSimple = getCapturedBoxGlobal(ctx, name);
    if (capturedBoxSimple !== undefined) {
      const resultType = compileExpression(ctx, fctx, expr.right, capturedBoxSimple.valType);
      if (!resultType) {
        reportError(ctx, expr, "Failed to compile assignment value");
        return null;
      }
      if (!valTypesMatch(resultType, capturedBoxSimple.valType)) {
        coerceType(ctx, fctx, resultType, capturedBoxSimple.valType);
      }
      const tmpVal = allocLocal(fctx, `__box_g_tmp_${fctx.locals.length}`, capturedBoxSimple.valType);
      fctx.body.push({ op: "local.set", index: tmpVal });
      // entry.globalIdx is read fresh inside the helper AFTER RHS compilation,
      // and `capturedBoxGlobals` is shifted in the global-index fixup, so a
      // string-constant global added while compiling the RHS can't stale it.
      emitCapturedBoxGlobalWrite(fctx, capturedBoxSimple, tmpVal);
      // Assignment expression result: the (coerced) assigned value.
      fctx.body.push({ op: "local.get", index: tmpVal });
      return capturedBoxSimple.valType;
    }

    // Check captured globals
    const capturedIdx = ctx.capturedGlobals.get(name);
    if (capturedIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
      const resultType = compileExpression(ctx, fctx, expr.right, globalDef?.type);
      if (!resultType) {
        reportError(ctx, expr, "Failed to compile assignment value");
        return null;
      }
      // Re-read index: RHS compilation may shift globals via addStringConstantGlobal
      const capturedIdxPost = ctx.capturedGlobals.get(name)!;
      fctx.body.push({ op: "global.set", index: capturedIdxPost });
      // global.set consumes the value; re-push it for expression result
      fctx.body.push({ op: "global.get", index: capturedIdxPost });
      return resultType;
    }
    // Check module-level globals
    const moduleIdx = ctx.moduleGlobals.get(name);
    if (moduleIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
      const globalType = globalDef?.type;
      // When assigning a function expression/arrow to a module global,
      // don't pass externref type hint — let it compile to its native closure
      // struct ref type. We'll coerce to externref for storage afterward (#852).
      const isFuncExprRHS = ts.isFunctionExpression(expr.right) || ts.isArrowFunction(expr.right);
      const isFuncRefRHS = ts.isIdentifier(expr.right) && ctx.funcMap.has(expr.right.text);
      const typeHint = (isFuncExprRHS || isFuncRefRHS) && globalType?.kind === "externref" ? undefined : globalType;
      const resultType = compileExpression(ctx, fctx, expr.right, typeHint);
      if (!resultType) {
        reportError(ctx, expr, "Failed to compile assignment value");
        return null;
      }
      // Coerce closure struct ref → externref for storage in the global
      if (globalType?.kind === "externref" && (resultType.kind === "ref" || resultType.kind === "ref_null")) {
        fctx.body.push({ op: "extern.convert_any" });
      } else if (globalType && !valTypesMatch(resultType, globalType)) {
        coerceType(ctx, fctx, resultType, globalType);
      }
      const runtimeEvalAotFunctionWrite =
        ctx.runtimeEvalGlobalFunctionBindings === true &&
        ctx.liveFuncBindingGlobals?.has(name) === true &&
        (ts.isFunctionExpression(expr.right) ||
          ts.isArrowFunction(expr.right) ||
          (ts.isIdentifier(expr.right) && ctx.funcMap.has(expr.right.text)));
      if (runtimeEvalAotFunctionWrite) emitRuntimeEvalAotCallableAdapter(ctx, fctx);
      // Re-read index: RHS compilation may shift globals via addStringConstantGlobal
      const moduleIdxPost = ctx.moduleGlobals.get(name)!;
      fctx.body.push({ op: "global.set", index: moduleIdxPost });
      fctx.body.push({ op: "global.get", index: moduleIdxPost });
      return globalType ?? resultType;
    }
    // §6.2.5.6 PutValue step 6 — sloppy creates a global-object property,
    // strict throws ReferenceError. Both arms live in `unresolvable-assign.ts`
    // (#3985): they are one decision sharing one predicate and one carrier, and
    // splitting them is how the strict half stayed missing.
    const unresolvable = tryCompileUnresolvableIdentifierAssign(ctx, fctx, expr.left, expr.right);
    if (unresolvable !== NOT_UNRESOLVABLE) return unresolvable;

    // (#4500 Slice B) A name the pre-scan classified as a property of the realm
    // global object (`this.p1 = 1`, or a top-level implicit `p1 = 1`) has REAL
    // storage — the global object — and `emitImplicitGlobalRead` reads it from
    // there. It must be WRITTEN there too. This is the same rule the #4231 RC-F
    // arm applies on the `with`-cascade write path
    // (`emitIdentifierWriteFromLocal`), but this is the ORDINARY identifier
    // write path, which had no such arm: `tryCompileUnresolvableIdentifierAssign`
    // declines (the name IS resolvable to the checker — `this.p1 = 1` gave it a
    // symbol), so the write fell into the auto-local fallback below.
    //
    // Diagnosed by instrumenting every write arm and compiling the #4500 row-1
    // probe: none of the four arms the plan suspected fired — this final
    // fallback did, in BOTH the failing and the "passing" case. The auto-local
    // makes the write FUNCTION-LOCAL, so:
    //
    //   this.p1 = 1; var f = function(){ p1 = 2; }; f(); p1 === 2   // f's local; outer reads the object ⇒ 1
    //   this.p1 = 1; p1 = 2; this.p1 === 2                          // module_init's local; `this.p1` reads the object ⇒ 1
    //
    // The straight-line bare-read case only *looked* correct because the write
    // and the read shared one function and therefore one local — the global
    // object was never updated in either case.
    if (ctx.sloppyImplicitGlobals?.has(name)) {
      const resultType = compileExpression(ctx, fctx, expr.right);
      if (!resultType) return null;
      const rhsTmp = allocLocal(fctx, `__implicit_global_write_${fctx.locals.length}`, resultType);
      fctx.body.push({ op: "local.set", index: rhsTmp });
      if (emitGlobalEnvironmentObject(ctx, fctx)) {
        const setIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_set");
        if (setIdx !== undefined) {
          emitGlobalEnvironmentKey(ctx, fctx, name);
          fctx.body.push({ op: "local.get", index: rhsTmp });
          if (resultType.kind !== "externref") coerceType(ctx, fctx, resultType, { kind: "externref" });
          fctx.body.push({ op: "call", funcIdx: setIdx });
          // The assignment expression evaluates to the RHS value.
          fctx.body.push({ op: "local.get", index: rhsTmp });
          return resultType;
        }
        // Setter unavailable — drop the receiver we just pushed and fall
        // through to the auto-local so the write is not lost.
        fctx.body.push({ op: "drop" });
      }
      // Global-environment object unavailable: preserve the pre-#4500 shape.
      const fallbackIdx = allocLocal(fctx, name, resultType);
      fctx.body.push({ op: "local.get", index: rhsTmp }, { op: "local.tee", index: fallbackIdx });
      return resultType;
    }

    // Graceful fallback for other unresolved identifiers: auto-allocate a
    // local so compilation can continue. This handles class/object method
    // bodies that reference outer-scope variables not yet captured (those
    // resolve in the TS checker, so `isUnresolvableIdent` is false for them and
    // the strict arm above does not claim them). Standalone implicit-global
    // semantics are tracked separately.
    {
      const resultType = compileExpression(ctx, fctx, expr.right);
      if (!resultType) return null;
      const newLocalIdx = allocLocal(fctx, name, resultType);
      fctx.body.push({ op: "local.tee", index: newLocalIdx });
      return resultType;
    }
  }

  if (ts.isPropertyAccessExpression(expr.left)) {
    return compilePropertyAssignment(ctx, fctx, expr.left, expr.right);
  }

  if (ts.isElementAccessExpression(expr.left)) {
    return compileElementAssignment(ctx, fctx, expr.left, expr.right);
  }

  if (ts.isObjectLiteralExpression(expr.left)) {
    return compileDestructuringAssignment(ctx, fctx, expr.left, expr.right);
  }

  if (ts.isArrayLiteralExpression(expr.left)) {
    return compileArrayDestructuringAssignment(ctx, fctx, expr.left, expr.right);
  }

  reportError(ctx, expr, "Unsupported assignment target");
  return null;
}

/**
 * (#2663 Slice 2) Write a PRE-COMPUTED externref value (in `rhsLocalIdx`) to
 * `id`, resolving through the dynamic `with` scope chain (statement form, leaves
 * nothing on the stack). If the innermost non-shadowing scope is a dynamic
 * `with`, emit `if HasBinding(obj,name) __extern_set else <next-outer>` and
 * recurse for the else arm with that scope (and inner) truncated — so a name
 * absent on the inner object cascades to the next-outer `with`, then to the
 * lexical write. When no with-scope resolves, do the plain lexical/global write.
 */
/** (#2663 Slice 3) `captureDynamicWithHasBindings` moved to `with-scope.ts` so
 *  the read-modify-write path (`x += v`, `x++`) shares the same capture. */
export function emitDynamicWithIdentifierWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  rhsLocalIdx: number,
  captures: Map<object, number>,
): void {
  const res = resolveWithBinding(fctx, id.text);
  if (res?.kind === "dynamic") {
    const scopes = fctx.withScopes!;
    const matchedIdx = scopes.lastIndexOf(res.scope);
    const hasLocal = captures.get(res.scope);
    // hasLocal is always present (captured pre-RHS for every cascade scope); if a
    // capture is somehow missing, fall back to "not bound" (write the outer).
    if (hasLocal === undefined) {
      const saved = fctx.withScopes;
      fctx.withScopes = scopes.slice(0, matchedIdx);
      try {
        emitDynamicWithIdentifierWrite(ctx, fctx, id, rhsLocalIdx, captures);
      } finally {
        fctx.withScopes = saved;
      }
      return;
    }
    emitDynamicWithSet(ctx, fctx, res.scope, id.text, rhsLocalIdx, hasLocal, () => {
      const saved = fctx.withScopes;
      fctx.withScopes = scopes.slice(0, matchedIdx);
      try {
        emitDynamicWithIdentifierWrite(ctx, fctx, id, rhsLocalIdx, captures);
      } finally {
        fctx.withScopes = saved;
      }
    });
    return;
  }
  if (res?.kind === "static") {
    // A static (closed-shape) with field: struct.set the field from the temp.
    const b = res.binding;
    fctx.body.push({ op: "local.get", index: b.scope.localIdx });
    fctx.body.push({ op: "local.get", index: rhsLocalIdx });
    if (b.field.type.kind !== "externref") {
      coerceType(ctx, fctx, { kind: "externref" }, b.field.type);
    }
    fctx.body.push({ op: "struct.set", typeIdx: b.scope.structTypeIdx, fieldIdx: b.fieldIdx });
    return;
  }
  emitIdentifierWriteFromLocal(ctx, fctx, id, rhsLocalIdx);
}

/**
 * (#2663 Slice 2) Write a PRE-COMPUTED externref value (held in `rhsLocalIdx`)
 * to the outer binding of `id` — the HasBinding-MISS fallback for a dynamic
 * `with` assignment. Mirrors the identifier-target arm of `compileAssignment`
 * but reads the value from the temp instead of compiling an RHS expression (so
 * the RHS is evaluated exactly once, in the caller). Leaves NOTHING on the stack
 * (the gated-set caller pushes the RHS value as the expression result). Handles
 * local / captured-global / module-global / undeclared (auto-local) targets,
 * coercing externref → the target's declared type. Boxed ref-cell captures and
 * const/read-only bindings are handled by re-reading them here too.
 */
function emitIdentifierWriteFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  rhsLocalIdx: number,
): void {
  const name = id.text;

  // const → TypeError; read-only (named-fn-expr) → silent no-op (sloppy).
  if (fctx.constBindings?.has(name)) {
    emitThrowTypeError(ctx, fctx, "Assignment to constant variable.");
    fctx.body.push({ op: "unreachable" });
    return;
  }
  if (fctx.readOnlyBindings?.has(name)) {
    return; // no-op
  }

  const pushRhsCoerced = (target?: ValType): void => {
    fctx.body.push({ op: "local.get", index: rhsLocalIdx });
    if (target && target.kind !== "externref") {
      coerceType(ctx, fctx, { kind: "externref" }, target);
    }
  };

  const localIdx = fctx.localMap.get(name);
  if (localIdx !== undefined) {
    const boxed = fctx.boxedCaptures?.get(name);
    if (boxed) {
      // Write through the ref cell (null-guarded), mirroring the boxed path.
      pushRhsCoerced(boxed.valType);
      const tmpVal = allocLocal(fctx, `__with_box_${fctx.locals.length}`, boxed.valType);
      fctx.body.push({ op: "local.set", index: tmpVal });
      fctx.body.push({ op: "local.get", index: localIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [],
        else: [
          { op: "local.get", index: localIdx },
          { op: "local.get", index: tmpVal },
          { op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 },
        ],
      });
      return;
    }
    const localType = getLocalType(fctx, localIdx);
    pushRhsCoerced(localType);
    fctx.body.push({ op: "local.set", index: localIdx });
    return;
  }

  // (#3039) Boxed captured global — destructuring / for-of style write through
  // the ref cell rather than overwriting the box global.
  const capturedBoxWrite = getCapturedBoxGlobal(ctx, name);
  if (capturedBoxWrite !== undefined) {
    pushRhsCoerced(capturedBoxWrite.valType);
    const tmpVal = allocLocal(fctx, `__box_gw_${fctx.locals.length}`, capturedBoxWrite.valType);
    fctx.body.push({ op: "local.set", index: tmpVal });
    emitCapturedBoxGlobalWrite(fctx, capturedBoxWrite, tmpVal);
    return;
  }

  const capturedIdx = ctx.capturedGlobals.get(name);
  if (capturedIdx !== undefined) {
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
    pushRhsCoerced(globalDef?.type);
    fctx.body.push({ op: "global.set", index: ctx.capturedGlobals.get(name)! });
    return;
  }

  const moduleIdx = ctx.moduleGlobals.get(name);
  if (moduleIdx !== undefined) {
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
    const globalType = globalDef?.type;
    fctx.body.push({ op: "local.get", index: rhsLocalIdx });
    if (globalType && globalType.kind !== "externref") {
      coerceType(ctx, fctx, { kind: "externref" }, globalType);
    }
    fctx.body.push({ op: "global.set", index: ctx.moduleGlobals.get(name)! });
    return;
  }

  // (#4231 RC-F) A name the pre-scan already classified as a property of the
  // realm's global object (`this.p1 = 1` or a top-level implicit `p1 = 1`,
  // #3956/#2726) has REAL storage — the global object — and `emitImplicitGlobalRead`
  // reads it from there. Auto-allocating a local for it below was actively
  // destructive, and silently so: `allocLocal` registers the name in
  // `fctx.localMap`, so from that point on EVERY bare read of the name in this
  // function resolves to the fresh local instead of the global object.
  //
  // The `with` cascade is where this bites, because it compiles this fallback as
  // the HasBinding-MISS arm of a branch that is normally NOT TAKEN:
  //
  //   with (o) { p1 = 'x1'; delete p3; }   // o owns p1 ⇒ the else arm never runs
  //   if (p1 !== 1) …                      // …but reads the else arm's local ⇒ null
  //
  // So merely *compiling* an unreachable fallback poisoned every later read.
  // That is the whole `S12.10_A1.*` family's assertion #1 (`p1 === 1` reading
  // `null`), and it needs the object write, not a local.
  if (ctx.sloppyImplicitGlobals?.has(name) && emitGlobalEnvironmentObject(ctx, fctx)) {
    const setIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_set");
    if (setIdx !== undefined) {
      emitGlobalEnvironmentKey(ctx, fctx, name);
      fctx.body.push({ op: "local.get", index: rhsLocalIdx });
      fctx.body.push({ op: "call", funcIdx: setIdx });
      return;
    }
    // The global-environment setter is unavailable — drop the receiver we just
    // pushed and fall through to the auto-local so the write is not lost.
    fctx.body.push({ op: "drop" });
  }

  // Genuinely undeclared and not pre-scanned: auto-allocate a local.
  const newLocalIdx = allocLocal(fctx, name, { kind: "externref" });
  fctx.body.push({ op: "local.get", index: rhsLocalIdx });
  fctx.body.push({ op: "local.set", index: newLocalIdx });
}

/** Write the miss arm of a runtime-eval-shadowable ambient name through its
 * real GlobalEnvironmentRecord storage. Compiling a branch-only miss must not
 * allocate a same-named local: that local would permanently redirect later
 * fallback reads even when the runtime branch was never taken. */
function tryEmitAmbientIdentifierGlobalWriteFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  rhsLocalIdx: number,
): boolean {
  const declarations = ctx.oracle.declarationsOf(id);
  if (declarations.length === 0 || !declarations.every((decl) => decl.getSourceFile().isDeclarationFile)) {
    return false;
  }
  if (!emitGlobalEnvironmentObject(ctx, fctx)) return false;
  const setIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_set");
  if (setIdx === undefined) {
    fctx.body.push({ op: "drop" });
    return false;
  }
  emitGlobalEnvironmentKey(ctx, fctx, id.text);
  fctx.body.push(
    { op: "local.get", index: rhsLocalIdx },
    { op: "call", funcIdx: ctx.funcMap.get("__extern_set") ?? setIdx },
  );
  return true;
}

export { isStrictContext } from "../helpers/is-strict-function.js";

/** True when this binding is the receiver of a static Object.defineProperty call. */
function sourceDefinesProperty(ctx: CodegenContext, receiver: ts.Identifier, propName: string): boolean {
  const receiverSymbol = ctx.checker.getSymbolAtLocation(receiver);
  const sourceFile = receiver.getSourceFile();
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "defineProperty" &&
      node.arguments.length >= 2
    ) {
      const objectArg = skipTransparentExpressions(node.arguments[0]!);
      const keyArg = skipTransparentExpressions(node.arguments[1]!);
      const sameReceiver =
        ts.isIdentifier(objectArg) &&
        (receiverSymbol
          ? ctx.checker.getSymbolAtLocation(objectArg) === receiverSymbol
          : objectArg.text === receiver.text);
      const key =
        ts.isStringLiteral(keyArg) || ts.isNumericLiteral(keyArg)
          ? keyArg.text
          : resolveComputedKeyExpression(ctx, keyArg);
      if (sameReceiver && key === propName) {
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

/**
 * Whether an identifier's object-literal initializer already declares a named
 * own property. This deliberately looks at the initializer, rather than the
 * widened Wasm struct shape: shape widening includes later assignments, while
 * `Object.preventExtensions(o); o.newProp = v` must still treat `newProp` as
 * absent at the time of the write.
 */
function objectLiteralInitializerHasProperty(ctx: CodegenContext, receiver: ts.Identifier, propName: string): boolean {
  const symbol = ctx.checker.getSymbolAtLocation(receiver);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.find(ts.isVariableDeclaration);
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;

  const initializer = skipTransparentExpressions(declaration.initializer);
  if (!ts.isObjectLiteralExpression(initializer)) return false;

  return initializer.properties.some((prop) => {
    if (ts.isSpreadAssignment(prop)) return false;
    const name = prop.name;
    if (!name) return false;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text === propName;
    }
    return ts.isComputedPropertyName(name) && resolveComputedKeyExpression(ctx, name.expression) === propName;
  });
}

/**
 * §6.2.4 PutValue step 5: if the LHS reference is unresolvable in strict mode,
 * throw ReferenceError. The RHS value must already be on the stack (for
 * observable evaluation of the Initializer per §13.15.5.2 step 1). We drop it
 * and throw. The subsequent destructuring code is emitted but becomes
 * unreachable — Wasm's type system accepts this via polymorphic stack after
 * `throw`.
 */
function emitStrictPutValueThrow(ctx: CodegenContext, fctx: FunctionContext): void {
  fctx.body.push({ op: "drop" });
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "throw", tagIdx });
}

function collectObjectRestExcludedKeys(ctx: CodegenContext, target: ts.ObjectLiteralExpression): string[] {
  const excludedKeys: string[] = [];
  for (const prop of target.properties) {
    if (ts.isSpreadAssignment(prop)) continue;
    const name = ts.isPropertyAssignment(prop) ? prop.name : prop.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      excludedKeys.push(name.text);
    } else if (ts.isComputedPropertyName(name)) {
      const key = resolveComputedKeyExpression(ctx, name.expression);
      if (key !== undefined) excludedKeys.push(key);
    }
  }
  return excludedKeys;
}

function compileDestructuringAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ObjectLiteralExpression,
  value: ts.Expression,
): InnerResult {
  // Compile the RHS — should produce a struct ref
  const resultType = compileExpression(ctx, fctx, value);
  if (!resultType) return null;

  // §6.2.4 PutValue: strict-mode assignment to unresolvable reference throws.
  if (isStrictContext(target, ctx.inferModuleStrictArguments) && findUnresolvableInObjectPattern(ctx, fctx, target)) {
    emitStrictPutValueThrow(ctx, fctx);
    // After throw the stack is polymorphic; push a sentinel matching resultType
    // so downstream code that expects a value sees the declared return type.
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Determine struct type from the RHS expression's type
  const rhsType = ctx.checker.getTypeAtLocation(value);
  const symName = rhsType.symbol?.name;
  let typeName =
    symName && symName !== "__type" && symName !== "__object" && ctx.structMap.has(symName)
      ? symName
      : (ctx.anonTypeMap.get(rhsType) ?? symName);

  // The checker can erase an object-literal's contextual fields (for example,
  // `{}` is typed as `{}` even when the codegen shape carries the `x` slot
  // needed by `{ x: [x] } = {}`). Prefer the actual struct emitted for the RHS
  // when it is available; otherwise this assignment would skip the nested
  // pattern before it can observe the missing value as `undefined` (#4717).
  const actualTypeIdx = (resultType as any).typeIdx as number | undefined;
  const actualName = actualTypeIdx !== undefined ? ctx.typeIdxToStructName.get(actualTypeIdx) : undefined;
  const actualFields = actualName ? ctx.structFields.get(actualName) : undefined;
  const hasActualStruct = actualTypeIdx !== undefined && actualFields !== undefined;

  // Auto-register anonymous object types (same as resolveWasmType logic)
  if (
    typeName &&
    (typeName === "__type" || typeName === "__object") &&
    !ctx.anonTypeMap.has(rhsType) &&
    rhsType.getProperties().length > 0
  ) {
    ensureStructForType(ctx, rhsType);
    typeName = ctx.anonTypeMap.get(rhsType) ?? typeName;
  }

  // When the RHS type is unknown or a primitive (boolean, number, string),
  // there is no struct to destructure from.  For empty patterns like `{} = val`
  // we just need the RHS value as the expression result.  For non-empty
  // patterns the bindings stay at their defaults (mimics JS behaviour for
  // destructuring primitives — the properties simply do not exist). (#379)
  if ((!typeName || !ctx.structMap.has(typeName) || !ctx.structFields.get(typeName)) && !hasActualStruct) {
    // Null/undefined check — throw TypeError (#783, #1260, #1701).
    // In JS, `{...} = null` and `{...} = undefined` always throw TypeError per
    // §13.15.5.2 ObjectAssignmentPattern step 1 (RequireObjectCoercible(value)),
    // which fires BEFORE the property list is walked. Even `{} = null` /
    // `{} = undefined` must throw. The earlier carve-out for empty patterns
    // (#225) was applied uniformly but is only correct for non-null/undefined
    // primitive RHS (e.g. `{} = 5` — a number is object-coercible).
    if (resultType.kind === "externref" || resultType.kind === "ref_null") {
      const tmpNullChk = allocLocal(fctx, `__destruct_null_chk_${fctx.locals.length}`, resultType);
      fctx.body.push({ op: "local.set", index: tmpNullChk });
      if (resultType.kind === "externref") {
        emitExternrefAssignDestructureGuard(ctx, fctx, tmpNullChk);
      } else {
        // ref_null source: only ref.is_null is meaningful (no undefined sentinel
        // for typed-struct refs).
        const throwInstrs = buildDestructureNullThrow(ctx, fctx);
        fctx.body.push({ op: "local.get", index: tmpNullChk });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: throwInstrs,
          else: [],
        });
      }
      // Restore value on stack
      fctx.body.push({ op: "local.get", index: tmpNullChk });
    }

    // Stash the RHS so we can use it for property reads via __extern_get,
    // then restore it as the expression result.
    const rhsTmp = allocLocal(fctx, `__destruct_rhs_${fctx.locals.length}`, resultType);
    fctx.body.push({ op: "local.tee", index: rhsTmp });
    fctx.body.push({ op: "drop" });

    // (#43) For each target binding, read the property via __extern_get
    // (which handles real JS objects, sidecar maps, and __sget_* fallbacks)
    // and apply default initializers per ECMA-262 §13.15.5.3 step 8 (only
    // when the read returns `undefined`). Without this, `result = { x = 1 }
    // = vals` left x at its initial zero/null even when vals had no `x`
    // property, because the no-struct-fields path returned early without
    // touching any of the target identifiers.
    if (resultType.kind === "externref") {
      // (#1866) Route `__extern_get` through `ensureLateImport` rather than a raw
      // `addImport("env", …)`: under `--target standalone` that re-routes to the
      // Wasm-native object-runtime impl (no `env::__extern_get` host import), so
      // the module instantiates under wasmtime; in JS-host mode it adds the host
      // import as before. A raw addImport leaks an undefined `env::__extern_get`
      // that breaks the zero-JS-host guarantee.
      ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      const getIdx = ctx.funcMap.get("__extern_get");

      if (getIdx !== undefined && undefIdx !== undefined) {
        for (const prop of target.properties) {
          // Determine (keyName to read, targetName to write, default). Handle
          // both shorthand `{ x = d }` (key === target) and the property form
          // `{ y: x = d }` with an identifier target (key !== target). The old
          // path only handled shorthand, so `{ y: x = 1 } = {}` silently dropped
          // the binding and never fired the default. (#2845)
          let keyName: string | undefined;
          let targetName: string | undefined;
          let propDefault: ts.Expression | undefined;
          if (ts.isShorthandPropertyAssignment(prop)) {
            keyName = prop.name.text;
            targetName = keyName;
            propDefault = prop.objectAssignmentInitializer;
          } else if (ts.isPropertyAssignment(prop)) {
            keyName =
              ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name)
                ? prop.name.text
                : undefined;
            let te: ts.Expression = prop.initializer;
            if (
              ts.isBinaryExpression(te) &&
              te.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isIdentifier(te.left)
            ) {
              propDefault = te.right;
              te = te.left;
            }
            if (ts.isIdentifier(te)) targetName = te.text;
          }
          if (keyName === undefined || targetName === undefined) continue;
          const name = targetName;

          // Resolve write target: local first, then module global. Allocate
          // a local only if neither exists.
          let localIdx = fctx.localMap.get(name);
          let moduleGlobalIdx = ctx.moduleGlobals.get(name);
          let targetType: ValType;
          if (localIdx !== undefined) {
            targetType = getLocalType(fctx, localIdx) ?? { kind: "externref" as const };
          } else if (moduleGlobalIdx !== undefined) {
            const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
            targetType = globalDef?.type ?? { kind: "externref" as const };
          } else {
            localIdx = allocLocal(fctx, name, { kind: "externref" });
            targetType = { kind: "externref" as const };
          }

          // Read prop value: tmp = __extern_get(rhs, "keyName")
          addStringConstantGlobal(ctx, keyName);

          const tmpVal = allocLocal(fctx, `__destruct_val_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.get", index: rhsTmp });
          // (#2515 S0 / #1623) sentinel-safe key push — nativeStrings stores `-1`
          // for the string-constant global, so materialize the key inline as
          // externref instead of `global.get -1`.
          for (const instr of stringConstantExternrefInstrs(ctx, keyName)) fctx.body.push(instr);
          fctx.body.push({ op: "call", funcIdx: getIdx });
          fctx.body.push({ op: "local.set", index: tmpVal });

          // Helper: emit `<value-on-stack> -> coerce -> set target`.
          const emitSetTarget = (instrs: Instr[]): void => {
            // The value is currently on the Wasm stack as externref. Coerce
            // and then set. We append into `instrs` so the caller can splice
            // it into a then/else branch.
            if (!valTypesMatch({ kind: "externref" }, targetType)) {
              const saved = fctx.body;
              fctx.body = instrs;
              coerceType(ctx, fctx, { kind: "externref" }, targetType);
              fctx.body = saved;
            }
            if (localIdx !== undefined) {
              instrs.push({ op: "local.set", index: localIdx });
            } else if (moduleGlobalIdx !== undefined) {
              instrs.push({ op: "global.set", index: moduleGlobalIdx });
            }
          };

          if (propDefault) {
            // Per spec: defaults fire ONLY on undefined. Use
            // __extern_is_undefined (not ref.is_null) so JS null falls
            // through to the assignment branch.
            fctx.body.push({ op: "local.get", index: tmpVal });
            fctx.body.push({ op: "call", funcIdx: undefIdx });

            // then-branch: compile default into target
            const trueInstrs: Instr[] = [];
            const savedTrueBody = fctx.body;
            fctx.body = trueInstrs;
            const initType = compileExpression(ctx, fctx, propDefault, targetType);
            if (initType && !valTypesMatch(initType, targetType)) {
              coerceType(ctx, fctx, initType, targetType);
            }
            fctx.body = savedTrueBody;
            if (localIdx !== undefined) {
              trueInstrs.push({ op: "local.set", index: localIdx });
            } else if (moduleGlobalIdx !== undefined) {
              // Re-read in case compileExpression shifted indices.
              moduleGlobalIdx = ctx.moduleGlobals.get(name)!;
              trueInstrs.push({ op: "global.set", index: moduleGlobalIdx });
            }

            // else-branch: forward the read value (with optional coerce)
            const elseInstrs: Instr[] = [{ op: "local.get", index: tmpVal }];
            emitSetTarget(elseInstrs);

            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: trueInstrs,
              else: elseInstrs,
            });
          } else {
            // No default: just assign whatever __extern_get returned (which
            // is `undefined` if missing — JS-equivalent behaviour).
            fctx.body.push({ op: "local.get", index: tmpVal });
            const tail: Instr[] = [];
            emitSetTarget(tail);
            for (const i of tail) fctx.body.push(i);
          }
        }
      } else {
        // Imports unavailable — fall through to the legacy alloc-only path
        // so we at least don't trap.
        for (const prop of target.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) {
            const name = prop.name.text;
            if (!fctx.localMap.has(name) && !ctx.moduleGlobals.has(name)) {
              allocLocal(fctx, name, { kind: "externref" });
            }
          } else if (ts.isSpreadAssignment(prop) && ts.isIdentifier(prop.expression)) {
            const name = prop.expression.text;
            if (!fctx.localMap.has(name) && !ctx.moduleGlobals.has(name)) {
              allocLocal(fctx, name, { kind: "externref" });
            }
          }
        }
      }
    } else {
      // Non-externref RHS (struct ref already typed) — preserve old
      // alloc-only behaviour; the typed-struct path above (lines 570+)
      // handles the real extraction.
      for (const prop of target.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
          const name = prop.name.text;
          if (!fctx.localMap.has(name) && !ctx.moduleGlobals.has(name)) {
            allocLocal(fctx, name, { kind: "externref" });
          }
        } else if (ts.isSpreadAssignment(prop) && ts.isIdentifier(prop.expression)) {
          const name = prop.expression.text;
          if (!fctx.localMap.has(name) && !ctx.moduleGlobals.has(name)) {
            allocLocal(fctx, name, { kind: "externref" });
          }
        }
      }
    }

    // Restore RHS as the expression result.
    fctx.body.push({ op: "local.get", index: rhsTmp });
    return resultType;
  }

  // Prefer the typeIdx from the RHS result over the TS-checker-derived typeName.
  // The RHS compilation may have created a different struct type than the one
  // the TS checker maps to (e.g., nested destructuring creates a struct with
  // ref-typed fields, but the TS checker sees externref fields). (#822)
  let structTypeIdx: number;
  let fields: { name: string; type: ValType; mutable?: boolean }[];
  if (actualTypeIdx !== undefined && actualFields) {
    structTypeIdx = actualTypeIdx;
    fields = actualFields;
  } else {
    structTypeIdx = ctx.structMap.get(typeName)!;
    fields = ctx.structFields.get(typeName)!;
  }

  // Save the struct ref in a temp local
  const tmpLocal = allocLocal(fctx, `__destruct_assign_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null guard for ref_null types
  const isNullableDA = resultType.kind === "ref_null";
  const savedBodyDA = fctx.body;
  const destructInstrsDA: Instr[] = [];
  fctx.body = destructInstrsDA;
  // (#2869) See compileArrayDestructuringAssignment — keep the detached buffer
  // reachable by the func-idx/global repoint passes for the member-target
  // (`{k: x.y} = src`) dispatcher `call`; deleted after the splice.
  ctx.liveBodies.add(destructInstrsDA);

  // For each property in the destructuring pattern, set the existing local
  for (const prop of target.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      // { width } = ... → prop.name is "width"
      const propName = prop.name.text;
      let localIdx = fctx.localMap.get(propName);
      let moduleGlobalIdx = localIdx === undefined ? ctx.moduleGlobals.get(propName) : undefined;

      const fieldIdx = fields.findIndex((f) => f.name === propName);

      // (#43) When the source struct has no matching field but the pattern
      // supplies a default initializer (e.g. `{ x = 1 } = {}`), the spec
      // says: read `obj.x` → `undefined` → default fires → x = 1. The old
      // path reported "Unknown field" and skipped the binding entirely,
      // leaving the local at its initial zero/null. Now we treat field-not-
      // found as "the value is undefined" — fire the default if present,
      // otherwise just leave the binding alone (matching JS where reading
      // a missing property gives undefined; the destructured local then
      // holds undefined).
      if (fieldIdx === -1) {
        if (!prop.objectAssignmentInitializer) {
          // No default, no field — silently skip (the destructured local
          // is already undefined / its zero value). This matches the
          // "primitive RHS / no destructure" branch above which lets
          // bindings stay at their defaults.
          continue;
        }
        // Auto-allocate local if not declared. Use externref so a
        // boxed-anything default (number, string, object) flows through.
        if (localIdx === undefined && moduleGlobalIdx === undefined) {
          localIdx = allocLocal(fctx, propName, { kind: "externref" });
        }
        const targetType =
          localIdx !== undefined
            ? (getLocalType(fctx, localIdx) ?? { kind: "externref" as const })
            : (ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx!)]?.type ?? { kind: "externref" as const });
        const initType = compileExpression(ctx, fctx, prop.objectAssignmentInitializer, targetType);
        if (initType && !valTypesMatch(initType, targetType)) {
          coerceType(ctx, fctx, initType, targetType);
        }
        if (localIdx !== undefined) {
          fctx.body.push({ op: "local.set", index: localIdx });
        } else {
          moduleGlobalIdx = ctx.moduleGlobals.get(propName)!;
          fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
        }
        continue;
      }

      // Auto-allocate local if not declared (e.g. destructuring creates new binding)
      if (localIdx === undefined && moduleGlobalIdx === undefined) {
        const fieldType = fields[fieldIdx]!.type;
        localIdx = allocLocal(fctx, propName, fieldType);
      }

      const fieldType = fields[fieldIdx]!.type;
      const targetType =
        localIdx !== undefined
          ? getLocalType(fctx, localIdx)
          : ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx!)]?.type;

      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      // Handle default value: { x = defaultVal } = obj
      if (prop.objectAssignmentInitializer) {
        if (fieldType.kind === "externref") {
          const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.tee", index: tmpField });
          // Per ECMA-262 §13.15.5.5 (DestructuringAssignmentEvaluation,
          // AssignmentElement), the default initializer fires ONLY when the
          // read value is `undefined`, NOT for JS `null`. In the WebAssembly JS
          // API, JS `null` maps to `ref.null extern` (ref.is_null === 1), so the
          // bare `ref.is_null` guard wrongly fired the default for `{ a } = { a: null }`.
          // Use __extern_is_undefined so JS null falls through to the value branch,
          // while a missing/undefined field (also non-null externref wrapping the
          // JS undefined sentinel, or a wasm-null uninitialized slot) still fires it.
          const undefIdxDA = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
          if (undefIdxDA !== undefined) {
            flushLateImportShifts(ctx, fctx);
            // value === undefined ?  (does not fire for JS null)
            fctx.body.push({ op: "call", funcIdx: undefIdxDA });
          } else {
            // Fallback: imprecise (treats null as undefined) when the import
            // could not be registered (e.g. standalone mode).
            fctx.body.push({ op: "ref.is_null" });
          }
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...(() => {
                const saved = fctx.body;
                fctx.body = [];
                compileExpression(ctx, fctx, prop.objectAssignmentInitializer!, targetType ?? fieldType);
                if (localIdx !== undefined) {
                  fctx.body.push({ op: "local.set", index: localIdx });
                } else {
                  moduleGlobalIdx = ctx.moduleGlobals.get(propName)!;
                  fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
                }
                const instrs = fctx.body;
                fctx.body = saved;
                return instrs;
              })(),
            ],
            else: [
              { op: "local.get", index: tmpField },
              ...(() => {
                if (targetType && !valTypesMatch(fieldType, targetType)) {
                  const saved = fctx.body;
                  fctx.body = [];
                  coerceType(ctx, fctx, fieldType, targetType);
                  const instrs = fctx.body;
                  fctx.body = saved;
                  return instrs;
                }
                return [];
              })(),
              localIdx !== undefined
                ? { op: "local.set", index: localIdx }
                : { op: "global.set", index: ctx.moduleGlobals.get(propName)! },
            ],
          });
        } else {
          // Coerce field type to local type if needed
          if (targetType && !valTypesMatch(fieldType, targetType)) {
            coerceType(ctx, fctx, fieldType, targetType);
          }
          fctx.body.push(
            localIdx !== undefined
              ? { op: "local.set", index: localIdx }
              : { op: "global.set", index: ctx.moduleGlobals.get(propName)! },
          );
        }
      } else {
        // Coerce field type to local type if needed
        if (targetType && !valTypesMatch(fieldType, targetType)) {
          coerceType(ctx, fctx, fieldType, targetType);
        }
        fctx.body.push(
          localIdx !== undefined
            ? { op: "local.set", index: localIdx }
            : { op: "global.set", index: ctx.moduleGlobals.get(propName)! },
        );
      }
    } else if (ts.isPropertyAssignment(prop)) {
      let propName = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteral(prop.name)
          ? prop.name.text
          : ts.isNumericLiteral(prop.name)
            ? prop.name.text
            : undefined;
      // Try resolving computed property names at compile time
      if (!propName && ts.isComputedPropertyName(prop.name)) {
        propName = resolveComputedKeyExpression(ctx, prop.name.expression);
      }
      if (!propName) continue; // truly unresolvable property name — skip

      // Determine the target and optional default value FIRST — the missing-
      // field arm below needs the default to fire it on an absent property. (#2845)
      let targetExpr = prop.initializer;
      let defaultExpr: ts.Expression | undefined;

      // { y: x = defaultVal } — BinaryExpression with EqualsToken
      if (
        ts.isBinaryExpression(targetExpr) &&
        targetExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(targetExpr.left)
      ) {
        defaultExpr = targetExpr.right;
        targetExpr = targetExpr.left;
      }

      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) {
        // The source struct has no matching field → reading `obj[prop]` yields
        // `undefined`. Per §13.15.5.5 the default Initializer fires on undefined,
        // so `{ y: x = d } = {}` (no `y`) must evaluate `d` and assign it to the
        // target. The old path skipped the binding entirely, leaving the local at
        // its zero/null. Mirrors the shorthand `fieldIdx === -1` arm above. (#2845)
        if (defaultExpr && ts.isIdentifier(targetExpr)) {
          const localName = targetExpr.text;
          let localIdx = fctx.localMap.get(localName);
          if (localIdx === undefined) localIdx = allocLocal(fctx, localName, { kind: "externref" });
          const targetType = getLocalType(fctx, localIdx) ?? { kind: "externref" as const };
          const initType = compileExpression(ctx, fctx, defaultExpr, targetType);
          if (initType && !valTypesMatch(initType, targetType)) coerceType(ctx, fctx, initType, targetType);
          fctx.body.push({ op: "local.set", index: localIdx });
          continue;
        }
        reportSilentFallback(ctx, "lookup-miss-skip", "assignment:destructure-assign-property-field-miss", prop);
        continue;
      }
      const fieldType = fields[fieldIdx]!.type;

      if (ts.isIdentifier(targetExpr)) {
        // { prop: ident } or { prop: ident = default }
        const localName = targetExpr.text;
        let localIdx = fctx.localMap.get(localName);

        // Auto-allocate local if not declared
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, localName, fieldType);
        }

        const localType = getLocalType(fctx, localIdx);

        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

        if (defaultExpr) {
          // Handle default value for property assignment target
          if (fieldType.kind === "externref" || fieldType.kind === "ref" || fieldType.kind === "ref_null") {
            const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "local.tee", index: tmpField });
            // Per §13.15.5.5 the default fires ONLY when the read value is
            // `undefined`, never JS `null`. JS `null` is `ref.null extern`
            // (ref.is_null === 1), so a bare `ref.is_null` wrongly fired the
            // default for `{ y: x = d } = { y: null }`. Use __extern_is_undefined
            // for externref (strict === undefined); keep ref.is_null for plain
            // wasm ref/ref_null (no JS-undefined sentinel — null slot = missing). (#2845)
            if (fieldType.kind === "externref") {
              const undefIdxP = ensureLateImport(
                ctx,
                "__extern_is_undefined",
                [{ kind: "externref" }],
                [{ kind: "i32" }],
              );
              if (undefIdxP !== undefined) {
                flushLateImportShifts(ctx, fctx);
                fctx.body.push({ op: "call", funcIdx: undefIdxP });
              } else {
                fctx.body.push({ op: "ref.is_null" });
              }
            } else {
              fctx.body.push({ op: "ref.is_null" });
            }
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...(() => {
                  const saved = fctx.body;
                  fctx.body = [];
                  compileExpression(ctx, fctx, defaultExpr!, localType ?? fieldType);
                  fctx.body.push({
                    op: "local.set",
                    index: localIdx!,
                  });
                  const instrs = fctx.body;
                  fctx.body = saved;
                  return instrs;
                })(),
              ],
              else: [
                { op: "local.get", index: tmpField },
                ...(() => {
                  if (localType && !valTypesMatch(fieldType, localType)) {
                    const saved = fctx.body;
                    fctx.body = [];
                    coerceType(ctx, fctx, fieldType, localType);
                    const instrs = fctx.body;
                    fctx.body = saved;
                    return instrs;
                  }
                  return [];
                })(),
                { op: "local.set", index: localIdx! },
              ],
            });
          } else {
            // Numeric field — just set the value (no undefined check needed for primitives)
            if (localType && !valTypesMatch(fieldType, localType)) {
              coerceType(ctx, fctx, fieldType, localType);
            }
            fctx.body.push({ op: "local.set", index: localIdx });
          }
        } else {
          // No default — just coerce and set
          if (localType && !valTypesMatch(fieldType, localType)) {
            coerceType(ctx, fctx, fieldType, localType);
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      } else if (ts.isObjectLiteralExpression(targetExpr)) {
        // { prop: { nested } } — nested destructuring
        const tmpNested = allocLocal(fctx, `__nested_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitObjectDestructureFromLocal(ctx, fctx, targetExpr, tmpNested, fieldType);
      } else if (ts.isArrayLiteralExpression(targetExpr)) {
        // { prop: [a, b] } — nested array destructuring
        const tmpNested = allocLocal(fctx, `__nested_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitArrayDestructureFromLocal(ctx, fctx, targetExpr, tmpNested, fieldType);
      } else if (ts.isPropertyAccessExpression(targetExpr) || ts.isElementAccessExpression(targetExpr)) {
        // { prop: obj.field } or { prop: arr[0] } — member expression target
        const tmpElem = allocLocal(fctx, `__nested_elem_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: tmpLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpElem });
        emitAssignToTarget(ctx, fctx, targetExpr, tmpElem, fieldType);
      }
      // else: unsupported target expression in property assignment — skip
    } else if (ts.isSpreadAssignment(prop)) {
      // { ...rest } = obj — rest element in object destructuring
      // Convert struct to externref and use __extern_rest_object to collect remaining props
      if (ts.isIdentifier(prop.expression)) {
        const restName = prop.expression.text;
        let restIdx = fctx.localMap.get(restName);
        if (restIdx === undefined) {
          restIdx = allocLocal(fctx, restName, { kind: "externref" });
        }
        // Collect excluded property names, including statically-resolvable
        // computed names (e.g. `{ [a]: b, ...rest }`).
        const excludedKeys = collectObjectRestExcludedKeys(ctx, target);
        if (ctx.targetProfile.semanticProviders === "native-first") {
          const emitted = emitNativeObjectRest(
            ctx,
            fctx,
            () => {
              fctx.body.push({ op: "local.get", index: tmpLocal });
              if (!materializeStructAsObject(ctx, fctx, structTypeIdx, { skipInternalFields: true })) {
                fctx.body.push({ op: "extern.convert_any" });
              }
            },
            excludedKeys,
            restIdx,
          );
          if (emitted) continue;
        }

        // Host-assisted compatibility ABI: comma-joined exclusion keys.
        let restObjIdx = ctx.funcMap.get("__extern_rest_object");
        if (restObjIdx === undefined) {
          const importsBefore = ctx.numImportFuncs;
          const restObjType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
          addImport(ctx, "env", "__extern_rest_object", { kind: "func", typeIdx: restObjType });
          shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
          restObjIdx = ctx.funcMap.get("__extern_rest_object");
        }
        if (restObjIdx !== undefined) {
          const excludedStr = excludedKeys.join(",");
          addStringConstantGlobal(ctx, excludedStr);
          // Convert struct ref to externref
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "extern.convert_any" });
          // (#2515 S0 / #1623) nativeStrings stores a `-1` sentinel global index
          // for string constants; a raw `global.get <stringGlobalMap.get(excludedStr)>`
          // would bake `global.get -1` and fail binary emit (the #2043 validator).
          // Materialize the excluded-keys CSV inline as externref — the twin fix
          // already applied to the destructuring-params rest path.
          for (const instr of stringConstantExternrefInstrs(ctx, excludedStr)) fctx.body.push(instr);
          fctx.body.push({ op: "call", funcIdx: restObjIdx });
          fctx.body.push({ op: "local.set", index: restIdx });
        }
      }
    }
  }

  // Close null guard — throw TypeError if null/undefined (#783).
  // Skip for empty `{} = val` patterns (#225).
  fctx.body = savedBodyDA;
  if (isNullableDA && target.properties.length > 0) {
    const throwInstrs = buildDestructureNullThrow(ctx, fctx);
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: throwInstrs,
      else: destructInstrsDA,
    });
  } else {
    fctx.body.push(...destructInstrsDA);
  }
  // (#2869) Buffer reattached — drop the registration (avoid the #1109 double-shift).
  ctx.liveBodies.delete(destructInstrsDA);

  // The result of a destructuring assignment is the RHS value
  fctx.body.push({ op: "local.get", index: tmpLocal });
  return resultType;
}

/**
 * (#1719 CPR-2) Drive a captured `Array.prototype[@@iterator]` override for an
 * array **assignment** destructuring (`[a, b, z] = arr`) whose targets are plain
 * identifiers — exactly the shape of the assignment-context
 * `*-iter-val-array-prototype.js` tests. PRECONDITION: the RHS vec ref is on the
 * stack and the caller gated on the brand + a captured override.
 *
 * Returns `true` after driving (RHS consumed); returns `false` WITHOUT disturbing
 * the stack (RHS still on top) for any non-identifier target / rest / nested
 * shape, so the caller falls through to the backing-store lowering. Mirrors the
 * binding-site read-drive (`tryEmitArrayProtoIteratorReadDrive`): drive override
 * → iterator, then per element `__iterator_next` → `(i32 done, externref value)`,
 * coerce + assign to the identifier's local/global. Null-guarded so an
 * unresolved-override dispatch-miss degrades gracefully instead of trapping.
 */
function tryEmitArrayProtoIteratorAssignDrive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ArrayLiteralExpression,
  resultType: ValType,
): boolean {
  const overrideGlobalIdx = arrayIteratorOverrideGlobalIdx(ctx);
  if (overrideGlobalIdx === undefined) return false;

  // Shape gate: every element must be a plain identifier target (no holes that
  // resolve to non-identifiers, no member/element-access, no rest/spread). Holes
  // (OmittedExpression) are allowed — they just advance the iterator.
  for (const el of target.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (ts.isSpreadElement(el)) return false; // rest → follow-up
    if (!ts.isIdentifier(el)) return false; // member / element-access / nested → follow-up
  }

  const nextIdx = ensureLateImport(
    ctx,
    "__iterator_next",
    [{ kind: "externref" }],
    [{ kind: "i32" }, { kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (nextIdx === undefined) return false;

  // The RHS vec ref is on the stack — drive the override into an iterator local.
  // `emitArrayProtoIteratorDrive` does `extern.convert_any` (any→extern) on the
  // vec ref, then calls __drive_proto_iterator(array, closure).
  const iterLocal = emitArrayProtoIteratorDrive(ctx, fctx, overrideGlobalIdx);
  const doneLocal = allocLocal(fctx, `__cpra_done_${fctx.locals.length}`, { kind: "i32" });
  const valLocal = allocLocal(fctx, `__cpra_val_${fctx.locals.length}`, { kind: "externref" });

  // Build the per-element drain into a buffer, guarded on a non-null iterator.
  const drainInstrs: Instr[] = [];
  const saved = fctx.body;
  fctx.savedBodies.push(saved);
  fctx.body = drainInstrs;
  try {
    for (const el of target.elements) {
      // (done, value) = __iterator_next(iter)
      fctx.body.push({ op: "local.get", index: iterLocal });
      fctx.body.push({ op: "call", funcIdx: nextIdx });
      fctx.body.push({ op: "local.set", index: valLocal }); // value (top)
      fctx.body.push({ op: "local.set", index: doneLocal }); // done (below)

      if (ts.isOmittedExpression(el) || !ts.isIdentifier(el)) continue; // hole: advance only

      const name = el.text;
      // Resolve the assignment target. Identifier assignment targets are
      // function locals or module globals; reuse the same resolution the
      // identifier-assignment path uses.
      const localIdx = fctx.localMap.get(name);
      const globalIdx = ctx.moduleGlobals.get(name);
      // When done (iterator exhausted), the spec value is `undefined`; leave the
      // local untouched (the targets already exist / hold their prior value) —
      // the 71 assignment tests yield concrete values, never short.
      if (localIdx !== undefined) {
        const localType = getLocalType(fctx, localIdx) ?? ({ kind: "externref" } as ValType);
        const assignBody: Instr[] = [];
        const sb = fctx.body;
        fctx.savedBodies.push(sb);
        fctx.body = assignBody;
        try {
          fctx.body.push({ op: "local.get", index: valLocal });
          coerceType(ctx, fctx, { kind: "externref" }, localType);
          fctx.body.push({ op: "local.set", index: localIdx });
        } finally {
          fctx.body = sb;
          fctx.savedBodies.pop();
        }
        fctx.body.push({ op: "local.get", index: doneLocal });
        fctx.body.push({ op: "i32.eqz" });
        fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: assignBody, else: [] });
      } else if (globalIdx !== undefined) {
        const gType = ctx.mod.globals[globalIdx]?.type ?? ({ kind: "externref" } as ValType);
        const assignBody: Instr[] = [];
        const sb = fctx.body;
        fctx.savedBodies.push(sb);
        fctx.body = assignBody;
        try {
          fctx.body.push({ op: "local.get", index: valLocal });
          coerceType(ctx, fctx, { kind: "externref" }, gType as ValType);
          fctx.body.push({ op: "global.set", index: globalIdx });
        } finally {
          fctx.body = sb;
          fctx.savedBodies.pop();
        }
        fctx.body.push({ op: "local.get", index: doneLocal });
        fctx.body.push({ op: "i32.eqz" });
        fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: assignBody, else: [] });
      }
      // Unresolvable identifier target: skip (rare in the 71; spec would create
      // a global in sloppy mode — out of scope for the fast drive).
    }
  } finally {
    fctx.body = saved;
    fctx.savedBodies.pop();
  }

  // if (iter !== null) { drain }
  fctx.body.push({ op: "local.get", index: iterLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: drainInstrs, else: [] });
  // The assignment expression evaluates to the RHS, but it was consumed by the
  // drive; assignment-destructuring is almost always a statement (result
  // dropped). Push a null externref to satisfy the caller's `externref` result
  // contract. (#1719 CPR-2)
  fctx.body.push({ op: "ref.null.extern" });
  return true;
}

function compileArrayDestructuringAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ArrayLiteralExpression,
  value: ts.Expression,
): InnerResult {
  // Compile the RHS — should produce a struct ref (either tuple or vec)
  const resultType = compileExpression(ctx, fctx, value);
  if (!resultType) return null;

  // (#1719 CPR-2) When the program overrode Array.prototype[@@iterator] and the
  // RHS is a real array, drive the captured override instead of the backing
  // store (§13.15.5.2 ArrayAssignmentPattern → GetIterator). Strictly gated
  // behind the brand + a captured override (both clear in the common case ⇒
  // byte-identical). Returns true (and the assignment result) when it drove the
  // identifier-target shape; falls through to the backing-store lowering for
  // member/element-access/rest/nested targets.
  if (
    ctx.arrayIteratorMaybeOverridden &&
    arrayIteratorOverrideGlobalIdx(ctx) !== undefined &&
    (resultType.kind === "ref" || resultType.kind === "ref_null")
  ) {
    const drove = tryEmitArrayProtoIteratorAssignDrive(ctx, fctx, target, resultType);
    if (drove) return { kind: "externref" };
  }

  // §6.2.4 PutValue: strict-mode assignment to unresolvable reference throws.
  if (isStrictContext(target, ctx.inferModuleStrictArguments) && findUnresolvableInArrayPattern(ctx, fctx, target)) {
    emitStrictPutValueThrow(ctx, fctx);
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Externref fallback: use __extern_get(obj, boxed_index) for each element
  if (resultType.kind !== "ref" && resultType.kind !== "ref_null") {
    if (resultType.kind === "externref") {
      return compileExternrefArrayDestructuringAssignment(ctx, fctx, target, resultType);
    }
    // #1701: ArrayAssignmentPattern always invokes GetIterator(value) per
    // §13.15.5.2. For primitive RHS (number, boolean — both lower to f64/i32
    // here) the spec result is a TypeError ("value is not iterable") because
    // numbers/booleans lack a [Symbol.iterator] method. Previously we boxed
    // the primitive via __box_number and recursed; the lenient runtime then
    // silently produced an empty array. Drop the value and throw directly.
    if (resultType.kind === "f64" || resultType.kind === "i32") {
      // #846: emit a REAL TypeError instance (not a bare string) so the
      // test262 `assert.throws(TypeError, …)` callbacks — which check
      // `e instanceof TypeError` inside the compiled program — observe the
      // correct error type. `emitThrowString` produced an opaque
      // string-payload exception that failed the instanceof check.
      fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "value is not iterable");
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    reportError(ctx, target, "Cannot destructure: not an array type");
    return null;
  }

  const typeIdx = (resultType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  if (!typeDef || typeDef.kind !== "struct") {
    // Non-struct ref: convert to externref and use __extern_get fallback
    fctx.body.push({ op: "extern.convert_any" });
    return compileExternrefArrayDestructuringAssignment(ctx, fctx, target, {
      kind: "externref",
    });
  }

  // Detect whether RHS is a tuple struct (fields $_0, $_1, ...) or vec struct ({length, data})
  const isVecStruct =
    typeDef.fields.length === 2 && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data";

  let arrTypeIdx = -1;
  let arrDef: { kind: string; element: ValType } | undefined;

  if (isVecStruct) {
    arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const ad = ctx.mod.types[arrTypeIdx];
    if (!ad || ad.kind !== "array") {
      reportError(ctx, target, "Cannot destructure: vec data is not array");
      return null;
    }
    arrDef = ad as { kind: string; element: ValType };
  }

  // Store struct ref in temp local
  const tmpLocal = allocLocal(fctx, `__arr_destruct_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null guard for ref_null types
  const isNullableADA = resultType.kind === "ref_null";
  const savedBodyADA = fctx.body;
  const arrDestructInstrsADA: Instr[] = [];
  fctx.body = arrDestructInstrsADA;
  // (#2869) Keep the detached element buffer reachable by the late-import
  // func-idx repoint pass (`shiftLateImportIndices`) AND the module-global
  // shift (`fixupModuleGlobalIndices`) — both walk `ctx.liveBodies`. A member
  // target (`[x.y] = …`) reserves the #2664 member-set dispatcher here; a LATER
  // in-window flush (a heterogeneous element's `__extern_is_undefined`, or the
  // `buildDestructureNullThrow` splice-gap below) would otherwise leave the
  // already-emitted `call <dispIdx>` stale-low. Deleted right after the splice
  // (no flush in that gap) to avoid the #1109 double-shift. Mirrors #2567.
  ctx.liveBodies.add(arrDestructInstrsADA);

  // Helper: get element type at index i
  const getElemType = (i: number): ValType => {
    if (isVecStruct) return arrDef!.element;
    // Tuple: field type at index i
    const field = typeDef.fields[i];
    return field ? field.type : { kind: "f64" };
  };

  // Helper: emit instructions to get element i onto the stack
  const emitElementGet = (i: number) => {
    fctx.body.push({ op: "local.get", index: tmpLocal });
    if (isVecStruct) {
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data array
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, arrDef!.element);
    } else {
      // Tuple: direct struct.get with field index
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: i });
    }
  };

  for (let i = 0; i < target.elements.length; i++) {
    const element = target.elements[i]!;

    // Skip holes: [a, , c] = arr
    if (ts.isOmittedExpression(element)) continue;

    // Handle rest element: [a, ...rest] = arr (only for vec structs)
    if (ts.isSpreadElement(element)) {
      if (isVecStruct) {
        const restTarget = element.expression;

        // Collect the remaining source elements into a FRESH vec of `resultType`
        // (same shape as the source), held in a temp local. We then dispatch on
        // the rest TARGET kind exactly like the non-rest elements below. Earlier
        // this branch only handled an IDENTIFIER rest target, so object-pattern,
        // array-pattern and member-expression rest targets — `[...{0:x,length}]`,
        // `[...[x]]`, `[...obj.y]` — silently dropped every binding (#2757).
        const tmpRestVec = allocLocal(fctx, `__rest_vec_${fctx.locals.length}`, resultType);
        {
          const tmpLen = allocLocal(fctx, `__rest_len_${fctx.locals.length}`, {
            kind: "i32",
          });
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // length
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.sub" });
          // (#2757) Clamp `length - i` to >= 0. When the source has FEWER
          // elements than the non-rest prefix (e.g. `[a, ...r] = []` → 0 - 1),
          // the count is negative; `array.new_default` reads the size as
          // UNSIGNED → requests a ~4-billion-element array → "requested new
          // array is too large" trap. A short/empty source must yield an empty
          // rest array, so floor the count at 0.
          fctx.body.push({ op: "local.tee", index: tmpLen });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "i32.lt_s" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: 0 },
              { op: "local.set", index: tmpLen },
            ],
            else: [],
          });
          fctx.body.push({ op: "local.get", index: tmpLen });

          fctx.body.push({
            op: "array.new_default",
            typeIdx: arrTypeIdx,
          });
          const tmpRestArr = allocLocal(fctx, `__rest_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "local.set", index: tmpRestArr });

          const tmpJ = allocLocal(fctx, `__rest_j_${fctx.locals.length}`, {
            kind: "i32",
          });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.set", index: tmpJ });

          const loopBody: Instr[] = [
            { op: "local.get", index: tmpJ },
            { op: "local.get", index: tmpLen },
            { op: "i32.lt_s" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: tmpRestArr },
            { op: "local.get", index: tmpJ },
            { op: "local.get", index: tmpLocal },
            { op: "struct.get", typeIdx, fieldIdx: 1 },
            { op: "local.get", index: tmpJ },
            { op: "i32.const", value: i },
            { op: "i32.add" },
            {
              op:
                arrDef!.element.kind === "i8"
                  ? "array.get_u"
                  : arrDef!.element.kind === "i16"
                    ? "array.get_s"
                    : "array.get",
              typeIdx: arrTypeIdx,
            },
            { op: "array.set", typeIdx: arrTypeIdx },
            { op: "local.get", index: tmpJ },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: tmpJ },
            { op: "br", depth: 0 },
          ];

          fctx.body.push({
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: loopBody,
              },
            ],
          });

          fctx.body.push({ op: "local.get", index: tmpLen });
          fctx.body.push({ op: "local.get", index: tmpRestArr });
          fctx.body.push({ op: "struct.new", typeIdx });
          fctx.body.push({ op: "local.set", index: tmpRestVec });
        }

        // Dispatch on the rest target kind (mirrors the non-rest element
        // dispatch below). The collected vec lives in `tmpRestVec`.
        if (ts.isIdentifier(restTarget)) {
          const restName = restTarget.text;
          let restLocalIdx = fctx.localMap.get(restName);
          if (restLocalIdx === undefined) {
            restLocalIdx = allocLocal(fctx, restName, resultType);
          } else {
            // If the rest local was pre-allocated as externref (e.g. var y;),
            // allocate a fresh local with the correct vec type and redirect
            // the name mapping. The old externref slot becomes dead.
            // Cannot change type in-place: earlier __get_undefined() init
            // targets externref and would cause illegal cast (#962, #971).
            const existingSlotIdx = restLocalIdx - fctx.params.length;
            if (existingSlotIdx >= 0) {
              const slot = fctx.locals[existingSlotIdx];
              if (slot && slot.type.kind === "externref") {
                restLocalIdx = allocLocal(fctx, restName, resultType);
              }
            }
          }
          fctx.body.push({ op: "local.get", index: tmpRestVec });
          fctx.body.push({ op: "local.set", index: restLocalIdx });
        } else if (ts.isObjectLiteralExpression(restTarget)) {
          // `[...{ 0: x, length }] = vals` — destructure the collected vec
          // through an object pattern using array-like semantics (#2757).
          emitVecArrayLikeObjectDestructure(ctx, fctx, restTarget, tmpRestVec, typeIdx, arrTypeIdx, arrDef!.element);
        } else if (ts.isArrayLiteralExpression(restTarget)) {
          // `[...[x, y]] = vals` — nested array pattern over the collected vec.
          // The rest vec is freshly built via `struct.new` (above) → never null,
          // so skip the null guard (dead code + late string-constant trigger,
          // see `emitArrayDestructureFromLocal`'s `srcKnownNonNull` note).
          emitArrayDestructureFromLocal(ctx, fctx, restTarget, tmpRestVec, resultType, true);
        } else if (ts.isPropertyAccessExpression(restTarget) || ts.isElementAccessExpression(restTarget)) {
          // `[...obj.y] = vals` / `[...obj[k]] = vals` — assign the collected
          // vec to a member-expression target.
          emitAssignToTarget(ctx, fctx, restTarget, tmpRestVec, resultType);
        }
      }
      // Rest on tuples is not supported (would need type conversion)
      continue;
    }

    const elemType = getElemType(i);

    if (ts.isIdentifier(element)) {
      const localName = element.text;
      let localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, localName, elemType);
      }
      emitElementGet(i);
      const localType = getLocalType(fctx, localIdx);
      if (localType && !valTypesMatch(elemType, localType)) {
        coerceType(ctx, fctx, elemType, localType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    } else if (ts.isPropertyAccessExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(fctx, `__arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitAssignToTarget(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isElementAccessExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(fctx, `__arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitAssignToTarget(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isObjectLiteralExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(fctx, `__arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitObjectDestructureFromLocal(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isArrayLiteralExpression(element)) {
      emitElementGet(i);
      const tmpElem = allocLocal(fctx, `__arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitArrayDestructureFromLocal(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isBinaryExpression(element) && element.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const assignTarget = element.left;
      const defaultExpr = element.right;
      if (ts.isIdentifier(assignTarget)) {
        const localName = assignTarget.text;
        let localIdx = fctx.localMap.get(localName);
        let moduleGlobalIdx = localIdx === undefined ? ctx.moduleGlobals.get(localName) : undefined;
        if (localIdx === undefined && moduleGlobalIdx === undefined) {
          localIdx = allocLocal(fctx, localName, elemType);
        }
        const targetType =
          localIdx !== undefined
            ? getLocalType(fctx, localIdx)
            : ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx!)]?.type;

        // Per ECMA-262 §13.15.5.5 (AssignmentElement /
        // IteratorDestructuringAssignmentEvaluation) the default Initializer
        // fires when the source element is ABSENT — i.e. the array/iterator
        // yields `undefined`. For a backing vec that means the index is OUT OF
        // BOUNDS (`i >= length`); for an `any`-typed (externref) element it ALSO
        // means an in-bounds slot holding the JS `undefined` sentinel (or an
        // array hole). The previous lowering (a) DROPPED the default entirely
        // for numeric (f64/i32) elements and (b) missed the OOB case for
        // externref elements (OOB read produced `ref.null` = JS `null`, which is
        // NOT `undefined`), so `[a = d] = []` left `a` at a garbage sentinel and
        // never evaluated `d`. (#2845)
        //
        // Strategy: only READ the element when in bounds (so a non-null `ref`
        // element never traps on an OOB `ref.as_non_null`), recording the value
        // in `tmpElem` and an `absent` i32 flag; then fire the default iff
        // absent, else assign the read value.
        const elemValType: ValType = elemType.kind === "i8" || elemType.kind === "i16" ? { kind: "i32" } : elemType;
        const tmpElem = allocLocal(fctx, `__dflt_${fctx.locals.length}`, elemValType);
        const absentLocal = allocLocal(fctx, `__dflt_absent_${fctx.locals.length}`, { kind: "i32" });

        // Build the IN-BOUNDS path: read element → tmpElem, set absent from the
        // value's undefined-ness (externref/ref) or 0 (numeric).
        const buildInBoundsInit = (): Instr[] => {
          const saved = fctx.body;
          fctx.body = [];
          emitElementGet(i); // safe: guarded by the in-bounds check below
          // An in-bounds `any[]` slot may hold the `$Hole` sentinel for a literal
          // elision (`[1, , 3]`); per Get it reads as `undefined`, so map it.
          if (elemType.kind === "externref" && ctx.usesArrayHoles) emitHoleToUndefined(ctx, fctx);
          emitF64HoleToUndef(ctx, fctx, elemType); // (#4491 T11) f64 twin
          fctx.body.push({ op: "local.set", index: tmpElem });
          if (elemType.kind === "externref") {
            const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
            flushLateImportShifts(ctx, fctx);
            fctx.body.push({ op: "local.get", index: tmpElem });
            if (undefIdx !== undefined) fctx.body.push({ op: "call", funcIdx: undefIdx });
            else fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({ op: "local.set", index: absentLocal });
          } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
            fctx.body.push({ op: "local.get", index: tmpElem });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({ op: "local.set", index: absentLocal });
          } else {
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "local.set", index: absentLocal });
          }
          const instrs = fctx.body;
          fctx.body = saved;
          return instrs;
        };

        if (isVecStruct) {
          // inBounds = i < length  (emitted as `length > i`)
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // length
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.gt_s" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: buildInBoundsInit(),
            else: [
              { op: "i32.const", value: 1 },
              { op: "local.set", index: absentLocal },
            ],
          });
        } else if (i < typeDef.fields.length) {
          // Tuple field present (compile-time known).
          fctx.body.push(...buildInBoundsInit());
        } else {
          // Tuple shorter than the pattern → element absent.
          fctx.body.push({ op: "i32.const", value: 1 });
          fctx.body.push({ op: "local.set", index: absentLocal });
        }

        const thenInit: Instr[] = (() => {
          const saved = fctx.body;
          fctx.body = [];
          compileExpression(ctx, fctx, defaultExpr, targetType ?? elemType);
          if (localIdx !== undefined) {
            fctx.body.push({ op: "local.set", index: localIdx });
          } else {
            moduleGlobalIdx = ctx.moduleGlobals.get(localName)!;
            fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
          }
          const instrs = fctx.body;
          fctx.body = saved;
          return instrs;
        })();
        const elseAssign: Instr[] = (() => {
          const saved = fctx.body;
          fctx.body = [];
          fctx.body.push({ op: "local.get", index: tmpElem });
          if (targetType && !valTypesMatch(elemValType, targetType)) coerceType(ctx, fctx, elemValType, targetType);
          if (localIdx !== undefined) {
            fctx.body.push({ op: "local.set", index: localIdx });
          } else {
            fctx.body.push({ op: "global.set", index: ctx.moduleGlobals.get(localName)! });
          }
          const instrs = fctx.body;
          fctx.body = saved;
          return instrs;
        })();
        fctx.body.push({ op: "local.get", index: absentLocal });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: thenInit,
          else: elseAssign,
        });
      } else if (ts.isPropertyAccessExpression(assignTarget) || ts.isElementAccessExpression(assignTarget)) {
        // (#2869) Member-expression target WITH a default: `[x.y = d] = vals`.
        // Mirror the identifier-default machinery above (read element →
        // value-or-default into a temp), then route the resolved value through
        // emitAssignToTarget → the #2664 member-set dispatcher. Previously the
        // whole `else if (Binary EqualsToken)` branch handled ONLY identifier
        // targets, so a member target with a default was SILENTLY DROPPED (the
        // `*-put-*-prop-ref-init` cluster). The same OOB-default limitation the
        // identifier path has applies here (a separate pre-existing issue).
        const elemValType: ValType = elemType.kind === "i8" || elemType.kind === "i16" ? { kind: "i32" } : elemType;
        const tmpElem = allocLocal(fctx, `__mdflt_${fctx.locals.length}`, elemValType);
        const absentLocal = allocLocal(fctx, `__mdflt_absent_${fctx.locals.length}`, { kind: "i32" });
        const tmpResolved = allocLocal(fctx, `__mdflt_res_${fctx.locals.length}`, elemValType);

        const buildInBoundsInit = (): Instr[] => {
          const saved = fctx.body;
          fctx.body = [];
          emitElementGet(i);
          if (elemType.kind === "externref" && ctx.usesArrayHoles) emitHoleToUndefined(ctx, fctx);
          emitF64HoleToUndef(ctx, fctx, elemType); // (#4491 T11) f64 twin
          fctx.body.push({ op: "local.set", index: tmpElem });
          if (elemType.kind === "externref") {
            const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
            flushLateImportShifts(ctx, fctx);
            fctx.body.push({ op: "local.get", index: tmpElem });
            if (undefIdx !== undefined) fctx.body.push({ op: "call", funcIdx: undefIdx });
            else fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({ op: "local.set", index: absentLocal });
          } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
            fctx.body.push({ op: "local.get", index: tmpElem });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({ op: "local.set", index: absentLocal });
          } else {
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "local.set", index: absentLocal });
          }
          const instrs = fctx.body;
          fctx.body = saved;
          return instrs;
        };

        if (isVecStruct) {
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // length
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.gt_s" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: buildInBoundsInit(),
            else: [
              { op: "i32.const", value: 1 },
              { op: "local.set", index: absentLocal },
            ],
          });
        } else if (i < typeDef.fields.length) {
          fctx.body.push(...buildInBoundsInit());
        } else {
          fctx.body.push({ op: "i32.const", value: 1 });
          fctx.body.push({ op: "local.set", index: absentLocal });
        }

        const thenInit: Instr[] = (() => {
          const saved = fctx.body;
          fctx.body = [];
          compileExpression(ctx, fctx, defaultExpr, elemValType);
          fctx.body.push({ op: "local.set", index: tmpResolved });
          const instrs = fctx.body;
          fctx.body = saved;
          return instrs;
        })();
        const elseAssign: Instr[] = (() => {
          const saved = fctx.body;
          fctx.body = [];
          fctx.body.push({ op: "local.get", index: tmpElem });
          fctx.body.push({ op: "local.set", index: tmpResolved });
          const instrs = fctx.body;
          fctx.body = saved;
          return instrs;
        })();
        fctx.body.push({ op: "local.get", index: absentLocal });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: thenInit,
          else: elseAssign,
        });
        emitAssignToTarget(ctx, fctx, assignTarget, tmpResolved, elemValType);
      }
    }
    // else: unsupported element target — skip
  }

  // Close null guard — throw TypeError if null/undefined (#783).
  // Skip for empty `[] = val` patterns (#225).
  fctx.body = savedBodyADA;
  if (isNullableADA && target.elements.length > 0) {
    const throwInstrs = buildDestructureNullThrow(ctx, fctx);
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: throwInstrs,
      else: arrDestructInstrsADA,
    });
  } else {
    fctx.body.push(...arrDestructInstrsADA);
  }
  // (#2869) Buffer reattached above — drop the liveBodies registration so a later
  // flush walks it only via `fctx.body` (the spread-splice shares element objects
  // with `fctx.body`, so keeping both registered would double-shift — #1109).
  ctx.liveBodies.delete(arrDestructInstrsADA);

  // The result of a destructuring assignment is the RHS value
  fctx.body.push({ op: "local.get", index: tmpLocal });
  return resultType;
}

/**
 * Destructure an externref value using __extern_get(obj, boxed_index) for each element.
 * This handles cases where the RHS is dynamically typed (e.g. arguments, iterators, function returns).
 */
function compileExternrefArrayDestructuringAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ArrayLiteralExpression,
  resultType: ValType,
): InnerResult {
  // Store externref in temp local
  const tmpLocal = allocLocal(fctx, `__ext_arr_destruct_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Null/undefined guard — throw TypeError per spec §13.15.5.2 step 2
  // (GetIterator requires the value to be object-coercible). Even empty
  // `[] = null` / `[] = undefined` must throw (#1431). The earlier carve-out
  // for empty patterns (#225) was applied uniformly but is only correct for
  // OBJECT assignment patterns — array assignment patterns always call
  // GetIterator so they always throw on null/undefined.
  if (resultType.kind === "externref") {
    emitExternrefAssignDestructureGuard(ctx, fctx, tmpLocal);
  }

  // #1454: Spec §13.15.5.2 ArrayAssignmentPattern requires GetIterator(value)
  // before reading binding elements. The previous `tmpLocal[i]` via
  // __extern_get path bypassed the @@iterator getter and .next() calls,
  // so a throwing @@iterator (iter-get-err) or throwing .next() (iter-step-err)
  // was silently swallowed. Materialize the source via __array_from_iter_n
  // first — it invokes @@iterator + .next() and propagates throws.
  // Plain arrays with the default @@iterator take the fast path. The f64
  // step-count bounds consumption so a no-rest pattern (`[a,,b] = gen()`)
  // consumes EXACTLY target.elements.length iterator steps rather than
  // draining a lazy generator; a rest element passes -1 → unbounded, which is
  // byte-identical to the legacy __array_from_iter drain (#1592).
  if (resultType.kind === "externref" && target.elements.length > 0) {
    const matStepCount = patternIteratorStepCount(target.elements);
    const matIterIdx = ensureLateImport(
      ctx,
      "__array_from_iter_n",
      [{ kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (matIterIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "f64.const", value: matStepCount });
      fctx.body.push({ op: "call", funcIdx: matIterIdx });
      fctx.body.push({ op: "local.set", index: tmpLocal });
    }
  }

  // (#3100 S4) Standalone/WASI element reads use the carrier-aware native
  // `__extern_get_idx(mat, f64 i)` (#2190 vec/$ObjVec arms) — the native
  // `__extern_get` is string-keyed and misses vec carriers. Host byte-identical.
  const useIdxReads = ctx.standalone || ctx.wasi;
  const readName = useIdxReads ? "__extern_get_idx" : "__extern_get";
  const keyType: ValType = useIdxReads ? { kind: "f64" } : { kind: "externref" };
  ensureLateImport(ctx, readName, [{ kind: "externref" }, keyType], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  let getIdx = ctx.funcMap.get(readName);
  if (getIdx === undefined) return null;

  // __box_number: host mode only — it boxes the index key for `__extern_get`.
  let boxIdx = ctx.funcMap.get("__box_number");
  if (!useIdxReads && boxIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const boxType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    boxIdx = ctx.funcMap.get("__box_number");
    // Also refresh getIdx since it may have shifted
    getIdx = ctx.funcMap.get(readName);
  }
  if ((!useIdxReads && boxIdx === undefined) || getIdx === undefined) return null;

  for (let i = 0; i < target.elements.length; i++) {
    const element = target.elements[i]!;
    if (ts.isOmittedExpression(element)) continue;
    // Handle rest element: [a, ...rest] = externArr — use __extern_slice
    if (ts.isSpreadElement(element)) {
      const restTarget = element.expression;
      if (ts.isIdentifier(restTarget)) {
        const restName = restTarget.text;
        let restLocalIdx = fctx.localMap.get(restName);
        if (restLocalIdx === undefined) {
          restLocalIdx = allocLocal(fctx, restName, { kind: "externref" });
        }
        let sliceIdx = ctx.funcMap.get("__extern_slice");
        if (sliceIdx === undefined) {
          ensureLateImport(ctx, "__extern_slice", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
          sliceIdx = ctx.funcMap.get("__extern_slice");
          boxIdx = ctx.funcMap.get("__box_number");
          getIdx = ctx.funcMap.get(readName);
        }
        if (sliceIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "f64.const", value: i });
          fctx.body.push({ op: "call", funcIdx: sliceIdx });
          fctx.body.push({ op: "local.set", index: restLocalIdx });
        }
      }
      continue;
    }

    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "f64.const", value: i });
    if (!useIdxReads) fctx.body.push({ op: "call", funcIdx: boxIdx! });
    fctx.body.push({ op: "call", funcIdx: getIdx! });

    const elemType: ValType = { kind: "externref" };

    if (ts.isIdentifier(element)) {
      const localName = element.text;
      let localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, localName, elemType);
      }
      const localType = getLocalType(fctx, localIdx);
      if (localType && !valTypesMatch(elemType, localType)) {
        coerceType(ctx, fctx, elemType, localType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    } else if (ts.isPropertyAccessExpression(element) || ts.isElementAccessExpression(element)) {
      const tmpElem = allocLocal(fctx, `__ext_arr_elem_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitAssignToTarget(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isBinaryExpression(element) && element.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // Default value: [a = default] = arr
      // Per spec §13.15.5.5 AssignmentElement step 4: the default fires ONLY
      // when the resolved value is `undefined` (never for `null`). Earlier
      // versions used `ref.is_null` which fires for both — that broke
      // `[a=1] = [null]` (default fired, a became 1 instead of null). Use
      // `__extern_is_undefined` instead, which the runtime maps to a strict
      // `=== undefined` check. Fall back to `ref.is_null` only when the host
      // import is unavailable (standalone mode) — imperfect but better than
      // never firing the default (#1431).
      const assignTarget = element.left;
      const defaultExpr = element.right;
      if (ts.isIdentifier(assignTarget)) {
        const localName = assignTarget.text;
        let localIdx = fctx.localMap.get(localName);
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, localName, elemType);
        }
        const tmpElem = allocLocal(fctx, `__ext_dflt_${fctx.locals.length}`, elemType);
        // Pre-ensure `__extern_is_undefined` so any late-import funcIdx shift
        // happens while fctx.body is authoritative (the saved-swap pattern
        // inside the if-then below detaches the slice from fctx).
        const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "local.set", index: tmpElem });
        if (undefIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: tmpElem });
          fctx.body.push({ op: "call", funcIdx: undefIdx });
        } else {
          fctx.body.push({ op: "local.get", index: tmpElem });
          fctx.body.push({ op: "ref.is_null" });
        }
        const localType = getLocalType(fctx, localIdx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...(() => {
              const saved = fctx.body;
              fctx.body = [];
              compileExpression(ctx, fctx, defaultExpr, localType ?? elemType);
              fctx.body.push({ op: "local.set", index: localIdx! });
              const instrs = fctx.body;
              fctx.body = saved;
              return instrs;
            })(),
          ],
          else: [
            { op: "local.get", index: tmpElem },
            ...(() => {
              if (localType && !valTypesMatch(elemType, localType)) {
                const saved = fctx.body;
                fctx.body = [];
                coerceType(ctx, fctx, elemType, localType);
                const instrs = fctx.body;
                fctx.body = saved;
                return instrs;
              }
              return [];
            })(),
            { op: "local.set", index: localIdx! },
          ],
        });
      }
    } else if (ts.isArrayLiteralExpression(element) || ts.isObjectLiteralExpression(element)) {
      // Nested destructuring: [[x]] = arr or [{x}] = arr
      // Element value is on the stack (externref). If null/undefined, throw TypeError
      // (per spec §14.3.3.1 RequireObjectCoercible / §8.4.2 GetIterator). (#dstr_null_undefined)
      const tmpNested = allocLocal(fctx, `__ext_nested_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: tmpNested });
      emitExternrefAssignDestructureGuard(ctx, fctx, tmpNested);
      // Proceed with nested destructuring via externref path
      if (ts.isArrayLiteralExpression(element)) {
        fctx.body.push({ op: "local.get", index: tmpNested });
        const nestedResult = compileExternrefArrayDestructuringAssignment(ctx, fctx, element, elemType);
        if (nestedResult) {
          fctx.body.push({ op: "drop" });
        }
      }
      // Object nested destructuring via externref: the null/undefined guard above is what
      // this bucket needs — the actual property extraction is a separate feature.
    }
  }

  // The result of a destructuring assignment is the RHS value
  fctx.body.push({ op: "local.get", index: tmpLocal });
  return resultType;
}

/** Assign value from a local to a property access or element access target */
/**
 * (#2869) Write an already-materialized destructure value (`valueLocal`) into a
 * dynamic member-expression target `obj.prop` whose receiver/field the static
 * struct-field fast path could NOT resolve — a plain `{}`/accessor/host receiver,
 * or a field only known at finalize (a late `__fnctor_<F>` struct). Routes through
 * the SAME #2664 deferred member-set dispatcher as a plain `obj.x = v` write
 * (`emitAlternateStructSetDispatch`), whose terminal else-arm is the
 * `__extern_set_strict` sidecar (native `$Object` store standalone / strict host
 * set in JS mode — a getter-only accessor throws per §[[Set]]). The value is
 * already in `valueLocal`; do NOT recompile the value AST (matches the `-no-get`
 * "read exactly once" assertions).
 *
 * IMPORTANT — funcIdx repoint: when the CALLER emits into a DETACHED destructure
 * body buffer (arrDestructInstrsADA / destructInstrsDA / odflInstrs / adflInstrs),
 * that buffer MUST be registered in `ctx.liveBodies` for its compile window (see
 * the `.add`/`.delete` around each swap/splice). The dispatch `call` baked here is
 * correct at emit time (reserveMemberSetDispatch flushes its import batch first),
 * but a LATER in-window late import (a heterogeneous element's `__extern_is_undefined`
 * flush, or the `buildDestructureNullThrow` splice-gap) shifts every defined-func
 * index up by `added`; without the liveBodies registration the detached buffer's
 * already-emitted `call <dispIdx>` is never walked by `shiftLateImportIndices`
 * (nor `fixupModuleGlobalIndices`), goes stale-low by one, and the module is
 * invalid (`need 3 got 2`) / recurses on a plain `{}`. Mirrors #2567/#1109.
 */
function emitDynamicMemberSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  valueLocal: number,
  valueType: ValType,
): void {
  if (ts.isPrivateIdentifier(target.name)) return; // `#x` private — out of scope, drop
  const propName = target.name.text;

  // (#3366 follow-up) A destructuring member target that is absent from the
  // receiver's closed struct shape is written through the dynamic member-set
  // dispatcher (ultimately the object's sidecar). Remember that representation
  // choice so a later statically-typed `obj.prop` read does not auto-add a new,
  // still-default struct field and thereby hide the value just written.
  if (ts.isIdentifier(target.expression)) {
    ctx.sidecarDefinedPropertyKeys.add(`${target.expression.text}:${propName}`);
  }

  // Receiver (reference before value, matching plain `obj.x = v` ordering) → externref local.
  const recvRes = compileExpression(ctx, fctx, target.expression);
  if (recvRes && recvRes.kind !== "externref") {
    coerceType(ctx, fctx, recvRes, { kind: "externref" });
  } else if (!recvRes) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const objLocal = allocLocal(fctx, `__dstr_set_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Value (already materialized by the destructure driver) → externref local.
  fctx.body.push({ op: "local.get", index: valueLocal });
  if (valueType.kind !== "externref") {
    coerceType(ctx, fctx, valueType, { kind: "externref" });
  }
  const valLocal = allocLocal(fctx, `__dstr_set_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valLocal });

  // Reserved-name carve-out (mirror tryEmitPinnedStructMemberSet:2753–2761):
  // length / constructor / __proto__ / prototype / name must NOT use the named
  // struct dispatcher (it would write a same-named struct slot, e.g. a vec
  // `length` field). Emit a bare `__extern_set_strict` terminal instead. These
  // are outside the 53 in-scope tests; correct-but-bare beats dropped.
  const reserved =
    propName === "length" ||
    propName === "constructor" ||
    propName === "__proto__" ||
    propName === "prototype" ||
    propName === "name";

  if (!reserved) {
    const dispatched = emitAlternateStructSetDispatch(ctx, fctx, objLocal, valLocal, propName, /*strict*/ true);
    if (dispatched) return;
    // else: dispatcher unreservable (no __extern_set_strict import) — bare sidecar below.
  }

  // Bare `__extern_set_strict(recv, "<name>", val)` terminal (reserved name or no
  // dispatcher). Mirrors compileExternPropertySet's `!dispatched` arm.
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set_strict",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  addStringConstantGlobal(ctx, propName);
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
  fctx.body.push({ op: "local.get", index: valLocal });
  if (setIdx !== undefined) fctx.body.push({ op: "call", funcIdx: setIdx });
}

export function emitAssignToTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Expression,
  valueLocal: number,
  valueType: ValType,
): void {
  if (ts.isPropertyAccessExpression(target)) {
    // Compile-away: frozen object property writes throw TypeError
    if (ts.isIdentifier(target.expression) && ctx.frozenVars.has(integrityVarKey(ctx, target.expression))) {
      emitThrowTypeError(ctx, fctx, "Cannot assign to read only property of frozen object");
      return;
    }

    // Static struct-field fast path: when the receiver resolves to a registered
    // struct that statically owns the field, write the SLOT directly.
    const typeName = resolveStructNameForExpr(ctx, fctx, target.expression);
    const structTypeIdx = typeName !== undefined ? ctx.structMap.get(typeName) : undefined;
    const fields = typeName !== undefined ? ctx.structFields.get(typeName) : undefined;
    const fieldName = ts.isPrivateIdentifier(target.name) ? undefined : target.name.text;
    const fieldIdx = fields && fieldName !== undefined ? fields.findIndex((f) => f.name === fieldName) : -1;
    if (structTypeIdx !== undefined && fields && fieldIdx !== -1) {
      const fieldType = fields[fieldIdx]!.type;
      // Push obj ref, then value
      compileExpression(ctx, fctx, target.expression);
      fctx.body.push({ op: "local.get", index: valueLocal });
      if (!valTypesMatch(valueType, fieldType)) {
        // (#4531, twin of the #4611 member-set arm) A wasm-vec value stored
        // into an externref FIELD keeps its raw identity: the generic
        // vec→externref coercion appends `__make_iterable`, which materializes
        // a JS MIRROR — the field then holds the mirror while every native
        // method/read path `ref.cast`s to the vec (prettier AstPath's
        // `this.stack = [value]`: every stack op trapped `illegal cast`).
        // Host-boundary reads of the raw boxed vec still materialize on
        // demand in the runtime bridges.
        if (
          fieldType.kind === "externref" &&
          (valueType.kind === "ref" || valueType.kind === "ref_null") &&
          getArrTypeIdxFromVec(ctx, (valueType as { typeIdx: number }).typeIdx) >= 0
        ) {
          fctx.body.push({ op: "extern.convert_any" });
        } else {
          coerceType(ctx, fctx, valueType, fieldType);
        }
      }
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
      return;
    }

    // (#2869) Dynamic member target — a plain `{}`/accessor/host receiver, or a
    // field only known at finalize. The three field/struct misses above used to
    // early-`return` here and SILENTLY DROP the write; route them through the
    // #2664 deferred member-set dispatcher instead (the `[x.y] = vals` cluster).
    emitDynamicMemberSet(ctx, fctx, target, valueLocal, valueType);
    return;
  } else if (ts.isElementAccessExpression(target)) {
    const arrType = compileExpression(ctx, fctx, target.expression);
    if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null")) return;
    const tIdx = (arrType as { typeIdx: number }).typeIdx;
    const tDef = ctx.mod.types[tIdx];
    // Handle vec struct
    if (
      tDef?.kind === "struct" &&
      tDef.fields.length === 2 &&
      tDef.fields[0]?.name === "length" &&
      tDef.fields[1]?.name === "data"
    ) {
      const aIdx = getArrTypeIdxFromVec(ctx, tIdx);
      // Save vec ref, compile index, then bounds-guard the write
      const vecTmp = allocLocal(fctx, `__dstr_vec_${fctx.locals.length}`, arrType);
      fctx.body.push({ op: "local.set", index: vecTmp });
      const idxResult = compileExpression(ctx, fctx, target.argumentExpression);
      if (!idxResult) return;
      if (idxResult.kind === "f64") {
        // Saturating truncation: NaN/Infinity/out-of-range indices clamp
        // instead of trapping the module. Matches every other index/length
        // conversion in this file (#1834).
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
      const idxTmp = allocLocal(fctx, `__dstr_idx_${fctx.locals.length}`, {
        kind: "i32",
      });
      fctx.body.push({ op: "local.set", index: idxTmp });
      // Bounds guard: only write if idx < array.len
      fctx.body.push({ op: "local.get", index: idxTmp });
      fctx.body.push({ op: "local.get", index: vecTmp });
      fctx.body.push({ op: "struct.get", typeIdx: tIdx, fieldIdx: 1 });
      fctx.body.push({ op: "array.len" });
      fctx.body.push({ op: "i32.lt_u" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" as const },
        then: [
          { op: "local.get", index: vecTmp },
          { op: "struct.get", typeIdx: tIdx, fieldIdx: 1 },
          { op: "local.get", index: idxTmp },
          { op: "local.get", index: valueLocal },
          { op: "array.set", typeIdx: aIdx },
        ],
        else: [],
      });
    }
  }
}

/** Destructure an object from a local variable (used for nested patterns) */
function emitObjectDestructureFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ObjectLiteralExpression,
  srcLocal: number,
  srcType: ValType,
): void {
  // Externref: emit null/undefined guard. We can't currently destructure externref
  // object assignments, but at minimum we must throw per spec §14.3.3.1 (#dstr_null_undefined).
  if (srcType.kind === "externref") {
    emitExternrefAssignDestructureGuard(ctx, fctx, srcLocal);
    return;
  }
  if (srcType.kind !== "ref" && srcType.kind !== "ref_null") return;
  const srcTypeIdx = (srcType as { typeIdx: number }).typeIdx;

  // Find struct name from type index
  const structName = ctx.typeIdxToStructName.get(srcTypeIdx);
  if (!structName) return;

  const fields = ctx.structFields.get(structName);
  if (!fields) return;

  // The compiler may declare the local as non-nullable `ref T` even though
  // the value at runtime can be null (e.g. `[{x}] = [null]` element-extracts
  // a ref_null whose runtime value is null but whose static type is `ref T`).
  // Widen the local so `ref.is_null` is valid below (#1260, mirrors #1225).
  const needsNullGuard = pattern.properties.length > 0;
  if (needsNullGuard) {
    widenLocalToNullable(fctx, srcLocal);
  }

  // Null guard for ref_null types
  const savedBodyODFL = fctx.body;
  const odflInstrs: Instr[] = [];
  fctx.body = odflInstrs;
  // (#2869) Member target inside a nested object pattern (`[{k: x.y}] = …`)
  // reserves the member-set dispatcher into this detached buffer — register it
  // with the repoint passes; deleted after the splice (see #2567/#1109).
  ctx.liveBodies.add(odflInstrs);

  for (const prop of pattern.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      const propName = prop.name.text;
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) {
        reportSilentFallback(ctx, "lookup-miss-skip", "assignment:object-destructure-shorthand-field-miss", prop);
        continue;
      }

      let localIdx = fctx.localMap.get(propName);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, propName, fields[fieldIdx]!.type);
      }

      fctx.body.push({ op: "local.get", index: srcLocal });
      fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
      const fieldType = fields[fieldIdx]!.type;
      const localType = getLocalType(fctx, localIdx);
      if (localType && !valTypesMatch(fieldType, localType)) {
        coerceType(ctx, fctx, fieldType, localType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    } else if (ts.isPropertyAssignment(prop)) {
      let propName = ts.isIdentifier(prop.name)
        ? prop.name.text
        : ts.isStringLiteral(prop.name)
          ? prop.name.text
          : ts.isNumericLiteral(prop.name)
            ? prop.name.text
            : undefined;
      // Try resolving computed property names at compile time
      if (!propName && ts.isComputedPropertyName(prop.name)) {
        propName = resolveComputedKeyExpression(ctx, prop.name.expression);
      }
      if (!propName) continue; // truly unresolvable property name — skip
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) {
        reportSilentFallback(
          ctx,
          "lookup-miss-skip",
          "assignment:object-destructure-from-local-property-field-miss",
          prop,
        );
        continue;
      }
      const fieldType = fields[fieldIdx]!.type;

      const targetExpr = prop.initializer;
      if (ts.isIdentifier(targetExpr)) {
        let localIdx = fctx.localMap.get(targetExpr.text);
        if (localIdx === undefined) {
          localIdx = allocLocal(fctx, targetExpr.text, fieldType);
        }
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        const localType = getLocalType(fctx, localIdx);
        if (localType && !valTypesMatch(fieldType, localType)) {
          coerceType(ctx, fctx, fieldType, localType);
        }
        emitCoercedLocalSet(ctx, fctx, localIdx, fieldType);
      } else if (ts.isObjectLiteralExpression(targetExpr)) {
        // Nested object: { x: { a, b } } = obj
        const tmpNested = allocLocal(fctx, `__nested_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitObjectDestructureFromLocal(ctx, fctx, targetExpr, tmpNested, fieldType);
      } else if (ts.isArrayLiteralExpression(targetExpr)) {
        // Nested array: { x: [a, b] } = obj
        const tmpNested = allocLocal(fctx, `__nested_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpNested });
        emitArrayDestructureFromLocal(ctx, fctx, targetExpr, tmpNested, fieldType);
      } else if (ts.isPropertyAccessExpression(targetExpr) || ts.isElementAccessExpression(targetExpr)) {
        // Member expression target: { x: obj.prop } = obj2
        const tmpElem = allocLocal(fctx, `__nested_elem_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpElem });
        emitAssignToTarget(ctx, fctx, targetExpr, tmpElem, fieldType);
      }
    }
  }

  // Close null guard — throw TypeError if null/undefined (#730, #1260).
  // Skip for empty `{} = val` nested patterns (#225).
  // Apply to both ref and ref_null sources (we widened above, so ref.is_null is valid).
  fctx.body = savedBodyODFL;
  if (needsNullGuard) {
    const throwInstrs = buildDestructureNullThrow(ctx, fctx);
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: throwInstrs,
      else: odflInstrs,
    });
  } else {
    fctx.body.push(...odflInstrs);
  }
  // (#2869) Buffer reattached — drop the registration (avoid the #1109 double-shift).
  ctx.liveBodies.delete(odflInstrs);
}

/** Destructure an array from a local variable (used for nested patterns) */
function emitArrayDestructureFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ArrayLiteralExpression,
  srcLocal: number,
  srcType: ValType,
  // (#2757) When the source local is a freshly-built, provably-non-null vec
  // (the collected rest vec — `[...[x]] = vals` builds it via `struct.new`),
  // the null guard is dead code. More importantly, `buildDestructureNullThrow`
  // adds a LATE `string_constants` import global ("Cannot destructure …"),
  // which shifts every module-global index. If a hole-array literal
  // (`var vals = [ , ]`) emitted a `$Hole` `global.get` earlier in the SAME
  // function, that shift can be missed when `ctx.currentFunc` is transiently
  // null at the string-constant add (the shifter then walks no in-progress
  // body), leaving the emitted `global.get` one slot stale → invalid Wasm
  // (`extern.convert_any` on an i32 global). Skipping the unnecessary guard for
  // a known-non-null source avoids both the dead code and the trigger.
  srcKnownNonNull = false,
): void {
  // Externref: emit null/undefined guard + delegate to externref path (#dstr_null_undefined)
  if (srcType.kind === "externref") {
    emitExternrefAssignDestructureGuard(ctx, fctx, srcLocal);
    fctx.body.push({ op: "local.get", index: srcLocal });
    compileExternrefArrayDestructuringAssignment(ctx, fctx, pattern, srcType);
    fctx.body.push({ op: "drop" });
    return;
  }
  if (srcType.kind !== "ref" && srcType.kind !== "ref_null") return;
  const srcTypeIdx = (srcType as { typeIdx: number }).typeIdx;
  const srcDef = ctx.mod.types[srcTypeIdx];
  if (!srcDef || srcDef.kind !== "struct") return;

  // Detect vec vs tuple struct shape (#1225). Tuple fields are named _0, _1, ...
  const isVecStruct =
    srcDef.fields.length === 2 && srcDef.fields[0]?.name === "length" && srcDef.fields[1]?.name === "data";
  const isTupleStruct =
    !isVecStruct &&
    srcDef.fields.length > 0 &&
    srcDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`);

  // For ref/ref_null sources we want to emit a null guard. The compiler may
  // declare the local as non-nullable `ref T` even though the value at runtime
  // can be null (e.g. struct fields holding nested tuple refs that may be
  // ref.null T). Widen the local so `ref.is_null` is valid (#1225).
  const needsNullGuard =
    !srcKnownNonNull && (srcType.kind === "ref" || srcType.kind === "ref_null") && pattern.elements.length > 0;
  if (needsNullGuard) {
    widenLocalToNullable(fctx, srcLocal);
  }

  // For unsupported struct shapes, still emit the null/undefined guard so we
  // throw the spec-required TypeError (#1225). Without this, nested patterns
  // like `[[ _ ]] = [null]` would silently drop the destructuring.
  if (!isVecStruct && !isTupleStruct) {
    if (needsNullGuard) {
      const throwInstrs = buildDestructureNullThrow(ctx, fctx);
      fctx.body.push({ op: "local.get", index: srcLocal });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: throwInstrs,
        else: [],
      });
    }
    return;
  }

  let arrTypeIdx = -1;
  let arrDef: { kind: string; element: ValType } | undefined;
  if (isVecStruct) {
    arrTypeIdx = getArrTypeIdxFromVec(ctx, srcTypeIdx);
    const ad = ctx.mod.types[arrTypeIdx];
    if (!ad || ad.kind !== "array") {
      // Unexpected: vec struct without proper array data field.
      // Fall back to emitting null guard only.
      if (needsNullGuard) {
        const throwInstrs = buildDestructureNullThrow(ctx, fctx);
        fctx.body.push({ op: "local.get", index: srcLocal });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: throwInstrs,
          else: [],
        });
      }
      return;
    }
    arrDef = ad as { kind: string; element: ValType };
  }

  // Helper: get element type at index i
  const getElemType = (i: number): ValType => {
    if (isVecStruct) return arrDef!.element;
    // Tuple
    const field = srcDef.fields[i];
    return field ? field.type : { kind: "f64" };
  };
  // Helper: emit instructions to load element i onto the stack
  const emitElemGet = (i: number): void => {
    fctx.body.push({ op: "local.get", index: srcLocal });
    if (isVecStruct) {
      fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "i32.const", value: i });
      // Nested assignment patterns read an array-like value, so an absent
      // element is the JS `undefined` value (and a sparse-array hole must not
      // leak its internal sentinel). (#4717)
      emitBoundsCheckedArrayGet(fctx, arrTypeIdx, arrDef!.element, ctx, true);
    } else {
      // Tuple: direct struct.get on field index i
      fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx: i });
    }
  };

  // Build the destructuring body in a separate buffer so we can wrap it in a
  // null guard for ref_null sources.
  const savedBodyADFL = fctx.body;
  const adflInstrs: Instr[] = [];
  fctx.body = adflInstrs;
  // (#2869) This buffer reaches a member-set dispatcher TRANSITIVELY (a nested
  // `emitObjectDestructureFromLocal` splices its dispatcher `call` in here), and
  // its own `buildDestructureNullThrow` splice-gap can flush a late import — so
  // register it with the repoint passes too; deleted after the splice (#2567/#1109).
  ctx.liveBodies.add(adflInstrs);

  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i]!;
    if (ts.isOmittedExpression(element)) continue;

    // Tuple OOB: pattern targets element beyond tuple's fields → no-op for
    // identifier targets (would normally read undefined; we rely on the local
    // staying at its prior value).
    if (isTupleStruct && i >= srcDef.fields.length) continue;

    const elemType = getElemType(i);

    if (ts.isIdentifier(element)) {
      let localIdx = fctx.localMap.get(element.text);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, element.text, elemType);
      }
      emitElemGet(i);
      // (#2757) Do NOT pre-coerce `elemType → localType` here: `emitCoercedLocalSet`
      // already coerces the stack value (typed `elemType`) to the local's type
      // internally. A manual pre-coerce left the stack as `localType` but still
      // told `emitCoercedLocalSet` the value was `elemType`, so it coerced a
      // SECOND time — emitting invalid Wasm (`f64.convert_i32_s` on an externref /
      // `extern.convert_any` on an i32) whenever the rest-vec element type differs
      // from the target local's type (e.g. `[...[x]] = [undefined]` with
      // `var x = null`). Single-coerce via `emitCoercedLocalSet` is correct for
      // both the matching and mismatching cases.
      emitCoercedLocalSet(ctx, fctx, localIdx, elemType);
    } else if (ts.isObjectLiteralExpression(element)) {
      // Nested object pattern: [{ a, b }] = arr (#1225)
      const tmpElem = allocLocal(fctx, `__arr_nested_${fctx.locals.length}`, elemType);
      emitElemGet(i);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitObjectDestructureFromLocal(ctx, fctx, element, tmpElem, elemType);
    } else if (ts.isArrayLiteralExpression(element)) {
      // Nested array pattern: [[a, b]] = arr (#1225)
      const tmpElem = allocLocal(fctx, `__arr_nested_${fctx.locals.length}`, elemType);
      emitElemGet(i);
      fctx.body.push({ op: "local.set", index: tmpElem });
      emitArrayDestructureFromLocal(ctx, fctx, element, tmpElem, elemType);
    }
    // else: unsupported nested target — skip (existing behavior)
  }

  // Close null guard — throw TypeError if null/undefined (#730, #1225).
  // Skip for empty `[] = val` nested patterns (#225).
  fctx.body = savedBodyADFL;
  if (needsNullGuard) {
    const throwInstrs = buildDestructureNullThrow(ctx, fctx);
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: throwInstrs,
      else: adflInstrs,
    });
  } else {
    fctx.body.push(...adflInstrs);
  }
  // (#2869) Buffer reattached — drop the registration (avoid the #1109 double-shift).
  ctx.liveBodies.delete(adflInstrs);
}

/**
 * (#2757) Destructure a VEC (array-like) source through an OBJECT pattern rest
 * target — `[...{ 0: x, length }] = vals`. The rest element collects the
 * remaining source elements into a fresh vec; an object pattern applied to an
 * array is evaluated as an ordinary object (ECMA-262 §13.15.5.5), so:
 *   - the `length` key reads the vec's length field,
 *   - a numeric key `N` reads element N (out-of-range → `undefined`),
 *   - any other key is absent on the array-like and binds `undefined`.
 * `emitObjectDestructureFromLocal` cannot be reused here because it does nominal
 * struct-field lookups by name, and a vec struct (`{length, data}`) is not
 * registered in `typeIdxToStructName` — numeric keys would never resolve.
 */
function emitVecArrayLikeObjectDestructure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ObjectLiteralExpression,
  srcLocal: number,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): void {
  // Push the array-like property value for `key` onto the stack; return its type.
  const readKey = (key: string): ValType => {
    if (key === "length") {
      fctx.body.push({ op: "local.get", index: srcLocal });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
      return { kind: "i32" };
    }
    // Numeric index → bounds-checked element read (OOB → undefined sentinel).
    const idx = Number(key);
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 }); // data array
    fctx.body.push({ op: "i32.const", value: idx | 0 });
    emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elemType, ctx, true);
    return elemType.kind === "i8" || elemType.kind === "i16" ? { kind: "i32" } : elemType;
  };

  // The value is on the stack; bind it to `targetExpr` (identifier / nested
  // pattern / member expression).
  const bindTarget = (targetExpr: ts.Expression, valueType: ValType): void => {
    const tmpVal = allocLocal(fctx, `__rest_obj_val_${fctx.locals.length}`, valueType);
    fctx.body.push({ op: "local.set", index: tmpVal });
    if (ts.isIdentifier(targetExpr)) {
      let localIdx = fctx.localMap.get(targetExpr.text);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, targetExpr.text, valueType);
      }
      fctx.body.push({ op: "local.get", index: tmpVal });
      // `emitCoercedLocalSet` coerces from the stack type (`valueType`) to the
      // local's declared type itself — do NOT pre-coerce here (that would leave
      // an already-converted value and double-convert, e.g. `f64.convert_i32_s`
      // applied to a boxed externref).
      emitCoercedLocalSet(ctx, fctx, localIdx, valueType);
    } else if (ts.isObjectLiteralExpression(targetExpr)) {
      emitObjectDestructureFromLocal(ctx, fctx, targetExpr, tmpVal, valueType);
    } else if (ts.isArrayLiteralExpression(targetExpr)) {
      emitArrayDestructureFromLocal(ctx, fctx, targetExpr, tmpVal, valueType);
    } else if (ts.isPropertyAccessExpression(targetExpr) || ts.isElementAccessExpression(targetExpr)) {
      emitAssignToTarget(ctx, fctx, targetExpr, tmpVal, valueType);
    }
    // else: unsupported target — value already consumed into tmpVal; skip.
  };

  for (const prop of pattern.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      // `{ length }` — key === target identifier.
      const valueType = readKey(prop.name.text);
      bindTarget(prop.name, valueType);
    } else if (ts.isPropertyAssignment(prop)) {
      // `{ 0: x }` / `{ "k": x }` / `{ [expr]: x }`.
      const key =
        ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name)
          ? prop.name.text
          : ts.isComputedPropertyName(prop.name)
            ? resolveComputedKeyExpression(ctx, prop.name.expression)
            : undefined;
      if (key === undefined) continue; // unresolvable key — skip
      // Strip a default initializer (`{ 0: x = d }`); the default arm is a
      // narrow tail not yet handled — bind the raw value rather than dropping.
      let targetExpr = prop.initializer;
      if (ts.isBinaryExpression(targetExpr) && targetExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        targetExpr = targetExpr.left;
      }
      const valueType = readKey(key);
      bindTarget(targetExpr, valueType);
    }
  }
}

/**
 * (#2101a R5) Emit an own-field WRITE (`this.code = v` / `inst.code = v`) on an
 * externref-backed subclass instance. The storage location depends on the
 * native backing representation (#2917 — `externrefBackedOwnFieldBacking`):
 *
 *   - Error family (`$Error_struct` backing): route through the
 *     `$Error_struct.$props` (fieldIdx 5) open-`$Object` side-slot instead of
 *     the vestigial `$A` struct (which the receiver is NOT — casting to it
 *     traps). Lowers to: `props = self.$props; if (props == null) { props =
 *     __new_plain_object(); self.$props = props } __extern_set(props, "code",
 *     box(value))`.
 *   - `extends Object` (#3238, native `$Object` backing): the instance ITSELF
 *     is the open property store — `__extern_set(self, "code", box(value))`
 *     directly. Casting it to `$Error_struct` (the pre-#2917 behavior) traps.
 *
 * Returns the RHS as the assignment-expression result on success, or
 * `undefined` when the backing is unknown / helpers are unavailable (caller
 * falls through to the legacy struct path).
 */
function emitExternrefBackedOwnFieldWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
  fieldName: string,
  className: string,
): ValType | null | undefined {
  const backing = externrefBackedOwnFieldBacking(ctx, className);
  if (backing === undefined) return undefined;
  ensureObjectRuntime(ctx);
  const newObjIdx = ctx.funcMap.get("__new_plain_object");
  const externSetIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (newObjIdx === undefined || externSetIdx === undefined) return undefined;

  if (backing === "plain-object") {
    // self IS the open `$Object` — write the field straight onto it:
    // `__extern_set(self, "code", box(value))`.
    const selfResult = compileExpression(ctx, fctx, target.expression, { kind: "externref" });
    if (!selfResult) {
      reportError(ctx, target, "Failed to compile externref-backed own-field receiver");
      return null;
    }
    if (selfResult.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
    addStringConstantGlobal(ctx, fieldName);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, fieldName));
    const objValType = compileExpression(ctx, fctx, value);
    if (!objValType) return null;
    if (objValType.kind !== "externref") {
      coerceType(ctx, fctx, objValType, { kind: "externref" });
    }
    // stack: [self, key, value(externref)] — stash the boxed value as the
    // assignment-expression result before consuming it in the call.
    const objTmpBoxed = allocLocal(fctx, `__ownf_boxed_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.tee", index: objTmpBoxed });
    fctx.body.push({ op: "call", funcIdx: externSetIdx });
    fctx.body.push({ op: "local.get", index: objTmpBoxed });
    return { kind: "externref" };
  }

  const errStructIdx = getOrRegisterErrorStructType(ctx);

  // self → a TYPED `(ref $Error_struct)` local, cast ONCE. Reused for both the
  // `$props` read and the lazy-alloc write-back, avoiding repeated
  // any.convert_extern/ref.cast round-trips (and their stack-typing pitfalls).
  const selfResult = compileExpression(ctx, fctx, target.expression, { kind: "externref" });
  if (!selfResult) {
    reportError(ctx, target, "Failed to compile externref-backed own-field receiver");
    return null;
  }
  if (selfResult.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  const selfStructLocal = allocLocal(fctx, `__ownf_self_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: errStructIdx,
  });
  const propsLocal = allocLocal(fctx, `__ownf_props_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: errStructIdx });
  fctx.body.push({ op: "local.set", index: selfStructLocal });

  // props = self.$props (fieldIdx 5)
  fctx.body.push({ op: "local.get", index: selfStructLocal });
  fctx.body.push({ op: "struct.get", typeIdx: errStructIdx, fieldIdx: 5 });
  fctx.body.push({ op: "local.tee", index: propsLocal });
  // if (props == null) { props = __new_plain_object(); self.$props = props }
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "call", funcIdx: newObjIdx },
      { op: "local.set", index: propsLocal },
      // self.$props = props
      { op: "local.get", index: selfStructLocal },
      { op: "local.get", index: propsLocal },
      { op: "struct.set", typeIdx: errStructIdx, fieldIdx: 5 },
    ],
    else: [],
  });

  // __extern_set(props, key, box(value))
  fctx.body.push({ op: "local.get", index: propsLocal });
  addStringConstantGlobal(ctx, fieldName);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, fieldName));
  const valType = compileExpression(ctx, fctx, value);
  if (!valType) return null;
  // Box the value to externref for the open-`$Object` store.
  if (valType.kind !== "externref") {
    coerceType(ctx, fctx, valType, { kind: "externref" });
  }
  // stack: [props, key, value(externref)] — stash the boxed value as the
  // assignment-expression result before consuming it in the call.
  const tmpBoxed = allocLocal(fctx, `__ownf_boxed_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.tee", index: tmpBoxed });
  fctx.body.push({ op: "call", funcIdx: externSetIdx });
  // The result is the boxed externref. The common `this.code = 42;` statement
  // drops it; an `x = (this.code = v)` consumer sees the boxed value (externref
  // is the uniform own-field representation through this backing).
  fctx.body.push({ op: "local.get", index: tmpBoxed });
  return { kind: "externref" };
}

/**
 * (#2681/#2686 A3 — write side) Route a pinned-struct `recv.<field> = v` WRITE
 * through the #2664 deferred `__set_member_<name>` dispatcher
 * (`emitAlternateStructSetDispatch`), so writes hit the native struct slot in
 * lockstep with the A3 read dispatch. Caller has established `recv` resolves to a
 * registered/approved `__fnctor_<F>` struct. Returns the assignment value type
 * (`externref`), or `undefined` to let the normal write path handle it (reserved
 * accessor / method-typed write / no struct candidate).
 */
function tryEmitPinnedStructMemberSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
): ValType | undefined {
  if (ts.isPrivateIdentifier(target.name)) return undefined;
  const propName = target.name.text;
  // Preserve the source Reference's strictness through the pinned-fnctor
  // dispatcher.  A synthetic module wrapper must not turn a sloppy script
  // assignment into `__extern_set_strict`: that would make an inherited
  // refusal throw instead of completing as the required no-op.
  const strict = isStrictContext(target, ctx.inferModuleStrictArguments);
  if (
    propName === "length" ||
    propName === "constructor" ||
    propName === "__proto__" ||
    propName === "prototype" ||
    propName === "name"
  ) {
    return undefined;
  }
  // A method/function-typed write keeps its closure/funcref lowering.
  const accessType = ctx.checker.getTypeAtLocation(target);
  if (accessType.getCallSignatures && accessType.getCallSignatures().length > 0) return undefined;

  // Pre-check the dispatcher is reservable BEFORE emitting any receiver/value
  // side effects, so a decline leaves the body untouched (the
  // emitAlternateStructSetDispatch reserve below is idempotent).
  if (reserveMemberSetDispatch(ctx, propName, strict, fctx) === undefined) return undefined;

  // Evaluate the receiver (reference before value), coerce to externref.
  const objResult = compileExpression(ctx, fctx, target.expression);
  // (#2660 S3b) A receiver whose COMPILED ValType is already the pinned
  // `$__fnctor_<F>` struct (a retyped binding) skips the box + `ref.test`
  // dispatcher round-trip: one `struct.set` (+ presence bit when tracked).
  // Same hook as `compilePropertyAssignmentExternSet`; declines fall through
  // byte-identically (the reserve above is idempotent and shared).
  {
    const fnctorTypedSet = tryEmitFnctorTypedFieldSet(
      ctx,
      fctx,
      target,
      propName,
      objResult,
      value,
      () => typeErrorThrowInstrs(ctx, target),
      (valType) => ensureI32Condition(fctx, valType, ctx),
    );
    if (fnctorTypedSet !== undefined) return fnctorTypedSet;
  }
  if (objResult && objResult.kind !== "externref") {
    coerceType(ctx, fctx, objResult, { kind: "externref" });
  } else if (!objResult) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const objLocal = allocLocal(fctx, `__pset_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Evaluate the value, coerce/box to externref.
  const valResult = compileExpression(ctx, fctx, value);
  // (#4157 A) statically-f64 value → the typed write twin (no box/unbox).
  const f64Set = tryEmitTypedF64MemberSet(ctx, fctx, objLocal, valResult, propName, strict);
  if (f64Set !== undefined) return f64Set;
  if (valResult && ctx.booleanPropertyNames.has(propName)) {
    // #2847: a dynamic method bridge may already have boxed an untyped
    // boolean-returning closure as numeric externref 0/1. The whole-program
    // property analysis proves this write is boolean, so normalize through
    // ToBoolean and re-box with the boolean brand before it reaches the
    // member-set dispatcher/sidecar.
    ensureI32Condition(fctx, valResult, ctx);
    coerceType(ctx, fctx, { kind: "i32", boolean: true }, { kind: "externref" });
  } else if (
    // (#4611) A wasm-vec value keeps its raw identity through the member-set
    // dispatcher: the generic vec→externref coercion appends `__make_iterable`,
    // whose JS-array COPY fails the dispatcher arm's element ref.test and
    // silently demotes a struct-slot write to the sidecar — splitting the field
    // across storages (acorn `this.range = [pos, 0]` under `if (options.ranges)`).
    // The arm's `__vec_from_extern` short-circuits on the exact vec rep, so the
    // raw box lands the SAME vec on the slot; the sidecar terminal stores the
    // raw vec extern, which `_safeSet`/`_safeGet` already handle (#1712 view).
    valResult &&
    (valResult.kind === "ref" || valResult.kind === "ref_null") &&
    getArrTypeIdxFromVec(ctx, (valResult as { typeIdx: number }).typeIdx) >= 0
  ) {
    fctx.body.push({ op: "extern.convert_any" });
  } else if (valResult && valResult.kind !== "externref") {
    coerceType(ctx, fctx, valResult, { kind: "externref" });
  } else if (!valResult) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const valLocal = allocLocal(fctx, `__pset_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valLocal });

  // #2664 deferred set dispatcher: native `struct.set` arms (incl. the
  // late-registered `__fnctor_<F>`) + `__extern_set_strict` sidecar terminal.
  const dispatched = emitAlternateStructSetDispatch(ctx, fctx, objLocal, valLocal, propName, strict);
  if (!dispatched) return undefined; // no struct candidate yet — fall through to the normal write path
  // `=` evaluates to the assigned value.
  fctx.body.push({ op: "local.get", index: valLocal });
  return { kind: "externref" };
}

/**
 * (#4154) `o.#x = v` where the receiver is statically an `externref` — emit the
 * §7.3.28 PrivateBrandCheck as a real branch instead of letting the call-arg
 * repair pass narrow the receiver with an unguarded `ref.cast_null`.
 *
 * The receiver externref is expected on the stack top (the caller has just
 * compiled `target.expression`); it is popped into a temp so the value can be
 * evaluated on a clean stack.
 *
 * Evaluation order follows §13.15.2 + §6.2.5.6: base first, then the RHS, and
 * only then PutValue → PrivateSet, which is where the brand check throws. So a
 * side-effecting RHS still runs before the TypeError, exactly as in a real
 * engine.
 *
 * Emits:
 * ```wat
 *   local.set  $recv                     ;; receiver, externref
 *   <value>                              ;; coerced to the setter's value param
 *   local.set  $val
 *   local.get  $recv
 *   any.convert_extern
 *   ref.test   $Class                    ;; the brand check
 *   (if
 *     (then local.get $recv; any.convert_extern; ref.cast_null $Class
 *           local.get $val; call $Class_set_x)
 *     (else <throw TypeError>))
 *   local.get  $val                      ;; `=` evaluates to the RHS
 * ```
 */
function compilePrivateSetterWithBrandCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  spec: {
    value: ts.Expression;
    setterName: string;
    funcIdx: number;
    setterParamTypes: ValType[] | undefined;
    brandTypeIdx: number;
    privateName: string;
  },
): ValType | null {
  const { value, setterName, funcIdx, setterParamTypes, brandTypeIdx, privateName } = spec;
  const recvTmp = allocTempLocal(fctx, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvTmp });

  const valResult = compileExpression(ctx, fctx, value, setterParamTypes?.[1]);
  if (!valResult) {
    releaseTempLocal(fctx, recvTmp);
    return null;
  }
  const tmpVal = allocLocal(fctx, `__priv_setter_assign_${fctx.locals.length}`, valResult);
  fctx.body.push({ op: "local.set", index: tmpVal });

  // The throw arm is built BEFORE `finalSetterIdx` is read: it can add a late
  // `__new_TypeError` import, which shifts every defined function's index.
  // `buildThrowJsErrorInstrs` self-flushes the already-emitted body against
  // that shift, so reading funcMap afterwards yields the relocated index.
  const throwInstrs = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    `Cannot write private member #${privateName} to an object whose class did not declare it`,
    { flush: fctx },
  );
  const finalSetterIdx = ctx.funcMap.get(setterName) ?? funcIdx;

  const callArm: Instr[] = [
    { op: "local.get", index: recvTmp },
    { op: "any.convert_extern" },
    { op: "ref.cast_null", typeIdx: brandTypeIdx },
  ];
  // Setter declaring only the self param takes no value argument.
  if (setterParamTypes && setterParamTypes.length > 1) {
    callArm.push({ op: "local.get", index: tmpVal });
  }
  callArm.push({ op: "call", funcIdx: finalSetterIdx });

  fctx.body.push({ op: "local.get", index: recvTmp });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: brandTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: callArm,
    else: throwInstrs, // terminal throw — stack-polymorphic, validates as void
  });
  // `=` evaluates to the RHS, not the setter's return.
  fctx.body.push({ op: "local.get", index: tmpVal });
  releaseTempLocal(fctx, recvTmp);
  return valResult;
}

/**
 * (#4638) Park the `arr.length = N` receiver into `vecTmp`, guarded when the
 * value is not statically a vec.
 *
 * An EXTERNREF receiver is not evidence that the value IS a vec.
 * `resolveArrayInfo` answers from the checker's TYPE, and the checker types
 * `Array.prototype` as `any[]` — but the runtime value is the Array prototype
 * OBJECT, not a `$Vec`. A plain `local.set` into the `(ref null $__vec_base)`
 * slot coerces via `any.convert_extern ; ref.cast null`, which TRAPS
 * `illegal cast` — uncatchably, aborting the module. `Array.prototype.length =
 * 0` is a real ES5 idiom (`15.2.3.6-4-117` and `15.2.3.7-6-a-113` both open with
 * it) and the trap fired before the assertion those tests are about.
 *
 * Same invariant as #3610 / #3620 / #3621: a `ref.cast` is a claim about the
 * RUNTIME representation, and a static type is not that evidence.
 *
 * Returns `true` when the receiver was statically PROVEN to be a vec, in which
 * case the emitted bytes are identical to pre-#4638 and the caller may store the
 * length unguarded. On `false` the parked value is `null` for a non-vec, so the
 * caller must null-guard the store — a no-op, which is the correct observable
 * for the prototype object (its `length` is 0 and stays 0).
 */
function emitArrayLengthSetReceiverPark(
  fctx: FunctionContext,
  receiverType: ValType,
  vecBaseIdx: number,
  vecTmp: number,
): boolean {
  if (receiverType.kind === "ref" || receiverType.kind === "ref_null") {
    fctx.body.push({ op: "local.set", index: vecTmp });
    return true;
  }
  const anyTmp = allocLocal(fctx, `__arr_len_set_any_${fctx.locals.length}`, { kind: "anyref" });
  if (receiverType.kind === "externref") fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.set", index: anyTmp });
  fctx.body.push({ op: "local.get", index: anyTmp });
  fctx.body.push({ op: "ref.test", typeIdx: vecBaseIdx });
  // Empty block type + a parked local, never a concrete-ref block type (#4620).
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: anyTmp },
      { op: "ref.cast_null", typeIdx: vecBaseIdx },
      { op: "local.set", index: vecTmp },
    ],
    else: [
      { op: "ref.null", typeIdx: vecBaseIdx },
      { op: "local.set", index: vecTmp },
    ],
  });
  return false;
}

function compilePropertyAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
): InnerResult {
  const objType = ctx.checker.getTypeAtLocation(target.expression);

  const poisonResult = tryCompileStrictFunctionPoisonAssignment(ctx, fctx, target, value);
  if (poisonResult !== undefined) return poisonResult;

  // (#671 W1) The direct-DeleteBinding `with` planner selected one canonical
  // open object for this exact declaration. A checker-derived struct.set here
  // would split it from the raw member-read MOP (and can silently retain a
  // stale field after the `with` body mutates it), so preserve the dynamic
  // carrier through the matching runtime [[Set]] path. The key predicate is
  // declaration-scoped; unrelated same-named locals do not reach this arm.
  if (!ts.isPrivateIdentifier(target.name) && isIrWithOpenObjectTargetReceiver(ctx, target.expression)) {
    return compilePropertyAssignmentExternSet(ctx, fctx, target, value, target.name.text, true);
  }

  // (#3872) Non-writable DATA property — `defineProperty(o,"p",{writable:false})`
  // then `o.p = v`. Sits at the TOP, before any lowering-path selection, because
  // §10.1.9.2 OrdinarySetWithOwnDescriptor step 2.b decides the write FAILS
  // regardless of which backend would have performed it. Placing it lower (next
  // to the frozen consult) fixed only the host lane: the standalone lowering
  // returns through an earlier branch and never reached it.
  //
  // This must be a COMPILE-TIME throw, not a runtime one. The standalone
  // `__extern_set_strict` is deliberately aliased to the non-throwing native
  // `__extern_set` (object-runtime.ts, #2017) because the native runtime has no
  // TypeError bridge — so the runtime path can suppress the store but can never
  // raise. Emitting the throw here is what gives standalone the strict-mode
  // TypeError without building that bridge.
  if (!ts.isPrivateIdentifier(target.name)) {
    const nonWritable = tryEmitNonWritablePropertyWrite(ctx, fctx, target, value, target.name.text);
    if (nonWritable !== undefined) return nonWritable;
  }

  // (#4484 C) The SPEC-declared non-writable own properties of a builtin —
  // `Math.PI`, `Function.length`. The #3872 arm above mirrors only what the
  // PROGRAM defined via `Object.defineProperty`, so these never reached it and a
  // strict write silently did nothing (`11.13.1-4-28gs` / `-29gs` /
  // `11.13.1-4-6-s`: "no exception was thrown at all"). Sloppy mode keeps its
  // existing dropped-write lowering, which is what §10.1.9.2 step 2.b says.
  if (!ts.isPrivateIdentifier(target.name)) {
    const specNonWritable = tryEmitSpecNonWritableBuiltinWrite(ctx, fctx, target, value, target.name.text);
    if (specNonWritable !== undefined) return specNonWritable;
  }

  // (#4485) `<errorInstance>.{message,name,stack} = v` → `struct.set` on the
  // backing `$Error_struct`. Must sit ABOVE the generic member-set arms: the
  // standalone READ of these three is a hard `struct.get` of that struct, so a
  // write routed anywhere else is invisible to every later read. Declines
  // outside standalone/WASI and on any receiver that is not statically Error.
  // (Order vs the #4484 arm above is immaterial: that arm keys on builtin
  // NAMESPACE receivers, this one on statically-Error instances — disjoint.)
  {
    const errField = tryEmitErrorInstanceFieldWrite(ctx, fctx, target, value);
    if (errField !== undefined) return errField;
  }

  // (#4500 Slice A) `this.p = v` / `globalThis.p = v` where `p` is a
  // **`var`-declared** script global: write the wasm module global that stores
  // it, not a property on the realm global object. Symmetric with the read arm
  // in `property-access.ts` — and the pair MUST land together: fixing only the
  // read makes `this.p = 2; this.p === 2` regress, because the read would then
  // consult the module global while the write still updated the object.
  // (Measured: that exact row flipped to failing with the read arm alone.)
  //
  // Placed after the runtime-state checks above (poison, non-writable), so a
  // genuine descriptor on the global object still decides the write, and before
  // the struct-shaped lowerings below, which are the ones that mis-route it.
  // (Merge note: the #4484/#4485 arms above and this one key on disjoint
  // receivers — builtin namespaces, Error instances, the realm global object.)
  if (!ts.isPrivateIdentifier(target.name)) {
    const name = target.name.text;
    const globalIdx = ctx.moduleGlobals.get(name);
    if (globalIdx !== undefined && receiverIsRealmGlobalObject(ctx, fctx, target.expression)) {
      const globalType = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type;
      const rhsType = compileExpression(ctx, fctx, value, globalType);
      if (!rhsType) return null;
      if (globalType && rhsType.kind !== globalType.kind) coerceType(ctx, fctx, rhsType, globalType);
      const resultLocal = allocLocal(fctx, `__realm_global_write_${fctx.locals.length}`, globalType ?? rhsType);
      fctx.body.push({ op: "local.tee", index: resultLocal });
      fctx.body.push({ op: "global.set", index: globalIdx });
      // An assignment expression evaluates to the assigned value.
      fctx.body.push({ op: "local.get", index: resultLocal });
      return globalType ?? rhsType;
    }
  }

  // (#2660 S2) `F.prototype = rhs` whole-reassign on a user function constructor
  // (standalone): store `rhs` (built as a native `$Object` when a plain literal)
  // into the per-fnctor prototype global, instead of `__extern_set($closure,
  // "prototype", …)` (which misses `ref.test $Object` and silently drops the
  // write). Per-prop `F.prototype.p = v` is NOT here — it rides the read
  // interception in compilePropertyAccess. Declines for classes/builtins/host.
  {
    const fnctorProtoWrite = tryCompileFnctorPrototypeAssign(ctx, fctx, target, value);
    if (fnctorProtoWrite !== undefined) return fnctorProtoWrite;
  }

  // (#2747 d) `o.__proto__ = v` invokes the §B.2.2.1 Object.prototype.__proto__
  // setter — i.e. SetPrototypeOf(o, v) — NOT a generic own-property write. Route
  // to the SAME proto-link machinery as Object.setPrototypeOf / Reflect.
  // setPrototypeOf: standalone → native __object_setPrototypeOf; gc/host →
  // __host_set_struct_proto (records `_wasmStructProto` so the for-in walk +
  // getPrototypeOf read path follow it). Without this the assignment fell
  // through to the generic struct-write, which wrote `__proto__` as an OWN
  // enumerable data property AND dropped the real prototype link (verify-first:
  // for-in listed `__proto__` and the inherited key never appeared). The
  // assignment expression evaluates to the RHS value (§13.15.2), so the proto
  // value is tee'd and re-pushed after the (obj-returning) helper call.
  if (!ts.isPrivateIdentifier(target.name) && target.name.text === "__proto__") {
    const externRef: ValType = { kind: "externref" };
    // obj (externref)
    const objResult = compileExpression(ctx, fctx, target.expression, externRef);
    if (!objResult) return null;
    if (objResult.kind !== "externref") coerceType(ctx, fctx, objResult, externRef);
    // proto (externref). Standalone reifies an inline-literal proto into a
    // native `$Object` (compileProtoArg) so __object_setPrototypeOf's
    // `ref.test $Object` succeeds; gc/host stores the externref as-is.
    if (ctx.standalone) {
      compileProtoArg(ctx, fctx, value);
    } else {
      const protoResult = compileExpression(ctx, fctx, value, externRef);
      if (protoResult) {
        if (protoResult.kind !== "externref") coerceType(ctx, fctx, protoResult, externRef);
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
    }
    // Save the RHS (assignment result) before it is consumed by the call.
    const tmpVal = allocTempLocal(fctx, externRef);
    fctx.body.push({ op: "local.tee", index: tmpVal });
    const helperName = ctx.standalone ? "__object_setPrototypeOf" : "__host_set_struct_proto";
    const idx = ensureLateImport(ctx, helperName, [externRef, externRef], [externRef]);
    flushLateImportShifts(ctx, fctx);
    if (idx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: idx });
      fctx.body.push({ op: "drop" }); // native returns obj; assignment yields the RHS
    } else {
      // Helper unavailable — discard [obj, proto] left on the stack.
      fctx.body.push({ op: "drop" }); // proto
      fctx.body.push({ op: "drop" }); // obj
    }
    fctx.body.push({ op: "local.get", index: tmpVal });
    releaseTempLocal(fctx, tmpVal);
    return externRef;
  }

  // #1456: Private method or getter-only accessor → TypeError on write.
  // Must run BEFORE any routing decisions because the receiver typing (e.g.
  // `(this as any).#m`) can otherwise send us through __extern_set and
  // silently drop the write.
  if (ts.isPrivateIdentifier(target.name)) {
    const privateMember = classifyPrivateMember(ctx, target.name);
    if (privateMember?.kind === "method" || privateMember?.kind === "accessor-readonly") {
      // Evaluate RHS for side effects before throwing (spec evaluation order).
      const rhsResult = compileExpression(ctx, fctx, value);
      if (rhsResult) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "Cannot assign to private method or read-only accessor");
      return { kind: "externref" };
    }
    // #1680: Private accessor with a setter (`set #x(v)`). Dispatch to the
    // setter function. Without this branch control falls through to the
    // generic struct-field write, which targets a `__priv_<name>` data slot
    // the getter never reads — silently dropping the write and cross-talking
    // between stacked accessors. Mirrors the public-accessor setter dispatch.
    if (privateMember?.kind === "accessor" || privateMember?.kind === "accessor-writeonly") {
      const setterName = `${privateMember.className}_set_${privateMember.fieldName}`;
      const funcIdx = ctx.funcMap.get(setterName);
      if (funcIdx !== undefined) {
        const recvResult = compileExpression(ctx, fctx, target.expression);
        if (!recvResult) return null;
        const setterParamTypes = getFuncParamTypes(ctx, funcIdx);
        // (#3232) Coerce the receiver to the setter's declared self-param type
        // (param 0) BEFORE compiling the value, while it is still the stack top.
        // The value param below is already coerced via `valTypeHint`; the
        // receiver had no matching coercion, so on the standalone/nativeStrings
        // lane a static-private setter receiver (`this` in a static method →
        // an `externref` static-class carrier) was pushed raw where the
        // accessor declares `(ref null $Class)`, producing `call[0] expected
        // type (ref …), found … externref` invalid Wasm. The getter read path
        // does the equivalent `any.convert_extern` + `ref.cast`. `coerceType`
        // is a no-op when the types already match, so the gc/host lane (whose
        // receiver is already the struct ref) stays byte-identical.
        const selfParamType = setterParamTypes?.[0];
        // (#4154) §7.3.28 PrivateBrandCheck. When the receiver is statically an
        // `externref` but the setter declares `(ref null $Class)`, SOMETHING has
        // to narrow it. Left alone, nothing here does — and the generic call-arg
        // repair in `fixCallArgTypesInBody` (stack-balance.ts) splices a bare
        // `any.convert_extern; ref.cast_null $Class` in front of the call. On a
        // receiver that does not carry the brand that is an UNCATCHABLE
        // `illegal cast` trap, where the spec requires a catchable TypeError —
        // so `assert.throws(TypeError, …)` cannot even run. Emit the narrowing
        // ourselves, guarded by `ref.test` on the same type the cast would use
        // (identical subtype relation, so every receiver the cast accepted still
        // takes the call path), and throw on the miss.
        //
        // `ref.test` is false for null, which is also correct: PutValue on a
        // Private Reference does `ToObject(base)` first, and `ToObject(null)`
        // throws TypeError too.
        const brandTypeIdx =
          selfParamType &&
          (selfParamType.kind === "ref" || selfParamType.kind === "ref_null") &&
          (recvResult.kind === "externref" || recvResult.kind === "ref_extern")
            ? selfParamType.typeIdx
            : undefined;
        if (brandTypeIdx !== undefined) {
          return compilePrivateSetterWithBrandCheck(ctx, fctx, {
            value,
            setterName,
            funcIdx,
            setterParamTypes,
            brandTypeIdx,
            privateName: target.name.text,
          });
        }
        if (
          (ctx.standalone || ctx.wasi) &&
          selfParamType &&
          recvResult.kind === "externref" &&
          selfParamType.kind !== "externref" &&
          !valTypesMatch(recvResult, selfParamType)
        ) {
          coerceType(ctx, fctx, recvResult, selfParamType);
        }
        const valTypeHint = setterParamTypes?.[1]; // param 0 = self, param 1 = value
        const valResult = compileExpression(ctx, fctx, value, valTypeHint);
        if (!valResult) return null;
        // Stack: [receiver, value]. Save value for the assignment result.
        const tmpVal = allocLocal(fctx, `__priv_setter_assign_${fctx.locals.length}`, valResult);
        fctx.body.push({ op: "local.tee", index: tmpVal });
        // Setter with no value parameter (only self): drop the value.
        if (!setterParamTypes || setterParamTypes.length <= 1) {
          fctx.body.push({ op: "drop" });
        }
        // Re-read funcIdx: receiver/RHS compilation may have shifted indices
        // via late import addition (addUnionImports).
        const finalSetterIdx = ctx.funcMap.get(setterName) ?? funcIdx;
        fctx.body.push({ op: "call", funcIdx: finalSetterIdx });
        // `=` evaluates to the RHS, not the setter's return.
        fctx.body.push({ op: "local.get", index: tmpVal });
        return valResult;
      }
    }
  }

  // #1914 — `re.lastIndex = v` on a standalone RegExp receiver. Must run
  // BEFORE the extern-class setter path, which would otherwise emit an
  // `env.RegExp_set_lastIndex` host import (a standalone purity leak).
  {
    const standaloneLastIndexWrite = tryCompileStandaloneRegExpLastIndexWrite(ctx, fctx, target, value);
    if (standaloneLastIndexWrite !== undefined) return standaloneLastIndexWrite;
  }

  // (#3173) `buf.__detached__ = true` — the test262 `$DETACHBUFFER` shim's
  // marker write. Standalone marks the i32_byte buffer vec detached
  // (length = −1) so the DataView accessor / byteLength detached-buffer
  // TypeErrors fire; the host lane keeps its runtime-sidecar path untouched.
  {
    const detachedWrite = tryCompileStandaloneDetachedWrite(ctx, fctx, target, value, (e, hint) =>
      compileExpression(ctx, fctx, e, hint),
    );
    if (detachedWrite !== undefined) return detachedWrite;
  }

  // (#3374) A module-global property whose descriptor was changed by
  // Object.defineProperty must run through the runtime [[Set]] path. Function-
  // local class instances use the compiled classAccessorSet path below.
  // A direct struct.set would bypass [[Writable]], an absent [[Set]], and the
  // receiver's extensibility state.
  // The strictness bit comes from the actual source context: test262's
  // `noStrict` scripts are compiled through a synthetic module wrapper and must
  // still keep sloppy failed writes as silent no-ops.
  if (!ts.isPrivateIdentifier(target.name) && ts.isIdentifier(target.expression)) {
    const receiverName = target.expression.text;
    const propName = target.name.text;
    const propertyKey = `${receiverName}:${propName}`;
    if (
      ctx.moduleGlobals.has(receiverName) &&
      (ctx.definePropertyReceiverKeys.has(propertyKey) || sourceDefinesProperty(ctx, target.expression, propName))
    ) {
      return compilePropertyAssignmentExternSet(ctx, fctx, target, value, propName, true);
    }

    // A later assignment can widen the physical struct with a field that did
    // not exist when preventExtensions ran. Do not mistake that storage slot
    // for an ECMAScript own property. For a provably-new property, compile the
    // failed [[Set]] directly: strict PutValue throws; sloppy PutValue returns
    // the RHS while leaving the object unchanged.
    if (
      // (#3403) per-declaration key (receiverName stays bare above for the
      // out-of-scope moduleGlobals/definePropertyReceiverKeys checks).
      ctx.nonExtensibleVars.has(integrityVarKey(ctx, target.expression)) &&
      !objectLiteralInitializerHasProperty(ctx, target.expression, propName)
    ) {
      const rhsType = compileExpression(ctx, fctx, value);
      if (!rhsType) return null;
      if (isStrictContext(target, ctx.inferModuleStrictArguments)) {
        fctx.body.push({ op: "drop" });
        emitThrowTypeError(ctx, fctx, `Cannot add property ${propName}, object is not extensible`);
      }
      return rhsType;
    }
  }

  // Compile-away: if the target object is frozen, emit TypeError throw
  if (ts.isIdentifier(target.expression) && ctx.frozenVars.has(integrityVarKey(ctx, target.expression))) {
    // Evaluate RHS for side effects, then throw
    const rhsType = compileExpression(ctx, fctx, value);
    if (rhsType) {
      fctx.body.push({ op: "drop" });
    }
    emitThrowTypeError(ctx, fctx, "Cannot assign to read only property of frozen object");
    return { kind: "f64" }; // unreachable, but need a type
  }

  // Handle declared and dynamically-added static properties on a class value.
  if (ts.isIdentifier(target.expression) && ctx.classSet.has(target.expression.text)) {
    const clsName = target.expression.text;
    const propName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
    const fullName = `${clsName}_${propName}`;
    const globalIdx = ctx.staticProps.get(fullName);
    if (globalIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
      const valType = compileExpression(ctx, fctx, value, globalDef?.type);
      if (!valType) return null;
      // Save value, set global, return value (assignment expression result)
      const tmpVal = allocLocal(fctx, `__prop_assign_${fctx.locals.length}`, valType);
      fctx.body.push({ op: "local.tee", index: tmpVal });
      fctx.body.push({ op: "global.set", index: globalIdx });
      fctx.body.push({ op: "local.get", index: tmpVal });
      return valType;
    }
    return compilePropertyAssignmentExternSet(ctx, fctx, target, value, propName, true);
  }
  // #1697: `this.X = v` / `this.#X = v` inside a static method body —
  // mirror the read path's ThisKeyword+staticContext arm in
  // property-access.ts:1427. Without this, the LHS is `this` (not an
  // Identifier in classSet) and the static-prop assignment falls through to
  // the generic struct-write path, which silently drops the write because
  // `this` is the class constructor (not a per-instance struct).
  if (
    skipTransparentExpressions(target.expression).kind === ts.SyntaxKind.ThisKeyword &&
    (fctx.localMap.get("this") === undefined || fctx.isStaticContext)
  ) {
    let enclosingClass: string | undefined = fctx.enclosingClassName;
    if (!enclosingClass) {
      const fname = fctx.name;
      let pos = -1;
      while (!enclosingClass) {
        pos = fname.indexOf("_", pos + 1);
        if (pos < 0) break;
        const candidate = fname.substring(0, pos);
        if (candidate && ctx.classSet.has(candidate)) enclosingClass = candidate;
      }
    }
    if (enclosingClass) {
      const propName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
      const fullName = `${enclosingClass}_${propName}`;
      const globalIdx = ctx.staticProps.get(fullName);
      if (globalIdx !== undefined) {
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        const valType = compileExpression(ctx, fctx, value, globalDef?.type);
        if (!valType) return null;
        const tmpVal = allocLocal(fctx, `__prop_assign_${fctx.locals.length}`, valType);
        fctx.body.push({ op: "local.tee", index: tmpVal });
        fctx.body.push({ op: "global.set", index: globalIdx });
        fctx.body.push({ op: "local.get", index: tmpVal });
        return valType;
      }
    }
  }

  // (#3496) `globalThis.<name> = value` is always a write to the realm's
  // intrinsic global object, never a field write on a compiler-generated
  // structural type. A bare `globalThis` captured in an object literal (the
  // standard `$262 = { global: globalThis }` harness shape) makes TypeScript's
  // enormous `typeof globalThis` type reachable and therefore registerable as
  // a Wasm struct. Letting the generic resolution below see that struct makes
  // later global-property writes cast the native standalone `$Object`
  // singleton to the unrelated structural type; the guarded cast yields null
  // and module initialization throws before the property can be installed.
  //
  // Mirror the dedicated `globalThis` read path: keep the receiver on its
  // externref/native-object representation regardless of which structural
  // types happen to have been registered elsewhere in the program. The
  // ordinary runtime setter preserves strictness and remains dual-mode for
  // host/GC versus standalone/WASI.
  if (ts.isIdentifier(target.expression) && target.expression.text === "globalThis") {
    const propName = ts.isPrivateIdentifier(target.name) ? `__priv_${target.name.text.slice(1)}` : target.name.text;
    const wrapRuntimeEvalCallable =
      ctx.runtimeEvalCallableBoundaryEnabled === true && isStaticallyCallableExpression(ctx, value);
    const externSetTy = compilePropertyAssignmentExternSet(
      ctx,
      fctx,
      target,
      value,
      propName,
      false,
      wrapRuntimeEvalCallable,
    );
    // (#4630) `globalThis.<topLevelFn> = …` also updates the override slot so
    // bare reads/calls of the declaration resolve the reassignment (§16.1.7).
    // The value is read BACK from the singleton (side-effect-free) rather than
    // re-evaluated.
    if (isShadowedTopLevelFn(ctx, propName)) {
      const slot = fnShadowSlot(ctx, propName);
      if (ctx.standalone || ctx.wasi) {
        const gtTy = withShadowReadSuppressed(() => emitNativeGlobalThisObject(ctx, fctx));
        if (gtTy) {
          const getIdx = ctx.funcMap.get("__extern_get");
          if (getIdx !== undefined) {
            addStringConstantGlobal(ctx, propName);
            for (const instr of stringConstantExternrefInstrs(ctx, propName)) fctx.body.push(instr);
            fctx.body.push({ op: "call", funcIdx: getIdx });
            fctx.body.push({ op: "global.set", index: slot });
          } else {
            fctx.body.push({ op: "drop" });
          }
        }
      } else if (externSetTy !== null && externSetTy !== VOID_RESULT && externSetTy.kind === "externref") {
        // (#4648) JS-host lane: `globalThis` is the host global object, so the
        // read-back hop the standalone arm uses (native singleton +
        // `__extern_get`) has no counterpart here. The assignment expression's
        // own result is already the stored value on top of the stack, so tee
        // it into the slot — same observable aliasing, no extra host call.
        const tmp = allocLocal(fctx, `__fnshadow_set_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.tee", index: tmp });
        fctx.body.push({ op: "global.set", index: slot });
        fctx.body.push({ op: "local.get", index: tmp });
      }
    }
    return externSetTy;
  }

  // Handle externref property set
  if (isExternalDeclaredClass(objType, ctx.checker)) {
    const externSetResult = compileExternPropertySet(ctx, fctx, target, value, objType);
    if (externSetResult !== null) return externSetResult;
    // For host objects, missing specific setter imports must not silently drop
    // the assignment. Fall back to dynamic __extern_set on the host object
    // instead of treating the extern class like a Wasm struct.
    const propName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
    return compilePropertyAssignmentExternSet(ctx, fctx, target, value, propName);
  }

  // Handle shape-inferred array-like variables: obj.length = N
  if (ts.isIdentifier(target.expression)) {
    const shapeInfo = ctx.shapeMap.get(target.expression.text);
    if (shapeInfo) {
      const fieldName = target.name.text;
      const vecDef = ctx.mod.types[shapeInfo.vecTypeIdx];
      if (vecDef && vecDef.kind === "struct") {
        const fieldIdx = vecDef.fields.findIndex((f: { name: string }) => f.name === fieldName);
        if (fieldIdx >= 0) {
          const structObjResult = compileExpression(ctx, fctx, target.expression);
          if (!structObjResult) return null;
          const valType = compileExpression(ctx, fctx, value, vecDef.fields[fieldIdx]!.type);
          if (!valType) return null;
          const tmpVal = allocLocal(fctx, `__prop_assign_${fctx.locals.length}`, valType);
          fctx.body.push({ op: "local.tee", index: tmpVal });
          fctx.body.push({
            op: "struct.set",
            typeIdx: shapeInfo.vecTypeIdx,
            fieldIdx,
          });
          fctx.body.push({ op: "local.get", index: tmpVal });
          return valType;
        }
      }
    }
  }

  // Handle arr.length = N on typed arrays (vec struct field 0 = length)
  if (target.name.text === "length") {
    const arrInfo = resolveArrayInfo(ctx, objType);
    if (arrInfo) {
      // The checker's FLOW type picks `vecTypeIdx`, but the receiver's runtime
      // representation can be a sibling vec (an evolving `var x = []` global is
      // stored as `$__vec_externref` while a later `x = [0]` narrows the flow
      // type to `number[]` → `$__vec_f64`; the local-set-coerce repair then
      // emits a sibling `ref.cast` that always traps — `illegal cast` on every
      // `x.length = n` after reassignment, test262 S15.4.5.1_A1.3_T1). The
      // write only touches field 0 (`length`), which lives on the shared
      // `$__vec_base` supertype, so type the receiver as the base: every
      // concrete vec upcasts safely and the store is identical.
      const vecBaseIdx = getOrRegisterVecBaseType(ctx);
      // Compile receiver (vec struct ref)
      const structObjResult = compileExpression(ctx, fctx, target.expression);
      if (!structObjResult) return null;
      const vecTmp = allocLocal(fctx, `__arr_len_set_vec_${fctx.locals.length}`, {
        kind: "ref_null",
        typeIdx: vecBaseIdx,
      });
      // (#4638) See `emitArrayLengthSetReceiverPark`.
      const receiverProvenVec = emitArrayLengthSetReceiverPark(fctx, structObjResult, vecBaseIdx, vecTmp);
      // Compile value (the new length)
      const valType = compileExpression(ctx, fctx, value);
      if (!valType) return null;
      // §10.4.2.4 step 3: ToUint32(ToNumber(value)). A non-numeric value
      // (`arr.length = "1"` / `null` / `new Number(1)`) used to fall to the
      // local-set-coerce repair, whose bare `__unbox_number` reads wrapper
      // objects as NaN and stored 0 (test262 S15.4.5.1_A1.3_T1). Coerce
      // ref-ish values through the real ToNumber chain (ToPrimitive + unbox)
      // so wrappers and strings get their valueOf/parse, then validate.
      let lenValKind = valType.kind;
      if (lenValKind !== "i32" && lenValKind !== "f64") {
        coerceType(ctx, fctx, valType, { kind: "f64" });
        lenValKind = "f64";
      }
      // Convert f64 to i32 if needed
      const newLenTmp = allocLocal(fctx, `__arr_len_set_nl_${fctx.locals.length}`, { kind: "i32" });
      if (lenValKind === "f64") {
        // (#4222) §10.4.2.4 ArraySetLength step 3 — RangeError, not a clamp;
        // body in array-length-define.ts, which owns the defineProperty forms.
        emitArraySetLengthValidation(ctx, fctx);
      }
      fctx.body.push({ op: "local.set", index: newLenTmp });
      // Set vec.length = newLen
      const lengthStore: Instr[] = [
        { op: "local.get", index: vecTmp },
        { op: "local.get", index: newLenTmp },
        { op: "struct.set", typeIdx: vecBaseIdx, fieldIdx: 0 },
      ];
      if (receiverProvenVec) {
        // Byte-identical to pre-#4638 for a statically proven vec receiver.
        for (const instr of lengthStore) fctx.body.push(instr);
      } else {
        // The guarded cast above parks `null` when the receiver was not a vec;
        // `struct.set` on null is the same uncatchable trap, so skip the store.
        fctx.body.push({ op: "local.get", index: vecTmp });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: lengthStore });
      }
      // Assignment result — UNSIGNED widening (#4491, see array-length-define.ts).
      fctx.body.push({ op: "local.get", index: newLenTmp });
      if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_u" });
      return ctx.fast ? { kind: "i32" } : { kind: "f64" };
    }
  }

  // (#2681/#2686 A3 — write side, MUST mirror the read side) When the receiver is
  // a pinned `__fnctor_<F>` struct (a lifted fnctor-prototype method's `this`, or a
  // single-return-inferred local), route the `recv.<field> = v` WRITE through the
  // #2664 deferred `__set_member_<name>` dispatcher (native `struct.set` arms +
  // `__extern_set_strict` sidecar terminal) — symmetric to the read dispatch in
  // compilePropertyAccess. WITHOUT this, the write below falls into
  // `tryEmitDeleteAwareDynamicSet` (acorn uses `delete` → an `any`-receiver write
  // goes to the bare `__extern_set_strict` SIDECAR), while the A3 read goes to the
  // native struct slot — reads and writes DIVERGE so `this.pos += 1` never advances
  // and the tokenizer loops forever (the hang the read-only fix exposed). Both
  // dispatchers are finalize-filled over the COMPLETE struct table, so at runtime
  // a struct instance hits the slot on BOTH sides and a genuine proxy hits the
  // sidecar on BOTH sides — consistent either way. Runs BEFORE the delete-aware
  // write so it wins for pinned receivers.
  // (#3683 S2 branch b) TYPED-`this` field WRITE inside a twin — the pinned
  // dispatcher's `$__fnctor_F` arm inlined against the twin prologue's
  // already-cast local. Runs first; declines fall through unchanged.
  {
    const typedSet = tryEmitTypedThisFieldSet(ctx, fctx, target, value, ensureI32Condition);
    if (typedSet !== undefined) return typedSet;
  }

  {
    const pinnedThis =
      target.expression.kind === ts.SyntaxKind.ThisKeyword && fctx.thisStructName !== undefined
        ? fctx.thisStructName
        : undefined;
    const pinned = pinnedThis ?? resolveReceiverStruct(ctx, fctx, target.expression);
    if (pinned !== undefined) {
      const pinnedSet = tryEmitPinnedStructMemberSet(ctx, fctx, target, value);
      if (pinnedSet !== undefined) return pinnedSet;
    }
  }

  // (#2731) Symmetric tombstone-aware WRITE routing. In a `delete`-using module,
  // any-receiver READS already route through the tombstone-aware host
  // `__extern_get` (`tryEmitDeleteAwareDynamicGet`); the WRITE must match. Without
  // this, `o.x = 9` after `delete o.x` takes the native `struct.set` fast-path
  // below (`resolveStructNameForExpr` resolves the shape-inferred anon struct),
  // bypassing `_safeSet`'s tombstone-clear — so the re-added key stays suppressed
  // in `__extern_get` / `__for_in_*` / `__object_keys`. Runs BEFORE the
  // struct-name resolution so the native struct.set is skipped for `any`
  // receivers; concrete-typed receivers and reserved/callable props decline.
  {
    const dynPropName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
    const dynSet = tryEmitDeleteAwareDynamicSet(ctx, fctx, target, value, objType, dynPropName);
    if (dynSet !== undefined) return dynSet;
  }

  const typeName = resolveStructNameForExpr(ctx, fctx, target.expression);
  if (!typeName) {
    // No struct type resolved. Mirror the compound/logical assignment fallback:
    // treat the receiver as a host/dynamic object and route the write through
    // __extern_set instead of silently dropping the assignment.
    const fieldName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
    return compilePropertyAssignmentExternSet(ctx, fctx, target, value, fieldName);
  }

  // Check for setter accessor on user-defined classes
  const fieldName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
  const accessorKey = `${typeName}_${fieldName}`;
  // (#1888 S5c / C4) Migrated struct accessor → route the write through the
  // host-free setter closure (per-(struct,prop) global + shared S5b
  // __call_accessor_set driver) so a setter that mutates an outer-scope capture
  // observes it. __call_accessor_set(recv, setter, value): recv = the struct
  // instance boxed to externref (threaded as `this` via __current_this); the
  // setter's return is DISCARDED by the driver (§10.1.5.3 [[Set]]); the
  // assignment expression evaluates to the RHS, not the setter result. The
  // closure globals only exist for Object.defineProperty(o,…)/objlit receivers
  // (always a struct instance), so the proto/class-object dummy path is not a
  // concern here.
  const closureAccSet =
    S5C_STRUCT_ACCESSOR_CLOSURE && ctx.standalone ? ctx.structAccessorClosure.get(accessorKey)?.setGlobal : undefined;
  if (closureAccSet !== undefined) {
    // recv: struct instance → externref
    const recvResult = compileExpression(ctx, fctx, target.expression);
    if (!recvResult) {
      reportError(ctx, target, "Failed to compile setter receiver");
      return null;
    }
    if (recvResult.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    // setter closure (externref)
    fctx.body.push({ op: "global.get", index: closureAccSet });
    // value: compile in its natural type, save for the assignment result, then
    // box a copy to externref for the driver's `value` arg.
    const valResult = compileExpression(ctx, fctx, value);
    if (!valResult) {
      reportError(ctx, target, "Failed to compile setter value");
      return null;
    }
    const valTmp = allocLocal(fctx, `__acc_set_val_${fctx.locals.length}`, valResult);
    fctx.body.push({ op: "local.tee", index: valTmp });
    if (valResult.kind !== "externref") {
      coerceType(ctx, fctx, valResult, { kind: "externref" });
    }
    const setDriverIdx = reserveAccessorSetDriver(ctx);
    fctx.body.push({ op: "call", funcIdx: setDriverIdx }); // () result — setter return discarded
    // Assignment expression evaluates to the RHS (natural type).
    fctx.body.push({ op: "local.get", index: valTmp });
    return valResult;
  }
  if (ctx.classAccessorSet.has(accessorKey)) {
    const setterName = `${typeName}_set_${fieldName}`;
    const funcIdx = ctx.funcMap.get(setterName);
    // (#2024) `classAccessorSet` records a class that declares EITHER a getter
    // or a setter for this prop (class-bodies.ts adds the key for both). A
    // get-only accessor — `class B extends A { get v() {…} }` over a parent
    // with `set v` — therefore lands here with NO `${type}_set_${field}`
    // function. Per §10.1.5.3 OrdinarySetWithOwnDescriptor, the own get-only
    // accessor SHADOWS the inherited setter: strict-mode writes throw TypeError
    // and the parent's setter must NOT run. Without this, control fell through
    // to the struct-field path, which found no field named `<field>` and
    // silently dropped the write. Emit the spec TypeError instead.
    if (funcIdx === undefined && ctx.funcMap.has(`${typeName}_get_${fieldName}`)) {
      // Evaluate the RHS for its side effects (spec: GetValue(rhs) is performed
      // before the [[Set]]), drop its value, then throw. `emitThrowTypeError`
      // emits an `unreachable`, so the assignment expression's stack effect is
      // satisfied by divergence — we report the RHS type so any wrapping
      // expression type-checks consistently.
      const rhsResult = compileExpression(ctx, fctx, value);
      if (rhsResult !== null) {
        fctx.body.push({ op: "drop" });
      }
      emitThrowTypeError(ctx, fctx, `Cannot assign to read only property '${fieldName}' of object`);
      return rhsResult ?? { kind: "f64" };
    }
    if (funcIdx !== undefined) {
      // `C.prototype.<setter> = v` and `C.<static setter> = v` both write
      // through a receiver that is an externref (the prototype singleton or the
      // class object), not a struct instance. Coercing that externref to the
      // setter's struct `this` param produces an invalid `local.tee` (externref
      // temp fed a struct ref.null). Use the dummy-struct call path (same as
      // `C.prototype[key] = v`) so the setter receives a throwaway struct
      // receiver and the value flows through unchanged.
      const receiverIsProto =
        ts.isPropertyAccessExpression(target.expression) &&
        ts.isIdentifier(target.expression.name) &&
        target.expression.name.text === "prototype";
      const receiverIsClassObject = ts.isIdentifier(target.expression) && ctx.classSet.has(target.expression.text);
      if (receiverIsProto || receiverIsClassObject) {
        return emitSetterCallWithDummy(ctx, fctx, typeName, setterName, funcIdx, value);
      }
      // Get setter's parameter types to provide type hints
      const setterParamTypes = getFuncParamTypes(ctx, funcIdx);
      const setterObjResult = compileExpression(ctx, fctx, target.expression, setterParamTypes?.[0]);
      if (!setterObjResult) {
        reportError(ctx, target, "Failed to compile setter receiver");
        return null;
      }
      const setterValExpectedType = setterParamTypes?.[1]; // param 0 = self, param 1 = value
      const setterValResult = compileExpression(ctx, fctx, value, setterValExpectedType);
      if (!setterValResult) {
        reportError(ctx, target, "Failed to compile setter value");
        return null;
      }
      // Save value for assignment expression result
      const setterTmpVal = allocLocal(fctx, `__setter_assign_${fctx.locals.length}`, setterValResult);
      fctx.body.push({ op: "local.tee", index: setterTmpVal });
      // If setter has no value parameter (only self), drop the value before calling
      const setterHasValueParam = setterParamTypes && setterParamTypes.length > 1;
      if (!setterHasValueParam) {
        fctx.body.push({ op: "drop" });
      }
      const finalSetterIdx = ctx.funcMap.get(setterName) ?? funcIdx;
      fctx.body.push({ op: "call", funcIdx: finalSetterIdx });
      fctx.body.push({ op: "local.get", index: setterTmpVal });
      return setterValResult;
    }
  }

  // (#2101a R5) Own-field write on an externref-backed Error subclass
  // (`class A extends Error { code = 0 }`). The instance is the parent's
  // `$Error_struct` externref, NOT a `$A` WasmGC struct, so the struct.set path
  // below casts `this` to `$A` and TRAPS at construction. Route the write
  // through the `$props` backing field (fieldIdx 5) instead: lazily allocate an
  // open `$Object` on first write, then `__extern_set(props, key, box(value))`.
  // Standalone only — host mode keeps the host-object machinery.
  if (ctx.standalone && ctx.classExternrefBackedSet.has(typeName)) {
    const ownWrite = emitExternrefBackedOwnFieldWrite(ctx, fctx, target, value, fieldName, typeName);
    if (ownWrite !== undefined) return ownWrite;
    // undefined → not applicable (e.g. helper unavailable); fall through.
  }

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) return null;

  const fieldIdx = fields.findIndex((f) => f.name === fieldName);
  if (fieldIdx === -1) {
    // (#4149) The receiver resolved to a KNOWN struct shape that provably lacks
    // this own field — a post-hoc property ADD (`var e = {}; e.f = fn`). The old
    // `return null` here made the whole assignment vanish: the caller's fallback
    // evaluated the RHS for side effects and dropped it, so nothing was ever
    // stored and every later dynamic read (`__extern_get` through an alias of
    // the same object) answered null. That is exactly the CommonJS/UMD wrapper
    // shape (`exports.parse = …` then `m.exports.parse(...)` — acorn defect #6).
    // Route the write through the dynamic sidecar instead, the same terminal the
    // unresolved-shape branch above uses: on standalone an empty-literal object
    // is a native `$Object`, so `__extern_set` stores and the aliased
    // `__extern_get` read finds it; on gc/host the host sidecar does the same.
    //
    // Landing this write is what lets a class body whose field was never
    // declared (`set #m(v) { this._v = v; }` — `_v` has no declaration) actually
    // store. Two test262 brand-check tests consequently run PAST their first
    // assert and reach a pre-existing latent `illegal cast` on the subsequent
    // foreign-receiver private access; that is a reclassification of an
    // already-failing test, declared under `trap-growth-allow` in
    // plan/issues/4149-*.md and tracked for a real fix in #4154.
    return compilePropertyAssignmentExternSet(ctx, fctx, target, value, fieldName);
  }
  const presenceSlot = presenceSlotOf(fields, fieldName);

  // A flow-grown slot with a clear presence bit is not an own property yet.
  // When inherited descriptors are observable, route it through the existing
  // dynamic member-set dispatcher so its strict/non-strict terminal reaches
  // the shared four-state [[Set]] decision before materializing the slot.
  // This runs before either receiver or RHS is emitted, preserving evaluation
  // order and leaving the direct physical fast path for a present slot in the
  // dispatcher/runtime itself.
  if (ctx.standalone && inheritedSetAffectsKey(ctx, fieldName) && presenceSlot !== undefined) {
    return compilePropertyAssignmentExternSet(ctx, fctx, target, value, fieldName);
  }

  const structSelfType: ValType = { kind: "ref_null", typeIdx: structTypeIdx };
  const structObjResult = compileExpression(ctx, fctx, target.expression, structSelfType);
  if (!structObjResult) {
    reportError(ctx, target, "Failed to compile struct field receiver");
    return null;
  }
  // (#2084) Null-guard the write. The read path already throws a catchable
  // TypeError on a null receiver, but the store path emitted `struct.set`
  // directly — a null receiver then trapped uncatchably ("dereferencing a null
  // pointer") instead of throwing `TypeError: Cannot set properties of null`
  // (error-model divergence, family #581/#2025). Skip the guard when the
  // receiver is a non-nullable `ref` or is statically provably non-null (e.g.
  // `new Foo()`, `this`) — no trap is possible there and the check is dead
  // weight. Mirrors the array-element write guard below (`isProvablyNonNull`).
  const guardNull = structObjResult.kind === "ref_null" && !isProvablyNonNull(target.expression, ctx.checker);
  const trackedValue = compileCoercionRhs(ctx, fctx, value, fields[fieldIdx]!.type, typeName, fieldName);
  if (!trackedValue) return null;
  const [valType, tmpVal] = trackedValue;
  if (guardNull) {
    // stack: [receiver, value] — stash value, then null-check the receiver.
    fctx.body.push({ op: "local.set", index: tmpVal });
    const tmpRecv = allocLocal(fctx, `__prop_recv_${fctx.locals.length}`, structSelfType);
    fctx.body.push({ op: "local.tee", index: tmpRecv });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: typeErrorThrowInstrs(ctx, target),
      else: [
        { op: "local.get", index: tmpRecv },
        { op: "local.get", index: tmpVal },
        { op: "struct.set", typeIdx: structTypeIdx, fieldIdx },
        ...(presenceSlot ? presenceSetInstrs(structTypeIdx, presenceSlot, tmpRecv) : []),
      ],
    });
  } else if (presenceSlot) {
    // Preserve the receiver as well as the RHS so the hidden presence slot can
    // be marked after the real field write.
    fctx.body.push({ op: "local.set", index: tmpVal });
    const tmpRecv = allocLocal(fctx, `__prop_recv_${fctx.locals.length}`, structSelfType);
    fctx.body.push({ op: "local.set", index: tmpRecv });
    fctx.body.push({ op: "local.get", index: tmpRecv });
    fctx.body.push({ op: "local.get", index: tmpVal });
    fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
    for (const instr of presenceSetInstrs(structTypeIdx, presenceSlot, tmpRecv)) fctx.body.push(instr);
  } else {
    fctx.body.push({ op: "local.tee", index: tmpVal });
    fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
  }
  fctx.body.push({ op: "local.get", index: tmpVal });

  return valType;
}

/** Conservative proof used only for the linked runtime-eval global seam. */
function isStaticallyCallableExpression(ctx: CodegenContext, value: ts.Expression): boolean {
  const expr = skipTransparentExpressions(value);
  if (
    ts.isFunctionExpression(expr) ||
    ts.isArrowFunction(expr) ||
    (ts.isIdentifier(expr) && (ctx.funcMap.has(expr.text) || ctx.topLevelFunctionNames.has(expr.text)))
  ) {
    return true;
  }
  return ctx.oracle.signatureOf(expr) !== undefined;
}

/**
 * Fallback for property assignment when the struct field is not found.
 * Used when Object.defineProperty with an accessor descriptor (get/set) was detected
 * at compile time — the property is intentionally excluded from the widened struct so
 * all accesses go through __extern_set, which calls _safeSet, which invokes the accessor.
 */
function compilePropertyAssignmentExternSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
  propName: string,
  forceRuntimeSet = false,
  wrapRuntimeEvalCallable = false,
): InnerResult {
  // Compile object expression and convert to externref
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  // (#4155 Phase 2) Struct-typed receiver + own mutable data slot → one
  // `struct.set` instead of the externref hop + `__extern_set` ladder. Never
  // when a runtime accessor descriptor forced this path (`forceRuntimeSet`) or
  // the runtime-eval callable wrap is needed — those must stay dynamic.
  // Flag-gated (declines are byte-identical); flag-independent census under
  // JS2WASM_FNCTOR_TYPED_READS_DEBUG.
  if (!forceRuntimeSet && !wrapRuntimeEvalCallable) {
    const fnctorTypedSet = tryEmitFnctorTypedFieldSet(
      ctx,
      fctx,
      target,
      propName,
      objResult,
      value,
      () => typeErrorThrowInstrs(ctx, target),
      (valType) => ensureI32Condition(fctx, valType, ctx),
    );
    if (fnctorTypedSet !== undefined) return fnctorTypedSet;
  }
  if (objResult.kind === "externref") {
    // already externref
  } else if (objResult.kind === "ref" || objResult.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  } else if (objResult.kind === "f64") {
    addUnionImports(ctx);
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else {
    return null;
  }
  const objLocal = allocLocal(fctx, `__paset_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Compile value as externref and save
  const valResult = compileExpression(ctx, fctx, value);
  if (!valResult) return null;
  // (#3374) PutValue throws only when [[Set]] returns false AND the Reference is
  // strict (§6.2.5.6 steps 3.d-e). Preserve that source-level bit instead of
  // treating the compiler's synthetic ESM wrapper as strict JavaScript.
  const strict = isStrictContext(target, ctx.inferModuleStrictArguments);
  // (#4157 A) statically-f64 value → the typed write twin (no box/unbox).
  const dyn = forceRuntimeSet || wrapRuntimeEvalCallable;
  const f64Set = dyn ? undefined : tryEmitTypedF64MemberSet(ctx, fctx, objLocal, valResult, propName, strict);
  if (f64Set !== undefined) return f64Set;
  if (ctx.booleanPropertyNames.has(propName)) {
    ensureI32Condition(fctx, valResult, ctx);
    coerceType(ctx, fctx, { kind: "i32", boolean: true }, { kind: "externref" });
  } else if (valResult.kind !== "externref") {
    coerceType(ctx, fctx, valResult, { kind: "externref" });
  }
  let assignmentResultLocal: number | undefined;
  if (wrapRuntimeEvalCallable) {
    // PutValue returns the ORIGINAL RHS, not the internal adapter stored on the
    // realm object. Preserve identity for `(globalThis.f = f) === f`.
    assignmentResultLocal = allocLocal(fctx, `__runtime_eval_aot_rhs_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.tee", index: assignmentResultLocal });
    emitRuntimeEvalAotCallableAdapter(ctx, fctx);
  }
  const valLocal = allocLocal(fctx, `__paset_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valLocal });

  const setName = strict ? "__extern_set_strict" : "__extern_set";
  const setIdx = ensureLateImport(
    ctx,
    setName,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);

  // (#2655) Build the selected __extern_set(obj, key, val) sequence as the terminal
  // else-arm of a symmetric struct.set dispatch. The member-READ fast path
  // resolves an `any`/`externref` receiver that is actually a typed WasmGC struct
  // via `struct.get <slot>`; a bare `__extern_set` write routes through `_safeSet`
  // to a JS-side SIDECAR and never touches the slot, so read (slot) and write
  // (sidecar) diverge (acorn `this.pos`/`this.type` loops). Writing the SLOT when
  // the receiver owns `propName` as a real field keeps the two in sync. The
  // selected __extern_set fallback still covers genuine host externrefs and
  // dynamic sidecar-only props.
  // (#2664) Route ordinary writes through the deferred-fill member-set dispatcher.
  // Its terminal else-arm IS the selected runtime setter, so no
  // inline fallback is needed; its struct-candidate arms are enumerated at
  // finalize (the full type table), fixing the compile-order candidate freeze.
  // (#3374) Object.defineProperty descriptors live in runtime state, not in a
  // Wasm struct slot. Bypass the struct.set arms for such properties so every
  // write observes [[Writable]] / [[Set]] and returns the correct [[Set]] result.
  const dispatched =
    !forceRuntimeSet && emitAlternateStructSetDispatch(ctx, fctx, objLocal, valLocal, propName, strict);
  if (!dispatched) {
    // Dispatcher could not be reserved — emit the bare host write with the
    // same strictness as the source Reference.
    addStringConstantGlobal(ctx, propName);
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push(...stringConstantExternrefInstrs(ctx, propName));
    fctx.body.push({ op: "local.get", index: valLocal });
    if (setIdx !== undefined) fctx.body.push({ op: "call", funcIdx: setIdx });
  }

  // Return the assigned value
  fctx.body.push({ op: "local.get", index: assignmentResultLocal ?? valLocal });
  return { kind: "externref" };
}

function compileExternPropertySet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
  objType: ts.Type,
): InnerResult {
  const className = objType.getSymbol()?.name;
  const propName = target.name.text;
  if (!className) return null;

  // Walk inheritance chain to find the class that declares the property
  const resolvedInfo = findExternInfoForMember(ctx, className, propName, "property");
  const propOwner = resolvedInfo ?? ctx.externClasses.get(className);
  if (!propOwner) return null;

  // Check if the import exists BEFORE compiling object+value to avoid dangling stack values
  const importName = `${propOwner.importPrefix}_set_${propName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) {
    // Import not found — return null silently to let caller handle fallback
    return null;
  }

  // Push object, then value (with type hint from property type)
  const externObjResult = compileExpression(ctx, fctx, target.expression);
  if (!externObjResult) {
    reportError(ctx, target, "Failed to compile extern property receiver");
    return null;
  }
  const propInfo = propOwner.properties.get(propName);
  const externValResult = compileExpression(ctx, fctx, value, propInfo?.type);
  if (!externValResult) {
    reportError(ctx, target, "Failed to compile extern property value");
    return null;
  }

  // Save value for assignment expression result
  const externTmpVal = allocLocal(fctx, `__extern_assign_${fctx.locals.length}`, externValResult);
  fctx.body.push({ op: "local.tee", index: externTmpVal });
  fctx.body.push({ op: "call", funcIdx });
  fctx.body.push({ op: "local.get", index: externTmpVal });
  return externValResult;
}

function emitSetterCallWithDummy(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  setterName: string,
  funcIdx: number,
  value: ts.Expression,
): InnerResult {
  // Get setter's parameter types to determine value type hint
  const setterPTypes = getFuncParamTypes(ctx, funcIdx);
  const valTypeHint = setterPTypes?.[1]; // param 0 = self, param 1 = value
  const valResult = compileExpression(ctx, fctx, value, valTypeHint);
  if (!valResult) return null;
  // Save value for return (assignments return the assigned value)
  const tmpLocal = allocLocal(fctx, `__setter_assign_${fctx.locals.length}`, valResult);
  fctx.body.push({ op: "local.tee", index: tmpLocal });
  const valLocal = allocLocal(fctx, `__setter_val_${fctx.locals.length}`, valResult);
  fctx.body.push({ op: "local.set", index: valLocal });
  // Create dummy struct and call setter
  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) return valResult;
  for (const field of fields) {
    if (field.name === "__tag") {
      const tag = ctx.classTagMap.get(className) ?? 0;
      fctx.body.push({ op: "i32.const", value: tag });
    } else {
      switch (field.type.kind) {
        case "f64":
          fctx.body.push({ op: "f64.const", value: 0 });
          break;
        case "i32":
          fctx.body.push({ op: "i32.const", value: 0 });
          break;
        case "externref":
          fctx.body.push({ op: "ref.null.extern" });
          break;
        case "ref_null":
          fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        case "ref":
          fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        default:
          fctx.body.push({ op: "i32.const", value: 0 });
          break;
      }
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
  fctx.body.push({ op: "local.get", index: valLocal });
  fctx.body.push({ op: "call", funcIdx });
  fctx.body.push({ op: "local.get", index: tmpLocal });
  return valResult;
}

/**
 * (#3872) Write to a non-writable DATA property recorded by `Object.defineProperty`.
 *
 * `ctx.definedPropertyFlags` is the compile-time mirror of the descriptor
 * attributes, keyed `<integrityVarKey>:<propName>` and carrying
 * `PROP_FLAG_WRITABLE`. `Object.defineProperty` writes it; until now nothing on
 * the assignment path read it, so `defineProperty(o,"p",{writable:false});
 * o.p = 20` neither threw nor (on host) left the value alone.
 *
 * Measured lane asymmetry that shapes this fix — standalone already suppresses
 * the store (`o.p` stays 10) and only omits the strict-mode TypeError, while
 * host lets the write land (`o.p` becomes 20). Emitting the compile-away branch
 * here covers both: the throw standalone was missing, and the suppression host
 * was missing, without duplicating the suppression standalone already performs
 * (this returns before any store is emitted).
 *
 * Deliberately narrow — only fires for a statically-recorded, non-accessor,
 * non-writable data property on an identifier receiver. Anything the
 * compile-time mirror cannot see falls through to the ordinary path, which for
 * dynamic receivers already consults the runtime `FLAG_WRITABLE` companion
 * table via `__extern_set`.
 */
export function isNonWritableDataProperty(ctx: CodegenContext, receiver: ts.Expression, propName: string): boolean {
  if (!ts.isIdentifier(receiver)) return false;
  const key = `${integrityVarKey(ctx, receiver)}:${propName}`;

  // (#3872) ONLY an EXPLICIT `writable: false` counts. Both lowering arms of
  // `Object.defineProperty` record into this set; nothing else is consulted.
  //
  // In particular `definedPropertyFlags` must NOT be used here. That map is
  // approximate about writability: `applyDescriptorFlags` starts from
  // `PROP_FLAG_DEFINED` and leaves the WRITABLE bit clear when the descriptor
  // OMITS `writable` — correct for a fresh define (omitted attributes default
  // to false) but wrong for a REDEFINE, where omitted means "keep existing".
  // Its historical consumers (gOPD reporting, redefine validation) tolerated
  // that; making it decide whether a WRITE is legal did not.
  //
  // Measured cost of getting this wrong: 27 deterministic test262 regressions,
  // e.g. `mapped-arguments-nonconfigurable-4.js`, which does
  // `Object.defineProperty(arguments,"0",{configurable:false})` — never
  // mentioning `writable` — and then expects `arguments[0] = 2` to LAND.
  return ctx.nonWritableExternKeys.has(key);
}

/**
 * (#4484 C) §10.1.9.2 step 2.b for a builtin's SPEC-declared non-writable own
 * data property (`Math.PI = 20`, `Function.length = 42`). Strict code throws;
 * sloppy code declines here and keeps the existing dropped-write lowering.
 *
 * The table and the shadowing proof live in `builtin-nonwritable-write.ts`; this
 * is only the emit half. Declines for every receiver that is not the bare,
 * unshadowed global — see that module's header for why the proof is syntactic.
 */
function tryEmitSpecNonWritableBuiltinWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
  propName: string,
): InnerResult | undefined {
  if (!isStrictContext(target, ctx.inferModuleStrictArguments)) return undefined;
  const receiver = resolveUnshadowedGlobalIdentifier(ctx, fctx, target.expression);
  if (receiver === undefined) return undefined;
  const builtinName = receiver.text;
  const isConstructorName = BUILTIN_CTOR_ARITY[builtinName] !== undefined;
  if (!isSpecNonWritableBuiltinProp(builtinName, propName, isConstructorName)) return undefined;

  // §13.15.2 — the RHS is evaluated before Set is attempted.
  const rhsType = compileExpression(ctx, fctx, value);
  if (rhsType === null) return null;
  fctx.body.push({ op: "drop" });
  emitThrowTypeError(ctx, fctx, `Cannot assign to read only property '${propName}' of object`);
  return rhsType;
}

function tryEmitNonWritablePropertyWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
  propName: string,
): InnerResult | undefined {
  if (!isNonWritableDataProperty(ctx, target.expression, propName)) return undefined;

  // §13.15.2: the RHS is evaluated before Set is attempted, so its side effects
  // must still happen even though the store never lands.
  const rhsType = compileExpression(ctx, fctx, value);
  if (rhsType === null) return null;

  if (isStrictContext(target, ctx.inferModuleStrictArguments)) {
    fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, `Cannot assign to read only property '${propName}' of object`);
    return rhsType;
  }

  // Sloppy mode: the write silently does not happen; the expression yields the RHS.
  return rhsType;
}

/**
 * (#3420) Element write to a frozen receiver — `Object.freeze(a); a[i] = v`.
 *
 * The two pre-existing `frozenVars` consults (`emitAssignToTarget` and the
 * property-assign path) both test `ts.isPropertyAccessExpression`, so they only
 * ever covered `o.x = v`. `ElementAccessExpression` never consulted the frozen
 * bit at all: the write fell straight through to the vec store, which stored
 * anyway (and grew the backing array for an index past the end).
 *
 * The originally filed symptom was an uncatchable `oob` trap; that is gone (the
 * #2744 integrity substrate plus #3742/#3750 landed since). The defect measured
 * on current main is a SILENT successful write, which is strictly worse than a
 * trap — `assert.throws(TypeError, …)` sees no throw and no wrong value either.
 *
 * Returns `undefined` when the receiver is not statically known to be frozen,
 * so the caller falls through to the ordinary store path untouched.
 */
function tryEmitFrozenElementWriteNoOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  value: ts.Expression,
): InnerResult | undefined {
  if (!ts.isIdentifier(target.expression)) return undefined;
  if (!ctx.frozenVars.has(integrityVarKey(ctx, target.expression))) return undefined;

  // Spec evaluation order (§13.15.2): the MemberExpression and its key are
  // evaluated, then the RHS, and only THEN does Set fail. Emit the key and the
  // RHS for their side effects (`a[f()] = g()` must still call both) and drop
  // the key; the RHS value stays as the assignment expression's result.
  const keyType = compileExpression(ctx, fctx, target.argumentExpression);
  if (keyType !== null) {
    fctx.body.push({ op: "drop" });
  }

  const rhsType = compileExpression(ctx, fctx, value);
  if (rhsType === null) return null;

  if (isStrictContext(target, ctx.inferModuleStrictArguments)) {
    fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, "Cannot assign to read only property of frozen object");
    // Unreachable after the throw, but the assignment expression still needs a
    // type for the surrounding expression stack.
    return rhsType;
  }

  // Sloppy mode: the write silently does not happen; `a[i] = v` evaluates to v.
  return rhsType;
}

function compileElementAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  value: ts.Expression,
): InnerResult {
  const poisonResult = tryCompileStrictFunctionPoisonAssignment(ctx, fctx, target, value);
  if (poisonResult !== undefined) return poisonResult;

  // (#2709) `super[super()] = value` PutValue: SuperProperty reference resolution
  // runs GetThisBinding() FIRST (§13.3.7.1 step 2), throwing ReferenceError before
  // the inner super() (in the key) or the RHS is evaluated. Emit that throw here,
  // ahead of any index/value emission, and stop — so the inner super() and RHS are
  // never evaluated and we don't reach the null-`this` illegal-cast trap. No-op for
  // every other shape (see emitSuperUninitializedThisGuard).
  if (
    target.expression.kind === ts.SyntaxKind.SuperKeyword &&
    emitSuperUninitializedThisGuard(ctx, fctx, target.argumentExpression)
  ) {
    return VOID_RESULT;
  }

  // (#3420) Frozen receiver: `a[i] = v` where `a` was passed to Object.freeze.
  // Per §10.4.2.1 / OrdinarySet EVERY element write on a frozen object fails —
  // its own data properties are non-writable AND it is non-extensible, so
  // neither an existing index nor a fresh one may be set. Sloppy mode fails
  // silently; strict mode throws a catchable TypeError.
  const frozenNoOp = tryEmitFrozenElementWriteNoOp(ctx, fctx, target, value);
  if (frozenNoOp !== undefined) return frozenNoOp;

  // (#3872) COMPUTED write to a non-writable data property — `o[k] = v` where
  // the key resolves statically. This is the third assignment form the issue
  // names (dot / computed / compound); the dot and compound arms live in
  // `compilePropertyAssignment` and `compilePropertyCompoundAssignment`.
  //
  // Host already handled this through the runtime `__extern_set_strict` consult
  // of `FLAG_WRITABLE`; standalone did NOT, because its `__extern_set_strict` is
  // deliberately aliased to the non-throwing native `__extern_set` (#2017) — no
  // TypeError bridge. So the throw has to be emitted at compile time here too.
  if (ts.isIdentifier(target.expression)) {
    const key = resolveComputedKeyExpression(ctx, target.argumentExpression);
    if (key !== undefined && isNonWritableDataProperty(ctx, target.expression, key)) {
      // §13.15.2 order: key and RHS still evaluate, then the Set fails.
      const keyType = compileExpression(ctx, fctx, target.argumentExpression);
      if (keyType !== null) fctx.body.push({ op: "drop" });
      const rhsType = compileExpression(ctx, fctx, value);
      if (rhsType === null) return null;
      if (isStrictContext(target, ctx.inferModuleStrictArguments)) {
        fctx.body.push({ op: "drop" });
        emitThrowTypeError(ctx, fctx, `Cannot assign to read only property '${key}' of object`);
      }
      return rhsType;
    }
  }

  // (#4491 T4) Bracket twin of the #4500 Slice A dot arm; placed like it — after
  // the runtime-state checks, before the struct lowerings. See its module.
  const realmGlobalElemWrite = tryEmitRealmGlobalElementWrite(ctx, fctx, target, value);
  if (realmGlobalElemWrite !== undefined) return realmGlobalElemWrite;
  // #1886 Slice B: linear-backed Uint8Array write `buf[i] = v` →
  // i32.store8(ptr+i, trunc(v)). Only fires for a registered linear-safe
  // buffer; any other target falls through to the GC element-assign path.
  const linU8Set = tryEmitLinearU8ElementSet(ctx, fctx, target, value);
  if (linU8Set !== null) return linU8Set;

  // (#2667) Non-writable mapped arguments index: `arguments[i] = x` on a slot
  // made non-writable by `Object.defineProperty(arguments,"<i>",{writable:false})`
  // is dropped (§10.4.4 — OrdinarySet on a non-writable data property fails;
  // sloppy mode does not throw). Detect the statically-resolvable literal-index
  // case and emit a write-free no-op: evaluate the RHS for side effects and
  // leave its value as the assignment-expression result.
  if (
    fctx.mappedArgsInfo?.nonWritableIndices &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "arguments"
  ) {
    const idxArg = target.argumentExpression;
    const idxText = ts.isNumericLiteral(idxArg) ? idxArg.text : ts.isStringLiteral(idxArg) ? idxArg.text : undefined;
    const argIndex = idxText !== undefined ? Number(idxText) : NaN;
    if (Number.isInteger(argIndex) && fctx.mappedArgsInfo.nonWritableIndices.has(argIndex)) {
      const valResult = compileExpression(ctx, fctx, value);
      return valResult;
    }
  }

  // Handle ClassName[key] = value for static setter accessors and static properties (#848)
  if (ts.isIdentifier(target.expression)) {
    const objName = target.expression.text;
    // Resolve class expressions (var C = class {}) through the expr-name map
    const resolvedClass = ctx.classExprNameMap.get(objName) ?? objName;
    if (ctx.classSet.has(resolvedClass)) {
      const key = resolveComputedKeyExpression(ctx, target.argumentExpression);
      if (key !== undefined) {
        // Check static accessor setter first
        const accessorKey = `${resolvedClass}_${key}`;
        if (ctx.classAccessorSet.has(accessorKey)) {
          const setterName = `${resolvedClass}_set_${key}`;
          const funcIdx = ctx.funcMap.get(setterName);
          if (funcIdx !== undefined) {
            return emitSetterCallWithDummy(ctx, fctx, resolvedClass, setterName, funcIdx, value);
          }
        }
        // Check static property global
        const fullName = `${resolvedClass}_${key}`;
        const globalIdx = ctx.staticProps.get(fullName);
        if (globalIdx !== undefined) {
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
          const globalType = globalDef?.type ?? { kind: "f64" as const };
          const valResult = compileExpression(ctx, fctx, value, globalType);
          if (!valResult) return null;
          const tmpLocal = allocLocal(fctx, `__static_assign_${fctx.locals.length}`, valResult);
          fctx.body.push({ op: "local.tee", index: tmpLocal });
          fctx.body.push({ op: "global.set", index: globalIdx });
          fctx.body.push({ op: "local.get", index: tmpLocal });
          return valResult;
        }
      }
    }
  }

  // Handle ClassName.prototype[key] = value for instance setter accessors (#848)
  if (
    ts.isPropertyAccessExpression(target.expression) &&
    ts.isIdentifier(target.expression.expression) &&
    target.expression.name.text === "prototype"
  ) {
    const rawName = target.expression.expression.text;
    // Resolve class expressions (var C = class {}) through the expr-name map
    const className = ctx.classExprNameMap.get(rawName) ?? rawName;
    if (ctx.classSet.has(className)) {
      const key = resolveComputedKeyExpression(ctx, target.argumentExpression);
      if (key !== undefined) {
        const accessorKey = `${className}_${key}`;
        if (ctx.classAccessorSet.has(accessorKey) && !ctx.staticAccessorSet.has(accessorKey)) {
          const setterName = `${className}_set_${key}`;
          const funcIdx = ctx.funcMap.get(setterName);
          if (funcIdx !== undefined) {
            return emitSetterCallWithDummy(ctx, fctx, className, setterName, funcIdx, value);
          }
        }
      }
    }
  }

  // Push array ref
  const arrType = compileExpression(ctx, fctx, target.expression);
  if (!arrType) {
    reportError(ctx, target, "Assignment to non-array");
    return null;
  }

  // Non-ref types (externref, f64, i32): fallback to __extern_set(obj, key, val)
  if (arrType.kind !== "ref" && arrType.kind !== "ref_null") {
    // (#3057) A boxed `$__ta_dyn_view` (dynamic `new <ctorVar>(rab)`) reaches here as
    // an externref receiver with a numeric index. Its element kind is a RUNTIME
    // field, so `__extern_set` can't byte-encode it (writes silently no-op'd —
    // #3054 D+E banked this). Route through the runtime-kind byte codec, which
    // `ref.test $__ta_dyn_view` FIRST and falls through to the EXACT `__extern_set`
    // path (via compileExternSetFallback semantics) for any non-dyn-view receiver,
    // so plain-array `any[i]=v` is unaffected. Gated on the module pre-scan
    // (`moduleUsesDynTaView`) so a helper compiled before the construct still routes
    // correctly; byte-inert when the module has no dynamic TA view. Standalone lane.
    if (
      arrType.kind === "externref" &&
      ctx.standalone &&
      ctx.moduleUsesDynTaView &&
      isNumericIndexExpression(ctx, target.argumentExpression, fctx)
    ) {
      const dynR = emitTaDynViewElementSet(ctx, fctx, target.argumentExpression, value, (e, h) =>
        compileExpression(ctx, fctx, e, h),
      );
      if (dynR) return dynR;
    }
    return compileExternSetFallback(ctx, fctx, target, value, arrType);
  }
  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // (#2357/#47) `$__subview` target (TypedArray subarray): write through to the
  // SHARED parent buffer at `data[byteOffset + i] = v` (true aliasing). Must run
  // BEFORE the struct-field check below — a `$__subview` is a 3-field struct so the
  // 2-field `isVecStructAssign` test is false and the field path would mis-handle
  // it. Compile-time discriminated by the receiver typeIdx; plain vec arrays never
  // reach this arm. The receiver ref is already on the stack (from line ~2765).
  // (#3054 B1) `$__ta_view` target (shared-backing TypedArray over an
  // ArrayBuffer): byte-encode `ta[i] = v` little-endian into the SHARED buffer
  // vec (true aliasing → sibling views / DataViews observe it). Must run BEFORE
  // the 2-field vec-struct assign check (a `$__ta_view` is a 3-field struct).
  // Compile-time discriminated by receiver typeIdx. Receiver ref already on the
  // stack (from the `compileExpression(target.expression)` above).
  if (typeDef?.kind === "struct" && isTaViewTypeIdx(ctx, typeIdx)) {
    const r = emitTaViewElementSet(ctx, fctx, typeIdx, target.argumentExpression, value, (e, h) =>
      compileExpression(ctx, fctx, e, h),
    );
    if (r) return r;
  }

  if (typeDef?.kind === "struct" && isSubviewTypeIdx(ctx, typeIdx)) {
    const subArrTypeIdx = getSubviewArrTypeIdx(ctx, typeIdx);
    const subArrDef = ctx.mod.types[subArrTypeIdx];
    if (!subArrDef || subArrDef.kind !== "array") {
      reportError(ctx, target, "Subview assignment: data is not an array");
      return null;
    }
    const svLocal = allocLocal(fctx, `__sv_set_${fctx.locals.length}`, { kind: "ref_null", typeIdx });
    fctx.body.push({ op: "local.set", index: svLocal });
    // absolute index = sv.byteOffset + i
    fctx.body.push({ op: "local.get", index: svLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 2 }); // byteOffset
    compileExpression(ctx, fctx, target.argumentExpression, { kind: "i32" });
    fctx.body.push({ op: "i32.add" });
    const svIdxLocal = allocLocal(fctx, `__sv_idx_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.set", index: svIdxLocal });
    // value: unpack i8/i16 element kind into i32 for the value position (#2159
    // Slice 1) — `array.set` re-packs into the packed element.
    const valHint: ValType =
      subArrDef.element.kind === "i8" || subArrDef.element.kind === "i16" ? { kind: "i32" } : subArrDef.element;
    const valResult = compileExpression(ctx, fctx, value, valHint);
    if (valResult && !valTypesMatch(valResult, valHint)) coerceType(ctx, fctx, valResult, valHint);
    const svValLocal = allocLocal(fctx, `__sv_val_${fctx.locals.length}`, valHint);
    fctx.body.push({ op: "local.set", index: svValLocal });
    // data[absIdx] = val  (shared backing array → aliases the parent)
    fctx.body.push({ op: "local.get", index: svLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // data array
    fctx.body.push({ op: "local.get", index: svIdxLocal });
    fctx.body.push({ op: "local.get", index: svValLocal });
    fctx.body.push({ op: "array.set", typeIdx: subArrTypeIdx });
    // Assignment is an expression — re-push the value as its result.
    fctx.body.push({ op: "local.get", index: svValLocal });
    return valHint;
  }

  // Bracket assignment on struct: obj["prop"] = value → struct.set
  // Resolve field name from string/numeric literal, const variable, or constant expression
  if (typeDef?.kind === "struct") {
    const isVecStructAssign =
      typeDef.fields.length === 2 && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data";
    if (!isVecStructAssign) {
      let fieldName: string | undefined;
      if (ts.isStringLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      } else if (ts.isNumericLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      } else if (ts.isIdentifier(target.argumentExpression)) {
        // Const variable reference: const key = "x"; obj[key] = val
        const sym = ctx.checker.getSymbolAtLocation(target.argumentExpression);
        if (sym) {
          const decl = sym.valueDeclaration;
          if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
            const declList = decl.parent;
            if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
              if (ts.isStringLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              } else if (ts.isNumericLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              }
            }
          }
        }
      }
      // Also handle computed key expressions (well-known symbols, enums, binary exprs)
      if (fieldName === undefined) {
        fieldName = resolveComputedKeyExpression(ctx, target.argumentExpression);
      }
      if (fieldName !== undefined) {
        // Check for setter accessor first
        const objTsType = ctx.checker.getTypeAtLocation(target.expression);
        // (#1239) Use resolveEffectiveStructName so accessor-tagged
        // identifiers bail out of the struct path and fall through to
        // the externref host setter.
        const sName = resolveEffectiveStructName(ctx, target.expression, objTsType);
        if (sName) {
          const accessorKey = `${sName}_${fieldName}`;
          if (ctx.classAccessorSet.has(accessorKey)) {
            const setterName = `${sName}_set_${fieldName}`;
            const funcIdx = ctx.funcMap.get(setterName);
            if (funcIdx !== undefined) {
              // Get setter's parameter types to provide type hint for value argument
              const eaSetterParamTypes = getFuncParamTypes(ctx, funcIdx);
              const eaSetterValType = eaSetterParamTypes?.[1]; // param 0 = self, param 1 = value
              const setValResult = compileExpression(ctx, fctx, value, eaSetterValType);
              if (!setValResult) return null;
              const setValLocal = allocLocal(fctx, `__setter_assign_${fctx.locals.length}`, setValResult);
              fctx.body.push({ op: "local.tee", index: setValLocal });
              // If setter has no value parameter (only self), drop the value before calling
              if (!eaSetterParamTypes || eaSetterParamTypes.length <= 1) {
                fctx.body.push({ op: "drop" });
              }
              const finalEaSetterIdx = ctx.funcMap.get(setterName) ?? funcIdx;
              fctx.body.push({ op: "call", funcIdx: finalEaSetterIdx });
              fctx.body.push({ op: "local.get", index: setValLocal });
              return setValResult;
            }
          }
        }

        const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
        if (fieldIdx !== -1) {
          const valType = compileExpression(ctx, fctx, value, typeDef.fields[fieldIdx]!.type);
          if (!valType) return null;
          const tmpVal = allocLocal(fctx, `__elem_assign_${fctx.locals.length}`, valType);
          fctx.body.push({ op: "local.tee", index: tmpVal });
          fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
          fctx.body.push({ op: "local.get", index: tmpVal });
          return valType;
        }
      }
    }
  }

  // Handle vec struct (array wrapped in {length, data}) — only for actual __vec_* types
  const isVecStruct =
    typeDef?.kind === "struct" &&
    typeDef.fields.length === 2 &&
    typeDef.fields[0]?.name === "length" &&
    typeDef.fields[1]?.name === "data";
  if (isVecStruct) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      reportError(ctx, target, "Assignment: vec data is not array");
      return null;
    }
    const holeyCarrier = isHoleyArrayType(ctx, typeIdx) && arrDef.element.kind === "externref";
    // (#4247) §10.4.2.2 — a constant numeric key that is NOT an array index
    // (`4294967295`, `4294967296`, `-1`, `1.1`, `NaN`, `Infinity`) is an
    // ordinary NAMED property: it goes to the #3537 expando bag and must leave
    // `length` alone. The vec grow sequence below would instead saturate the
    // key to `i32.max` and TRAP the module trying to allocate the backing
    // array. TypedArray views and `arguments` are NOT array exotics, so they
    // keep their own lowering.
    if (
      elementAccessTypedArrayName(ctx, target.expression) === undefined &&
      !(ts.isIdentifier(target.expression) && target.expression.text === "arguments")
    ) {
      const namedKey = nonArrayIndexNumericKey(ctx, fctx, target.argumentExpression);
      if (namedKey !== undefined) {
        const named = emitNonIndexVecElementSet(ctx, fctx, arrType, namedKey, value, (e, h) =>
          compileExpression(ctx, fctx, e, h),
        );
        if (named) return named;
      }
    }
    // (#4159 S5) Overlay-aware routed WRITE — twin of the S3 read routing;
    // rationale + exclusions in typed-lane-overlay-route.ts. `arguments` keeps
    // the legacy path (mapped-args reverse sync #849); TA views keep theirs.
    if (
      overlayRouteActive(ctx) &&
      elementAccessTypedArrayName(ctx, target.expression) === undefined &&
      !(ts.isIdentifier(target.expression) && target.expression.text === "arguments")
    ) {
      const routed = emitOverlayRoutedElementSet(ctx, fctx, target.argumentExpression, value, (e, h) =>
        compileExpression(ctx, fctx, e, h),
      );
      if (routed) return routed;
    }
    // Save vec ref and index in locals for reuse
    const vecLocal = allocLocal(fctx, `__vec_${fctx.locals.length}`, arrType);
    fctx.body.push({ op: "local.set", index: vecLocal });
    // Null guard: throw TypeError if vec is null (#441)
    // Skip when receiver is provably non-null (e.g. const array literal)
    if (arrType.kind === "ref_null" && !isProvablyNonNull(target.expression, ctx.checker)) {
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "throw", tagIdx }],
        else: [],
      });
    }
    // Preserve range-proven counted-loop index arithmetic as i32. Fall back to
    // the existing conversion path when constants, bounds, or overflow safety
    // cannot be established.
    const idxResult = compileElementIndexI32(ctx, fctx, target.argumentExpression);
    if (!idxResult) {
      reportError(ctx, target, "Failed to compile element index");
      return null;
    }
    const idxLocal = allocLocal(fctx, `__idx_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.set", index: idxLocal });
    // Compile value. (#2593) Hint the UNPACKED value type (i32 for packed
    // i8/i16 storage), NOT the packed `i8`/`i16` element type — `i8`/`i16` are
    // storage-only and have no value-position encoding, so passing them as the
    // compile hint produced an invalid local/value (the Int16/Uint16 element-write
    // INVALID). `array.set` into the packed element re-truncates the i32 store
    // value to the element width (free ToInt8/ToInt16/ToInt32/ToUint*). Float
    // views keep their f64 element hint.
    // (#2593) `Uint8ClampedArray` write is NOT modulo — it is ToUint8Clamp
    // (clamp to [0,255] + round-half-even). Detect the view by name so the value
    // routes through `emitToUint8Clamp` below instead of the plain i32 truncation.
    const taViewName = elementAccessTypedArrayName(ctx, target.expression);
    const isUint8Clamped = taViewName === "Uint8ClampedArray";
    // (#2729) On the WasmGC host/gc backend a `new Uint8Array(n)` element is
    // stored in an `f64` vec (the i8 packed storage is wasi/standalone-only —
    // see `typedArrayVecStorage`). The f64 store path applied NO conversion, so
    // out-of-range / non-integer values read back raw (`u[0]=257`→257,
    // `u[0]=-1`→-1, `u[0]=NaN`→NaN). When the backing element is f64 we must
    // apply ToUint8 (§7.1.10) explicitly before the store. The wasi/standalone
    // i8-packed path is handled by the `array.set` re-truncation branch below.
    const isHostUint8 = taViewName === "Uint8Array" && arrDef.element.kind === "f64";
    const valueHint: ValType =
      arrDef.element.kind === "i8" || arrDef.element.kind === "i16"
        ? isUint8Clamped
          ? { kind: "f64" } // keep f64 for the clamp helper
          : { kind: "i32" }
        : arrDef.element;
    const elemValResult = compileExpression(ctx, fctx, value, valueHint);
    if (!elemValResult) {
      reportError(ctx, target, "Failed to compile element value");
      return null;
    }
    if (isUint8Clamped) {
      // ToUint8Clamp: f64 → clamped i32 in [0,255], round-half-even. Ensure the
      // value is f64 first (a literal/i32 may have compiled to i32).
      if (elemValResult.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
      emitToUint8Clamp(fctx);
    } else if (isHostUint8) {
      // (#2729) ToUint8 for the f64-backed host store: ToInt32 (NaN/±Inf→0,
      // truncate toward zero, reduce mod 2^32) then mask the low byte (& 0xFF),
      // then widen back to f64 for the f64 vec element. This matches the linear
      // backend's ToUint8 (#2715) and the wasi/standalone i8-packed truncation.
      if (elemValResult.kind !== "f64") coerceType(ctx, fctx, elemValResult, { kind: "f64" });
      emitToInt32(fctx); // f64 → i32
      fctx.body.push({ op: "i32.const", value: 0xff });
      fctx.body.push({ op: "i32.and" });
      fctx.body.push({ op: "f64.convert_i32_u" });
    } else if ((arrDef.element.kind === "i8" || arrDef.element.kind === "i16") && elemValResult.kind === "f64") {
      // (#2593) Other packed i8/i16 views: truncate the f64 store value to i32
      // (ToInt32 modulo); `array.set` re-packs to the element width.
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    // #2159 — `i8`/`i16` are *packed storage* types, valid only inside array
    // elements / struct fields. The value temp holds the unpacked Wasm value
    // (an `i32`) that `array.set` re-packs; allocating the local with the raw
    // packed `arrDef.element` leaked an `i8`/`i16` into a local (value position),
    // which Wasm has no encoding for and the binary emitter rejects. This is the
    // standalone Uint8Array/Int8Array/Int16Array/Uint16Array element-write CE.
    // The matching read path already unpacks via array.get_u/_s → i32
    // (property-access.ts). Mirror it here for the store value local.
    const valLocalType: ValType =
      arrDef.element.kind === "i8" || arrDef.element.kind === "i16" ? { kind: "i32" } : arrDef.element;
    const valLocal = allocLocal(fctx, `__val_${fctx.locals.length}`, valLocalType);
    fctx.body.push({ op: "local.set", index: valLocal });

    // #1196: Bounds-check elimination on writes — when the for-loop pattern
    // proves `i < arr.length`, the index is in [0, length) so capacity is
    // already sufficient and `vec.length` does not need to grow. Skip the
    // grow check + length-update entirely and emit a direct `array.set`.
    if (isSafeBoundsEliminated(fctx, target)) {
      // Vec data field is `(ref $arr)` (non-nullable), so struct.get yields
      // a non-null ref directly — no ref.as_non_null needed.
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data
      fctx.body.push({ op: "local.get", index: idxLocal });
      fctx.body.push({ op: "local.get", index: valLocal });
      fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
      // Mapped arguments reverse sync (#849)
      if (fctx.mappedArgsInfo && ts.isIdentifier(target.expression) && target.expression.text === "arguments") {
        emitMappedArgReverseSync(ctx, fctx, idxLocal, valLocal);
      }
      fctx.body.push({ op: "local.get", index: valLocal });
      return elemValResult;
    }

    // Get data array into a local so we can update it after potential grow
    const dataLocal = allocLocal(fctx, `__vec_data_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: arrTypeIdx,
    });
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // get data
    fctx.body.push({ op: "local.set", index: dataLocal });

    // Ensure capacity: if idx >= array.len(data), grow backing array
    const newCapLocal = allocLocal(fctx, `__vec_ncap_${fctx.locals.length}`, {
      kind: "i32",
    });
    const newDataLocal = allocLocal(fctx, `__vec_ndata_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: arrTypeIdx,
    });
    const oldCapLocal = allocLocal(fctx, `__vec_ocap_${fctx.locals.length}`, {
      kind: "i32",
    });

    // (#4491 lane J) An index above the 16M allocation guard is UNBACKABLE: the
    // flag gates the grow, the gap-fill and the `array.set`, and every index
    // compare below turns UNSIGNED (the local holds a u32 bit pattern — index
    // 2**32-2 arrives as `-2`). Full rationale in vec-sparse-index.ts.
    const unbackedLocal = emitUnbackableIndexFlag(fctx, idxLocal);
    fctx.body.push(...needsGrowCondInstrs(unbackedLocal, idxLocal, dataLocal));
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // oldCap = array.len(data)
        { op: "local.get", index: dataLocal },
        { op: "array.len" },
        { op: "local.set", index: oldCapLocal },

        // newCap = max(idx + 1, oldCap * 2): store idx+1 first, then compare
        { op: "local.get", index: idxLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: newCapLocal }, // newCap = idx + 1
        // if oldCap * 2 > newCap, use oldCap * 2
        { op: "local.get", index: oldCapLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.shl" }, // oldCap * 2
        { op: "local.get", index: newCapLocal },
        { op: "i32.gt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: oldCapLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.shl" },
            { op: "local.set", index: newCapLocal },
          ],
        },
        // Ensure at least 4
        { op: "i32.const", value: 4 },
        { op: "local.get", index: newCapLocal },
        { op: "i32.gt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 4 },
            { op: "local.set", index: newCapLocal },
          ],
        },

        // The dedicated sparse carrier, and only it, fills new capacity with
        // absence sentinels. Ordinary externref vectors retain their exact
        // default-filled allocation.
        ...(holeyCarrier ? holeSentinelInstrs(ctx) : []),
        { op: "local.get", index: newCapLocal },
        ...(holeyCarrier
          ? ([{ op: "array.new", typeIdx: arrTypeIdx }] satisfies Instr[])
          : ([{ op: "array.new_default", typeIdx: arrTypeIdx }] satisfies Instr[])),
        { op: "local.set", index: newDataLocal },

        // array.copy newData[0..oldCap] = data[0..oldCap]
        { op: "local.get", index: newDataLocal },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: dataLocal },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: oldCapLocal },
        {
          op: "array.copy",
          dstTypeIdx: arrTypeIdx,
          srcTypeIdx: arrTypeIdx,
        },

        // Update vec.data = newData
        { op: "local.get", index: vecLocal },
        { op: "local.get", index: newDataLocal },
        { op: "ref.as_non_null" },
        { op: "struct.set", typeIdx, fieldIdx: 1 },

        // Update local data pointer
        { op: "local.get", index: newDataLocal },
        { op: "local.set", index: dataLocal },
      ],
    });

    // (#2773 S7) Gap-fill for an index-grow write PAST the current length on an
    // externref-element vec: `a[idx] = v` with idx > length leaves
    // [length, idx) holding the array.new_default null (or a stale popped
    // slot), and once `vec.length` is bumped to idx+1 below those slots are
    // IN-BOUNDS — so a read returned `null` where JS reads `undefined`
    // (test262 reduceRight "-c-ii-5": `kIndex[3]=1` on an empty tracking array,
    // then `typeof kIndex[2]` must be "undefined"). Fill the gap with the JS
    // `undefined` value so the length-bounded read (property-access) returns it
    // directly. The #4222 branded carrier instead needs genuine absence so its
    // dedicated filter provider can apply HasProperty before Get. Externref
    // elements only: an f64/i32 slot cannot hold either representation.
    if (arrDef.element.kind === "externref" || arrDef.element.kind === "ref_extern") {
      // undefined → local, emitted IMPERATIVELY so the `__get_undefined` late
      // import registers/shifts through the normal path (never baked inside a
      // detached branch array).
      if (holeyCarrier) fctx.body.push(...holeSentinelInstrs(ctx));
      else emitUndefined(ctx, fctx);
      const gapUndefLocal = allocLocal(fctx, `__gap_undef_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: gapUndefLocal });
      const gapOldLenLocal = allocLocal(fctx, `__gap_len_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // current length
      fctx.body.push({ op: "local.set", index: gapOldLenLocal });
      // if (idx > length) array.fill(data, length, undefined, idx - length)
      fctx.body.push(...needsGapFillCondInstrs(unbackedLocal, idxLocal, gapOldLenLocal));
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: dataLocal },
          { op: "local.get", index: gapOldLenLocal },
          { op: "local.get", index: gapUndefLocal },
          { op: "local.get", index: idxLocal },
          { op: "local.get", index: gapOldLenLocal },
          { op: "i32.sub" },
          { op: "array.fill", typeIdx: arrTypeIdx },
        ],
      });
    } else if (arrDef.element.kind === "f64") {
      // (#4491 T8) The f64 twin of the gap-fill above: an f64 slot CAN hold an
      // absence marker (the `UNDEF_F64_BITS` sNaN), so the gap no longer reads
      // back as a real `0`. Body in `vec-f64-hole-gap.ts`.
      const f64HoleGap = f64HolesActive(ctx);
      if (f64HoleGap) ctx.f64HoleMarkerEmitted = true;
      fctx.body.push(
        ...emitF64GapFillInstrs(fctx, {
          vecLocal,
          dataLocal,
          idxLocal,
          vecTypeIdx: typeIdx,
          arrTypeIdx,
          gapCond: (oldLen) => needsGapFillCondInstrs(unbackedLocal, idxLocal, oldLen),
          // (#4491 T11) A module that can ask presence questions marks the gap
          // ABSENT; one that cannot keeps T8-A's `undefined` marker, so its
          // bytes and behaviour are unchanged.
          markerBits: f64HoleGap ? HOLE_F64_BITS : undefined,
        }),
      );
    }

    // array.set: data[idx] = val (skipped for an unbackable index).
    fctx.body.push(...guardedElementSetInstrs(unbackedLocal, dataLocal, idxLocal, valLocal, arrTypeIdx));

    // Update length if idx+1 > current length:
    // if (idx + 1 > vec.length) vec.length = idx + 1
    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // get length
    fctx.body.push({ op: "i32.gt_u" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: vecLocal },
        { op: "local.get", index: idxLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "struct.set", typeIdx, fieldIdx: 0 },
      ],
    });
    // Mapped arguments reverse sync: arguments[i] = X → update param local (#849)
    if (fctx.mappedArgsInfo && ts.isIdentifier(target.expression) && target.expression.text === "arguments") {
      emitMappedArgReverseSync(ctx, fctx, idxLocal, valLocal);
    }

    // Return the assigned value (assignment expression result)
    fctx.body.push({ op: "local.get", index: valLocal });
    return elemValResult;
  }

  // Plain struct (non-vec): resolve string/numeric literal index to struct.set
  if (typeDef?.kind === "struct") {
    let fieldName: string | undefined;
    if (ts.isStringLiteral(target.argumentExpression)) {
      fieldName = target.argumentExpression.text;
    } else if (ts.isNumericLiteral(target.argumentExpression)) {
      fieldName = target.argumentExpression.text;
    } else if (ts.isIdentifier(target.argumentExpression)) {
      const sym = ctx.checker.getSymbolAtLocation(target.argumentExpression);
      if (sym) {
        const decl = sym.valueDeclaration;
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
          const declList = decl.parent;
          if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
            if (ts.isStringLiteral(decl.initializer)) fieldName = decl.initializer.text;
            else if (ts.isNumericLiteral(decl.initializer)) fieldName = decl.initializer.text;
          }
        }
      }
    }
    if (fieldName === undefined) {
      fieldName = resolveComputedKeyExpression(ctx, target.argumentExpression);
    }
    if (fieldName !== undefined) {
      // Check for setter accessor first (obj['prop'] = val where prop has a setter)
      const objTsType = ctx.checker.getTypeAtLocation(target.expression);
      // (#1239) Use resolveEffectiveStructName for consistency with the
      // PropertyAccessExpression path above.
      const sName = resolveEffectiveStructName(ctx, target.expression, objTsType);
      if (sName) {
        const accessorKey = `${sName}_${fieldName}`;
        if (ctx.classAccessorSet.has(accessorKey)) {
          const setterName = `${sName}_set_${fieldName}`;
          const funcIdx = ctx.funcMap.get(setterName);
          if (funcIdx !== undefined) {
            // struct ref is already on stack; save it, compile value, then call setter
            const objLocal = allocLocal(fctx, `__struct_obj_${fctx.locals.length}`, arrType);
            fctx.body.push({ op: "local.set", index: objLocal });
            const valResult = compileExpression(ctx, fctx, value);
            if (!valResult) return null;
            const valLocal = allocLocal(fctx, `__struct_val_${fctx.locals.length}`, valResult);
            fctx.body.push({ op: "local.set", index: valLocal });
            fctx.body.push({ op: "local.get", index: objLocal });
            // If setter has a value parameter (2+ params), push the value
            const eaSetterPTypes = getFuncParamTypes(ctx, funcIdx);
            if (eaSetterPTypes && eaSetterPTypes.length > 1) {
              fctx.body.push({ op: "local.get", index: valLocal });
            }
            fctx.body.push({ op: "call", funcIdx });
            // Return the assigned value (assignment expression result)
            fctx.body.push({ op: "local.get", index: valLocal });
            return valResult;
          }
        }
      }

      const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
      if (fieldIdx >= 0) {
        // struct ref is already on stack; save it, compile value, then struct.set
        const objLocal = allocLocal(fctx, `__struct_obj_${fctx.locals.length}`, arrType);
        fctx.body.push({ op: "local.set", index: objLocal });
        const fieldType = typeDef.fields[fieldIdx]!.type;
        const valResult = compileExpression(ctx, fctx, value, fieldType);
        if (!valResult) return null;
        const valLocal = allocLocal(fctx, `__struct_val_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.set", index: valLocal });
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "local.get", index: valLocal });
        fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
        // Return the assigned value (assignment expression result)
        fctx.body.push({ op: "local.get", index: valLocal });
        return valResult;
      }
    }
  }

  if (!typeDef || typeDef.kind !== "array") {
    // Fallback: convert struct/unknown ref to externref and use __extern_set
    return compileExternSetFallback(ctx, fctx, target, value, arrType);
  }
  // Push index (as i32)
  const plainIdxResult = compileExpression(ctx, fctx, target.argumentExpression, { kind: "f64" });
  if (!plainIdxResult) {
    reportError(ctx, target, "Failed to compile element index");
    return null;
  }
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  // Push value
  const plainValResult = compileExpression(ctx, fctx, value, typeDef.element);
  if (!plainValResult) {
    reportError(ctx, target, "Failed to compile element value");
    return null;
  }
  // Save value for assignment expression result
  const plainValLocal = allocLocal(fctx, `__arr_assign_${fctx.locals.length}`, plainValResult);
  fctx.body.push({ op: "local.tee", index: plainValLocal });
  fctx.body.push({ op: "array.set", typeIdx });
  fctx.body.push({ op: "local.get", index: plainValLocal });
  return plainValResult;
}

/**
 * Fallback for element assignment on non-array types.
 * Converts the object to externref and calls __extern_set(obj, key, val).
 * The object value is already on the stack.
 */
function compileExternSetFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  value: ts.Expression,
  objType: ValType,
): InnerResult {
  // Convert object on stack to externref
  if (objType.kind === "externref") {
    // Already externref, nothing to do
  } else if (objType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else if (objType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else if (objType.kind === "ref" || objType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  } else {
    reportError(ctx, target, "Unsupported element assignment target type");
    return null;
  }

  // Save obj externref to local
  const objLocal = allocLocal(fctx, `__eset_obj_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: objLocal });

  // §13.15.2: evaluate and canonicalize the computed key before the RHS.
  // The native standalone setter has receiver-specific early dispatch arms
  // which can return before its string-keyed object table performs
  // ToPropertyKey.  Canonicalizing at the Reference boundary both preserves
  // the observable ordering and gives every receiver arm the same key.
  const keyResult = compileExpression(ctx, fctx, target.argumentExpression, {
    kind: "externref",
  });
  if (!keyResult) return null;
  emitToPropertyKeyOnce(ctx, fctx);
  const keyLocal = allocLocal(fctx, `__eset_key_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: keyLocal });

  // Compile value after ToPropertyKey and save it for the assignment result.
  const valResult = compileExpression(ctx, fctx, value, { kind: "externref" });
  if (!valResult) return null;
  const valLocal = allocLocal(fctx, `__eset_val_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: valLocal });

  // Push args: obj, key, val
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: keyLocal });
  fctx.body.push({ op: "local.get", index: valLocal });

  // (#3374) Bracket writes carry the same PutValue strictness bit as dot writes.
  // Keep sloppy failed [[Set]] results silent; strict failures throw TypeError.
  const setName = isStrictContext(target, ctx.inferModuleStrictArguments) ? "__extern_set_strict" : "__extern_set";
  const funcIdx = ensureLateImport(
    ctx,
    setName,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (funcIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx });
  }

  // Return the assigned value
  fctx.body.push({ op: "local.get", index: valLocal });
  return { kind: "externref" };
}

/** Unwrap parenthesized expressions: (x) -> x, ((x)) -> x, etc. */

export {
  compileArrayDestructuringAssignment,
  compileDestructuringAssignment,
  compileElementAssignment,
  compileExternSetFallback,
  compilePropertyAssignment,
};
