// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * UpdateExpression compilation: prefix/postfix `++` and `--`.
 *
 * Covers every target shape: identifiers (locals, module globals, captured
 * globals, boxed ref-cell captures), property access (`obj.x++`), and
 * element access (`arr[i]--`). The non-update prefix unary operators
 * (`+`, `-`, `!`, `~`) live in ./unary.ts.
 */
import { ts } from "../../ts-api.js";
import { isSymbolType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { emitBoundsCheckedArrayGet } from "../array-methods.js";
import { reportError } from "../context/errors.js";
import { reportSilentFallback } from "../fallback-telemetry.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { addUnionImports, ensureStructForType, getArrTypeIdxFromVec, localGlobalIdx } from "../index.js";
import { emitBoundsGuardedArraySet, resolveInheritedStaticProp } from "../property-access.js";
import { coerceType, compileExpression, skipTransparentExpressions } from "../shared.js";
import { defaultValueInstrs } from "../type-coercion.js";
import { emitThrowString, emitThrowTypeError, getFuncParamTypes } from "./helpers.js";
import { emitMappedArgParamSync } from "./logical-ops.js";
import { resolveStructName } from "./misc.js";

/**
 * §13.4 UpdateExpression evaluation applies ToNumeric to the operand's current
 * value before the +1/-1 step. ToNumeric on a Symbol throws TypeError per
 * §7.1.3 step 3. Symbols are lowered to i32 ids, so without this guard `s++` /
 * `--s` would silently treat the id as a number. Returns true (and emits the
 * throw) when the operand's TS type is Symbol.
 */
function emitSymbolUpdateThrow(ctx: CodegenContext, fctx: FunctionContext, operand: ts.Expression): boolean {
  if (!isSymbolType(ctx.checker.getTypeAtLocation(unwrapParens(operand)))) return false;
  emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
  return true;
}

function unwrapParens(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) {
    node = node.expression;
  }
  return node;
}

/**
 * Emit a ToNumeric coercion for an externref operand of `++`/`--` (#1379).
 *
 * UpdateExpressions (ECMA-262 §13.4) call ToNumeric on the operand before
 * the +1/-1 step. ToNumeric calls ToPrimitive(NUMBER_HINT) then ToNumber
 * (BigInt is split out — see #1349). For ++/-- the routing is:
 *   - null      → 0
 *   - undefined → NaN
 *   - true/false→ 1/0
 *   - "1"       → 1     (whitespace-trimmed numeric string parse)
 *   - ""        → 0
 *   - "abc"     → NaN
 *   - {valueOf:()=>"5"} → 5    (valueOf → ToNumber chain)
 *   - {} / fn   → NaN          ([object Object]/function source → NaN)
 *
 * The host import `__unbox_number` (registered by `addUnionImports`) maps
 * to the runtime "unbox/number" intent which performs exactly this
 * ToPrimitive→Number chain via `_toPrimitive` + `_hostToPrimitive` (#1319),
 * so a direct call is correct here. The previous implementation used
 * `emitSafeExternrefToF64` which short-circuited any non-`typeof===number`
 * value to NaN — that was a defensive path from before the WasmGC
 * struct ToPrimitive support landed.
 *
 * Expects one externref on the stack; leaves one f64.
 */
function emitToNumericForUpdate(ctx: CodegenContext, fctx: FunctionContext): void {
  addUnionImports(ctx);
  const unboxIdx = ctx.funcMap.get("__unbox_number")!;
  fctx.body.push({ op: "call", funcIdx: unboxIdx });
}

/**
 * #2019: resolve the module global backing a static property `++`/`--` target.
 * Handles both receiver shapes:
 *   - `ClassName.prop` — Identifier in classSet; own field first, then walk
 *     the parent chain so inherited static fields update the ancestor's global.
 *   - `this.prop` in a static context — resolve the enclosing class from
 *     `fctx.enclosingClassName` or the function-name prefix, then look up the
 *     static global (the receiver may be wrapped: `(this as any).prop`).
 * Returns the global index, or undefined when the target is not a static field.
 */
function resolveStaticPropGlobalForUpdate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  propName: string,
): number | undefined {
  // `ClassName.prop` (own or inherited).
  if (ts.isIdentifier(receiver)) {
    const clsName = ctx.classExprNameMap.get(receiver.text) ?? receiver.text;
    if (ctx.classSet.has(clsName)) {
      return ctx.staticProps.get(`${clsName}_${propName}`) ?? resolveInheritedStaticProp(ctx, clsName, propName);
    }
    return undefined;
  }
  // `this.prop` / `(this as any).prop` in a static context.
  if (
    skipTransparentExpressions(receiver).kind === ts.SyntaxKind.ThisKeyword &&
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
      return (
        ctx.staticProps.get(`${enclosingClass}_${propName}`) ??
        resolveInheritedStaticProp(ctx, enclosingClass, propName)
      );
    }
  }
  return undefined;
}

/**
 * #2019: emit `++`/`--` against a static-property module global. Reads the
 * global, applies ToNumeric (so non-numeric externref backing values follow
 * §13.4), computes old±1, writes it back, and leaves the spec result on the
 * stack (old value for postfix, new value for prefix). Always yields f64.
 */
