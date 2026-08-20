// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4576 — checker-backed certification for the exact standalone Builtins DOM
// component. This is deliberately a leaf module: codegen planning, selection,
// and lowering must consume one node-identity plan without importing either
// codegen or the JavaScript runtime.

import { ts, forEachChild } from "../ts-api.js";
import { buildIrUnitInventory, terminalIrUnitsForSource } from "./identity.js";

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

/** Frozen companion ABI used only by the complete Calendar interaction plan. */
export const IR_STANDALONE_DOM_INTERACTION_IMPORTS = Object.freeze([
  "HTMLElement_addEventListener",
  "CSSStyleDeclaration_set_background",
] as const);

export type IrStandaloneDomImportName =
  | (typeof IR_STANDALONE_DOM_BUILTINS_IMPORTS)[number]
  | (typeof IR_STANDALONE_DOM_INTERACTION_IMPORTS)[number];

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
      readonly importName:
        | "Element_set_innerHTML"
        | "Element_set_textContent"
        | "CSSStyleDeclaration_set_cssText"
        | "CSSStyleDeclaration_set_background";
      readonly assignment: ts.BinaryExpression;
      readonly access: ts.PropertyAccessExpression;
      readonly receiverClass: "HTMLElement" | "CSSStyleDeclaration";
      /** This exact provider projects a native `$AnyString` at the boundary. */
      readonly valueBoundary: "native-string";
    }
  | {
      readonly kind: "member-call";
      readonly importName: "Document_createElement" | "Node_appendChild" | "HTMLElement_addEventListener";
      readonly call: ts.CallExpression;
      readonly access: ts.PropertyAccessExpression;
      readonly receiverClass: "Document" | "HTMLElement";
      readonly resultClass: "HTMLElement" | null;
      readonly argumentBoundaries:
        | readonly ["native-string"]
        | readonly ["dom-handle"]
        | readonly ["native-string", "native-callback-zero-void", "nullish"];
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
  /** True only for the complete two-import Calendar interaction extension. */
  readonly requiresInteraction: boolean;
  operation(node: ts.Node): IrStandaloneDomOperation | undefined;
  /**
   * Certify the exact nullable DOM module slots used by Calendar. A value is
   * admitted only when it is either the declaration's null initializer or a
   * direct result of this plan's source-owned createElement factory.
   */
  moduleBinding(
    declaration: ts.VariableDeclaration,
    writeValue?: ts.Expression,
  ): { readonly capability: "dom"; readonly className: "HTMLElement" } | undefined;
}

const IR_STANDALONE_CALENDAR_TERMINAL_NAMES = Object.freeze([
  "el",
  "mname",
  "dimOf",
  "fdow",
  "priceOf",
  "renderCal",
  "onDay",
  "updFoot",
  "main",
] as const);

const IR_STANDALONE_CALENDAR_DOM_BINDING_NAMES = Object.freeze([
  "gridEl",
  "monthEl",
  "yearEl",
  "nightsEl",
  "totalEl",
] as const);

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
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionDeclaration(current) && current.body && ts.isSourceFile(current.parent)) return current;
    if (ts.isFunctionLike(current)) {
      // Calendar's provider-owned event listeners are the only nested
      // executable syntax in this capability plan. The dedicated callback
      // resolver proves their captures/body; this structural check prevents a
      // nested helper with the same DOM spelling from borrowing its owner.
      const call: ts.Node = current.parent;
      if (
        !ts.isArrowFunction(current) ||
        !ts.isCallExpression(call) ||
        call.arguments[1] !== current ||
        !ts.isPropertyAccessExpression(call.expression) ||
        call.expression.name.text !== "addEventListener"
      ) {
        return undefined;
      }
    }
    current = current.parent;
  }
  return undefined;
}

function ambientDocumentSymbol(node: ts.Identifier, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (node.text !== "document") return undefined;
  const symbol = checker.getSymbolAtLocation(node);
  if (!declarationsAreLibraryOwned(symbol)) return undefined;
  const declarations = symbol!.declarations!;
  if (!declarations.every(ts.isVariableDeclaration)) return undefined;
  return exactDomClassName(node, checker) === "Document" ? symbol : undefined;
}

