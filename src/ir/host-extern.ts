// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2856) Host-extern ambient-global resolution for the IR selector.
//
// Deliberately a LEAF module (imports only the ts facade and the checker
// type-mapper): it is consumed both by `src/codegen/index.ts` (the real
// compiler's `planIrOverlay`) and by `scripts/check-ir-fallbacks.ts` (the IR
// retirement gate, which builds its own program/checker). Importing it from
// the gate script must not drag the whole codegen module graph in — doing so
// perturbs ESM evaluation order and trips the coercion-engine/string-ops
// circular-init TDZ.

import { ts } from "../ts-api.js";
import { isExternalDeclaredClass } from "../checker/type-mapper.js";

export interface IrAmbientClassCallCertification {
  readonly call: ts.CallExpression;
  readonly targetName: string;
  readonly declaration: ts.FunctionDeclaration;
}

export type IrAmbientClassCallResolver = (call: ts.CallExpression) => IrAmbientClassCallCertification | undefined;

function hasDeclareModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
}

function isFixedPrimitiveAmbientType(node: ts.TypeNode | undefined): boolean {
  return (
    node?.kind === ts.SyntaxKind.BooleanKeyword ||
    node?.kind === ts.SyntaxKind.NumberKeyword ||
    node?.kind === ts.SyntaxKind.StringKeyword
  );
}

/**
 * #3657 — certify a direct call from a top-level class member to a same-file
 * user `declare function` stub.
 *
 * This deliberately excludes lib globals, imports, overloads, aliases,
 * optional/rest/default parameters, and nested functions. The checker proves
 * declaration identity (so a shadow with the same spelling cannot pass), while
 * the syntax gate keeps the admitted ABI to exact fixed-arity primitive
 * params/results already registered by `collectExternDeclarations`.
 */
export function makeIrAmbientClassCallResolver(checker: ts.TypeChecker): IrAmbientClassCallResolver {
  return (call: ts.CallExpression): IrAmbientClassCallCertification | undefined => {
    try {
      if (
        call.questionDotToken ||
        (call.typeArguments?.length ?? 0) > 0 ||
        !ts.isIdentifier(call.expression) ||
        call.arguments.some(ts.isSpreadElement)
      ) {
        return undefined;
      }

      let owner: ts.Node | undefined = call.parent;
      while (owner && !ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
      if (
        !owner ||
        (!ts.isMethodDeclaration(owner) &&
          !ts.isGetAccessorDeclaration(owner) &&
          !ts.isSetAccessorDeclaration(owner) &&
          !ts.isConstructorDeclaration(owner)) ||
        !ts.isClassDeclaration(owner.parent) ||
        !ts.isSourceFile(owner.parent.parent)
      ) {
        return undefined;
      }

      const resolved = checker.getResolvedSignature(call);
      const declaration = resolved?.declaration;
      if (
        !resolved ||
        !declaration ||
        !ts.isFunctionDeclaration(declaration) ||
        declaration.body ||
        !declaration.name ||
        declaration.name.text !== call.expression.text ||
        declaration.getSourceFile() !== call.getSourceFile() ||
        !ts.isSourceFile(declaration.parent) ||
        !hasDeclareModifier(declaration) ||
        declaration.asteriskToken ||
        (declaration.typeParameters?.length ?? 0) > 0 ||
        declaration.parameters.length !== call.arguments.length ||
        declaration.parameters.some(
          (parameter) =>
            !ts.isIdentifier(parameter.name) ||
            !!parameter.questionToken ||
            !!parameter.dotDotDotToken ||
            !!parameter.initializer ||
            !isFixedPrimitiveAmbientType(parameter.type),
        ) ||
        !isFixedPrimitiveAmbientType(declaration.type)
      ) {
        return undefined;
      }

      const symbol = checker.getSymbolAtLocation(call.expression);
      if (!symbol?.declarations?.includes(declaration)) return undefined;
      return { call, targetName: declaration.name.text, declaration };
    } catch {
      return undefined;
    }
  };
}

/**
 * #3214 B2 / #2856 Calendar — one checker-certified host callback site.
 *
 * The capture list is declaration-identity based. Selection uses it to prove
 * the names are live in its lexical scope, while lowering rechecks the same
 * set against the IR capture analysis before materialising the closure.
 */
export interface IrHostVoidCallbackCertification {
  readonly call: ts.CallExpression;
  readonly callback: ts.ArrowFunction & { readonly body: ts.Block };
  readonly captureNames: ReadonlySet<string>;
}

export type IrHostVoidCallbackResolver = (call: ts.CallExpression) => IrHostVoidCallbackCertification | undefined;

function containsNode(ancestor: ts.Node, candidate: ts.Node): boolean {
  for (let current: ts.Node | undefined = candidate; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function simpleAssignmentTargetContains(node: ts.Node, target: ts.Symbol, checker: ts.TypeChecker): boolean {
  if (ts.isIdentifier(node)) return checker.getSymbolAtLocation(node) === target;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some((element) =>
      ts.isOmittedExpression(element)
        ? false
        : simpleAssignmentTargetContains(ts.isSpreadElement(element) ? element.expression : element, target, checker),
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return checker.getSymbolAtLocation(property.name) === target;
      }
      if (ts.isPropertyAssignment(property)) {
        return simpleAssignmentTargetContains(property.initializer, target, checker);
      }
      if (ts.isSpreadAssignment(property)) {
        return simpleAssignmentTargetContains(property.expression, target, checker);
      }
      return false;
    });
  }
  return false;
}