function compileStaticPropIncDec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  globalIdx: number,
  f64Op: "f64.add" | "f64.sub",
  mode: "prefix" | "postfix",
): ValType {
  const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
  const globalType = globalDef?.type ?? { kind: "externref" };

  // Read current value as f64 (ToNumeric for non-f64 backing globals).
  fctx.body.push({ op: "global.get", index: globalIdx });
  if (globalType.kind === "externref") {
    emitToNumericForUpdate(ctx, fctx);
  } else if (globalType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  }

  const oldTmp = allocLocal(fctx, `__static_incdec_old_${fctx.locals.length}`, { kind: "f64" });
  const newTmp = allocLocal(fctx, `__static_incdec_new_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: oldTmp });
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: f64Op });
  fctx.body.push({ op: "local.set", index: newTmp });

  // Store the new value back, coercing to the global's declared type.
  fctx.body.push({ op: "local.get", index: newTmp });
  if (globalType.kind === "externref") {
    addUnionImports(ctx);
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else if (globalType.kind === "i32") {
    fctx.body.push({ op: "i32.trunc_f64_s" });
  }
  fctx.body.push({ op: "global.set", index: globalIdx });

  // Result: old for postfix, new for prefix.
  fctx.body.push({ op: "local.get", index: mode === "postfix" ? oldTmp : newTmp });
  return { kind: "f64" };
}

/**
 * Compile prefix/postfix increment/decrement on member expressions:
 *   ++obj.x, obj.x++, --obj[i], obj[i]--, etc.
 *
 * For prefix: evaluates new value (old +/- 1), stores, returns new value.
 * For postfix: evaluates old value, stores new value (old +/- 1), returns old value.
 */
function compileMemberIncDec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
  arithOp: "add" | "sub",
  mode: "prefix" | "postfix",
): ValType | null {
  const f64Op = arithOp === "add" ? "f64.add" : "f64.sub";
  const i32Op = arithOp === "add" ? "i32.add" : "i32.sub";

  // Unwrap parenthesized expressions: ++(obj.x) -> ++obj.x
  operand = unwrapParens(operand);

  // Handle obj.prop
  if (ts.isPropertyAccessExpression(operand)) {
    const propName = ts.isPrivateIdentifier(operand.name) ? "__priv_" + operand.name.text.slice(1) : operand.name.text;

    // #2019: static-property `++`/`--`. The receiver is either `ClassName`
    // (Identifier in classSet, possibly inheriting the field from an ancestor)
    // or `this` inside a static context. Static fields are module globals, not
    // struct fields, so the generic struct-write path below cannot reach them —
    // it falls through to the `f64.const NaN` fallback and the write is lost.
    // Mirror the staticProps arm from assignment.ts with pre/post semantics.
    {
      const staticGlobalIdx = resolveStaticPropGlobalForUpdate(ctx, fctx, operand.expression, propName);
      if (staticGlobalIdx !== undefined) {
        return compileStaticPropIncDec(ctx, fctx, staticGlobalIdx, f64Op, mode);
      }
    }

    const objType = ctx.checker.getTypeAtLocation(operand.expression);
    // Ensure anonymous types are registered as structs before resolving
    ensureStructForType(ctx, objType);
    let typeName = resolveStructName(ctx, objType);
    // Fallback: check widened variable struct map (matches compilePropertyAssignment)
    if (!typeName && ts.isIdentifier(operand.expression)) {
      typeName = ctx.widenedVarStructMap.get(operand.expression.text);
    }
    if (!typeName) {
      // Unresolvable type (e.g. this.x in module scope, new Object().prop)
      // Gracefully emit NaN — incrementing an unresolvable property is NaN in JS
      reportSilentFallback(ctx, "const-fallback", "unary-updates:incdec-unresolvable-receiver-type", operand);
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
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
        const incGetterPTypes = getFuncParamTypes(ctx, getterIdx);
        const objResult = compileExpression(ctx, fctx, operand.expression, incGetterPTypes?.[0]);
        if (!objResult) return null;
        const objTmp = allocLocal(fctx, `__incdec_acc_obj_${fctx.locals.length}`, objResult);
        fctx.body.push({ op: "local.set", index: objTmp });

        // Read current value via getter
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "call", funcIdx: getterIdx });

        if (mode === "postfix") {
          // Save old value, compute new, store via setter, return old
          const oldTmp = allocLocal(fctx, `__incdec_acc_old_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: oldTmp });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: f64Op });
          const newTmp = allocLocal(fctx, `__incdec_acc_new_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: newTmp });
          fctx.body.push({ op: "local.get", index: objTmp });
          // Coerce f64 to setter's expected value param type (if setter has value param)
          {
            const idParamTypes = getFuncParamTypes(ctx, setterIdx);
            const idValType = idParamTypes?.[1];
            if (idValType) {
              fctx.body.push({ op: "local.get", index: newTmp });
              if (idValType.kind === "externref") {
                addUnionImports(ctx);
                const bIdx = ctx.funcMap.get("__box_number");
                if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
              }
            }
          }
          {
            const fs = ctx.funcMap.get(setterName) ?? setterIdx;
            fctx.body.push({ op: "call", funcIdx: fs });
          }
          fctx.body.push({ op: "local.get", index: oldTmp });
        } else {
          // Compute new, store via setter, return new
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: f64Op });
          const newTmp = allocLocal(fctx, `__incdec_acc_new_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: newTmp });
          // Store: setter expects [obj, val] (or just [obj] if setter ignores value)
          const valTmp = allocLocal(fctx, `__incdec_acc_val_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: valTmp });
          fctx.body.push({ op: "local.get", index: objTmp });
          // Coerce f64 to setter's expected value param type (if setter has value param)
          {
            const idParamTypes = getFuncParamTypes(ctx, setterIdx);
            const idValType = idParamTypes?.[1];
            if (idValType) {
              fctx.body.push({ op: "local.get", index: valTmp });
              if (idValType.kind === "externref") {
                addUnionImports(ctx);
                const bIdx = ctx.funcMap.get("__box_number");
                if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
              }
            }
          }
          {
            const fs = ctx.funcMap.get(setterName) ?? setterIdx;
            fctx.body.push({ op: "call", funcIdx: fs });
          }
          fctx.body.push({ op: "local.get", index: newTmp });
        }
        return { kind: "f64" };
      }
    }

    const structTypeIdx = ctx.structMap.get(typeName);
    const fields = ctx.structFields.get(typeName);
    if (structTypeIdx === undefined || !fields) {
      // Struct not found — gracefully emit NaN
      reportSilentFallback(ctx, "const-fallback", "unary-updates:incdec-struct-not-found", operand);
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    const fieldIdx = fields.findIndex((f) => f.name === propName);
    if (fieldIdx === -1) {
      // Unknown field — gracefully emit NaN (reading undefined property in numeric context)
      reportSilentFallback(ctx, "const-fallback", "unary-updates:member-incdec-unknown-field", operand);
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    const fieldType = fields[fieldIdx]!.type;

    // Compile the object expression and save to a temp local
    const objResult = compileExpression(ctx, fctx, operand.expression);
    if (!objResult) return null;
    const objTmp = allocLocal(fctx, `__incdec_obj_${fctx.locals.length}`, objResult);
    fctx.body.push({ op: "local.set", index: objTmp });

    // Read current value: obj.prop
    fctx.body.push({ op: "local.get", index: objTmp });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

    if (ctx.fast && fieldType.kind === "i32") {
      if (mode === "postfix") {
        // Save old value, compute new, store new, return old
        const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.tee", index: oldTmp });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: i32Op });
        const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.set", index: newTmp });
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "local.get", index: newTmp });
        fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.get", index: oldTmp });
        return { kind: "i32" };
      } else {
        // Compute new, store, return new
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: i32Op });
        const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.set", index: newTmp });
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "local.get", index: newTmp });
        fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.get", index: newTmp });
        return { kind: "i32" };
      }
    }

    // Default: f64 arithmetic
    // Coerce field value to f64 if needed
    if (fieldType.kind !== "f64") {
      coerceType(ctx, fctx, fieldType, { kind: "f64" });
    }

    if (mode === "postfix") {
      // Save old value, compute new, store, return old
      const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: oldTmp });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: f64Op });
      // Coerce back to field type if needed
      if (fieldType.kind !== "f64") {
        coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      }
      const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, fieldType);
      fctx.body.push({ op: "local.set", index: newTmp });
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "local.get", index: newTmp });
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: oldTmp });
      return { kind: "f64" };
    } else {
      // Compute new, store, return new
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: f64Op });
      const newF64Tmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: newF64Tmp });
      // Store: obj.prop = new (coerced back to field type)
      fctx.body.push({ op: "local.get", index: objTmp });
      fctx.body.push({ op: "local.get", index: newF64Tmp });
      if (fieldType.kind !== "f64") {
        coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      }
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: newF64Tmp });
      return { kind: "f64" };
    }
  }

  // Handle obj[idx] — element access increment/decrement on arrays
  if (ts.isElementAccessExpression(operand)) {
    const objTsType = ctx.checker.getTypeAtLocation(operand.expression);
    const objResult = compileExpression(ctx, fctx, operand.expression);
    if (!objResult) return null;

    // Externref element access: cannot do struct.get/struct.set on externref,
    // gracefully emit NaN (incrementing a dynamic property produces NaN).
    //
    // #1720 — reference evaluation order on `base[key]++`. Per §13.4 the LHS
    // MemberExpression is evaluated to a Reference *before* GetValue forces the
    // ToNumeric coercion, and per §13.3.3 evaluating `base[key]` evaluates both
    // the base sub-expression AND the property-key sub-expression (with their
    // side effects) before the Reference is resolved. The old code dropped the
    // base and emitted NaN without ever compiling the key expression, so a
    // side-effecting key (`base[prop()]++`) silently skipped `prop()`. We now
    // evaluate the key for its side effects, then — when the base is null at
    // runtime — throw a TypeError (RequireObjectCoercible inside GetValue),
    // which is observable *before* ToPropertyKey would call the key's
    // `toString`. A non-null externref base still falls through to NaN.
    if (objResult.kind === "externref") {
      const elemBaseTmp = allocLocal(fctx, `__incdec_ebase_${fctx.locals.length}`, objResult);
      fctx.body.push({ op: "local.set", index: elemBaseTmp });
      // Evaluate the property-key expression for its side effects, then discard
      // its value (ToPropertyKey itself is skipped — GetValue throws first when
      // the base is null/undefined).
      const keyResult = compileExpression(ctx, fctx, operand.argumentExpression);
      if (keyResult) fctx.body.push({ op: "drop" });
      // RequireObjectCoercible: null base -> TypeError before the update step.
      fctx.body.push({ op: "local.get", index: elemBaseTmp });
      fctx.body.push({ op: "ref.is_null" });
      // Emit the TypeError throw into the REAL body first so emitThrowTypeError's
      // late-import-shift bookkeeping (ensureLateImport + flushLateImportShifts)
      // patches the already-emitted instructions correctly, then splice the
      // freshly-appended throw instrs out into the `if` then-body. Building the
      // throw against a detached body would skip the shift on prior instrs and
      // emit an index-corrupt module (#1720).
      const throwStart = fctx.body.length;
      emitThrowTypeError(ctx, fctx, "TypeError: Cannot read properties of null (update target)");
      const thenBody = fctx.body.splice(throwStart);
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenBody });
      // Non-null externref base: incrementing a dynamic property yields NaN.
      reportSilentFallback(ctx, "const-fallback", "unary-updates:incdec-dynamic-property-externref", operand);
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    if (objResult.kind !== "ref" && objResult.kind !== "ref_null") {
      // Non-ref element access (numeric/i32 base): gracefully emit NaN.
      // #1720 — still evaluate the property-key expression for its side effects
      // (a numeric base can't be null, so no TypeError path applies here).
      fctx.body.push({ op: "drop" });
      const keyResult = compileExpression(ctx, fctx, operand.argumentExpression);
      if (keyResult) fctx.body.push({ op: "drop" });
      reportSilentFallback(ctx, "const-fallback", "unary-updates:incdec-nonref-element-access", operand);
      fctx.body.push({ op: "f64.const", value: NaN });
      return { kind: "f64" };
    }

    // Save object to a temp local early so the stack is clean for fallback paths
    const elemObjTmp = allocLocal(fctx, `__incdec_eobj_${fctx.locals.length}`, objResult);
    fctx.body.push({ op: "local.set", index: elemObjTmp });

    const typeIdx = (objResult as { typeIdx: number }).typeIdx;
    const typeDef = ctx.mod.types[typeIdx];

    // String/numeric literal index on a plain struct — resolve to field
    if (typeDef?.kind === "struct") {
      const isVec =
        typeDef.fields.length === 2 && typeDef.fields[0]?.name === "length" && typeDef.fields[1]?.name === "data";

      if (!isVec) {
        // Plain struct: resolve field by name
        let fieldName: string | undefined;
        if (ts.isStringLiteral(operand.argumentExpression)) {
          fieldName = operand.argumentExpression.text;
        } else if (ts.isNumericLiteral(operand.argumentExpression)) {
          fieldName = operand.argumentExpression.text;
        }

        if (fieldName) {
          const fieldIdx = typeDef.fields.findIndex((f: { name: string }) => f.name === fieldName);
          if (fieldIdx !== -1) {
            const fieldType = typeDef.fields[fieldIdx]!.type;

            // Read current value
            fctx.body.push({ op: "local.get", index: elemObjTmp });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });

            if (fieldType.kind !== "f64") {
              coerceType(ctx, fctx, fieldType, { kind: "f64" });
            }

            if (mode === "postfix") {
              const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, { kind: "f64" });
              fctx.body.push({ op: "local.tee", index: oldTmp });
              fctx.body.push({ op: "f64.const", value: 1 });
              fctx.body.push({ op: f64Op });
              if (fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, fieldType);
              const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, fieldType);
              fctx.body.push({ op: "local.set", index: newTmp });
              fctx.body.push({ op: "local.get", index: elemObjTmp });
              fctx.body.push({ op: "local.get", index: newTmp });
              fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
              fctx.body.push({ op: "local.get", index: oldTmp });
              return { kind: "f64" };
            } else {
              fctx.body.push({ op: "f64.const", value: 1 });
              fctx.body.push({ op: f64Op });
              const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, { kind: "f64" });
              fctx.body.push({ op: "local.set", index: newTmp });
              fctx.body.push({ op: "local.get", index: elemObjTmp });
              fctx.body.push({ op: "local.get", index: newTmp });
              if (fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, fieldType);
              fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
              fctx.body.push({ op: "local.get", index: newTmp });
              return { kind: "f64" };
            }
          }
        }
      }

      // Vec struct: arr[i]++ — array element increment/decrement
      if (isVec) {
        const objTmp = elemObjTmp;

        // Compile index
        const idxResult = compileExpression(ctx, fctx, operand.argumentExpression);
        if (!idxResult) return null;
        // Convert index to i32
        if (idxResult.kind === "f64") {
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        }
        const idxTmp = allocLocal(fctx, `__incdec_idx_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.set", index: idxTmp });

        // Get the data array
        const dataFieldType = typeDef.fields[1]!.type;
        const arrayTypeIdx = (dataFieldType as { typeIdx: number }).typeIdx;
        const arrayDef = ctx.mod.types[arrayTypeIdx];
        const elemType = arrayDef && arrayDef.kind === "array" ? arrayDef.element : { kind: "f64" as const };

        // Read current value: arr.data[idx] (bounds-checked)
        fctx.body.push({ op: "local.get", index: objTmp });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "local.get", index: idxTmp });
        emitBoundsCheckedArrayGet(fctx, arrayTypeIdx, elemType);

        // Coerce to f64 for arithmetic if needed
        if (elemType.kind !== "f64" && elemType.kind !== "i32") {
          coerceType(ctx, fctx, elemType, { kind: "f64" });
        }

        const numType = ctx.fast && elemType.kind === "i32" ? ("i32" as const) : ("f64" as const);
        const op = numType === "i32" ? i32Op : f64Op;

        if (mode === "postfix") {
          const oldTmp = allocLocal(fctx, `__incdec_old_${fctx.locals.length}`, { kind: numType });
          fctx.body.push({ op: "local.tee", index: oldTmp });
          if (numType === "i32") {
            fctx.body.push({ op: "i32.const", value: 1 });
          } else {
            fctx.body.push({ op: "f64.const", value: 1 });
          }
          fctx.body.push({ op });
          const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, { kind: numType });
          fctx.body.push({ op: "local.set", index: newTmp });
          // Store: arr.data[idx] = new (bounds-guarded)
          emitBoundsGuardedArraySet(fctx, objTmp, typeIdx, idxTmp, newTmp, arrayTypeIdx);
          fctx.body.push({ op: "local.get", index: oldTmp });
          return { kind: numType };
        } else {
          if (numType === "i32") {
            fctx.body.push({ op: "i32.const", value: 1 });
          } else {
            fctx.body.push({ op: "f64.const", value: 1 });
          }
          fctx.body.push({ op });
          const newTmp = allocLocal(fctx, `__incdec_new_${fctx.locals.length}`, { kind: numType });
          fctx.body.push({ op: "local.set", index: newTmp });
          // Store: arr.data[idx] = new (bounds-guarded)
          emitBoundsGuardedArraySet(fctx, objTmp, typeIdx, idxTmp, newTmp, arrayTypeIdx);
          fctx.body.push({ op: "local.get", index: newTmp });
          return { kind: numType };
        }
      }
    }
  }

  // Unsupported operand kind — gracefully emit NaN instead of hard error
  reportSilentFallback(ctx, "const-fallback", "unary-updates:incdec-unsupported-operand", operand);
  fctx.body.push({ op: "f64.const", value: NaN });
  return { kind: "f64" };
}

