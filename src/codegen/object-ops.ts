// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Object operations: Object.defineProperty, Object.keys/values/entries,
 * hasOwnProperty / propertyIsEnumerable.
 *
 * Extracted from expressions.ts (#688 step 6).
 */
import { inheritedSetAnyDirty } from "./inherited-set-gate.js"; // (#4602) per-key #4504 gate
import { ts } from "../ts-api.js";
import { isVoidType } from "../checker/type-mapper.js";
import type { FieldDef, Instr, ValType, WasmFunction } from "../ir/types.js";
import { emitUndefinedExtern } from "./any-helpers.js";
import {
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  compileArrowAsCallback,
  compileArrowAsClosure,
  promoteAccessorCapturesToGlobals,
} from "./closures.js";
import { reportError } from "./context/errors.js";
import { isGlobalObjectExpr } from "./global-environment.js"; // (#4394) host global object, never a struct
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowRangeError, emitThrowTypeError } from "./expressions/helpers.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js"; // (#3177 slice 4) defineProperty rejection sentinel → TypeError
import { emitMappedArgReverseSync } from "./expressions/logical-ops.js";
import { resolveStructName } from "./expressions/misc.js";
import { widenedStructNameForUse, integrityVarKey } from "./widened-var-key.js";
import { addUnionImports, cacheStringLiterals, getOrRegisterTupleType, resolveWasmType } from "./index.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterRefCellType, getOrRegisterVecType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3) stable-regime minting
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression, compileStatement, ensureLateImport, flushLateImportShifts } from "./shared.js";
import {
  S5C_STRUCT_ACCESSOR_CLOSURE,
  buildAccessorClosure,
  ensureStructAccessorGlobal,
} from "./struct-accessor-closure.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { compileNativeStringLiteral, compileStringLiteral } from "./string-ops.js";
import { getVecInfo } from "./type-coercion.js";
import {
  isSideEffectFreeReceiver,
  maybeEmitVecLengthDefine,
  tryEmitVecLengthDefineForDefineProperties,
} from "./array-length-define.js";
import { emitHasOwnPresence } from "./closed-struct-presence.js"; // (#3920) per-instance own-presence
import { vecNamedKeyNeedsRuntime } from "./vec-named-key-presence.js"; // (#4062) array expando presence
import { isStaticDescWellFormed, isStaticallyNonObjectDescExpr } from "./descriptor-shape.js";
// (#4479) the `Properties` MAP half of Object.defineProperties — key naming and
// `$Object` materialization. Reasoning lives in that module's header.
import { compileDescriptorMapAsDynamicObject, staticDescriptorMapKey } from "./define-properties-map.js";
import { isDescriptorTranscribableStruct } from "./property-descriptor-shape.js"; // (#4180) #2372 transcription gate
import {
  descriptorFieldName,
  inheritedTrueDescriptorFlags,
  tryConstantFoldToBoolean,
  unwrapTransparentExpression,
} from "./object-descriptor-analysis.js";

export { tryConstantFoldToBoolean } from "./object-descriptor-analysis.js";

/**
 * (#2580 B-acc) ES §6.1.7 — a canonical *array index* is a String that is a
 * canonical numeric string whose numeric value is an integer in `[0, 2^32-1)`.
 * Such a key is the one accessed via integer-indexed element retrieval
 * (`__extern_get_idx` / `__extern_has_idx`) in the generic
 * `Array.prototype.X.call(arrayLike, cb)` loops, so an accessor defined on it
 * must live in the runtime sidecar (which those helpers read), not in the
 * compiled named-accessor fast path. Excludes `"-0"`, leading-zero forms, and
 * `4294967295` (2^32-1) per the canonical-numeric-string round-trip rule.
 */
function _isCanonicalArrayIndexString(s: string): boolean {
  if (s.length === 0 || s.length > 10) return false;
  // Canonical: ToString(ToUint32(s)) === s, and value < 2^32-1.
  if (!/^[0-9]+$/.test(s)) return false;
  if (s.length > 1 && s[0] === "0") return false; // no leading zeros ("01" is not canonical)
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n < 0xffffffff;
}

/**
 * (#3368) Prove that a canonical index names a present element of the dense
 * array literal that produced `receiver`.
 *
 * Numeric vecs do not carry a hole/presence bitmap, so a raw bounds check is
 * unsound after elisions, `delete`, length shrink, or an aliased mutation. Keep
 * this proof intentionally local: accept a direct dense literal, or an
 * identifier whose dense literal declaration has no intervening reference at
 * all before the `hasOwnProperty` call. The latter excludes mutation and alias
 * escape without attempting whole-program data-flow analysis.
 */
function provesDenseLiteralOwnIndex(
  ctx: CodegenContext,
  receiver: ts.Expression,
  call: ts.CallExpression,
  key: string,
): boolean {
  if (!_isCanonicalArrayIndexString(key)) return false;
  const index = Number(key);
  const unwrapped = unwrapTransparentExpression(receiver);

  const literalHasElement = (literal: ts.ArrayLiteralExpression): boolean =>
    !literal.elements.some(ts.isSpreadElement) &&
    index < literal.elements.length &&
    !ts.isOmittedExpression(literal.elements[index]!);

  if (ts.isArrayLiteralExpression(unwrapped)) return literalHasElement(unwrapped);
  if (!ts.isIdentifier(unwrapped)) return false;

  const symbol = ctx.checker.getSymbolAtLocation(unwrapped);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  const initializer = unwrapTransparentExpression(declaration.initializer);
  if (!ts.isArrayLiteralExpression(initializer) || !literalHasElement(initializer)) return false;
  if (declaration.getSourceFile() !== call.getSourceFile()) return false;

  const declarationEnd = declaration.getEnd();
  const callStart = call.getStart();
  let interveningReference = false;
  const visit = (node: ts.Node): void => {
    if (interveningReference) return;
    const start = node.getStart();
    if (start >= callStart || node.getEnd() <= declarationEnd) return;
    if (ts.isIdentifier(node) && node.text === unwrapped.text && start >= declarationEnd) {
      interveningReference = true;
      return;
    }
    node.forEachChild(visit);
  };
  call.getSourceFile().forEachChild(visit);
  return !interveningReference;
}

// (#4061) `isStaticallyNonObjectDescArg` moved to descriptor-shape.ts as
// `isStaticallyNonObjectDescExpr` — `Object.create`'s static expansion needs
// the identical §6.2.5.5-step-1 classification, and a module-private copy here
// is exactly why it did not have it.

function isUndefinedLikeExpression(expr: ts.Expression): boolean {
  const inner = unwrapTransparentExpression(expr);
  return (
    inner.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(inner) && inner.text === "undefined") ||
    ts.isVoidExpression(inner)
  );
}

function descriptorUndefinedFields(descArg: ts.Expression): string[] {
  const desc = unwrapTransparentExpression(descArg);
  if (!ts.isObjectLiteralExpression(desc)) return [];
  const fields: string[] = [];
  for (const prop of desc.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const field = descriptorFieldName(prop.name);
    if (field !== undefined && isUndefinedLikeExpression(prop.initializer)) fields.push(field);
  }
  return fields;
}

function descriptorInitializerForIdentifier(
  ctx: CodegenContext,
  descArg: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
  const unwrapped = unwrapTransparentExpression(descArg);
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const sym = ctx.checker.getSymbolAtLocation(unwrapped);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  const init = unwrapTransparentExpression(decl.initializer);
  return ts.isObjectLiteralExpression(init) ? init : undefined;
}

function markRuntimeDefinedProperty(ctx: CodegenContext, objArg: ts.Expression, propArg: ts.Expression): void {
  if (!ts.isIdentifier(objArg)) return;
  const propName = ts.isStringLiteral(propArg) ? propArg.text : ts.isNumericLiteral(propArg) ? propArg.text : undefined;
  if (propName === undefined) return;
  ctx.sidecarDefinedPropertyKeys.add(`${objArg.text}:${propName}`);
}

function emitDescriptorUndefinedSidecars(
  ctx: CodegenContext,
  fctx: FunctionContext,
  descLocal: number,
  fields: readonly string[],
): void {
  if (fields.length === 0) return;
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (setIdx === undefined) return;
  for (const field of fields) {
    fctx.body.push({ op: "local.get", index: descLocal });
    addStringConstantGlobal(ctx, field);
    for (const instr of stringConstantExternrefInstrs(ctx, field)) fctx.body.push(instr);
    emitUndefined(ctx, fctx);
    fctx.body.push({ op: "call", funcIdx: setIdx });
  }
}

/**
 * (#2372) Reify a typed WasmGC descriptor struct (already on the stack) into a
 * fresh open-hash `$Object`, so the native `__obj_define_from_desc` applier —
 * which runs ToPropertyDescriptor via `__hasOwnProperty`/`__extern_get` over a
 * `$Object` — can read it. A dynamic descriptor (`var d = { value: 1 }`) is
 * typed by the checker as a closed struct; without reification the applier sees
 * a non-`$Object` and throws a spurious TypeError §10.1.6.
 *
 * Stack contract: consumes the `(ref|ref null structTypeIdx)` on top, leaves a
 * `$Object` externref in its place.
 *
 * Emitted INLINE referencing `__new_plain_object` / `__extern_set` via
 * `ensureLateImport` (shift-safe by-name late imports) — NOT a finalize-built
 * helper body that bakes funcIdxs, so the #2190 late-import-shift hazard does
 * not apply. Per-field boxing is delegated to `coerceType(... externref)`
 * (f64 → `__box_number`, i32/bool → box, ref/externref → `extern.convert_any`/
 * identity). Accessor `get`/`set` fields are already `externref` (boxed
 * closures) and pass through unchanged.
 */
function emitDescriptorStructReify(
  ctx: CodegenContext,
  fctx: FunctionContext,
  structTypeIdx: number,
  fields: readonly FieldDef[],
): void {
  const newObjIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);

  // Stow the source struct ref (currently on the stack) in a temp.
  const srcLocal = allocLocal(fctx, `__desc_src_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: structTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: srcLocal });

  if (newObjIdx === undefined || setIdx === undefined) {
    // Object runtime unavailable (should not happen under ctx.standalone, but be
    // safe): degrade to the prior behavior — push the struct as externref.
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "extern.convert_any" });
    return;
  }

  // newObj = __new_plain_object()
  const objLocal = allocLocal(fctx, `__desc_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: newObjIdx });
  fctx.body.push({ op: "local.set", index: objLocal });

  // For each static struct field: __extern_set(newObj, "<name>", box(field)).
  // The source struct may be null (ref_null) — guard each read with a non-null
  // check so a null descriptor reifies to an empty object (the applier then
  // throws §10.1.6 for the empty/non-descriptor case, preserving ordering).
  for (let fieldIdx = 0; fieldIdx < fields.length; fieldIdx++) {
    const field = fields[fieldIdx]!;
    // skip internal/synthetic fields that aren't real descriptor keys
    if (field.name.startsWith("$") || field.name.startsWith("__")) continue;
    fctx.body.push({ op: "local.get", index: objLocal });
    addStringConstantGlobal(ctx, field.name);
    for (const instr of stringConstantExternrefInstrs(ctx, field.name)) fctx.body.push(instr);
    // value: src.<field>, boxed to externref
    fctx.body.push({ op: "local.get", index: srcLocal });
    fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
    if (field.type.kind !== "externref") {
      coerceType(ctx, fctx, field.type, { kind: "externref" });
    }
    fctx.body.push({ op: "call", funcIdx: setIdx });
  }

  // Leave the reified $Object on the stack.
  fctx.body.push({ op: "local.get", index: objLocal });
}

