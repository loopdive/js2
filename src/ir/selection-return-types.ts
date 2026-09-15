// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { IrType, IrClosureSignature } from "./nodes.js";

/**
 * Resolve a param's type. Explicit TS annotation wins (must be number /
 * boolean / string). Otherwise, the TypeMap entry's lattice type must be a
 * concrete primitive.
 *
 * #1169a — slice 1 widens the resolver to recognise `string`. The set of
 * call sites still treats the result as a null-vs-non-null discriminator,
 * so adding a third positive value is backward-compatible.
 */
// Slice 14 (#1228) — `any` and `void` are accepted at the selector level:
//   - `any` (param or return) lowers to externref via `resolvePositionType`.
//   - `void` (return only) means the function has zero result types; lowering
//     constructs the IrFunctionBuilder with `[]` results and accepts bare
//     `return;` / fall-through tails. `void` in param position is rejected
//     (no JS source emits a `void`-typed param value, so there's nothing to
//     accept).
// #2859 / #3214 B0+B3 — `closure` selector kind: a FunctionTypeNode annotation whose params
//   and return are all primitive-annotated (the same surface slice-3 closure
//   literals support). The override lowers a source parameter or result to
//   `IrType.callable` / externref; calls unpack it through the canonical wrapper
//   root. A returned literal is explicitly packed at the return boundary.
//   `IrType.closure` remains the compiler-owned local literal carrier.
// #2949 slice 2 — `dynamic`: an UNANNOTATED position whose propagated lattice
//   type converged to `unknown` (no evidence) or `dynamic` (top). Lowers to
//   `IrType.dynamic` → the module's boxed-any carrier via
//   `IrLowerResolver.resolveDynamic()` (fast/standalone: `ref_null $AnyValue`;
//   JS-host: externref) — the SAME carrier legacy `resolveWasmType`'s
//   any/unknown arm gives these positions, so IR-claimed and legacy functions
//   agree on the ABI by construction. The claim is additionally gated by
//   `dynamicUsesAreMoveOnly`: producers are still move-only (box/unbox
//   producer widening is the #2949 follow-up slice), so dynamic values may
//   only MOVE. (#2949 slice 3b) The explicit `any` ANNOTATION now resolves
//   "dynamic" too — the historical "any" kind (externref in all modes, no
//   use gating) is deleted: it diverged from legacy's fast-mode `any` ABI
//   and was the last claim-then-demote channel for non-move any-uses.
export type ResolvedKind = "f64" | "bool" | "string" | "object" | "void" | "closure" | "dynamic" | null;

/**
 * #2859 — build an `IrClosureSignature` from an explicit function-type
 * annotation (`(a: number, b: string) => number`), or return `null` when the
 * annotation is outside the expressible surface. The primitive mapping MUST
 * stay identical to `typeNodeToIr` in `from-ast.ts` (number→f64, boolean→i32,
 * string→string): a closure-literal argument's signature is built there, and
 * `lowerClosureCall` / `irTypeEquals` compare the two structurally — any
 * divergence would reject valid calls at lowering time (post-claim demotion).
 *
 * Out-of-surface shapes (→ null, so the selector keeps the honest
 * `param-type-not-resolvable` rejection): non-primitive param/return types,
 * rest/optional/default params, and type parameters. Void returns are a
 * canonical zero-result closure signature; value-position calls still reject.
 */
export function primitiveClosureTypeFromTypeNode(node: ts.TypeNode | undefined): IrType | null {
  if (!node) return null;
  if (node.kind === ts.SyntaxKind.NumberKeyword) return { kind: "val", val: { kind: "f64" } };
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return { kind: "val", val: { kind: "i32" } };
  if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: "string" };
  return null;
}

export function irClosureSignatureFromFunctionTypeNode(node: ts.FunctionTypeNode): IrClosureSignature | null {
  if (node.typeParameters && node.typeParameters.length > 0) return null;
  const params: IrType[] = [];
  for (const p of node.parameters) {
    if (p.questionToken || p.dotDotDotToken || p.initializer) return null;
    const ir = primitiveClosureTypeFromTypeNode(p.type);
    if (!ir) return null;
    params.push(ir);
  }
  const returnType = node.type.kind === ts.SyntaxKind.VoidKeyword ? null : primitiveClosureTypeFromTypeNode(node.type);
  if (returnType === null && node.type.kind !== ts.SyntaxKind.VoidKeyword) return null;
  return { params, returnType };
}

// #1370 Phase A: widened to also accept ts.MethodDeclaration. The `.type`
// (return-type annotation) field is identical in shape across both AST
// nodes (it's `TypeNode | undefined`), and so is the dispatch logic below.
// ts.ConstructorDeclaration is excluded — constructors don't carry a
// source-level return type; the caller short-circuits before this.
/**
 * (#1373b C-1) Annotation arm of {@link resolveReturnType}, extracted so the
 * async claim can resolve the `T` unwrapped from a `Promise<T>` annotation
 * with the exact same kind mapping. Keep the two in lockstep.
 */
export function resolveReturnTypeNode(t: ts.TypeNode): ResolvedKind {
  if (t.kind === ts.SyntaxKind.NumberKeyword) return "f64";
  if (t.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
  if (t.kind === ts.SyntaxKind.StringKeyword) return "string";
  // Slice 14 (#1228) — `void` return: function has zero result types.
  if (t.kind === ts.SyntaxKind.VoidKeyword) return "void";
  // (#2949 slice 3b) `any` return IS the dynamic type (same rationale as
  // the param arm — one `any` ABI, move-only-scanned).
  if (t.kind === ts.SyntaxKind.AnyKeyword) return "dynamic";
  // #3522 returned-closure ownership — exact primitive FunctionTypeNode
  // results use the same canonical callable/externref ABI already proven for
  // callable parameters. Inexpressible signatures remain unclaimable.
  if (ts.isFunctionTypeNode(t)) {
    return irClosureSignatureFromFunctionTypeNode(t) ? "closure" : null;
  }
  if (ts.isTypeLiteralNode(t) || ts.isTypeReferenceNode(t) || ts.isArrayTypeNode(t)) return "object";
  return null;
}
