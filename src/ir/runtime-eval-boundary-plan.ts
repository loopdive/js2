// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Backend-neutral inventory of syntax that can cross the linked runtime-eval
 * boundary. The inventory is built once so IR admission and legacy lowering
 * cannot disagree after a speculative static lowering declines a site.
 */
import type { TypeOracle } from "../checker/oracle.js";
import { forEachChild, ts } from "../ts-api.js";

export type IrRuntimeEvalSiteKind =
  | "direct-eval"
  | "indirect-eval"
  | "function-constructor"
  | "intrinsic-value"
  | "provider-definition";

export interface IrRuntimeEvalSite {
  readonly sourceId: string;
  readonly start: number;
  readonly end: number;
  readonly kind: IrRuntimeEvalSiteKind;
  readonly providerDisposition: "required" | "may-fallback" | "provided";
  readonly literalSource?: string;
}

export interface IrRuntimeEvalBoundaryPlan {
  readonly sites: readonly IrRuntimeEvalSite[];
  readonly providerMayExecute: boolean;
  readonly sharedRealmMayContainCanonicalValues: boolean;
  readonly callableBoundaryRequired: boolean;
  readonly unknownDynamicSource: boolean;
  readonly dynamicSourceFragments: readonly string[];
}

const PROVIDER_NAMES = new Set([
  "__runtime_new_function",
  "__runtime_indirect_eval",
  "__runtime_direct_eval",
  "__runtime_apply_interpreted",
]);

export function isRuntimeEvalBoundaryProviderName(name: string | undefined): boolean {
  return name !== undefined && PROVIDER_NAMES.has(name);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isGlobalIntrinsic(identifier: ts.Identifier, oracle: TypeOracle): boolean {
  const declaration = oracle.valueDeclarationOf(identifier);
  return declaration === undefined || declaration.getSourceFile().isDeclarationFile;
}

function stableSourceId(sourceFile: ts.SourceFile, index: number): string {
  const normalized = sourceFile.fileName.replace(/\\/g, "/");
  return `source:${index}:${normalized.slice(normalized.lastIndexOf("/") + 1)}`;
}

/**
 * Cheap, sound negative gate for the runtime-eval inventory walk. Most source
 * files contain none of the boundary spellings, and walking their full AST is
 * pure compile work. A Unicode escape keeps the answer conservatively true:
 * escaped identifier characters can spell `eval`, `Function`, or a provider
 * name without those literal substrings appearing in the raw source.
 */
export function sourceMayContainRuntimeEvalBoundary(sourceFile: ts.SourceFile): boolean {
  const text = sourceFile.text;
  return text.includes("eval") || text.includes("Function") || text.includes("__runtime_") || text.includes("\\u");
}

function stringArguments(args: readonly ts.Expression[] | undefined): { literalSource?: string; unknown: boolean } {
  if (!args || args.length === 0) return { unknown: false };
  if (!args.every(ts.isStringLiteralLike)) return { unknown: true };
  return { literalSource: args.map((arg) => arg.text).join("\n"), unknown: false };
}

function isDirectCalleeIntrinsicValue(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    unwrapExpression(parent.expression) === identifier
  ) {
    return true;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.CommaToken &&
    parent.right === identifier
  ) {
    const call = parent.parent;
    return (ts.isCallExpression(call) || ts.isNewExpression(call)) && unwrapExpression(call.expression) === parent;
  }
  return false;
}

/** Build the single immutable runtime-eval routing authority for a program. */
export function buildIrRuntimeEvalBoundaryPlan(
  sourceFiles: readonly ts.SourceFile[],
  oracle: TypeOracle,
): IrRuntimeEvalBoundaryPlan {
  const sites: IrRuntimeEvalSite[] = [];
  const dynamicSourceFragments: string[] = [];
  let unknownDynamicSource = false;

  const addSite = (
    sourceFile: ts.SourceFile,
    id: string,
    node: ts.Node,
    kind: IrRuntimeEvalSiteKind,
    providerDisposition: IrRuntimeEvalSite["providerDisposition"],
    literalSource?: string,
  ): void => {
    sites.push(
      Object.freeze({
        sourceId: id,
        start: node.getStart(sourceFile),
        end: node.end,
        kind,
        providerDisposition,
        ...(literalSource === undefined ? {} : { literalSource }),
      }),
    );
  };

  sourceFiles.forEach((sourceFile, index) => {
    if (!sourceMayContainRuntimeEvalBoundary(sourceFile)) return;
    const id = stableSourceId(sourceFile, index);
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && isRuntimeEvalBoundaryProviderName(statement.name?.text)) {
        addSite(sourceFile, id, statement, "provider-definition", "provided");
      }
    }

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = unwrapExpression(node.expression);
        if (ts.isIdentifier(callee) && isGlobalIntrinsic(callee, oracle)) {
          if (callee.text === "eval") {
            const source = node.arguments?.[0];
            const literalSource = source && ts.isStringLiteralLike(source) ? source.text : undefined;
            addSite(sourceFile, id, node, "direct-eval", "required", literalSource);
            if (literalSource !== undefined) dynamicSourceFragments.push(literalSource);
            else if (source !== undefined) unknownDynamicSource = true;
          } else if (callee.text === "Function") {
            const source = stringArguments(node.arguments);
            addSite(sourceFile, id, node, "function-constructor", "may-fallback", source.literalSource);
            if (source.literalSource !== undefined) dynamicSourceFragments.push(source.literalSource);
            if (source.unknown) unknownDynamicSource = true;
          }
        } else if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) {
          const intrinsic = unwrapExpression(callee.right);
          if (ts.isIdentifier(intrinsic) && intrinsic.text === "eval" && isGlobalIntrinsic(intrinsic, oracle)) {
            const source = node.arguments?.[0];
            const literalSource = source && ts.isStringLiteralLike(source) ? source.text : undefined;
            addSite(sourceFile, id, node, "indirect-eval", "required", literalSource);
            if (literalSource !== undefined) dynamicSourceFragments.push(literalSource);
            else if (source !== undefined) unknownDynamicSource = true;
          }
        }
      }

      if (
        ts.isIdentifier(node) &&
        (node.text === "eval" || node.text === "Function") &&
        isGlobalIntrinsic(node, oracle) &&
        !isDirectCalleeIntrinsicValue(node)
      ) {
        const parent = node.parent;
        const isMemberName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isElementAccessExpression(parent) && parent.argumentExpression === node);
        if (!isMemberName) {
          addSite(sourceFile, id, node, "intrinsic-value", "required");
          unknownDynamicSource = true;
        }
      }
      forEachChild(node, visit);
    };
    visit(sourceFile);
  });

  const frozenSites = Object.freeze(sites.slice());
  const frozenFragments = Object.freeze(dynamicSourceFragments.slice());
  const providerMayExecute = frozenSites.some((site) => site.providerDisposition !== "provided");
  return Object.freeze({
    sites: frozenSites,
    providerMayExecute,
    sharedRealmMayContainCanonicalValues: providerMayExecute,
    callableBoundaryRequired: frozenSites.length !== 0,
    unknownDynamicSource,
    dynamicSourceFragments: frozenFragments,
  });
}