const IR_STANDALONE_DOM_DECLARATION_OWNERS = new Set([
  "Document",
  "Node",
  "Element",
  "HTMLElement",
  "EventTarget",
  "ElementCSSInlineStyle",
  "CSSStyleDeclaration",
  "Window",
  "WindowEventHandlers",
  "GlobalEventHandlers",
]);

function typeContainsLibraryDomSurface(type: ts.Type, seen: Set<ts.Type> = new Set()): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => typeContainsLibraryDomSurface(member, seen));
  }
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return (
    symbol !== undefined && IR_STANDALONE_DOM_DECLARATION_OWNERS.has(symbol.name) && declarationsAreLibraryOwned(symbol)
  );
}

function isNonBindingPropertyName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isPropertyDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertySignature(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isMethodSignature(parent) && parent.name === identifier) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === identifier) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === identifier) ||
    (ts.isEnumMember(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.propertyName === identifier) ||
    (ts.isQualifiedName(parent) && parent.right === identifier) ||
    (ts.isLabeledStatement(parent) && parent.label === identifier) ||
    ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === identifier)
  );
}

/**
 * Recognize the global spelling even when the checker cannot prove lib.dom
 * ownership. In particular, `declare const document: any` must not erase the
 * authority demand. Ordinary object members named `document` are not binding
 * declarations or value references, so they remain a negative control.
 */
function isTypeOnlyDomSurfaceSyntax(node: ts.Node): boolean {
  if (ts.isPartOfTypeNode(node)) return true;
  let typeQueryParent = node.parent;
  while (ts.isQualifiedName(typeQueryParent)) typeQueryParent = typeQueryParent.parent;
  if (ts.isTypeQueryNode(typeQueryParent)) return true;
  const parent = node.parent;
  return (
    (ts.isIdentifier(node) &&
      (ts.isTypeAliasDeclaration(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeParameterDeclaration(parent)) &&
      parent.name === node) ||
    ((ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) &&
      ts.isTypeOnlyImportOrExportDeclaration(parent)) ||
    (ts.isImportClause(parent) && parent.isTypeOnly)
  );
}

function isPossiblyDocumentValueBindingOrReference(identifier: ts.Identifier): boolean {
  if (
    identifier.text !== "document" ||
    isNonBindingPropertyName(identifier) ||
    isTypeOnlyDomSurfaceSyntax(identifier)
  ) {
    return false;
  }
  // After excluding type-only and non-binding names, any remaining spelling is
  // either a runtime binding or a value reference. Fail closed when the
  // checker has erased it to `any` rather than attempting to enumerate every
  // expression-parent kind.
  return true;
}

function moduleExportsLibraryDomSurface(
  moduleSymbol: ts.Symbol,
  checker: ts.TypeChecker,
  location: ts.Node,
  seen: Set<ts.Symbol>,
): boolean {
  if (seen.has(moduleSymbol)) return false;
  seen.add(moduleSymbol);
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const type = checker.getTypeOfSymbolAtLocation(exported, location);
    if (typeContainsLibraryDomSurface(type)) return true;

    const aliased = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : undefined;
    if (aliased && (aliased.flags & ts.SymbolFlags.Transient) !== 0 && (type.flags & ts.TypeFlags.Any) !== 0) {
      return true;
    }
    const typeSymbol = type.aliasSymbol ?? type.getSymbol();
    const nestedModule =
      aliased && (aliased.flags & ts.SymbolFlags.Module) !== 0
        ? aliased
        : typeSymbol && (typeSymbol.flags & ts.SymbolFlags.Module) !== 0
          ? typeSymbol
          : undefined;
    if (nestedModule && moduleExportsLibraryDomSurface(nestedModule, checker, location, seen)) return true;
  }
  return false;
}

function namespaceImportExportsLibraryDomSurface(identifier: ts.Identifier, checker: ts.TypeChecker): boolean {
  if (!ts.isNamespaceImport(identifier.parent) || identifier.parent.name !== identifier) return false;
  const alias = checker.getSymbolAtLocation(identifier);
  if (!alias || (alias.flags & ts.SymbolFlags.Alias) === 0) return true;
  return moduleExportsLibraryDomSurface(checker.getAliasedSymbol(alias), checker, identifier, new Set());
}