/**
 * Compile a prefix UpdateExpression: `++x` or `--x` on any target shape
 * (identifier, property access, element access, boxed capture, global).
 *
 * Caller must have already established that `expr.operator` is either
 * `PlusPlusToken` or `MinusMinusToken`.
 */
function compilePrefixUpdate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PrefixUnaryExpression,
): ValType | null {
  // §13.4 / §7.1.3 — ++/-- on a Symbol throws TypeError before the update step.
  if (emitSymbolUpdateThrow(ctx, fctx, expr.operand)) {
    return { kind: "f64" };
  }
  switch (expr.operator) {
    case ts.SyntaxKind.PlusPlusToken: {
      // Unwrap parenthesized expressions: ++(x) -> ++x
      const ppOperand = unwrapParens(expr.operand);
      if (ts.isIdentifier(ppOperand) && fctx.constBindings?.has(ppOperand.text)) {
        emitThrowString(ctx, fctx, "TypeError: Assignment to constant variable.");
        fctx.body.push({ op: "unreachable" });
        return { kind: "f64" };
      }
      if (ts.isIdentifier(ppOperand)) {
        const idx = fctx.localMap.get(ppOperand.text);
        if (idx !== undefined) {
          const boxedPP = fctx.boxedCaptures?.get(ppOperand.text);
          if (boxedPP) {
            // ++x through ref cell (null-guarded #702)
            // For non-numeric boxed types (externref, ref_null, i64), coerce to f64
            // before arithmetic to avoid f64.add on non-f64 operand (#816)
            const needsCoerce = boxedPP.valType.kind !== "f64" && boxedPP.valType.kind !== "i32";
            if (needsCoerce) {
              const ppF64Tmp = allocLocal(fctx, `__pp_f64_${fctx.locals.length}`, { kind: "f64" });
              const ppNewTmp = allocLocal(fctx, `__pp_new_${fctx.locals.length}`, boxedPP.valType);
              // Build else-branch using savedBody pattern so coerceType can push freely
              const savedBody = fctx.body;
              const elseBranch: Instr[] = [];
              fctx.body = elseBranch;
              fctx.body.push({ op: "local.get", index: idx });
              fctx.body.push({
                op: "struct.get",
                typeIdx: boxedPP.refCellTypeIdx,
                fieldIdx: 0,
              });
              coerceType(ctx, fctx, boxedPP.valType, { kind: "f64" });
              fctx.body.push({ op: "f64.const", value: 1 });
              fctx.body.push({ op: "f64.add" });
              fctx.body.push({ op: "local.tee", index: ppF64Tmp });
              coerceType(ctx, fctx, { kind: "f64" }, boxedPP.valType);
              fctx.body.push({ op: "local.set", index: ppNewTmp });
              fctx.body.push({ op: "local.get", index: idx });
              fctx.body.push({ op: "local.get", index: ppNewTmp });
              fctx.body.push({
                op: "struct.set",
                typeIdx: boxedPP.refCellTypeIdx,
                fieldIdx: 0,
              });
              fctx.body.push({ op: "local.get", index: ppF64Tmp });
              fctx.body = savedBody;
              fctx.body.push({ op: "local.get", index: idx });
              fctx.body.push({ op: "ref.is_null" });
              fctx.body.push({
                op: "if",
                blockType: { kind: "val" as const, type: { kind: "f64" } },
                then: [{ op: "f64.const", value: NaN } as Instr],
                else: elseBranch,
              });
              return { kind: "f64" };
            }
            const ppTmp = allocLocal(fctx, `__pp_${fctx.locals.length}`, boxedPP.valType);
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({
              op: "if",
              blockType: { kind: "val" as const, type: boxedPP.valType },
              then: defaultValueInstrs(boxedPP.valType),
              else: [
                { op: "local.get", index: idx } as Instr,
                { op: "local.get", index: idx } as Instr,
                {
                  op: "struct.get",
                  typeIdx: boxedPP.refCellTypeIdx,
                  fieldIdx: 0,
                } as Instr,
                ...(boxedPP.valType.kind === "i32"
                  ? [{ op: "i32.const", value: 1 } as Instr, { op: "i32.add" } as Instr]
                  : [{ op: "f64.const", value: 1 } as Instr, { op: "f64.add" } as Instr]),
                { op: "local.tee", index: ppTmp } as Instr,
                {
                  op: "struct.set",
                  typeIdx: boxedPP.refCellTypeIdx,
                  fieldIdx: 0,
                } as Instr,
                { op: "local.get", index: ppTmp } as Instr,
              ],
            });
            return boxedPP.valType;
          }
          const localType = getLocalType(fctx, idx);
          if (localType?.kind === "i32") {
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "i32.const", value: 1 });
            fctx.body.push({ op: "i32.add" });
            fctx.body.push({ op: "local.tee", index: idx });
            emitMappedArgParamSync(ctx, fctx, idx, { kind: "i32" });
            return { kind: "i32" };
          }
          if (localType?.kind === "externref") {
            fctx.body.push({ op: "local.get", index: idx });
            emitToNumericForUpdate(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "local.tee", index: idx });
            emitMappedArgParamSync(ctx, fctx, idx, { kind: "externref" });
            return { kind: "externref" };
          }
          if (localType?.kind === "ref" || localType?.kind === "ref_null") {
            fctx.body.push({ op: "local.get", index: idx });
            coerceType(ctx, fctx, localType!, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            return { kind: "f64" };
          }
          if (localType?.kind === "i64") {
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "i64.const", value: 1n });
            fctx.body.push({ op: "i64.add" });
            fctx.body.push({ op: "local.tee", index: idx });
            emitMappedArgParamSync(ctx, fctx, idx, { kind: "i64" });
            return { kind: "i64" };
          }
          fctx.body.push({ op: "local.get", index: idx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.add" });
          fctx.body.push({ op: "local.tee", index: idx });
          emitMappedArgParamSync(ctx, fctx, idx, { kind: "f64" });
          return { kind: "f64" };
        }
        // Check module globals for prefix ++
        const ppModIdx = ctx.moduleGlobals.get(ppOperand.text);
        if (ppModIdx !== undefined) {
          const ppModGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, ppModIdx)];
          if (ppModGlobalDef?.type.kind === "externref") {
            // externref global: safe unbox to f64, add 1, box back
            fctx.body.push({ op: "global.get", index: ppModIdx });
            emitToNumericForUpdate(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "global.set", index: ppModIdx });
            fctx.body.push({ op: "global.get", index: ppModIdx });
            return { kind: "externref" };
          }
          if (ppModGlobalDef && (ppModGlobalDef.type.kind === "ref" || ppModGlobalDef.type.kind === "ref_null")) {
            // ref global: coerce via valueOf, result is NaN+1 = NaN for plain objects
            fctx.body.push({ op: "global.get", index: ppModIdx });
            coerceType(ctx, fctx, ppModGlobalDef.type, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "global.get", index: ppModIdx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.add" });
          const ppTmp = allocLocal(fctx, `__pp_mod_${fctx.locals.length}`, {
            kind: "f64",
          });
          fctx.body.push({ op: "local.tee", index: ppTmp });
          fctx.body.push({ op: "global.set", index: ppModIdx });
          fctx.body.push({ op: "local.get", index: ppTmp });
          return { kind: "f64" };
        }
        // Check captured globals for prefix ++
        const ppCapIdx = ctx.capturedGlobals.get(ppOperand.text);
        if (ppCapIdx !== undefined) {
          const ppCapGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, ppCapIdx)];
          if (ppCapGlobalDef?.type.kind === "externref") {
            fctx.body.push({ op: "global.get", index: ppCapIdx });
            emitToNumericForUpdate(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "global.set", index: ppCapIdx });
            fctx.body.push({ op: "global.get", index: ppCapIdx });
            return { kind: "externref" };
          }
          if (ppCapGlobalDef && (ppCapGlobalDef.type.kind === "ref" || ppCapGlobalDef.type.kind === "ref_null")) {
            fctx.body.push({ op: "global.get", index: ppCapIdx });
            coerceType(ctx, fctx, ppCapGlobalDef.type, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: "f64.add" });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "global.get", index: ppCapIdx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: "f64.add" });
          const ppTmp = allocLocal(fctx, `__pp_cap_${fctx.locals.length}`, {
            kind: "f64",
          });
          fctx.body.push({ op: "local.tee", index: ppTmp });
          fctx.body.push({ op: "global.set", index: ppCapIdx });
          fctx.body.push({ op: "local.get", index: ppTmp });
          return { kind: "f64" };
        }
      }
      // ++obj.prop or ++obj[idx] — delegate to member increment helper
      return compileMemberIncDec(ctx, fctx, expr.operand, "add", "prefix");
    }
    case ts.SyntaxKind.MinusMinusToken: {
      const isIncrement = false;
      const arithOp = isIncrement ? "f64.add" : "f64.sub";
      const arithOpI32 = isIncrement ? "i32.add" : "i32.sub";

      // Unwrap parenthesized expressions: --(x) -> --x
      const mmOperand = unwrapParens(expr.operand);
      if (ts.isIdentifier(mmOperand) && fctx.constBindings?.has(mmOperand.text)) {
        emitThrowString(ctx, fctx, "TypeError: Assignment to constant variable.");
        fctx.body.push({ op: "unreachable" });
        return { kind: "f64" };
      }
      if (ts.isIdentifier(mmOperand)) {
        const idx = fctx.localMap.get(mmOperand.text);
        if (idx !== undefined) {
          const boxed = fctx.boxedCaptures?.get(mmOperand.text);
          if (boxed) {
            // ++x / --x through ref cell (null-guarded #702)
            // For non-numeric boxed types (externref, ref_null, i64), coerce to f64
            // before arithmetic to avoid f64.sub on non-f64 operand (#816)
            const needsCoerce = boxed.valType.kind !== "f64" && boxed.valType.kind !== "i32";
            if (needsCoerce) {
              const mmF64Tmp = allocLocal(fctx, `__mm_f64_${fctx.locals.length}`, { kind: "f64" });
              const mmNewTmp = allocLocal(fctx, `__mm_new_${fctx.locals.length}`, boxed.valType);
              // Build else-branch using savedBody pattern so coerceType can push freely
              const savedBody = fctx.body;
              const elseBranch: Instr[] = [];
              fctx.body = elseBranch;
              fctx.body.push({ op: "local.get", index: idx });
              fctx.body.push({
                op: "struct.get",
                typeIdx: boxed.refCellTypeIdx,
                fieldIdx: 0,
              });
              coerceType(ctx, fctx, boxed.valType, { kind: "f64" });
              fctx.body.push({ op: "f64.const", value: 1 });
              fctx.body.push({ op: arithOp });
              fctx.body.push({ op: "local.tee", index: mmF64Tmp });
              coerceType(ctx, fctx, { kind: "f64" }, boxed.valType);
              fctx.body.push({ op: "local.set", index: mmNewTmp });
              fctx.body.push({ op: "local.get", index: idx });
              fctx.body.push({ op: "local.get", index: mmNewTmp });
              fctx.body.push({
                op: "struct.set",
                typeIdx: boxed.refCellTypeIdx,
                fieldIdx: 0,
              });
              fctx.body.push({ op: "local.get", index: mmF64Tmp });
              fctx.body = savedBody;
              fctx.body.push({ op: "local.get", index: idx });
              fctx.body.push({ op: "ref.is_null" });
              fctx.body.push({
                op: "if",
                blockType: { kind: "val" as const, type: { kind: "f64" } },
                then: [{ op: "f64.const", value: NaN } as Instr],
                else: elseBranch,
              });
              return { kind: "f64" };
            }
            const tmp = allocLocal(fctx, `__pp_${fctx.locals.length}`, boxed.valType);
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "ref.is_null" });
            fctx.body.push({
              op: "if",
              blockType: { kind: "val" as const, type: boxed.valType },
              then: defaultValueInstrs(boxed.valType),
              else: [
                { op: "local.get", index: idx } as Instr,
                { op: "local.get", index: idx } as Instr,
                {
                  op: "struct.get",
                  typeIdx: boxed.refCellTypeIdx,
                  fieldIdx: 0,
                } as Instr,
                ...(boxed.valType.kind === "i32"
                  ? [{ op: "i32.const", value: 1 } as Instr, { op: arithOpI32 } as Instr]
                  : [{ op: "f64.const", value: 1 } as Instr, { op: arithOp } as Instr]),
                { op: "local.tee", index: tmp } as Instr,
                {
                  op: "struct.set",
                  typeIdx: boxed.refCellTypeIdx,
                  fieldIdx: 0,
                } as Instr,
                { op: "local.get", index: tmp } as Instr,
              ],
            });
            return boxed.valType;
          }
          const localType = getLocalType(fctx, idx);
          if (localType?.kind === "i32") {
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "i32.const", value: 1 });
            fctx.body.push({ op: arithOpI32 });
            fctx.body.push({ op: "local.tee", index: idx });
            emitMappedArgParamSync(ctx, fctx, idx, { kind: "i32" });
            return { kind: "i32" };
          }
          if (localType?.kind === "externref") {
            fctx.body.push({ op: "local.get", index: idx });
            emitToNumericForUpdate(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "local.tee", index: idx });
            emitMappedArgParamSync(ctx, fctx, idx, { kind: "externref" });
            return { kind: "externref" };
          }
          if (localType?.kind === "ref" || localType?.kind === "ref_null") {
            fctx.body.push({ op: "local.get", index: idx });
            coerceType(ctx, fctx, localType!, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            return { kind: "f64" };
          }
          if (localType?.kind === "i64") {
            fctx.body.push({ op: "local.get", index: idx });
            fctx.body.push({ op: "i64.const", value: 1n });
            fctx.body.push({ op: isIncrement ? "i64.add" : "i64.sub" });
            fctx.body.push({ op: "local.tee", index: idx });
            emitMappedArgParamSync(ctx, fctx, idx, { kind: "i64" });
            return { kind: "i64" };
          }
          fctx.body.push({ op: "local.get", index: idx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          fctx.body.push({ op: "local.tee", index: idx });
          emitMappedArgParamSync(ctx, fctx, idx, { kind: "f64" });
          return { kind: "f64" };
        }
        // Check module globals for prefix --
        const mmModIdx = ctx.moduleGlobals.get(mmOperand.text);
        if (mmModIdx !== undefined) {
          const mmModGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, mmModIdx)];
          if (mmModGlobalDef?.type.kind === "externref") {
            fctx.body.push({ op: "global.get", index: mmModIdx });
            emitToNumericForUpdate(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "global.set", index: mmModIdx });
            fctx.body.push({ op: "global.get", index: mmModIdx });
            return { kind: "externref" };
          }
          if (mmModGlobalDef && (mmModGlobalDef.type.kind === "ref" || mmModGlobalDef.type.kind === "ref_null")) {
            fctx.body.push({ op: "global.get", index: mmModIdx });
            coerceType(ctx, fctx, mmModGlobalDef.type, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "global.get", index: mmModIdx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          const mmTmp = allocLocal(fctx, `__mm_mod_${fctx.locals.length}`, {
            kind: "f64",
          });
          fctx.body.push({ op: "local.tee", index: mmTmp });
          fctx.body.push({ op: "global.set", index: mmModIdx });
          fctx.body.push({ op: "local.get", index: mmTmp });
          return { kind: "f64" };
        }
        // Check captured globals for prefix --
        const mmCapIdx = ctx.capturedGlobals.get(mmOperand.text);
        if (mmCapIdx !== undefined) {
          const mmCapGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, mmCapIdx)];
          if (mmCapGlobalDef?.type.kind === "externref") {
            fctx.body.push({ op: "global.get", index: mmCapIdx });
            emitToNumericForUpdate(ctx, fctx);
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            addUnionImports(ctx);
            fctx.body.push({
              op: "call",
              funcIdx: ctx.funcMap.get("__box_number")!,
            });
            fctx.body.push({ op: "global.set", index: mmCapIdx });
            fctx.body.push({ op: "global.get", index: mmCapIdx });
            return { kind: "externref" };
          }
          if (mmCapGlobalDef && (mmCapGlobalDef.type.kind === "ref" || mmCapGlobalDef.type.kind === "ref_null")) {
            fctx.body.push({ op: "global.get", index: mmCapIdx });
            coerceType(ctx, fctx, mmCapGlobalDef.type, { kind: "f64" });
            fctx.body.push({ op: "f64.const", value: 1 });
            fctx.body.push({ op: arithOp });
            return { kind: "f64" };
          }
          fctx.body.push({ op: "global.get", index: mmCapIdx });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          const mmTmp = allocLocal(fctx, `__mm_cap_${fctx.locals.length}`, {
            kind: "f64",
          });
          fctx.body.push({ op: "local.tee", index: mmTmp });
          fctx.body.push({ op: "global.set", index: mmCapIdx });
          fctx.body.push({ op: "local.get", index: mmTmp });
          return { kind: "f64" };
        }
      }
      // --obj.prop or --obj[idx] — delegate to member decrement helper
      return compileMemberIncDec(ctx, fctx, expr.operand, "sub", "prefix");
    }
  }

  reportError(ctx, expr, `Unsupported prefix update operator: ${ts.SyntaxKind[expr.operator]}`);
  return null;
}

