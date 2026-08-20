// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4576 — checker-backed certification for the exact standalone Builtins DOM
// component. This is deliberately a leaf module: codegen planning, selection,
// and lowering must consume one node-identity plan without importing either
// codegen or the JavaScript runtime.

import { ts, forEachChild } from "../ts-api.js";

export const IR_STANDALONE_DOM_BUILTINS_IMPORTS = Object.freeze([
  "global_document",
  "Document_createElement",
  "Document_get_body",
  "Element_set_innerHTML",
  "Element_set_textContent",
  "CSSStyleDeclaration_set_cssText",
  "HTMLElement_get_style",
  "Node_appendChild",
] as const);

export type IrStandaloneDomImportName = (typeof IR_STANDALONE_DOM_BUILTINS_IMPORTS)[number];

type IrStandaloneDomClassName = "Document" | "HTMLElement" | "CSSStyleDeclaration";

export type IrStandaloneDomOperation =
  | {
      readonly kind: "global-get";
      readonly importName: "global_document";
      readonly identifier: ts.Identifier;
      readonly resultClass: "Document";
    }
  | {
      readonly kind: "member-get";
      readonly importName: "Document_get_body" | "HTMLElement_get_style";
      readonly access: ts.PropertyAccessExpression;
      readonly receiverClass: "Document" | "HTMLElement";
      readonly resultClass: "HTMLElement" | "CSSStyleDeclaration";
    }
  | {
      readonly kind: "member-set";
      readonly importName: "Element_set_innerHTML" | "Element_set_textContent" | "CSSStyleDeclaration_set_cssText";
      readonly assignment: ts.BinaryExpression;
      readonly access: ts.PropertyAccessExpression;
      readonly receiverClass: "HTMLElement" | "CSSStyleDeclaration";
      /** This exact provider projects a native `$AnyString` at the boundary. */
      readonly valueBoundary: "native-string";
    }
  | {
      readonly kind: "member-call";
      readonly importName: "Document_createElement" | "Node_appendChild";
      readonly call: ts.CallExpression;
      readonly access: ts.PropertyAccessExpression;
      readonly receiverClass: "Document" | "HTMLElement";
      readonly resultClass: "HTMLElement";
      readonly argumentBoundaries: readonly ["native-string"] | readonly ["dom-handle"];
    };

/**
 * Closed source-owned capability plan. `operation(node)` accepts only nodes
 * from `sourceFile`; callers must not re-derive authorization from names or
 * checker types after this plan has been built.
 */
export interface IrStandaloneDomCapabilityPlan {
  readonly sourceFile: ts.SourceFile;
  readonly owners: ReadonlySet<ts.FunctionDeclaration>;
  readonly imports: ReadonlySet<IrStandaloneDomImportName>;
  operation(node: ts.Node): IrStandaloneDomOperation | undefined;
}

function isLibraryDeclaration(node: ts.Node): boolean {
  const source = node.getSourceFile();
  if (!source.isDeclarationFile) return false;
  // The in-memory checker concatenates the web libraries into `lib.d.ts`;
  // ordinary TypeScript Programs retain `lib.dom.d.ts`. Do not accept a user
  // ambient declaration merely because it happens to use a DOM-shaped name.
  const normalized = source.fileName.replace(/\\/g, "/");
  return normalized === "lib.d.ts" || normalized.endsWith("/lib.d.ts") || normalized.endsWith("/lib.dom.d.ts");
}

function declarationsAreLibraryOwned(symbol: ts.Symbol | undefined): boolean {
  const declarations = symbol?.declarations;
  return declarations !== undefined && declarations.length > 0 && declarations.every(isLibraryDeclaration);
}

function exactDomClassName(expr: ts.Expression, checker: ts.TypeChecker): IrStandaloneDomClassName | undefined {
  const type = checker.getTypeAtLocation(expr);
  if ((type.flags & ts.TypeFlags.Object) === 0 || type.isUnion() || type.isIntersection()) return undefined;
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!declarationsAreLibraryOwned(symbol)) return undefined;
  switch (symbol!.name) {
    case "Document":
    case "HTMLElement":
    case "CSSStyleDeclaration":
      return symbol!.name;
    default:
      return undefined;
  }
}

function isExactlyString(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(expr);
  return (
    !type.isUnion() && !type.isIntersection() && (type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) !== 0
  );
}

function containingTopLevelFunction(node: ts.Node): ts.FunctionDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current && ts.isFunctionDeclaration(current) && current.body && ts.isSourceFile(current.parent)
    ? current
    : undefined;
}

function ambientDocumentSymbol(node: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (node.text !== "document") return undefined;
  const symbol = checker.getSymbolAtLocation(node);
  if (!declarationsAreLibraryOwned(symbol)) return undefined;
  const declarations = symbol!.declarations!;
  if (!declarations.every(ts.isVariableDeclaration)) return undefined;
  return exactDomClassName(node, checker) === "Document" ? symbol : undefined;
}

