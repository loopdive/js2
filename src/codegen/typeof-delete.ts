// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * typeof, delete, instanceof, and RegExp literal compilation.
 * Extracted from expressions.ts (issue #688 step 5).
 */
import { ts } from "../ts-api.js";
import { isBooleanType, isStringType, isSymbolType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { reportError } from "./context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts, shiftLateImportIndices } from "./expressions/late-imports.js";
import { resolveStructName } from "./expressions/misc.js";
import { addUnionImports, parseRegExpLiteral, resolveWasmType } from "./index.js";
import { compileStandaloneRegExpLiteral } from "./regexp-standalone.js";
import { addImport } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import type { InnerResult } from "./shared.js";
import { compileExpression, ensureAnyHelpers, isAnyValue } from "./shared.js";
import { compileStringLiteral } from "./string-ops.js";
import { findWithBinding } from "./with-scope.js";

// ── Delete expression ─────────────────────────────────────────────────

/**
 * Emit the sentinel (undefined) value for a given Wasm field type.
 * - ref/ref_null: ref.null of the struct's type index
 * - externref: ref.null.extern
 * - f64: NaN (chosen as sentinel since deleted numeric props return undefined -> NaN in numeric context)
 * - i32: 0
 */
function emitDeleteSentinel(fctx: FunctionContext, fieldType: ValType): void {
  switch (fieldType.kind) {
    case "ref":
    case "ref_null":
      fctx.body.push({ op: "ref.null", typeIdx: (fieldType as { typeIdx: number }).typeIdx });
      break;
    case "externref":
      fctx.body.push({ op: "ref.null.extern" });
      break;
    case "f64":
      fctx.body.push({ op: "f64.const", value: NaN });
      break;
    case "i32":
      fctx.body.push({ op: "i32.const", value: 0 });
      break;
    default:
      fctx.body.push({ op: "ref.null.extern" });
      break;
  }
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

  if (ts.isIdentifier(inner)) {
    // Variables are not deletable — return false
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

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
      (fctx.mappedArgsInfo.unmappedIndices ??= new Set<number>()).add(argIndex);
    }
  }

  // Try to resolve struct type and field for property access: delete obj.prop
  if (ts.isPropertyAccessExpression(inner)) {
    const objType = ctx.checker.getTypeAtLocation(inner.expression);
    let typeName = resolveStructName(ctx, objType);
    if (!typeName && ts.isIdentifier(inner.expression)) {
      typeName = ctx.widenedVarStructMap.get(inner.expression.text);
    }
    if (typeName) {
      const structTypeIdx = ctx.structMap.get(typeName);
      const fields = ctx.structFields.get(typeName);
      const fieldName = ts.isPrivateIdentifier(inner.name) ? "__priv_" + inner.name.text.slice(1) : inner.name.text;
      if (structTypeIdx !== undefined && fields) {
        const fieldIdx = fields.findIndex((f) => f.name === fieldName);
        if (fieldIdx !== -1 && fields[fieldIdx]!.mutable) {
          const fieldType = fields[fieldIdx]!.type;
          // (#1334) Compile the receiver once, save to a local, then both
          //   (a) set the struct field to a sentinel (legacy fast-path), and
          //   (b) clear any sidecar descriptor entry via `__delete_property`.
          // Without (b), `Object.defineProperty(obj, "x", { configurable: true })`
          // (which stores a descriptor-only entry in `_wasmPropDescs`) would
          // leave `obj.hasOwnProperty("x")` returning true after `delete obj.x`,
          // because `__hasOwnProperty` consults the descriptor map.
          const recvType = compileExpression(ctx, fctx, inner.expression);
          if (!recvType) {
            fctx.body.push({ op: "i32.const", value: 1 });
            return { kind: "i32" };
          }
          // Save the receiver so we can re-push it for the sidecar call.
          const recvLocal = allocLocal(fctx, `__del_recv_${fctx.locals.length}`, recvType);
          fctx.body.push({ op: "local.set", index: recvLocal });

          // (a) struct.set with sentinel — restores the field to undefined.
          fctx.body.push({ op: "local.get", index: recvLocal });
          emitDeleteSentinel(fctx, fieldType);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });

          // (b) Sidecar / descriptor-map cleanup. Push receiver as externref +
          // key as externref, then call __delete_property and RETURN its result
          // (#1821). The helper reports `false` (0) for a non-configurable
          // descriptor entry (ECMA-262 §13.5.1 step 5) and `true` (1) otherwise
          // — including a plain struct field with no descriptor (deletable).
          // The previous code dropped the result and hardcoded `true`, so
          // `delete obj.nonConfigurable` wrongly returned `true`.
          fctx.body.push({ op: "local.get", index: recvLocal });
          if (recvType.kind === "ref" || recvType.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" } as Instr);
          } else if (recvType.kind !== "externref") {
            // Non-struct numeric/bool — skip sidecar cleanup. struct.set above
            // suffices and __delete_property doesn't apply.
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "i32.const", value: 1 });
            return { kind: "i32" };
          }
          const keyResult = compileStringLiteral(ctx, fctx, fieldName, inner.name);
          if (keyResult) {
            const delIdx = ensureLateImport(
              ctx,
              "__delete_property",
              [{ kind: "externref" }, { kind: "externref" }],
              [{ kind: "i32" }],
            );
            flushLateImportShifts(ctx, fctx);
            if (delIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: delIdx });
              // Leave __delete_property's i32 result on the stack as the
              // `delete` expression value (spec-correct configurability check).
              return { kind: "i32" };
            }
            // No host import (standalone): drop receiver + key; struct.set
            // already cleared the field, so report `true`.
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "drop" });
          } else {
            // String literal failed (shouldn't happen for a static field name);
            // discard the receiver/key and continue.
            fctx.body.push({ op: "drop" });
          }
          fctx.body.push({ op: "i32.const", value: 1 });
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
      typeName = ctx.widenedVarStructMap.get(inner.expression.text);
    }
    if (typeName) {
      const structTypeIdx = ctx.structMap.get(typeName);
      const fields = ctx.structFields.get(typeName);
      const fieldName = inner.argumentExpression.text;
      if (structTypeIdx !== undefined && fields) {
        const fieldIdx = fields.findIndex((f) => f.name === fieldName);
        if (fieldIdx !== -1 && fields[fieldIdx]!.mutable) {
          const fieldType = fields[fieldIdx]!.type;
          // (#1821) Mirror the property-access arm above: clear the struct
          // field AND the sidecar/descriptor entry, then return
          // __delete_property's result. The previous element-access arm only
          // did the struct.set + hardcoded `true`, so `delete obj["x"]`
          // diverged from `delete obj.x` — it left the `Object.defineProperty`
          // descriptor in place (`hasOwnProperty("x")` stayed true) and
          // reported `true` even for a non-configurable property.
          const recvType = compileExpression(ctx, fctx, inner.expression);
          if (!recvType) {
            fctx.body.push({ op: "i32.const", value: 1 });
            return { kind: "i32" };
          }
          const recvLocal = allocLocal(fctx, `__del_recv_${fctx.locals.length}`, recvType);
          fctx.body.push({ op: "local.set", index: recvLocal });

          // (a) struct.set with sentinel — restores the field to undefined.
          fctx.body.push({ op: "local.get", index: recvLocal });
          emitDeleteSentinel(fctx, fieldType);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });

          // (b) sidecar / descriptor-map cleanup, returning the helper result.
          fctx.body.push({ op: "local.get", index: recvLocal });
          if (recvType.kind === "ref" || recvType.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" } as Instr);
          } else if (recvType.kind !== "externref") {
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "i32.const", value: 1 });
            return { kind: "i32" };
          }
          const keyResult = compileStringLiteral(ctx, fctx, fieldName, inner.argumentExpression);
          if (keyResult) {
            const delIdx = ensureLateImport(
              ctx,
              "__delete_property",
              [{ kind: "externref" }, { kind: "externref" }],
              [{ kind: "i32" }],
            );
            flushLateImportShifts(ctx, fctx);
            if (delIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: delIdx });
              return { kind: "i32" };
            }
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "drop" });
          } else {
            fctx.body.push({ op: "drop" });
          }
          fctx.body.push({ op: "i32.const", value: 1 });
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
      fctx.body.push({ op: "extern.convert_any" } as Instr);
    } else if (recvType.kind !== "externref") {
      // Other shapes (f64/i32) — drop and return false; primitives have no
      // own properties to delete.
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    }

    // Compile the key as externref. Property access uses the static name;
    // element access uses the bracket expression (any externref).
    if (ts.isPropertyAccessExpression(inner)) {
      const keyName = ts.isPrivateIdentifier(inner.name) ? `__priv_${inner.name.text.slice(1)}` : inner.name.text;
      const keyResult = compileStringLiteral(ctx, fctx, keyName, inner.name);
      if (!keyResult) {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
    } else {
      // ElementAccess — compile argumentExpression as externref so the
      // runtime helper can stringify or treat as Symbol.
      const keyType = compileExpression(ctx, fctx, inner.argumentExpression, { kind: "externref" });
      if (keyType === null) {
        fctx.body.push({ op: "drop" });
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
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
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
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    }
    fctx.body.push({ op: "call", funcIdx: delIdx });
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
  if (ctx.standalone) {
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
      } as Instr,
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
 * Compile `typeof x` as a standalone expression that returns a type string (externref).
 * For statically known types, emits the string constant directly.
 * For externref/union types, calls the __typeof host helper.
 */
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
      const withBinding = findWithBinding(fctx, ident.text);
      if (withBinding) {
        return compileStringLiteral(ctx, fctx, staticTypeofForWasmType(withBinding.field.type));
      }
      const sym = ctx.checker.getSymbolAtLocation(ident);
      const hasValueDecl = !!sym?.valueDeclaration;
      if (!hasValueDecl) {
        return compileStringLiteral(ctx, fctx, "undefined");
      }
    }
  }

  const tsType = ctx.checker.getTypeAtLocation(operand);

  // Try static resolution first via the shared helper
  const staticResult = staticTypeofForType(ctx, tsType);
  if (staticResult !== null) {
    return compileStringLiteral(ctx, fctx, staticResult);
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
    const boxIdx = ctx.funcMap.get("__box_boolean");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else if (operandType.kind === "ref" || operandType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" } as Instr);
  }

  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}