function compilePostfixUnary(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PostfixUnaryExpression,
): ValType | null {
  // §13.4 / §7.1.3 — x++/x-- on a Symbol throws TypeError before the update step.
  if (emitSymbolUpdateThrow(ctx, fctx, expr.operand)) {
    return { kind: "f64" };
  }
  const isIncrement = expr.operator === ts.SyntaxKind.PlusPlusToken;
  const arithOp = isIncrement ? "f64.add" : "f64.sub";
  const arithOpI32 = isIncrement ? "i32.add" : "i32.sub";

  // Unwrap parenthesized expressions: (x)++ -> x++
  const postOperand = unwrapParens(expr.operand);

  if (!ts.isIdentifier(postOperand)) {
    // obj.prop++ or obj[idx]++ — delegate to member increment helper
    const memberOp = isIncrement ? "add" : "sub";
    return compileMemberIncDec(ctx, fctx, expr.operand, memberOp, "postfix");
  }

  if (ts.isIdentifier(postOperand)) {
    // const bindings — increment/decrement throws TypeError at runtime
    if (fctx.constBindings?.has(postOperand.text)) {
      emitThrowString(ctx, fctx, "TypeError: Assignment to constant variable.");
      fctx.body.push({ op: "unreachable" });
      return { kind: "f64" };
    }
    const idx = fctx.localMap.get(postOperand.text);
    if (idx === undefined) {
      // Check module globals for postfix ++/--
      const postModIdx = ctx.moduleGlobals.get(postOperand.text);
      if (postModIdx !== undefined) {
        const postModGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, postModIdx)];
        if (postModGlobalDef?.type.kind === "externref") {
          // externref global: safe unbox old value, compute new, box and store back
          fctx.body.push({ op: "global.get", index: postModIdx });
          emitToNumericForUpdate(ctx, fctx);
          const postOldTmp = allocLocal(fctx, `__post_old_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: postOldTmp });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          addUnionImports(ctx);
          fctx.body.push({
            op: "call",
            funcIdx: ctx.funcMap.get("__box_number")!,
          });
          fctx.body.push({ op: "global.set", index: postModIdx });
          fctx.body.push({ op: "local.get", index: postOldTmp });
          return { kind: "f64" };
        }
        if (postModGlobalDef && (postModGlobalDef.type.kind === "ref" || postModGlobalDef.type.kind === "ref_null")) {
          // ref global: coerce via valueOf, postfix returns old numeric value
          fctx.body.push({ op: "global.get", index: postModIdx });
          coerceType(ctx, fctx, postModGlobalDef.type, { kind: "f64" });
          return { kind: "f64" };
        }
        // Postfix: return old value, store new value
        fctx.body.push({ op: "global.get", index: postModIdx });
        fctx.body.push({ op: "global.get", index: postModIdx });
        fctx.body.push({ op: "f64.const", value: 1 });
        fctx.body.push({ op: arithOp });
        fctx.body.push({ op: "global.set", index: postModIdx });
        return { kind: "f64" };
      }
      // Check captured globals for postfix ++/--
      const postCapIdx = ctx.capturedGlobals.get(postOperand.text);
      if (postCapIdx !== undefined) {
        const postCapGlobalDef = ctx.mod.globals[localGlobalIdx(ctx, postCapIdx)];
        if (postCapGlobalDef?.type.kind === "externref") {
          fctx.body.push({ op: "global.get", index: postCapIdx });
          emitToNumericForUpdate(ctx, fctx);
          const postCapOldTmp = allocLocal(fctx, `__post_cap_old_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: postCapOldTmp });
          fctx.body.push({ op: "f64.const", value: 1 });
          fctx.body.push({ op: arithOp });
          addUnionImports(ctx);
          fctx.body.push({
            op: "call",
            funcIdx: ctx.funcMap.get("__box_number")!,
          });
          fctx.body.push({ op: "global.set", index: postCapIdx });
          fctx.body.push({ op: "local.get", index: postCapOldTmp });
          return { kind: "f64" };
        }
        if (postCapGlobalDef && (postCapGlobalDef.type.kind === "ref" || postCapGlobalDef.type.kind === "ref_null")) {
          fctx.body.push({ op: "global.get", index: postCapIdx });
          coerceType(ctx, fctx, postCapGlobalDef.type, { kind: "f64" });
          return { kind: "f64" };
        }
        fctx.body.push({ op: "global.get", index: postCapIdx });
        fctx.body.push({ op: "global.get", index: postCapIdx });
        fctx.body.push({ op: "f64.const", value: 1 });
        fctx.body.push({ op: arithOp });
        fctx.body.push({ op: "global.set", index: postCapIdx });
        return { kind: "f64" };
      }
      // Graceful fallback: emit 0 for unknown postfix increment/decrement
      fctx.body.push({ op: "f64.const", value: 0 });
      return { kind: "f64" };
    }

    // Handle boxed (ref cell) mutable captures for postfix (null-guarded #702)
    const boxedPost = fctx.boxedCaptures?.get(postOperand.text);
    if (boxedPost) {
      // For non-numeric boxed types (externref, ref_null, i64), coerce to f64
      // before arithmetic to avoid f64.add/sub on non-f64 operand (#816)
      const needsCoerce = boxedPost.valType.kind !== "f64" && boxedPost.valType.kind !== "i32";
      if (needsCoerce) {
        const postOldF64 = allocLocal(fctx, `__postbox_f64_${fctx.locals.length}`, { kind: "f64" });
        const postNewTmp = allocLocal(fctx, `__postnew_${fctx.locals.length}`, boxedPost.valType);
        // Build else-branch using savedBody pattern so coerceType can push freely
        const savedBody = fctx.body;
        const elseBranch: Instr[] = [];
        fctx.body = elseBranch;
        fctx.body.push({ op: "local.get", index: idx });
        fctx.body.push({
          op: "struct.get",
          typeIdx: boxedPost.refCellTypeIdx,
          fieldIdx: 0,
        });
        coerceType(ctx, fctx, boxedPost.valType, { kind: "f64" });
        fctx.body.push({ op: "local.tee", index: postOldF64 });
        fctx.body.push({ op: "f64.const", value: 1 });
        fctx.body.push({ op: arithOp });
        coerceType(ctx, fctx, { kind: "f64" }, boxedPost.valType);
        fctx.body.push({ op: "local.set", index: postNewTmp });
        fctx.body.push({ op: "local.get", index: idx });
        fctx.body.push({ op: "local.get", index: postNewTmp });
        fctx.body.push({
          op: "struct.set",
          typeIdx: boxedPost.refCellTypeIdx,
          fieldIdx: 0,
        });
        fctx.body.push({ op: "local.get", index: postOldF64 });
        fctx.body = savedBody;
        fctx.body.push({ op: "local.get", index: idx });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val" as const, type: { kind: "f64" } },
          then: [{ op: "f64.const", value: NaN } as Instr],
          else: elseBranch,
        });
        return { kind: "f64" };
      }
      const oldTmp = allocLocal(fctx, `__postbox_${fctx.locals.length}`, boxedPost.valType);
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val" as const, type: boxedPost.valType },
        then: defaultValueInstrs(boxedPost.valType),
        else: [
          { op: "local.get", index: idx } as Instr,
          {
            op: "struct.get",
            typeIdx: boxedPost.refCellTypeIdx,
            fieldIdx: 0,
          } as Instr,
          { op: "local.tee", index: oldTmp } as Instr,
          ...(boxedPost.valType.kind === "i32"
            ? [{ op: "i32.const", value: 1 } as Instr, { op: arithOpI32 } as Instr]
            : [{ op: "f64.const", value: 1 } as Instr, { op: arithOp } as Instr]),
          ...(() => {
            const newTmp = allocLocal(fctx, `__postnew_${fctx.locals.length}`, boxedPost.valType);
            return [
              { op: "local.set", index: newTmp } as Instr,
              { op: "local.get", index: idx } as Instr,
              { op: "local.get", index: newTmp } as Instr,
              {
                op: "struct.set",
                typeIdx: boxedPost.refCellTypeIdx,
                fieldIdx: 0,
              } as Instr,
              { op: "local.get", index: oldTmp } as Instr,
            ];
          })(),
        ],
      });
      return boxedPost.valType;
    }

    const localType = getLocalType(fctx, idx);
    if (localType?.kind === "i32") {
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: arithOpI32 });
      fctx.body.push({ op: "local.set", index: idx });
      emitMappedArgParamSync(ctx, fctx, idx, { kind: "i32" });
      return { kind: "i32" };
    }

    if (localType?.kind === "externref") {
      fctx.body.push({ op: "local.get", index: idx });
      emitToNumericForUpdate(ctx, fctx);
      const tmpOld = allocLocal(fctx, `__postfix_old_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: tmpOld });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: arithOp });
      addUnionImports(ctx);
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_number")! });
      fctx.body.push({ op: "local.set", index: idx });
      fctx.body.push({ op: "local.get", index: tmpOld });
      emitMappedArgParamSync(ctx, fctx, idx, { kind: "f64" });
      return { kind: "f64" };
    }

    if (localType?.kind === "ref" || localType?.kind === "ref_null") {
      fctx.body.push({ op: "local.get", index: idx });
      coerceType(ctx, fctx, localType!, { kind: "f64" });
      return { kind: "f64" };
    }

    if (localType?.kind === "i64") {
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "local.get", index: idx });
      fctx.body.push({ op: "i64.const", value: 1n });
      fctx.body.push({ op: isIncrement ? "i64.add" : "i64.sub" });
      fctx.body.push({ op: "local.set", index: idx });
      emitMappedArgParamSync(ctx, fctx, idx, { kind: "i64" });
      return { kind: "i64" };
    }

    fctx.body.push({ op: "local.get", index: idx });
    fctx.body.push({ op: "local.get", index: idx });
    fctx.body.push({ op: "f64.const", value: 1 });
    fctx.body.push({ op: arithOp });
    fctx.body.push({ op: "local.set", index: idx });
    emitMappedArgParamSync(ctx, fctx, idx, { kind: "f64" });
    return { kind: "f64" };
  }

  // obj.prop++ / obj.prop-- (property access target)
  if (ts.isPropertyAccessExpression(expr.operand)) {
    return compilePostfixIncrementProperty(ctx, fctx, expr.operand, isIncrement);
  }

  // arr[i]++ / arr[i]-- (element access target)
  if (ts.isElementAccessExpression(expr.operand)) {
    return compilePostfixIncrementElement(ctx, fctx, expr.operand, isIncrement);
  }

  reportError(ctx, expr, "Unsupported postfix unary target");
  return null;
}

// ── Prefix/postfix increment helpers for property/element access ────

/**
 * ++obj.prop / --obj.prop: get field, increment, set field, return NEW value
 */
function compilePrefixIncrementProperty(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  isIncrement: boolean,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(target.expression);
  const propName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
  const typeName = resolveStructName(ctx, objType);
  if (!typeName) {
    reportError(ctx, target, `Cannot resolve struct for prefix increment on property: ${propName}`);
    return null;
  }
  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    reportError(ctx, target, `Unknown struct type for prefix increment: ${typeName}`);
    return null;
  }
  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx === -1) {
    // Unknown field — gracefully emit NaN (reading undefined property in numeric context)
    reportSilentFallback(ctx, "const-fallback", "unary-updates:prefix-incr-property-unknown-field", target);
    fctx.body.push({ op: "f64.const", value: NaN });
    return { kind: "f64" };
  }

  // Compile object ref and save it (we need it twice: once to get, once to set)
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  const objLocal = allocLocal(fctx, `__inc_obj_${fctx.locals.length}`, objResult);
  fctx.body.push({ op: "local.set", index: objLocal });

  // Get current field value
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

  // Coerce to f64 if needed
  const fieldType = fields[fieldIdx]!.type;
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, fieldType, { kind: "f64" });
  }

  // Increment/decrement
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: isIncrement ? "f64.add" : "f64.sub" });

  // Save new value
  const newVal = allocLocal(fctx, `__inc_new_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: newVal });

  // Set field: obj, newValue -> struct.set
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: newVal });
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, { kind: "f64" }, fieldType);
  }
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });

  // Return new value (prefix returns the new value)
  fctx.body.push({ op: "local.get", index: newVal });
  return { kind: "f64" };
}

