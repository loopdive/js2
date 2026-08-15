// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Operator-assignment compilation: logical assignment (&&= ||= ??=) and compound
 * assignment (+= -= *= &= >>= plus the string / native-string += fast paths).
 *
 * Extracted verbatim from assignment.ts (#3266, subtask of #3182) as a pure,
 * behaviour-preserving leaf move. This module owns the `x op= y` lowering; plain
 * `=` assignment and destructuring stay in assignment.ts.
 */
import { ts, forEachChild } from "../../ts-api.js";
import { isBooleanType, isStringType } from "../../checker/type-mapper.js";
import type { FieldDef, Instr, ValType } from "../../ir/types.js";
import { emitBoundsCheckedArrayGet } from "../array-methods.js";
import { tryEmitLinearU8ElementCompound } from "../linear-uint8-codegen.js";
import { emitAnyAdd, emitAnyAddFromExternTemps, emitModulo, emitToInt32 } from "../binary-ops.js";
import { compileWithCompoundAssignment } from "../with-rmw.js";
import { pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  addStringConstantGlobal,
  addStringImports,
  addUnionImports,
  ensureI32Condition,
  localGlobalIdx,
  resolveWasmType,
} from "../index.js";
import { resolveComputedKeyExpression } from "../literals.js";
import { resolveReceiverStruct } from "../fnctor-escape-gate.js";
import { EMIT_COMPOUND_OP_HANDLES, tryEmitTypedThisCompound } from "../typed-this.js"; // (#3683 S2) typed-`this` compound
import { reserveMemberGetDispatch } from "../member-get-dispatch.js";
import {
  emitAlternateStructSetDispatch,
  emitCapturedBoxGlobalRead,
  emitCapturedBoxGlobalWrite,
  emitNullGuardedStructGet,
  getCapturedBoxGlobal,
} from "../property-access.js";
import { coerceType, compileExpression } from "../shared.js";
import { emitBoolToAnyStr, rhsStringForcesConcatLane } from "../string-compound-lane.js";
import { compileStringLiteral, emitBoolToString } from "../string-ops.js";
import { patchStructNewForDynamicField } from "./extern.js";
import {
  classifyPrivateMember,
  emitSuperUninitializedThisGuard,
  emitThrowReferenceError,
  emitThrowTypeError,
  emitWebCompatCallAssignmentTarget,
  getFuncParamTypes,
} from "./helpers.js";
import {
  emitAnyStrToExternrefSlot,
  emitExternrefSlotToAnyStr,
  slotNeedsExternrefBridge,
} from "../native-string-slot-bridge.js";
import { compileComputedMemberKeyAfterBaseGuard, emitToPropertyKeyOnce } from "./computed-member-reference.js";
import { ensureLateImport, flushLateImportShifts, patchStructNewForAddedField } from "./late-imports.js";
import { emitMappedArgParamSync } from "./logical-ops.js";
import { resolveStructNameForExpr } from "./misc.js";
import {
  compileStringBuilderAppend,
  emitStringBuilderAppendCodeUnit,
  getBuilderInfo,
  type StringBuilderInfo,
} from "../string-builder.js";
import { compileExternSetFallback, isNonWritableDataProperty, isStrictContext } from "./assignment.js";

/**
 * Compile logical assignment operators: ??=, ||=, &&=
 *
 * Desugars to value-preserving semantics:
 *   a ??= b  →  if (a is null) a = b; result = a
 *   a ||= b  →  if (!a) a = b; result = a
 *   a &&= b  →  if (a) a = b; result = a
 */
export function compileLogicalAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  // Handle property access logical assignment: obj.prop ??= default
  if (ts.isPropertyAccessExpression(expr.left)) {
    return compilePropertyLogicalAssignment(ctx, fctx, expr.left, expr.right, op);
  }

  // Handle element access logical assignment: arr[i] ||= default
  if (ts.isElementAccessExpression(expr.left)) {
    return compileElementLogicalAssignment(ctx, fctx, expr.left, expr.right, op);
  }

  if (!ts.isIdentifier(expr.left)) {
    reportError(
      ctx,
      expr,
      "Logical assignment only supported for simple identifiers, property access, or element access",
    );
    return null;
  }

  const name = expr.left.text;

  // Resolve the variable storage location
  let storage:
    | { kind: "local"; index: number; type: ValType }
    | { kind: "captured"; index: number; type: ValType }
    | { kind: "capturedBox"; box: { globalIdx: number; refCellTypeIdx: number; valType: ValType }; type: ValType }
    | { kind: "module"; index: number; type: ValType }
    | null = null;

  const localIdx = fctx.localMap.get(name);
  if (localIdx !== undefined) {
    const localType =
      localIdx < fctx.params.length ? fctx.params[localIdx]!.type : fctx.locals[localIdx - fctx.params.length]?.type;
    storage = {
      kind: "local",
      index: localIdx,
      type: localType ?? { kind: "f64" },
    };
  }
  if (!storage) {
    // (#3039) Boxed captured global — read/write THROUGH the ref cell.
    const capturedBoxLogical = getCapturedBoxGlobal(ctx, name);
    if (capturedBoxLogical !== undefined) {
      storage = { kind: "capturedBox", box: capturedBoxLogical, type: capturedBoxLogical.valType };
    }
  }
  if (!storage) {
    const capturedIdx = ctx.capturedGlobals.get(name);
    if (capturedIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
      storage = {
        kind: "captured",
        index: capturedIdx,
        type: globalDef?.type ?? { kind: "f64" },
      };
    }
  }
  if (!storage) {
    const moduleIdx = ctx.moduleGlobals.get(name);
    if (moduleIdx !== undefined) {
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
      storage = {
        kind: "module",
        index: moduleIdx,
        type: globalDef?.type ?? { kind: "f64" },
      };
    }
  }

  if (!storage) {
    // Graceful fallback: compile the RHS for side effects, then return externref
    const rhsFallback = compileExpression(ctx, fctx, expr.right);
    if (rhsFallback) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  const varType = storage.type;

  // Emit: read current value
  // Re-read global index from the map each time, because compiling expressions
  // can trigger addStringConstantGlobal which shifts all global indices.
  const getStorageIndex = () => {
    if (storage!.kind === "local") return storage!.index;
    if (storage!.kind === "captured") return ctx.capturedGlobals.get(name)!;
    return ctx.moduleGlobals.get(name)!;
  };
  const emitGet = () => {
    if (storage!.kind === "capturedBox") {
      emitCapturedBoxGlobalRead(ctx, fctx, storage!.box);
    } else if (storage!.kind === "local") {
      fctx.body.push({ op: "local.get", index: getStorageIndex() });
    } else {
      fctx.body.push({ op: "global.get", index: getStorageIndex() });
    }
  };
  const emitSet = () => {
    if (storage!.kind === "capturedBox") {
      // Value on stack → stash, write through the cell, re-read for the result.
      const tmpVal = allocLocal(fctx, `__box_glog_${fctx.locals.length}`, storage!.box.valType);
      fctx.body.push({ op: "local.set", index: tmpVal });
      emitCapturedBoxGlobalWrite(fctx, storage!.box, tmpVal);
      emitCapturedBoxGlobalRead(ctx, fctx, storage!.box);
    } else if (storage!.kind === "local") {
      fctx.body.push({ op: "local.tee", index: getStorageIndex() });
    } else {
      const idx = getStorageIndex();
      fctx.body.push({ op: "global.set", index: idx });
      fctx.body.push({ op: "global.get", index: idx });
    }
  };

  if (op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    // a ??= b  →  if (a is null/undefined) { a = b }; result = a
    // For value types (i32, i64, f32, f64, etc.), values can never be null/undefined,
    // so just return the current value without evaluating RHS (short-circuit).
    if (!isRefType(varType)) {
      emitGet();
      return varType;
    }
    emitGet();
    // Check null or undefined (JS ??= triggers for both)
    const qqeTmp = allocTempLocal(fctx, varType);
    fctx.body.push({ op: "local.tee", index: qqeTmp });
    fctx.body.push({ op: "ref.is_null" });
    const qqeUndefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
    if (qqeUndefIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: qqeTmp });
      if (varType.kind !== "externref") {
        fctx.body.push({ op: "extern.convert_any" });
      }
      fctx.body.push({ op: "call", funcIdx: qqeUndefIdx });
      fctx.body.push({ op: "i32.or" });
    }
    releaseTempLocal(fctx, qqeTmp);

    // Compile the RHS in a separate body
    const savedBody = pushBody(fctx);
    const nullishRhsResult = compileExpression(ctx, fctx, expr.right, varType);
    if (!nullishRhsResult) {
      fctx.body = savedBody;
      return null;
    }
    emitSet();
    const thenInstrs = fctx.body;

    // Else: just read the current value (it's not null)
    fctx.body = [];
    emitGet();
    const elseInstrs = fctx.body;

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  } else if (op === ts.SyntaxKind.BarBarEqualsToken) {
    // a ||= b  →  if (!a) { a = b }; result = a
    emitGet();
    ensureI32Condition(fctx, varType, ctx);

    // Then (truthy): keep current value
    const savedBody = pushBody(fctx);
    emitGet();
    const thenInstrs = fctx.body;

    // Else (falsy): assign RHS
    fctx.body = [];
    const orRhsResult = compileExpression(ctx, fctx, expr.right, varType);
    if (!orRhsResult) {
      fctx.body = savedBody;
      return null;
    }
    emitSet();
    const elseInstrs = fctx.body;

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  } else {
    // a &&= b  →  if (a) { a = b }; result = a
    emitGet();
    ensureI32Condition(fctx, varType, ctx);

    // Then (truthy): assign RHS
    const savedBody = pushBody(fctx);
    const andRhsResult = compileExpression(ctx, fctx, expr.right, varType);
    if (!andRhsResult) {
      fctx.body = savedBody;
      return null;
    }
    emitSet();
    const thenInstrs = fctx.body;

    // Else (falsy): keep current value
    fctx.body = [];
    emitGet();
    const elseInstrs = fctx.body;

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  }

  return varType;
}

/**
 * Compile logical assignment on property access: obj.prop ??= default, obj.prop ||= default, obj.prop &&= default
 * Uses short-circuit semantics: RHS is only evaluated if the condition is met.
 */
function compilePropertyLogicalAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(target.expression);
  const propName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;

  // Resolve struct type
  const typeName = resolveStructNameForExpr(ctx, fctx, target.expression);
  if (!typeName) {
    // Fallback: treat as externref property access via __extern_get / __extern_set
    return compilePropertyLogicalAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  // Check for accessor properties (get/set) before looking up struct fields
  const accessorKey = `${typeName}_${propName}`;
  if (ctx.classAccessorSet.has(accessorKey)) {
    const getterName = `${typeName}_get_${propName}`;
    const setterName = `${typeName}_set_${propName}`;
    const getterIdx = ctx.funcMap.get(getterName);
    const setterIdx = ctx.funcMap.get(setterName);
    if (getterIdx !== undefined && setterIdx !== undefined) {
      // Compile obj and save to a local for reuse, coercing to getter's self type
      const getterPTypes = getFuncParamTypes(ctx, getterIdx);
      const objResult = compileExpression(ctx, fctx, target.expression, getterPTypes?.[0]);
      if (!objResult) return null;
      const objLocal = allocLocal(fctx, `__logprop_acc_obj_${fctx.locals.length}`, objResult);
      fctx.body.push({ op: "local.set", index: objLocal });

      const propType = ctx.checker.getTypeAtLocation(target);
      const fieldType = resolveWasmType(ctx, propType);

      const emitFieldGet = () => {
        // Re-lookup funcIdx at emission time — addUnionImports may have shifted indices
        const gIdx = ctx.funcMap.get(getterName)!;
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "call", funcIdx: gIdx });
      };
      const emitFieldSet = () => {
        // Re-lookup funcIdx at emission time — addUnionImports may have shifted indices
        const sIdx = ctx.funcMap.get(setterName)!;
        const tmpVal = allocLocal(fctx, `__logprop_acc_val_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.set", index: tmpVal });
        fctx.body.push({ op: "local.get", index: objLocal });
        // If setter has a value parameter (2+ params), push the value
        const logSetterPTypes = getFuncParamTypes(ctx, sIdx);
        if (logSetterPTypes && logSetterPTypes.length > 1) {
          fctx.body.push({ op: "local.get", index: tmpVal });
        }
        fctx.body.push({ op: "call", funcIdx: sIdx });
        fctx.body.push({ op: "local.get", index: tmpVal });
      };

      return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, fieldType, emitFieldGet, emitFieldSet);
    }
  }

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    // Struct name resolved but type not in structMap — fall back to externref path
    return compilePropertyLogicalAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx === -1) {
    // A class may acquire a property dynamically (including through ??=/||=/&&=).
    // Treating an uncollected field as a numeric `undefined` sentinel drops the
    // required GetValue/PutValue and can feed that f64 into a reference-typed
    // receiver slot. Route through the ordinary dynamic property path instead.
    return compilePropertyLogicalAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  const fieldType = fields[fieldIdx]!.type;

  // Compile obj and save to a local for reuse
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  const objLocal = allocLocal(fctx, `__logprop_obj_${fctx.locals.length}`, objResult);
  fctx.body.push({ op: "local.set", index: objLocal });

  // Create helpers that read/write the field
  const emitFieldGet = () => {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
  };
  const emitFieldSet = () => {
    // After RHS is on stack, save it, load obj, load value, struct.set, load value again for result
    const tmpVal = allocLocal(fctx, `__logprop_val_${fctx.locals.length}`, fieldType);
    fctx.body.push({ op: "local.set", index: tmpVal });
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: tmpVal });
    fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
    fctx.body.push({ op: "local.get", index: tmpVal });
  };

  return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, fieldType, emitFieldGet, emitFieldSet);
}

/**
 * Fallback for logical assignment on a property access target when the
 * struct type cannot be resolved statically.
 *
 * Strategy:
 * 1. Compile the object expression to discover its runtime Wasm type.
 * 2. If the result is a struct ref, look up the field by name and use struct.get/struct.set.
 * 3. Otherwise, convert to externref and use __extern_get / __extern_set.
 */
function compilePropertyLogicalAssignmentExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  propName: string,
): ValType | null {
  // Compile the object expression to discover its runtime type
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;

  // --- Path A: The object compiled to a struct ref ---
  if (objResult.kind === "ref" || objResult.kind === "ref_null") {
    const typeIdx = (objResult as { typeIdx: number }).typeIdx;
    const resolvedTypeName = ctx.typeIdxToStructName.get(typeIdx);
    if (resolvedTypeName) {
      const fields = ctx.structFields.get(resolvedTypeName);
      if (fields) {
        let fieldIdx = fields.findIndex((f) => f.name === propName);

        // If the field doesn't exist yet, try to add it dynamically from TS type info
        // but NEVER for class struct types — their fields are fixed at collection time
        if (fieldIdx === -1 && !ctx.classSet.has(resolvedTypeName)) {
          const objTsType = ctx.checker.getTypeAtLocation(target.expression);
          const tsProps = objTsType.getProperties?.();
          if (tsProps) {
            const tsProp = tsProps.find((p) => p.name === propName);
            if (tsProp) {
              const propTsType = ctx.checker.getTypeOfSymbolAtLocation(tsProp, target);
              const propWasmType = resolveWasmType(ctx, propTsType);
              const newField: FieldDef = {
                name: propName,
                type: propWasmType,
                mutable: true,
              };
              fields.push(newField);
              // fields === typeDef.fields (same array ref from structFields map)
              patchStructNewForAddedField(ctx, fctx, typeIdx, propWasmType);
              const typeDef = ctx.mod.types[typeIdx];
              if (typeDef?.kind === "struct" && typeDef.fields !== fields) {
                typeDef.fields.push(newField);
              }
              // Patch existing struct.new instructions to include the new field
              patchStructNewForDynamicField(ctx, typeIdx, propWasmType);
              fieldIdx = fields.length - 1;
            }
          }
        }

        if (fieldIdx !== -1) {
          const fieldType = fields[fieldIdx]!.type;
          const objTmp = allocLocal(fctx, `__logprop_ext_obj_${fctx.locals.length}`, objResult);
          fctx.body.push({ op: "local.set", index: objTmp });

          const emitGet = () => {
            fctx.body.push({ op: "local.get", index: objTmp });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          };
          const emitSet = () => {
            const tmpVal = allocLocal(fctx, `__logprop_ext_val_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "local.set", index: tmpVal });
            fctx.body.push({ op: "local.get", index: objTmp });
            fctx.body.push({ op: "local.get", index: tmpVal });
            fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
            fctx.body.push({ op: "local.get", index: tmpVal });
          };

          return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, fieldType, emitGet, emitSet);
        }
      }
    }

    // Struct ref but field not found — convert to externref and fall through to path B
    fctx.body.push({ op: "extern.convert_any" });
  } else if (objResult.kind !== "externref") {
    // For f64/i32, box to externref
    if (objResult.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
    } else if (objResult.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
    } else {
      // Unknown type — emit NaN as graceful fallback
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }
  }

  // --- Path B: externref-based property logical assignment ---
  const objLocal = allocLocal(fctx, `__logprop_pobj_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Compile propName as externref string key
  addStringConstantGlobal(ctx, propName);
  const keyResult = compileStringLiteral(ctx, fctx, propName);
  if (!keyResult) return null;
  if (keyResult.kind !== "externref") {
    coerceType(ctx, fctx, keyResult, { kind: "externref" });
  }
  const keyLocal = allocLocal(fctx, `__logprop_pkey_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: keyLocal });

  // Ensure __extern_get is available
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  if (getIdx === undefined) return null;

  // Ensure __extern_set is available. (#3430) PutValue's strict-Reference
  // throw (§13.15.2 → §6.2.5.6 step 3.e) applies here exactly as it does for
  // plain `=` assignment (assignment.ts's `compileExternSetFallback`) — a
  // strict `obj.prop ??= v` that fails [[Set]] (non-writable data property /
  // new key on a non-extensible object) must throw TypeError, not silently
  // no-op. Select the strict sidecar terminal accordingly; sloppy keeps the
  // legacy silent refusal.
  const setName = isStrictContext(target, ctx.inferModuleStrictArguments) ? "__extern_set_strict" : "__extern_set";
  const setIdx = ensureLateImport(
    ctx,
    setName,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (setIdx === undefined) return null;

  // Ensure union imports (including __unbox_number, __box_number) are registered
  addUnionImports(ctx);

  const varType: ValType = { kind: "externref" };

  // Capture final getIdx/setIdx values for closures
  const finalGetIdx = getIdx;
  const finalSetIdx = setIdx;

  const emitGet = () => {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "call", funcIdx: finalGetIdx });
  };

  const emitSet = () => {
    // Stack has the new value (externref) on top
    const tmpVal = allocLocal(fctx, `__logprop_pval_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: tmpVal });
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: tmpVal });
    fctx.body.push({ op: "call", funcIdx: finalSetIdx });
    fctx.body.push({ op: "local.get", index: tmpVal });
  };

  return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, varType, emitGet, emitSet);
}

/**
 * Compile logical assignment on element access: arr[i] ??= default, arr[i] ||= default, arr[i] &&= default
 * Uses short-circuit semantics.
 */
function compileElementLogicalAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
): ValType | null {
  // Compile object expression
  const arrType = compileExpression(ctx, fctx, target.expression);
  if (!arrType) {
    reportError(ctx, target, "Logical assignment on undefined element access target");
    return null;
  }

  // #1268 — index-signature dict (`{ [key: string]: T }`) lowers to
  // externref (host JS object); other non-ref kinds (f64, i32 — rare,
  // but possible via boxed primitives) likewise route through the host.
  // Plain `obj[key] = val` already has a `compileExternSetFallback` arm
  // for these; the parallel `??=` / `||=` / `&&=` arm was missing and
  // produced a "Logical assignment on non-array element access" error
  // that callers silently dropped, leaving the LHS uninitialized — the
  // subsequent read returned NaN. This routes the logical-assignment
  // case through the same `__extern_get` / `__extern_set` host imports
  // the plain assignment uses.
  if (arrType.kind !== "ref" && arrType.kind !== "ref_null") {
    return compileElementLogicalAssignmentExternref(ctx, fctx, target, rhs, op, arrType);
  }

  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle struct bracket notation: obj["prop"] ??= default
  if (typeDef?.kind === "struct") {
    const isVecStruct =
      typeDef.fields.length === 2 && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data";
    if (!isVecStruct) {
      let fieldName: string | undefined;
      if (ts.isStringLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      } else if (ts.isNumericLiteral(target.argumentExpression)) {
        fieldName = target.argumentExpression.text;
      }
      if (fieldName !== undefined) {
        const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
        if (fieldIdx !== -1) {
          const fieldType = typeDef.fields[fieldIdx]!.type;

          // Save obj ref
          const objLocal = allocLocal(fctx, `__logelem_obj_${fctx.locals.length}`, arrType);
          fctx.body.push({ op: "local.set", index: objLocal });

          const emitFieldGet = () => {
            fctx.body.push({ op: "local.get", index: objLocal });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          };
          const emitFieldSet = () => {
            const tmpVal = allocLocal(fctx, `__logelem_val_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "local.set", index: tmpVal });
            fctx.body.push({ op: "local.get", index: objLocal });
            fctx.body.push({ op: "local.get", index: tmpVal });
            fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
            fctx.body.push({ op: "local.get", index: tmpVal });
          };

          return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, fieldType, emitFieldGet, emitFieldSet);
        }
      }
    }

    // Vec struct: array[i] ??= default
    if (isVecStruct) {
      const arrLocal = allocLocal(fctx, `__logelem_arr_${fctx.locals.length}`, arrType);
      fctx.body.push({ op: "local.set", index: arrLocal });

      // Compile index
      const idxResult = compileExpression(ctx, fctx, target.argumentExpression, { kind: "f64" });
      if (!idxResult) return null;
      if (idxResult.kind !== "i32") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
      const idxLocal = allocLocal(fctx, `__logelem_idx_${fctx.locals.length}`, {
        kind: "i32",
      });
      fctx.body.push({ op: "local.set", index: idxLocal });

      const dataField = typeDef.fields[1]!;
      const dataTypeIdx = (dataField.type as { typeIdx: number }).typeIdx;
      const dataDef = ctx.mod.types[dataTypeIdx];
      if (!dataDef || dataDef.kind !== "array") {
        reportError(ctx, target, "Vec struct data field is not an array");
        return null;
      }
      const elemType = dataDef.element;

      const emitElemGet = () => {
        fctx.body.push({ op: "local.get", index: arrLocal });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "local.get", index: idxLocal });
        emitBoundsCheckedArrayGet(fctx, dataTypeIdx, elemType);
      };
      const emitElemSet = () => {
        const tmpVal = allocLocal(fctx, `__logelem_aval_${fctx.locals.length}`, elemType);
        fctx.body.push({ op: "local.set", index: tmpVal });
        // Bounds-guarded write: only set if idx < array.len
        fctx.body.push({ op: "local.get", index: idxLocal });
        fctx.body.push({ op: "local.get", index: arrLocal });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "array.len" });
        fctx.body.push({ op: "i32.lt_u" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" as const },
          then: [
            { op: "local.get", index: arrLocal },
            { op: "struct.get", typeIdx, fieldIdx: 1 },
            { op: "local.get", index: idxLocal },
            { op: "local.get", index: tmpVal },
            { op: "array.set", typeIdx: dataTypeIdx },
          ],
          else: [],
        });
        fctx.body.push({ op: "local.get", index: tmpVal });
      };

      return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, elemType, emitElemGet, emitElemSet);
    }
  }

  reportError(ctx, target, "Unsupported element access logical assignment target");
  return null;
}

/**
 * #1268 — `obj[key] ??= rhs` / `obj[key] ||= rhs` / `obj[key] &&= rhs`
 * where `obj` is an index-signature dict (lowered to externref) or any
 * other non-ref / non-ref_null target.
 *
 * Mirrors `compileExternSetFallback` for the read+write portions and
 * `emitLogicalAssignmentPattern` for the short-circuit semantics.
 *
 * Layout:
 *   1. Coerce obj to externref (already on stack), save to `__lelm_obj`
 *   2. Compute key (externref string), save to `__lelm_key`
 *   3. emitGet := obj_local; key_local; call $__extern_get → externref
 *   4. emitSet (after RHS pushed): save val to `__lelm_val`;
 *      obj_local; key_local; val_local; call $__extern_set;
 *      val_local (return value)
 *   5. emitLogicalAssignmentPattern handles the if/else dispatch
 *
 * Result type is externref — the host import lives in externref world,
 * and the caller-visible value is whatever the write/read produced.
 *
 * Caveat: `??=` semantics in JS treat `null` AND `undefined` as nullish.
 * `__extern_get` returns `ref.null.extern` for missing keys (which the
 * `ref.is_null` check captures correctly) and a boxed `undefined` for
 * keys present with undefined value. The current `emitLogicalAssignment-
 * Pattern` only checks `ref.is_null` for the `??=` arm, which matches
 * the legacy global-scope `??=` behaviour. Distinguishing
 * `undefined`-vs-other-truthy is the same gap that the global path has
 * (compiled there too) — leave aligned with the existing convention.
 */
function compileElementLogicalAssignmentExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  objType: ValType,
): ValType | null {
  // Coerce obj on stack to externref (mirrors compileExternSetFallback's prelude).
  if (objType.kind === "externref") {
    // already externref
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
  } else {
    reportError(ctx, target, "Unsupported element logical-assignment target type");
    return null;
  }

  // Save obj to a local so we can read it twice (get + set).
  const objLocal = allocLocal(fctx, `__lelm_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Compute key (always externref string for host imports) and save.
  const keyType = compileExpression(ctx, fctx, target.argumentExpression, { kind: "externref" });
  if (!keyType) return null;
  // Coerce key to externref if needed (string literals already are).
  if (keyType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else if (keyType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else if (keyType.kind === "ref" || keyType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  const keyLocal = allocLocal(fctx, `__lelm_key_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: keyLocal });

  // Ensure host imports are registered.
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  // (#3430) Strict `arr[i] ??= v` (etc.) mirrors the property-access sidecar:
  // a failed [[Set]] must throw under a strict Reference. See the property
  // arm above for the full rationale.
  const elemSetName = isStrictContext(target, ctx.inferModuleStrictArguments) ? "__extern_set_strict" : "__extern_set";
  const setIdx = ensureLateImport(
    ctx,
    elemSetName,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (getIdx === undefined || setIdx === undefined) {
    reportError(ctx, target, "Could not register __extern_get/__extern_set imports");
    return null;
  }

  const emitGet = (): void => {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "call", funcIdx: getIdx });
  };
  const emitSet = (): void => {
    // Stack on entry: <rhs value as externref>
    // We need to: save it, then call __extern_set(obj, key, val), then
    // re-push val as the result value of the logical assignment.
    const valLocal = allocLocal(fctx, `__lelm_val_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: valLocal });
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: valLocal });
    fctx.body.push({ op: "call", funcIdx: setIdx });
    fctx.body.push({ op: "local.get", index: valLocal });
  };

  return emitLogicalAssignmentPattern(ctx, fctx, rhs, op, { kind: "externref" }, emitGet, emitSet);
}

/**
 * Check if a ValType is a reference type (can be used with ref.is_null).
 * Value types (i32, i64, f32, f64, v128, i16) are never null/undefined.
 */
function isRefType(t: ValType): boolean {
  return (
    t.kind === "ref" ||
    t.kind === "ref_null" ||
    t.kind === "funcref" ||
    t.kind === "externref" ||
    t.kind === "ref_extern" ||
    t.kind === "eqref"
  );
}

/**
 * Common logic for logical assignment patterns (??=, ||=, &&=).
 * Given emitGet/emitSet closures for the target, emit the if/else with short-circuit semantics.
 */
function emitLogicalAssignmentPattern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  varType: ValType,
  emitGet: () => void,
  emitSet: () => void,
): ValType | null {
  if (op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
    // target ??= rhs  →  if (target is null/undefined) { target = rhs }; result = target
    // For value types (i32, i64, f32, f64, etc.), values can never be null/undefined,
    // so just return the current value without evaluating RHS (short-circuit).
    if (!isRefType(varType)) {
      emitGet();
      return varType;
    }
    // For externref-typed targets, host imports return JS `undefined` as
    // a non-null externref (the WebAssembly type system doesn't equate
    // them). `ref.is_null` alone misses `undefined`-valued slots — see
    // the parallel pattern in `compileLogicalAssignment` that uses
    // `__extern_is_undefined` for variable-scope `??=`. Compose the
    // two checks via `i32.or` so the then-arm fires for both.
    //
    // GetValue must run exactly once (§13.15.2): tee the fetched value into
    // a temp and reuse it on the keep path so accessor getters fire once.
    emitGet();
    const tmpKeep = allocTempLocal(fctx, varType);
    fctx.body.push({ op: "local.tee", index: tmpKeep });
    fctx.body.push({ op: "ref.is_null" });
    if (varType.kind === "externref") {
      const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      if (undefIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: tmpKeep });
        fctx.body.push({ op: "call", funcIdx: undefIdx });
        fctx.body.push({ op: "i32.or" });
      }
    }

    const savedBody = pushBody(fctx);
    const rhsResult = compileExpression(ctx, fctx, rhs, varType);
    if (!rhsResult) {
      fctx.body = savedBody;
      releaseTempLocal(fctx, tmpKeep);
      return null;
    }
    emitSet();
    const thenInstrs = fctx.body;

    fctx.body = [];
    fctx.body.push({ op: "local.get", index: tmpKeep });
    const elseInstrs = fctx.body;
    releaseTempLocal(fctx, tmpKeep);

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  } else if (op === ts.SyntaxKind.BarBarEqualsToken) {
    // target ||= rhs  →  if (target is truthy) { keep } else { target = rhs }
    // GetValue once (§13.15.2): tee the fetched value, reuse on the keep path.
    emitGet();
    const tmpKeep = allocTempLocal(fctx, varType);
    fctx.body.push({ op: "local.tee", index: tmpKeep });
    ensureI32Condition(fctx, varType, ctx);

    const savedBody = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: tmpKeep });
    const thenInstrs = fctx.body;

    fctx.body = [];
    const rhsResult = compileExpression(ctx, fctx, rhs, varType);
    if (!rhsResult) {
      fctx.body = savedBody;
      releaseTempLocal(fctx, tmpKeep);
      return null;
    }
    emitSet();
    const elseInstrs = fctx.body;
    releaseTempLocal(fctx, tmpKeep);

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  } else {
    // target &&= rhs  →  if (target is truthy) { target = rhs } else { keep }
    // GetValue once (§13.15.2): tee the fetched value, reuse on the keep path.
    emitGet();
    const tmpKeep = allocTempLocal(fctx, varType);
    fctx.body.push({ op: "local.tee", index: tmpKeep });
    ensureI32Condition(fctx, varType, ctx);

    const savedBody = pushBody(fctx);
    const rhsResult = compileExpression(ctx, fctx, rhs, varType);
    if (!rhsResult) {
      fctx.body = savedBody;
      releaseTempLocal(fctx, tmpKeep);
      return null;
    }
    emitSet();
    const thenInstrs = fctx.body;

    fctx.body = [];
    fctx.body.push({ op: "local.get", index: tmpKeep });
    const elseInstrs = fctx.body;
    releaseTempLocal(fctx, tmpKeep);

    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: varType },
      then: thenInstrs,
      else: elseInstrs,
    });
  }

  return varType;
}

export function isCompoundAssignment(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.PlusEqualsToken ||
    op === ts.SyntaxKind.MinusEqualsToken ||
    op === ts.SyntaxKind.AsteriskEqualsToken ||
    op === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    op === ts.SyntaxKind.SlashEqualsToken ||
    op === ts.SyntaxKind.PercentEqualsToken ||
    op === ts.SyntaxKind.AmpersandEqualsToken ||
    op === ts.SyntaxKind.BarEqualsToken ||
    op === ts.SyntaxKind.CaretEqualsToken ||
    op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
  );
}

/**
 * Handle string += : load current string value, compile RHS (coercing
 * numbers to string if needed), call concat, store back.
 *
 * In nativeStrings mode (auto-on for `--target wasi`), routes through the
 * native `__str_concat` helper which expects `ref $AnyString` operands and
 * returns `ref $AnyString`. The legacy host-import branch uses
 * `wasm:js-string concat` with externref operands. The two branches must
 * not be mixed: calling `addStringImports` late in nativeStrings mode adds
 * 5 host imports without shifting already-emitted module function indices,
 * which corrupts every `call funcIdx=N` instruction whose index now points
 * at a host import instead of the intended native helper (#1175).
 */
/**
 * (#2058) `x += rhs` where the result may be a runtime string. Compute
 * `x + rhs` via the shared runtime-dispatched add (`emitAnyAdd`: JS `+` host
 * bridge, or a standalone tag-dispatch concat/add), then store the resulting
 * externref back into the variable. Returns null (caller falls through to the
 * numeric paths) only for storage classes this doesn't cover.
 */
function compileAnyCompoundAdd(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  name: string,
): ValType | null {
  const localIdx = fctx.localMap.get(name);
  const capturedIdx = ctx.capturedGlobals.get(name);
  const moduleIdx = ctx.moduleGlobals.get(name);
  if (localIdx === undefined && capturedIdx === undefined && moduleIdx === undefined) {
    return null; // unresolved binding — let the default paths handle it
  }

  // emitAnyAdd reads `expr.left` (the current value of `x`) and `expr.right`,
  // leaving the §13.15.3 result on the stack as an externref.
  const addResult = emitAnyAdd(ctx, fctx, expr);
  if (addResult.kind !== "externref") {
    // emitAnyAdd took the legacy f64 fallback (no host, no native strings).
    // Coerce to externref so the store below is uniform.
    coerceType(ctx, fctx, addResult, { kind: "externref" });
  }

  // Store back into the resolved binding (re-read global indices in case RHS
  // compilation shifted them), coercing externref → the binding's storage type.
  if (localIdx !== undefined) {
    const localType = getLocalType(fctx, localIdx) ?? { kind: "externref" as const };
    if (localType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, localType);
    fctx.body.push({ op: "local.tee", index: localIdx });
    return localType;
  }
  if (capturedIdx !== undefined) {
    const capturedIdxPost = ctx.capturedGlobals.get(name)!;
    const globalType: ValType = ctx.mod.globals[localGlobalIdx(ctx, capturedIdxPost)]?.type ?? { kind: "externref" };
    if (globalType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, globalType);
    fctx.body.push({ op: "global.set", index: capturedIdxPost });
    fctx.body.push({ op: "global.get", index: capturedIdxPost });
    return globalType;
  }
  const moduleIdxPost = ctx.moduleGlobals.get(name)!;
  const globalType: ValType = ctx.mod.globals[localGlobalIdx(ctx, moduleIdxPost)]?.type ?? { kind: "externref" };
  if (globalType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, globalType);
  fctx.body.push({ op: "global.set", index: moduleIdxPost });
  fctx.body.push({ op: "global.get", index: moduleIdxPost });
  return globalType;
}

function compileStringCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  name: string,
): ValType | null {
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    return compileNativeStringCompoundAssignment(ctx, fctx, expr, name);
  }

  // Ensure string imports are registered
  addStringImports(ctx);

  const concatIdx = ctx.jsStringImports.get("concat");
  if (concatIdx === undefined) {
    reportError(ctx, expr, "String concat import not available");
    return null;
  }

  // Determine storage location
  const localIdx = fctx.localMap.get(name);
  const capturedIdx = ctx.capturedGlobals.get(name);
  const moduleIdx = ctx.moduleGlobals.get(name);

  // Load current value
  if (localIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: localIdx });
  } else if (capturedIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: capturedIdx });
  } else if (moduleIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: moduleIdx });
  } else {
    // Graceful fallback: compile RHS for side effects, return externref
    const rhsFallback = compileExpression(ctx, fctx, expr.right);
    if (rhsFallback) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Compile RHS, coercing numbers to string
  const rhsType = compileExpression(ctx, fctx, expr.right);
  if (!rhsType) {
    reportError(ctx, expr, "Failed to compile string += RHS");
    return null;
  }
  if (rhsType.kind === "f64" || rhsType.kind === "i32") {
    const rhsTsType = ctx.checker.getTypeAtLocation(expr.right);
    if (isBooleanType(rhsTsType) && rhsType.kind === "i32") {
      emitBoolToString(ctx, fctx);
    } else {
      if (rhsType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
      const toStr = ctx.funcMap.get("number_toString");
      if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
    }
  }

  // Call concat
  fctx.body.push({ op: "call", funcIdx: concatIdx });

  // Store back — re-read global indices since RHS compilation may have shifted them
  if (localIdx !== undefined) {
    fctx.body.push({ op: "local.tee", index: localIdx });
  } else if (capturedIdx !== undefined) {
    const capturedIdxPost = ctx.capturedGlobals.get(name)!;
    fctx.body.push({ op: "global.set", index: capturedIdxPost });
    fctx.body.push({ op: "global.get", index: capturedIdxPost });
  } else if (moduleIdx !== undefined) {
    const moduleIdxPost = ctx.moduleGlobals.get(name)!;
    fctx.body.push({ op: "global.set", index: moduleIdxPost });
    fctx.body.push({ op: "global.get", index: moduleIdxPost });
  }

  return { kind: "externref" };
}

/**
 * #1744 — single-code-unit append fast path for string-builders.
 *
 * Returns `true` if `rhs` is a one-code-unit producer that can be appended
 * to the builder `sb` without materialising an intermediate `$NativeString`,
 * and emits the append. Two shapes qualify:
 *
 *   - `X.charAt(i)` where `X` is a native string — read `X`'s code unit at
 *     `i` (flatten `X` once, `array.get_u data[off+i]`) and append it.
 *   - a 1-character string literal (`buf += ";"`) — append the constant code
 *     unit directly, no string materialisation at all.
 *
 * In both cases the bulk path would otherwise allocate a 1-char string per
 * iteration (`array.new_fixed` + `struct.new`) and copy a single character
 * out of it. Returns `false` (caller falls back to `compileStringBuilderAppend`)
 * for anything else, including `at()` (negative indices) and `charAt` on a
 * non-string receiver.
 */
function tryCompileSingleCharBuilderAppend(
  ctx: CodegenContext,
  fctx: FunctionContext,
  rhs: ts.Expression,
  sb: StringBuilderInfo,
): boolean {
  // Shape 1: a 1-character string literal → append the constant code unit.
  if (ts.isStringLiteral(rhs) && rhs.text.length === 1) {
    fctx.body.push({ op: "i32.const", value: rhs.text.charCodeAt(0) });
    emitStringBuilderAppendCodeUnit(ctx, fctx, sb);
    return true;
  }

  // Shape 2: `X.charAt(i)` on a native-string receiver.
  if (
    ts.isCallExpression(rhs) &&
    ts.isPropertyAccessExpression(rhs.expression) &&
    rhs.expression.name.text === "charAt" &&
    rhs.arguments.length <= 1
  ) {
    const receiver = rhs.expression.expression;
    const recvType = ctx.checker.getTypeAtLocation(receiver);
    // Only fire when the receiver is statically a string — otherwise charAt
    // might be a user method and the inline read would be wrong.
    const isStr = (recvType.flags & ts.TypeFlags.StringLike) !== 0;
    if (isStr) {
      const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
      if (flattenIdx !== undefined) {
        const strTypeIdx = ctx.nativeStrTypeIdx;
        const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
        // A const initialized directly from a string literal is already a
        // flat $NativeString for its entire lifetime. Avoid calling the
        // generic flatten helper for every append in a hot loop (the landing
        // string-hash shape reads the same alphabet twice per iteration).
        const receiverDeclaration = ts.isIdentifier(receiver) ? ctx.oracle.variableDeclarationOf(receiver) : undefined;
        const receiverIsConstLiteral =
          receiverDeclaration !== undefined &&
          ts.isVariableDeclaration(receiverDeclaration) &&
          receiverDeclaration.initializer !== undefined &&
          (ts.isStringLiteral(receiverDeclaration.initializer) ||
            ts.isNoSubstitutionTemplateLiteral(receiverDeclaration.initializer)) &&
          ts.isVariableDeclarationList(receiverDeclaration.parent) &&
          (ts.getCombinedNodeFlags(receiverDeclaration.parent) & ts.NodeFlags.Const) !== 0;

        // flat = receiver (proven flat) or __str_flatten(receiver), then stash.
        const recvVal = compileExpression(ctx, fctx, receiver);
        if (recvVal !== null) {
          if (receiverIsConstLiteral) {
            fctx.body.push({ op: "ref.cast", typeIdx: strTypeIdx });
          } else {
            fctx.body.push({ op: "call", funcIdx: flattenIdx });
          }
          const flatTmp = allocLocal(fctx, `__sb_charAt_flat_${fctx.locals.length}`, {
            kind: "ref_null",
            typeIdx: strTypeIdx,
          });
          fctx.body.push({ op: "local.set", index: flatTmp });
          // cu = flat.data[flat.off + idx]
          fctx.body.push({ op: "local.get", index: flatTmp });
          fctx.body.push({ op: "ref.as_non_null" });
          fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }); // .data
          fctx.body.push({ op: "local.get", index: flatTmp });
          fctx.body.push({ op: "ref.as_non_null" });
          fctx.body.push({ op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }); // .off
          if (rhs.arguments.length > 0) {
            const idxType = compileExpression(ctx, fctx, rhs.arguments[0]!, { kind: "f64" });
            if (idxType?.kind === "f64") {
              fctx.body.push({ op: "i32.trunc_sat_f64_s" });
            } else if (idxType !== null && idxType.kind !== "i32") {
              // Unexpected index type — bail to the generic path would require
              // unwinding already-emitted ops, which we can't. Coerce best-effort.
              fctx.body.push({ op: "i32.const", value: 0 });
            }
          } else {
            fctx.body.push({ op: "i32.const", value: 0 });
          }
          fctx.body.push({ op: "i32.add" }); // off + idx
          fctx.body.push({ op: "array.get_u", typeIdx: strDataTypeIdx });
          emitStringBuilderAppendCodeUnit(ctx, fctx, sb);
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Native-strings variant of string `+=` (#1175). Uses `__str_concat` which
 * accepts and returns `ref $AnyString`. RHS coercion: numbers are routed
 * through `number_toString` (returns externref) then `any.convert_extern` +
 * `ref.cast` to land back in the native string type.
 */
function compileNativeStringCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  name: string,
): ValType | null {
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (concatIdx === undefined) {
    reportError(ctx, expr, "Native __str_concat helper not available");
    return null;
  }
  const anyStrType: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  const anyStrTypeNullable: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };

  // #1210: route detected `let s = ""; for (...) s += <expr>` builder
  // patterns to the in-place buffer append, avoiding O(N) ConsString
  // allocations.
  const sb = getBuilderInfo(fctx, name);
  if (sb !== undefined) {
    // #1744: single-code-unit fast path — `buf += X.charAt(i)` / `buf += "c"`
    // append one code unit directly to the buffer, skipping the per-iteration
    // 1-char `$NativeString` allocation the generic path would emit.
    if (tryCompileSingleCharBuilderAppend(ctx, fctx, expr.right, sb)) {
      fctx.body.push({ op: "ref.null", typeIdx: ctx.anyStrTypeIdx });
      return anyStrTypeNullable;
    }
    // Compile RHS and coerce to ref $AnyString — same coercion the legacy
    // path uses below, lifted into a small helper.
    const coerced = compileAndCoerceToAnyStr(ctx, fctx, expr.right);
    if (coerced === null) {
      reportError(ctx, expr, "Failed to compile string += RHS");
      return null;
    }
    compileStringBuilderAppend(ctx, fctx, coerced, sb);
    // The += statement is normally side-effecting (statement-level) — the
    // wrapping ExpressionStatement drops the result. Push a sentinel
    // `ref.null $AnyString` so callers that DO consume the value get a
    // typed value to drop / coerce.
    fctx.body.push({ op: "ref.null", typeIdx: ctx.anyStrTypeIdx });
    return anyStrTypeNullable;
  }

  const localIdx = fctx.localMap.get(name);
  const capturedIdx = ctx.capturedGlobals.get(name);
  const moduleIdx = ctx.moduleGlobals.get(name);

  // Load current value. A statically-`string` binding's slot is already a
  // native-string ref (`ref $AnyString`), which `__str_concat` accepts as-is.
  // An `any`/untyped binding routed here via `hasStringAssignment` — an
  // unannotated param, or a `var` initialised with a String OBJECT wrapper —
  // has an EXTERNREF slot, so the value must cross the externref bridge on the
  // way IN and again on the way OUT. Both directions live together in
  // native-string-slot-bridge.ts (#3472 inbound, #3989 outbound).
  let slotType: ValType | undefined;
  if (localIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: localIdx });
    slotType = getLocalType(fctx, localIdx);
  } else if (capturedIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: capturedIdx });
    slotType = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)]?.type;
  } else if (moduleIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: moduleIdx });
    slotType = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)]?.type;
  } else {
    // Graceful fallback: compile RHS for side effects, return null AnyString.
    const rhsFallback = compileExpression(ctx, fctx, expr.right);
    if (rhsFallback) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null", typeIdx: ctx.anyStrTypeIdx });
    return anyStrTypeNullable;
  }
  const bridgeSlot = slotNeedsExternrefBridge(ctx, slotType);
  if (bridgeSlot) {
    emitExternrefSlotToAnyStr(ctx, fctx);
  }

  // Compile RHS
  const rhsType = compileExpression(ctx, fctx, expr.right);
  if (!rhsType) {
    reportError(ctx, expr, "Failed to compile string += RHS");
    return null;
  }
  // Coerce RHS to ref $AnyString.
  if (rhsType.kind === "ref" || rhsType.kind === "ref_null") {
    // Already a ref. Assume it's an AnyString-compatible type; if not,
    // ref.cast at __str_concat boundary will trap. Common case: native
    // string method calls return ref $AnyString already.
  } else if (rhsType.kind === "f64" || rhsType.kind === "i32") {
    const rhsTsType = ctx.checker.getTypeAtLocation(expr.right);
    if (isBooleanType(rhsTsType) && rhsType.kind === "i32") {
      emitBoolToAnyStr(ctx, fctx);
    } else {
      if (rhsType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
      const toStr = ctx.funcMap.get("number_toString");
      if (toStr !== undefined) {
        fctx.body.push({ op: "call", funcIdx: toStr });
        // number_toString returns externref → convert to ref $AnyString
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
      } else {
        // No host number_toString: fall back to dropping and using empty string.
        // (Standalone WASI mode currently lacks a wasm-native number-to-string;
        //  this is an open gap. Drop the f64 to keep stack balanced.)
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null", typeIdx: ctx.anyStrTypeIdx });
      }
    }
  } else if (rhsType.kind === "externref") {
    // externref → ref $AnyString. The value is usually already a native string
    // (host charAt result), but a STRING-typed RHS can also be a String
    // WRAPPER OBJECT — `x += new String("1")` types as String while the
    // runtime value is the $Object wrapper, and the old unconditional
    // `ref.cast` trapped with `illegal cast` (test262 S11.13.2_A4.4_T1.4).
    // Test first; on a non-string, run the §7.1.17 walker `__extern_toString`
    // (ToPrimitive → ToString — unwraps wrappers, stringifies objects).
    const externToStrIdx = ctx.standalone || ctx.wasi ? ctx.funcMap.get("__extern_toString") : undefined;
    if (externToStrIdx !== undefined) {
      const extTmp = allocTempLocal(fctx, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: extTmp });
      fctx.body.push({ op: "local.get", index: extTmp });
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.test", typeIdx: ctx.anyStrTypeIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx } },
        then: [
          { op: "local.get", index: extTmp },
          { op: "any.convert_extern" },
          { op: "ref.cast_null", typeIdx: ctx.anyStrTypeIdx },
        ],
        else: [
          { op: "local.get", index: extTmp },
          { op: "call", funcIdx: externToStrIdx },
          { op: "any.convert_extern" },
          { op: "ref.cast_null", typeIdx: ctx.anyStrTypeIdx },
        ],
      });
      releaseTempLocal(fctx, extTmp);
    } else {
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
    }
  }

  // Call __str_concat — returns ref $AnyString
  fctx.body.push({ op: "call", funcIdx: concatIdx });

  // (#3989) Store back across the SAME bridge the load used. Without this the
  // `ref $AnyString` result lands in an externref slot and the module fails to
  // validate, costing the whole file rather than the statement.
  if (bridgeSlot) {
    emitAnyStrToExternrefSlot(fctx);
  }
  // Store back. Re-read indices since RHS compilation may have shifted them.
  if (localIdx !== undefined) {
    fctx.body.push({ op: "local.tee", index: localIdx });
  } else if (capturedIdx !== undefined) {
    const capturedIdxPost = ctx.capturedGlobals.get(name)!;
    fctx.body.push({ op: "global.set", index: capturedIdxPost });
    fctx.body.push({ op: "global.get", index: capturedIdxPost });
  } else if (moduleIdx !== undefined) {
    const moduleIdxPost = ctx.moduleGlobals.get(name)!;
    fctx.body.push({ op: "global.set", index: moduleIdxPost });
    fctx.body.push({ op: "global.get", index: moduleIdxPost });
  }

  // The value left on the stack is whatever the SLOT holds — `local.tee` and the
  // `global.set`/`global.get` pair both re-expose the slot type. Reporting
  // `anyStrType` after storing into an externref slot would hand callers a type
  // the stack does not carry, which is how a validation error migrates from this
  // statement to whatever consumes `x += y` as a value.
  if (bridgeSlot) return { kind: "externref" };

  return anyStrType;
}

/**
 * Compile a string-typed expression and coerce the result to a non-null
 * `ref $AnyString`. Handles the same coercion paths as
 * `compileNativeStringCompoundAssignment` (numbers via `number_toString`,
 * externref via `any.convert_extern + ref.cast`, booleans via
 * `emitBoolToString`). Used by the #1210 string-builder rewrite.
 *
 * Returns the resulting ValType (always `ref $AnyString` on success), or
 * null on failure.
 */
function compileAndCoerceToAnyStr(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): ValType | null {
  const anyStrType: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  const rhsType = compileExpression(ctx, fctx, expr);
  if (!rhsType) return null;

  if (rhsType.kind === "ref" || rhsType.kind === "ref_null") {
    // Already a ref to a string-like type. If nullable, force non-null —
    // __str_flatten and array.copy require non-null operands.
    if (rhsType.kind === "ref_null") {
      fctx.body.push({ op: "ref.as_non_null" });
    }
    return anyStrType;
  }
  if (rhsType.kind === "f64" || rhsType.kind === "i32") {
    const rhsTsType = ctx.checker.getTypeAtLocation(expr);
    if (isBooleanType(rhsTsType) && rhsType.kind === "i32") {
      emitBoolToAnyStr(ctx, fctx);
      return anyStrType;
    }
    if (rhsType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
    const toStr = ctx.funcMap.get("number_toString");
    if (toStr !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toStr });
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
      return anyStrType;
    }
    // Standalone-mode gap: no host number_toString. Drop the value and emit
    // an empty native string so the append is a no-op.
    fctx.body.push({ op: "drop" });
    // Empty NativeString: struct.new $NativeString(0, 0, array.new_default 0)
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
    return anyStrType;
  }
  if (rhsType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
    return anyStrType;
  }
  // Other types (i64 etc.) — drop and emit empty string as fallback.
  fctx.body.push({ op: "drop" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx });
  fctx.body.push({ op: "struct.new", typeIdx: ctx.nativeStrTypeIdx });
  return anyStrType;
}

/**
 * Check if a variable named `name` is assigned a string value anywhere
 * in the enclosing function/block scope. This handles the test262 pattern:
 *   var __str;     // type: any
 *   __str = ""     // string assignment
 *   __str += index // should be string concat, not numeric add
 */
function hasStringAssignment(name: string, fromExpr: ts.Node): boolean {
  // Walk up to the enclosing function body or source file
  let scope: ts.Node = fromExpr;
  while (
    scope &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope) &&
    !ts.isSourceFile(scope)
  ) {
    scope = scope.parent;
  }
  if (!scope) return false;

  let found = false;
  function visit(node: ts.Node) {
    if (found) return;
    // Check: name = "stringLiteral" or name = `template`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      if (
        ts.isStringLiteral(node.right) ||
        ts.isNoSubstitutionTemplateLiteral(node.right) ||
        ts.isTemplateExpression(node.right)
      ) {
        found = true;
        return;
      }
    }
    // Check: var name = "stringLiteral"
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      if (
        ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer) ||
        ts.isTemplateExpression(node.initializer)
      ) {
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  }
  forEachChild(scope, visit);
  return found;
}

/**
 * Like hasStringAssignment but searches from the source file root, not just
 * the immediate function. This catches the pattern where a closure captures
 * a variable that was assigned a string in a parent scope (#795).
 */
function hasStringAssignmentInParentScopes(name: string, fromExpr: ts.Node): boolean {
  // Walk up to the source file root
  let root: ts.Node = fromExpr;
  while (root.parent) root = root.parent;
  if (!ts.isSourceFile(root)) return false;
  // Search the entire source file for string assignments to this name
  let found = false;
  function visit(node: ts.Node) {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      if (
        ts.isStringLiteral(node.right) ||
        ts.isNoSubstitutionTemplateLiteral(node.right) ||
        ts.isTemplateExpression(node.right)
      ) {
        found = true;
        return;
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      if (
        ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer) ||
        ts.isTemplateExpression(node.initializer)
      ) {
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  }
  forEachChild(root, visit);
  return found;
}

export function compileCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): ValType | null {
  // Annex B.3.9: the call runs, then ReferenceError is thrown before GetValue
  // or RHS evaluation. Logical assignments are still rejected as early errors.
  if (emitWebCompatCallAssignmentTarget(ctx, fctx, expr.left)) {
    return { kind: "f64" };
  }
  // Handle property access compound assignment: obj.prop += value
  if (ts.isPropertyAccessExpression(expr.left)) {
    return compilePropertyCompoundAssignment(ctx, fctx, expr.left, expr.right, op);
  }

  // Handle element access compound assignment: arr[i] += value
  if (ts.isElementAccessExpression(expr.left)) {
    // (#2709) `super[super()] += v` — SuperProperty compound assignment whose key
    // contains super(). §13.3.7.1 resolves the reference (GetThisBinding) BEFORE
    // the key, so this always throws a ReferenceError; emit it and stop, before the
    // inner super() / RHS run. No-op for every other shape.
    if (
      expr.left.expression.kind === ts.SyntaxKind.SuperKeyword &&
      emitSuperUninitializedThisGuard(ctx, fctx, expr.left.argumentExpression)
    ) {
      return { kind: "f64" };
    }
    return compileElementCompoundAssignment(ctx, fctx, expr.left, expr.right, op);
  }

  if (!ts.isIdentifier(expr.left)) {
    reportError(ctx, expr, "Compound assignment only supported for simple identifiers");
    return null;
  }

  const name = expr.left.text;

  // (#2663 Slice 3) An Object Environment Record pushed by `with` is consulted
  // BEFORE the surrounding function/global environment, so this must precede the
  // const / boxed-capture / local paths below. Declines (returns undefined) when
  // no `with` scope binds the name — then the pre-existing lowering runs.
  const withCompound = compileWithCompoundAssignment(ctx, fctx, expr.left, expr.right, op);
  if (withCompound !== undefined) return withCompound;

  // const bindings — compound assignment throws TypeError at runtime
  if (fctx.constBindings?.has(name)) {
    const rhsType = compileExpression(ctx, fctx, expr.right);
    if (rhsType) fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, "Assignment to constant variable.");
    fctx.body.push({ op: "unreachable" });
    return { kind: "f64" };
  }

  // (#3039) Boxed captured global compound-assign (`c += 1` in a method-
  // shorthand / class-method / accessor body reading a transitively-captured
  // boxed var). Read THROUGH the ref cell, apply the op, write back THROUGH the
  // cell — never treat the box global as holding the scalar. Self-contained
  // (sources the box from the global each time, no localMap rebind) to avoid a
  // conditionally-set-local dominance hazard; mirrors the boxedCaptures
  // local-box compound path below (string concat for externref cells, f64
  // arithmetic with coerce-in/coerce-out for numeric cells).
  const capturedBoxCompound = getCapturedBoxGlobal(ctx, name);
  if (capturedBoxCompound !== undefined) {
    const valType = capturedBoxCompound.valType;
    // Read current value (null-guarded default for an uninitialized cell).
    emitCapturedBoxGlobalRead(ctx, fctx, capturedBoxCompound);

    // NOTE: string `+=` concat on an EXTERNREF boxed cell (a string-typed boxed
    // transitively-captured var updated with `+=` inside an accessor/method) is
    // intentionally NOT special-cased here — it goes through the numeric path
    // below (ToNumber both sides). That sub-case is vanishingly rare, already
    // miscompiled on main (the whole boxed-transitive-capture-accessor path was
    // broken), and is out of scope for this fix; adding it back would require
    // direct type-checker probing (against the #1930 oracle ratchet). The
    // numeric/bitwise path handles every #3039 acceptance case (f64/i32 cells).

    // Numeric / bitwise: the op switch is f64-based, so promote a non-f64 cell
    // value (and the RHS) to f64 and coerce the result back on writeback.
    const needsCoerce = valType.kind !== "f64";
    if (needsCoerce) coerceType(ctx, fctx, valType, { kind: "f64" });
    const compoundRhs = compileExpression(ctx, fctx, expr.right, needsCoerce ? { kind: "f64" } : valType);
    if (!compoundRhs) {
      reportError(ctx, expr, "Failed to compile compound assignment RHS");
      return null;
    }
    if (needsCoerce && compoundRhs.kind !== "f64") coerceType(ctx, fctx, compoundRhs, { kind: "f64" });
    emitCompoundOp(ctx, fctx, op);
    if (needsCoerce) coerceType(ctx, fctx, { kind: "f64" }, valType);
    const tmpRes = allocLocal(fctx, `__box_gcmp_${fctx.locals.length}`, valType);
    fctx.body.push({ op: "local.set", index: tmpRes });
    emitCapturedBoxGlobalWrite(fctx, capturedBoxCompound, tmpRes);
    fctx.body.push({ op: "local.get", index: tmpRes });
    return valType;
  }

  // String += : concat instead of numeric add.
  // Skip when the binding is a boxed mutable capture (ref cell): the boxed
  // path below (assignment.ts boxedCaptures branch) loads/stores through the
  // ref-cell struct and has its own externref string-concat handling (#795).
  // compileStringCompoundAssignment uses bare local.get/local.tee, which would
  // pass the `(struct (mut externref))` ref cell straight into js-string concat
  // (→ illegal cast / invalid wasm). #1999.
  const plusEqualsUnboxed = op === ts.SyntaxKind.PlusEqualsToken && !fctx.boxedCaptures?.has(name);
  const plusLeftTsType = plusEqualsUnboxed ? ctx.checker.getTypeAtLocation(expr.left) : undefined;
  const plusRightTsType = plusEqualsUnboxed ? ctx.checker.getTypeAtLocation(expr.right) : undefined;
  if (plusEqualsUnboxed && plusLeftTsType && plusRightTsType) {
    let isStr = isStringType(plusLeftTsType);
    if (!isStr && (plusLeftTsType.flags & ts.TypeFlags.Any) !== 0) {
      // For `any`-typed variables (e.g. `var __str; __str=""`), check if
      // the variable is ever assigned a string value in the enclosing scope.
      // This handles the common test262 pattern where `var x; x=""` followed
      // by `x += numericVar` should do string concatenation.
      isStr = hasStringAssignment(name, expr);
    }
    // (#4427) A statically String-typed RHS forces concat on its own (§13.5.3
    // step 3) — see `rhsStringForcesConcatLane` for why the LHS-only gate above
    // mis-lowered `x = 1; x += "1"` to `2`, and for the slot restriction.
    if (!isStr) isStr = rhsStringForcesConcatLane(ctx, fctx, name, plusRightTsType);
    if (isStr) {
      return compileStringCompoundAssignment(ctx, fctx, expr, name);
    }
  }

  // (#2058) `x += rhs` where the value may be a runtime string at `+` time —
  // either the LHS is `any`/`unknown` (it could currently hold a string) or the
  // RHS is `any`/`unknown` (it could evaluate to a string). The numeric `+=`
  // paths below ToNumber-coerce both sides, so `let x: any = 1; x += "2"` wrongly
  // produced `3` instead of `"12"`. The static-string concat gate above only
  // catches LHS that are *statically* assigned a string; this catches the
  // runtime case. Skip boxed captures (their own externref concat path handles
  // them) and bigint. Provably-numeric `+=` keeps the f64 fast path (neither
  // side is `any`/`unknown`).
  //
  // Fast mode (`anyValueTypeIdx >= 0`) is excluded: there the AnyValue
  // infrastructure already round-trips `any += number` through the existing
  // numeric path, and the `__host_add` host import isn't part of that ABI.
  // Per the #2058 design rule, this per-site recovery is **default-mode only**.
  // (#4137) …EXCEPT with no JS host: that exclusion was written for the
  // `__host_add` ABI, which `emitAnyAddFromExternTemps` never emits in
  // standalone/WASI. "Already round-trips" holds for `any += number` and is
  // FALSE for a runtime STRING — which is how acorn's `message += " (" + …`
  // rendered as the number NaN. Mirrors `emitAnyAdd`'s own `noJsHost` test.
  const anyCompoundAddEligible = ctx.anyValueTypeIdx < 0 || ctx.standalone === true || ctx.wasi === true;
  if (plusEqualsUnboxed && plusLeftTsType && plusRightTsType && anyCompoundAddEligible) {
    const leftTsType = plusLeftTsType;
    const rightTsType = plusRightTsType;
    const leftIsAnyish = (leftTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const rightIsAnyish = (rightTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const isBigInt =
      (leftTsType.flags & ts.TypeFlags.BigIntLike) !== 0 || (rightTsType.flags & ts.TypeFlags.BigIntLike) !== 0;
    if ((leftIsAnyish || rightIsAnyish) && !isBigInt) {
      const r = compileAnyCompoundAdd(ctx, fctx, expr, name);
      if (r !== null) return r;
    }
  }

  // Check captured globals first
  const capturedIdx = ctx.capturedGlobals.get(name);
  if (capturedIdx !== undefined && fctx.localMap.get(name) === undefined) {
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
    const globalType: ValType = globalDef?.type ?? { kind: "f64" };
    const needsCoerce = globalType.kind !== "f64";

    fctx.body.push({ op: "global.get", index: capturedIdx });
    if (needsCoerce) coerceType(ctx, fctx, globalType, { kind: "f64" });

    const compoundRhsType1 = compileExpression(ctx, fctx, expr.right, {
      kind: "f64",
    });
    if (!compoundRhsType1) {
      reportError(ctx, expr, "Failed to compile compound assignment RHS");
      return null;
    }
    if (compoundRhsType1.kind !== "f64") coerceType(ctx, fctx, compoundRhsType1, { kind: "f64" });

    emitCompoundOp(ctx, fctx, op);

    // Re-read the global index after RHS compilation: compiling the RHS may
    // trigger addStringConstantGlobal which shifts all global indices via
    // fixupModuleGlobalIndices. The already-emitted global.get was shifted
    // in-place, but our local `capturedIdx` variable is now stale.
    const capturedIdxPost = ctx.capturedGlobals.get(name)!;
    if (needsCoerce) coerceType(ctx, fctx, { kind: "f64" }, globalType);
    fctx.body.push({ op: "global.set", index: capturedIdxPost });
    fctx.body.push({ op: "global.get", index: capturedIdxPost });
    return globalType;
  }

  // Check module-level globals
  const moduleIdx = ctx.moduleGlobals.get(name);
  if (moduleIdx !== undefined && fctx.localMap.get(name) === undefined) {
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
    const globalType: ValType = globalDef?.type ?? { kind: "f64" };
    const needsCoerce = globalType.kind !== "f64";

    fctx.body.push({ op: "global.get", index: moduleIdx });
    if (needsCoerce) coerceType(ctx, fctx, globalType, { kind: "f64" });

    const compoundRhsType2 = compileExpression(ctx, fctx, expr.right, {
      kind: "f64",
    });
    if (!compoundRhsType2) {
      reportError(ctx, expr, "Failed to compile compound assignment RHS");
      return null;
    }
    if (compoundRhsType2.kind !== "f64") coerceType(ctx, fctx, compoundRhsType2, { kind: "f64" });

    emitCompoundOp(ctx, fctx, op);

    // Re-read the global index after RHS compilation (same reason as above)
    const moduleIdxPost = ctx.moduleGlobals.get(name)!;
    if (needsCoerce) coerceType(ctx, fctx, { kind: "f64" }, globalType);
    fctx.body.push({ op: "global.set", index: moduleIdxPost });
    fctx.body.push({ op: "global.get", index: moduleIdxPost });
    return globalType;
  }

  let localIdx = fctx.localMap.get(name);
  if (localIdx === undefined) {
    // §13.15.2 CompoundAssignmentEvaluation step 1.c: `lval = GetValue(lref)`
    // runs before the RHS is evaluated. GetValue on an *unresolvable*
    // reference throws ReferenceError (§6.2.4). A name that reaches here with
    // no local / captured-global / module-global / const binding AND no
    // resolved symbol from the checker is genuinely undeclared (e.g.
    // `x += 1` with no `x` in scope) — throw rather than silently
    // auto-allocating a zero local. Names with a symbol (hoisted `var`,
    // outer-scope bindings, builtins) keep the graceful auto-allocate path.
    const lhsSym = ctx.checker.getSymbolAtLocation(expr.left);
    if (lhsSym === undefined && !ctx.moduleGlobals.has(name) && ctx.capturedGlobals.get(name) === undefined) {
      emitThrowReferenceError(ctx, fctx, `${name} is not defined`);
      // After throw the stack is polymorphic; push a sentinel so callers that
      // expect a compound-assignment result value (f64) typecheck.
      fctx.body.push({ op: "f64.const", value: 0 });
      return { kind: "f64" };
    }
    // Graceful fallback: auto-allocate a local for the unknown identifier
    // so compound assignments work correctly (the variable is initialized
    // to the appropriate zero value).
    const tsType = ctx.checker.getTypeAtLocation(expr.left);
    const wasmType = resolveWasmType(ctx, tsType);
    localIdx = allocLocal(fctx, name, wasmType);
  }

  // Handle boxed (ref cell) mutable captures
  const boxed = fctx.boxedCaptures?.get(name);
  if (boxed) {
    // Read current value from ref cell (null-guarded: if ref cell is null,
    // use default value for the compound op instead of trapping #702)
    fctx.body.push({ op: "local.get", index: localIdx });
    emitNullGuardedStructGet(
      ctx,
      fctx,
      { kind: "ref_null", typeIdx: boxed.refCellTypeIdx },
      boxed.valType,
      boxed.refCellTypeIdx,
      0,
      undefined /* propName */,
      false /* throwOnNull — ref cells use default for uninitialized captures */,
    );

    // For externref boxed captures, check if += should be string concat (#795)
    if (boxed.valType.kind === "externref" && op === ts.SyntaxKind.PlusEqualsToken) {
      const rightTsType = ctx.checker.getTypeAtLocation(expr.right);
      const rhsIsString = isStringType(rightTsType);
      // A statically string-typed LHS (`let acc = ""` / `let acc: string`) must
      // concat even when the RHS is numeric (`acc += x`) — JS coerces x to
      // string. #1999.
      const lhsIsString = isStringType(ctx.checker.getTypeAtLocation(expr.left));
      // Also check if the variable was assigned a string in any enclosing scope
      const varHasStringAssign = hasStringAssignment(name, expr) || hasStringAssignmentInParentScopes(name, expr);
      if (rhsIsString || lhsIsString || varHasStringAssign) {
        // String concat path: current value (externref) is on stack
        addStringImports(ctx);
        const concatIdx = ctx.jsStringImports.get("concat");
        if (concatIdx !== undefined) {
          const compoundRhsStr = compileExpression(ctx, fctx, expr.right);
          if (!compoundRhsStr) {
            reportError(ctx, expr, "Failed to compile compound assignment RHS");
            return null;
          }
          // Coerce RHS to externref if needed (e.g. number → string)
          if (compoundRhsStr.kind === "f64" || compoundRhsStr.kind === "i32") {
            if (compoundRhsStr.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
            const toStr = ctx.funcMap.get("number_toString");
            if (toStr !== undefined) fctx.body.push({ op: "call", funcIdx: toStr });
          }
          fctx.body.push({ op: "call", funcIdx: concatIdx });
          // Write back to ref cell
          const tmpStrResult = allocLocal(fctx, `__box_cmp_${fctx.locals.length}`, boxed.valType);
          fctx.body.push({ op: "local.set", index: tmpStrResult });
          fctx.body.push({ op: "local.get", index: localIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [],
            else: [
              { op: "local.get", index: localIdx },
              { op: "local.get", index: tmpStrResult },
              { op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 },
            ],
          });
          fctx.body.push({ op: "local.get", index: tmpStrResult });
          return boxed.valType;
        }
      }
    }

    // (#3328) Native-strings analog of the #795 externref string-concat arm
    // above. Under nativeStrings a captured string's cell valType is a
    // `ref/ref_null $AnyString`-family type — NOT externref — so the #795 gate
    // never fired and `log += 'y'` inside a capturing closure fell to the f64
    // arithmetic below: the string cell value was coerced string→number,
    // f64.add'd, and the f64→string writeback coercion has no arm, emitting a
    // `ref.null` + `ref.as_non_null` placeholder — a GUARANTEED
    // "dereferencing a null pointer" trap the first time any capturing
    // toString/valueOf ran (blocked Date/UTC coercion-order.js and every
    // capturing-ToPrimitive test262 row).
    if (
      op === ts.SyntaxKind.PlusEqualsToken &&
      ctx.nativeStrings &&
      ctx.anyStrTypeIdx >= 0 &&
      (boxed.valType.kind === "ref" || boxed.valType.kind === "ref_null") &&
      ((boxed.valType as { typeIdx: number }).typeIdx === ctx.anyStrTypeIdx ||
        (boxed.valType as { typeIdx: number }).typeIdx === ctx.nativeStrTypeIdx)
    ) {
      // Oracle-routed (#1930 ratchet): fact kind "string" covers String |
      // StringLiteral; the String wrapper object (`new String("x")`)
      // classifies as builtin "String" — same coverage as isStringType.
      const rhsFactN = ctx.oracle.typeFactOf(expr.right);
      const lhsFactN = ctx.oracle.typeFactOf(expr.left);
      const rhsIsStringN = rhsFactN.kind === "string" || (rhsFactN.kind === "builtin" && rhsFactN.name === "String");
      const lhsIsStringN = lhsFactN.kind === "string" || (lhsFactN.kind === "builtin" && lhsFactN.name === "String");
      const varHasStringAssignN = hasStringAssignment(name, expr) || hasStringAssignmentInParentScopes(name, expr);
      const concatIdxN = ctx.nativeStrHelpers.get("__str_concat");
      if (concatIdxN !== undefined && (rhsIsStringN || lhsIsStringN || varHasStringAssignN)) {
        // Current cell value (ref/ref_null $AnyString) is on the stack from the
        // null-guarded read above. RHS → non-null ref $AnyString (numbers via
        // number_toString, booleans via emitBoolToString — the same coercions
        // the unboxed native-string += uses).
        const coercedRhs = compileAndCoerceToAnyStr(ctx, fctx, expr.right);
        if (coercedRhs !== null) {
          fctx.body.push({ op: "call", funcIdx: concatIdxN });
          // A concrete $NativeString cell can't hold the ConsString concat
          // result — flatten first. $AnyString cells store it directly.
          if (
            (boxed.valType as { typeIdx: number }).typeIdx === ctx.nativeStrTypeIdx &&
            ctx.nativeStrTypeIdx !== ctx.anyStrTypeIdx
          ) {
            const flattenIdxN = ctx.nativeStrHelpers.get("__str_flatten");
            if (flattenIdxN !== undefined) fctx.body.push({ op: "call", funcIdx: flattenIdxN });
          }
          const tmpStrN = allocLocal(fctx, `__box_cmp_${fctx.locals.length}`, boxed.valType);
          fctx.body.push({ op: "local.set", index: tmpStrN });
          fctx.body.push({ op: "local.get", index: localIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [],
            else: [
              { op: "local.get", index: localIdx },
              { op: "local.get", index: tmpStrN },
              { op: "struct.set", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 },
            ],
          });
          fctx.body.push({ op: "local.get", index: tmpStrN });
          return boxed.valType;
        }
        reportError(ctx, expr, "Failed to compile string += RHS");
        return null;
      }
    }

    // The compound-op switch below emits f64 arithmetic, so any non-f64 cell
    // value (and its RHS) must be promoted to f64 first and coerced back on
    // writeback. This includes i32 (#2120): a captured i32 loop var that is
    // also compound-assigned in the body (`for (let i…) { f = () => i; i += 1 }`)
    // read the cell as i32 but hit `f64.add`, producing an invalid module
    // (F64Add left value type mismatch). The i32↔f64 round-trip is exact for the
    // counter range. (#795, #816 covered the externref/other-ref cells.)
    const boxedNeedsCoerce = boxed.valType.kind !== "f64";
    if (boxedNeedsCoerce) {
      coerceType(ctx, fctx, boxed.valType, { kind: "f64" });
    }

    const compoundRhsBoxed = compileExpression(
      ctx,
      fctx,
      expr.right,
      boxedNeedsCoerce ? { kind: "f64" } : boxed.valType,
    );
    if (!compoundRhsBoxed) {
      reportError(ctx, expr, "Failed to compile compound assignment RHS");
      return null;
    }
    // Coerce RHS to f64 if needed (#795, #816)
    if (boxedNeedsCoerce && compoundRhsBoxed.kind !== "f64") {
      coerceType(ctx, fctx, compoundRhsBoxed, { kind: "f64" });
    }

    switch (op) {
      case ts.SyntaxKind.PlusEqualsToken:
        fctx.body.push({ op: "f64.add" });
        break;
      case ts.SyntaxKind.MinusEqualsToken:
        fctx.body.push({ op: "f64.sub" });
        break;
      case ts.SyntaxKind.AsteriskEqualsToken:
        fctx.body.push({ op: "f64.mul" });
        break;
      case ts.SyntaxKind.SlashEqualsToken:
        fctx.body.push({ op: "f64.div" });
        break;
      case ts.SyntaxKind.PercentEqualsToken:
        emitModulo(ctx, fctx);
        break;
      case ts.SyntaxKind.AsteriskAsteriskEqualsToken: {
        const fi = ctx.funcMap.get("Math_pow");
        if (fi !== undefined) fctx.body.push({ op: "call", funcIdx: fi });
        break;
      }
      case ts.SyntaxKind.AmpersandEqualsToken:
      case ts.SyntaxKind.BarEqualsToken:
      case ts.SyntaxKind.CaretEqualsToken:
      case ts.SyntaxKind.LessThanLessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
        emitBitwiseCompoundOp(fctx, op);
        break;
    }

    // Coerce result back to original type if the ref cell stores non-f64 (#795, #816)
    if (boxedNeedsCoerce) {
      coerceType(ctx, fctx, { kind: "f64" }, boxed.valType);
    }

    // Write back to ref cell (skip if ref cell is null #702)
    const tmpResult = allocLocal(fctx, `__box_cmp_${fctx.locals.length}`, boxed.valType);
    fctx.body.push({ op: "local.set", index: tmpResult });
    fctx.body.push({ op: "local.get", index: localIdx });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [
        { op: "local.get", index: localIdx },
        { op: "local.get", index: tmpResult },
        {
          op: "struct.set",
          typeIdx: boxed.refCellTypeIdx,
          fieldIdx: 0,
        },
      ],
    });
    fctx.body.push({ op: "local.get", index: tmpResult });
    return boxed.valType;
  }

  let localType = getLocalType(fctx, localIdx) ?? { kind: "f64" as const };
  let needsLocalCoerce = localType.kind !== "f64";

  fctx.body.push({ op: "local.get", index: localIdx });
  if (needsLocalCoerce) coerceType(ctx, fctx, localType, { kind: "f64" });

  const compoundRhsType3 = compileExpression(ctx, fctx, expr.right, {
    kind: "f64",
  });
  if (!compoundRhsType3) {
    reportError(ctx, expr, "Failed to compile compound assignment RHS");
    return null;
  }
  if (compoundRhsType3.kind !== "f64") coerceType(ctx, fctx, compoundRhsType3, { kind: "f64" });

  // (#3024) Compiling the RHS can PROMOTE this local's slot from a concrete
  // primitive to externref mid-expression — e.g. `x *= eval("var x = 2;")`,
  // where the direct-eval body redeclares `x` (the re-declaration re-type in
  // statements/variables.ts). The left value was already emitted above as a raw
  // `local.get` of the then-f64 slot with no coercion, so it is now a stale
  // externref buried under the (f64) RHS on the stack — and the writeback below
  // would `local.tee` an f64 into what is now an externref slot. Both are invalid
  // Wasm. Detect the flip (slot was primitive when read, is externref now) and
  // repair: unbox the buried left operand to f64 (save RHS, coerce left, restore
  // RHS), then switch the writeback to re-box via the externref path. Guarded on
  // an actual primitive→externref flip, so ordinary compound assignments are
  // byte-inert.
  const localTypeAfter = getLocalType(fctx, localIdx);
  if (!needsLocalCoerce && localType.kind === "f64" && localTypeAfter?.kind === "externref") {
    const tmpRhs = allocLocal(fctx, `__cmp3024_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: tmpRhs });
    coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" }, "number");
    fctx.body.push({ op: "local.get", index: tmpRhs });
    localType = { kind: "externref" };
    needsLocalCoerce = true;
  }

  emitCompoundOp(ctx, fctx, op);

  if (needsLocalCoerce) {
    coerceType(ctx, fctx, { kind: "f64" }, localType);
    fctx.body.push({ op: "local.tee", index: localIdx });
    emitMappedArgParamSync(ctx, fctx, localIdx, localType);
    return localType;
  }
  fctx.body.push({ op: "local.tee", index: localIdx });
  emitMappedArgParamSync(ctx, fctx, localIdx, { kind: "f64" });
  return { kind: "f64" };
}