function memberIsLibraryOwned(
  access: ts.PropertyAccessExpression,
  expectedOwner: "Document" | "Element" | "ElementCSSInlineStyle" | "CSSStyleDeclaration" | "Node",
  checker: ts.TypeChecker,
): boolean {
  const symbol = checker.getSymbolAtLocation(access.name);
  if (!declarationsAreLibraryOwned(symbol)) return false;
  return symbol!.declarations!.every((declaration) => {
    const parent = declaration.parent;
    return (
      (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) &&
      parent.name !== undefined &&
      parent.name.text === expectedOwner
    );
  });
}

function resolvedCallIsLibraryOwned(
  call: ts.CallExpression,
  member: string,
  expectedOwner: "Document" | "Node",
  checker: ts.TypeChecker,
): boolean {
  const declaration = checker.getResolvedSignature(call)?.getDeclaration();
  if (!declaration || !isLibraryDeclaration(declaration)) return false;
  const name = "name" in declaration ? declaration.name : undefined;
  const parent = declaration.parent;
  return (
    !!name &&
    ts.isIdentifier(name) &&
    name.text === member &&
    (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) &&
    parent.name?.text === expectedOwner
  );
}

function exactAssignment(access: ts.PropertyAccessExpression): ts.BinaryExpression | undefined {
  const parent = access.parent;
  return ts.isBinaryExpression(parent) &&
    parent.left === access &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ? parent
    : undefined;
}

function exactCall(access: ts.PropertyAccessExpression): ts.CallExpression | undefined {
  const parent = access.parent;
  return ts.isCallExpression(parent) && parent.expression === access ? parent : undefined;
}

/**
 * Build the all-or-nothing plan for the current Builtins slice.
 *
 * The plan exists only when the source uses the complete eight-import surface
 * and every DOM member use belongs to the exact fixed-arity, non-computed,
 * non-optional subset. One unsupported use (including `querySelector`) makes
 * the whole plan unavailable, so selection cannot claim only a convenient
 * fragment of the four-function component.
 */