export function emitDefinePropertyDescRuntime(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objArg: ts.Expression,
  propArg: ts.Expression,
  descArg: ts.Expression,
  undefinedFields: readonly string[],
): ValType | null {
  markRuntimeDefinedProperty(ctx, objArg, propArg);

  const objType = compileExpression(ctx, fctx, objArg);
  if (!objType) return null;
  if (objType.kind === "ref" || objType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  } else if (objType.kind !== "externref") {
    coerceType(ctx, fctx, objType, { kind: "externref" });
  }

  const propType = compileExpression(ctx, fctx, propArg, { kind: "externref" });
  if (propType && propType.kind !== "externref") {
    coerceType(ctx, fctx, propType, { kind: "externref" });
  } else if (!propType) {
    fctx.body.push({ op: "ref.null.extern" });
  }

  const descType = compileExpression(ctx, fctx, descArg);
  // (#2372) Standalone descriptor reification. The native
  // `__obj_define_from_desc` applier runs ToPropertyDescriptor over the
  // descriptor as a `$Object` (via `__hasOwnProperty`/`__extern_get`, which
  // `ref.test $Object`); a *dynamic* descriptor (`var d = {...}`) that the TS
  // checker typed as a closed WasmGC struct is "not an object" to that helper
  // and triggers a spurious TypeError §10.1.6. When the descriptor compiled to
  // a typed struct, reify it into a fresh `$Object` here (read each static
  // struct field via `struct.get`, box to externref, `__extern_set` onto a new
  // open-hash object) so the applier can read it. A descriptor that is already
  // a `$Object` (externref — e.g. `as any`, or a `$Object`-built literal) is
  // passed through unchanged: no double-wrap. The native semantic-provider
  // policy uses this same path in JavaScript and host-free environments.
  const descStructTypeIdx =
    ctx.targetProfile.semanticProviders === "native-first" &&
    descType &&
    (descType.kind === "ref" || descType.kind === "ref_null")
      ? descType.typeIdx
      : undefined;
  const reifyStructName = descStructTypeIdx !== undefined ? ctx.typeIdxToStructName.get(descStructTypeIdx) : undefined;
  const reifyFields = reifyStructName ? ctx.structFields.get(reifyStructName) : undefined;
  // (#4180) …but ONLY for a struct that is plausibly a descriptor RECORD. Any
  // other typed struct — array `{length,data}`, `__Date` `{timestamp}`, a
  // subview — would have its INTERNAL wasm fields transcribed as if they were
  // the object's own properties, silently fabricating a descriptor and
  // discarding the real one in the carrier bag. Rationale + measured repro:
  // `isDescriptorTranscribableStruct`. Otherwise pass the externref through and
  // let the applier run ToPropertyDescriptor over the actual object.
  //
  // (#4176) This test SUBSUMES the three-name skip list this branch used to
  // carry (`__vec_*` / `__StandaloneRegExp` / `__Date`): none of those is
  // `__anon_*` and none carries a §6.2.5.6 field name, so all three pass
  // through, and the allow-test additionally covers every struct kind a
  // denylist would have to be kept in sync with. The #4176 reason for wanting
  // them passed through is BROADER than #4180's and is what this branch adds:
  // the reify severs not only the #3468/#3537 carrier-bag OWN expandos but the
  // proto-property-store INHERITED keys — `Array.prototype.value = "x";
  // Object.defineProperty(o, "p", [])`, the §8.10.5 inherited-descriptor idiom.
  // Measured: the Date / Array / RegExp rows of
  // 15.2.3.6-3-{139..149,218..228,248..258}-1 all read empty descriptors.
  // `__obj_define_from_desc`'s reads (`__desc_has_own` + `__extern_get`)
  // resolve both — own bag first, then the per-brand companions.
  const mayTranscribe =
    reifyStructName !== undefined && !!reifyFields && isDescriptorTranscribableStruct(reifyStructName, reifyFields);
  if (descType && descStructTypeIdx !== undefined && reifyFields && reifyFields.length > 0 && mayTranscribe) {
    emitDescriptorStructReify(ctx, fctx, descStructTypeIdx, reifyFields);
    // emitDescriptorStructReify consumes the struct ref on the stack and leaves
    // a `$Object` externref in its place.
  } else if (descType) {
    if (descType.kind === "ref" || descType.kind === "ref_null") {
      fctx.body.push({ op: "extern.convert_any" });
    } else if (descType.kind !== "externref") {
      coerceType(ctx, fctx, descType, { kind: "externref" });
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const descLocal = allocLocal(fctx, `__defprop_desc_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: descLocal });

  // (#1629b/#4397) Native semantics never use the `__defineProperty_desc`
  // host fallback. Route to the Wasm-native
  // `__obj_define_from_desc(obj, key, desc)` helper, which performs
  // ToPropertyDescriptor over the descriptor `$Object` and dispatches to the
  // native `__defineProperty_value` / `__defineProperty_accessor` store. The
  // host-side `__descriptor_undefined` presence sidecar is not used standalone
  // (the native helper reads presence directly via `__hasOwnProperty`), so the
  // undefined-fields sidecar emission is host-only.
  if (ctx.targetProfile.semanticProviders === "native-first") {
    ensureObjectRuntime(ctx);
    fctx.body.push({ op: "local.get", index: descLocal });
    const nativeIdx = ctx.funcMap.get("__obj_define_from_desc");
    if (nativeIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: nativeIdx });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  emitDescriptorUndefinedSidecars(ctx, fctx, descLocal, undefinedFields);
  fctx.body.push({ op: "local.get", index: descLocal });

  const dpDescIdx = ensureLateImport(
    ctx,
    "__defineProperty_desc",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (dpDescIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: dpDescIdx });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return { kind: "externref" };
}

// ── #1130 PR-0: array-index-exotic length growth on defineProperty ───

/**
 * Parse a property key string as a canonical array index per the array
 * exotic-object rules (ES §10.4.2.1 / `CanonicalNumericIndexString` plus
 * `ToString(ToUint32(n)) === key`). Returns the index when the key is a
 * canonical array index in `[0, 2^32-2]`, else undefined. "length", "01",
 * "-1", "1.5", "4294967295" are NOT canonical array indices.
 */
function parseCanonicalArrayIndex(key: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
  const n = Number(key);
  // Array indices are < 2^32 - 1 (4294967295 is the max length, not an index).
  if (!Number.isInteger(n) || n < 0 || n >= 0xffffffff) return undefined;
  return n;
}

/**
 * #1130 PR-0: emit array-index-exotic `length` growth.
 *
 * `Object.defineProperty(arr, "n", desc)` on an array exotic object with
 * `n >= arr.length` sets `arr.length = n + 1` (ES §10.4.2.1 ArraySetLength
 * via `[[DefineOwnProperty]]`). Our WasmGC vec stores the logical length in
 * struct field 0; this emits a guarded bump on a freshly-compiled vec ref.
 *
 * Emits nothing (and returns) when `objArg` is not a side-effect-free vec
 * receiver or `propArg` is not a canonical array index. Leaves the operand
 * stack unchanged.
 */
function maybeEmitVecLengthGrowth(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objArg: ts.Expression,
  propArg: ts.Expression,
): void {
  if (!ts.isStringLiteral(propArg)) return;
  const idx = parseCanonicalArrayIndex(propArg.text);
  if (idx === undefined) return;
  if (!isSideEffectFreeReceiver(objArg)) return;

  const objTsType = ctx.checker.getTypeAtLocation(objArg);
  const wasmType = resolveWasmType(ctx, objTsType);
  if (wasmType.kind !== "ref" && wasmType.kind !== "ref_null") return;
  const vecTypeIdx = (wasmType as { typeIdx?: number }).typeIdx;
  if (vecTypeIdx === undefined) return;
  const vecInfo = getVecInfo(ctx, vecTypeIdx);
  if (vecInfo === null) return;
  const arrTypeIdx = vecInfo.arrTypeIdx;

  // Re-compile the receiver to a raw vec ref (safe: side-effect-free).
  const recvType = compileExpression(ctx, fctx, objArg);
  if (!recvType || (recvType.kind !== "ref" && recvType.kind !== "ref_null")) {
    // Unexpected: discard whatever landed on the stack to stay balanced.
    if (recvType) fctx.body.push({ op: "drop" });
    return;
  }
  const vecLocal = allocLocal(fctx, `__defprop_grow_${fctx.locals.length}`, recvType);
  fctx.body.push({ op: "local.set", index: vecLocal });

  // Only grow when idx >= vec.length. Inside the guard, grow the backing
  // `$data` array if its capacity is too small (so iteration/index reads
  // don't trap), then set vec.length = idx + 1. This mirrors the indexed
  // assignment grow path in expressions/assignment.ts so the vec stays
  // internally consistent (logical length never exceeds backing capacity).
  const dataLocal = allocLocal(fctx, `__defprop_grow_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  const oldCapLocal = allocLocal(fctx, `__defprop_grow_ocap_${fctx.locals.length}`, { kind: "i32" });
  const newDataLocal = allocLocal(fctx, `__defprop_grow_ndata_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });

  fctx.body.push({ op: "i32.const", value: idx });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "i32.ge_s" }); // idx >= vec.length?
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // data = vec.data
      { op: "local.get", index: vecLocal },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: dataLocal },

      // if (idx >= array.len(data)) grow backing array to idx + 1
      { op: "local.get", index: dataLocal },
      { op: "array.len" },
      { op: "local.tee", index: oldCapLocal },
      { op: "i32.const", value: idx },
      { op: "i32.le_s" }, // oldCap <= idx?
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // newData = array.new_default(idx + 1)
          { op: "i32.const", value: idx + 1 },
          { op: "array.new_default", typeIdx: arrTypeIdx },
          { op: "local.set", index: newDataLocal },
          // array.copy newData[0..oldCap] = data[0..oldCap]
          { op: "local.get", index: newDataLocal },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: dataLocal },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: oldCapLocal },
          { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
          // vec.data = newData
          { op: "local.get", index: vecLocal },
          { op: "local.get", index: newDataLocal },
          { op: "ref.as_non_null" },
          { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 },
        ],
      },

      // vec.length = idx + 1
      { op: "local.get", index: vecLocal },
      { op: "i32.const", value: idx + 1 },
      { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 },
    ],
  });
}

// ── Compile-time primitive type check for Object methods ─────────────

/**
 * Check if the first argument to Object.defineProperty / defineProperties
 * is statically known to be a non-object type (undefined, null, boolean,
 * number, string).  If so, emit `throw TypeError` and return true.
 *
 * Per ES spec (19.1.2.4 step 1): "If Type(O) is not Object, throw a TypeError."
 */
export function emitNonObjectArgGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argExpr: ts.Expression,
  methodName: string,
): boolean {
  const tsType = ctx.checker.getTypeAtLocation(argExpr);
  const flags = tsType.flags;

  // Check for primitive types that are definitely not objects
  const NON_OBJECT_FLAGS =
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Null |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.StringLike |
    ts.TypeFlags.BigIntLike;

  if (flags & NON_OBJECT_FLAGS) {
    // Compile the argument for side effects (it might have side effects)
    const argType = compileExpression(ctx, fctx, argExpr);
    if (argType) fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, ` called on non-object`);
    return true;
  }

  // Also check for literal expressions that are obviously non-object
  if (
    argExpr.kind === ts.SyntaxKind.UndefinedKeyword ||
    argExpr.kind === ts.SyntaxKind.NullKeyword ||
    argExpr.kind === ts.SyntaxKind.TrueKeyword ||
    argExpr.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isNumericLiteral(argExpr) ||
    (ts.isIdentifier(argExpr) && argExpr.text === "undefined")
  ) {
    emitThrowTypeError(ctx, fctx, ` called on non-object`);
    return true;
  }

  return false;
}

// ── Null guard for object method arguments ────────────────────────────

/**
 * Emit a null check on the ref stored in `localIdx`.
 * If null, throws TypeError via the exception tag.
 */
function emitObjectArgNullGuard(ctx: CodegenContext, fctx: FunctionContext, localIdx: number): void {
  const message = "TypeError: Object method called on null or undefined";
  addStringConstantGlobal(ctx, message);
  const tagIdx = ensureExnTag(ctx);
  // Materialize the message via stringConstantExternrefInstrs so it works in
  // both backends: a host `string_constants` global, OR — under nativeStrings
  // (auto-on for --target standalone/wasi) — an inline-built `$NativeString`.
  // The previous `global.get` of `stringGlobalMap.get(message)` emitted index
  // -1 (the nativeStrings sentinel) → "Invalid global index: 4294967295" at
  // instantiate. This surfaced once #1629 S6 let Object.defineProperty reach
  // this guard under standalone instead of refusing at compile time.
  fctx.body.push({ op: "local.get", index: localIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [...stringConstantExternrefInstrs(ctx, message), { op: "throw", tagIdx }],
    else: [],
  });
}

// ── Object.defineProperty flag helpers ────────────────────────────────

/**
 * Property descriptor flag encoding for the __pf_ side-table:
 *   bit 0: writable
 *   bit 1: enumerable
 *   bit 2: configurable
 *   bit 3: "defined" marker (always 1 when a descriptor has been stored)
 *   bit 4: is accessor property (get/set vs data)
 */
export const PROP_FLAG_WRITABLE = 1 << 0; // 1
export const PROP_FLAG_ENUMERABLE = 1 << 1; // 2
export const PROP_FLAG_CONFIGURABLE = 1 << 2; // 4
export const PROP_FLAG_DEFINED = 1 << 3; // 8
export const PROP_FLAG_ACCESSOR = 1 << 4; // 16
const PROP_FLAGS_DEFAULT_DATA = PROP_FLAG_WRITABLE | PROP_FLAG_ENUMERABLE | PROP_FLAG_CONFIGURABLE | PROP_FLAG_DEFINED;

/**
 * (#3872) Record `<integrityVarKey>:<propName>` as explicitly non-writable, for
 * the assignment-path consult in `isNonWritableDataProperty`.
 *
 * Called from BOTH `Object.defineProperty` lowering arms (struct and externref)
 * so the consult behaves identically in the host and standalone lanes.
 *
 * Fires ONLY on an explicit `writable: false` data descriptor. The consult must
 * not fall back to `definedPropertyFlags`, which leaves the WRITABLE bit clear
 * when the descriptor merely OMITS `writable` — right for a fresh define, wrong
 * for a redefine ("omitted" means keep-existing). Reading that map as a write
 * permission cost 27 deterministic test262 regressions, including
 * `mapped-arguments-nonconfigurable-4.js`, whose descriptor never mentions
 * `writable` at all.
 */
function recordExplicitNonWritable(
  ctx: CodegenContext,
  objArg: ts.Expression,
  propName: string | undefined,
  descWritable: boolean | undefined,
  getNode: unknown,
  setNode: unknown,
): void {
  if (propName === undefined || !ts.isIdentifier(objArg)) return;
  if (descWritable !== false || getNode || setNode) return;
  ctx.nonWritableExternKeys.add(`${integrityVarKey(ctx, objArg)}:${propName}`);
}

function applyDescriptorFlags(
  currentFlags: number | undefined,
  writable: boolean | undefined,
  enumerable: boolean | undefined,
  configurable: boolean | undefined,
  isAccessor: boolean,
  hasData: boolean,
): number {
  let flags = currentFlags ?? PROP_FLAG_DEFINED;
  flags |= PROP_FLAG_DEFINED;

  if (writable !== undefined) flags = writable ? flags | PROP_FLAG_WRITABLE : flags & ~PROP_FLAG_WRITABLE;
  if (enumerable !== undefined) flags = enumerable ? flags | PROP_FLAG_ENUMERABLE : flags & ~PROP_FLAG_ENUMERABLE;
  if (configurable !== undefined) {
    flags = configurable ? flags | PROP_FLAG_CONFIGURABLE : flags & ~PROP_FLAG_CONFIGURABLE;
  }

  if (isAccessor) {
    flags |= PROP_FLAG_ACCESSOR;
  } else if (hasData) {
    flags &= ~PROP_FLAG_ACCESSOR;
  }

  return flags;
}

/**
 * (#3043) Compile-time §10.1.6.3 ValidateAndApplyPropertyDescriptor transition
 * check for a statically-tracked `varName:propName` property. Emits a Wasm
 * `throw TypeError` when redefining a NON-configurable property in a
 * spec-forbidden way. Shared so the data fast path, the accessor fast path, and
 * the attribute-only runtime path all enforce the SAME matrix against
 * `definedPropertyFlags` — previously only the inline data path validated, so an
 * accessor define (which records flags but routed a later attribute-only /
 * get-set redefine through a path that skipped validation) silently accepted
 * illegal transitions (15.2.3.6-4-30 / -252 / -312, 15.2.3.7-6-a-241).
 *
 * Mirrors the inline data-path check (writable-narrow, enum-toggle,
 * config-false→true, data↔accessor flip) and adds the accessor-redefine case:
 * `newProvidesFreshAccessorFn` is true when the redefining descriptor supplies a
 * get/set as a *fresh function expression* (getNode/setNode) — always a distinct
 * object, so redefining a non-configurable accessor's get/set with it can never
 * be SameValue and MUST throw (spec step 10.a/b). An identifier-ref get/set is
 * left to conservative allow (it *may* be SameValue with the existing accessor).
 *
 * The data/accessor KIND is read from `newFlags` (which `applyDescriptorFlags`
 * already resolved — an attribute-only redefine like `{enumerable:true}`
 * PRESERVES the existing kind), NOT from a raw "did this descriptor name a
 * get/set" flag: the latter false-flags a bare-attribute redefine of an
 * accessor as a data↔accessor flip (the accSameAttrs false-throw).
 *
 * Returns true when a throw was emitted (caller may skip further emission).
 */
function emitStaticDescriptorTransitionThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  existingFlags: number | undefined,
  newFlags: number,
  _isAccessor: boolean,
  newProvidesFreshAccessorFn: boolean,
): boolean {
  if (existingFlags === undefined) return false;
  if (existingFlags & PROP_FLAG_CONFIGURABLE) return false; // configurable ⇒ any redefine ok
  // configurable false → true is forbidden.
  if (newFlags & PROP_FLAG_CONFIGURABLE) {
    emitThrowTypeError(ctx, fctx, "Cannot redefine property");
    return true;
  }
  // enumerable toggle is forbidden.
  if ((existingFlags & PROP_FLAG_ENUMERABLE) !== (newFlags & PROP_FLAG_ENUMERABLE)) {
    emitThrowTypeError(ctx, fctx, "Cannot redefine property");
    return true;
  }
  const existingIsAccessor = !!(existingFlags & PROP_FLAG_ACCESSOR);
  const newIsAccessor = !!(newFlags & PROP_FLAG_ACCESSOR);
  // data ↔ accessor flip is forbidden on a non-configurable property.
  if (existingIsAccessor !== newIsAccessor) {
    emitThrowTypeError(ctx, fctx, "Cannot redefine property");
    return true;
  }
  // Data property: writable false → true is forbidden.
  if (!existingIsAccessor && !newIsAccessor && !(existingFlags & PROP_FLAG_WRITABLE) && newFlags & PROP_FLAG_WRITABLE) {
    emitThrowTypeError(ctx, fctx, "Cannot redefine property");
    return true;
  }
  // Accessor → accessor: a fresh (distinct) get/set can never be SameValue.
  if (existingIsAccessor && newIsAccessor && newProvidesFreshAccessorFn) {
    emitThrowTypeError(ctx, fctx, "Cannot redefine property");
    return true;
  }
  return false;
}

// ── Mapped-arguments value redefine (#2667) ──────────────────────────────

/**
 * Emit `Object.defineProperty(arguments, "<i>", { value: V })` for a mapped
 * arguments index, per ECMA-262 §10.4.4.2. The WasmGC-vec-backed arguments
 * object carries no sidecar descriptor for its indices, so routing this through
 * the runtime `Object.defineProperty` throws ("Cannot redefine property"). The
 * spec-correct behaviour for a still-mapped index is to update the arguments
 * slot AND the linked formal parameter; if the link was already severed
 * (`unmappedIndices`), only the slot is written. Leaves the arguments object
 * (externref) on the stack as the call result.
 */
function emitMappedArgValueDefine(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NonNullable<FunctionContext["mappedArgsInfo"]>,
  argIndex: number,
  valueExpr: ts.Expression,
): ValType {
  // Compile the value as externref (boxing numbers/refs) for storage in the
  // externref-backed arguments vec.
  const valType = compileExpression(ctx, fctx, valueExpr, { kind: "externref" });
  if (valType && valType.kind !== "externref") {
    coerceType(ctx, fctx, valType, { kind: "externref" });
  }
  const valLocal = allocLocal(fctx, `__mappedarg_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valLocal });

  // arguments vec slot write: vec.data[argIndex] = val (null-guarded). The slot
  // exists since argIndex < paramCount, so no grow is needed.
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
      { op: "local.get", index: valLocal },
      { op: "array.set", typeIdx: info.arrTypeIdx },
    ],
  });

  // Param sync — reuse the canonical mapped-args reverse-sync emitter, which
  // already skips severed (`unmappedIndices`) slots (§10.4.4.2) and owns the
  // single value-coercion vocabulary (§7.1.x), so this site stays out of the
  // per-file coercion-site budget (#2108). It matches on a runtime index, so
  // pin a constant-index local to argIndex.
  const idxLocal = allocLocal(fctx, `__mappedarg_idx_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: argIndex });
  fctx.body.push({ op: "local.set", index: idxLocal });
  emitMappedArgReverseSync(ctx, fctx, idxLocal, valLocal);

  // Result of Object.defineProperty is the object — push arguments as externref.
  fctx.body.push({ op: "local.get", index: info.argsLocalIdx });
  fctx.body.push({ op: "extern.convert_any" });
  return { kind: "externref" };
}

// ── Object.defineProperty ─────────────────────────────────────────────

/**
 * Compile Object.defineProperty(obj, prop, descriptor).
 *
 * If the descriptor is an object literal with a `value` property, we extract
 * the value and emit __extern_set(obj, prop, value).
 * If the descriptor has `get` and/or `set` properties, we compile them as
 * struct accessor methods (getter/setter functions).
 * Otherwise we compile all arguments for side effects and return the object unchanged.
 *
 * Returns obj (externref).
 */
function emitInheritedTrueDescriptorDefineProperty(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objArg: ts.Expression,
  propArg: ts.Expression,
  descArg: ts.Expression,
  call: ts.CallExpression,
): ValType | null | undefined {
  const inheritedFlags = inheritedTrueDescriptorFlags(ctx, descArg, call);
  if (!inheritedFlags) return undefined;
  return emitExternDefinePropertyNoValue(
    ctx,
    fctx,
    objArg,
    propArg,
    descArg,
    inheritedFlags.writable,
    undefined,
    inheritedFlags.configurable,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    false,
    true,
  );
}

/**
 * (#4491) §10.4.4.2 step 5.b.i — the parameter write owed by a define that the
 * inline mapped fast path declined.
 *
 * `emitMappedArgValueDefine` handles the shapes it can lower inline (it writes
 * the slot AND the linked parameter). Every other data define on a mapped index
 * — `writable: false`, or any index whose descriptor already lives in the
 * runtime sidecar — falls through to the generic define, which writes only the
 * arguments slot. The linked formal parameter was then left at its old value:
 * `(function (a) { Object.defineProperty(arguments, "0", { value: 20, writable:
 * false }); return a; })(0)` answered 0, not 20.
 *
 * The core records the debt HERE rather than the wrapper re-deriving the
 * fast-path predicate, so the two can never disagree about which defines the
 * inline path took. Saved/restored around the core call, since compiling the
 * descriptor can itself contain a nested `Object.defineProperty`.
 */
type PendingMappedArgSync = { info: NonNullable<FunctionContext["mappedArgsInfo"]>; argIndex: number };
let pendingMappedArgSync: PendingMappedArgSync | null = null;

/**
 * Emit step 5.b.i for the case above, AFTER the define has stored the value in
 * the arguments slot: read that slot back — it is exactly `Desc.[[Value]]`, so
 * the descriptor expression is evaluated once — and push it into the linked
 * parameter. Net stack effect is zero, so the define's own result stays on top.
 */
function emitMappedArgValueSyncAfterDefine(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pending: PendingMappedArgSync,
): void {
  const { info, argIndex } = pending;
  const valLocal = allocLocal(fctx, `__mappedarg_defval_${fctx.locals.length}`, { kind: "externref" });
  const idxLocal = allocLocal(fctx, `__mappedarg_defidx_${fctx.locals.length}`, { kind: "i32" });

  // Under-applied calls build a vec shorter than the formal count, so the slot
  // is not guaranteed to exist; an absent slot has no mapping to update.
  fctx.body.push({ op: "local.get", index: info.argsLocalIdx });
  fctx.body.push({ op: "struct.get", typeIdx: info.vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "i32.const", value: argIndex });
  fctx.body.push({ op: "i32.gt_u" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: info.argsLocalIdx },
      { op: "struct.get", typeIdx: info.vecTypeIdx, fieldIdx: 1 },
      { op: "i32.const", value: argIndex },
      { op: "array.get", typeIdx: info.arrTypeIdx },
      { op: "local.set", index: valLocal },
      { op: "i32.const", value: argIndex },
      { op: "local.set", index: idxLocal },
    ],
    else: [
      // Out of range: point the runtime index at a slot no parameter matches.
      { op: "i32.const", value: -1 },
      { op: "local.set", index: idxLocal },
    ],
  });

  // The define already applied step 5.b.ii while parsing the descriptor, and
  // `emitMappedArgReverseSync` skips severed indices. Re-open the link for the
  // duration of this emission so the two steps land in spec order.
  const severed = info.unmappedIndices?.delete(argIndex) ?? false;
  emitMappedArgReverseSync(ctx, fctx, idxLocal, valLocal);
  if (severed) info.unmappedIndices?.add(argIndex);
}

export function compileObjectDefineProperty(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const saved = pendingMappedArgSync;
  pendingMappedArgSync = null;
  const result = compileObjectDefinePropertyCore(ctx, fctx, expr);
  const pending = pendingMappedArgSync;
  pendingMappedArgSync = saved;
  if (pending !== null) emitMappedArgValueSyncAfterDefine(ctx, fctx, pending);
  return result;
}

function compileObjectDefinePropertyCore(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const objArg = expr.arguments[0]!;
  const propArg = expr.arguments[1]!;
  // Strip TS-only `as`/`!`/type-assertion wrappers so descriptor shape inspection
  // (object-literal detection, primitive-literal R5 check, etc.) sees the real node.
  const descArg = unwrapTransparentExpression(expr.arguments[2]!);

  // (#2726) Record the defineProperty'd `varName:propName` on an identifier
  // receiver up-front, BEFORE any lowering-path branch (inline data fast path,
  // inline accessor fast path, runtime-descriptor route, …). This is the single
  // chokepoint every path flows through, so it captures the signal uniformly —
  // unlike `definedPropertyFlags` (inline-literal only) and
  // `sidecarDefinedPropertyKeys` (runtime route only). It exists ONLY to route
  // `hasOwnProperty` / `propertyIsEnumerable` to the runtime helper (so a
  // subsequent configurable `delete`'s tombstone is honoured) and never feeds
  // descriptor-flag logic. Recorded even if a guard below throws — a defineProperty
  // that throws defines nothing, and the runtime presence answer stays correct.
  if (ts.isIdentifier(objArg)) {
    const dpPropName = ts.isStringLiteral(propArg)
      ? propArg.text
      : ts.isNumericLiteral(propArg)
        ? propArg.text
        : undefined;
    if (dpPropName !== undefined) {
      ctx.definePropertyReceiverKeys.add(`${objArg.text}:${dpPropName}`);
    }
  }

  // ES spec 19.1.2.4 step 1: throw TypeError if first arg is not an object
  if (emitNonObjectArgGuard(ctx, fctx, objArg, "Object.defineProperty")) {
    // After the throw, emit unreachable and return externref to satisfy callers
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }

  // (#1460 R5) ES spec §6.2.5.5 step 1: throw TypeError if descriptor is not an object.
  // Static check: numeric/string/boolean/null/undefined literal descriptors are spec
  // violations. The runtime helpers already check this for opaque cases, but the
  // compiler-time check produces a clean throw that the test262 suite expects.
  if (isStaticallyNonObjectDescExpr(descArg)) {
    // Compile obj/prop for side effects then throw.
    const t1 = compileExpression(ctx, fctx, objArg);
    if (t1) fctx.body.push({ op: "drop" });
    const t2 = compileExpression(ctx, fctx, propArg);
    if (t2) fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, "TypeError: Property description must be an object");
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }

  // (#3116) A LITERAL `get: null` / `set: null` descriptor field is a
  // compile-time-provable ToPropertyDescriptor TypeError (§10.1: present, not
  // undefined, not callable). The inline lowerings used to classify null as
  // "no accessor" and silently degrade to a data define, and the runtime route
  // can't be trusted with it — a null struct field is indistinguishable from
  // an absent/undefined one at the wasm boundary (#2106). Emit the throw
  // eagerly after evaluating the arguments for side effects (spec order).
  if (ts.isObjectLiteralExpression(descArg)) {
    let nullAccessor: "Getter" | "Setter" | undefined;
    for (const dp of descArg.properties) {
      if (!ts.isPropertyAssignment(dp) || !ts.isIdentifier(dp.name)) continue;
      if (unwrapTransparentExpression(dp.initializer).kind !== ts.SyntaxKind.NullKeyword) continue;
      if (dp.name.text === "get") nullAccessor = "Getter";
      else if (dp.name.text === "set" && nullAccessor === undefined) nullAccessor = "Setter";
    }
    if (nullAccessor !== undefined) {
      const t1 = compileExpression(ctx, fctx, objArg);
      if (t1) fctx.body.push({ op: "drop" });
      const t2 = compileExpression(ctx, fctx, propArg);
      if (t2) fctx.body.push({ op: "drop" });
      const t3 = compileExpression(ctx, fctx, descArg);
      if (t3) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, `${nullAccessor} must be a function: null`);
      fctx.body.push({ op: "unreachable" });
      return { kind: "externref" };
    }
  }

  // (#1355 Slice F) Standalone proxy-receiver routing. A standalone `Proxy`
  // (`new Proxy(t, h)`) is an opaque externref typed `any` — it never resolves to
  // a static struct, so the inline-literal fast paths below
  // (`__defineProperty_value` / `__defineProperty_accessor`) would store the value
  // DIRECTLY on the proxy externref and never fire the `defineProperty` trap.
  // Route a PROVABLE-proxy receiver through `emitDefinePropertyDescRuntime` →
  // `__obj_define_from_desc`, whose `ref.test $Proxy` front-guard diverts a proxy
  // to `__proxy_define_dispatch(target, key, desc)` (the descriptor passed through
  // whole). For a NON-proxy receiver this is behaviour-identical —
  // `__obj_define_from_desc` dispatches to the SAME
  // `__defineProperty_value`/`__defineProperty_accessor` store — but the inline
  // fast paths below would otherwise store the value DIRECTLY on the proxy
  // externref and never fire the `defineProperty` trap.
  //
  // GATE PRECISELY on a *syntactic* `new Proxy(...)` shape (a direct
  // `new Proxy(...)` receiver, or an identifier whose variable-declaration
  // initializer is `new Proxy(...)`), NOT merely a dynamic `any` receiver: a bare
  // `any` reroute swallowed the §19.1.2.4-step-1 non-object throw for `const o:
  // any = null` (the inline path's later null-guard never ran). The proxy harness
  // rows always bind `const p = new Proxy(t, h)` then `defineProperty(p, …)`, so
  // this shape covers them while leaving every non-proxy receiver on its existing
  // path. Accessor/getter inline literals are NOT rerouted (the proxy
  // defineProperty harness rows use data descriptors; an accessor reroute would
  // lose the struct-accessor compiled-getter wiring).
  if (ctx.standalone) {
    const isProxyReceiver = (() => {
      const isNewProxy = (e: ts.Expression): boolean =>
        ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "Proxy";
      if (isNewProxy(objArg)) return true;
      if (ts.isIdentifier(objArg)) {
        const sym = ctx.checker.getSymbolAtLocation(objArg);
        const decl = sym?.valueDeclaration;
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer && isNewProxy(decl.initializer)) {
          return true;
        }
      }
      return false;
    })();
    const isAccessorLiteral =
      ts.isObjectLiteralExpression(descArg) &&
      descArg.properties.some(
        (p) =>
          (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) &&
          ts.isIdentifier(p.name) &&
          (p.name.text === "get" || p.name.text === "set"),
      );
    if (isProxyReceiver && !isAccessorLiteral) {
      const init = !ts.isObjectLiteralExpression(descArg)
        ? descriptorInitializerForIdentifier(ctx, descArg)
        : undefined;
      const r = emitDefinePropertyDescRuntime(
        ctx,
        fctx,
        objArg,
        propArg,
        descArg,
        init ? descriptorUndefinedFields(init) : [],
      );
      // (#3177 slice 4) Object.defineProperty converts a null (rejection
      // sentinel / falsy-undefined trap result) into the §20.1.2.4 TypeError.
      if (r !== null) emitDefinePropertyRejectionThrow(ctx, fctx);
      return r;
    }
  }

  // (#2668 Slice C) Array exotic `[[DefineOwnProperty]]` for the `length`
  // property: `Object.defineProperty(arr, "length", desc)` (ES §10.4.2.1
  // ArraySetLength) — RangeError on a non-uint32 length value, TypeError on an
  // illegal attribute change / accessor descriptor, else set `vec.length`. When
  // it fully handles the define, return immediately (the receiver is the result).
  //
  // (#3251 S3) STANDALONE-GATED OFF: the native `__vec_dp_value` length arm now
  // implements the FULL ArraySetLength — including the per-index-configurable
  // shrink stop (step 15) and the non-writable length bit that this inline
  // path deliberately deferred — over the overlay companion. The inline path
  // has no companion knowledge, so letting it win here silently shrank past
  // non-configurable indices in the static lane. Host mode is unchanged.
  if (!ctx.standalone) {
    const lenDef = maybeEmitVecLengthDefine(ctx, fctx, objArg, propArg, descArg);
    if (lenDef !== false) return lenDef;
  }

  // (#1130 PR-0) Array exotic objects grow `length` when a numeric-index
  // property at or beyond the current length is defined. Emit the guarded
  // bump before the descriptor is applied; no-op for non-array receivers.
  //
  // (#3251 S1) STANDALONE-GATED OFF: the native `__defineProperty_value` vec
  // arm owns growth there (per-carrier `__vec_elem_set_<t>` on write-back).
  // The call-site pre-growth destroyed the real-element/fresh-hole
  // distinction the overlay's seeding depends on (the #3116 regression-class-1
  // hazard: a pre-grown hole at idx<length is indistinguishable from a real
  // element, so a FRESH index define would seed w/e/c=true instead of the
  // CompletePropertyDescriptor false defaults). Host mode is unchanged.
  if (!ctx.standalone) maybeEmitVecLengthGrowth(ctx, fctx, objArg, propArg);

  // (#2668 Slice A) Host-mode DYNAMIC-DESCRIPTOR route. The inline fast paths
  // below only fire when the descriptor is a *syntactic* object literal at the
  // call site (`Object.defineProperty(o, k, { value: 1 })`). The common
  // `var d = { value: 1 }; Object.defineProperty(o, k, d)` shape (descriptor in
  // a local whose initializer is an object literal — the dominant `15.2.3.6-3-*`
  // ES5 pattern) never reached any value/attr handling and fell through to
  // `emitExternDefinePropertyNoValue`, silently dropping the value + attributes.
  // Route THAT shape through `emitDefinePropertyDescRuntime` →
  // `__defineProperty_desc`, the runtime applier that runs full
  // ToPropertyDescriptor + `_validatePropertyDescriptor` (§10.1.6.3) and writes
  // the canonical `_wasmPropDescs` sidecar every read / for-in / write / delete
  // consults; for a plain JS receiver + plain JS descriptor it bottoms out in
  // native `Object.defineProperty`, so attribute defaulting,
  // redefine-preserves-omitted, non-configurable throws, and SameValue come for
  // free.
  //
  // SCOPE — only when the descriptor identifier resolves to a *literal*
  // initializer (`descriptorInitializerForIdentifier`). Deliberately NOT routing
  // arbitrary host-object descriptors (`Math`, a `Date` instance, an
  // `Object.create(proto)` whose attributes live on a sidecar-backed
  // PROTOTYPE): `__defineProperty_desc`'s ToPropertyDescriptor reader resolves a
  // WasmGC-struct descriptor's attributes only on its OWN level, so a
  // prototype-inherited `enumerable`/`configurable` is dropped — which would
  // flip those properties non-enumerable and regress the
  // `15.2.3.6-3-23..45` for-in cluster (a deeper Object.create + proto-sidecar
  // gap, out of Slice A scope). Those non-literal descriptors keep their prior
  // path. The standalone lane has its own native route (#1629b / #2372). Inline
  // object literals keep their zero-overhead fast paths (no behavior change).
  if (!ctx.standalone && !ts.isObjectLiteralExpression(descArg)) {
    const init = descriptorInitializerForIdentifier(ctx, descArg);
    if (init) {
      return emitDefinePropertyDescRuntime(ctx, fctx, objArg, propArg, descArg, descriptorUndefinedFields(init));
    }
  }

  // Check if descriptor is an object literal with a `value`, `get`, or `set` property
  let valueExpr: ts.Expression | undefined;
  let getNode: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
  let setNode: ts.MethodDeclaration | ts.SetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
  // For `get: identifierRef` / `set: identifierRef` — not inline function nodes but expression refs
  let getExpr: ts.Expression | undefined;
  let setExpr: ts.Expression | undefined;
  // (#2992 S3) explicit `get: undefined` / `set: undefined` — a PRESENT
  // accessor field per ToPropertyDescriptor (§6.2.5.6), routed as an accessor
  // define with an empty half under standalone (host mode keeps its
  // `emitDefinePropertyDescRuntime` route below, which handles presence).
  let getExplicitUndefined = false;
  let setExplicitUndefined = false;
  if (ts.isObjectLiteralExpression(descArg)) {
    for (const prop of descArg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") {
        valueExpr = prop.initializer;
      }
      // get: function() { ... } or get: () => ...
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "get" &&
        (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer))
      ) {
        getNode = prop.initializer;
      }
      // get() { ... } (method shorthand)
      if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === "get") {
        getNode = prop;
      }
      // set: function(v) { ... } or set: (v) => ...
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "set" &&
        (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer))
      ) {
        setNode = prop.initializer;
      }
      // set(v) { ... } (method shorthand)
      if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name) && prop.name.text === "set") {
        setNode = prop;
      }
      // get: someIdentifier (function reference, not inline)
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "get" &&
        !ts.isFunctionExpression(prop.initializer) &&
        !ts.isArrowFunction(prop.initializer)
      ) {
        const init = prop.initializer;
        // Only treat as accessor if it's not `undefined` or `null`
        if (
          !(ts.isIdentifier(init) && (init.text === "undefined" || init.text === "null")) &&
          !(init.kind === ts.SyntaxKind.NullKeyword)
        ) {
          getExpr = init;
        } else if (ts.isIdentifier(init) && init.text === "undefined") {
          // (#2992 S3) `get: undefined` is still a PRESENT [[Get]] field per
          // ToPropertyDescriptor — the define creates/merges an ACCESSOR
          // property whose get half is undefined (15.2.3.6-4-439).
          getExplicitUndefined = true;
        }
      }
      // set: someIdentifier (function reference, not inline)
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "set" &&
        !ts.isFunctionExpression(prop.initializer) &&
        !ts.isArrowFunction(prop.initializer)
      ) {
        const init = prop.initializer;
        if (
          !(ts.isIdentifier(init) && (init.text === "undefined" || init.text === "null")) &&
          !(init.kind === ts.SyntaxKind.NullKeyword)
        ) {
          setExpr = init;
        } else if (ts.isIdentifier(init) && init.text === "undefined") {
          // (#2992 S3) `set: undefined` — see the get half above.
          setExplicitUndefined = true;
        }
      }
    }
  }

  // ── Parse descriptor flags (configurable, writable, enumerable) ──────
  // Defaults per spec: all false when using Object.defineProperty.
  // (#1460 R1) Apply ToBoolean per ES §6.2.5.6 step 5.b — `tryConstantFoldToBoolean`
  // handles all statically-known shapes (`0`, `-12345`, `null`, `"foo"`, `{}`, etc.).
  // Track whether the property key was present in the descriptor (`*Specified`)
  // separately from its boolean value — an unspecified attribute is functionally
  // identical to `false` for `Object.defineProperty` per ES §6.2.5.6 step 7, but
  // we must NOT downgrade an attribute that was supplied dynamically to "absent".
  let descWritable: boolean | undefined;
  let descEnumerable: boolean | undefined;
  let descConfigurable: boolean | undefined;
  let writableDynamic = false;
  let enumerableDynamic = false;
  let configurableDynamic = false;
  if (ts.isObjectLiteralExpression(descArg)) {
    for (const prop of descArg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        const name = prop.name.text;
        if (name === "writable" || name === "enumerable" || name === "configurable") {
          const folded = tryConstantFoldToBoolean(prop.initializer);
          if (name === "writable") {
            descWritable = folded;
            if (folded === undefined) writableDynamic = true;
          } else if (name === "enumerable") {
            descEnumerable = folded;
            if (folded === undefined) enumerableDynamic = true;
          } else if (name === "configurable") {
            descConfigurable = folded;
            if (folded === undefined) configurableDynamic = true;
          }
        }
      }
    }
  }
  const _anyFlagDynamic = writableDynamic || enumerableDynamic || configurableDynamic;

  // (#1460 R4) ES spec §6.2.5.6 step 4 — if the descriptor mixes data attributes
  // (value / writable) with accessor attributes (get / set), throw TypeError.
  // Detect statically so the diagnostic doesn't depend on runtime descriptor
  // shape resolution.
  {
    const hasData = valueExpr !== undefined || descWritable !== undefined || writableDynamic;
    const hasAccessor =
      getNode !== undefined ||
      setNode !== undefined ||
      getExpr !== undefined ||
      setExpr !== undefined ||
      // (#2992 S3, standalone) explicit `get: undefined`/`set: undefined` are
      // present accessor fields for the §6.2.5.6 step-4 conflict too. Host
      // mode keeps its runtime-route handling (byte-inert).
      (ctx.standalone && (getExplicitUndefined || setExplicitUndefined));
    if (hasData && hasAccessor) {
      // Compile obj/prop for side effects then throw.
      const t1 = compileExpression(ctx, fctx, objArg);
      if (t1) fctx.body.push({ op: "drop" });
      const t2 = compileExpression(ctx, fctx, propArg);
      if (t2) fctx.body.push({ op: "drop" });
      emitThrowTypeError(
        ctx,
        fctx,
        "TypeError: Invalid property descriptor. Cannot both specify accessors and a value or writable attribute",
      );
      fctx.body.push({ op: "unreachable" });
      return { kind: "externref" };
    }
  }

  // Resolve the property name at compile time (string literal)
  let propName: string | undefined;
  if (ts.isStringLiteral(propArg)) {
    propName = propArg.text;
  }

  // (#1511) Mapped-arguments link-break. Per ECMA-262 §10.4.4.2
  // (ArgumentsExoticObject.[[DefineOwnProperty]]), defining a mapped index
  // with an accessor descriptor, or a data descriptor whose `writable` is
  // explicitly false, removes the param↔arguments mapping for that index:
  // subsequent parameter writes must stop reflecting into `arguments[i]` and
  // vice-versa. Setting only `configurable:false` (or `enumerable`) leaves the
  // map intact. We detect the statically-resolvable shape — `arguments` as the
  // receiver identifier (in a mapped-args function) with a literal index — and
  // sever the link in `mappedArgsInfo.unmappedIndices`; the mapped-sync
  // emitters read this set live, so codegen order makes the break apply only
  // to syncs emitted after this defineProperty call.
  if (
    fctx.mappedArgsInfo &&
    ts.isIdentifier(objArg) &&
    objArg.text === "arguments" &&
    ts.isObjectLiteralExpression(descArg)
  ) {
    const idxKey = propName ?? (ts.isNumericLiteral(propArg) ? propArg.text : undefined);
    const argIndex = idxKey !== undefined ? Number(idxKey) : NaN;
    if (Number.isInteger(argIndex) && argIndex >= 0 && argIndex < fctx.mappedArgsInfo.paramCount) {
      const info = fctx.mappedArgsInfo;
      const isAccessor =
        getNode !== undefined || setNode !== undefined || getExpr !== undefined || setExpr !== undefined;
      // (#4491) Whether the index is mapped as this define BEGINS — read before
      // the step-5.b.ii sever below, since step 5.b.i still applies to it.
      const wasMapped = !(info.unmappedIndices?.has(argIndex) ?? false);
      const breaksLink = isAccessor || descWritable === false;
      if (breaksLink) {
        (info.unmappedIndices ??= new Set<number>()).add(argIndex);
      }
      // (#2667) Track non-configurable / non-writable attribute state so the
      // delete + element-write emitters can apply §10.4.4 semantics for the
      // statically-resolvable case (literal index on the `arguments`
      // identifier). `configurable:false` makes `delete arguments[i]` return
      // false (OrdinaryDelete) without severing the map; `writable:false`
      // freezes the value (writes dropped) and severs the map.
      if (descConfigurable === false) {
        (info.nonConfigurableIndices ??= new Set<number>()).add(argIndex);
      }
      if (descWritable === false) {
        (info.nonWritableIndices ??= new Set<number>()).add(argIndex);
      }

      // (#2667) A pure data-descriptor define carrying a literal `value`, for a
      // mapped arguments index, writes the arguments slot and — when the slot is
      // still mapped — the linked formal parameter (§10.4.4.2 +
      // OrdinaryDefineOwnProperty). Routing it through the runtime
      // `Object.defineProperty` on the WasmGC-vec-backed arguments object trips
      // `_validatePropertyDescriptor` ("Cannot redefine property") because the
      // vec carries no matching sidecar descriptor. Handle it inline.
      //
      // A value change is permitted whenever the property is still configurable
      // (configurable ⇒ any redefinition is allowed) OR still writable. It is
      // forbidden only once the slot is BOTH non-configurable AND non-writable
      // (truly frozen) — that case is left to the runtime so it reports the
      // spec-mandated TypeError. `nonWritableIndices` severs the param map (set
      // above + via `unmappedIndices`), so the helper writes only the slot.
      const isFrozen =
        (info.nonConfigurableIndices?.has(argIndex) ?? false) &&
        (info.nonWritableIndices?.has(argIndex) ?? false) &&
        descWritable !== true; // re-enabling writable un-freezes
      const isPureDataValueDefine =
        !isAccessor &&
        valueExpr !== undefined &&
        getExpr === undefined &&
        setExpr === undefined &&
        descWritable !== false && // writable:false freezes — handled by the drop path below
        !isFrozen &&
        // (#4491) …and only while the opaque vec slot is still the authority for
        // this index. Once a define has been routed to the runtime the sidecar
        // descriptor is, and a slot-only write would desync the two.
        !(info.runtimeDefinedIndices?.has(argIndex) ?? false);
      if (isPureDataValueDefine) {
        return emitMappedArgValueDefine(ctx, fctx, info, argIndex, valueExpr!);
      }
      // Everything else falls through to the generic define, which records a
      // real descriptor for this index.
      (info.runtimeDefinedIndices ??= new Set<number>()).add(argIndex);
      // …and writes only the arguments SLOT. §10.4.4.2 step 5.b.i additionally
      // requires `Map.[[Set]]` — the linked formal parameter — for a data
      // descriptor with an explicit [[Value]] on an index that was still mapped
      // when this define started. The wrapper emits it after the define, so the
      // value is read back from the slot (evaluated once) and the step-5.b.ii
      // sever above cannot pre-empt it.
      if (!isAccessor && valueExpr !== undefined && wasMapped) {
        pendingMappedArgSync = { info, argIndex };
      }
    }
  }

  // (#1629a) Dynamic-descriptor path: when the descriptor argument is not an
  // ObjectLiteralExpression (e.g. `var d = {value: 1}; defineProperty(o, k, d)`),
  // the inline-literal code below has nothing to extract — valueExpr / getNode /
  // descWritable are all undefined. The legacy fall-through to
  // emitExternDefinePropertyNoValue silently emits empty flags AND for typed
  // struct receivers skips the runtime call entirely, so the descriptor's
  // value / accessor / flag bits are dropped on the floor.
  //
  // Route to the runtime's __defineProperty_desc helper, which materializes
  // the descriptor via struct-aware getField (sidecar + __sget_<f> exports)
  // and applies it via native Object.defineProperty. The obj is coerced to
  // externref so the runtime sees a uniform entry point — this matches the
  // sibling Object.create path at calls.ts:3996+ (#1631).
  if (!ts.isObjectLiteralExpression(descArg)) {
    // (#3663) Fold direct inherited TRUE descriptor flags into the canonical
    // runtime store when the carrier and prototype writes are both proven.
    const inheritedResult = emitInheritedTrueDescriptorDefineProperty(ctx, fctx, objArg, propArg, descArg, expr);
    if (inheritedResult !== undefined) return inheritedResult;
    const init = descriptorInitializerForIdentifier(ctx, descArg);
    const r = emitDefinePropertyDescRuntime(
      ctx,
      fctx,
      objArg,
      propArg,
      descArg,
      init ? descriptorUndefinedFields(init) : [],
    );
    // (#3177 slice 4) §20.1.2.4 step 3: the applier threads the dyn-view
    // [[DefineOwnProperty]]-false sentinel (null) out — Object.defineProperty
    // converts it to TypeError. (Reflect.defineProperty consumes the same
    // applier via `__is_truthy` → `false` instead; see call-namespace-static.)
    if (r !== null) emitDefinePropertyRejectionThrow(ctx, fctx);
    return r;
  }

  // (#1629) Explicit-`undefined` descriptor fields (e.g. `{ value: undefined }`,
  // `{ get: undefined }`) need the runtime __defineProperty_desc path so the
  // field is recorded as PRESENT (not omitted) per ToPropertyDescriptor. That
  // path emits the `__defineProperty_desc` / `__extern_set` JS-host imports,
  // which are refused in `--target standalone` (#1472 Phase B) and would turn
  // every such inline literal into a compile_error. The standalone fast path
  // (struct.set + flag table) already compiles these correctly — origin/main
  // passed all of test/built-ins/Object/define*({value:undefined}) in
  // standalone via that path — so only take the host-runtime branch when a JS
  // host is available. JS-host mode keeps the precise presence-bit behavior.
  if (!ctx.standalone) {
    const explicitUndefinedFields = descriptorUndefinedFields(descArg);
    if (explicitUndefinedFields.length > 0) {
      return emitDefinePropertyDescRuntime(ctx, fctx, objArg, propArg, descArg, explicitUndefinedFields);
    }
  }

  // Check if obj is a struct type with the given field
  // (#4394) …unless the receiver IS the global object — see `isGlobalObjectExpr`.
  // ALL lanes: in JS-host mode the global object is a host value with no
  // compiled struct. Standalone/WASI build globalThis as the native `$Object`
  // singleton (`emitNativeGlobalThisObject`) — that is a RUNTIME-internal
  // struct type, NOT the checker-minted `typeof globalThis` struct that
  // `resolveStructName` returns, so the struct arm's guarded `ref.test`
  // misses there too (else-arm `ref.null` → the misleading "called on null"
  // TypeError). The extern arm routes to the native `__defineProperty_value`
  // runtime, which handles the `$Object` receiver host-free.
  const objTsType = ctx.checker.getTypeAtLocation(objArg);
  const receiverIsHostGlobalObject = isGlobalObjectExpr(ctx, fctx, objArg);
  let structName = receiverIsHostGlobalObject
    ? undefined
    : resolveStructName(ctx, objTsType) || (ts.isIdentifier(objArg) ? widenedStructNameForUse(ctx, objArg) : undefined);

  // (#1629 S3) Whether the receiver is *statically* struct-typed — i.e. resolved
  // WITHOUT the `any`/externref rescue fallbacks 1-3 below. This is the same
  // strength of resolution the *read* site (`resolveStructNameForExpr` in
  // property-access.ts) has, so when it is set the compiled accessor fast path
  // (`${structName}_get_<prop>` + `classAccessorSet`) is reachable from reads and
  // must be kept. When it is unset (the `const o:any = {...}` case, resolved only
  // via the define-site-only fallbacks), reads route through `__extern_get` /
  // `_safeGet`, which the synthesized compiled getter can NOT serve — those must
  // instead mirror the accessor into the runtime sidecar (the working
  // `emitExternDefinePropertyNoValue` → `__defineProperty_accessor` path). Splitting
  // on this bit fixes the `const o:any` accessor-get bug without regressing the
  // statically struct-typed (class-instance) accessor path.
  const receiverIsStaticStruct = structName !== undefined;
  // #4504: `C.prototype` is an inherited-descriptor owner, never the
  // instance's physical struct.  The historical static-struct accessor path
  // recorded `${C}_p` in `classAccessorSet`, which later made the closed-field
  // write ladder suppress a real own slot on `new C()`.  In descriptor-active
  // standalone modules keep this target on the runtime prototype path instead;
  // genuine instance-side accessors retain the compiled fast path below.
  const prototypeDescriptorTarget =
    ctx.standalone &&
    inheritedSetAnyDirty(ctx) &&
    (() => {
      const unwrapped = unwrapTransparentExpression(objArg);
      return ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === "prototype";
    })();

  // Fallback 1: resolve struct name from the local variable's Wasm type.
  // This handles cases where the TS type is `any` but the local holds a struct ref.
  if (!structName && ts.isIdentifier(objArg)) {
    const localIdx = fctx.localMap.get(objArg.text);
    if (localIdx !== undefined) {
      const localType =
        localIdx < fctx.params.length ? fctx.params[localIdx]!.type : fctx.locals[localIdx - fctx.params.length]?.type;
      if (localType && (localType.kind === "ref" || localType.kind === "ref_null")) {
        structName = ctx.typeIdxToStructName.get(localType.typeIdx);
      }
    }
  }

  // Fallback 2: resolve struct name from the variable's declaration initializer.
  // For `const obj: any = { x: 0 }`, the TS type is `any` and the local is
  // externref, but the initializer is an object literal whose fields match a struct.
  if (!structName && ts.isIdentifier(objArg)) {
    const sym = ctx.checker.getSymbolAtLocation(objArg);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const initType = ctx.checker.getTypeAtLocation(decl.initializer);
      structName = resolveStructName(ctx, initType);
      // If resolveStructName failed (ts.Type identity mismatch), try to match
      // by struct field names against the object literal properties.
      if (!structName && ts.isObjectLiteralExpression(decl.initializer)) {
        const litProps = decl.initializer.properties
          .filter((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name))
          .map((p) => (p.name as ts.Identifier).text)
          .sort();
        if (litProps.length > 0) {
          for (const [sName, sFields] of ctx.structFields) {
            const fieldNames = sFields.map((f) => f.name).sort();
            if (fieldNames.length === litProps.length && fieldNames.every((n, i) => n === litProps[i])) {
              structName = sName;
              break;
            }
          }
        }
      }
    }
  }

  const structTypeIdx = structName ? ctx.structMap.get(structName) : undefined;
  const fields = structName ? ctx.structFields.get(structName) : undefined;
  const fieldIdx = fields && propName ? fields.findIndex((f) => f.name === propName) : -1;
  // (#1460 R1) When any flag has a *dynamic* (non-foldable) initializer, the
  // struct fast path can't encode it — fall back to externref. For statically-
  // folded flags we keep struct.set (preserves the value-storage side-effect)
  // and emit an additional side-effect `__defineProperty_value` call further
  // below so attribute flags are propagated to the runtime sidecar
  // (`_wasmPropDescs`) for later `Object.getOwnPropertyDescriptor` reads.
  // (#3116) Veto the compile-time struct fast path when a PRIOR define for the
  // same var:prop went through a runtime route (`sidecarDefinedPropertyKeys` —
  // populated by emitDefinePropertyDescRuntime / emitExternDefineProperty*):
  // the authoritative descriptor state (attributes AND the SameValue-relevant
  // current value) then lives in the runtime sidecar, which the compile-time
  // `definedPropertyFlags` tracker cannot see. A static struct.set here would
  // skip §10.1.6.3 validation against that state (e.g. redefining `{value:-0}`
  // over a non-writable `+0` defined via a descriptor variable must throw —
  // 15.2.3.7-6-a-46). Routing to the externref path keeps validation in the
  // runtime, and `_structFieldWriteback` still mirrors the value into the
  // typed struct field for static reads.
  const priorRuntimeDefine =
    propName !== undefined &&
    ts.isIdentifier(objArg) &&
    ctx.sidecarDefinedPropertyKeys.has(`${objArg.text}:${propName}`);
  const useStruct =
    !_anyFlagDynamic && !priorRuntimeDefine && structTypeIdx !== undefined && fields && fieldIdx >= 0 && valueExpr;
  const anyFlagSpecified =
    _anyFlagDynamic || descWritable !== undefined || descEnumerable !== undefined || descConfigurable !== undefined;

  // ── Getter/setter path ──────────────────────────────────────────────
  // Object.defineProperty(obj, "prop", { get() {...}, set(v) {...} })
  //
  // (#1629 S3) For a *statically struct-typed* receiver (a class instance / typed
  // object — `receiverIsStaticStruct`) this branch compiles the getter/setter into
  // a `${structName}_get_<prop>` Wasm function + `classAccessorSet` registration,
  // which the read site dispatches via `compilePropertyAccess`'s class-accessor
  // path. That read site resolves the same `structName`, so the compiled fast
  // path is reachable and stays — removing it regresses the #459 accessor suite.
  //
  // For a `const o:any = {...}` receiver, by contrast, `structName` was resolved
  // ONLY via the define-site rescue fallbacks 1-3 below, which the *read* site
  // (`resolveStructNameForExpr`) lacks. Such reads lower to `__extern_get` /
  // `_safeGet`, which the synthesized compiled getter can NOT serve — so the old
  // unconditional early-return left the getter in neither
  // `_wasmStructProps[obj]["__get_<prop>"]` nor `_wasmStructAccessors`, and
  // `o.p` / `o["p"]` / `o[k]` / host reads returned `undefined`. We now fall
  // those through (below) to `emitExternDefinePropertyNoValue`, which mirrors
  // get/set into the runtime `__defineProperty_accessor` import (closure-wrapped
  // via `_maybeWrapCallable` / the unconditional `__call_fn_<n>` bridge, validated
  // by `_validatePropertyDescriptor`, written to the canonical sidecar slot
  // `_safeGet` / S1 `_readOwnDescriptor` / GOPD all consult). One write reconciles
  // every reader — the symmetric mirror the data-value path already emits via
  // `__defineProperty_value`.
  // (#2580 B-acc) A *canonical array-index* accessor key (e.g. "0", "1") on a
  // statically struct-typed array-like receiver must NOT be captured into the
  // compiled `${structName}_<idx>` accessor below: that fast path is reachable
  // ONLY from the NAMED read site (`compilePropertyAccess`'s `classAccessorSet`
  // dispatch), but an INDEXED element retrieval — exactly what the generic
  // `Array.prototype.X.call(arrayLike, cb)` cluster does — reads via
  // `__extern_get_idx` / `__extern_has_idx`, which consult the runtime sidecar
  // (`_wasmStructProps` / `_wasmStructAccessors`), never `classAccessorSet`. When
  // the index isn't an own struct field (`fieldIdx < 0`), the compiled accessor
  // is unreachable from BOTH read paths and the descriptor is silently dropped —
  // so `forEach.call({length:N}, cb)` after `Object.defineProperty(obj, "1",
  // {get/set})` never visits index 1 (verified per-process: index visit skipped).
  // Decline for that exact shape so it falls through to
  // `emitExternDefinePropertyNoValue` → `__defineProperty_accessor`, which mirrors
  // the accessor into the sidecar the indexed-read path DOES consult. Named-key
  // accessors (field OR non-field, e.g. `obj.computed`) are unchanged — they stay
  // on the compiled fast path that the named read resolves.
  const isCanonicalArrayIndexAccessorKey =
    propName !== undefined && fieldIdx < 0 && _isCanonicalArrayIndexString(propName);
  if (
    receiverIsStaticStruct &&
    !prototypeDescriptorTarget &&
    (getNode || setNode) &&
    !valueExpr &&
    structName &&
    structTypeIdx !== undefined &&
    propName &&
    !isCanonicalArrayIndexAccessorKey
  ) {
    // Compile obj and save to local
    const objType = compileExpression(ctx, fctx, objArg);
    if (!objType) return null;
    const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, objType);
    fctx.body.push({ op: "local.set", index: objLocal });
    emitObjectArgNullGuard(ctx, fctx, objLocal);

    const accessorKey = `${structName}_${propName}`;
    ctx.classAccessorSet.add(accessorKey);

    // (#2726 group (d)) Record a NON-configurable accessor key on an identifier
    // receiver. Per ES §6.2.5.6, an omitted `configurable` defaults to false, so
    // the accessor is non-configurable unless `configurable: true` was given.
    // This fast path doesn't mirror the flag into `_wasmPropDescs`, so the
    // struct-field `delete` site consults this set to refuse the delete
    // (OrdinaryDelete ⇒ false; strict ⇒ TypeError) — `__delete_property` alone
    // would wrongly report success.
    if (descConfigurable !== true && ts.isIdentifier(objArg)) {
      ctx.nonConfigurableAccessorKeys.add(`${objArg.text}:${propName}`);
    } else if (descConfigurable === true && ts.isIdentifier(objArg)) {
      // A later `configurable: true` redefine clears any earlier non-configurable
      // record for the same key (last-write-wins, mirroring runtime semantics).
      ctx.nonConfigurableAccessorKeys.delete(`${objArg.text}:${propName}`);
    }

    // (#3043) Record this accessor's descriptor flags in `definedPropertyFlags`
    // (the compile-time descriptor source-of-truth) and validate the transition
    // against any prior define for the same key. This fast path previously
    // recorded ONLY `nonConfigurableAccessorKeys`, so a subsequent attribute-only
    // redefine (routed through `emitExternDefinePropertyNoValue`) or a get/set
    // redefine saw no existing descriptor and silently accepted illegal
    // transitions on a non-configurable accessor (configurable false→true,
    // enumerable toggle, data↔accessor flip, get/set change) — 15.2.3.6-4-30 /
    // -252 / -312, 15.2.3.7-6-a-241. Only on an identifier receiver (the key
    // shape the flag maps use).
    // (#3043) HOST-lane only: recording an accessor key in `definedPropertyFlags`
    // routes standalone `hasOwnProperty` through the wasm-native `__hasOwnProperty`
    // helper (object-ops.ts ~4543), which does NOT report a defineProperty-added
    // struct-shape property as own → regresses the standalone accessor
    // hasOwnProperty case (#2726). The #3043 transition-validation cluster is the
    // JS-host default lane, so gate the record + check to host mode; standalone
    // keeps origin/main behaviour.
    if (!ctx.standalone && ts.isIdentifier(objArg)) {
      const dpKey = `${integrityVarKey(ctx, objArg)}:${propName}`; // (#3403) per-declaration key
      const existingFlags = ctx.definedPropertyFlags.get(dpKey);
      const newFlags = applyDescriptorFlags(existingFlags, descWritable, descEnumerable, descConfigurable, true, false);
      // On an illegal transition, RETURN immediately — emitting the compiled
      // getter/setter below would register a second accessor that clobbers the
      // still-live original (the define throws, so nothing must change).
      if (emitStaticDescriptorTransitionThrow(ctx, fctx, existingFlags, newFlags, true, !!(getNode || setNode))) {
        fctx.body.push({ op: "unreachable" });
        return objType;
      }
      ctx.definedPropertyFlags.set(dpKey, newFlags);
    }

    // (#1888 S5c / C2) STORE arm — land dark behind `S5C_STRUCT_ACCESSOR_CLOSURE`.
    // The #1629-S3 bare `${struct}_get/set_${prop}` fns below have NO capture
    // environment, so a getter/setter that closes over outer scope reads those
    // captures as 0 (sd-1888 root cause). Under standalone, additionally lift
    // each accessor as a host-free CLOSURE (captures baked into `$self` by
    // `compileArrowAsClosure`, `this` via `__current_this`) and store it in the
    // per-(struct,prop) `(mut externref)` module global. C3 (read) / C4 (write)
    // gate dispatch on `ctx.structAccessorClosure.has(key)` to route through the
    // S5b `__call_accessor_get/set` drivers; until those land the bare-fn path
    // below still serves reads, so this arm is additive + side-effect-free when
    // the flag is off. The `as unknown as ts.FunctionExpression` cast mirrors the
    // proven S5b `emitAccessorFn` call sites (object-ops.ts ~1945) — accessor
    // nodes (MethodDeclaration / Get/SetAccessorDeclaration) structurally satisfy
    // the `.body` / `.parameters` / `.modifiers` reads `compileArrowAsClosure`
    // performs.
    if (S5C_STRUCT_ACCESSOR_CLOSURE && ctx.standalone) {
      if (getNode) {
        const getGlobalIdx = ensureStructAccessorGlobal(ctx, structName, propName, "get");
        if (buildAccessorClosure(ctx, fctx, getNode as unknown as ts.FunctionExpression)) {
          fctx.body.push({ op: "global.set", index: getGlobalIdx });
        } else {
          // Lift failed — leave the global null; the bare-fn read path below
          // still serves this accessor, so no behavior regression.
          fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "global.set", index: getGlobalIdx });
        }
      }
      if (setNode) {
        const setGlobalIdx = ensureStructAccessorGlobal(ctx, structName, propName, "set");
        if (buildAccessorClosure(ctx, fctx, setNode as unknown as ts.FunctionExpression)) {
          fctx.body.push({ op: "global.set", index: setGlobalIdx });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "global.set", index: setGlobalIdx });
        }
      }
    }

    // (#2029 family A) Promote outer-fctx captures referenced by the
    // descriptor's get/set bodies BEFORE compiling the bare accessor fns
    // below. The object-literal accessor path (literals.ts) has always done
    // this; the defineProperty descriptor path never did — so a descriptor
    // getter like `get() { loadNextCount++; return next; }` compiled its body
    // in a fresh fctx with no way to reach the enclosing function's locals,
    // and materializing the nested fn `next`'s closure baked the enclosing
    // function's local slot into the accessor body (the
    // for-of/iterator-next-reference.js "local index out of range" emit
    // crash — BOTH modes). `promoteAccessorCapturesToGlobals` also promotes
    // the transitive captures of referenced nested functions (value global
    // for immutable, shared ref-cell box global for mutable). Placed AFTER
    // the S5c closure-lift arm so the standalone closure path keeps its
    // existing capture sourcing.
    const promoteDescriptorAccessorBody = (
      node:
        | ts.MethodDeclaration
        | ts.GetAccessorDeclaration
        | ts.SetAccessorDeclaration
        | ts.FunctionExpression
        | ts.ArrowFunction
        | undefined,
    ): void => {
      if (!node) return;
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        promoteAccessorCapturesToGlobals(ctx, fctx, undefined, [node.body]);
      } else if (node.body) {
        promoteAccessorCapturesToGlobals(ctx, fctx, node.body as ts.Block);
      }
    };
    promoteDescriptorAccessorBody(getNode);
    promoteDescriptorAccessorBody(setNode);

    // Helper to get body statements from a getter/setter node
    const getBodyStatements = (
      node:
        | ts.MethodDeclaration
        | ts.GetAccessorDeclaration
        | ts.SetAccessorDeclaration
        | ts.FunctionExpression
        | ts.ArrowFunction,
    ): ts.Statement[] => {
      if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
        // Arrow with expression body: wrap as return statement
        return [];
      }
      const body = ts.isArrowFunction(node) ? (node.body as ts.Block) : node.body;
      return body ? [...body.statements] : [];
    };

    // Helper to get parameters from a node
    const getParams = (
      node: ts.MethodDeclaration | ts.SetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction,
    ): readonly ts.ParameterDeclaration[] => {
      return node.parameters;
    };

    // Compile getter
    if (getNode) {
      const getterName = `${structName}_get_${propName}`;
      if (!ctx.funcMap.has(getterName)) {
        // Use ref_null so callers with nullable locals don't need ref.as_non_null
        const getterParams: ValType[] = [{ kind: "ref_null", typeIdx: structTypeIdx }];

        // Determine return type from the getter function signature
        const sig = ctx.checker.getSignatureFromDeclaration(getNode);
        let getterResults: ValType[] = [];
        if (sig) {
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          if (!isVoidType(retType)) {
            getterResults = [resolveWasmType(ctx, retType)];
          }
        }

        const getterTypeIdx = addFuncType(ctx, getterParams, getterResults, `${getterName}_type`);
        const getterFuncIdx = mintDefinedFunc(ctx);
        ctx.funcMap.set(getterName, getterFuncIdx);

        const getterFunc: WasmFunction = {
          name: getterName,
          typeIdx: getterTypeIdx,
          locals: [],
          body: [],
          exported: false,
        };
        pushDefinedFunc(ctx, getterFuncIdx, getterFunc);

        // Compile getter body
        const getterFctx: FunctionContext = {
          name: getterName,
          params: [{ name: "this", type: { kind: "ref_null", typeIdx: structTypeIdx } }],
          locals: [],
          localMap: new Map(),
          returnType: getterResults.length > 0 ? getterResults[0]! : null,
          body: [],
          blockDepth: 0,
          breakStack: [],
          continueStack: [],
          labelMap: new Map(),
          savedBodies: [],
        };
        getterFctx.localMap.set("this", 0);

        const savedFunc = ctx.currentFunc;
        if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
        if (savedFunc) ctx.funcStack.push(savedFunc);
        ctx.currentFunc = getterFctx;

        if (ts.isArrowFunction(getNode) && !ts.isBlock(getNode.body)) {
          // Arrow with expression body: compile as return expression
          const retType = compileExpression(
            ctx,
            getterFctx,
            getNode.body as ts.Expression,
            getterFctx.returnType ?? undefined,
          );
          if (retType && getterFctx.returnType && retType.kind !== getterFctx.returnType.kind) {
            coerceType(ctx, getterFctx, retType, getterFctx.returnType);
          }
        } else {
          const stmts = getBodyStatements(getNode);
          for (const stmt of stmts) {
            compileStatement(ctx, getterFctx, stmt);
          }
        }

        // Ensure valid return for non-void getters
        if (getterFctx.returnType) {
          const lastInstr = getterFctx.body[getterFctx.body.length - 1];
          if (!lastInstr || lastInstr.op !== "return") {
            if (getterFctx.returnType.kind === "f64") {
              getterFctx.body.push({ op: "f64.const", value: 0 });
            } else if (getterFctx.returnType.kind === "i32") {
              getterFctx.body.push({ op: "i32.const", value: 0 });
            } else if (getterFctx.returnType.kind === "externref") {
              getterFctx.body.push({ op: "ref.null.extern" });
            } else if (getterFctx.returnType.kind === "ref" || getterFctx.returnType.kind === "ref_null") {
              getterFctx.body.push({ op: "ref.null", typeIdx: getterFctx.returnType.typeIdx });
            }
          }
        }
        cacheStringLiterals(ctx, getterFctx);
        getterFunc.locals = getterFctx.locals;
        getterFunc.body = getterFctx.body;
        if (savedFunc) ctx.funcStack.pop();
        if (savedFunc) ctx.parentBodiesStack.pop();
        ctx.currentFunc = savedFunc;
      }
    }

    // Compile setter
    if (setNode) {
      const setterName = `${structName}_set_${propName}`;
      if (!ctx.funcMap.has(setterName)) {
        // Use ref_null so callers with nullable locals don't need ref.as_non_null
        const setterParams: ValType[] = [{ kind: "ref_null", typeIdx: structTypeIdx }];
        const allNodeParams = getParams(setNode);
        // Filter out the TS `this` parameter (explicit this type annotation)
        const nodeParams = allNodeParams.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === "this"));
        for (const param of nodeParams) {
          const paramType = ctx.checker.getTypeAtLocation(param);
          setterParams.push(resolveWasmType(ctx, paramType));
        }

        const setterTypeIdx = addFuncType(ctx, setterParams, [], `${setterName}_type`);
        const setterFuncIdx = mintDefinedFunc(ctx);
        ctx.funcMap.set(setterName, setterFuncIdx);

        const setterFunc: WasmFunction = {
          name: setterName,
          typeIdx: setterTypeIdx,
          locals: [],
          body: [],
          exported: false,
        };
        pushDefinedFunc(ctx, setterFuncIdx, setterFunc);

        // Compile setter body
        const setterFctxParams: { name: string; type: ValType }[] = [
          { name: "this", type: { kind: "ref_null", typeIdx: structTypeIdx } },
        ];
        for (let pi = 0; pi < nodeParams.length; pi++) {
          const param = nodeParams[pi]!;
          const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
          const paramType = ctx.checker.getTypeAtLocation(param);
          setterFctxParams.push({ name: paramName, type: resolveWasmType(ctx, paramType) });
        }

        const setterFctx: FunctionContext = {
          name: setterName,
          params: setterFctxParams,
          locals: [],
          localMap: new Map(),
          returnType: null,
          body: [],
          blockDepth: 0,
          breakStack: [],
          continueStack: [],
          labelMap: new Map(),
          savedBodies: [],
        };
        for (let i = 0; i < setterFctxParams.length; i++) {
          setterFctx.localMap.set(setterFctxParams[i]!.name, i);
        }

        const savedFunc = ctx.currentFunc;
        if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
        if (savedFunc) ctx.funcStack.push(savedFunc);
        ctx.currentFunc = setterFctx;

        if (ts.isArrowFunction(setNode) && !ts.isBlock(setNode.body)) {
          // Arrow with expression body: compile for side effects
          const retType = compileExpression(ctx, setterFctx, setNode.body as ts.Expression);
          if (retType) setterFctx.body.push({ op: "drop" });
        } else {
          const stmts = getBodyStatements(setNode as ts.MethodDeclaration);
          for (const stmt of stmts) {
            compileStatement(ctx, setterFctx, stmt);
          }
        }

        cacheStringLiterals(ctx, setterFctx);
        setterFunc.locals = setterFctx.locals;
        setterFunc.body = setterFctx.body;
        if (savedFunc) ctx.funcStack.pop();
        if (savedFunc) ctx.parentBodiesStack.pop();
        ctx.currentFunc = savedFunc;
      }
    }

    // Return obj
    fctx.body.push({ op: "local.get", index: objLocal });
    return objType;
  }

  if (valueExpr && useStruct) {
    // Struct path: Object.defineProperty(obj, "prop", { value: v }) → struct.set

    // Compile obj and save to local
    let objType = compileExpression(ctx, fctx, objArg);
    if (!objType) return null;

    // If obj is externref but we know it's a struct (e.g. `const obj: any = { x: 0 }`),
    // cast from externref to the struct ref type via any.convert_extern + guarded ref.cast.
    if (objType.kind === "externref" && structTypeIdx !== undefined) {
      fctx.body.push({ op: "any.convert_extern" });
      // Guard: ref.test before ref.cast to avoid illegal cast traps
      const tmpAny = allocTempLocal(fctx, { kind: "anyref" } as ValType);
      fctx.body.push({ op: "local.tee", index: tmpAny });
      fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "ref_null", typeIdx: structTypeIdx } as ValType },
        then: [
          { op: "local.get", index: tmpAny },
          { op: "ref.cast_null", typeIdx: structTypeIdx },
        ],
        else: [{ op: "ref.null", typeIdx: structTypeIdx }],
      });
      releaseTempLocal(fctx, tmpAny);
      objType = { kind: "ref_null", typeIdx: structTypeIdx };
    }

    const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, objType);
    fctx.body.push({ op: "local.set", index: objLocal });
    emitObjectArgNullGuard(ctx, fctx, objLocal);

    // ── Compile-time flag checking for struct path ──
    // Save existing flags BEFORE updating (needed for value comparison below)
    let priorExistingFlags: number | undefined;
    const isKnownExistingField = structTypeIdx !== undefined && fields && fieldIdx >= 0;
    let appliedStructFlags = applyDescriptorFlags(
      isKnownExistingField ? PROP_FLAGS_DEFAULT_DATA : undefined,
      descWritable,
      descEnumerable,
      descConfigurable,
      false,
      true,
    );
    if (propName) {
      const varName = ts.isIdentifier(objArg) ? integrityVarKey(ctx, objArg) : undefined; // (#3403) per-declaration key
      if (varName) {
        const isAccessor = !!(getNode || setNode);
        const key = `${varName}:${propName}`;
        const trackedExistingFlags = ctx.definedPropertyFlags.get(key);
        const isDefinePropertyWidenedField = ctx.widenedDefinePropertyKeys.has(key);
        const currentFlags =
          trackedExistingFlags ??
          (isKnownExistingField && !isDefinePropertyWidenedField ? PROP_FLAGS_DEFAULT_DATA : undefined);
        const newFlags = applyDescriptorFlags(
          currentFlags,
          descWritable,
          descEnumerable,
          descConfigurable,
          isAccessor,
          descWritable !== undefined,
        );
        appliedStructFlags = newFlags;
        priorExistingFlags = currentFlags;

        // Check non-extensibility — but only for genuinely new properties.
        // If the property is a known struct field (fieldIdx >= 0), it already
        // exists on the object, so redefining it is not "adding a new property".
        if (ctx.nonExtensibleVars.has(varName) && currentFlags === undefined) {
          emitThrowTypeError(ctx, fctx, "Cannot define property, object is not extensible");
        }

        // Check existing flags
        const existingFlags = currentFlags;
        if (existingFlags !== undefined) {
          const isExistingConfigurable = !!(existingFlags & PROP_FLAG_CONFIGURABLE);
          if (!isExistingConfigurable) {
            // Non-configurable: check for violations
            if (newFlags & PROP_FLAG_CONFIGURABLE) {
              emitThrowTypeError(ctx, fctx, "Cannot redefine property");
            }
            const existingEnumerable = existingFlags & PROP_FLAG_ENUMERABLE;
            const newEnumerable = newFlags & PROP_FLAG_ENUMERABLE;
            if (existingEnumerable !== newEnumerable) {
              emitThrowTypeError(ctx, fctx, "Cannot redefine property");
            }
            // Data property writable checks
            if (!(existingFlags & PROP_FLAG_ACCESSOR) && !isAccessor) {
              if (!(existingFlags & PROP_FLAG_WRITABLE)) {
                if (newFlags & PROP_FLAG_WRITABLE) {
                  // Cannot change writable from false to true on non-configurable
                  emitThrowTypeError(ctx, fctx, "Cannot redefine property");
                }
              }
            }
            // Cannot change data<->accessor on non-configurable
            if (isAccessor && !(existingFlags & PROP_FLAG_ACCESSOR)) {
              emitThrowTypeError(ctx, fctx, "Cannot redefine property");
            }
            if (!isAccessor && existingFlags & PROP_FLAG_ACCESSOR) {
              emitThrowTypeError(ctx, fctx, "Cannot redefine property");
            }
          }
        }

        // Record the new flags
        ctx.definedPropertyFlags.set(key, newFlags);
        // (#3872) Parallel record for the assignment-path consult — struct arm.
        // Explicit `writable:false` only; see recordExplicitNonWritable.
        recordExplicitNonWritable(ctx, objArg, propName, descWritable, getNode, setNode);

        // Update shapePropFlags so getOwnPropertyDescriptor sees updated attributes
        if (structTypeIdx !== undefined && fields) {
          const userFieldsList = fields
            .map((f, idx) => ({ field: f, fieldIdx: idx }))
            .filter((e) => !e.field.name.startsWith("__"));
          const userIdx = userFieldsList.findIndex((e) => e.field.name === propName);
          if (userIdx >= 0) {
            const flagsArr = ctx.shapePropFlags.get(structTypeIdx);
            if (flagsArr && userIdx < flagsArr.length) {
              flagsArr[userIdx] = newFlags & 0x07; // Only store WEC bits
            }
          }
        }
      }
    }

    // Compile remaining descriptor properties for side effects (before value)
    for (const prop of (descArg as ts.ObjectLiteralExpression).properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") continue;
      if (ts.isPropertyAssignment(prop)) {
        const sideType = compileExpression(ctx, fctx, prop.initializer);
        if (sideType) fctx.body.push({ op: "drop" });
      }
    }

    // Check if this property is non-writable non-configurable (needs runtime value comparison)
    // Uses priorExistingFlags captured BEFORE the current call updated the map.
    // Also: if the object is frozen, ALL data properties are non-writable non-configurable,
    // even if they weren't explicitly set via defineProperty (i.e. original struct fields).
    const varName2 = ts.isIdentifier(objArg) ? integrityVarKey(ctx, objArg) : undefined; // (#3403) per-declaration key
    const isFrozenProperty = varName2 !== undefined && ctx.frozenVars.has(varName2) && isKnownExistingField;
    const shouldStoreDescriptorDefaults =
      varName2 !== undefined &&
      propName !== undefined &&
      ctx.widenedDefinePropertyKeys.has(`${varName2}:${propName}`) &&
      priorExistingFlags === undefined;
    const needsValueCompare =
      isFrozenProperty ||
      (priorExistingFlags !== undefined &&
        !(priorExistingFlags & PROP_FLAG_CONFIGURABLE) &&
        !(priorExistingFlags & PROP_FLAG_WRITABLE) &&
        !(priorExistingFlags & PROP_FLAG_ACCESSOR));

    // Emit struct.set: push obj, then value, then struct.set
    const fieldType = fields![fieldIdx]!.type;

    if (needsValueCompare) {
      // Save old value for comparison
      const oldValLocal = allocLocal(fctx, `__defprop_oldval_${fctx.locals.length}`, fieldType);
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx!, fieldIdx });
      fctx.body.push({ op: "local.set", index: oldValLocal });

      // Compile new value into temp local
      const newValLocal = allocLocal(fctx, `__defprop_newval_${fctx.locals.length}`, fieldType);
      const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
      if (!valType) {
        fctx.body.push({ op: "local.get", index: objLocal });
        return objType;
      }
      if (valType.kind !== fieldType.kind) {
        coerceType(ctx, fctx, valType, fieldType);
      }
      fctx.body.push({ op: "local.set", index: newValLocal });

      // Compare old and new values. If different, throw TypeError.
      // Use SameValue semantics (for f64: need to handle NaN === NaN, +0 !== -0)
      //
      // (#2042 S4 call-site) Build the throw as a real catchable TypeError
      // INSTANCE via the body-swap pattern (mirrors buildTemporalThrowInstrs in
      // temporal-native.ts). #2515 S0 already made the message push sentinel-safe
      // (`stringConstantExternrefInstrs` instead of `global.get -1`), fixing the
      // `global index out of range — -1` emit error on a double value-define under
      // nativeStrings. But it still threw a BARE STRING, so `assert.throws(
      // TypeError, …)` (test262 verifyProperty) never matched. Routing through
      // `emitThrowTypeError` keeps the sentinel-safe inline `$NativeString` message
      // AND wraps it in the in-module `__new_TypeError`, so the thrown value is a
      // real catchable TypeError instance in BOTH modes (§10.1.6.3).
      const throwRedefineInstrs = ((): Instr[] => {
        const saved = fctx.body;
        const out: Instr[] = [];
        fctx.body = out;
        try {
          emitThrowTypeError(ctx, fctx, "Cannot redefine property");
        } finally {
          fctx.body = saved;
        }
        return out;
      })();

      if (fieldType.kind === "f64") {
        // f64 comparison using SameValue semantics (ECMA-262 §7.2.10):
        //   SameValue(x, y) = (x == y && copysign(1,x) == copysign(1,y)) || (x != x && y != y)
        // This correctly handles: SameValue(NaN, NaN) = true, SameValue(+0, -0) = false.
        //
        // f64.copysign(x, y) returns x with the sign of y. To extract the
        // SIGN of a value (without its magnitude) we need copysign(1, value).
        // In Wasm stack order, that's: push 1, then push value, then copysign
        // pops y=value first and x=1 second. The previous version had the
        // pushes reversed, computing copysign(value, 1) = abs(value), which
        // collapsed `+0` and `-0` to the same sign and silently allowed
        // `Object.defineProperty(obj, "x", { value: -0 })` on a frozen +0.
        const compareBody: Instr[] = throwRedefineInstrs;
        // Part 1: (old == new) && (copysign(1,old) == copysign(1,new))
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "f64.eq" });
        fctx.body.push({ op: "f64.const", value: 1.0 });
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "f64.copysign" });
        fctx.body.push({ op: "f64.const", value: 1.0 });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "f64.copysign" });
        fctx.body.push({ op: "f64.eq" });
        fctx.body.push({ op: "i32.and" });
        // Part 2: (old != old) && (new != new)  — both NaN
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({ op: "i32.and" });
        // SameValue = part1 || part2
        fctx.body.push({ op: "i32.or" });
        // If NOT SameValue → throw TypeError
        fctx.body.push({ op: "i32.eqz" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: compareBody,
        });
      } else if (fieldType.kind === "i32") {
        const compareBody: Instr[] = throwRedefineInstrs;
        fctx.body.push({ op: "local.get", index: oldValLocal });
        fctx.body.push({ op: "local.get", index: newValLocal });
        fctx.body.push({ op: "i32.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: compareBody,
        });
      }
      // For externref/ref types, skip value comparison (would need reference equality)

      // Do the struct.set with the new value
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "local.get", index: newValLocal });
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx!, fieldIdx });
    } else {
      fctx.body.push({ op: "local.get", index: objLocal });
      const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
      if (!valType) {
        // Drop the obj ref we just pushed
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "local.get", index: objLocal });
        return objType;
      }
      if (valType.kind !== fieldType.kind) {
        coerceType(ctx, fctx, valType, fieldType);
      }
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx!, fieldIdx });
    }

    // (#1460 R1) Register attribute flags in the runtime sidecar
    // (`_wasmPropDescs`) when any of writable/enumerable/configurable is
    // specified. We pass the raw struct obj through `extern.convert_any` so the
    // host import sees the same externref identity used by every other sidecar
    // lookup. Value bit (1<<7) is left unset so the host doesn't overwrite the
    // value we just struct.set above.
    if (anyFlagSpecified || shouldStoreDescriptorDefaults) {
      fctx.body.push({ op: "local.get", index: objLocal });
      if (objType.kind === "ref" || objType.kind === "ref_null") {
        fctx.body.push({ op: "extern.convert_any" });
      } else if (objType.kind !== "externref") {
        coerceType(ctx, fctx, objType, { kind: "externref" });
      }
      // prop key
      const sePropType = compileExpression(ctx, fctx, propArg, { kind: "externref" });
      if (sePropType && sePropType.kind !== "externref") {
        coerceType(ctx, fctx, sePropType, { kind: "externref" });
      }
      // null value (hasValue=false ensures runtime won't overwrite struct.set)
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({
        op: "f64.const",
        value: (1 << 3) | (1 << 4) | (1 << 5) | (appliedStructFlags & 0x07),
      });
      const sideFuncIdx = ensureLateImport(
        ctx,
        "__defineProperty_value",
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (sideFuncIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: sideFuncIdx });
        fctx.body.push({ op: "drop" }); // discard returned obj
      }
    }

    // Return obj
    fctx.body.push({ op: "local.get", index: objLocal });
    return objType;
  } else if (valueExpr) {
    // (#3872) Record a NON-WRITABLE define on the EXTERNREF path.
    //
    // `definedPropertyFlags` is written only in the `useStruct` branch above,
    // which needs a registered struct field. Standalone compiles
    // `const o: any = {}` to a native `$Object`, so `fieldIdx < 0`, `useStruct`
    // is false, and nothing was recorded — which is why the #3872 write-consult
    // fired on host and never on standalone (instrumented: host
    // `{"o@41:p": 14}` vs standalone `[]`).
    //
    // This deliberately records into a DEDICATED set, not into
    // `definedPropertyFlags`. An earlier revision wrote the full descriptor into
    // that map and caused a merged-state regression of −67 pass that every
    // PR-level check passed: `builtin-static-gopd.ts` treats a present entry as
    // an OVERRIDE of the shape table (`if (dpf !== undefined) flags = dpf & 0x0f`),
    // so recording here changed what `getOwnPropertyDescriptor` reports for
    // EVERY externref-receiver define — and reported `enumerable:false,
    // configurable:false` for a REDEFINE, where omitted attributes must mean
    // "keep existing" rather than "default to false".
    //
    // The lesson, since the original reasoning looked sound: it is not enough to
    // check that the writer can't observe its own record. Enumerate every READER
    // of a shared mutable structure before writing to it. `definedPropertyFlags`
    // has four (`builtin-static-gopd.ts`, `property-access.ts`, and the
    // program-order snapshot/restore in `declarations.ts` / `index.ts`); only one
    // had been considered.
    //
    // Recorded only when the descriptor states `writable` EXPLICITLY — with it
    // omitted the intent is ambiguous between a fresh define (defaults false)
    // and a redefine (keep existing), and the externref arm has no
    // `isKnownExistingField` to tell them apart. Every corpus row for this issue
    // states `writable:false` explicitly, so the narrower rule costs no coverage.
    recordExplicitNonWritable(ctx, objArg, propName, descWritable, getNode, setNode);
    // Externref path: Object.defineProperty(obj, prop, { value: v }) → __defineProperty_value
    return emitExternDefinePropertyValue(
      ctx,
      fctx,
      objArg,
      propArg,
      descArg,
      valueExpr,
      descWritable,
      descEnumerable,
      descConfigurable,
    );
  } else {
    // (#3872) Third and last lowering arm. `Object.defineProperty(o,"b",
    // {writable:false})` — explicit, but with NO `value` — lands here rather
    // than in either arm above, so it needs its own record or the consult never
    // sees it (`language/types/reference/8.7.2-3-s.js`).
    recordExplicitNonWritable(ctx, objArg, propName, descWritable, getNode, setNode);
    // No value property or descriptor is not an object literal:
    // For externref objects, delegate to __defineProperty_value with no-value flag
    return emitExternDefinePropertyNoValue(
      ctx,
      fctx,
      objArg,
      propArg,
      descArg,
      descWritable,
      descEnumerable,
      descConfigurable,
      getNode,
      setNode,
      getExpr,
      setExpr,
      getExplicitUndefined,
      setExplicitUndefined,
    );
  }
}

