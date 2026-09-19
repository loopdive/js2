// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6603 (#5383 S16) — a `let`/`const` bound to a **nullable native string**
 * element of a vec must not be slotted at the element's NON-NULL twin.
 *
 * ## The lie, and where it lands
 *
 * Standalone stores an unmatched capture group as a **null native string** —
 * `native-regex.ts` `ensureRegexMatchVecType` types the match vec's element
 * `ref_null $anyStr`, and `regexp-standalone.ts` documents that null as "the
 * compiler's `undefined` for nullable native string slots". TypeScript does not
 * model it: `RegExpExecArray extends Array<string>`, so `resolveWasmType` hands
 * back the non-null `{kind:"ref", typeIdx: anyStrTypeIdx}` for `t[7]`.
 *
 * `walkStmtForLetConst` is the AUTHORITATIVE let/const slot-typer and ends its
 * cascade at exactly that call, so `const c = t[7]` records a **non-null**
 * slot. Nothing fails at the store — the encoder gives a `ref` local a
 * defaultable nullable slot — so the null is written and kept. What breaks is
 * every later READ: `getLocalType` answers `ref $anyStr`, and the consumers
 * that have a correct null-aware arm never reach it. Truthiness takes
 * `emitToBoolean`'s non-null arm (`__str_flatten` → `struct.get length`) rather
 * than the #3548 `__str_truthy` arm, `+` flattens, `typeof` answers `"string"`.
 *
 * The measured signature of this is that the INLINE read is right and the bound
 * read is wrong: `"" + m[1]` is `"undefined"` while `const a = m[1]; "" + a`
 * traps. The defect is the binding's recorded type, not any operator.
 *
 * ## Why this is narrowed to a native-string element
 *
 * `resolveWasmType` also returns a non-null `ref` for class/object struct
 * types, so a general "any `ref_null` element" filter would re-type every
 * `const x = objArray[i]` binding in BOTH lanes. That is a large byte-level
 * blast radius over a value domain whose consumers have no proven null-aware
 * arms, and it is not the same defect: for an object element the nullable
 * carrier is a representation detail, whereas for a native string the null IS
 * the language-level `undefined` of a value the checker calls `string`, and
 * `+` / `===` / `typeof` / ToBoolean each already answer correctly once they
 * are told the value is nullable.
 *
 * Sibling of `array-hof-nullable-elem-param.ts` (#6602), which is the same lie
 * one boundary earlier (the array-HOF callback parameter), and narrowed on the
 * same principle: fire only on the exact non-null-twin pair, so no other
 * binding shape can change a single emitted byte.
 */
import * as ts from "typescript";
import type { ValType } from "../ir/types.js";
import { getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { localGlobalIdx } from "./registry/imports.js";

/** Strip the wrappers that do not change which value an initializer produces. */
function stripBindingWrapper(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * The wasm carrier a receiver EXPRESSION already has in this frame, or
 * `undefined` when it is not a plain identifier bound to a local or a module
 * global. Deliberately not a checker query: the nullability this module exists
 * for lives only in the wasm carrier, and the checker is the party that is
 * wrong about it.
 */
function receiverCarrier(ctx: CodegenContext, fctx: FunctionContext, receiver: ts.Expression): ValType | undefined {
  if (!ts.isIdentifier(receiver)) return undefined;
  const localIdx = fctx.localMap.get(receiver.text);
  if (localIdx !== undefined) return getLocalType(fctx, localIdx);
  const globalIdx = ctx.moduleGlobals.get(receiver.text);
  if (globalIdx === undefined) return undefined;
  return ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type;
}

/**
 * The element type of a vec struct carrier (`{length, data}` where `data` is a
 * `ref` to an array type), or `undefined` for anything else.
 */
function vecElementType(ctx: CodegenContext, carrier: ValType | undefined): ValType | undefined {
  if (!carrier || (carrier.kind !== "ref" && carrier.kind !== "ref_null")) return undefined;
  const vecDef = ctx.mod.types[carrier.typeIdx];
  if (vecDef?.kind !== "struct" || vecDef.fields.length < 2) return undefined;
  if (vecDef.fields[0]?.name !== "length" || vecDef.fields[1]?.name !== "data") return undefined;
  const dataField = vecDef.fields[1]!;
  if (dataField.type.kind !== "ref") return undefined;
  const arrDef = ctx.mod.types[dataField.type.typeIdx];
  return arrDef?.kind === "array" ? arrDef.element : undefined;
}

/** `let` / `const` / `using` / `await using` — everything except `var`. */
function isBlockScopedDeclaration(decl: ts.VariableDeclaration): boolean {
  const flags = decl.parent.flags;
  return (flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !== 0;
}

/**
 * Post-filter over a let/const slot type that a declaration cascade has already
 * settled on.
 *
 * Returns `resolved` unchanged for everything except the exact defect: a
 * block-scoped binding whose initializer reads an element out of a vec whose
 * element type is the NULLABLE native string, slotted at that element type's
 * non-null twin. In that one case it answers the nullable twin, so the binding
 * models what it actually holds.
 *
 * Every guard is a narrowing one: a `var`, a non-element-access initializer, a
 * receiver whose carrier is not a vec (or not resolvable in this frame), a
 * non-string element, an already-nullable slot, or a slot the cascade resolved
 * to anything else (`externref`, `f64`, a struct) all return `resolved`. That
 * is what keeps the blast radius to the lie itself.
 */
export function nullableNativeStringElemBindingType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.VariableDeclaration,
  resolved: ValType,
): ValType {
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return resolved;
  if (resolved.kind !== "ref" || resolved.typeIdx !== ctx.anyStrTypeIdx) return resolved;
  if (!isBlockScopedDeclaration(decl)) return resolved;
  const initializer = decl.initializer;
  if (initializer === undefined) return resolved;
  const unwrapped = stripBindingWrapper(initializer);
  if (!ts.isElementAccessExpression(unwrapped) || unwrapped.questionDotToken !== undefined) return resolved;
  const elemType = vecElementType(ctx, receiverCarrier(ctx, fctx, unwrapped.expression));
  if (elemType === undefined) return resolved;
  if (elemType.kind !== "ref_null" || elemType.typeIdx !== ctx.anyStrTypeIdx) return resolved;
  return { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
}
