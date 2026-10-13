// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { IrType } from "./core/types.js";
import { IrInvariantError } from "./outcomes.js";
interface LogicalVectorSourceHost {
  readonly funcName: string;
  readonly logicalVectorTypes?: ReadonlyMap<
    ts.ParameterDeclaration | ts.VariableDeclaration | ts.Expression,
    Extract<IrType, { kind: "vec" }>
  >;
  readonly logicalVectorConsumed?: ReadonlySet<ts.Node>;
}
export function logicalVectorMismatch(funcName: string, detail: string): never {
  throw new IrInvariantError("type-map-failure", "build", `ir/from-ast: logical vector ${detail} (${funcName})`);
}

export function validateLogicalVectorFacts(
  fn: ts.FunctionLikeDeclaration,
  facts: LogicalVectorSourceHost["logicalVectorTypes"],
  funcName: string,
): void {
  if (facts === undefined) return;
  const owned = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (node !== fn && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) return;
    if (ts.isTypeNode(node)) return;
    owned.add(node);
    ts.forEachChild(node, visit);
  };
  visit(fn);
  for (const [node, type] of facts) {
    const parent = node.parent;
    const nonReadName =
      ts.isIdentifier(node) &&
      (((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isPropertyAccessExpression(parent)) &&
        parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node));
    if (
      !owned.has(node) ||
      nonReadName ||
      !(ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isExpression(node))
    ) {
      logicalVectorMismatch(funcName, "entry is not an owned declaration or expression read");
    }
    if (
      type.kind !== "vec" ||
      typeof type.nullable !== "boolean" ||
      Object.keys(type).some((key) => !["kind", "elementType", "nullable"].includes(key)) ||
      type.elementType.kind !== "val" ||
      Object.keys(type.elementType).some((key) => !["kind", "val"].includes(key)) ||
      !["f64", "externref"].includes(type.elementType.val.kind) ||
      Object.keys(type.elementType.val).some((key) => key !== "kind")
    ) {
      logicalVectorMismatch(funcName, "entry must be a layout-free f64/Promise-carrier vector");
    }
  }
}

export function requireLogicalVector(
  expr: ts.Expression,
  cx: LogicalVectorSourceHost,
): Extract<IrType, { kind: "vec" }> {
  const type = cx.logicalVectorTypes?.get(expr);
  if (!type) logicalVectorMismatch(cx.funcName, `missing expression entry for ${ts.SyntaxKind[expr.kind]}`);
  return type;
}

export function checkLogicalVectorConsumption(cx: LogicalVectorSourceHost): void {
  for (const node of cx.logicalVectorTypes?.keys() ?? []) {
    if (!cx.logicalVectorConsumed?.has(node))
      logicalVectorMismatch(cx.funcName, "entry was not consumed by its owned declaration/expression");
  }
}