// ── __defineProperty_value runtime flag encoding ──────────────────────
//   bit 0: writable          bit 3: writable specified
//   bit 1: enumerable        bit 4: enumerable specified
//   bit 2: configurable      bit 5: configurable specified
//   bit 6: is accessor       bit 7: has value

function computeRuntimeFlags(
  descWritable: boolean | undefined,
  descEnumerable: boolean | undefined,
  descConfigurable: boolean | undefined,
  hasValue: boolean,
): number {
  let flags = 0;
  if (descWritable !== undefined) {
    flags |= 1 << 3; // writable specified
    if (descWritable) flags |= 1;
  }
  if (descEnumerable !== undefined) {
    flags |= 1 << 4; // enumerable specified
    if (descEnumerable) flags |= 1 << 1;
  }
  if (descConfigurable !== undefined) {
    flags |= 1 << 5; // configurable specified
    if (descConfigurable) flags |= 1 << 2;
  }
  if (hasValue) flags |= 1 << 7;
  return flags;
}

function resolveKnownStructProperty(
  ctx: CodegenContext,
  objArg: ts.Expression,
  propArg: ts.Expression,
): { isKnown: boolean; structName: string | undefined; propName: string | undefined } {
  const objTsType = ctx.checker.getTypeAtLocation(objArg);
  const staticStructName = resolveStructName(ctx, objTsType);
  const structName = staticStructName || (ts.isIdentifier(objArg) ? widenedStructNameForUse(ctx, objArg) : undefined);
  const propName = ts.isStringLiteral(propArg) ? propArg.text : undefined;
  const structTypeIdx = structName ? ctx.structMap.get(structName) : undefined;
  const fields = structName ? ctx.structFields.get(structName) : undefined;
  const fieldIdx = fields && propName ? fields.findIndex((field) => field.name === propName) : -1;
  return {
    isKnown: staticStructName !== undefined && structTypeIdx !== undefined && fields !== undefined && fieldIdx >= 0,
    structName,
    propName,
  };
}