/**
 * ++arr[i] / --arr[i]: get element, increment, set element, return NEW value
 */
function compilePrefixIncrementElement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  isIncrement: boolean,
): ValType | null {
  const arrType = compileExpression(ctx, fctx, target.expression);
  if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null")) {
    reportError(ctx, target, "Prefix increment on non-array element access");
    return null;
  }
  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // String-literal bracket access on struct: ++obj["prop"]
  if (typeDef?.kind === "struct" && ts.isStringLiteral(target.argumentExpression)) {
    const propName = target.argumentExpression.text;
    const fieldIdx = typeDef.fields.findIndex((f: { name: string }) => f.name === propName);
    if (fieldIdx !== -1) {
      const objLocal = allocLocal(fctx, `__inc_obj_${fctx.locals.length}`, arrType);
      fctx.body.push({ op: "local.set", index: objLocal });

      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
      const fieldType = typeDef.fields[fieldIdx]!.type;
      if (fieldType.kind !== "f64") coerceType(ctx, fctx, fieldType, { kind: "f64" });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: isIncrement ? "f64.add" : "f64.sub" });
      const newVal = allocLocal(fctx, `__inc_new_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: newVal });
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "local.get", index: newVal });
      if (fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: newVal });
      return { kind: "f64" };
    }
  }

  // Vec struct (array wrapped in {length, data})
  const isVecStruct =
    typeDef?.kind === "struct" &&
    typeDef.fields.length === 2 &&
    typeDef.fields[0]?.name === "length" &&
    typeDef.fields[1]?.name === "data";
  if (isVecStruct) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      reportError(ctx, target, "Prefix increment: vec data is not array");
      return null;
    }
    const vecLocal = allocLocal(fctx, `__inc_vec_${fctx.locals.length}`, arrType);
    fctx.body.push({ op: "local.set", index: vecLocal });
    const idxResult = compileExpression(ctx, fctx, target.argumentExpression, {
      kind: "f64",
    });
    if (!idxResult) return null;
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    const idxLocal = allocLocal(fctx, `__inc_idx_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.set", index: idxLocal });

    const elemType = arrDef.element;

    // Bounds check: if idx < array.len, do read-modify-write; else produce NaN
    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // data field
    fctx.body.push({ op: "array.len" });
    fctx.body.push({ op: "i32.lt_u" } as Instr);

    // Build the in-bounds branch: read, modify, write, return new value
    const thenInstrs: Instr[] = [];
    thenInstrs.push({ op: "local.get", index: vecLocal } as Instr);
    thenInstrs.push({ op: "struct.get", typeIdx, fieldIdx: 1 } as Instr);
    thenInstrs.push({ op: "local.get", index: idxLocal } as Instr);
    thenInstrs.push({ op: "array.get", typeIdx: arrTypeIdx } as Instr);
    if (elemType.kind !== "f64") {
      const savedBody = fctx.body;
      fctx.body = thenInstrs as any;
      coerceType(ctx, fctx, elemType, { kind: "f64" });
      fctx.body = savedBody;
    }
    thenInstrs.push({ op: "f64.const", value: 1 } as Instr);
    thenInstrs.push({ op: isIncrement ? "f64.add" : "f64.sub" } as Instr);
    const newVal = allocLocal(fctx, `__inc_new_${fctx.locals.length}`, {
      kind: "f64",
    });
    thenInstrs.push({ op: "local.tee", index: newVal } as Instr);
    // Coerce back for array.set if needed
    if (elemType.kind !== "f64") {
      const savedBody = fctx.body;
      fctx.body = thenInstrs as any;
      coerceType(ctx, fctx, { kind: "f64" }, elemType);
      fctx.body = savedBody;
    }
    const coercedNewVal = allocLocal(fctx, `__inc_cval_${fctx.locals.length}`, elemType);
    thenInstrs.push({ op: "local.set", index: coercedNewVal } as Instr);
    thenInstrs.push({ op: "local.get", index: vecLocal } as Instr);
    thenInstrs.push({ op: "struct.get", typeIdx, fieldIdx: 1 } as Instr);
    thenInstrs.push({ op: "local.get", index: idxLocal } as Instr);
    thenInstrs.push({ op: "local.get", index: coercedNewVal } as Instr);
    thenInstrs.push({ op: "array.set", typeIdx: arrTypeIdx } as Instr);
    thenInstrs.push({ op: "local.get", index: newVal } as Instr);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val" as const, type: { kind: "f64" as const } },
      then: thenInstrs,
      else: [{ op: "f64.const", value: NaN } as Instr],
    } as Instr);

    return { kind: "f64" };
  }

  reportError(ctx, target, "Unsupported prefix increment element access target");
  return null;
}