/** Emit bitwise compound op: stack has [left_f64, right_f64], replaces with result f64 */
function emitBitwiseCompoundOp(fctx: FunctionContext, op: ts.SyntaxKind): void {
  const opMap: Record<
    number,
    {
      i32op: "i32.and" | "i32.or" | "i32.xor" | "i32.shl" | "i32.shr_s" | "i32.shr_u";
      unsigned: boolean;
    }
  > = {
    [ts.SyntaxKind.AmpersandEqualsToken]: { i32op: "i32.and", unsigned: false },
    [ts.SyntaxKind.BarEqualsToken]: { i32op: "i32.or", unsigned: false },
    [ts.SyntaxKind.CaretEqualsToken]: { i32op: "i32.xor", unsigned: false },
    [ts.SyntaxKind.LessThanLessThanEqualsToken]: {
      i32op: "i32.shl",
      unsigned: false,
    },
    [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: {
      i32op: "i32.shr_s",
      unsigned: false,
    },
    [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: {
      i32op: "i32.shr_u",
      unsigned: true,
    },
  };
  const entry = opMap[op]!;
  const tmpR = allocLocal(fctx, `__bw_r_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: tmpR });
  emitToInt32(fctx);
  fctx.body.push({ op: "local.get", index: tmpR });
  emitToInt32(fctx);
  fctx.body.push({ op: entry.i32op });
  fctx.body.push({
    op: entry.unsigned ? "f64.convert_i32_u" : "f64.convert_i32_s",
  });
}

/** Emit the arithmetic/bitwise operation for a compound assignment operator.
 *  Stack must contain [left_f64, right_f64]. Replaces with result f64. */
export function emitCompoundOp(ctx: CodegenContext, fctx: FunctionContext, op: ts.SyntaxKind): void {
  switch (op) {
    case ts.SyntaxKind.PlusEqualsToken:
      fctx.body.push({ op: "f64.add" });
      break;
    case ts.SyntaxKind.MinusEqualsToken:
      fctx.body.push({ op: "f64.sub" });
      break;
    case ts.SyntaxKind.AsteriskEqualsToken:
      fctx.body.push({ op: "f64.mul" });
      break;
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken: {
      const funcIdx = ctx.funcMap.get("Math_pow");
      if (funcIdx !== undefined) fctx.body.push({ op: "call", funcIdx });
      break;
    }
    case ts.SyntaxKind.SlashEqualsToken:
      fctx.body.push({ op: "f64.div" });
      break;
    case ts.SyntaxKind.PercentEqualsToken:
      emitModulo(ctx, fctx);
      break;
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      emitBitwiseCompoundOp(fctx, op);
      break;
  }
}

/**
 * Compile compound assignment on a property access target: obj.prop += value
 * Pattern: read obj.prop, compile RHS, apply op, store back into obj.prop
 */
function compilePropertyCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(target.expression);
  const propName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;

  // (#3872) Compound assignment to a non-writable data property — `o.p %= 20`
  // after `defineProperty(o,"p",{writable:false})`. §13.15.2 evaluates the RHS
  // and computes, then PutValue fails: strict throws a TypeError.
  //
  // STRICT ONLY, deliberately. In strict mode the throw discards the computed
  // value, so evaluating the RHS for its side effects and throwing is exact.
  // Sloppy mode would need the *computed* value (GetValue ∘ op ∘ RHS) as the
  // expression result while suppressing only the store — the surrounding code
  // fuses those, and returning the bare RHS instead (the #2667 mapped-arguments
  // shortcut) is correct for a simple assignment but WRONG here. So sloppy
  // still falls through rather than being given a wrong expression value.
  // The corpus this targets is `onlyStrict` (`11.13.2-*-s.js`), so the strict
  // arm covers it; sloppy compound is recorded as not-covered in the issue.
  if (
    isNonWritableDataProperty(ctx, target.expression, propName) &&
    isStrictContext(target, ctx.inferModuleStrictArguments)
  ) {
    const rhsType = compileExpression(ctx, fctx, rhs);
    if (rhsType) fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, `Cannot assign to read only property '${propName}' of object`);
    return { kind: "f64" }; // unreachable after the throw
  }

  // (#3683 S2 branch c1) TYPED-`this` compound assignment inside a twin. Only
  // entered for operators `emitCompoundOp` actually lowers — its switch has no
  // `default`, so an unlisted one would strand the read + RHS on the stack.
  if (EMIT_COMPOUND_OP_HANDLES.has(op)) {
    const typed = tryEmitTypedThisCompound(ctx, fctx, target, rhs, op, emitCompoundOp);
    if (typed !== undefined) return typed;
  }

  // (#3496 merge-queue follow-up) `globalThis.<name> op= value` must keep the
  // receiver on the realm-object externref path for both its read and write.
  // The generic compound path resolves TypeScript's structural
  // `typeof globalThis` as a Wasm struct before compiling the receiver, then
  // casts the real host/native global object to that unrelated struct. The
  // cast traps before the dedicated globalThis read/write lowerings can run.
  // Plain reads and `=` writes already force this same externref route.
  if (ts.isIdentifier(target.expression) && target.expression.text === "globalThis") {
    return compilePropertyCompoundAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  // #1456: Private methods and getter-only accessors throw TypeError on write
  if (ts.isPrivateIdentifier(target.name)) {
    const privateMember = classifyPrivateMember(ctx, target.name);
    if (privateMember?.kind === "method" || privateMember?.kind === "accessor-readonly") {
      // Evaluate receiver for side effects (spec evaluates Reference before throwing)
      const receiverResult = compileExpression(ctx, fctx, target.expression);
      if (receiverResult) fctx.body.push({ op: "drop" });
      // Evaluate RHS for side effects
      const rhsResult = compileExpression(ctx, fctx, rhs);
      if (rhsResult) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "Cannot assign to private method or read-only accessor");
      return { kind: "f64" };
    }
  }

  // Handle static property compound assignment: ClassName.staticProp += value
  if (ts.isIdentifier(target.expression) && ctx.classSet.has(target.expression.text)) {
    const clsName = target.expression.text;
    const fullName = `${clsName}_${propName}`;
    const globalIdx = ctx.staticProps.get(fullName);
    if (globalIdx !== undefined) {
      // Read current value
      fctx.body.push({ op: "global.get", index: globalIdx });
      // Compile RHS
      const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
      if (!rhsType) return null;
      // Apply op
      emitCompoundOp(ctx, fctx, op);
      // Store back
      fctx.body.push({ op: "global.set", index: globalIdx });
      fctx.body.push({ op: "global.get", index: globalIdx });
      return { kind: "f64" };
    }
  }

  // Resolve struct type
  const typeName = resolveStructNameForExpr(ctx, fctx, target.expression);
  if (!typeName) {
    // Fallback: treat as externref property access via __extern_get / __extern_set
    return compilePropertyCompoundAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  // Check for accessor properties (get/set) before looking up struct fields
  const accessorKey = `${typeName}_${propName}`;
  if (ctx.classAccessorSet.has(accessorKey)) {
    const getterName = `${typeName}_get_${propName}`;
    const setterName = `${typeName}_set_${propName}`;
    const getterIdx = ctx.funcMap.get(getterName);
    const setterIdx = ctx.funcMap.get(setterName);
    if (getterIdx !== undefined && setterIdx !== undefined) {
      // Compile the object expression and save to a temp local, coercing to getter's self type
      const cmpGetterPTypes = getFuncParamTypes(ctx, getterIdx);
      const objResult = compileExpression(ctx, fctx, target.expression, cmpGetterPTypes?.[0]);
      if (!objResult) return null;
      const objTmp = allocLocal(fctx, `__cmpd_acc_obj_${fctx.locals.length}`, objResult);
      fctx.body.push({ op: "local.set", index: objTmp });

      // Read current value via getter: obj.get_prop()
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "call", funcIdx: getterIdx });

      // Compile RHS as f64
      const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
      if (!rhsType) return null;

      // Apply compound operation
      emitCompoundOp(ctx, fctx, op);

      // Save result
      const resultTmp = allocLocal(fctx, `__cmpd_acc_res_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: resultTmp });

      // Store back via setter: obj.set_prop(result)
      fctx.body.push({ op: "local.get", index: objTmp });
      // Coerce f64 result to setter's expected value param type
      const cmpSetterParamTypes = getFuncParamTypes(ctx, setterIdx);
      const cmpSetterValType = cmpSetterParamTypes?.[1]; // param 0 = self, param 1 = value
      if (cmpSetterValType) {
        fctx.body.push({ op: "local.get", index: resultTmp });
        if (cmpSetterValType.kind === "externref") {
          // f64 → externref: box the number
          addUnionImports(ctx);
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
        }
      }
      // If setter has no value parameter (only self), don't push value
      const finalCmpSetterIdx = ctx.funcMap.get(setterName) ?? setterIdx;
      fctx.body.push({ op: "call", funcIdx: finalCmpSetterIdx });

      // Return the result
      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "f64" };
    }
  }

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    // Struct not found — fall back to externref property access
    return compilePropertyCompoundAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx === -1) {
    // Unknown field — fall back to externref property access
    return compilePropertyCompoundAssignmentExternref(ctx, fctx, target, rhs, op, propName);
  }

  const fieldType = fields[fieldIdx]!.type;

  // Compile the object expression and save to a temp local
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  const objTmp = allocLocal(fctx, `__cmpd_obj_${fctx.locals.length}`, objResult);
  fctx.body.push({ op: "local.set", index: objTmp });

  // Read current value: obj.prop
  fctx.body.push({ op: "local.get", index: objTmp });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

  // Coerce field value to f64 for arithmetic
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, fieldType, { kind: "f64" });
  }

  // Compile RHS as f64
  const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
  if (!rhsType) return null;

  // Apply compound operation
  emitCompoundOp(ctx, fctx, op);

  // Save result
  const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: resultTmp });

  // Store back: obj.prop = result (coerced to field type)
  fctx.body.push({ op: "local.get", index: objTmp });
  fctx.body.push({ op: "local.get", index: resultTmp });
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, { kind: "f64" }, fieldType);
  }
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });

  // Return the result (as f64)
  fctx.body.push({ op: "local.get", index: resultTmp });
  return { kind: "f64" };
}