/**
 * Extract any dynamic-flag expressions (non-constant-foldable) from a descriptor
 * object literal. The compiler converts each to runtime `__to_boolean` calls so
 * that `Object.defineProperty(obj, k, { configurable: -12345 })` ToBoolean-coerces
 * per ES §6.2.5.6 step 5.b (#1460 R1).
 */
function extractDynamicFlagExprs(descArg: ts.Expression): {
  writableDyn?: ts.Expression;
  enumerableDyn?: ts.Expression;
  configurableDyn?: ts.Expression;
} {
  const out: {
    writableDyn?: ts.Expression;
    enumerableDyn?: ts.Expression;
    configurableDyn?: ts.Expression;
  } = {};
  if (!ts.isObjectLiteralExpression(descArg)) return out;
  for (const prop of descArg.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const folded = tryConstantFoldToBoolean(prop.initializer);
    if (folded !== undefined) continue;
    if (prop.name.text === "writable") out.writableDyn = prop.initializer;
    else if (prop.name.text === "enumerable") out.enumerableDyn = prop.initializer;
    else if (prop.name.text === "configurable") out.configurableDyn = prop.initializer;
  }
  return out;
}

/**
 * Emit code that pushes the runtime flag bitword as an f64 onto the stack.
 *
 * Static base: encode constant-foldable flags via `computeRuntimeFlags`.
 * Dynamic adds: for each non-constant-foldable flag, compile the expression as
 * externref, call `__to_boolean` (i32), shift to the value bit position, and
 * OR with the running accumulator. The "specified" bit for each dynamic flag
 * is included in the static base (the attribute IS supplied; only the bool
 * value is computed at runtime).
 *
 * Stack effect: pushes 1 value (f64).
 */
function emitRuntimeFlagsF64(
  ctx: CodegenContext,
  fctx: FunctionContext,
  descWritable: boolean | undefined,
  descEnumerable: boolean | undefined,
  descConfigurable: boolean | undefined,
  hasValue: boolean,
  writableDyn: ts.Expression | undefined,
  enumerableDyn: ts.Expression | undefined,
  configurableDyn: ts.Expression | undefined,
  // (#2992 S3) extra static bits OR'd into the flag word — the accessor
  // [[Get]]/[[Set]] "specified" bits 8/9. Callers pass 0 (default) everywhere
  // the encoding must stay byte-identical.
  extraStaticBits = 0,
): void {
  const hasDynamic = writableDyn !== undefined || enumerableDyn !== undefined || configurableDyn !== undefined;
  if (!hasDynamic) {
    const flags = computeRuntimeFlags(descWritable, descEnumerable, descConfigurable, hasValue) | extraStaticBits;
    fctx.body.push({ op: "f64.const", value: flags });
    return;
  }
  // Static base includes:
  //   - bit 7 (hasValue)
  //   - bit 3/4/5 (specified) for all dynamic flags
  //   - bit 3/4/5 (specified) + value bit for any statically-folded flags
  let staticBase = extraStaticBits;
  if (hasValue) staticBase |= 1 << 7;
  if (descWritable !== undefined) {
    staticBase |= 1 << 3;
    if (descWritable) staticBase |= 1;
  } else if (writableDyn !== undefined) {
    staticBase |= 1 << 3;
  }
  if (descEnumerable !== undefined) {
    staticBase |= 1 << 4;
    if (descEnumerable) staticBase |= 1 << 1;
  } else if (enumerableDyn !== undefined) {
    staticBase |= 1 << 4;
  }
  if (descConfigurable !== undefined) {
    staticBase |= 1 << 5;
    if (descConfigurable) staticBase |= 1 << 2;
  } else if (configurableDyn !== undefined) {
    staticBase |= 1 << 5;
  }
  // Push static base as i32
  fctx.body.push({ op: "i32.const", value: staticBase });

  // (#2915) ToBoolean-coerce each dynamic descriptor attribute. In standalone
  // mode use the NATIVE `__is_truthy` union helper (a real Wasm body — walks the
  // same boxed-value structs `__box_number`/`__box_boolean`/`$BigInt`/`$AnyString`
  // and treats any other non-null ref, e.g. a `new Boolean(false)` $Object
  // wrapper, as truthy per ES §7.1.2) instead of the `__to_boolean` HOST import,
  // which has no native body and therefore leaks an `env::__to_boolean` import
  // that keeps otherwise-passing defineProperty/defineProperties/Boolean tests
  // host-dependent. `__is_truthy` is strictly ≥ `__to_boolean` in spec-fidelity
  // here (the host import, seeing an opaque WasmGC ref, can only answer
  // "non-null → truthy"), so every leaky-PASS converts 1:1 host-free with no
  // behaviour change. Gated on `ctx.standalone` so the GC/host lane emits the
  // byte-identical `__to_boolean` sequence it always did.
  const useNativeTruthy = ctx.standalone;
  if (useNativeTruthy) addUnionImports(ctx);
  const toBoolIdx = ensureLateImport(
    ctx,
    useNativeTruthy ? "__is_truthy" : "__to_boolean",
    [{ kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);

  const emitDyn = (expr: ts.Expression, valueBitShift: number): void => {
    // Compile expr → externref
    const t = compileExpression(ctx, fctx, expr, { kind: "externref" });
    if (t && t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
    if (toBoolIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: toBoolIdx });
    } else {
      // Defensive: __to_boolean import is built-in to the runtime, this should not happen.
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
    }
    if (valueBitShift > 0) {
      fctx.body.push({ op: "i32.const", value: valueBitShift });
      fctx.body.push({ op: "i32.shl" });
    }
    fctx.body.push({ op: "i32.or" });
  };
  if (writableDyn !== undefined) emitDyn(writableDyn, 0); // bit 0
  if (enumerableDyn !== undefined) emitDyn(enumerableDyn, 1); // bit 1
  if (configurableDyn !== undefined) emitDyn(configurableDyn, 2); // bit 2

  // Convert i32 → f64 for the f64-typed flags parameter
  fctx.body.push({ op: "f64.convert_i32_s" });
}

/**
 * #2042 PR-A — ToPropertyKey the `Object.defineProperty` key in standalone mode.
 *
 * The standalone `$Object` runtime is string-keyed: `__obj_insert` /
 * `__defineProperty_value` / `__defineProperty_accessor` all `ref.cast
 * $AnyString` the incoming key. The defineProperty call sites compile the key
 * with the `{ externref }` hint, which boxes a *number* literal
 * (`Object.defineProperty(o, 0, …)`) as a boxed-number externref rather than a
 * string — that boxed number then traps `illegal cast` in `__obj_insert`.
 *
 * `__extern_toString` (host import in JS mode, native runtime helper in
 * standalone) maps any externref through ToString — numeric keys become their
 * canonical decimal ("0", "1.5"), matching how `{0:x}` / `obj[0]=x` store the
 * key. It is idempotent on strings, so string keys pass through unchanged.
 *
 * Expects the key externref on top of the stack; leaves a $AnyString externref.
 * Gated on `ctx.standalone`: in host mode `__defineProperty_value` is a JS
 * import that ToPropertyKeys the key itself (and correctly preserves Symbol
 * keys, which a pre-emptive ToString would alias) — so host output stays
 * byte-identical. Symbol keys in standalone are out of scope for Part A; the
 * string-keyed runtime cannot represent them, and ToString-ing one would alias
 * `Symbol("x")` to `"Symbol(x)"` — but the `15.2.3.6-4-*` illegal-cast rows are
 * numeric, not symbol, so the bulk is fixed here.
 */
function emitStandaloneDefinePropertyKeyToString(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!ctx.standalone) return;
  const toStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  const finalIdx = ctx.funcMap.get("__extern_toString") ?? toStrIdx;
  if (finalIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalIdx });
}