/**
 * Conservative per-source authority detector for multi-module planning.
 *
 * A source that mentions a `document` binding/reference, a lib.dom-owned
 * member or namespace export, or one of the explicit provider descriptor
 * spellings must possess its own exact capability plan. Returning true on
 * checker uncertainty is deliberate: a second source may not borrow the entry
 * source's ctx-global DOM imports.
 */
export function sourceTouchesIrStandaloneDomSurface(checker: ts.TypeChecker, sourceFile: ts.SourceFile): boolean {
  const reservedImportNames = new Set<string>([
    ...IR_STANDALONE_DOM_BUILTINS_IMPORTS,
    ...IR_STANDALONE_DOM_INTERACTION_IMPORTS,
  ]);
  let touches = false;
  const visit = (node: ts.Node): void => {
    if (touches) return;
    try {
      if (
        ts.isIdentifier(node) &&
        (reservedImportNames.has(node.text) ||
          isPossiblyDocumentValueBindingOrReference(node) ||
          (!isTypeOnlyDomSurfaceSyntax(node) && ambientDocumentSymbol(node, checker) !== undefined) ||
          namespaceImportExportsLibraryDomSurface(node, checker))
      ) {
        touches = true;
        return;
      }
      if (
        (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        !isTypeOnlyDomSurfaceSyntax(node) &&
        typeContainsLibraryDomSurface(checker.getTypeAtLocation(node))
      ) {
        touches = true;
        return;
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        if (
          exactDomClassName(node.expression, checker) !== undefined ||
          exactDomClassName(node, checker) !== undefined
        ) {
          touches = true;
          return;
        }
      }
      if (ts.isPropertyAccessExpression(node)) {
        const declarations = checker.getSymbolAtLocation(node.name)?.declarations;
        if (
          declarations?.some((declaration) => {
            if (!isLibraryDeclaration(declaration)) return false;
            const normalized = declaration.getSourceFile().fileName.replace(/\\/g, "/");
            if (normalized.endsWith("/lib.dom.d.ts")) return true;
            const parent = declaration.parent;
            return (
              (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) &&
              parent.name !== undefined &&
              IR_STANDALONE_DOM_DECLARATION_OWNERS.has(parent.name.text)
            );
          }) === true
        ) {
          touches = true;
          return;
        }
      }
    } catch {
      touches = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return touches;
}

function memberIsLibraryOwned(
  access: ts.PropertyAccessExpression,
  expectedOwner:
    | "Document"
    | "Element"
    | "ElementCSSInlineStyle"
    | "CSSStyleDeclaration"
    | "Node"
    | "HTMLElement"
    | "EventTarget",
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
  expectedOwner: "Document" | "Node" | "HTMLElement" | "EventTarget",
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

function collectedDomInteractionMode(
  invalid: boolean,
  ownerCount: number,
  imports: ReadonlySet<IrStandaloneDomImportName>,
): boolean | undefined {
  const hasBase = IR_STANDALONE_DOM_BUILTINS_IMPORTS.every((name) => imports.has(name));
  const interactionCount = IR_STANDALONE_DOM_INTERACTION_IMPORTS.filter((name) => imports.has(name)).length;
  const interaction = interactionCount === IR_STANDALONE_DOM_INTERACTION_IMPORTS.length;
  const expectedCount =
    IR_STANDALONE_DOM_BUILTINS_IMPORTS.length + (interaction ? IR_STANDALONE_DOM_INTERACTION_IMPORTS.length : 0);
  return invalid ||
    ownerCount === 0 ||
    !hasBase ||
    (interactionCount !== 0 && !interaction) ||
    imports.size !== expectedCount
    ? undefined
    : interaction;
}

type IrStandaloneDomModuleBinding = { readonly capability: "dom"; readonly className: "HTMLElement" };

interface CalendarDomStorageCertification {
  moduleBinding(
    declaration: ts.VariableDeclaration,
    writeValue?: ts.Expression,
  ): IrStandaloneDomModuleBinding | undefined;
}

/** Certify the exact Calendar-owned nullable DOM storage transaction. */
function certifyCalendarDomStorage(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  operations: WeakMap<ts.Node, IrStandaloneDomOperation>,
  exactOwners: ReadonlySet<ts.FunctionDeclaration>,
  requiresInteraction: boolean,
): CalendarDomStorageCertification | undefined {
  const hasExactNullableHtmlElementType = (declaration: ts.VariableDeclaration): boolean => {
    if (
      declaration.getSourceFile() !== sourceFile ||
      !ts.isIdentifier(declaration.name) ||
      !declaration.type ||
      !ts.isUnionTypeNode(declaration.type) ||
      declaration.type.types.length !== 2
    ) {
      return false;
    }
    let sawNull = false;
    let sawHtmlElement = false;
    for (const member of declaration.type.types) {
      if (ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword) {
        sawNull = true;
      } else if (
        ts.isTypeReferenceNode(member) &&
        ts.isIdentifier(member.typeName) &&
        member.typeName.text === "HTMLElement" &&
        declarationsAreLibraryOwned(checker.getSymbolAtLocation(member.typeName))
      ) {
        sawHtmlElement = true;
      } else {
        return false;
      }
    }
    return sawNull && sawHtmlElement;
  };
  const isExactNullableHtmlElementDeclaration = (declaration: ts.VariableDeclaration): boolean => {
    if (!hasExactNullableHtmlElementType(declaration) || declaration.initializer?.kind !== ts.SyntaxKind.NullKeyword) {
      return false;
    }
    const declarationList = declaration.parent;
    const statement = declarationList.parent;
    return (
      ts.isVariableDeclarationList(declarationList) &&
      (declarationList.flags & ts.NodeFlags.Let) !== 0 &&
      ts.isVariableStatement(statement) &&
      ts.isSourceFile(statement.parent)
    );
  };
  const factoryOwners = new Set<ts.FunctionDeclaration>();
  for (const owner of exactOwners) {
    if (!owner.body || !owner.type || owner.type.kind !== ts.SyntaxKind.TypeReference) continue;
    const returnType = owner.type as ts.TypeReferenceNode;
    if (
      !ts.isIdentifier(returnType.typeName) ||
      returnType.typeName.text !== "HTMLElement" ||
      !declarationsAreLibraryOwned(checker.getSymbolAtLocation(returnType.typeName))
    ) {
      continue;
    }
    const produced = new Set<ts.VariableDeclaration>();
    const returns: ts.ReturnStatement[] = [];
    let factoryClosed = true;
    const inspectFactory = (node: ts.Node): void => {
      if (node !== owner.body && ts.isFunctionLike(node)) {
        factoryClosed = false;
        return;
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        operations.get(node.initializer)?.importName === "Document_createElement"
      ) {
        produced.add(node);
      }
      if (ts.isReturnStatement(node)) returns.push(node);
      forEachChild(node, inspectFactory);
    };
    inspectFactory(owner.body);
    if (!factoryClosed || produced.size !== 1 || returns.length !== 1) continue;
    const producedDeclaration = [...produced][0]!;
    const producedName = producedDeclaration.name;
    const producedList = producedDeclaration.parent;
    const producedSymbol = ts.isIdentifier(producedName) ? checker.getSymbolAtLocation(producedName) : undefined;
    if (
      !ts.isIdentifier(producedName) ||
      !ts.isVariableDeclarationList(producedList) ||
      (producedList.flags & ts.NodeFlags.Const) === 0 ||
      !producedSymbol ||
      producedSymbol.valueDeclaration !== producedDeclaration ||
      producedSymbol.declarations?.length !== 1 ||
      returns[0]!.expression === undefined ||
      !ts.isIdentifier(returns[0]!.expression!) ||
      checker.getSymbolAtLocation(returns[0]!.expression!) !== producedSymbol
    ) {
      continue;
    }
    const inspectProducedUses = (node: ts.Node): void => {
      if (!factoryClosed) return;
      if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === producedSymbol) {
        if (node !== producedName && node !== returns[0]!.expression) {
          const parent = node.parent;
          const receiverOperation =
            ts.isPropertyAccessExpression(parent) && parent.expression === node ? operations.get(parent) : undefined;
          const exactDomReceiver =
            receiverOperation !== undefined &&
            receiverOperation.kind !== "global-get" &&
            receiverOperation.receiverClass === "HTMLElement";
          const argumentIndex = ts.isCallExpression(parent) ? parent.arguments.indexOf(node) : -1;
          const callOperation = argumentIndex >= 0 ? operations.get(parent) : undefined;
          const exactDomArgument =
            callOperation?.kind === "member-call" && callOperation.argumentBoundaries[argumentIndex] === "dom-handle";
          if (!exactDomReceiver && !exactDomArgument) factoryClosed = false;
        }
      }
      forEachChild(node, inspectProducedUses);
    };
    inspectProducedUses(owner.body);
    if (factoryClosed) factoryOwners.add(owner);
  }

  let exactCalendarBindings: ReadonlySet<ts.VariableDeclaration> = new Set();
  let exactCalendarFactory: ts.FunctionDeclaration | undefined;
  if (requiresInteraction) {
    const calendarInventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile, checker });
    if (terminalIrUnitsForSource(calendarInventory, sourceFile).length !== 10) return undefined;
    const expectedFunctionNames = new Set<string>(IR_STANDALONE_CALENDAR_TERMINAL_NAMES);
    const topLevelFunctions = sourceFile.statements.filter(ts.isFunctionDeclaration);
    const functionsByName = new Map<string, ts.FunctionDeclaration>();
    for (const fn of topLevelFunctions) {
      if (!fn.name || !fn.body || !expectedFunctionNames.has(fn.name.text) || functionsByName.has(fn.name.text)) {
        return undefined;
      }
      functionsByName.set(fn.name.text, fn);
    }
    if (
      topLevelFunctions.length !== IR_STANDALONE_CALENDAR_TERMINAL_NAMES.length ||
      IR_STANDALONE_CALENDAR_TERMINAL_NAMES.some((name) => !functionsByName.has(name))
    ) {
      return undefined;
    }

    const nullableDomDeclarations: ts.VariableDeclaration[] = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (hasExactNullableHtmlElementType(declaration)) nullableDomDeclarations.push(declaration);
      }
    }
    const expectedBindingNames = new Set<string>(IR_STANDALONE_CALENDAR_DOM_BINDING_NAMES);
    const declarationsByName = new Map<string, ts.VariableDeclaration>();
    const declarationsBySymbol = new Map<ts.Symbol, ts.VariableDeclaration>();
    for (const declaration of nullableDomDeclarations) {
      if (
        !isExactNullableHtmlElementDeclaration(declaration) ||
        !ts.isIdentifier(declaration.name) ||
        !expectedBindingNames.has(declaration.name.text) ||
        declarationsByName.has(declaration.name.text)
      ) {
        return undefined;
      }
      const symbol = checker.getSymbolAtLocation(declaration.name);
      if (
        !symbol ||
        symbol.valueDeclaration !== declaration ||
        !symbol.declarations ||
        symbol.declarations.length !== 1 ||
        symbol.declarations[0] !== declaration ||
        declarationsBySymbol.has(symbol)
      ) {
        return undefined;
      }
      declarationsByName.set(declaration.name.text, declaration);
      declarationsBySymbol.set(symbol, declaration);
    }
    if (
      nullableDomDeclarations.length !== IR_STANDALONE_CALENDAR_DOM_BINDING_NAMES.length ||
      IR_STANDALONE_CALENDAR_DOM_BINDING_NAMES.some((name) => !declarationsByName.has(name))
    ) {
      return undefined;
    }

    const elFactory = functionsByName.get("el");
    if (!elFactory || factoryOwners.size !== 1 || !factoryOwners.has(elFactory)) return undefined;
    if (
      elFactory.parameters.length !== 2 ||
      elFactory.parameters.some(
        (parameter, index) =>
          !ts.isIdentifier(parameter.name) ||
          parameter.name.text !== (index === 0 ? "tag" : "css") ||
          parameter.questionToken !== undefined ||
          parameter.dotDotDotToken !== undefined ||
          parameter.initializer !== undefined ||
          parameter.type?.kind !== ts.SyntaxKind.StringKeyword,
      )
    ) {
      return undefined;
    }
    exactCalendarFactory = elFactory;

    const isExactFactoryCall = (value: ts.Expression): boolean => {
      if (
        !ts.isCallExpression(value) ||
        value.questionDotToken ||
        (value.typeArguments?.length ?? 0) !== 0 ||
        value.arguments.length !== 2 ||
        value.arguments.some(ts.isSpreadElement) ||
        !ts.isIdentifier(value.expression) ||
        value.expression.text !== "el" ||
        checker.getSymbolAtLocation(value.expression)?.valueDeclaration !== elFactory
      ) {
        return false;
      }
      return checker.getResolvedSignature(value)?.getDeclaration() === elFactory;
    };
    const useCounts = new Map<ts.VariableDeclaration, number>(
      nullableDomDeclarations.map((declaration) => [declaration, 0] as const),
    );
    let closedUseCensus = true;
    const inspectUses = (node: ts.Node): void => {
      if (!closedUseCensus) return;
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        const declaration = symbol ? declarationsBySymbol.get(symbol) : undefined;
        if (declaration) {
          useCounts.set(declaration, useCounts.get(declaration)! + 1);
          if (node !== declaration.name) {
            const parent = node.parent;
            const strictNullComparison =
              ts.isBinaryExpression(parent) &&
              (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
                parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
              ((parent.left === node && parent.right.kind === ts.SyntaxKind.NullKeyword) ||
                (parent.right === node && parent.left.kind === ts.SyntaxKind.NullKeyword));
            const exactWrite =
              ts.isBinaryExpression(parent) &&
              parent.left === node &&
              parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              (parent.right.kind === ts.SyntaxKind.NullKeyword || isExactFactoryCall(parent.right));
            const receiverOperation =
              ts.isPropertyAccessExpression(parent) && parent.expression === node ? operations.get(parent) : undefined;
            const exactDomReceiver =
              receiverOperation !== undefined &&
              receiverOperation.kind !== "global-get" &&
              receiverOperation.receiverClass === "HTMLElement";
            let exactDomArgument = false;
            if (ts.isCallExpression(parent)) {
              const argumentIndex = parent.arguments.indexOf(node);
              const callOperation = operations.get(parent);
              exactDomArgument =
                argumentIndex >= 0 &&
                callOperation?.kind === "member-call" &&
                callOperation.argumentBoundaries[argumentIndex] === "dom-handle";
            }
            if (!strictNullComparison && !exactWrite && !exactDomReceiver && !exactDomArgument) {
              closedUseCensus = false;
              return;
            }
          }
        }
      }
      forEachChild(node, inspectUses);
    };
    inspectUses(sourceFile);
    if (!closedUseCensus || [...useCounts.values()].some((count) => count < 2)) return undefined;
    exactCalendarBindings = new Set(nullableDomDeclarations);
  }

  const exactBinding = Object.freeze({ capability: "dom" as const, className: "HTMLElement" as const });
  return Object.freeze({
    moduleBinding(
      declaration: ts.VariableDeclaration,
      writeValue?: ts.Expression,
    ): IrStandaloneDomModuleBinding | undefined {
      if (!requiresInteraction || !exactCalendarFactory || !exactCalendarBindings.has(declaration)) return undefined;
      if (writeValue === undefined || writeValue.kind === ts.SyntaxKind.NullKeyword) return exactBinding;
      if (
        !ts.isCallExpression(writeValue) ||
        writeValue.questionDotToken ||
        (writeValue.typeArguments?.length ?? 0) !== 0 ||
        writeValue.arguments.length !== 2 ||
        writeValue.arguments.some(ts.isSpreadElement) ||
        !ts.isIdentifier(writeValue.expression) ||
        writeValue.expression.text !== "el" ||
        checker.getSymbolAtLocation(writeValue.expression)?.valueDeclaration !== exactCalendarFactory
      ) {
        return undefined;
      }
      return checker.getResolvedSignature(writeValue)?.getDeclaration() === exactCalendarFactory
        ? exactBinding
        : undefined;
    },
  });
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
  const reject = (_node: ts.Node): void => {
    invalid = true;
  };

  const register = (nodes: readonly ts.Node[], operation: IrStandaloneDomOperation): void => {
    const owner = containingTopLevelFunction(nodes[0]!);
    if (!owner || owner.getSourceFile() !== sourceFile) {
      reject(nodes[0]!);
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
        reject(node);
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
          reject(node);
          return;
        }
      } else {
        if (node.questionDotToken || !ts.isIdentifier(node.name)) {
          reject(node);
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
            reject(node);
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
            reject(node);
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
            (consumer.name.text !== "cssText" && consumer.name.text !== "background") ||
            exactAssignment(consumer) === undefined
          ) {
            reject(node);
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
            reject(node);
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
        } else if (receiverClass === "CSSStyleDeclaration" && (member === "cssText" || member === "background")) {
          const assignment = exactAssignment(node);
          if (
            !assignment ||
            !memberIsLibraryOwned(node, "CSSStyleDeclaration", checker) ||
            !isExactlyString(assignment.right, checker)
          ) {
            reject(node);
            return;
          }
          const operation = Object.freeze({
            kind: "member-set" as const,
            importName:
              member === "cssText"
                ? ("CSSStyleDeclaration_set_cssText" as const)
                : ("CSSStyleDeclaration_set_background" as const),
            assignment,
            access: node,
            receiverClass: "CSSStyleDeclaration" as const,
            valueBoundary: "native-string" as const,
          });
          register([node, assignment], operation);
        } else if (receiverClass === "HTMLElement" && member === "addEventListener") {
          const call = exactCall(node);
          const callback = call?.arguments[1];
          const declaration = call ? checker.getResolvedSignature(call)?.getDeclaration() : undefined;
          const declarationParent = declaration?.parent;
          const declarationOwner =
            declarationParent &&
            (ts.isInterfaceDeclaration(declarationParent) || ts.isClassDeclaration(declarationParent))
              ? declarationParent.name?.text
              : undefined;
          if (
            !call ||
            call.questionDotToken ||
            (call.typeArguments?.length ?? 0) !== 0 ||
            call.arguments.length !== 2 ||
            call.arguments.some(ts.isSpreadElement) ||
            !memberIsLibraryOwned(node, declarationOwner === "EventTarget" ? "EventTarget" : "HTMLElement", checker) ||
            !resolvedCallIsLibraryOwned(
              call,
              member,
              declarationOwner === "EventTarget" ? "EventTarget" : "HTMLElement",
              checker,
            ) ||
            !isExactlyString(call.arguments[0]!, checker) ||
            !callback ||
            !ts.isArrowFunction(callback)
          ) {
            reject(node);
            return;
          }
          const operation = Object.freeze({
            kind: "member-call" as const,
            importName: "HTMLElement_addEventListener" as const,
            call,
            access: node,
            receiverClass: "HTMLElement" as const,
            resultClass: null,
            argumentBoundaries: Object.freeze(["native-string", "native-callback-zero-void", "nullish"] as const),
          });
          register([node, call], operation);
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
            reject(node);
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
          reject(node);
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
        reject(node);
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
  const requiresInteraction = collectedDomInteractionMode(invalid, owners.size, imports);
  if (requiresInteraction === undefined) return undefined;

  const exactOwners = new Set(owners);
  const exactImports = new Set(imports);
  const storage = certifyCalendarDomStorage(checker, sourceFile, operations, exactOwners, requiresInteraction);
  if (!storage) return undefined;
  return Object.freeze({
    sourceFile,
    owners: exactOwners,
    imports: exactImports,
    requiresInteraction,
    operation(node: ts.Node): IrStandaloneDomOperation | undefined {
      return node.getSourceFile() === sourceFile ? operations.get(node) : undefined;
    },
    moduleBinding: storage.moduleBinding,
  });
}
