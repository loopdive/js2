// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#5312) A class field that is DECLARED but never given a value — `m!: () =>
// number`, `m?: () => number`, or a bare `m: T` under a non-strict config — is
// still INSTALLED on the instance by `useDefineForClassFields`, holding the
// JavaScript value `undefined`. Its WasmGC struct slot, though, is a nullable
// reference whose construction default is `ref.null`, and the checker reports
// the declared type (`() => number`), which does not admit `undefined`. Every
// observation site therefore folded against the declaration instead of the
// value:
//
//     class B { m!: () => number; f() { return this.m === undefined ? 0 : this.m(); } }
//     new B().f();          // node: 0        js2 (base): traps in `this.m()`
//
// The two halves of the correct mechanism already exist in this compiler:
//
//   * `FieldDef.undefinedDefault` makes an uninitialised OPTIONAL NUMERIC slot
//     hold the exact f64 `undefined` sentinel instead of 0, and
//     `property-nullish-read.ts` routes PRIVATE names through the typed struct
//     read specifically so that sentinel survives to the comparison. Measured
//     on origin/main 2ca2591652: `class B { #n?: number }` +
//     `this.#n === undefined` is already TRUE on both lanes.
//   * The nullish-comparison ref arm in `binary-ops.ts` already knows that for
//     SOME carriers a null reference IS the `undefined` value — that is what
//     `isNullableNativeString` and the `nonNullUnionHasUndefined` union test
//     encode.
//
// This module supplies the missing third case to that same family: for a
// nullable-ref slot the class never initialises, `ref.null` IS `undefined`.
// Nothing here folds — the emitted test is always a runtime `ref.is_null`, so a
// field a METHOD assigns later reads `undefined` before the write and the real
// callable after it, with no flow analysis.
//
// Deliberately NOT claimed:
//   * A field whose declared type admits `null` (`m: (() => number) | null`).
//     There the program can store a real JS `null`, which `ref.null` would be
//     indistinguishable from, and node answers `typeof … === "object"` /
//     `… === undefined` false. Those rows are pinned unchanged.
//   * A field the CONSTRUCTOR assigns. The slot always holds a real value by
//     the time any method can read it, so the existing fold is already correct
//     and re-routing it would move emitted bytes for no semantic gain.
//   * An f64 (`n!: number`) slot. Extending `undefinedDefault` from `?` to `!`
//     is a separate, wider change to numeric field storage — see the issue's
//     `## Landed` note.

import type { FieldDef, Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { hasStaticModifier } from "./ast-modifiers.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureExternIsUndefinedImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { compileExpression } from "./shared.js";
import { compileStringLiteral } from "./string-ops.js";

/** The struct slot behind a declared-but-never-initialised class field. */
export interface UninitialisedFieldSlot {
  /** Struct field name (`__priv_`-mangled for a private name). */
  readonly name: string;
  /** The slot's Wasm type — always a nullable reference. */
  readonly type: ValType;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.Node & { readonly modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return modifiers?.some((modifier) => modifier.kind === kind) === true;
}

/**
 * Does the declared TYPE ANNOTATION admit `null`? Answered syntactically so the
 * check needs neither the checker nor the oracle: a `null` in the annotation
 * means the program may store a real JS `null`, which shares `ref.null` with
 * the uninitialised default and must keep the existing semantics.
 */
function annotationAdmitsNull(typeNode: ts.TypeNode | undefined): boolean {
  if (typeNode === undefined) return true; // no annotation ⇒ no proof; stay out
  const isNullNode = (node: ts.TypeNode): boolean =>
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword);
  if (isNullNode(typeNode)) return true;
  if (ts.isUnionTypeNode(typeNode)) return typeNode.types.some(isNullNode);
  return false;
}

/** Does this class's constructor assign `this.<fieldName> = …` at statement level? */
function constructorAssignsField(cls: ts.ClassLikeDeclaration, fieldName: string): boolean {
  for (const member of cls.members) {
    if (!ts.isConstructorDeclaration(member) || !member.body) continue;
    for (const stmt of member.body.statements) {
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(stmt.expression.left) &&
        stmt.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const raw = stmt.expression.left.name;
        const name = ts.isPrivateIdentifier(raw) ? "__priv_" + raw.text.slice(1) : raw.text;
        if (name === fieldName) return true;
      }
    }
    // A parameter property (`constructor(public m: T)`) also supplies a value.
    for (const param of member.parameters) {
      if (param.modifiers && ts.isIdentifier(param.name) && param.name.text === fieldName) return true;
    }
  }
  return false;
}