/**
 * Emit __defineProperty_value(obj, prop, value, flags) for the externref value path.
 */
function emitExternDefinePropertyValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objArg: ts.Expression,
  propArg: ts.Expression,
  descArg: ts.Expression,
  valueExpr: ts.Expression,
  descWritable: boolean | undefined,
  descEnumerable: boolean | undefined,
  descConfigurable: boolean | undefined,
): ValType | null {
  markRuntimeDefinedProperty(ctx, objArg, propArg);

  // Compile obj WITHOUT externref hint to get the raw Wasm type.
  // For vec structs (e.g. string[], number[]) coerceType would call __make_iterable,
  // which creates a NEW JS array on every call — breaking sidecar property descriptor
  // storage (WeakMap keys on different objects each time). We emit extern.convert_any
  // directly to get a stable externref identity for the WasmGC struct (#856).
  const objType = compileExpression(ctx, fctx, objArg);
  if (!objType) return null;
  if (objType.kind === "ref" || objType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  } else if (objType.kind !== "externref") {
    coerceType(ctx, fctx, objType, { kind: "externref" });
  }
  const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // ES spec 19.1.2.4 step 1: throw TypeError if first arg is null/undefined (standalone mode)
  emitObjectArgNullGuard(ctx, fctx, objLocal);

  // Compile prop key as externref
  const propType = compileExpression(ctx, fctx, propArg, { kind: "externref" });
  if (!propType) {
    fctx.body.push({ op: "local.get", index: objLocal });
    return { kind: "externref" };
  }
  if (propType.kind !== "externref") {
    coerceType(ctx, fctx, propType, { kind: "externref" });
  }
  // #2042 PR-A: in standalone mode the `$Object` table is string-keyed and
  // `__obj_insert` does `ref.cast $AnyString` on the key. A non-string key —
  // `Object.defineProperty(o, 0, …)` boxes `0` as a number externref — traps
  // `illegal cast`. ToPropertyKey (ToString for everything but Symbols) it here
  // so the value handed to `__defineProperty_value` is always a $AnyString. In
  // host mode `__defineProperty_value` is a JS import that ToPropertyKeys
  // itself (and would mishandle a pre-stringified Symbol), so gate on standalone.
  emitStandaloneDefinePropertyKeyToString(ctx, fctx);
  const propLocal = allocLocal(fctx, `__defprop_key_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: propLocal });

  // Compile value as externref
  const valType = compileExpression(ctx, fctx, valueExpr, { kind: "externref" });
  if (!valType) {
    fctx.body.push({ op: "local.get", index: objLocal });
    return { kind: "externref" };
  }
  if (valType.kind !== "externref") {
    coerceType(ctx, fctx, valType, { kind: "externref" });
  }
  const valLocal = allocLocal(fctx, `__defprop_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valLocal });

  // Compile remaining descriptor properties for side effects
  if (ts.isObjectLiteralExpression(descArg)) {
    for (const prop of descArg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") continue;
      // Skip flag properties (writable, enumerable, configurable) — handled via flags param
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        (prop.name.text === "writable" || prop.name.text === "enumerable" || prop.name.text === "configurable")
      )
        continue;
      if (ts.isPropertyAssignment(prop)) {
        const sideType = compileExpression(ctx, fctx, prop.initializer);
        if (sideType) fctx.body.push({ op: "drop" });
      }
    }
  }

  // Compute runtime flags (#1460 R1: ToBoolean coercion on dynamic flag exprs)
  const { writableDyn, enumerableDyn, configurableDyn } = extractDynamicFlagExprs(descArg);

  // Push args: obj, key, val, flags and call __defineProperty_value
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: propLocal });
  fctx.body.push({ op: "local.get", index: valLocal });
  emitRuntimeFlagsF64(
    ctx,
    fctx,
    descWritable,
    descEnumerable,
    descConfigurable,
    true,
    writableDyn,
    enumerableDyn,
    configurableDyn,
  );

  const funcIdx = ensureLateImport(
    ctx,
    "__defineProperty_value",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (funcIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx });
    emitDefinePropertyRejectionThrow(ctx, fctx);
  }

  // __defineProperty_value returns obj, so we're done
  return { kind: "externref" };
}

/**
 * (#3177 slice 4) §20.1.2.4 step 3: `Object.defineProperty` throws TypeError
 * when [[DefineOwnProperty]] returns false. The standalone dyn-view arms in
 * `__defineProperty_value`/`_accessor` signal that false with a
 * `ref.null.extern` SENTINEL (every ordinary path returns the input obj, and
 * a null/undefined obj already threw in `emitObjectArgNullGuard` — so a null
 * result can ONLY be the rejection sentinel). Reflect.defineProperty keeps
 * its own consumption (`__is_truthy` → spec `false`) and is NOT routed here.
 * Standalone-only: the host-lane import returns the JS object, never null.
 * Leaves the (non-null) result on the stack.
 */