/**
 * obj.prop++ / obj.prop--: get field, save OLD, increment, set field, return OLD value
 */
function compilePostfixIncrementProperty(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  isIncrement: boolean,
): ValType | null {
  const objType = ctx.checker.getTypeAtLocation(target.expression);
  const propName = ts.isPrivateIdentifier(target.name) ? "__priv_" + target.name.text.slice(1) : target.name.text;
  const typeName = resolveStructName(ctx, objType);
  if (!typeName) {
    reportError(ctx, target, `Cannot resolve struct for postfix increment on property: ${propName}`);
    return null;
  }
  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    reportError(ctx, target, `Unknown struct type for postfix increment: ${typeName}`);
    return null;
  }
  const fieldIdx = fields.findIndex((f) => f.name === propName);
  if (fieldIdx === -1) {
    // Unknown field — gracefully emit NaN (reading undefined property in numeric context)
    reportSilentFallback(ctx, "const-fallback", "unary-updates:postfix-incr-property-unknown-field", target);
    fctx.body.push({ op: "f64.const", value: NaN });
    return { kind: "f64" };
  }

  // Compile object ref and save
  const objResult = compileExpression(ctx, fctx, target.expression);
  if (!objResult) return null;
  const objLocal = allocLocal(fctx, `__postinc_obj_${fctx.locals.length}`, objResult);
  fctx.body.push({ op: "local.set", index: objLocal });

  // Get current field value
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

  // Coerce to f64 if needed
  const fieldType = fields[fieldIdx]!.type;
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, fieldType, { kind: "f64" });
  }

  // Save OLD value
  const oldVal = allocLocal(fctx, `__postinc_old_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: oldVal });

  // Compute new value
  fctx.body.push({ op: "local.get", index: oldVal });
  fctx.body.push({ op: "f64.const", value: 1 });
  fctx.body.push({ op: isIncrement ? "f64.add" : "f64.sub" });

  // Save new value for struct.set
  const newVal = allocLocal(fctx, `__postinc_new_${fctx.locals.length}`, {
    kind: "f64",
  });
  fctx.body.push({ op: "local.set", index: newVal });

  // Set field: obj, newValue -> struct.set
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: newVal });
  if (fieldType.kind !== "f64") {
    coerceType(ctx, fctx, { kind: "f64" }, fieldType);
  }
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });

  // Return OLD value (postfix returns old value)
  fctx.body.push({ op: "local.get", index: oldVal });
  return { kind: "f64" };
}

/**
 * arr[i]++ / arr[i]--: get element, save OLD, increment, set element, return OLD value
 */
function compilePostfixIncrementElement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.ElementAccessExpression,
  isIncrement: boolean,
): ValType | null {
  const arrType = compileExpression(ctx, fctx, target.expression);
  if (!arrType || (arrType.kind !== "ref" && arrType.kind !== "ref_null")) {
    reportError(ctx, target, "Postfix increment on non-array element access");
    return null;
  }
  const typeIdx = (arrType as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];

  // String-literal bracket access on struct: obj["prop"]++
  if (typeDef?.kind === "struct" && ts.isStringLiteral(target.argumentExpression)) {
    const propName = target.argumentExpression.text;
    const fieldIdx = typeDef.fields.findIndex((f: { name: string }) => f.name === propName);
    if (fieldIdx !== -1) {
      const objLocal = allocLocal(fctx, `__postinc_obj_${fctx.locals.length}`, arrType);
      fctx.body.push({ op: "local.set", index: objLocal });

      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
      const fieldType = typeDef.fields[fieldIdx]!.type;
      if (fieldType.kind !== "f64") coerceType(ctx, fctx, fieldType, { kind: "f64" });
      const oldVal = allocLocal(fctx, `__postinc_old_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: oldVal });
      fctx.body.push({ op: "local.get", index: oldVal });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: isIncrement ? "f64.add" : "f64.sub" });
      const newVal = allocLocal(fctx, `__postinc_new_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: newVal });
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "local.get", index: newVal });
      if (fieldType.kind !== "f64") coerceType(ctx, fctx, { kind: "f64" }, fieldType);
      fctx.body.push({ op: "struct.set", typeIdx, fieldIdx });
      fctx.body.push({ op: "local.get", index: oldVal });
      return { kind: "f64" };
    }
  }

  // Vec struct (array wrapped in {length, data})
  const isVecStruct =
    typeDef?.kind === "struct" &&
    typeDef.fields.length === 2 &&
    typeDef.fields[0]?.name === "length" &&
    typeDef.fields[1]?.name === "data";
  if (isVecStruct) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      reportError(ctx, target, "Postfix increment: vec data is not array");
      return null;
    }
    const vecLocal = allocLocal(fctx, `__postinc_vec_${fctx.locals.length}`, arrType);
    fctx.body.push({ op: "local.set", index: vecLocal });
    const idxResult = compileExpression(ctx, fctx, target.argumentExpression, {
      kind: "f64",
    });
    if (!idxResult) return null;
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    const idxLocal = allocLocal(fctx, `__postinc_idx_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.set", index: idxLocal });

    const elemType = arrDef.element;

    // Bounds check: if idx < array.len, do read-modify-write; else produce NaN
    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "array.len" });
    fctx.body.push({ op: "i32.lt_u" } as Instr);

    // Build the in-bounds branch: read old, compute new, write, return old
    const thenInstrs: Instr[] = [];
    thenInstrs.push({ op: "local.get", index: vecLocal } as Instr);
    thenInstrs.push({ op: "struct.get", typeIdx, fieldIdx: 1 } as Instr);
    thenInstrs.push({ op: "local.get", index: idxLocal } as Instr);
    thenInstrs.push({ op: "array.get", typeIdx: arrTypeIdx } as Instr);
    if (elemType.kind !== "f64") {
      const savedBody = fctx.body;
      fctx.body = thenInstrs as any;
      coerceType(ctx, fctx, elemType, { kind: "f64" });
      fctx.body = savedBody;
    }
    const oldVal = allocLocal(fctx, `__postinc_old_${fctx.locals.length}`, {
      kind: "f64",
    });
    thenInstrs.push({ op: "local.set", index: oldVal } as Instr);
    // Compute new value
    thenInstrs.push({ op: "local.get", index: oldVal } as Instr);
    thenInstrs.push({ op: "f64.const", value: 1 } as Instr);
    thenInstrs.push({ op: isIncrement ? "f64.add" : "f64.sub" } as Instr);
    // Coerce and write back
    const newVal = allocLocal(fctx, `__postinc_new_${fctx.locals.length}`, {
      kind: "f64",
    });
    thenInstrs.push({ op: "local.set", index: newVal } as Instr);
    thenInstrs.push({ op: "local.get", index: vecLocal } as Instr);
    thenInstrs.push({ op: "struct.get", typeIdx, fieldIdx: 1 } as Instr);
    thenInstrs.push({ op: "local.get", index: idxLocal } as Instr);
    thenInstrs.push({ op: "local.get", index: newVal } as Instr);
    if (elemType.kind !== "f64") {
      const savedBody = fctx.body;
      fctx.body = thenInstrs as any;
      coerceType(ctx, fctx, { kind: "f64" }, elemType);
      fctx.body = savedBody;
    }
    thenInstrs.push({ op: "array.set", typeIdx: arrTypeIdx } as Instr);
    // Return old value
    thenInstrs.push({ op: "local.get", index: oldVal } as Instr);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val" as const, type: { kind: "f64" as const } },
      then: thenInstrs,
      else: [{ op: "f64.const", value: NaN } as Instr],
    } as Instr);

    return { kind: "f64" };
  }

  reportError(ctx, target, "Unsupported postfix increment element access target");
  return null;
}

export { compileMemberIncDec, compilePostfixUnary, compilePrefixUpdate };