/**
 * Resolve `expr` to the nullable-ref struct slot of a declared-but-never-
 * initialised class field, or `undefined` when the read is anything else.
 *
 * Returning a slot is a claim about the CARRIER, not about the current value:
 * callers must still emit a runtime `ref.is_null`, never a constant fold.
 */
export function uninitialisedFieldSlot(ctx: CodegenContext, expr: ts.Expression): UninitialisedFieldSlot | undefined {
  if (!ts.isPropertyAccessExpression(expr) || expr.questionDotToken) return undefined;
  // `declarationsOf`, not `valueDeclarationOf`: the latter bails on a
  // PrivateIdentifier (it gates on `ts.isIdentifier`), which would leave the
  // `#m!` twin of this shape trapping while the public `m!` one was fixed —
  // exactly the public/private split #5309 was about. Requiring a SINGLE
  // declaration keeps a merged or overloaded member out.
  const declarations = ctx.oracle.declarationsOf(expr.name);
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0]!;
  if (!ts.isPropertyDeclaration(declaration)) return undefined;
  // An initializer supplies a real value at construction; `declare` installs no
  // property at all (an inherited member stays visible through it); a static
  // field is a module global, not a struct slot.
  if (declaration.initializer !== undefined) return undefined;
  if (hasStaticModifier(declaration)) return undefined;
  if (hasModifier(declaration, ts.SyntaxKind.DeclareKeyword)) return undefined;
  if (hasModifier(declaration, ts.SyntaxKind.AbstractKeyword)) return undefined;
  if (annotationAdmitsNull(declaration.type)) return undefined;

  const cls = declaration.parent;
  if (!ts.isClassDeclaration(cls) && !ts.isClassExpression(cls)) return undefined;
  const className = cls.name?.text;
  if (className === undefined) return undefined; // anonymous class ⇒ no struct key

  const declaredName = declaration.name;
  const fieldName = ts.isPrivateIdentifier(declaredName)
    ? "__priv_" + declaredName.text.slice(1)
    : ts.isIdentifier(declaredName) || ts.isStringLiteral(declaredName)
      ? declaredName.text
      : undefined;
  if (fieldName === undefined) return undefined; // computed name ⇒ not a fixed slot
  if (constructorAssignsField(cls, fieldName)) return undefined;

  const field: FieldDef | undefined = ctx.structFields.get(className)?.find((slot) => slot.name === fieldName);
  if (field === undefined) return undefined;
  // Only a REFERENCE slot carries a null construction default that can stand in
  // for `undefined`: a struct ref (`o!: { a: number }`) gets `ref.null`, and the
  // boxed carrier a function-typed field uses gets `ref.null.extern`. A numeric
  // slot defaults to `0`, which is a different (wider) change — see the module
  // comment and the issue's `## Landed` note.
  if (field.type.kind !== "ref" && field.type.kind !== "ref_null" && field.type.kind !== "externref") {
    return undefined;
  }
  return { name: fieldName, type: field.type };
}

/** Cheap boolean form for the guard chains that only need "does this apply?". */
export function readsUninitialisedFieldSlot(ctx: CodegenContext, expr: ts.Expression): boolean {
  return uninitialisedFieldSlot(ctx, expr) !== undefined;
}

/**
 * Emit the read of an uninitialised field slot followed by `ref.is_null`,
 * leaving `1` on the stack exactly when the field still holds its `undefined`.
 *
 * Returns `false` WITHOUT emitting anything when the shape does not apply, so
 * every caller keeps its historical fold untouched.
 */