function emitDefinePropertyRejectionThrow(ctx: CodegenContext, fctx: FunctionContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  const resLocal = allocLocal(fctx, `__defprop_res_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.tee", index: resLocal });
  fctx.body.push({ op: "ref.is_null" });
  const throwInstrs = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "Cannot define property, object is not extensible or index is invalid",
    {
      flush: fctx,
    },
  );
  // Stack: `local.tee` kept the copy in the local, `ref.is_null` consumed the
  // stack copy — re-read the local for the caller.
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: [] });
  fctx.body.push({ op: "local.get", index: resLocal });
}

/**
 * Resolve an expression to its underlying function AST node for use with compileArrowAsCallback.
 * For `get: identifierRef` / `set: identifierRef`, looks up the TS symbol and returns the
 * function declaration or function expression at the declaration site.
 * Returns undefined if the expression does not resolve to a compilable function node.
 */
function resolveExprToFuncNode(
  ctx: CodegenContext,
  expr: ts.Expression,
): ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined {
  const sym = ctx.checker.getSymbolAtLocation(expr);
  if (!sym) return undefined;
  const decl = sym.valueDeclaration;
  if (!decl) return undefined;
  // Direct function declaration: function getFunc() { ... }
  if (ts.isFunctionDeclaration(decl)) return decl;
  // Variable: var setFunc = function(v) { ... } or var setFunc = (v) => ...
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = decl.initializer;
    if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return init;
  }
  return undefined;
}

/**
 * (#1888 S5b) Compile an accessor getter/setter function and leave an externref
 * on the stack to pass into `__defineProperty_accessor`. Returns `true` when a
 * value was pushed, `false` when the caller should push `ref.null.extern`.
 *
 * Dual-mode:
 *  - **standalone** (`ctx.standalone`): compile the function as a HOST-FREE
 *    closure (`compileArrowAsClosure`) and convert the closure-struct ref →
 *    externref. This is what makes the stored `$PropEntry.$get/$set` slot hold a
 *    real callable closure that the native accessor arms in `__extern_get`/
 *    `__extern_set` can dispatch through `__call_accessor_get/set` →
 *    `__call_fn_method_0/1` (which threads the receiver as `this` via
 *    `__current_this`, #1636-S1). The lifted closure body sets
 *    `readsCurrentThis: true`, so `this` inside the getter/setter resolves to the
 *    installed receiver per §6.2.5.5 / §10.1.5.3.
 *  - **JS-host / GC** (default): unchanged — `compileArrowAsCallback` with
 *    `needsThis: true` routes through the `__make_getter_callback` JS bridge.
 *    Gating strictly on `ctx.standalone` keeps the host/GC binary byte-identical.
 */
function emitAccessorFn(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fn: ts.FunctionExpression | ts.ArrowFunction,
): boolean {
  if (ctx.standalone) {
    const closureType = compileArrowAsClosure(ctx, fctx, fn);
    if (!closureType) return false;
    // compileArrowAsClosure leaves a closure-struct ref; __defineProperty_accessor
    // expects externref. Convert unless it is already externref.
    if (closureType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    return true;
  }
  return !!compileArrowAsCallback(ctx, fctx, fn, { needsThis: true });
}

/**
 * (#2668 Slice B) Emit the externref operand for an *identifier-reference*
 * accessor half (`{ get: fnRef }` / `{ set: fnRef }`) so the value stored in the
 * descriptor preserves the user's ORIGINAL function identity.
 *
 * The legacy path resolved `fnRef` back to its function *declaration* and
 * re-synthesized a FRESH closure via {@link emitAccessorFn}. That fresh closure
 * is a different object than the value the user holds, so
 * `Object.getOwnPropertyDescriptor(o, k).get === fnRef` failed (the largest
 * remaining accessor-descriptor bucket) — even though the getter *worked*.
 *
 * Instead, compile the reference expression directly to push the user's actual
 * function value (a stable closure — function-reference identity is preserved
 * across multiple references in this compiler). The runtime
 * `__defineProperty_accessor` wraps it for native invocation, and
 * `_hostEqComparableValue` unwraps that wrapper back to this same closure on the
 * `===`/`!==` compare — so identity round-trips. Invocation is unaffected: the
 * wrapper dispatches through `__call_fn_method_0/1`, threading the receiver as
 * `this` (a strict improvement over the captureless re-synthesized fn).
 *
 * Host mode only. Under `ctx.standalone` the descriptor stores a host-free
 * closure that the native accessor arms dispatch through, so keep the existing
 * {@link emitAccessorFn} path there (byte-identical standalone output).
 *
 * Returns `true` when a value was pushed; `false` when the caller should push
 * `ref.null.extern`.
 */
function emitAccessorRefValue(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): boolean {
  if (ctx.standalone) {
    // (#2992 S3) `get: someIdentifier` — compile the identifier's VALUE (the
    // live host-free closure) instead of re-synthesizing a fresh closure from
    // its AST. The re-synthesis lost function identity: gOPD read back a
    // DIFFERENT function object, so `desc.get === getFunc` was always false
    // (15.2.3.6-4-* accessor fidelity family). A closure value is directly
    // invocable by the accessor get/set drivers (#1636-S1), verified via the
    // dynamic-descriptor path which has always stored raw values. Non-
    // identifier shapes keep the AST fallback.
    if (ts.isIdentifier(expr)) {
      const t = compileExpression(ctx, fctx, expr, { kind: "externref" });
      if (t) {
        if (t.kind === "ref" || t.kind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" });
        } else if (t.kind !== "externref") {
          coerceType(ctx, fctx, t, { kind: "externref" });
        }
        return true;
      }
      return false;
    }
    const funcNode = resolveExprToFuncNode(ctx, expr);
    if (!funcNode) return false;
    return emitAccessorFn(ctx, fctx, funcNode as unknown as ts.FunctionExpression);
  }
  const t = compileExpression(ctx, fctx, expr, { kind: "externref" });
  if (!t) return false;
  if (t.kind === "ref" || t.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  } else if (t.kind !== "externref") {
    coerceType(ctx, fctx, t, { kind: "externref" });
  }
  return true;
}

/**
 * Emit __defineProperty_value(obj, prop, null, flags) for descriptors without a value property.
 * For externref objects, this delegates to the JS host which can handle flag-only descriptors.
 * For struct-typed objects, this is a no-op (struct fields are always writable).
 */
function emitExternDefinePropertyNoValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objArg: ts.Expression,
  propArg: ts.Expression,
  descArg: ts.Expression,
  descWritable: boolean | undefined,
  descEnumerable: boolean | undefined,
  descConfigurable: boolean | undefined,
  getNode: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined,
  setNode: ts.MethodDeclaration | ts.SetAccessorDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined,
  getExpr?: ts.Expression,
  setExpr?: ts.Expression,
  getExplicitUndefined = false,
  setExplicitUndefined = false,
  forceRuntime = false,
): ValType | null {
  // Compile obj
  const objType = compileExpression(ctx, fctx, objArg);
  if (!objType) return null;
  const objLocal = allocLocal(fctx, `__defprop_obj_${fctx.locals.length}`, objType);
  fctx.body.push({ op: "local.set", index: objLocal });

  // ES spec 19.1.2.4 step 1: throw TypeError if first arg is null/undefined (standalone mode)
  if (objType.kind === "externref" || objType.kind === "ref_null") {
    emitObjectArgNullGuard(ctx, fctx, objLocal);
  }

  // Compile prop and save as externref (needed for __defineProperty_value call)
  const propType = compileExpression(ctx, fctx, propArg, { kind: "externref" });
  let propLocal: number | undefined;
  if (propType) {
    if (propType.kind !== "externref") {
      coerceType(ctx, fctx, propType, { kind: "externref" });
    }
    // #2042 PR-A: symmetric with the value path — stringify the key in
    // standalone so the string-keyed `$Object` runtime (__obj_insert /
    // __defineProperty_accessor) never `ref.cast $AnyString`-traps on a
    // numeric/boxed key.
    emitStandaloneDefinePropertyKeyToString(ctx, fctx);
    propLocal = allocLocal(fctx, `__defprop_key_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: propLocal });
  }

  // For accessor descriptors (get/set), skip compiling descArg for side effects —
  // we'll compile getter/setter directly as JS-callable callbacks below.
  // (#2992 S3, standalone) explicit `get: undefined` / `set: undefined` are
  // PRESENT accessor fields (ToPropertyDescriptor §6.2.5.6) — route them to
  // the accessor applier with the half's "specified" bit and a null slot, so
  // the property becomes an accessor visible to gOPD (15.2.3.6-4-439). Host
  // mode keeps its `emitDefinePropertyDescRuntime` presence handling.
  const isAccessorDesc =
    !!(getNode || setNode || getExpr || setExpr) || (ctx.standalone && (getExplicitUndefined || setExplicitUndefined));
  if (!isAccessorDesc) {
    // Compile descriptor for side effects:
    // - non-accessor descriptors are applied through the flag-only runtime
    //   helper or compile-time flag table after descriptor evaluation.
    // - accessor descriptors compile their getter/setter operands directly in
    //   the accessor runtime branch below.
    const descType = compileExpression(ctx, fctx, descArg);
    if (descType) fctx.body.push({ op: "drop" });
  }

  // For externref objects (or non-struct GC types like arrays), call the runtime
  // helper. Accessor descriptors also need the runtime path even when the key is
  // a known struct field: the sidecar is the only store that compiled reads can
  // consult for `get: identifierRef` / `set: identifierRef` descriptors.
  const structProperty = resolveKnownStructProperty(ctx, objArg, propArg);
  const isKnownStructField = structProperty.isKnown;
  if ((forceRuntime || !isKnownStructField || isAccessorDesc) && propLocal !== undefined) {
    markRuntimeDefinedProperty(ctx, objArg, propArg);
    const propName = ts.isStringLiteral(propArg) ? propArg.text : undefined;

    // Compile-time tracking
    if (propName && ts.isObjectLiteralExpression(descArg)) {
      const isAccessor = isAccessorDesc;
      const varName = ts.isIdentifier(objArg) ? integrityVarKey(ctx, objArg) : undefined; // (#3403) per-declaration key
      if (varName) {
        const key = `${varName}:${propName}`;
        const existingFlags = ctx.definedPropertyFlags.get(key);
        const newFlags = applyDescriptorFlags(
          existingFlags,
          descWritable,
          descEnumerable,
          descConfigurable,
          isAccessor,
          descWritable !== undefined,
        );
        // (#3043) §10.1.6.3 transition check. Covers the attribute-only redefine
        // of a non-configurable accessor (`{configurable:true}` / enumerable
        // toggle) whose FIRST define recorded flags via the accessor fast path,
        // AND the `const o:any` accessor get/set redefine that lands here. The
        // throw is emitted after argument side-effects (spec order). On a throw
        // we RETURN immediately (unreachable) — continuing would emit a second,
        // dead accessor registration that clobbers the still-live original
        // accessor (15.2.3.6-4-540-*: the post-catch read must see the ORIGINAL
        // get/set intact).
        // Host-lane only (see the accessor fast-path note): the transition
        // matrix is validated against `definedPropertyFlags`, which in standalone
        // feeds the wasm-native hasOwnProperty routing; keep standalone on its
        // origin/main path. The existing `definedPropertyFlags.set` below is
        // unchanged in both modes.
        if (
          !ctx.standalone &&
          emitStaticDescriptorTransitionThrow(ctx, fctx, existingFlags, newFlags, isAccessor, !!(getNode || setNode))
        ) {
          fctx.body.push({ op: "unreachable" });
          return { kind: "externref" };
        }
        ctx.definedPropertyFlags.set(key, newFlags);
      }
    }

    if (isAccessorDesc) {
      // Pre-box shared mutable captures: variables referenced by BOTH getter and setter
      // where at least one writes to them. Without this, each callback gets its own
      // copy of the captured variable — a setter write would not be visible to the getter. (#929)
      if (getNode && setNode) {
        const getterRefs = new Set<string>();
        const setterRefs = new Set<string>();
        const getterWrites = new Set<string>();
        const setterWrites = new Set<string>();
        collectReferencedIdentifiers(getNode, getterRefs);
        collectReferencedIdentifiers(setNode, setterRefs);
        collectWrittenIdentifiers(getNode, getterWrites);
        collectWrittenIdentifiers(setNode, setterWrites);

        for (const varName of getterRefs) {
          if (!setterRefs.has(varName)) continue;
          if (!getterWrites.has(varName) && !setterWrites.has(varName)) continue;
          const localIdx = fctx.localMap.get(varName);
          if (localIdx === undefined) continue;
          if (fctx.boxedCaptures?.has(varName)) continue; // already boxed
          const type: ValType =
            localIdx < fctx.params.length
              ? fctx.params[localIdx]!.type
              : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" as const });
          const refCellTypeIdx = getOrRegisterRefCellType(ctx, type);
          fctx.body.push({ op: "local.get", index: localIdx });
          fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
          const refCellLocalIdx = allocLocal(fctx, `__shared_rc_${varName}`, {
            kind: "ref_null",
            typeIdx: refCellTypeIdx,
          });
          fctx.body.push({ op: "local.set", index: refCellLocalIdx });
          fctx.localMap.set(varName, refCellLocalIdx);
          if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
          fctx.boxedCaptures.set(varName, { refCellTypeIdx, valType: type });
        }
      }

      // Accessor path: compile getter/setter as JS-callable callbacks.
      // (#1460 R1) Resolve dynamic enumerable/configurable expressions for ToBoolean.
      const accDyn = extractDynamicFlagExprs(descArg);

      fctx.body.push({ op: "local.get", index: objLocal });
      if (objType.kind === "ref" || objType.kind === "ref_null") {
        fctx.body.push({ op: "extern.convert_any" });
      } else if (objType.kind !== "externref") {
        coerceType(ctx, fctx, objType, { kind: "externref" });
      }
      fctx.body.push({ op: "local.get", index: propLocal });

      // Compile getter (host-free closure under standalone, else JS callback;
      // #1888 S5b emitAccessorFn). `this` is the object the property is accessed on.
      if (getNode) {
        // MethodDeclaration / GetAccessorDeclaration — cast for TS; runtime props are compatible
        if (!emitAccessorFn(ctx, fctx, getNode as unknown as ts.FunctionExpression))
          fctx.body.push({ op: "ref.null.extern" });
      } else if (getExpr) {
        // get: identifierRef — compile the reference directly (host) so the
        // descriptor preserves the user's original function identity (#2668 B).
        if (!emitAccessorRefValue(ctx, fctx, getExpr)) fctx.body.push({ op: "ref.null.extern" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }

      // Compile setter (host-free closure under standalone, else JS callback;
      // #1888 S5b). `this` is the object the property is assigned on.
      if (setNode) {
        if (!emitAccessorFn(ctx, fctx, setNode as unknown as ts.FunctionExpression))
          fctx.body.push({ op: "ref.null.extern" });
      } else if (setExpr) {
        // set: identifierRef — compile the reference directly (host) so the
        // descriptor preserves the user's original function identity (#2668 B).
        if (!emitAccessorRefValue(ctx, fctx, setExpr)) fctx.body.push({ op: "ref.null.extern" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }

      emitRuntimeFlagsF64(
        ctx,
        fctx,
        undefined,
        descEnumerable,
        descConfigurable,
        false,
        undefined,
        accDyn.enumerableDyn,
        accDyn.configurableDyn,
        // (#2992 S3) [[Get]]/[[Set]] "specified" bits (8/9) — the standalone
        // accessor applier MERGES a partial descriptor (absent half preserves
        // the live half, §10.1.6.3). Standalone-gated so the gc/host lane's
        // f64 flag consts stay byte-identical.
        ctx.standalone
          ? (getNode || getExpr || getExplicitUndefined ? 1 << 8 : 0) |
              (setNode || setExpr || setExplicitUndefined ? 1 << 9 : 0)
          : 0,
      );

      const accFuncIdx = ensureLateImport(
        ctx,
        "__defineProperty_accessor",
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (accFuncIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: accFuncIdx });
        emitDefinePropertyRejectionThrow(ctx, fctx);
      }

      // (#3125) STANDALONE closed-struct receiver: the runtime
      // `__defineProperty_accessor` above stores into the open-`$Object`
      // `$PropEntry` sidecar — but a CLOSED-struct receiver (an inline object
      // literal, `Object.defineProperty({}, 'then', {get})` — the test262
      // poisoned-thenable pattern) fails its `ref.test $Object` and the
      // accessor is silently DROPPED. Mirror the getter/setter closures into
      // the #1888 S5c per-(struct,prop) module globals so runtime consumers
      // that dispatch on the struct shape (the #3125
      // `__promise_has_callable_then` predicate, the S5c read/write sites)
      // still see the accessor. `structProperty.structName` resolves HERE
      // (post-obj-compile) because compiling the literal registered its anon
      // type; when it does not resolve, behaviour is unchanged (pre-#3125:
      // accessor dropped). The TS-type resolution misses an anonymous inline
      // literal; the COMPILED wasm type of the receiver identifies its closed
      // struct directly.
      const mirrorStructName =
        structProperty.structName ??
        (objType.kind === "ref" || objType.kind === "ref_null"
          ? ctx.typeIdxToStructName.get(objType.typeIdx)
          : undefined);
      if (S5C_STRUCT_ACCESSOR_CLOSURE && ctx.standalone && mirrorStructName && structProperty.propName !== undefined) {
        if (getNode) {
          const getGlobalIdx = ensureStructAccessorGlobal(ctx, mirrorStructName, structProperty.propName, "get");
          if (buildAccessorClosure(ctx, fctx, getNode as unknown as ts.FunctionExpression)) {
            fctx.body.push({ op: "global.set", index: getGlobalIdx });
          }
        }
        if (setNode) {
          const setGlobalIdx = ensureStructAccessorGlobal(ctx, mirrorStructName, structProperty.propName, "set");
          if (buildAccessorClosure(ctx, fctx, setNode as unknown as ts.FunctionExpression)) {
            fctx.body.push({ op: "global.set", index: setGlobalIdx });
          }
        }
      }
      return { kind: "externref" };
    }

    // Non-accessor path: flag-only descriptor
    // (#1460 R1) Resolve dynamic flag exprs for runtime ToBoolean coercion.
    const flagOnlyDyn = extractDynamicFlagExprs(descArg);

    fctx.body.push({ op: "local.get", index: objLocal });
    // Use extern.convert_any directly (not coerceType) to avoid __make_iterable
    // for vec structs, which would create a new JS array with different identity (#856).
    if (objType.kind === "ref" || objType.kind === "ref_null") {
      fctx.body.push({ op: "extern.convert_any" });
    } else if (objType.kind !== "externref") {
      coerceType(ctx, fctx, objType, { kind: "externref" });
    }
    fctx.body.push({ op: "local.get", index: propLocal });
    // (#3319) no-value define: [[Value]] defaults to `undefined` on a FRESH
    // define (§10.1.6.3) — the $undefined singleton under the #2106 regime
    // (null read back as `typeof 'object'` / `!== undefined`); legacy lanes
    // keep the byte-identical null value. Redefines ignore this param (the
    // #2992 S3 merge preserves the live value when hasValue is unset).
    if (!emitUndefinedExtern(ctx, fctx)) fctx.body.push({ op: "ref.null.extern" }); // null value
    emitRuntimeFlagsF64(
      ctx,
      fctx,
      descWritable,
      descEnumerable,
      descConfigurable,
      false,
      flagOnlyDyn.writableDyn,
      flagOnlyDyn.enumerableDyn,
      flagOnlyDyn.configurableDyn,
    );

    const funcIdx = ensureLateImport(
      ctx,
      "__defineProperty_value",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      emitDefinePropertyRejectionThrow(ctx, fctx);
    }
    return { kind: "externref" };
  }

  // For struct-typed objects, flag-only descriptors are a no-op at runtime
  // (struct fields don't support property attributes)
  const propName = ts.isStringLiteral(propArg) ? propArg.text : undefined;
  if (propName && ts.isObjectLiteralExpression(descArg)) {
    // #1629: treat identifier-reference accessors (get/set: fnRef) as accessor
    // descriptors too, not just inline get/set methods — `isAccessorDesc`
    // includes getExpr/setExpr. #1718's applyDescriptorFlags below preserves
    // omitted writable/enumerable/configurable on partial redefine.
    const isAccessor = isAccessorDesc;
    const varName = ts.isIdentifier(objArg) ? integrityVarKey(ctx, objArg) : undefined; // (#3403) per-declaration key
    if (varName) {
      const key = `${varName}:${propName}`;
      const trackedExistingFlags = ctx.definedPropertyFlags.get(key);
      const isDefinePropertyWidenedField = ctx.widenedDefinePropertyKeys.has(key);
      const currentFlags =
        trackedExistingFlags ??
        (isKnownStructField && !isDefinePropertyWidenedField ? PROP_FLAGS_DEFAULT_DATA : undefined);
      const newFlags = applyDescriptorFlags(
        currentFlags,
        descWritable,
        descEnumerable,
        descConfigurable,
        isAccessor,
        descWritable !== undefined,
      );
      if (ctx.nonExtensibleVars.has(varName) && currentFlags === undefined) {
        emitThrowTypeError(ctx, fctx, "Cannot define property, object is not extensible");
      }
      const existingFlags = currentFlags;
      if (existingFlags !== undefined) {
        const isExistingConfigurable = !!(existingFlags & PROP_FLAG_CONFIGURABLE);
        if (!isExistingConfigurable) {
          if (newFlags & PROP_FLAG_CONFIGURABLE) {
            emitThrowTypeError(ctx, fctx, "Cannot redefine property");
          }
          if ((existingFlags & PROP_FLAG_ENUMERABLE) !== (newFlags & PROP_FLAG_ENUMERABLE)) {
            emitThrowTypeError(ctx, fctx, "Cannot redefine property");
          }
          // Data property writable checks (#856)
          if (!(existingFlags & PROP_FLAG_ACCESSOR) && !isAccessor) {
            if (!(existingFlags & PROP_FLAG_WRITABLE)) {
              if (newFlags & PROP_FLAG_WRITABLE) {
                // Cannot change writable from false to true on non-configurable
                emitThrowTypeError(ctx, fctx, "Cannot redefine property");
              }
            }
          }
          // Cannot change data<->accessor on non-configurable
          if (isAccessor && !(existingFlags & PROP_FLAG_ACCESSOR)) {
            emitThrowTypeError(ctx, fctx, "Cannot redefine property");
          }
          if (!isAccessor && existingFlags & PROP_FLAG_ACCESSOR) {
            emitThrowTypeError(ctx, fctx, "Cannot redefine property");
          }
        }
      }
      ctx.definedPropertyFlags.set(key, newFlags);
    }
  }

  fctx.body.push({ op: "local.get", index: objLocal });
  return objType;
}

// ── Object.defineProperties ───────────────────────────────────────────

/**
 * (#4491) One entry of a `Properties` map held in a variable, as
 * `stableDescriptorMapEntries` models it.
 *
 * - `literal` — the entry's initializer IS an object literal, so its fields are
 *   individually known and a later `props.k.field = v` write can be merged in.
 * - `expr` — anything else (`var props = { "0": descObj }`): the descriptor is
 *   opaque here and must be handed to the runtime whole.
 */
type DescriptorMapEntry =
  | { kind: "literal"; literal: ts.ObjectLiteralExpression; fields: Map<string, ts.Expression> }
  | { kind: "expr"; expr: ts.Expression };

/**
 * Compile Object.defineProperties(obj, descriptors).
 *
 * Static path: when descriptors is an object literal, iterate each property
 * and synthesize individual Object.defineProperty calls at compile time.
 *
 * Dynamic fallback: delegate to __defineProperties host import.
 */
export function compileObjectDefineProperties(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const objArg = expr.arguments[0]!;
  const descsArg = expr.arguments[1]!;

  // ES spec 19.1.2.3 step 1: throw TypeError if first arg is not an object
  if (emitNonObjectArgGuard(ctx, fctx, objArg, "Object.defineProperties")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }

  // (#3116) A LITERAL `get: null` / `set: null` in any inner descriptor is a
  // compile-time-provable ToPropertyDescriptor TypeError (§10.1: present, not
  // undefined, not callable). Routing it to the runtime is unreliable — a null
  // struct field is indistinguishable from an absent/undefined one at the wasm
  // boundary (#2106), so the runtime sometimes sees `{get: undefined}` (a
  // VALID accessor) instead. Emit the throw eagerly, after evaluating the
  // receiver + descriptors expressions for side effects (spec order: argument
  // evaluation precedes the per-key ToPropertyDescriptor throw).
  const nullAccessorField = ((): "Getter" | "Setter" | undefined => {
    if (!ts.isObjectLiteralExpression(descsArg)) return undefined;
    for (const prop of descsArg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const inner = unwrapTransparentExpression(prop.initializer);
      if (!ts.isObjectLiteralExpression(inner)) continue;
      for (const dp of inner.properties) {
        if (!ts.isPropertyAssignment(dp) || !ts.isIdentifier(dp.name)) continue;
        if (unwrapTransparentExpression(dp.initializer).kind !== ts.SyntaxKind.NullKeyword) continue;
        if (dp.name.text === "get") return "Getter";
        if (dp.name.text === "set") return "Setter";
      }
    }
    return undefined;
  })();
  if (nullAccessorField !== undefined) {
    const objT = compileExpression(ctx, fctx, objArg);
    if (objT) fctx.body.push({ op: "drop" });
    const descsT = compileExpression(ctx, fctx, descsArg);
    if (descsT) fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, `${nullAccessorField} must be a function: null`);
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }

  // (#3782) Rollup-style packages commonly build a fixed descriptor map in a
  // module variable, fill each descriptor's `get`/`set` field, then apply it
  // to a function's prototype. The plural native fallback cannot enumerate a
  // statically-shaped WasmGC map as a dynamic `$Object`. When the map's own key
  // set is provably fixed and the receiver is a plain user-function prototype,
  // expand the plural operation into singular definitions. Each descriptor is
  // still read at the original call site, after all intervening mutations.
  const stableDescriptorMapEntries = (() => {
    if (!ctx.standalone || !ts.isIdentifier(descsArg)) return undefined;
    // (#3957) Receiver gate widened from "<fn>.prototype only" to "any
    // re-evaluable-without-side-effects receiver", i.e. a bare identifier as
    // well. The expansion below compiles `objArg` once PER KEY, so the gate's
    // real job is to exclude receivers whose re-evaluation is observable
    // (calls, element access with a computed index, `new`, …) — being a
    // function prototype was never the load-bearing part. A bare identifier is
    // the ordinary test262 / user spelling
    // (`Object.defineProperties(obj, properties)`) and hits the same wall the
    // #3782 comment describes: the native plural fallback cannot enumerate a
    // statically-shaped WasmGC map as a dynamic `$Object`, so without the
    // expansion the whole call is refused with "unsupported descriptor shape".
    const receiverIsReEvaluable = (() => {
      if (ts.isIdentifier(objArg)) return true;
      if (
        ts.isPropertyAccessExpression(objArg) &&
        objArg.name.text === "prototype" &&
        ts.isIdentifier(objArg.expression)
      ) {
        const receiverDeclaration = ctx.oracle.valueDeclarationOf(objArg.expression);
        return (
          !!receiverDeclaration &&
          (ts.isFunctionDeclaration(receiverDeclaration) ||
            (ts.isVariableDeclaration(receiverDeclaration) &&
              !!receiverDeclaration.initializer &&
              ts.isFunctionExpression(unwrapTransparentExpression(receiverDeclaration.initializer))))
        );
      }
      return false;
    })();
    if (!receiverIsReEvaluable) return undefined;

    const declaration = ctx.oracle.variableDeclarationOf(descsArg);
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer ||
      !ts.isObjectLiteralExpression(unwrapTransparentExpression(declaration.initializer))
    ) {
      return undefined;
    }
    const literal = unwrapTransparentExpression(declaration.initializer) as ts.ObjectLiteralExpression;
    // (#4491) An entry is either a LITERAL descriptor — a field map the
    // stability visitor below may still MERGE later writes into — or a
    // PASS-THROUGH expression (`var properties = { "0": descObj }`), which the
    // expansion can only hand to the runtime whole. Before this the second
    // shape returned `undefined` here and the whole call fell to the native
    // fallback, where an identifier map is a closed WasmGC struct and refuses
    // with `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`.
    const descriptors = new Map<string, DescriptorMapEntry>();
    for (const property of literal.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      ) {
        return undefined;
      }
      const entryInit = unwrapTransparentExpression(property.initializer);
      if (!ts.isObjectLiteralExpression(entryInit)) {
        descriptors.set(property.name.text, { kind: "expr", expr: property.initializer });
        continue;
      }
      const fields = new Map<string, ts.Expression>();
      for (const field of entryInit.properties) {
        if (!ts.isPropertyAssignment(field) || (!ts.isIdentifier(field.name) && !ts.isStringLiteral(field.name))) {
          return undefined;
        }
        fields.set(field.name.text, field.initializer);
      }
      descriptors.set(property.name.text, { kind: "literal", literal: entryInit, fields });
    }
    const keys = [...descriptors.keys()];
    if (keys.length === 0 || new Set(keys).size !== keys.length) return undefined;
    const keySet = new Set(keys);
    let stable = true;
    /** (#4491) Did the visitor merge a later write into a literal entry? */
    let mergedIntoLiteral = false;
    const visit = (node: ts.Node): void => {
      if (!stable) return;
      if (ts.isIdentifier(node) && ctx.oracle.variableDeclarationOf(node) === declaration) {
        if (node === declaration.name || node === descsArg) {
          // Declaration and the defineProperties argument itself are expected.
        } else if (
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.expression === node &&
          keySet.has(node.parent.name.text) &&
          ts.isPropertyAccessExpression(node.parent.parent) &&
          node.parent.parent.expression === node.parent &&
          ts.isBinaryExpression(node.parent.parent.parent) &&
          node.parent.parent.parent.left === node.parent.parent &&
          node.parent.parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          node.parent.parent.parent.getStart() < expr.getStart()
        ) {
          // A direct field assignment before the application preserves the
          // descriptor map's key set and can be merged into its literal shape.
          // (#4491) …but only into a LITERAL entry. A pass-through entry has no
          // field map to merge into, so the write is unmodelled and the whole
          // expansion must decline rather than silently drop it.
          const mergeTarget = descriptors.get(node.parent.name.text)!;
          if (mergeTarget.kind !== "literal") {
            stable = false;
            return;
          }
          mergedIntoLiteral = true;
          mergeTarget.fields.set(node.parent.parent.name.text, node.parent.parent.parent.right);
        } else {
          stable = false;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(descsArg.getSourceFile());
    if (!stable) return undefined;
    const hasPassThrough = [...descriptors.values()].some((e) => e.kind !== "literal");
    return {
      // (#4491) The reify route re-uses the ORIGINAL descriptor nodes, so it is
      // only offered when the visitor merged nothing (a merged shape exists
      // only as a synthesized literal, which has no source parents to compile
      // an entry against). Otherwise the pre-existing per-key expansion runs
      // unchanged — its emission for an all-literal, unmerged map is unaffected
      // by this branch.
      reify: hasPassThrough && !mergedIntoLiteral,
      entries: keys.map((key) => {
        const entry = descriptors.get(key)!;
        return {
          key,
          /** The node handed to `Object.defineProperty` / the reified map. */
          descriptor:
            entry.kind === "literal"
              ? ts.factory.createObjectLiteralExpression(
                  [...entry.fields.entries()].map(([name, initializer]) =>
                    ts.factory.createPropertyAssignment(name, initializer),
                  ),
                )
              : entry.expr,
          /** The ORIGINAL source node, when there is one (reify route only). */
          sourceNode: entry.kind === "literal" ? entry.literal : entry.expr,
        };
      }),
    };
  })();
  // (#4491) A map with a pass-through entry goes to the NATIVE plural applier
  // over a reified `$Object` rather than the per-key expansion: the native is
  // the only path with ToPropertyDescriptor's conflict/callable checks, and it
  // preserves §20.1.2.3.1's gather-all-then-define-all order, which a per-key
  // expansion structurally cannot (see define-properties-map.ts).
  const reifiedDescsArg: ts.ObjectLiteralExpression | undefined = stableDescriptorMapEntries?.reify
    ? (() => {
        const synth = ts.factory.createObjectLiteralExpression(
          stableDescriptorMapEntries.entries.map(({ key, sourceNode }) =>
            ts.factory.createPropertyAssignment(ts.factory.createStringLiteral(key), sourceNode),
          ),
        );
        ts.setTextRange(synth, descsArg);
        (synth as ts.ObjectLiteralExpression & { parent: ts.Node }).parent = expr;
        for (const p of synth.properties) {
          ts.setTextRange(p, descsArg);
          (p as ts.ObjectLiteralElementLike & { parent: ts.Node }).parent = synth;
          ts.setTextRange(p.name!, descsArg);
          (p.name as unknown as { parent: ts.Node }).parent = p;
        }
        return synth;
      })()
    : undefined;
  if (stableDescriptorMapEntries && !stableDescriptorMapEntries.reify) {
    const expansion = stableDescriptorMapEntries.entries;
    let resultType: ValType | null = null;
    for (let index = 0; index < expansion.length; index++) {
      const { key, descriptor } = expansion[index]!;
      const syntheticCall = ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("Object"), "defineProperty"),
        undefined,
        [objArg, ts.factory.createStringLiteral(key), descriptor],
      );
      ts.setTextRange(syntheticCall, expr);
      ts.setTextRange(descriptor, descsArg);
      (descriptor as ts.Expression & { parent: ts.Node }).parent = syntheticCall;
      (syntheticCall as ts.CallExpression & { parent: ts.Node }).parent = expr.parent;
      resultType = compileObjectDefineProperty(ctx, fctx, syntheticCall);
      if (resultType && index + 1 < expansion.length) fctx.body.push({ op: "drop" });
    }
    return resultType;
  }

  // Static path: descriptors is an object literal — expand to individual
  // defineProperty calls. `isStaticDescWellFormed` (descriptor-shape.ts, #3991)
  // decides whether the expansion may own each inner descriptor; anything it
  // cannot fully model falls through to the dynamic `__defineProperties`, whose
  // ToPropertyDescriptor (§6.2.5.6) is the only complete implementation.
  if (ts.isObjectLiteralExpression(descsArg)) {
    let allWellFormed = true;
    for (const prop of descsArg.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      // (#4479) A key the expansion cannot name DECLINES the whole call; the
      // old per-entry `propName === undefined ⇒ continue` silently dropped it
      // (`define-properties-map.ts`, defect 1).
      if (staticDescriptorMapKey(prop.name) === undefined) {
        allWellFormed = false;
        break;
      }
      if (!isStaticDescWellFormed(prop.initializer)) {
        allWellFormed = false;
        break;
      }
    }
    if (!allWellFormed) {
      // Fall through to dynamic runtime — __defineProperties validates and throws TypeError.
    } else {
      // Compile obj and save to local
      const objType = compileExpression(ctx, fctx, objArg);
      if (!objType) return null;
      const objLocal = allocLocal(fctx, `__defprops_obj_${fctx.locals.length}`, objType);
      fctx.body.push({ op: "local.set", index: objLocal });

      for (const prop of descsArg.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        // (#4479) unnameable keys can no longer reach here (pre-scan declined).
        const propName = staticDescriptorMapKey(prop.name);
        if (propName === undefined) continue;

        // (#3984) Removed here: a synthetic `Object.defineProperty(...)` call node
        // that was built, text-ranged, re-parented — and never read. Its comment
        // claimed this loop "directly call[s] compileObjectDefineProperty"; it never
        // did. That false claim is how the array-`length` routing gap below stayed
        // invisible. The loop expands each descriptor inline, as the code below shows.
        const descExpr = prop.initializer;

        // (#3984) Route array-`length` defines to ArraySetLength — the inline
        // expansion below has no notion of the vec's length field and would
        // silently leave the length unchanged. See array-length-define.ts.
        if (
          tryEmitVecLengthDefineForDefineProperties(ctx, fctx, objArg, propName, descExpr, compileObjectDefineProperty)
        ) {
          continue;
        }

        // Parse the individual descriptor
        let valueExpr: ts.Expression | undefined;
        let descWritable: boolean | undefined;
        let descEnumerable: boolean | undefined;
        let descConfigurable: boolean | undefined;
        let dpGetNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
        let dpSetNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined;
        let dpGetExpr: ts.Expression | undefined;
        let dpSetExpr: ts.Expression | undefined;

        if (ts.isObjectLiteralExpression(descExpr)) {
          for (const dp of descExpr.properties) {
            if (ts.isPropertyAssignment(dp) && ts.isIdentifier(dp.name)) {
              if (dp.name.text === "value") valueExpr = dp.initializer;
              if (dp.name.text === "writable") {
                // (#1460 R1) Apply ToBoolean via compile-time fold; dynamic values
                // remain undefined here and are resolved at runtime in the externref
                // fallback below via emitRuntimeFlagsF64 + extractDynamicFlagExprs.
                descWritable = tryConstantFoldToBoolean(dp.initializer);
              }
              if (dp.name.text === "enumerable") {
                descEnumerable = tryConstantFoldToBoolean(dp.initializer);
              }
              if (dp.name.text === "configurable") {
                descConfigurable = tryConstantFoldToBoolean(dp.initializer);
              }
              // Accessor: get/set with inline function
              if (dp.name.text === "get") {
                if (ts.isFunctionExpression(dp.initializer) || ts.isArrowFunction(dp.initializer)) {
                  dpGetNode = dp.initializer;
                } else if (
                  !(
                    ts.isIdentifier(dp.initializer) &&
                    (dp.initializer.text === "undefined" || dp.initializer.text === "null")
                  ) &&
                  dp.initializer.kind !== ts.SyntaxKind.NullKeyword
                ) {
                  dpGetExpr = dp.initializer;
                }
              }
              if (dp.name.text === "set") {
                if (ts.isFunctionExpression(dp.initializer) || ts.isArrowFunction(dp.initializer)) {
                  dpSetNode = dp.initializer;
                } else if (
                  !(
                    ts.isIdentifier(dp.initializer) &&
                    (dp.initializer.text === "undefined" || dp.initializer.text === "null")
                  ) &&
                  dp.initializer.kind !== ts.SyntaxKind.NullKeyword
                ) {
                  dpSetExpr = dp.initializer;
                }
              }
            }
            if (ts.isMethodDeclaration(dp) && dp.name && ts.isIdentifier(dp.name)) {
              if (dp.name.text === "get") dpGetNode = dp;
              if (dp.name.text === "set") dpSetNode = dp;
            }
          }
        }

        // Try struct path: if obj is a known struct and propName matches a field
        const objTsType = ctx.checker.getTypeAtLocation(objArg);
        const structName =
          resolveStructName(ctx, objTsType) ||
          (ts.isIdentifier(objArg) ? widenedStructNameForUse(ctx, objArg) : undefined);
        const structTypeIdx = structName ? ctx.structMap.get(structName) : undefined;
        const fields = structName ? ctx.structFields.get(structName) : undefined;
        const fieldIdx = fields && propName ? fields.findIndex((f) => f.name === propName) : -1;
        // (#3116) Same veto as the singular `useStruct` path: a prior define
        // for this var:prop went through a runtime route, so the authoritative
        // descriptor state (attributes + SameValue-relevant current value)
        // lives in the runtime sidecar — the compile-time struct.set would skip
        // validation against it (15.2.3.7-6-a-46). Route to the externref path.
        const priorRuntimeDefine =
          propName !== undefined &&
          ts.isIdentifier(objArg) &&
          ctx.sidecarDefinedPropertyKeys.has(`${objArg.text}:${propName}`);

        if (!priorRuntimeDefine && structTypeIdx !== undefined && fields && fieldIdx >= 0 && valueExpr) {
          // Struct path: emit struct.set directly
          const fieldType = fields[fieldIdx]!.type;

          // ── Compile-time flag checking for struct path (#856) ──
          let priorExistingFlags: number | undefined;
          let newFlagsForStructField = applyDescriptorFlags(
            PROP_FLAGS_DEFAULT_DATA,
            descWritable,
            descEnumerable,
            descConfigurable,
            false,
            valueExpr !== undefined || descWritable !== undefined,
          );
          if (ts.isIdentifier(objArg)) {
            const isAccessor = false;
            const key = `${integrityVarKey(ctx, objArg)}:${propName}`; // (#3403) per-declaration key
            const trackedExistingFlags = ctx.definedPropertyFlags.get(key);
            const isDefinePropertyWidenedField = ctx.widenedDefinePropertyKeys.has(key);
            const currentFlags =
              trackedExistingFlags ?? (!isDefinePropertyWidenedField ? PROP_FLAGS_DEFAULT_DATA : undefined);
            const newFlags = applyDescriptorFlags(
              currentFlags,
              descWritable,
              descEnumerable,
              descConfigurable,
              isAccessor,
              valueExpr !== undefined || descWritable !== undefined,
            );
            newFlagsForStructField = newFlags;
            priorExistingFlags = currentFlags;

            const existingFlags = currentFlags;
            if (existingFlags !== undefined) {
              const isExistingConfigurable = !!(existingFlags & PROP_FLAG_CONFIGURABLE);
              if (!isExistingConfigurable) {
                // Non-configurable: check for violations
                if (newFlags & PROP_FLAG_CONFIGURABLE) {
                  emitThrowTypeError(ctx, fctx, "Cannot redefine property");
                }
                const existingEnumerable = existingFlags & PROP_FLAG_ENUMERABLE;
                const newEnumerable = newFlags & PROP_FLAG_ENUMERABLE;
                if (existingEnumerable !== newEnumerable) {
                  emitThrowTypeError(ctx, fctx, "Cannot redefine property");
                }
                // Data property writable checks
                if (!(existingFlags & PROP_FLAG_ACCESSOR) && !isAccessor) {
                  if (!(existingFlags & PROP_FLAG_WRITABLE)) {
                    if (newFlags & PROP_FLAG_WRITABLE) {
                      emitThrowTypeError(ctx, fctx, "Cannot redefine property");
                    }
                  }
                }
                // Cannot change data<->accessor on non-configurable
                if (isAccessor && !(existingFlags & PROP_FLAG_ACCESSOR)) {
                  emitThrowTypeError(ctx, fctx, "Cannot redefine property");
                }
                if (!isAccessor && existingFlags & PROP_FLAG_ACCESSOR) {
                  emitThrowTypeError(ctx, fctx, "Cannot redefine property");
                }
              }
            }
          }

          // Check if this property is non-writable non-configurable (needs runtime value comparison)
          const needsValueCompare =
            priorExistingFlags !== undefined &&
            !(priorExistingFlags & PROP_FLAG_CONFIGURABLE) &&
            !(priorExistingFlags & PROP_FLAG_WRITABLE) &&
            !(priorExistingFlags & PROP_FLAG_ACCESSOR);

          fctx.body.push({ op: "local.get", index: objLocal });

          // Cast if needed — guard with ref.test to avoid illegal cast traps (#778)
          let needsGuard = false;
          if (objType.kind === "externref") {
            fctx.body.push({ op: "any.convert_extern" });
            needsGuard = true;
          } else if (
            (objType.kind === "ref_null" || objType.kind === "ref") &&
            "typeIdx" in objType &&
            objType.typeIdx !== structTypeIdx
          ) {
            needsGuard = true;
          }

          if (needsValueCompare) {
            // Non-writable non-configurable: compare old and new values
            if (needsGuard) {
              // Save as anyref for guarded access
              const defpTmp = allocLocal(fctx, `__defp_tmp_${fctx.locals.length}`, { kind: "anyref" });
              fctx.body.push({ op: "local.set", index: defpTmp });

              // Save old value
              const oldValLocal = allocLocal(fctx, `__defps_oldval_${fctx.locals.length}`, fieldType);
              fctx.body.push({ op: "local.get", index: defpTmp });
              fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
              if (fieldType.kind === "f64") {
                fctx.body.push({
                  op: "if",
                  blockType: { kind: "val", type: { kind: "f64" } as ValType },
                  then: [
                    { op: "local.get", index: defpTmp },
                    { op: "ref.cast", typeIdx: structTypeIdx },
                    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx },
                  ],
                  else: [{ op: "f64.const", value: 0 }],
                });
              } else if (fieldType.kind === "i32") {
                fctx.body.push({
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } as ValType },
                  then: [
                    { op: "local.get", index: defpTmp },
                    { op: "ref.cast", typeIdx: structTypeIdx },
                    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx },
                  ],
                  else: [{ op: "i32.const", value: 0 }],
                });
              }
              fctx.body.push({ op: "local.set", index: oldValLocal });

              // Compile new value
              const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
              if (valType) {
                const newValLocal = allocLocal(fctx, `__defps_newval_${fctx.locals.length}`, fieldType);
                if (valType.kind !== fieldType.kind) {
                  coerceType(ctx, fctx, valType, fieldType);
                }
                fctx.body.push({ op: "local.set", index: newValLocal });

                // Compare values — throw if different
                const tagIdx = ensureExnTag(ctx);
                const errMsg = "TypeError: Cannot redefine property";
                addStringConstantGlobal(ctx, errMsg);
                // (#2515 S0) sentinel-safe message push.
                const errMsgInstrs = stringConstantExternrefInstrs(ctx, errMsg);
                if (fieldType.kind === "f64") {
                  fctx.body.push({ op: "local.get", index: oldValLocal });
                  fctx.body.push({ op: "local.get", index: newValLocal });
                  fctx.body.push({ op: "f64.ne" });
                  fctx.body.push({
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [...errMsgInstrs, { op: "throw", tagIdx }],
                  });
                } else if (fieldType.kind === "i32") {
                  fctx.body.push({ op: "local.get", index: oldValLocal });
                  fctx.body.push({ op: "local.get", index: newValLocal });
                  fctx.body.push({ op: "i32.ne" });
                  fctx.body.push({
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [...errMsgInstrs, { op: "throw", tagIdx }],
                  });
                }

                // Do the struct.set if values match
                fctx.body.push({ op: "local.get", index: defpTmp });
                fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
                fctx.body.push({
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: defpTmp },
                    { op: "ref.cast", typeIdx: structTypeIdx },
                    { op: "local.get", index: newValLocal },
                    { op: "struct.set", typeIdx: structTypeIdx, fieldIdx },
                  ],
                  else: [],
                });
              }
            } else {
              // Non-guarded: direct struct access
              const oldValLocal = allocLocal(fctx, `__defps_oldval_${fctx.locals.length}`, fieldType);
              fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
              fctx.body.push({ op: "local.set", index: oldValLocal });

              const newValLocal = allocLocal(fctx, `__defps_newval_${fctx.locals.length}`, fieldType);
              const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
              if (valType) {
                if (valType.kind !== fieldType.kind) {
                  coerceType(ctx, fctx, valType, fieldType);
                }
                fctx.body.push({ op: "local.set", index: newValLocal });

                const tagIdx = ensureExnTag(ctx);
                const errMsg = "TypeError: Cannot redefine property";
                addStringConstantGlobal(ctx, errMsg);
                // (#2515 S0) sentinel-safe message push.
                const errMsgInstrs = stringConstantExternrefInstrs(ctx, errMsg);
                if (fieldType.kind === "f64") {
                  fctx.body.push({ op: "local.get", index: oldValLocal });
                  fctx.body.push({ op: "local.get", index: newValLocal });
                  fctx.body.push({ op: "f64.ne" });
                  fctx.body.push({
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [...errMsgInstrs, { op: "throw", tagIdx }],
                  });
                } else if (fieldType.kind === "i32") {
                  fctx.body.push({ op: "local.get", index: oldValLocal });
                  fctx.body.push({ op: "local.get", index: newValLocal });
                  fctx.body.push({ op: "i32.ne" });
                  fctx.body.push({
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [...errMsgInstrs, { op: "throw", tagIdx }],
                  });
                }

                // Do the struct.set
                fctx.body.push({ op: "local.get", index: objLocal });
                fctx.body.push({ op: "local.get", index: newValLocal });
                fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
              } else {
                fctx.body.push({ op: "drop" });
              }
            }
          } else if (needsGuard) {
            // Save obj as anyref, compile value, then guard the struct.set
            const defpTmp = allocLocal(fctx, `__defp_tmp_${fctx.locals.length}`, { kind: "anyref" });
            fctx.body.push({ op: "local.set", index: defpTmp });

            // Compile the value expression first (outside the guard)
            const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
            if (valType) {
              const valLocal = allocLocal(fctx, `__defp_val_${fctx.locals.length}`, fieldType);
              if (valType.kind !== fieldType.kind) {
                coerceType(ctx, fctx, valType, fieldType);
              }
              fctx.body.push({ op: "local.set", index: valLocal });

              // Now guard the struct.set with ref.test
              fctx.body.push({ op: "local.get", index: defpTmp });
              fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: defpTmp },
                  { op: "ref.cast", typeIdx: structTypeIdx },
                  { op: "local.get", index: valLocal },
                  { op: "struct.set", typeIdx: structTypeIdx, fieldIdx },
                ],
                else: [],
              });
            }
          } else {
            const valType = compileExpression(ctx, fctx, valueExpr, fieldType);
            if (valType) {
              if (valType.kind !== fieldType.kind) {
                coerceType(ctx, fctx, valType, fieldType);
              }
              fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
            } else {
              // No value produced — drop the obj ref
              fctx.body.push({ op: "drop" });
            }
          }

          // Update compile-time flags
          if (ts.isIdentifier(objArg)) {
            const key = `${integrityVarKey(ctx, objArg)}:${propName}`; // (#3403) per-declaration key
            ctx.definedPropertyFlags.set(key, newFlagsForStructField);
          }

          // Update shapePropFlags
          const userFields = fields
            .map((f, idx) => ({ field: f, fieldIdx: idx }))
            .filter((e) => !e.field.name.startsWith("__"));
          const userFieldIdx = userFields.findIndex((e) => e.fieldIdx === fieldIdx);
          if (userFieldIdx >= 0) {
            const flagsArr = ctx.shapePropFlags.get(structTypeIdx);
            if (flagsArr && userFieldIdx < flagsArr.length) {
              flagsArr[userFieldIdx] = newFlagsForStructField & 0x07; // Only store WEC bits
            }
          }

          continue; // Next property
        }

        // Externref fallback
        const dpIsAccessor = !!(dpGetNode || dpSetNode || dpGetExpr || dpSetExpr);
        // Use extern.convert_any directly (not coerceType) to avoid __make_iterable
        // for vec structs, which would create a new JS array with different identity (#856/#1092).
        fctx.body.push({ op: "local.get", index: objLocal });
        if (objType.kind === "ref" || objType.kind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" });
        } else if (objType.kind !== "externref") {
          coerceType(ctx, fctx, objType, { kind: "externref" });
        }
        const objExtLocal = allocLocal(fctx, `__defprops_ext_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: objExtLocal });

        if (dpIsAccessor) {
          // Accessor descriptor: emit __defineProperty_accessor
          // (#1460 R1) Extract dynamic flag exprs for runtime ToBoolean.
          const dpAccDyn = ts.isObjectLiteralExpression(descExpr)
            ? extractDynamicFlagExprs(descExpr)
            : ({} as ReturnType<typeof extractDynamicFlagExprs>);
          fctx.body.push({ op: "local.get", index: objExtLocal });
          compileExpression(ctx, fctx, ts.factory.createStringLiteral(propName), { kind: "externref" });

          // Compile getter (host-free closure under standalone, else JS callback; #1888 S5b)
          if (dpGetNode) {
            if (!emitAccessorFn(ctx, fctx, dpGetNode as unknown as ts.FunctionExpression))
              fctx.body.push({ op: "ref.null.extern" });
          } else if (dpGetExpr && ctx.standalone) {
            // (#2992 S3) identity-preserving direct value — see emitAccessorRefValue.
            if (!emitAccessorRefValue(ctx, fctx, dpGetExpr)) fctx.body.push({ op: "ref.null.extern" });
          } else if (dpGetExpr) {
            const gFuncNode = resolveExprToFuncNode(ctx, dpGetExpr);
            if (gFuncNode) {
              if (!emitAccessorFn(ctx, fctx, gFuncNode as unknown as ts.FunctionExpression))
                fctx.body.push({ op: "ref.null.extern" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }

          // Compile setter (host-free closure under standalone, else JS callback; #1888 S5b)
          if (dpSetNode) {
            if (!emitAccessorFn(ctx, fctx, dpSetNode as unknown as ts.FunctionExpression))
              fctx.body.push({ op: "ref.null.extern" });
          } else if (dpSetExpr && ctx.standalone) {
            // (#2992 S3) identity-preserving direct value — see emitAccessorRefValue.
            if (!emitAccessorRefValue(ctx, fctx, dpSetExpr)) fctx.body.push({ op: "ref.null.extern" });
          } else if (dpSetExpr) {
            const sFuncNode = resolveExprToFuncNode(ctx, dpSetExpr);
            if (sFuncNode) {
              if (!emitAccessorFn(ctx, fctx, sFuncNode as unknown as ts.FunctionExpression))
                fctx.body.push({ op: "ref.null.extern" });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }

          emitRuntimeFlagsF64(
            ctx,
            fctx,
            undefined,
            descEnumerable,
            descConfigurable,
            false,
            undefined,
            dpAccDyn.enumerableDyn,
            dpAccDyn.configurableDyn,
            // (#2992 S3) [[Get]]/[[Set]] specified bits — see the
            // emitExternDefinePropertyNoValue twin. Standalone-gated.
            ctx.standalone ? (dpGetNode || dpGetExpr ? 1 << 8 : 0) | (dpSetNode || dpSetExpr ? 1 << 9 : 0) : 0,
          );
          const accIdx = ensureLateImport(
            ctx,
            "__defineProperty_accessor",
            [
              { kind: "externref" },
              { kind: "externref" },
              { kind: "externref" },
              { kind: "externref" },
              { kind: "f64" },
            ],
            [{ kind: "externref" }],
          );
          flushLateImportShifts(ctx, fctx);
          if (accIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: accIdx });
            fctx.body.push({ op: "drop" });
          }

          if (ts.isIdentifier(objArg)) {
            const isAccessor = true;
            const key = `${integrityVarKey(ctx, objArg)}:${propName}`; // (#3403) per-declaration key
            const newFlags = applyDescriptorFlags(
              ctx.definedPropertyFlags.get(key),
              descWritable,
              descEnumerable,
              descConfigurable,
              isAccessor,
              false,
            );
            ctx.definedPropertyFlags.set(key, newFlags);
          }
        } else {
          // Value/flags descriptor: emit __defineProperty_value
          // Push prop name as string
          fctx.body.push({ op: "local.get", index: objExtLocal });
          compileExpression(ctx, fctx, ts.factory.createStringLiteral(propName), { kind: "externref" });

          // Compile value or push the no-value default. (#3319) A missing
          // `value` defaults [[Value]] to `undefined` on a fresh define
          // (§10.1.6.3) — the $undefined singleton under the #2106 regime
          // (null read back `!== undefined` / typeof "object"); legacy lanes
          // keep the byte-identical null push.
          if (valueExpr) {
            const vt = compileExpression(ctx, fctx, valueExpr, { kind: "externref" });
            if (vt && vt.kind !== "externref") {
              coerceType(ctx, fctx, vt, { kind: "externref" });
            } else if (!vt) {
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else if (!emitUndefinedExtern(ctx, fctx)) {
            fctx.body.push({ op: "ref.null.extern" });
          }

          // Runtime flags (#1460 R1: ToBoolean coercion on dynamic flag exprs)
          const dpValDyn = ts.isObjectLiteralExpression(descExpr)
            ? extractDynamicFlagExprs(descExpr)
            : ({} as ReturnType<typeof extractDynamicFlagExprs>);
          emitRuntimeFlagsF64(
            ctx,
            fctx,
            descWritable,
            descEnumerable,
            descConfigurable,
            !!valueExpr,
            dpValDyn.writableDyn,
            dpValDyn.enumerableDyn,
            dpValDyn.configurableDyn,
          );

          const funcIdx = ensureLateImport(
            ctx,
            "__defineProperty_value",
            [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
            [{ kind: "externref" }],
          );
          flushLateImportShifts(ctx, fctx);
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            fctx.body.push({ op: "drop" }); // drop returned obj (we use our local)
          }

          // Update compile-time flags for externref path
          if (ts.isIdentifier(objArg)) {
            const isAccessor = false;
            const key = `${integrityVarKey(ctx, objArg)}:${propName}`; // (#3403) per-declaration key
            const newFlags = applyDescriptorFlags(
              ctx.definedPropertyFlags.get(key),
              descWritable,
              descEnumerable,
              descConfigurable,
              isAccessor,
              valueExpr !== undefined || descWritable !== undefined,
            );
            ctx.definedPropertyFlags.set(key, newFlags);
          }
        }
      }

      // Return obj
      fctx.body.push({ op: "local.get", index: objLocal });
      return objType;
    }
  }

  // Dynamic fallback: delegate to __defineProperties host import
  const objType = compileExpression(ctx, fctx, objArg);
  if (!objType) return null;
  // Use extern.convert_any directly (not coerceType) to avoid __make_iterable
  // for vec structs, which would create a new JS array with different identity (#856/#1092).
  if (objType.kind === "ref" || objType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  } else if (objType.kind !== "externref") {
    coerceType(ctx, fctx, objType, { kind: "externref" });
  }
  // (#4479) Standalone: the literal `Properties` map must reach the native as a
  // real `$Object`, not the closed struct its `PropertyDescriptorMap` contextual
  // type produces — a struct answers no `__desc_has_own`/`__extern_get`, so every
  // field read missed. Declines (emits nothing) elsewhere: define-properties-map.ts.
  // (#4491) …and a `Properties` IDENTIFIER whose declaration is a provably
  // stable map literal reaches it through the same builder, over a synthesized
  // literal that re-uses the original per-key descriptor nodes.
  const descsType =
    compileDescriptorMapAsDynamicObject(ctx, fctx, reifiedDescsArg ?? descsArg) ??
    compileExpression(ctx, fctx, descsArg, { kind: "externref" });
  if (!descsType) {
    return { kind: "externref" };
  }
  if (descsType.kind !== "externref") {
    coerceType(ctx, fctx, descsType, { kind: "externref" });
  }

  const funcIdx = ensureLateImport(
    ctx,
    "__defineProperties",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (funcIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx });
  }
  return { kind: "externref" };
}

// ── Object.keys / Object.values ───────────────────────────────────────

/**
 * Compile Object.keys(obj) or Object.values(obj) by expanding struct fields
 * at compile time. Object.keys returns a string[] of field names,
 * Object.values returns an array of the field values.
 */
export function compileObjectKeysOrValues(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: string,
  expr: ts.CallExpression,
): ValType | null {
  const arg = expr.arguments[0]!;
  const argType = ctx.checker.getTypeAtLocation(arg);

  // (#2746) ES ToObject (§7.1.18): Object.keys/values/entries of `null` or
  // `undefined` throws a TypeError. A bare nullish-typed argument otherwise
  // falls into the empty-object-literal fast path below (no own properties to
  // enumerate) and wrongly compiles away to `[]` instead of throwing. Detect a
  // purely-nullish argument type and emit the ToObject TypeError directly — this
  // is mode-agnostic (works in JS-host and standalone) since it never reaches a
  // host import. `any`/`unknown` keep flowing to the runtime path (which throws
  // at runtime when the value turns out to be nullish).
  const NULLISH_FLAGS = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
  const isNullishType = (t: ts.Type): boolean =>
    t.isUnion() ? t.types.every(isNullishType) : (t.flags & NULLISH_FLAGS) !== 0 && (t.flags & ~NULLISH_FLAGS) === 0;
  if (isNullishType(argType)) {
    const t = compileExpression(ctx, fctx, arg);
    if (t) fctx.body.push({ op: "drop" });
    const which = !argType.isUnion() && argType.flags & ts.TypeFlags.Null ? "null" : "undefined";
    emitThrowTypeError(ctx, fctx, `Cannot convert ${which} to object`);
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }

  // (#2804) When the argument is a variable that holds a HOST `$Object`
  // (externref) rather than a closed struct — e.g. `const b = { ...a, z: 3 }`,
  // whose spread routes it to the host plain-object path and tags it in
  // `externrefAccessorVars` — the compile-time struct fast path below is WRONG:
  // it would enumerate the keys in the var's INFERRED STRUCT field order (TS
  // lists spread-merged own props first, e.g. `z,x,y`), but the live host object
  // carries the runtime CopyDataProperties INSERTION order (`x,y,z`). Force the
  // runtime `__object_keys`/`values`/`entries` helper (the `!structName` arm)
  // so enumeration reflects the actual object, matching V8. Keyed on the SAME
  // `externrefAccessorVars` tag the variable sites set, so the representation
  // (externref host object) and the enumeration path stay in lockstep.
  const argIsHostObjectVar = ts.isIdentifier(arg) && ctx.externrefAccessorVars.has(arg.text);
  // Resolve struct name from the argument type
  const structName = argIsHostObjectVar ? undefined : resolveStructName(ctx, argType);
  if (!structName) {
    // Only a FRESH syntactic `{}` proves an empty own-key set. A variable or
    // parameter whose checker type has zero declared properties is not such a
    // proof: `{}` is a structural TypeScript type and the runtime object may
    // have received computed writes (Redux's `nextState[key] = value`) or may
    // have arrived from a caller with arbitrary own properties. Folding those
    // expressions to `[]` loses observable mutations. Keep the allocation-free
    // fast path for the direct literal and send every other zero-property value
    // through the runtime own-key operation.
    const isAnyOrUnknown = (argType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const tsProps = argType.getProperties?.();
    const unwrappedArg = unwrapTransparentExpression(arg);
    const isFreshEmptyLiteral = ts.isObjectLiteralExpression(unwrappedArg) && unwrappedArg.properties.length === 0;
    if (!isAnyOrUnknown && tsProps && tsProps.length === 0 && isFreshEmptyLiteral) {
      const argResult = compileExpression(ctx, fctx, arg);
      if (argResult) {
        fctx.body.push({ op: "drop" });
      }
      const elemKind = "externref";
      const vecTypeIdx = getOrRegisterVecType(ctx, elemKind);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) return null;
      fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: 0 });
      const tmpData = allocLocal(fctx, `__obj_${method}_empty_data_${fctx.locals.length}`, {
        kind: "ref",
        typeIdx: arrTypeIdx,
      });
      fctx.body.push({ op: "local.set", index: tmpData });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.get", index: tmpData });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    // Non-struct argument (any, externref, etc.) — delegate to host import
    // which calls the real JS Object.keys/values/entries at runtime.
    // The host import uses __struct_field_names + __sget_* for WasmGC structs.
    // Returns externref (a JS array) which the coercion layer converts to a
    // WasmGC vec when stored in a typed variable (e.g., const keys = ...).
    const argResult = compileExpression(ctx, fctx, arg);
    if (!argResult) return null;
    // Coerce to externref if needed
    if (argResult.kind !== "externref") {
      coerceType(ctx, fctx, argResult, { kind: "externref" });
    }
    const importName = `__object_${method}`;
    const funcIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "externref" };
    }
    // Fallback: drop arg, push null externref
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Native-first object literals can deliberately lower to the open `$Object`
  // carrier. Its struct fields are runtime storage (`props`, `count`, flags,
  // …), not the object's JavaScript own properties, so the closed-struct field
  // expansion below would filter them all and constant-fold Object.keys to
  // `[]`. Enumerate `$Object`/`$Proxy` through the native object MOP instead;
  // its `$ObjVec` result stays Wasm-owned and is converted to the caller's
  // declared array carrier by the normal native coercion path.
  const structTypeIdx = ctx.structMap.get(structName);
  const objectRuntimeTypes = ctx.objectRuntimeTypes;
  if (
    structName === "$Object" ||
    structName === "$Proxy" ||
    (objectRuntimeTypes !== undefined &&
      (structTypeIdx === objectRuntimeTypes.objectTypeIdx || structTypeIdx === objectRuntimeTypes.proxyTypeIdx))
  ) {
    ensureObjectRuntime(ctx);
    const argResult = compileExpression(ctx, fctx, arg);
    if (!argResult) return null;
    if (argResult.kind !== "externref") {
      coerceType(ctx, fctx, argResult, { kind: "externref" });
    }
    const funcIdx = ctx.funcMap.get(`__object_${method}`);
    if (funcIdx === undefined) {
      reportError(ctx, expr, `Object.${method}(): native object enumerator is unavailable`);
      return null;
    }
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "externref" };
  }

  const fields = ctx.structFields.get(structName);
  if (structTypeIdx === undefined || !fields) {
    reportError(ctx, expr, `Object.${method}(): unknown struct "${structName}"`);
    return null;
  }

  // Filter out internal fields like __tag
  const userFields = fields
    .map((f, idx) => ({ field: f, fieldIdx: idx }))
    .filter((e) => !e.field.name.startsWith("__"));

  // Per ES spec, keys/values/entries only include enumerable own properties.
  // definedPropertyFlags is keyed as "varName:propName" and updated at compile time
  // by Object.defineProperty calls. shapePropFlags is initialized with defaults after
  // compilation, so it won't reflect defineProperty updates during this pass.
  const argVarName = ts.isIdentifier(arg) ? arg.text : undefined;
  // (#3403) per-declaration key for definedPropertyFlags; argVarName stays bare
  // for the out-of-scope definePropertyReceiverKeys scan.
  const argVarKey = ts.isIdentifier(arg) ? integrityVarKey(ctx, arg) : undefined;

  // (#2746) An object that received an `Object.defineProperty` ADDING a property
  // beyond its static struct shape needs the runtime own-property set: the
  // compile-time field expansion below can only see the literal's declared
  // fields. Route `Object.keys` for such a receiver to the runtime
  // `__object_keys` helper (which reads struct fields + the defineProperty/
  // dynamic-write sidecar with the correct enumerable filter — #2746 runtime
  // fix). Gate PRECISELY on a property that is NOT a known struct field
  // (`definePropertyReceiverKeys` records every `varName:propName` define at a
  // single chokepoint, independent of the lowering path): a define that only
  // re-flags an EXISTING field is already handled by the `definedPropertyFlags`
  // filter below, so it keeps the fast compile-time vec path and does not perturb
  // the many currently-green define-on-existing-field tests. The `!structName`
  // branch above proves this helper exists in both host and standalone modes.
  const fieldNameSetForRoute = new Set(userFields.map((e) => e.field.name));
  const hasAddedDefineProp =
    method === "keys" &&
    argVarName !== undefined &&
    (() => {
      const prefix = `${argVarName}:`;
      for (const k of ctx.definePropertyReceiverKeys) {
        if (!k.startsWith(prefix)) continue;
        if (!fieldNameSetForRoute.has(k.slice(prefix.length))) return true;
      }
      return false;
    })();
  if (hasAddedDefineProp) {
    const objType = compileExpression(ctx, fctx, arg);
    if (!objType) return null;
    if (objType.kind === "ref" || objType.kind === "ref_null") {
      fctx.body.push({ op: "extern.convert_any" });
    } else if (objType.kind !== "externref") {
      coerceType(ctx, fctx, objType, { kind: "externref" });
    }
    const funcIdx = ensureLateImport(ctx, "__object_keys", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  const enumUserFields = userFields.filter((e) => {
    if (argVarName) {
      const key = `${argVarKey}:${e.field.name}`; // (#3403) per-declaration key
      const flags = ctx.definedPropertyFlags.get(key);
      if (flags !== undefined) {
        return !!(flags & PROP_FLAG_ENUMERABLE);
      }
    }
    return true; // no explicit descriptor = enumerable by default
  });

  // (#3229) Resolve the CANONICAL vec type from the call's TS return type so an
  // INLINE `.length` (which dispatches on `resolveWasmType(returnType)` — the
  // canonical `string[]`/`T[]` vec) matches. The keys/values fast-paths built a
  // vec-of-EXTERNREF whose type index the `.length` `ref.test` could not match →
  // read 0; build with the canonical arr/elem types instead. Shared across all
  // three arms; falls back to the legacy externref vec when unresolvable.
  const canonSig = ctx.checker.getResolvedSignature(expr);
  const canonRetType = canonSig ? ctx.checker.getReturnTypeOfSignature(canonSig) : undefined;
  const canonResolvedRet = canonRetType ? resolveWasmType(ctx, canonRetType) : undefined;
  const canonicalVec =
    canonResolvedRet &&
    (canonResolvedRet.kind === "ref" || canonResolvedRet.kind === "ref_null") &&
    "typeIdx" in canonResolvedRet
      ? (() => {
          const info = getVecInfo(ctx, (canonResolvedRet as { typeIdx: number }).typeIdx);
          return info ? { vecTypeIdx: (canonResolvedRet as { typeIdx: number }).typeIdx, ...info } : undefined;
        })()
      : undefined;

  if (method === "keys") {
    // Build a string[] array from the field names.
    // (#3229) Use the CANONICAL string[] vec type (so an inline `.length`
    // matches) and coerce each field-name string to its element type; fall back
    // to the legacy vec-of-externref when the return type is unresolvable. In
    // host mode the canonical element IS externref, so this is byte-identical to
    // the previous behaviour; only standalone (native-string element) changes.
    const vecTypeIdx = canonicalVec ? canonicalVec.vecTypeIdx : getOrRegisterVecType(ctx, "externref");
    const arrTypeIdx = canonicalVec ? canonicalVec.arrTypeIdx : getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) {
      reportError(ctx, expr, `Object.keys(): cannot resolve array type for string[]`);
      return null;
    }
    const elemTarget: ValType = canonicalVec ? canonicalVec.elemType : { kind: "externref" };

    // Push each enumerable field name string onto the stack, coerced to the
    // vec's element type. `compileStringLiteral` materialises a native string in
    // nativeStrings mode and an externref string constant otherwise, and handles
    // late registration when the name was not collected in the first pass (an
    // unregistered name pushed nothing → array.new_fixed underflow, #786).
    for (const entry of enumUserFields) {
      const pushed = compileStringLiteral(ctx, fctx, entry.field.name, expr) ?? { kind: "externref" };
      coerceType(ctx, fctx, pushed, elemTarget);
    }

    // Create the backing array with array.new_fixed
    const count = enumUserFields.length;
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: count });
    const tmpData = allocLocal(fctx, `__obj_keys_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: count });
    fctx.body.push({ op: "local.get", index: tmpData });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  if (method === "entries") {
    // Build [string, T][] by resolving the TS return type to get the correct
    // tuple struct and vec types that match what resolveWasmType produces.
    const argResult = compileExpression(ctx, fctx, arg);
    if (!argResult) return null;
    const objLocal = allocLocal(fctx, `__obj_entries_src_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: structTypeIdx,
    });
    fctx.body.push({ op: "local.set", index: objLocal });
    emitObjectArgNullGuard(ctx, fctx, objLocal);

    // (#3229) Reuse the hoisted return-type resolution (shared with keys/values)
    // to get the proper tuple/vec types — keeps the checker query count flat.
    const resolvedRet = canonResolvedRet;

    // The return type should be ref_null to a vec struct (Array<[string, T]>)
    // Extract the vec type index and from it the array type index and entry tuple type
    let outerVecTypeIdx: number;
    let outerArrTypeIdx: number;
    let entryTupleTypeIdx: number;

    if (resolvedRet && (resolvedRet.kind === "ref" || resolvedRet.kind === "ref_null") && "typeIdx" in resolvedRet) {
      outerVecTypeIdx = resolvedRet.typeIdx;
      outerArrTypeIdx = getArrTypeIdxFromVec(ctx, outerVecTypeIdx);
      // The array element type is a ref to the tuple struct
      // Get it from the vec's array type definition
      const arrTypeDef = ctx.mod.types[outerArrTypeIdx];
      if (
        arrTypeDef &&
        arrTypeDef.kind === "array" &&
        (arrTypeDef as any).element &&
        ((arrTypeDef as any).element.kind === "ref" || (arrTypeDef as any).element.kind === "ref_null")
      ) {
        entryTupleTypeIdx = (arrTypeDef as any).element.typeIdx;
      } else {
        // Fallback: create a tuple with [externref, externref]
        entryTupleTypeIdx = getOrRegisterTupleType(ctx, [{ kind: "externref" }, { kind: "externref" }]);
      }
    } else {
      // Fallback: create externref-based types
      entryTupleTypeIdx = getOrRegisterTupleType(ctx, [{ kind: "externref" }, { kind: "externref" }]);
      const entryElemKind = `ref_${entryTupleTypeIdx}`;
      outerVecTypeIdx = getOrRegisterVecType(ctx, entryElemKind, { kind: "ref", typeIdx: entryTupleTypeIdx });
      outerArrTypeIdx = getArrTypeIdxFromVec(ctx, outerVecTypeIdx);
    }

    if (outerArrTypeIdx < 0) {
      reportError(ctx, expr, `Object.entries(): cannot resolve outer array type`);
      return null;
    }

    // Get the tuple struct fields to know the value type
    const tupleTypeDef = ctx.mod.types[entryTupleTypeIdx];
    const tupleFields = tupleTypeDef && tupleTypeDef.kind === "struct" ? (tupleTypeDef as any).fields : undefined;
    // Field 0 is the key (string), field 1 is the value
    const valueFieldType: ValType | undefined = tupleFields?.[1]?.type;

    // Ensure union boxing imports are registered (needed for boxing primitives)
    addUnionImports(ctx);

    // For each enumerable field, create a tuple struct [key, value]
    for (const entry of enumUserFields) {
      // Push key string (field 0 of tuple)
      if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        compileNativeStringLiteral(ctx, fctx, entry.field.name);
        // If tuple expects externref for the key, convert
        if (tupleFields && tupleFields[0]?.type?.kind === "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
      } else {
        // Late-register unregistered field names so nothing underflows the
        // tuple/array construction below (#786).
        compileStringLiteral(ctx, fctx, entry.field.name, expr);
      }

      // Push value (field 1 of tuple)
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: entry.fieldIdx });

      // Coerce the struct field value to match the tuple's value field type
      const fieldKind = entry.field.type.kind;
      const targetKind = valueFieldType?.kind ?? "externref";

      if (targetKind === "externref") {
        // Box primitives to externref
        if (fieldKind === "f64") {
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
        } else if (fieldKind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
        } else if (fieldKind === "ref" || fieldKind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" });
        }
      }
      // If target is f64 and field is f64, no conversion needed
      // If target is i32 and field is i32, no conversion needed

      // Create tuple struct
      fctx.body.push({ op: "struct.new", typeIdx: entryTupleTypeIdx });
    }

    // Create outer array from the entry tuples on the stack
    const count = enumUserFields.length;
    fctx.body.push({ op: "array.new_fixed", typeIdx: outerArrTypeIdx, length: count });
    const outerData = allocLocal(fctx, `__obj_entries_data_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: outerArrTypeIdx,
    });
    fctx.body.push({ op: "local.set", index: outerData });
    fctx.body.push({ op: "i32.const", value: count });
    fctx.body.push({ op: "local.get", index: outerData });
    fctx.body.push({ op: "struct.new", typeIdx: outerVecTypeIdx });
    return { kind: "ref_null", typeIdx: outerVecTypeIdx };
  }

  // method === "values"
  // Compile the argument expression, store in a local, then struct.get each field
  const argResult = compileExpression(ctx, fctx, arg);
  if (!argResult) return null;
  const objLocal = allocLocal(fctx, `__obj_vals_src_${fctx.locals.length}`, { kind: "ref", typeIdx: structTypeIdx });
  fctx.body.push({ op: "local.set", index: objLocal });
  emitObjectArgNullGuard(ctx, fctx, objLocal);

  // (#3229) Use the CANONICAL values[] vec type (so an inline `.length` matches)
  // and coerce each field value to its element type, instead of always boxing to
  // externref and returning a vec-of-externref that the inline `.length`
  // `ref.test` could not match (→ 0). For a homogeneous `number[]` the canonical
  // element is f64 → the field value is stored unboxed; for a heterogeneous
  // `(string|number)[]` it is externref → `coerceType` boxes exactly as before.
  // Falls back to the legacy vec-of-externref when the return type is
  // unresolvable.
  const vecTypeIdx = canonicalVec ? canonicalVec.vecTypeIdx : getOrRegisterVecType(ctx, "externref");
  const arrTypeIdx = canonicalVec ? canonicalVec.arrTypeIdx : getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    reportError(ctx, expr, `Object.values(): cannot resolve array type for values[]`);
    return null;
  }
  const elemTarget: ValType = canonicalVec ? canonicalVec.elemType : { kind: "externref" };

  // Ensure union boxing imports are registered (needed when the element target
  // is externref and a primitive field must be boxed by coerceType).
  addUnionImports(ctx);

  // Push each enumerable field value onto the stack, coerced to the vec element.
  for (const entry of enumUserFields) {
    fctx.body.push({ op: "local.get", index: objLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: entry.fieldIdx });
    coerceType(ctx, fctx, entry.field.type, elemTarget);
  }

  // Create the backing array with array.new_fixed
  const count = enumUserFields.length;
  fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: count });
  const tmpData = allocLocal(fctx, `__obj_vals_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: tmpData });
  fctx.body.push({ op: "i32.const", value: count });
  fctx.body.push({ op: "local.get", index: tmpData });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

function emitRuntimePropertyIntrospection(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  key: ts.Expression,
  checkEnumerability: boolean,
): boolean {
  const importName = checkEnumerability ? "__propertyIsEnumerable" : "__hasOwnProperty";
  const predicateIdx = ensureLateImport(
    ctx,
    importName,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (predicateIdx === undefined) return false;

  const recvType = compileExpression(ctx, fctx, receiver);
  if (recvType && (recvType.kind === "ref" || recvType.kind === "ref_null")) {
    fctx.body.push({ op: "extern.convert_any" });
  } else if (recvType && recvType.kind !== "externref") {
    coerceType(ctx, fctx, recvType, { kind: "externref" });
  }
  const keyType = compileExpression(ctx, fctx, key, { kind: "externref" });
  if (keyType && keyType.kind !== "externref") {
    coerceType(ctx, fctx, keyType, { kind: "externref" });
  }
  fctx.body.push({ op: "call", funcIdx: predicateIdx });
  return true;
}

/**
 * Compile obj.hasOwnProperty(key) / obj.propertyIsEnumerable(key).
 * For WasmGC structs all own fields are enumerable, so both methods behave
 * identically: return true iff `key` names an own field of the struct type.
 *
 * Static resolution (string literal arg): constant fold to i32.const 0/1.
 * Dynamic resolution: runtime string comparison against known field names.
 */
export function compilePropertyIntrospection(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  expr: ts.CallExpression,
): InnerResult {
  const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const receiverWasm = resolveWasmType(ctx, receiverType);

  // (#3021 RC1) The test262 harness rewrites
  // `Object.prototype.hasOwnProperty.call(X, k)` to `(X).hasOwnProperty(k)` —
  // a *parenthesized* receiver. The AST-based receiver classification below
  // (prototype-vs-instance, and the #1334/#2726 needsRuntime var-name gate)
  // must see through those parens, or `(C.prototype).hasOwnProperty(...)` is
  // misclassified as an instance receiver and constant-folds the INVERTED
  // answer ('field'→true, 'method'→false). The type checker (`receiverType`)
  // already resolves through parens; this local gives the AST checks the same
  // paren-transparency.
  let recvExpr: ts.Expression = propAccess.expression;
  while (ts.isParenthesizedExpression(recvExpr)) recvExpr = recvExpr.expression;

  // For externref/any receivers (e.g. Object.create result), delegate to runtime
  // since we can't statically know their properties
  if (receiverWasm.kind === "externref") {
    const isHOP = propAccess.name.text === "hasOwnProperty";
    const importName = isHOP ? "__hasOwnProperty" : "__propertyIsEnumerable";
    const hopIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
    if (hopIdx !== undefined) {
      // Push receiver. `receiverWasm` is the receiver's STATIC type, which
      // `resolveWasmType` reports as `externref` for a function/method type
      // (e.g. `RegExp.prototype.test`). But the member access actually emits a
      // concrete function-object struct `(ref $fn)`, not an externref — so the
      // pushed value must still be coerced (`extern.convert_any`) to match the
      // helper's `externref` param. Without this the receiver reached the call
      // as a raw `struct.new` and produced `call[0] expected type externref,
      // found struct.new of type (ref …)` invalid Wasm in standalone (#2934).
      const recvType = compileExpression(ctx, fctx, propAccess.expression);
      if (recvType && recvType.kind !== "externref") {
        coerceType(ctx, fctx, recvType, { kind: "externref" });
      }
      // Push key argument (or null if missing)
      if (expr.arguments[0]) {
        // (#3368) Preserve a symbol key as a real JS Symbol. ESSymbol values
        // use an unbranded i32 carrier; the externref expected-type hint is
        // what selects __box_symbol instead of the generic __box_number.
        const argType = compileExpression(ctx, fctx, expr.arguments[0], { kind: "externref" });
        if (argType && argType.kind !== "externref") {
          coerceType(ctx, fctx, argType, { kind: "externref" });
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: hopIdx });
      return { kind: "i32", boolean: true };
    }
  }

  // (#2746) Array-exotic own index keys. An Array compiles to a `__vec_*` struct
  // whose integer-index elements are own (enumerable) data properties — NOT
  // static WasmGC struct fields, so the field-name logic below would wrongly
  // answer `false` for `arr.hasOwnProperty(0)` (e.g. on the result array of
  // `Object.keys`). The answer is `(index in-bounds and the slot is present) OR
  // the index was added to the runtime sidecar (e.g. `Object.defineProperty(arr,
  // "0", …)` on an empty array)` — the OR with the host/native `__hasOwnProperty`
  // covers the sidecar case the vec data alone can't see.
  //
  // We only run the vec bounds branch for REFERENCE-element vecs (string/object
  // arrays): there a hole is a distinguishable `ref.null`, so `index < length AND
  // data[index] != null` is exact. NUMERIC-element vecs densify holes to `0`/`NaN`
  // (indistinguishable) AND a `defineProperties` length-shrink leaves stale slots,
  // so a bounds check there would mis-report holes/shrunk indices as own — those
  // keep the legacy field-name path. The result array of `Object.keys`/
  // `getOwnPropertyNames` is an externref string vec, so the targeted tests are
  // covered. Only a statically-resolvable canonical index is handled.
  if (propAccess.name.text === "hasOwnProperty" && (receiverWasm.kind === "ref" || receiverWasm.kind === "ref_null")) {
    const vecTypeIdx = (receiverWasm as { typeIdx: number }).typeIdx;
    const vecInfo = getVecInfo(ctx, vecTypeIdx);
    const elemIsRef =
      vecInfo !== null &&
      (vecInfo.elemType.kind === "externref" ||
        vecInfo.elemType.kind === "ref" ||
        vecInfo.elemType.kind === "ref_null" ||
        vecInfo.elemType.kind === "anyref" ||
        vecInfo.elemType.kind === "eqref");
    const keyArg = expr.arguments[0];
    let staticKey: string | null = null;
    if (keyArg) {
      if (ts.isStringLiteral(keyArg) || ts.isNumericLiteral(keyArg)) staticKey = keyArg.text;
      else {
        const at = ctx.checker.getTypeAtLocation(keyArg);
        if (at.isStringLiteral()) staticKey = at.value;
        else if (at.isNumberLiteral()) staticKey = String(at.value);
      }
    }
    if (!elemIsRef && keyArg && staticKey !== null && provesDenseLiteralOwnIndex(ctx, recvExpr, expr, staticKey)) {
      // The optimized answer must retain ordinary evaluation order even though
      // the presence result is statically known: evaluate receiver, then key,
      // discard both values, and produce the boolean true.
      const recv = compileExpression(ctx, fctx, propAccess.expression);
      if (recv !== null) fctx.body.push({ op: "drop" });
      const keyType = compileExpression(ctx, fctx, keyArg);
      if (keyType !== null) fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32", boolean: true };
    }
    // (#4491 wave-5 T2) A canonical INDEX key on a REFERENCE-element vec.
    //
    // #2746 answered this statically: `present := index < length && data[index]
    // != null`, OR-ed with the native predicate to catch sidecar additions. The
    // bounds half rests on "a hole is a distinguishable `ref.null`", and that is
    // no longer true — `delete arr[0]` records the hole by flagging the #3251
    // COMPANION entry and leaves the vec slot alone, so the static half read
    // `present = 1` and the OR made it unconditionally true. Measured:
    //
    //   var a = ["x", "y"]; delete a[0];
    //   a.hasOwnProperty("0")   // true — while `0 in a`, `for…in`,
    //                           // getOwnPropertyNames and gOPD all said absent
    //
    // The native predicate alone is now correct in every direction (its #4010
    // S3 vec prologue consults `__vec_gopd` then the bag). Verified through an
    // opaque receiver, which forces exactly that path: present index true,
    // out-of-bounds false, deleted index false, `Object.defineProperty`-added
    // index true, numeric-element arrays likewise. So the static bounds
    // computation is dropped rather than patched — it can only re-derive what
    // the predicate already knows, and this is the second way it has been
    // wrong. NUMERIC-element vecs are untouched: they keep the
    // `provesDenseLiteralOwnIndex` constant fold above and the legacy path
    // below, exactly as before.
    if (elemIsRef && keyArg && staticKey !== null && _isCanonicalArrayIndexString(staticKey)) {
      const recv = compileExpression(ctx, fctx, propAccess.expression);
      if (recv === null) return null;
      if (recv.kind === "ref" || recv.kind === "ref_null") {
        fctx.body.push({ op: "extern.convert_any" });
      } else if (recv.kind !== "externref") {
        coerceType(ctx, fctx, recv, { kind: "externref" });
      }
      const keyT = compileExpression(ctx, fctx, keyArg, { kind: "externref" });
      if (keyT && keyT.kind !== "externref") coerceType(ctx, fctx, keyT, { kind: "externref" });
      const hopIdx2 = ensureLateImport(
        ctx,
        "__hasOwnProperty",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (hopIdx2 !== undefined) {
        fctx.body.push({ op: "call", funcIdx: hopIdx2 });
        return { kind: "i32", boolean: true };
      }
      // No predicate available — drop the args and keep the pre-#4491 "absent".
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32", boolean: true };
    }
    // (#4491) A NON-index static key on an array receiver — "4294967295"
    // (2^32-1 is a valid NAMED property but not an array index, §6.1.7) or a
    // named expando — is RUNTIME state: `Object.defineProperty(arr, k, …)`
    // stores it in the #3251 companion / #3537 bag, which the static
    // struct-field logic below cannot see (it answered a compile-time false
    // while gOPD/`in` both found the entry). Route to the native predicate,
    // whose vec prologue consults gOPD + bag. `length` keeps the static path:
    // the vec gOPD arm deliberately bails for it.
    if (
      vecInfo !== null &&
      keyArg &&
      staticKey !== null &&
      staticKey !== "length" &&
      !_isCanonicalArrayIndexString(staticKey)
    ) {
      const recv = compileExpression(ctx, fctx, propAccess.expression);
      if (recv === null) return null;
      if (recv.kind === "ref" || recv.kind === "ref_null") {
        fctx.body.push({ op: "extern.convert_any" });
      } else if (recv.kind !== "externref") {
        coerceType(ctx, fctx, recv, { kind: "externref" });
      }
      const keyT = compileExpression(ctx, fctx, keyArg, { kind: "externref" });
      if (keyT && keyT.kind !== "externref") coerceType(ctx, fctx, keyT, { kind: "externref" });
      const hopDynIdx = ensureLateImport(
        ctx,
        "__hasOwnProperty",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (hopDynIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: hopDynIdx });
        return { kind: "i32", boolean: true };
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32", boolean: true };
    }
    // else fall through to the generic struct-field path (legacy behaviour).
  }

  // Build a set of private member names (without '#') from the TS type.
  // Private fields (#x) are stored in the struct with the '#' stripped, but
  // should never be reported as own properties via hasOwnProperty("x").
  const privateNames = new Set<string>();
  for (const prop of receiverType.getProperties()) {
    if (prop.name.startsWith("#")) {
      privateNames.add(prop.name.slice(1));
    }
  }

  // Collect struct field names from the Wasm struct definition, excluding:
  // - Internal fields (e.g. __tag) that are compiler-generated
  // - Fields that correspond to private members (#-prefixed in TS source)
  let structFieldNames: string[] | null = null;
  if (receiverWasm.kind === "ref" || receiverWasm.kind === "ref_null") {
    const structDef = ctx.mod.types[(receiverWasm as { typeIdx: number }).typeIdx];
    if (structDef?.kind === "struct") {
      structFieldNames = structDef.fields
        .map((f) => f.name)
        .filter((n): n is string => n !== undefined && !n.startsWith("__") && !privateNames.has(n));
    }
  }

  // Detect if receiver is a prototype object (e.g. C.prototype) vs an instance
  // vs a class constructor.  Each has different "own" property semantics:
  //   - Prototype:   methods + accessors are own; instance fields are NOT
  //   - Instance:    instance fields are own; methods are NOT (they're on prototype)
  //   - Constructor: static members are own; instance members are NOT
  const isPrototypeReceiver = ts.isPropertyAccessExpression(recvExpr) && recvExpr.name.text === "prototype";

  // A constructor type (typeof C) has construct signatures; an instance does not.
  const isConstructorReceiver = !isPrototypeReceiver && receiverType.getConstructSignatures().length > 0;

  // For prototype/constructor receivers, the struct definition represents the
  // instance layout — its fields are NOT own properties of the prototype or
  // constructor object.  Clear structFieldNames so only tsProps drives the result.
  if (isPrototypeReceiver || isConstructorReceiver) {
    structFieldNames = null;
  }

  // Collect own properties from the TypeScript type system.
  // Filtering depends on what kind of object the receiver is.
  const tsProps = new Set<string>();
  const nonEnumerableTsProps = new Set<string>();
  for (const prop of receiverType.getProperties()) {
    // Skip private identifiers — they start with '#' and can't be matched by string keys
    if (prop.name.startsWith("#")) continue;

    const decls = prop.getDeclarations();
    const isMethod =
      decls && decls.length > 0 && decls.every((d) => ts.isMethodDeclaration(d) || ts.isMethodSignature(d));
    const isAccessor =
      decls && decls.length > 0 && decls.every((d) => ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d));

    if (isPrototypeReceiver) {
      // On C.prototype: only methods and accessors are own properties.
      // Instance data fields are NOT on the prototype (set in constructor).
      if (!isMethod && !isAccessor) continue;
      nonEnumerableTsProps.add(prop.name);
    } else if (isConstructorReceiver) {
      // On the constructor (typeof C): only static members are own.
      if (decls && decls.length > 0) {
        const hasStatic = decls.some((d) =>
          ts.canHaveModifiers(d)
            ? (ts.getModifiers(d as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
            : false,
        );
        if (!hasStatic) continue;
      }
      if (isMethod || isAccessor) nonEnumerableTsProps.add(prop.name);
    } else {
      // On an instance: skip methods and accessors — they live on the prototype.
      if (isMethod || isAccessor) continue;
    }

    tsProps.add(prop.name);
  }

  // Add synthetic own properties for callable types (functions/constructors).
  // ES spec: all functions have own "length" and "name" properties.
  // Non-arrow functions also have "prototype" as an own property.
  const callSigs = receiverType.getCallSignatures();
  const constructSigs = receiverType.getConstructSignatures();
  if (callSigs.length > 0 || constructSigs.length > 0) {
    tsProps.add("length");
    tsProps.add("name");
    // Constructors and non-arrow functions have "prototype"
    if (constructSigs.length > 0) {
      tsProps.add("prototype");
    }
    // Check if receiver is a class — classes always have "prototype"
    const symbol = receiverType.getSymbol();
    if (symbol && symbol.flags & ts.SymbolFlags.Class) {
      tsProps.add("prototype");
    }
  }

  // Get the first argument (the property name to check)
  const arg = expr.arguments[0];
  if (!arg) {
    // No argument — hasOwnProperty() with no args returns false in JS
    // Compile receiver for side effects
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32", boolean: true };
  }

  // Try to resolve the key at compile time
  let staticKey: string | null = null;
  if (ts.isStringLiteral(arg)) {
    staticKey = arg.text;
  } else if (ts.isNumericLiteral(arg)) {
    staticKey = arg.text;
  } else {
    // Check if TS can resolve the type to a string literal
    const argTsType = ctx.checker.getTypeAtLocation(arg);
    if (argTsType.isStringLiteral()) {
      staticKey = argTsType.value;
    }
  }

  const isPropertyIsEnumerable = propAccess.name.text === "propertyIsEnumerable";

  if (staticKey !== null) {
    // Static resolution: check if the key is a known own property
    const hasInStruct = structFieldNames !== null && structFieldNames.includes(staticKey);
    const hasInTs = tsProps.has(staticKey);
    const has = hasInStruct || hasInTs;

    // (#1334) If `Object.defineProperty` has been called on this variable
    // for any property — or `delete` could have removed a struct field via
    // the runtime tombstone (any time the struct shape includes the queried
    // key) — the compile-time answer can disagree with the runtime state.
    // Route through the runtime helper so the tombstone (`__delete_property`
    // path) and any sidecar accessor entries are consulted.
    //
    // The signals we use are `ctx.definedPropertyFlags` AND
    // `ctx.sidecarDefinedPropertyKeys`: both are populated only when
    // `Object.defineProperty` is statically observed, so we only pay the
    // runtime call cost on objects that have actually been mutated.
    // Anonymous receivers (e.g. `({}).hasOwnProperty(...)`) skip this path.
    //
    // (#2726) `definedPropertyFlags` is populated ONLY for *inline* object-literal
    // descriptors (`defineProperty(o, k, { value: 1 })`). The dominant ES5
    // `var d = { value: 1, configurable: true }; defineProperty(o, k, d)` shape
    // (the `15.2.3.6-3-*` cluster) routes through `emitDefinePropertyDescRuntime`,
    // which records the key in `sidecarDefinedPropertyKeys` instead. Without
    // consulting that set, `hasOwnProperty` constant-folds to `true` because the
    // queried key is in the (defineProperty-widened) struct shape, ignoring a
    // subsequent configurable `delete` that tombstoned it — the root of the
    // `11.4.1-4.a-1/-2`, `11.4.1-4-a-4-s` failures.
    const recvVarName = ts.isIdentifier(recvExpr) ? recvExpr.text : undefined;
    // (#3403) per-declaration key for definedPropertyFlags; recvVarName/prefix
    // stay bare for the out-of-scope definePropertyReceiverKeys/sidecar scans.
    const recvVarKey = ts.isIdentifier(recvExpr) ? integrityVarKey(ctx, recvExpr) : undefined;
    let needsRuntime = false;
    if (recvVarName) {
      const prefix = `${recvVarName}:`;
      const dpfPrefix = `${recvVarKey}:`; // (#3403) per-declaration key
      // (#2726) Pre-existing signal (mode-agnostic): an inline object-literal
      // descriptor recorded in `definedPropertyFlags`. Routing on this in BOTH
      // modes preserves origin/main behavior.
      for (const k of ctx.definedPropertyFlags.keys()) {
        if (k.startsWith(dpfPrefix)) {
          needsRuntime = true;
          break;
        }
      }
      // (#2726 standalone fix) The broad new signals — `definePropertyReceiverKeys`
      // (every lowering path) and `sidecarDefinedPropertyKeys` (runtime-descriptor
      // route) — route to the `__hasOwnProperty` / `__propertyIsEnumerable` helper.
      // In HOST mode that helper consults the descriptor/tombstone sidecar and
      // answers correctly. In STANDALONE mode the wasm-native helper does NOT
      // report a `defineProperty`-added struct-shape property as own (it returns
      // false), so routing there REGRESSES every `defineProperty(o,k,…)` +
      // `o.hasOwnProperty(k)` test (the 19-file standalone-floor park on PR #2177:
      // built-ins/Object/{defineProperty,prototype/hasOwnProperty,getOwnPropertyNames}).
      // Gate these two broad signals to host mode; standalone keeps the
      // const-fold (correct for the no-delete case, unchanged from origin/main).
      //
      // (#4187) …EXCEPT when this very receiver is also deleted from. The
      // awaited substrate has landed (#1629 S6 / #2042 S4 real `$Object`
      // entries, the #3468/#3537/#4010 carrier bags, #4098 tombstones, the
      // closed-struct field arms), but widening the gate WHOLESALE is still the
      // PR #2177 park — so admit only receivers where the fold is unsound. The
      // fold answers from the defineProperty-widened struct SHAPE, which no
      // runtime `delete` retracts: with no delete the two agree and folding
      // stays (byte-identical, cheaper); with one they diverge, as in
      // `Object/defineProperty/15.2.3.6-3-86-1.js` where `delete obj.property`
      // succeeded everywhere except the folded `hasOwnProperty` call site.
      // Pre-scan, not record-as-you-compile: the repro's first read precedes the
      // delete textually and must still answer `true`, so both reads must come
      // from the same mechanism. See `scanModuleMemberDeletes`.
      const standaloneDeleteObserved =
        ctx.standalone && recvVarName !== undefined && (ctx.memberDeleteReceiverNames?.has(recvVarName) ?? false);
      if (!needsRuntime && (!ctx.standalone || standaloneDeleteObserved)) {
        for (const k of ctx.definePropertyReceiverKeys) {
          if (k.startsWith(prefix)) {
            needsRuntime = true;
            break;
          }
        }
        if (!needsRuntime) {
          for (const k of ctx.sidecarDefinedPropertyKeys) {
            if (k.startsWith(prefix)) {
              needsRuntime = true;
              break;
            }
          }
        }
      }
    }

    if (needsRuntime && (receiverWasm.kind === "ref" || receiverWasm.kind === "ref_null")) {
      if (emitRuntimePropertyIntrospection(ctx, fctx, propAccess.expression, arg, isPropertyIsEnumerable)) {
        return { kind: "i32", boolean: true };
      }
    }

    // For propertyIsEnumerable, also check definedPropertyFlags for updated enumerability.
    // definedPropertyFlags is keyed as "varName:propName" and is the authoritative source
    // for compile-time flag updates from Object.defineProperty calls.
    let result = has ? 1 : 0;
    if (isPropertyIsEnumerable && has) {
      if (recvVarName) {
        const key = `${recvVarKey}:${staticKey}`; // (#3403) per-declaration key
        const flags = ctx.definedPropertyFlags.get(key);
        if (flags !== undefined) {
          result = flags & PROP_FLAG_ENUMERABLE ? 1 : 0;
        } else if (nonEnumerableTsProps.has(staticKey)) {
          result = 0;
        }
      } else if (nonEnumerableTsProps.has(staticKey)) {
        result = 0;
      }
    }

    // (#3920/#4225) Replace an unsound folded constant — see closed-struct-presence.ts.
    if (emitHasOwnPresence(ctx, fctx, receiverWasm, structFieldNames, staticKey, propAccess, arg, result)) {
      return { kind: "i32", boolean: true };
    }

    // (#4062) A named expando on an ARRAY receiver lives in the #3537 bag, which
    // no part of the fold above can see — the vec's field list is
    // `["length","data"]`. Only a folded `0` is routed, so every affirmative
    // answer stays byte-identical. See vec-named-key-presence.ts.
    if (vecNamedKeyNeedsRuntime(ctx, receiverWasm, staticKey, result)) {
      if (emitRuntimePropertyIntrospection(ctx, fctx, propAccess.expression, arg, isPropertyIsEnumerable)) {
        return { kind: "i32", boolean: true };
      }
    }

    // Compile receiver and argument for side effects, then drop
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType) {
      fctx.body.push({ op: "drop" });
    }
    const argResultType = compileExpression(ctx, fctx, arg);
    if (argResultType) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: result });
    return { kind: "i32", boolean: true };
  }

  // Dynamic keys cannot be answered from the declared struct shape alone.
  // Ordinary computed writes live in the host sidecar / standalone carrier
  // bag, and deletes can tombstone a declared field. Route the same concrete
  // struct receiver through the shared runtime/native predicate used by
  // Object.hasOwn so all three sources of own-property state agree. (#4298)
  if (receiverWasm.kind === "ref" || receiverWasm.kind === "ref_null") {
    if (emitRuntimePropertyIntrospection(ctx, fctx, propAccess.expression, arg, isPropertyIsEnumerable)) {
      return { kind: "i32", boolean: true };
    }
  }

  // Fallback for a receiver whose concrete runtime predicate is unavailable:
  // compare the key against the statically known field names.
  const allFieldNames = new Set<string>();
  if (structFieldNames) {
    for (const f of structFieldNames) allFieldNames.add(f);
  }
  for (const p of tsProps) allFieldNames.add(p);

  const comparableFieldNames = isPropertyIsEnumerable
    ? new Set([...allFieldNames].filter((name) => !nonEnumerableTsProps.has(name)))
    : allFieldNames;

  if (comparableFieldNames.size > 0) {
    // Ensure all field name strings are registered as globals
    for (const fieldName of comparableFieldNames) {
      if (!ctx.stringGlobalMap.has(fieldName)) {
        addStringConstantGlobal(ctx, fieldName);
      }
    }

    // Compile receiver for side effects, drop it
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    if (recvType) {
      fctx.body.push({ op: "drop" });
    }

    // Compile the key argument
    const keyType = compileExpression(ctx, fctx, arg);
    if (keyType) {
      const equalsIdx = ctx.funcMap.get("__str_eq") ?? ctx.funcMap.get("string_equals");
      const jsStrEquals = ctx.mod.imports.findIndex((imp) => imp.module === "wasm:js-string" && imp.name === "equals");
      const eqFunc = jsStrEquals >= 0 ? jsStrEquals : equalsIdx;
      if (eqFunc !== undefined && eqFunc >= 0) {
        const keyLocal = allocLocal(fctx, `__hop_key_${fctx.locals.length}`, keyType);
        fctx.body.push({ op: "local.set", index: keyLocal });
        // Start with false (0)
        fctx.body.push({ op: "i32.const", value: 0 });
        for (const fieldName of comparableFieldNames) {
          const strGlobal = ctx.stringGlobalMap.get(fieldName);
          if (strGlobal !== undefined) {
            fctx.body.push({ op: "local.get", index: keyLocal });
            fctx.body.push({ op: "global.get", index: strGlobal });
            fctx.body.push({ op: "call", funcIdx: eqFunc });
            fctx.body.push({ op: "i32.or" });
          }
        }
        return { kind: "i32", boolean: true };
      }
    }
  }

  // Fallback: compile both sides for side effects, return false
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType) {
    fctx.body.push({ op: "drop" });
  }
  const argResultType = compileExpression(ctx, fctx, arg);
  if (argResultType) {
    fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "i32.const", value: 0 });
  return { kind: "i32", boolean: true };
}