function symbolIsWrittenIn(
  root: ts.Node,
  ignoredFunction: ts.ArrowFunction,
  target: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  let written = false;
  const visit = (node: ts.Node): void => {
    if (written) return;
    if (node !== ignoredFunction && ts.isFunctionLike(node)) return;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        (op === ts.SyntaxKind.EqualsToken ||
          (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)) &&
        simpleAssignmentTargetContains(node.left, target, checker)
      ) {
        written = true;
        return;
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      checker.getSymbolAtLocation(node.operand) === target
    ) {
      written = true;
      return;
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (
        !ts.isVariableDeclarationList(node.initializer) &&
        simpleAssignmentTargetContains(node.initializer, target, checker)
      ) {
        written = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return written;
}

/**
 * Build the exact B2 resolver shared by production planning and the fallback
 * gate. It deliberately recognises only the browser-host EventTarget method
 * shape needed by the benchmark helper and calendar:
 *
 *   ambientExtern.addEventListener(type, () => { ... })
 *
 * The callback must be a zero-parameter, block-bodied, synchronous void arrow.
 * Lexical `this`/`arguments`/`super`/`new.target`, nested runtime declarations,
 * and mutable captures are rejected. Captures may only be simple outer
 * parameters or `const` declarations; symbol identity (not spelling) proves
 * both capture ownership and immutability.
 */
export function makeIrHostVoidCallbackResolver(checker: ts.TypeChecker): IrHostVoidCallbackResolver {
  return (call: ts.CallExpression): IrHostVoidCallbackCertification | undefined => {
    try {
      if (
        call.questionDotToken ||
        (call.typeArguments?.length ?? 0) > 0 ||
        call.arguments.length !== 2 ||
        !ts.isExpressionStatement(call.parent) ||
        !ts.isPropertyAccessExpression(call.expression) ||
        call.expression.questionDotToken ||
        call.expression.name.text !== "addEventListener" ||
        !ts.isArrowFunction(call.arguments[1]!)
      ) {
        return undefined;
      }
      const callback = call.arguments[1]!;
      if (
        callback.parameters.length !== 0 ||
        !ts.isBlock(callback.body) ||
        callback.body.statements.length === 0 ||
        (callback.typeParameters?.length ?? 0) > 0 ||
        callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
        (callback.type !== undefined && callback.type.kind !== ts.SyntaxKind.VoidKeyword)
      ) {
        return undefined;
      }

      let owner: ts.Node | undefined = callback.parent;
      while (owner && !ts.isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
      if (!owner || !ts.isFunctionDeclaration(owner) || !owner.body || !ts.isSourceFile(owner.parent)) {
        return undefined;
      }

      // Multiple sibling callback sites are safe when they are the owner's
      // only runtime declarations: source-order lowering then assigns the
      // contiguous `<owner>__closure_N` names recorded by the overlay plan.
      // This is intentionally only a syntactic sibling screen. Each sibling
      // is independently checker-certified when selection reaches its call;
      // a malformed sibling therefore rejects the owner before claim.
      let unsupportedSiblingRuntime = false;
      const visitSiblingRuntime = (node: ts.Node): void => {
        if (unsupportedSiblingRuntime || node === callback) return;
        if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
          const parent = node.parent;
          const isSiblingHostCallbackCandidate =
            ts.isArrowFunction(node) &&
            ts.isCallExpression(parent) &&
            parent.arguments[1] === node &&
            ts.isExpressionStatement(parent.parent) &&
            ts.isPropertyAccessExpression(parent.expression) &&
            parent.expression.name.text === "addEventListener";
          if (!isSiblingHostCallbackCandidate) unsupportedSiblingRuntime = true;
          return;
        }
        ts.forEachChild(node, visitSiblingRuntime);
      };
      ts.forEachChild(owner.body, visitSiblingRuntime);
      if (unsupportedSiblingRuntime) return undefined;

      const resolved = checker.getResolvedSignature(call);
      const declaration = resolved?.declaration;
      if (!resolved || !declaration || !declaration.getSourceFile().isDeclarationFile) return undefined;
      const declarationName = "name" in declaration ? declaration.name : undefined;
      if (!declarationName || !ts.isIdentifier(declarationName) || declarationName.text !== "addEventListener") {
        return undefined;
      }
      if ((checker.getReturnTypeOfSignature(resolved).flags & ts.TypeFlags.Void) === 0) return undefined;

      const receiverType = checker.getNonNullableType(checker.getTypeAtLocation(call.expression.expression));
      if (!isExternalDeclaredClass(receiverType, checker)) return undefined;
      const callbackSignature = checker.getSignatureFromDeclaration(callback);
      if (!callbackSignature || (checker.getReturnTypeOfSignature(callbackSignature).flags & ts.TypeFlags.Void) === 0) {
        return undefined;
      }

      // The existing IR capture materializer is keyed by lexical spelling.
      // Pre-claim reject an owner binding whose spelling is also used by a
      // different identifier symbol inside the callback (for example an outer
      // `textContent` parameter plus `sink.textContent`). Without this guard,
      // lowering would mistake the property name for an extra capture even
      // though the checker correctly resolves it to the ambient property.
      const ownerBindingsByName = new Map<string, Set<ts.Symbol>>();
      const registerOwnerBindingName = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) {
          const symbol = checker.getSymbolAtLocation(name);
          if (symbol) {
            let symbols = ownerBindingsByName.get(name.text);
            if (!symbols) ownerBindingsByName.set(name.text, (symbols = new Set()));
            symbols.add(symbol);
          }
          return;
        }
        for (const element of name.elements) {
          if (!ts.isOmittedExpression(element)) registerOwnerBindingName(element.name);
        }
      };
      for (const parameter of owner.parameters) {
        registerOwnerBindingName(parameter.name);
      }
      const collectOwnerBindings = (node: ts.Node): void => {
        if (node === callback || (node !== owner && (ts.isFunctionLike(node) || ts.isClassLike(node)))) return;
        if (ts.isVariableDeclaration(node)) registerOwnerBindingName(node.name);
        ts.forEachChild(node, collectOwnerBindings);
      };
      ts.forEachChild(owner.body, collectOwnerBindings);

      let invalidLexicalShape = false;
      const captureSymbols = new Map<ts.Symbol, string>();
      const visit = (node: ts.Node): void => {
        if (invalidLexicalShape) return;
        if (node !== callback && (ts.isFunctionLike(node) || ts.isClassLike(node))) {
          invalidLexicalShape = true;
          return;
        }
        if (
          node.kind === ts.SyntaxKind.ThisKeyword ||
          node.kind === ts.SyntaxKind.SuperKeyword ||
          ts.isMetaProperty(node) ||
          ts.isYieldExpression(node) ||
          (ts.isIdentifier(node) && node.text === "arguments")
        ) {
          invalidLexicalShape = true;
          return;
        }
        if (ts.isIdentifier(node)) {
          const symbol = checker.getSymbolAtLocation(node);
          const sameSpellingOwnerBindings = ownerBindingsByName.get(node.text);
          if (sameSpellingOwnerBindings && (!symbol || !sameSpellingOwnerBindings.has(symbol))) {
            invalidLexicalShape = true;
            return;
          }
          const captureDeclaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
          if (
            symbol &&
            captureDeclaration &&
            containsNode(owner!, captureDeclaration) &&
            !containsNode(callback, captureDeclaration)
          ) {
            if (ts.isParameter(captureDeclaration) && ts.isIdentifier(captureDeclaration.name)) {
              captureSymbols.set(symbol, captureDeclaration.name.text);
            } else if (
              ts.isVariableDeclaration(captureDeclaration) &&
              ts.isIdentifier(captureDeclaration.name) &&
              ts.isVariableDeclarationList(captureDeclaration.parent) &&
              (captureDeclaration.parent.flags & ts.NodeFlags.Const) !== 0
            ) {
              captureSymbols.set(symbol, captureDeclaration.name.text);
            } else {
              invalidLexicalShape = true;
              return;
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(callback.body, visit);
      if (invalidLexicalShape) return undefined;

      for (const symbol of captureSymbols.keys()) {
        if (symbolIsWrittenIn(owner.body, callback, symbol, checker)) return undefined;
      }
      return {
        call,
        callback: callback as ts.ArrowFunction & { readonly body: ts.Block },
        captureNames: new Set(captureSymbols.values()),
      };
    } catch {
      return undefined;
    }
  };
}

/**
 * Build the selector's host-global resolver: identifier node → extern class
 * name ("Document", "Console"), or undefined when the identifier is not an
 * ambient host global the legacy backend would service.
 *
 * Checker-backed on purpose: (a) selection runs before the ctx registries
 * (`declaredGlobals` / `externClasses`) are populated, and (b) the checker
 * resolves the identifier's REAL binding, so user shadowing (`const document
 * = ...`) wins over the lib global by construction. The
 * `isExternalDeclaredClass` gate keeps selector claims in lockstep with what
 * `collectDeclaredGlobals` will actually register as a `global_<name>`
 * handle import.
 *
 * `console` is special-cased: the legacy backend services `console.<m>(...)`
 * via dedicated per-arg-type import variants (`console_log_string`, … — see
 * `collectConsoleImports`), NOT via a `global_console` handle, so it must not
 * need to pass the declared-class gate to be claimable as a method-call
 * receiver.
 *
 * Exclusions:
 *   - `Math` is owned by the dedicated IR whitelist arm
 *     (IR_MATH_UNARY_WHITELIST / mathUnaryToIrOp) — claiming it generically
 *     would bypass the whitelist's method gating.
 *   - CONSTRUCTOR/callable-typed globals (`Date: DateConstructor`,
 *     `Symbol: SymbolConstructor`, …): their static members are
 *     legacy-intercepted (Date.now, Array.isArray, …) and the extern-member
 *     machinery does not model them — claiming one would route a static call
 *     to a nonexistent `<TypeName>_<member>` import. Only INSTANCE-shaped
 *     globals (document, performance, …) resolve.
 */
export function makeIrHostGlobalResolver(checker: ts.TypeChecker): (node: ts.Identifier) => string | undefined {
  return (node: ts.Identifier): string | undefined => {
    try {
      if (node.text === "Math") return undefined;
      const sym = checker.getSymbolAtLocation(node);
      const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
      if (!decl || !ts.isVariableDeclaration(decl)) return undefined;
      if (!decl.getSourceFile().isDeclarationFile) return undefined;
      const type = checker.getTypeAtLocation(decl);
      if (node.text === "console") return "Console";
      if (type.getConstructSignatures().length > 0 || type.getCallSignatures().length > 0) return undefined;
      if (!isExternalDeclaredClass(type, checker)) return undefined;
      return type.getSymbol()?.name;
    } catch {
      return undefined;
    }
  };
}