export function emitUninitialisedFieldNullTest(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
): boolean {
  if (uninitialisedFieldSlot(ctx, operand) === undefined) return false;
  const probe: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = probe;
  let readType: ValType | null;
  try {
    readType = compileExpression(ctx, fctx, operand);
  } finally {
    fctx.body = savedBody;
  }
  if (readType === null || (readType.kind !== "externref" && readType.kind !== "ref" && readType.kind !== "ref_null")) {
    return false; // unexpected carrier — nothing emitted, keep the fold
  }
  fctx.body.push(...probe, { op: "ref.is_null" });
  return true;
}

/**
 * `typeof <uninitialised field>` as a VALUE: select between the two string
 * constants on the slot's own null test. Returns `null` (having emitted
 * nothing) when the shape does not apply.
 */
export function emitUninitialisedFieldTypeofString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
  staticTypeof: string,
): ValType | null {
  if (staticTypeof === "undefined") return null;
  const undefArm: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = undefArm;
  let undefType: ValType | null;
  try {
    undefType = compileStringLiteral(ctx, fctx, "undefined");
  } finally {
    fctx.body = savedBody;
  }
  if (undefType === null) return null;
  if (!emitUninitialisedFieldNullTest(ctx, fctx, operand)) return null;
  const valueArm: Instr[] = [];
  const savedValueBody = fctx.body;
  fctx.body = valueArm;
  try {
    compileStringLiteral(ctx, fctx, staticTypeof);
  } finally {
    fctx.body = savedValueBody;
  }
  fctx.body.push({ op: "if", blockType: { kind: "val", type: undefType }, then: undefArm, else: valueArm });
  return undefType;
}

/**
 * `typeof <uninitialised field> === <literal>` as the boolean the comparison
 * wants: the field is `undefined` exactly when its slot reference is null, and
 * carries the folded verdict otherwise. Returns `null` (having emitted nothing)
 * when the shape does not apply.
 */
export function emitUninitialisedFieldTypeofComparison(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
  staticTypeof: string,
  stringLiteral: string,
  isEq: boolean,
): ValType | null {
  if (staticTypeof === "undefined") return null;
  if (!emitUninitialisedFieldNullTest(ctx, fctx, operand)) return null;
  if (stringLiteral === "undefined") {
    if (!isEq) fctx.body.push({ op: "i32.eqz" });
  } else if (staticTypeof === stringLiteral) {
    fctx.body.push({ op: "i32.eqz" });
    if (!isEq) fctx.body.push({ op: "i32.eqz" });
  } else {
    fctx.body.push({ op: "drop" }, { op: "i32.const", value: isEq ? 0 : 1 });
  }
  return { kind: "i32" };
}

/**
 * The strict null/undefined comparison for a BOXED uninitialised field slot —
 * the carrier a function-typed field actually lands on. The value is already on
 * the stack as an `externref`.
 *
 * `ref.null.extern` here is this field's `undefined`, so both arms move:
 * `=== undefined` must accept the null slot (the host `__extern_is_undefined`
 * probe sees a JS `null` and answers false, which is what made the issue's
 * guard fall through into a trapping `this.m()`), and `=== null` must stop
 * reporting true for it, because the installed value is `undefined`, not
 * `null`. Loose `== null` is unchanged — it is already true either way.
 */
export function emitUninitialisedFieldStrictNullish(
  ctx: CodegenContext,
  fctx: FunctionContext,
  nullSideIsNullKeyword: boolean,
  isStrictNeqOp: boolean,
): ValType {
  if (nullSideIsNullKeyword) {
    fctx.body.push({ op: "drop" }, { op: "i32.const", value: isStrictNeqOp ? 1 : 0 });
    return { kind: "i32" };
  }
  const isUndefIdx = ensureExternIsUndefinedImport(ctx);
  if (isUndefIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    const tmpLocal = allocTempLocal(fctx, { kind: "externref" });
    fctx.body.push({ op: "local.tee", index: tmpLocal });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "call", funcIdx: isUndefIdx });
    fctx.body.push({ op: "i32.or" });
    releaseTempLocal(fctx, tmpLocal);
  } else {
    fctx.body.push({ op: "ref.is_null" });
  }
  if (isStrictNeqOp) fctx.body.push({ op: "i32.eqz" });
  return { kind: "i32" };
}