/**
 * Fallback for compound assignment on a property access target when the
 * struct type cannot be resolved statically.
 *
 * Strategy:
 * 1. Compile the object expression to discover its runtime Wasm type.
 * 2. If the result is a struct ref, look up the field by name in that struct
 *    and perform struct.get / struct.set.
 * 3. If the result is externref, use __extern_get / __extern_set with the
 *    property name as a string key (same pattern as element access compound).
 */
function compilePropertyCompoundAssignmentExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
  propName: string,
): ValType | null {
  // Compile the object expression to discover its runtime type
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;

  // --- Path A: The object compiled to a struct ref ---
  if (objResult.kind === "ref" || objResult.kind === "ref_null") {
    const typeIdx = (objResult as { typeIdx: number }).typeIdx;
    // Find the struct fields by looking up which typeName maps to this typeIdx
    const resolvedTypeName = ctx.typeIdxToStructName.get(typeIdx);
    if (resolvedTypeName) {
      const fields = ctx.structFields.get(resolvedTypeName);
      if (fields) {
        let fieldIdx = fields.findIndex((f) => f.name === propName);

        // If the field doesn't exist yet, try to add it dynamically from TS type info
        // but NEVER for class struct types — their fields are fixed at collection time
        if (fieldIdx === -1 && !ctx.classSet.has(resolvedTypeName)) {
          const objTsType = ctx.checker.getTypeAtLocation(target.expression);
          const tsProps = objTsType.getProperties?.();
          if (tsProps) {
            const tsProp = tsProps.find((p) => p.name === propName);
            if (tsProp) {
              const propTsType = ctx.checker.getTypeOfSymbolAtLocation(tsProp, target);
              const propWasmType = resolveWasmType(ctx, propTsType);
              const newField: FieldDef = {
                name: propName,
                type: propWasmType,
                mutable: true,
              };
              fields.push(newField);
              // fields === typeDef.fields (same array ref from structFields map)
              patchStructNewForAddedField(ctx, fctx, typeIdx, propWasmType);
              const typeDef = ctx.mod.types[typeIdx];
              if (typeDef?.kind === "struct" && typeDef.fields !== fields) {
                typeDef.fields.push(newField);
              }
              // Patch existing struct.new instructions to include the new field
              patchStructNewForDynamicField(ctx, typeIdx, propWasmType);
              fieldIdx = fields.length - 1;
            }
          }
        }

        if (fieldIdx !== -1) {
          const fieldType = fields[fieldIdx]!.type;
          // Save object to temp local
          const objTmp = allocLocal(fctx, `__cmpd_obj_${fctx.locals.length}`, objResult);
          fctx.body.push({ op: "local.set", index: objTmp });

          // Read current value
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });

          // Coerce field value to f64 for arithmetic
          if (fieldType.kind !== "f64") {
            coerceType(ctx, fctx, fieldType, { kind: "f64" });
          }

          // Compile RHS as f64
          const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
          if (!rhsType) return null;

          // Apply compound operation
          emitCompoundOp(ctx, fctx, op);

          // Save result
          const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: resultTmp });

          // Store back
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "local.get", index: resultTmp });
          if (fieldType.kind !== "f64") {
            coerceType(ctx, fctx, { kind: "f64" }, fieldType);
          }
          fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });

          // Return the result as f64
          fctx.body.push({ op: "local.get", index: resultTmp });
          return { kind: "f64" };
        }
      }
    }

    // Struct ref but field not found — convert to externref and fall through to path B
    fctx.body.push({ op: "extern.convert_any" });
  } else if (objResult.kind !== "externref") {
    // For f64/i32, box to externref
    if (objResult.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
    } else if (objResult.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
    } else {
      // Unknown type — emit NaN as graceful fallback
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }
  }

  // --- Path B: externref-based property compound assignment ---
  // Save obj to local
  const objLocal = allocLocal(fctx, `__cmpd_pobj_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Ensure the property name string constant is registered
  addStringConstantGlobal(ctx, propName);

  // Compile propName as externref string and save to local
  const keyResult = compileStringLiteral(ctx, fctx, propName);
  if (!keyResult) return null;
  if (keyResult.kind !== "externref") {
    coerceType(ctx, fctx, keyResult, { kind: "externref" });
  }
  const keyLocal = allocLocal(fctx, `__cmpd_pkey_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: keyLocal });

  // (#2681/#2686) Is the receiver a PINNED reconstructed-fnctor struct (acorn's
  // `this.pos`, `this`/flow-mapped)? Only THEN do the compound read+write route
  // through the `__get_member`/`__set_member` struct dispatchers (slot), staying
  // symmetric with the pinned simple read/write so `this.pos += 1` advances. For
  // a GENERAL `any`-receiver (a plain object literal lowered to an anonymous
  // `$__anon_N` struct), the dispatcher's struct arm would read/write the SLOT and
  // bypass the delete-tombstone/ordering sidecar semantics (#2179/#2731 — the
  // `for-in/order-simple-object` regressor), so a general receiver stays on the
  // bare `__extern_get`/`__extern_set` sidecar.
  const pinnedCompound =
    (target.expression.kind === ts.SyntaxKind.ThisKeyword && fctx.thisStructName !== undefined) ||
    resolveReceiverStruct(ctx, fctx, target.expression) !== undefined;

  // Read current value. When pinned, route through the symmetric
  // `__get_member_<name>` dispatcher (`struct.get` arms + `__extern_get` terminal)
  // so read/write stay consistent with the A3 main-path read; otherwise the bare
  // tombstone-aware `__extern_get`.
  fctx.body.push({ op: "local.get", index: objLocal });
  const getDispIdx = pinnedCompound ? reserveMemberGetDispatch(ctx, propName, fctx) : undefined;
  if (getDispIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: getDispIdx });
  } else {
    fctx.body.push({ op: "local.get", index: keyLocal });
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (getIdx === undefined) return null;
    fctx.body.push({ op: "call", funcIdx: getIdx });
  }

  // (#2850) `obj.prop += rhs` on a dynamic (externref/any) receiver: JS `+` is
  // NOT numeric-only — §13.15.3 string-concatenates when either primitive is a
  // string. The unconditional `__unbox_number → f64.add → __box_number` chain
  // below turned acorn's `state.lastStringValue += codePointToString(ch)` into
  // NaN, which broke EVERY multi-named-group regex ("Duplicate capture group
  // name" — both names keyed "NaN") and EVERY `\p{…}/u` property escape
  // ("Invalid property name" — the property name string was NaN). Route the
  // `+=` current-value/RHS pair through the runtime-dispatched JS `+`
  // (`__host_add`, the same bridge emitAnyAdd/#2058 uses for identifier
  // targets).
  //
  // (#3673) …and the STANDALONE/WASI lane now too. #2850 left it out ("its
  // extern property surface is a different, native lowering"), so the exact
  // symptoms #2850 names were still live standalone — compiled acorn's
  // `state.lastStringValue += codePointToString(state.lastIntValue)` NaN'd, so
  // every named capture group keyed the SAME `groupNames` entry and
  // `/(?<year>\d{4})-(?<month>\d{2})/` failed with "Duplicate capture group
  // name". Standalone has no `__host_add` import; `emitAnyAddFromExternTemps`
  // is the in-module §13.15.3 dispatch (`__to_primitive` → typeof-string test →
  // `__str_concat` or `f64.add`) that `emitAnyAdd` already builds for this lane,
  // split out so a caller with pre-evaluated operands can reach it.
  if (op === ts.SyntaxKind.PlusEqualsToken) {
    const noJsHostAdd = ctx.targetProfile.semanticProviders === "native-first";
    if (noJsHostAdd) {
      // Current value is on the stack (from the read above) — park it, then
      // evaluate the RHS, so both operands are temps the dispatch can re-read.
      const lTmp = allocLocal(fctx, `__cmpd_padd_l_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: lTmp });
      const rhsAny = compileExpression(ctx, fctx, rhs, { kind: "externref" });
      if (!rhsAny) return null;
      if (rhsAny.kind !== "externref") {
        coerceType(ctx, fctx, rhsAny, { kind: "externref" });
      }
      const rTmp = allocLocal(fctx, `__cmpd_padd_r_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: rTmp });
      const addType = emitAnyAddFromExternTemps(ctx, fctx, lTmp, rTmp);
      // The no-native-strings fallback yields f64; box it so the write-back
      // below (which stores an externref) stays uniform.
      if (addType.kind !== "externref") {
        coerceType(ctx, fctx, addType, { kind: "externref" });
      }
    } else {
      const rhsAny = compileExpression(ctx, fctx, rhs, { kind: "externref" });
      if (!rhsAny) return null;
      if (rhsAny.kind !== "externref") {
        coerceType(ctx, fctx, rhsAny, { kind: "externref" });
      }
      const hostAddIdx = ensureLateImport(
        ctx,
        "__host_add",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      const finalAddIdx = ctx.funcMap.get("__host_add") ?? hostAddIdx;
      if (finalAddIdx === undefined) {
        reportError(ctx, target, "Missing __host_add for compound externref property assignment");
        return null;
      }
      fctx.body.push({ op: "call", funcIdx: finalAddIdx });
    }
    const anyResultLocal = allocLocal(fctx, `__cmpd_pany_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: anyResultLocal });

    // Write back — same pinned-dispatch/bare-host split as the numeric arm.
    // (#3430) The BARE (non-pinned) fallback is the general `obj.prop += v`
    // path for a plain externref/host-object receiver — select the strict
    // sidecar terminal there so a failed [[Set]] (non-writable data property /
    // new key on a non-extensible object) throws under a strict Reference,
    // matching plain `=` assignment (assignment.ts, #3374). The PINNED
    // dispatcher branch below keeps its existing NON-strict wiring unchanged
    // (see its own comment) — this only affects the bare sidecar write.
    const anySetName = isStrictContext(target, ctx.inferModuleStrictArguments) ? "__extern_set_strict" : "__extern_set";
    const setAnyIdx = ensureLateImport(
      ctx,
      anySetName,
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [],
    );
    flushLateImportShifts(ctx, fctx);
    const anyDispatched =
      pinnedCompound && emitAlternateStructSetDispatch(ctx, fctx, objLocal, anyResultLocal, propName, /*strict*/ false);
    if (!anyDispatched) {
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "local.get", index: keyLocal });
      fctx.body.push({ op: "local.get", index: anyResultLocal });
      if (setAnyIdx !== undefined) fctx.body.push({ op: "call", funcIdx: setAnyIdx });
    }
    fctx.body.push({ op: "local.get", index: anyResultLocal });
    return { kind: "externref" };
  }

  // Ensure union imports (including __unbox_number, __box_number) are registered
  addUnionImports(ctx);

  // Unbox to f64: __unbox_number(externref) -> f64
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  if (unboxIdx === undefined) {
    reportError(ctx, target, "Missing __unbox_number for compound externref property assignment");
    return null;
  }
  fctx.body.push({ op: "call", funcIdx: unboxIdx });

  // Compile RHS as f64
  const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
  if (!rhsType) return null;

  // Apply compound operation (stack: [lhs_f64, rhs_f64] -> result_f64)
  emitCompoundOp(ctx, fctx, op);

  // Save result for return value
  const resultLocal = allocLocal(fctx, `__cmpd_pres_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Box result to externref: __box_number(f64) -> externref
  fctx.body.push({ op: "local.get", index: resultLocal });
  const boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx === undefined) {
    reportError(ctx, target, "Missing __box_number for compound externref property assignment");
    return null;
  }
  fctx.body.push({ op: "call", funcIdx: boxIdx });
  const boxedLocal = allocLocal(fctx, `__cmpd_pboxed_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: boxedLocal });

  // Write back. (#2655) The member-READ fast path resolves an `any`/`externref`
  // receiver that is actually a typed WasmGC struct via `struct.get <slot>`
  // (property-access.ts), but a plain `__extern_set` write-back routes through
  // `_safeSet` to a JS-side SIDECAR — it cannot write the struct slot. The two
  // then diverge (acorn's `this.pos += 1` loop condition reads the frozen slot
  // forever → infinite loop). Emit the SYMMETRIC struct.set dispatch first so
  // the slot is written when the receiver owns `propName` as a real field;
  // fall back to `__extern_set` for genuine host externrefs / sidecar-only props.
  // (#3430) The bare fallback selects the strict sidecar terminal for a
  // strict Reference — see the `+=` string-concat arm above for rationale;
  // this is the numeric-op mirror of the same fix.
  const cmpdSetName = isStrictContext(target, ctx.inferModuleStrictArguments) ? "__extern_set_strict" : "__extern_set";
  const setIdx = ensureLateImport(
    ctx,
    cmpdSetName,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  // (#2664) Route through the deferred-fill member-set dispatcher (NON-strict —
  // `obj.x += v` already read the property, so the sidecar update never hits a
  // getter-only-accessor throw). The dispatcher's terminal else-arm IS the
  // `__extern_set` sidecar; its struct-candidate arms are enumerated at finalize
  // (the full type table), fixing the compile-order candidate freeze (#2664).
  // (#2681/#2686) Only a PINNED reconstructed-fnctor receiver uses the struct.set
  // dispatcher (symmetric with the pinned read above); a general any-receiver
  // (plain object) stays on the bare `__extern_set` sidecar to preserve the
  // delete-tombstone/ordering semantics (#2179/#2731).
  const cmpdDispatched =
    pinnedCompound && emitAlternateStructSetDispatch(ctx, fctx, objLocal, boxedLocal, propName, /*strict*/ false);
  if (!cmpdDispatched) {
    // Not pinned (or dispatcher not reservable) — emit the bare host write.
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: boxedLocal });
    if (setIdx !== undefined) fctx.body.push({ op: "call", funcIdx: setIdx });
  }

  // Return the result as f64
  fctx.body.push({ op: "local.get", index: resultLocal });
  return { kind: "f64" };
}

/**
 * Compile compound assignment on an element access target: arr[i] += value
 * Handles both vec structs (arrays) and plain structs (bracket notation).
 */
function compileElementCompoundAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  rhs: ts.Expression,
  op: ts.SyntaxKind,
): ValType | null {
  // (#3872) Computed COMPOUND write to a non-writable data property —
  // `o[k] %= 20`. The fourth and last of the assignment shapes this issue
  // names; the other three are handled in `compilePropertyAssignment`,
  // `compilePropertyCompoundAssignment` and `compileElementAssignment`.
  // Strict-only for the same reason as the property-compound arm: sloppy would
  // need the computed value while suppressing only the store, and the lowering
  // fuses those.
  if (ts.isIdentifier(target.expression)) {
    const nwKey = resolveComputedKeyExpression(ctx, target.argumentExpression);
    if (
      nwKey !== undefined &&
      isNonWritableDataProperty(ctx, target.expression, nwKey) &&
      isStrictContext(target, ctx.inferModuleStrictArguments)
    ) {
      const keyType = compileExpression(ctx, fctx, target.argumentExpression);
      if (keyType !== null) fctx.body.push({ op: "drop" });
      const rhsType = compileExpression(ctx, fctx, rhs);
      if (rhsType) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, `Cannot assign to read only property '${nwKey}' of object`);
      return { kind: "f64" }; // unreachable after the throw
    }
  }

  // #2045 C.8: compound write `b[i] op= rhs` on a linear-backed Uint8Array must
  // read-modify-write the linear memory. Without this it fell through to the
  // GC/externref path below (which materialises the buffer as a value and never
  // touches linear memory), so `b[0] += 1` silently kept the old byte. Try the
  // linear read-modify-write first; falls through to GC for any other target.
  const linU8Compound = tryEmitLinearU8ElementCompound(ctx, fctx, target, () => {
    // current element value is already on the stack as f64; push rhs, apply op.
    compileExpression(ctx, fctx, rhs, { kind: "f64" });
    emitCompoundOp(ctx, fctx, op);
  });
  if (linU8Compound !== null) return linU8Compound;

  // Compile the object expression
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;

  // Externref element access compound assignment
  // Pattern: read via __extern_get, unbox, operate, box, write via __extern_set
  if (objResult.kind === "externref") {
    // Save obj to local
    const objLocal = allocLocal(fctx, `__cmpd_eobj_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: objLocal });

    const keyLocal = compileComputedMemberKeyAfterBaseGuard(
      ctx,
      fctx,
      objLocal,
      target.argumentExpression,
      "__cmpd_ekey",
    );
    if (keyLocal === null) return null;

    // Read current value: __extern_get(obj, key) -> externref
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (getIdx === undefined) return null;
    fctx.body.push({ op: "call", funcIdx: getIdx });

    // Ensure union imports (including __unbox_number, __box_number) are registered
    addUnionImports(ctx);

    // Unbox to f64: __unbox_number(externref) -> f64
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx === undefined) {
      reportError(ctx, target, "Missing __unbox_number for compound externref assignment");
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: unboxIdx });

    // Compile RHS as f64
    const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
    if (!rhsType) return null;

    // Apply compound operation (stack: [lhs_f64, rhs_f64] -> result_f64)
    emitCompoundOp(ctx, fctx, op);

    // Save result for return value
    const resultLocal = allocLocal(fctx, `__cmpd_eres_${fctx.locals.length}`, {
      kind: "f64",
    });
    fctx.body.push({ op: "local.set", index: resultLocal });

    // Box result to externref: __box_number(f64) -> externref
    fctx.body.push({ op: "local.get", index: resultLocal });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) {
      reportError(ctx, target, "Missing __box_number for compound externref assignment");
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: boxIdx });
    const boxedLocal = allocLocal(fctx, `__cmpd_eboxed_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: boxedLocal });

    // Write back: __extern_set(obj, key, boxed_result). (#3430) Select the
    // strict sidecar terminal for a strict Reference — `arr[i] op= v` (etc.)
    // on a plain host-object/externref receiver must throw TypeError when
    // [[Set]] fails (non-writable data property / new key on a
    // non-extensible object), mirroring plain `=` assignment (#3374).
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: boxedLocal });
    const elemCmpdSetName = isStrictContext(target, ctx.inferModuleStrictArguments)
      ? "__extern_set_strict"
      : "__extern_set";
    const setIdx = ensureLateImport(
      ctx,
      elemCmpdSetName,
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [],
    );
    flushLateImportShifts(ctx, fctx);
    if (setIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: setIdx });
    }

    // Return the result as f64
    fctx.body.push({ op: "local.get", index: resultLocal });
    return { kind: "f64" };
  }

  // For primitive targets (f64, i32, i64), box to externref and re-enter via the externref path
  if (objResult.kind === "f64" || objResult.kind === "i32" || objResult.kind === "i64") {
    coerceType(ctx, fctx, objResult, { kind: "externref" });

    // Save obj as externref local
    const objLocal = allocLocal(fctx, `__cmpd_eobj_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: objLocal });

    // Compile key as externref and save to local
    const keyResult = compileExpression(ctx, fctx, target.argumentExpression, {
      kind: "externref",
    });
    if (!keyResult) return null;
    // (#2666) ToPropertyKey ONCE (§7.1.19): a read-modify-write
    // (`o[key] op= rhs`) evaluates the LHS Reference once (§13.15.2), so the
    // key's ToPropertyKey must fire once. The raw key flows to BOTH
    // __extern_get and __extern_set, each of which ToPropertyKeys internally —
    // coercing a side-effecting key object twice. Coerce here once; the stored
    // primitive (string / preserved Symbol) is idempotent under the host's
    // internal ToPropertyKey, so no second `toString`.
    emitToPropertyKeyOnce(ctx, fctx);
    const keyLocal = allocLocal(fctx, `__cmpd_ekey_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: keyLocal });

    // Read current value: __extern_get(obj, key) -> externref
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (getIdx === undefined) return null;
    fctx.body.push({ op: "call", funcIdx: getIdx });

    // Ensure union imports (including __unbox_number, __box_number) are registered
    addUnionImports(ctx);

    // Unbox to f64
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx === undefined) {
      reportError(ctx, target, "Missing __unbox_number for compound element assignment");
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: unboxIdx });

    // Compile RHS as f64
    const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
    if (!rhsType) return null;

    // Apply compound operation
    emitCompoundOp(ctx, fctx, op);

    // Save result
    const resultLocal = allocLocal(fctx, `__cmpd_eres_${fctx.locals.length}`, {
      kind: "f64",
    });
    fctx.body.push({ op: "local.set", index: resultLocal });

    // Box result to externref
    fctx.body.push({ op: "local.get", index: resultLocal });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) {
      reportError(ctx, target, "Missing __box_number for compound element assignment");
      return null;
    }
    fctx.body.push({ op: "call", funcIdx: boxIdx });
    const boxedLocal = allocLocal(fctx, `__cmpd_eboxed_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: boxedLocal });

    // Write back: __extern_set(obj, key, boxed_result). (#3430) Select the
    // strict sidecar terminal for a strict Reference — `arr[i] op= v` (etc.)
    // on a plain host-object/externref receiver must throw TypeError when
    // [[Set]] fails (non-writable data property / new key on a
    // non-extensible object), mirroring plain `=` assignment (#3374).
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "local.get", index: keyLocal });
    fctx.body.push({ op: "local.get", index: boxedLocal });
    const elemCmpdSetName = isStrictContext(target, ctx.inferModuleStrictArguments)
      ? "__extern_set_strict"
      : "__extern_set";
    const setIdx = ensureLateImport(
      ctx,
      elemCmpdSetName,
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [],
    );
    flushLateImportShifts(ctx, fctx);
    if (setIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: setIdx });
    }

    // Return the result as f64
    fctx.body.push({ op: "local.get", index: resultLocal });
    return { kind: "f64" };
  }

  if (objResult.kind !== "ref" && objResult.kind !== "ref_null") {
    reportError(ctx, target, "Compound assignment on non-ref element access");
    return null;
  }

  const typeIdx = (objResult as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // Handle plain struct: obj["prop"] += value → struct.get + op + struct.set
  if (typeDef?.kind === "struct") {
    const isVec =
      typeDef.fields.length === 2 && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data";

    if (!isVec) {
      // Resolve field name from literal or const variable
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
              if (ts.isStringLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              } else if (ts.isNumericLiteral(decl.initializer)) {
                fieldName = decl.initializer.text;
              }
            }
          }
        }
      }
      if (fieldName === undefined) {
        fieldName = resolveComputedKeyExpression(ctx, target.argumentExpression);
      }

      if (fieldName !== undefined) {
        const fieldIdx = typeDef.fields.findIndex((f: { name?: string }) => f.name === fieldName);
        if (fieldIdx !== -1) {
          const fieldType = typeDef.fields[fieldIdx]!.type;
          const objTmp = allocLocal(fctx, `__cmpd_obj_${fctx.locals.length}`, objResult);
          fctx.body.push({ op: "local.set", index: objTmp });

          // Read current value
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
          if (fieldType.kind !== "f64") {
            coerceType(ctx, fctx, fieldType, { kind: "f64" });
          }

          // Compile RHS as f64
          const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
          if (!rhsType) return null;

          // Apply compound operation
          emitCompoundOp(ctx, fctx, op);

          // Save result
          const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: resultTmp });

          // Store back
          fctx.body.push({ op: "local.get", index: objTmp });
          fctx.body.push({ op: "local.get", index: resultTmp });
          if (fieldType.kind !== "f64") {
            coerceType(ctx, fctx, { kind: "f64" }, fieldType);
          }
          fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });

          fctx.body.push({ op: "local.get", index: resultTmp });
          return { kind: "f64" };
        }
      }
    }

    // Vec struct: arr[i] += value
    if (isVec) {
      const objTmp = allocLocal(fctx, `__cmpd_arr_${fctx.locals.length}`, objResult);
      fctx.body.push({ op: "local.set", index: objTmp });

      // Compile index
      const idxResult = compileExpression(ctx, fctx, target.argumentExpression);
      if (!idxResult) return null;
      if (idxResult.kind === "f64") {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      }
      const idxTmp = allocLocal(fctx, `__cmpd_idx_${fctx.locals.length}`, {
        kind: "i32",
      });
      fctx.body.push({ op: "local.set", index: idxTmp });

      // Get the data array type
      const dataFieldType = typeDef.fields[1]!.type;
      const arrayTypeIdx = (dataFieldType as { typeIdx: number }).typeIdx;
      const arrayDef = ctx.mod.types[arrayTypeIdx];
      const elemType = arrayDef && arrayDef.kind === "array" ? arrayDef.element : { kind: "f64" as const };

      // Read current value: arr.data[idx] (bounds-checked)
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "local.get", index: idxTmp });
      emitBoundsCheckedArrayGet(fctx, arrayTypeIdx, elemType);

      // Coerce to f64 for arithmetic
      if (elemType.kind !== "f64") {
        coerceType(ctx, fctx, elemType, { kind: "f64" });
      }

      // Compile RHS as f64
      const rhsType = compileExpression(ctx, fctx, rhs, { kind: "f64" });
      if (!rhsType) return null;

      // Apply compound operation
      emitCompoundOp(ctx, fctx, op);

      // Save result
      const resultTmp = allocLocal(fctx, `__cmpd_res_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: resultTmp });

      // Store back: arr.data[idx] = result (bounds-guarded)
      fctx.body.push({ op: "local.get", index: idxTmp });
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "array.len" });
      fctx.body.push({ op: "i32.lt_u" });
      {
        const setInstrs: Instr[] = [
          { op: "local.get", index: objTmp },
          { op: "struct.get", typeIdx, fieldIdx: 1 },
          { op: "local.get", index: idxTmp },
          { op: "local.get", index: resultTmp },
        ];
        if (elemType.kind !== "f64") {
          const savedBody = fctx.body;
          fctx.body = setInstrs as any;
          coerceType(ctx, fctx, { kind: "f64" }, elemType);
          fctx.body = savedBody;
        }
        setInstrs.push({ op: "array.set", typeIdx: arrayTypeIdx });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" as const },
          then: setInstrs,
          else: [],
        });
      }

      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "f64" };
    }
  }

  reportError(ctx, target, `Unsupported compound assignment on element access`);
  return null;
}