export function makeIrStandaloneDomCapabilityPlan(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): IrStandaloneDomCapabilityPlan | undefined {
  const operations = new WeakMap<ts.Node, IrStandaloneDomOperation>();
  const owners = new Set<ts.FunctionDeclaration>();
  const imports = new Set<IrStandaloneDomImportName>();
  let invalid = false;

  const register = (nodes: readonly ts.Node[], operation: IrStandaloneDomOperation): void => {
    const owner = containingTopLevelFunction(nodes[0]!);
    if (!owner || owner.getSourceFile() !== sourceFile) {
      invalid = true;
      return;
    }
    for (const node of nodes) operations.set(node, operation);
    owners.add(owner);
    imports.add(operation.importName);
  };

  const visit = (node: ts.Node): void => {
    if (invalid) return;

    if (ts.isElementAccessExpression(node)) {
      // Computed DOM members are outside the provider ABI even when the key is
      // a constant string. Keep this before the generic child walk.
      if (exactDomClassName(node.expression, checker) !== undefined || exactDomClassName(node, checker) !== undefined) {
        invalid = true;
        return;
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const receiverClass = exactDomClassName(node.expression, checker);
      const resultClass = exactDomClassName(node, checker);
      if (receiverClass === undefined) {
        // Reject DOM handles obtained through an unregistered producer such as
        // `window.document`; source-local function calls and identifiers are
        // checked at their eventual registered member use instead.
        if (resultClass !== undefined) {
          invalid = true;
          return;
        }
      } else {
        if (node.questionDotToken || !ts.isIdentifier(node.name)) {
          invalid = true;
          return;
        }
        const member = node.name.text;

        if (receiverClass === "Document" && member === "createElement") {
          const call = exactCall(node);
          if (
            !call ||
            call.questionDotToken ||
            (call.typeArguments?.length ?? 0) !== 0 ||
            call.arguments.length !== 1 ||
            ts.isSpreadElement(call.arguments[0]!) ||
            !ts.isIdentifier(node.expression) ||
            ambientDocumentSymbol(node.expression, checker) === undefined ||
            !memberIsLibraryOwned(node, "Document", checker) ||
            !resolvedCallIsLibraryOwned(call, member, "Document", checker) ||
            !isExactlyString(call.arguments[0]!, checker) ||
            exactDomClassName(call, checker) !== "HTMLElement"
          ) {
            invalid = true;
            return;
          }
          const operation = Object.freeze({
            kind: "member-call" as const,
            importName: "Document_createElement" as const,
            call,
            access: node,
            receiverClass: "Document" as const,
            resultClass: "HTMLElement" as const,
            argumentBoundaries: Object.freeze(["native-string"] as const),
          });
          register([node, call], operation);
        } else if (receiverClass === "Document" && member === "body") {
          if (
            !ts.isIdentifier(node.expression) ||
            ambientDocumentSymbol(node.expression, checker) === undefined ||
            !memberIsLibraryOwned(node, "Document", checker) ||
            resultClass !== "HTMLElement" ||
            exactCall(node) !== undefined ||
            exactAssignment(node) !== undefined
          ) {
            invalid = true;
            return;
          }
          register(
            [node],
            Object.freeze({
              kind: "member-get" as const,
              importName: "Document_get_body" as const,
              access: node,
              receiverClass: "Document" as const,
              resultClass: "HTMLElement" as const,
            }),
          );
        } else if (receiverClass === "HTMLElement" && member === "style") {
          const consumer = node.parent;
          if (
            !memberIsLibraryOwned(node, "ElementCSSInlineStyle", checker) ||
            resultClass !== "CSSStyleDeclaration" ||
            !ts.isPropertyAccessExpression(consumer) ||
            consumer.expression !== node ||
            consumer.name.text !== "cssText" ||
            exactAssignment(consumer) === undefined
          ) {
            invalid = true;
            return;
          }
          register(
            [node],
            Object.freeze({
              kind: "member-get" as const,
              importName: "HTMLElement_get_style" as const,
              access: node,
              receiverClass: "HTMLElement" as const,
              resultClass: "CSSStyleDeclaration" as const,
            }),
          );
        } else if (receiverClass === "HTMLElement" && (member === "innerHTML" || member === "textContent")) {
          const assignment = exactAssignment(node);
          if (
            !assignment ||
            !memberIsLibraryOwned(node, "Element", checker) ||
            !isExactlyString(assignment.right, checker)
          ) {
            invalid = true;
            return;
          }
          const operation = Object.freeze({
            kind: "member-set" as const,
            importName:
              member === "innerHTML" ? ("Element_set_innerHTML" as const) : ("Element_set_textContent" as const),
            assignment,
            access: node,
            receiverClass: "HTMLElement" as const,
            valueBoundary: "native-string" as const,
          });
          register([node, assignment], operation);
        } else if (receiverClass === "CSSStyleDeclaration" && member === "cssText") {
          const assignment = exactAssignment(node);
          if (
            !assignment ||
            !memberIsLibraryOwned(node, "CSSStyleDeclaration", checker) ||
            !isExactlyString(assignment.right, checker)
          ) {
            invalid = true;
            return;
          }
          const operation = Object.freeze({
            kind: "member-set" as const,
            importName: "CSSStyleDeclaration_set_cssText" as const,
            assignment,
            access: node,
            receiverClass: "CSSStyleDeclaration" as const,
            valueBoundary: "native-string" as const,
          });
          register([node, assignment], operation);
        } else if (receiverClass === "HTMLElement" && member === "appendChild") {
          const call = exactCall(node);
          if (
            !call ||
            call.questionDotToken ||
            (call.typeArguments?.length ?? 0) !== 0 ||
            call.arguments.length !== 1 ||
            ts.isSpreadElement(call.arguments[0]!) ||
            !memberIsLibraryOwned(node, "Node", checker) ||
            !resolvedCallIsLibraryOwned(call, member, "Node", checker) ||
            exactDomClassName(call.arguments[0]!, checker) !== "HTMLElement" ||
            exactDomClassName(call, checker) !== "HTMLElement"
          ) {
            invalid = true;
            return;
          }
          const operation = Object.freeze({
            kind: "member-call" as const,
            importName: "Node_appendChild" as const,
            call,
            access: node,
            receiverClass: "HTMLElement" as const,
            resultClass: "HTMLElement" as const,
            argumentBoundaries: Object.freeze(["dom-handle"] as const),
          });
          register([node, call], operation);
        } else {
          invalid = true;
          return;
        }
      }
    }

    if (ts.isIdentifier(node) && ambientDocumentSymbol(node, checker) !== undefined) {
      const parent = node.parent;
      const memberOperation =
        parent && ts.isPropertyAccessExpression(parent) && parent.expression === node
          ? operations.get(parent)
          : undefined;
      if (
        !memberOperation ||
        (memberOperation.importName !== "Document_createElement" && memberOperation.importName !== "Document_get_body")
      ) {
        invalid = true;
        return;
      }
      const operation = Object.freeze({
        kind: "global-get" as const,
        importName: "global_document" as const,
        identifier: node,
        resultClass: "Document" as const,
      });
      register([node], operation);
    }

    forEachChild(node, visit);
  };

  try {
    visit(sourceFile);
  } catch {
    return undefined;
  }
  if (
    invalid ||
    owners.size === 0 ||
    imports.size !== IR_STANDALONE_DOM_BUILTINS_IMPORTS.length ||
    !IR_STANDALONE_DOM_BUILTINS_IMPORTS.every((name) => imports.has(name))
  ) {
    return undefined;
  }

  const exactOwners = new Set(owners);
  const exactImports = new Set(imports);
  return Object.freeze({
    sourceFile,
    owners: exactOwners,
    imports: exactImports,
    operation(node: ts.Node): IrStandaloneDomOperation | undefined {
      return node.getSourceFile() === sourceFile ? operations.get(node) : undefined;
    },
  });
}