function staticTypeofForWasmType(type: ValType): string {
  if (type.kind === "i32") return "boolean";
  if (type.kind === "f32" || type.kind === "f64" || type.kind === "i64") return "number";
  return "object";
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
      const withBinding = findWithBinding(fctx, ident.text);
      if (withBinding) {
        const actual = staticTypeofForWasmType(withBinding.field.type);
        const matches = actual === stringLiteral;
        const result = isEq ? (matches ? 1 : 0) : matches ? 0 : 1;
        fctx.body.push({ op: "i32.const", value: result });
        return { kind: "i32" };
      }
      const sym = ctx.checker.getSymbolAtLocation(ident);
      if (!sym?.valueDeclaration) {
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
  if (ts.isIdentifier(operand)) {
    const localIdx = fctx.localMap.get(operand.text);
    if (localIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: localIdx });
    } else {
      // Try other resolution paths
      const valType = compileExpression(ctx, fctx, operand);
      if (!valType) return null;
    }
  } else {
    const valType = compileExpression(ctx, fctx, operand);
    if (!valType) return null;
  }

  // Call the typeof helper
  fctx.body.push({ op: "call", funcIdx });

  // If !== comparison, negate the result
  if (isNeq) {
    fctx.body.push({ op: "i32.eqz" });
  }

  return { kind: "i32" };
}
