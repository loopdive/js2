// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachChild, ts } from "../../ts-api.js";
import { makeLocalNumberReceiverDomain } from "./local-number-receiver-domain.js";

type FunctionLike = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };

interface LocalValueDef {
  readonly expr?: ts.Expression;
  readonly forcedNumeric?: boolean;
}

interface SlotView {
  readonly isParam: boolean;
  readonly defs: readonly LocalValueDef[];
}

interface ScopeView<S extends SlotView> {
  frameOf(node: ts.Node): ts.Node;
  resolve(node: ts.Node, name: string): S | undefined;
}

interface LocalProofHost {
  readonly oracle?: {
    typeFactOf(node: ts.Node): { readonly kind: string };
    valueDeclarationOf?(node: ts.Node): ts.Declaration | undefined;
  };
  readonly openWorldPropertyReads?: boolean;
}

interface BroadProof {
  isNumeric(expr: ts.Expression): boolean;
}

interface LocalProofPolicy {
  unwrap(expr: ts.Expression): ts.Expression;
  isFunctionLikeWithBody(node: ts.Node): node is FunctionLike;
  assignmentPropertyName(expr: ts.Expression): string | undefined;
  ownReturnExpressions(fn: FunctionLike): ts.Expression[] | undefined;
  readonly BOOLEAN_BINARY: ReadonlySet<ts.SyntaxKind>;
  readonly ALWAYS_NUMERIC_BINARY: ReadonlySet<ts.SyntaxKind>;
  readonly ALWAYS_NUMERIC_COMPOUND: ReadonlySet<ts.SyntaxKind>;
  readonly NUMERIC_GLOBAL_CALLS: ReadonlySet<string>;
  readonly STRING_NUMERIC_METHODS: ReadonlySet<string>;
  readonly STRING_STRING_METHODS: ReadonlySet<string>;
}

type NumberCarrier = "number" | "non-number" | "unknown";

interface StringEffectContext<S extends SlotView> {
  readonly host: LocalProofHost;
  readonly sourceFiles: readonly ts.SourceFile[];
  readonly scopes: ScopeView<S>;
  readonly policy: LocalProofPolicy;
  readonly isKnownGlobal: (identifier: ts.Identifier) => boolean;
  readonly isInertGlobalRead: (identifier: ts.Identifier) => boolean;
  readonly isKnownIntrinsicMember: (callee: ts.PropertyAccessExpression) => boolean;
  readonly eligibleParameters: ReadonlySet<S>;
  readonly declaredCallables: ReadonlyMap<ts.Declaration, number>;
  readonly changedBindings: ReadonlySet<ts.Declaration>;
  readonly closedCallables: ReadonlyMap<ts.Declaration, FunctionLike>;
}

type EffectPrimitive = "string" | "primitive" | "unknown";
type ReceiverDomain = ReturnType<typeof makeLocalNumberReceiverDomain>;
type ReceiverQuery = Parameters<Parameters<ReceiverDomain["withQuery"]>[1]>[0];

interface ReceiverEffectBridge {
  primitive(expr: ts.Expression): EffectPrimitive;
  read(member: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean;
  write(target: ts.Expression, node: ts.Node): boolean;
  call(call: ts.CallExpression): boolean;
}

/** Pure original ancestry: erased wrappers do not supply identity/value evidence. */
function transparentCalleeCall(
  identifier: ts.Identifier,
  sourceFiles: readonly ts.SourceFile[],
  unwrap: LocalProofPolicy["unwrap"],
): ts.CallExpression | undefined {
  const source = identifier.getSourceFile();
  if (!sourceFiles.includes(source)) return undefined;
  let expression: ts.Expression = identifier;
  for (let depth = 0; depth <= 48; depth++) {
    const parent = expression.parent;
    if (!parent || parent.getSourceFile() !== source) return undefined;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === expression
    ) {
      if (depth === 48) return undefined;
      expression = parent;
      continue;
    }
    return ts.isCallExpression(parent) &&
      parent.expression === expression &&
      !parent.questionDotToken &&
      !parent.arguments.some(ts.isSpreadElement) &&
      unwrap(parent.expression) === identifier
      ? parent
      : undefined;
  }
  return undefined;
}

function effectCallable<S extends SlotView>(
  expression: ts.Expression,
  context: StringEffectContext<S>,
): FunctionLike | undefined {
  const callee = context.policy.unwrap(expression);
  let fn: FunctionLike | undefined;
  if (ts.isIdentifier(callee)) {
    const declaration = context.host.oracle?.valueDeclarationOf?.(callee);
    if (!declaration || context.changedBindings.has(declaration)) return undefined;
    if (ts.isFunctionDeclaration(declaration) && context.policy.isFunctionLikeWithBody(declaration)) {
      if (context.declaredCallables.get(declaration) !== 1) return undefined;
      fn = declaration;
    } else if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const slot = context.scopes.resolve(callee, callee.text);
      const value = context.policy.unwrap(declaration.initializer);
      if (
        slot?.defs.length === 1 &&
        slot.defs[0]?.expr === declaration.initializer &&
        (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
      )
        fn = value;
    }
  } else if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) fn = callee;
  if (
    !fn ||
    !context.sourceFiles.includes(fn.getSourceFile()) ||
    ("asteriskToken" in fn && fn.asteriskToken) ||
    fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  )
    return undefined;
  return fn;
}

/** Effect-only value kinds: no annotations, broad votes or new carrier admission. */
function makePrimitiveEffectProof<S extends SlotView>(
  context: StringEffectContext<S>,
  bridge?: ReceiverEffectBridge,
): (expression: ts.Expression, depth?: number) => EffectPrimitive {
  const slotsInFlight = new Set<S>();
  const callsInFlight = new Set<FunctionLike>();
  const { policy, scopes, eligibleParameters, isKnownGlobal, isKnownIntrinsicMember } = context;
  const join = (left: EffectPrimitive, right: EffectPrimitive): EffectPrimitive =>
    left === "unknown" || right === "unknown"
      ? "unknown"
      : left === "string" && right === "string"
        ? "string"
        : "primitive";
  const proveValue = (expression: ts.Expression, depth = 0): EffectPrimitive => {
    if (depth > 48) return "unknown";
    const value = policy.unwrap(expression);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return "string";
    if (
      ts.isNumericLiteral(value) ||
      ts.isBigIntLiteral(value) ||
      value.kind === ts.SyntaxKind.TrueKeyword ||
      value.kind === ts.SyntaxKind.FalseKeyword ||
      value.kind === ts.SyntaxKind.NullKeyword
    )
      return "primitive";
    if (ts.isTemplateExpression(value)) {
      return value.templateSpans.every((span) => prove(span.expression, depth + 1) !== "unknown")
        ? "string"
        : "unknown";
    }
    if (ts.isIdentifier(value)) {
      const slot = scopes.resolve(value, value.text);
      if (!slot)
        return (value.text === "NaN" || value.text === "Infinity" || value.text === "undefined") && isKnownGlobal(value)
          ? "primitive"
          : "unknown";
      if (slotsInFlight.has(slot) || slot.defs.length === 0 || (slot.isParam && !eligibleParameters.has(slot)))
        return "unknown";
      slotsInFlight.add(slot);
      try {
        let kind: EffectPrimitive | undefined;
        for (const def of slot.defs) {
          if (def.expr === undefined) {
            if (!def.forcedNumeric) return "unknown";
            continue;
          }
          const current = prove(def.expr, depth + 1);
          kind = kind === undefined ? current : join(kind, current);
        }
        return kind ?? "unknown";
      } finally {
        slotsInFlight.delete(slot);
      }
    }
    if (ts.isConditionalExpression(value)) {
      return join(prove(value.whenTrue, depth + 1), prove(value.whenFalse, depth + 1));
    }
    if (ts.isTypeOfExpression(value) || ts.isVoidExpression(value) || ts.isDeleteExpression(value)) {
      return ts.isTypeOfExpression(value) ? "string" : "primitive";
    }
    if (ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value)) {
      return value.operator === ts.SyntaxKind.ExclamationToken || prove(value.operand, depth + 1) !== "unknown"
        ? "primitive"
        : "unknown";
    }
    if (ts.isBinaryExpression(value)) {
      const op = value.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.CommaToken) return prove(value.right, depth + 1);
      if (policy.BOOLEAN_BINARY.has(op)) return "primitive";
      const left = prove(value.left, depth + 1);
      const right = prove(value.right, depth + 1);
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      )
        return join(left, right);
      if (left === "unknown" || right === "unknown") return "unknown";
      return (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.PlusEqualsToken) &&
        (left === "string" || right === "string")
        ? "string"
        : "primitive";
    }
    if (
      ts.isPropertyAccessExpression(value) &&
      value.name.text === "length" &&
      prove(value.expression, depth + 1) === "string"
    )
      return "primitive";
    if (!ts.isCallExpression(value) || value.questionDotToken) return "unknown";
    const callee = policy.unwrap(value.expression);
    if (ts.isIdentifier(callee) && isKnownGlobal(callee)) {
      if (callee.text === "String") return "string";
      if (["Number", "parseInt", "parseFloat", "Boolean", "Symbol", "BigInt"].includes(callee.text)) return "primitive";
    }
    if (ts.isPropertyAccessExpression(callee) && !callee.questionDotToken) {
      if (isKnownIntrinsicMember(callee)) return "primitive";
      if (prove(callee.expression, depth + 1) === "string") {
        if (
          policy.STRING_NUMERIC_METHODS.has(callee.name.text) &&
          callee.name.text !== "search" &&
          callee.name.text !== "codePointAt"
        )
          return "primitive";
        if (
          policy.STRING_STRING_METHODS.has(callee.name.text) &&
          callee.name.text !== "replace" &&
          callee.name.text !== "replaceAll"
        )
          return "string";
      }
    }
    const fn = effectCallable(callee, context);
    if (!fn || callsInFlight.has(fn)) return "unknown";
    const returns = policy.ownReturnExpressions(fn);
    if (!returns) return "unknown";
    callsInFlight.add(fn);
    try {
      return returns.reduce<EffectPrimitive>(
        (kind, expr) => join(kind, prove(expr, depth + 1)),
        prove(returns[0]!, depth + 1),
      );
    } finally {
      callsInFlight.delete(fn);
    }
  };
  const prove = (expression: ts.Expression, depth = 0): EffectPrimitive => {
    if (depth > 48) return "unknown";
    const result = proveValue(expression, depth);
    return result === "unknown" ? (bridge?.primitive(expression) ?? "unknown") : result;
  };
  return prove;
}

/** Effect capability only: original scans separately prove operand evaluation. */
function makeInertIntrinsicCallProof<S extends SlotView>(
  context: StringEffectContext<S>,
  primitiveFallback: ReceiverEffectBridge["primitive"],
): (call: ts.CallExpression) => boolean {
  const primitive = makePrimitiveEffectProof(context, {
    primitive: primitiveFallback,
    read: () => false,
    write: () => false,
    call: () => false,
  });
  return (call) => {
    if (call.questionDotToken || call.arguments.some(ts.isSpreadElement)) return false;
    const callee = context.policy.unwrap(call.expression);
    if (ts.isIdentifier(callee) && context.isKnownGlobal(callee)) {
      // ToBoolean does not invoke user coercion hooks; evaluation is still scanned.
      if (callee.text === "Boolean") return true;
      if (!["Number", "String", "parseInt", "parseFloat"].includes(callee.text)) return false;
    } else if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.questionDotToken ||
      !context.isKnownIntrinsicMember(callee)
    )
      return false;
    return call.arguments.every((argument) => primitive(argument) !== "unknown");
  };
}

/** A finite source effect perimeter; unsupported getters/coercions remain unknown. */
function makeClosedStringEffectProof<S extends SlotView>(
  context: StringEffectContext<S>,
  changedKeys: ReadonlySet<string>,
  bridge?: ReceiverEffectBridge,
): boolean {
  const primitive = makePrimitiveEffectProof(context, bridge);
  const { policy, scopes, isKnownGlobal, isInertGlobalRead, isKnownIntrinsicMember } = context;
  const inFlight = new Set<FunctionLike>();
  const isPrimitive = (expr: ts.Expression, depth: number): boolean => primitive(expr, depth) !== "unknown";
  const identifierSafe = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (
      (ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isBindingElement(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isEnumMember(parent) ||
        ts.isModuleDeclaration(parent)) &&
      parent.name === node
    )
      return true;
    if (
      (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
      parent.label === node
    )
      return true;
    if (scopes.resolve(node, node.text) || isInertGlobalRead(node)) return true;
    const declaration = context.host.oracle?.valueDeclarationOf?.(node);
    return (
      !!declaration &&
      context.sourceFiles.includes(declaration.getSourceFile()) &&
      (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration) || ts.isEnumDeclaration(declaration))
    );
  };
  const prototype = (expr: ts.Expression): boolean => {
    const value = policy.unwrap(expr);
    if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return false;
    const root = policy.unwrap(value.expression);
    return (
      ts.isIdentifier(root) &&
      root.text === "String" &&
      isKnownGlobal(root) &&
      policy.assignmentPropertyName(value) === "prototype"
    );
  };
  const readSafe = (value: ts.PropertyAccessExpression | ts.ElementAccessExpression, depth: number): boolean => {
    if (value.questionDotToken) return false;
    if (bridge?.read(value)) return safe(value.expression, depth + 1);
    if (!ts.isPropertyAccessExpression(value)) return false;
    return (
      value.name.text === "length" &&
      primitive(value.expression, depth + 1) === "string" &&
      safe(value.expression, depth + 1)
    );
  };
  const writeSafe = (expr: ts.Expression, depth: number, node: ts.Node): boolean => {
    const value = policy.unwrap(expr);
    if (ts.isIdentifier(value)) return !!scopes.resolve(value, value.text);
    if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return false;
    if (bridge?.write(value, node)) return safe(value.expression, depth + 1);
    return (
      prototype(value.expression) &&
      policy.assignmentPropertyName(value) !== undefined &&
      safe(value.expression, depth + 1, true)
    );
  };
  const functionSafe = (fn: FunctionLike, depth: number): boolean => {
    if (
      depth > 48 ||
      inFlight.has(fn) ||
      ("asteriskToken" in fn && fn.asteriskToken) ||
      fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword || ts.isDecorator(modifier))
    )
      return false;
    inFlight.add(fn);
    try {
      return (
        fn.parameters.every((parameter) => !parameter.initializer || safe(parameter.initializer, depth + 1)) &&
        safe(fn.body, depth + 1)
      );
    } finally {
      inFlight.delete(fn);
    }
  };
  const callSafe = (call: ts.CallExpression | ts.NewExpression, depth: number): boolean => {
    if (ts.isCallExpression(call) && call.questionDotToken) return false;
    const args = call.arguments ?? [];
    if (!args.every((arg) => !ts.isSpreadElement(arg) && safe(arg, depth + 1))) return false;
    const callee = policy.unwrap(call.expression);
    if (ts.isIdentifier(callee) && isKnownGlobal(callee)) {
      if (callee.text === "Boolean") return true;
      if (["Number", "String", "parseInt", "parseFloat", "Symbol", "BigInt"].includes(callee.text)) {
        return args.every((arg) => isPrimitive(arg, depth + 1));
      }
    }
    if (ts.isNewExpression(call)) {
      const fn = effectCallable(callee, context);
      return !!fn && functionSafe(fn, depth + 1);
    }
    if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      !callee.questionDotToken &&
      bridge?.call(call)
    )
      return safe(callee.expression, depth + 1);
    if (ts.isPropertyAccessExpression(callee) && !callee.questionDotToken) {
      if (isKnownIntrinsicMember(callee)) return args.every((arg) => isPrimitive(arg, depth + 1));
      const key = callee.name.text;
      const permitted =
        (policy.STRING_NUMERIC_METHODS.has(key) && key !== "search" && key !== "codePointAt") ||
        (policy.STRING_STRING_METHODS.has(key) && key !== "replace" && key !== "replaceAll");
      return (
        permitted &&
        !changedKeys.has(key) &&
        primitive(callee.expression, depth + 1) === "string" &&
        safe(callee.expression, depth + 1) &&
        args.every((arg) => isPrimitive(arg, depth + 1))
      );
    }
    const fn = effectCallable(callee, context);
    return !!fn && functionSafe(fn, depth + 1);
  };
  const safe = (node: ts.Node, depth = 0, handle = false): boolean => {
    if (depth > 48) return false;
    if (
      policy.isFunctionLikeWithBody(node) ||
      ts.isTypeNode(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    )
      return true;
    // Ambient runtime bindings have no source effect/value closure, including
    // a possible global accessor read. Type-only declarations above are inert.
    if (
      (ts.isVariableStatement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
    )
      return false;
    if (ts.isImportDeclaration(node)) return node.importClause?.isTypeOnly === true;
    if (ts.isImportEqualsDeclaration(node)) return node.isTypeOnly;
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) return node.isTypeOnly;
    if (
      ts.isTaggedTemplateExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isYieldExpression(node) ||
      ts.isSpreadElement(node) ||
      ts.isSpreadAssignment(node)
    )
      return false;
    if (
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWithStatement(node) ||
      ts.isHeritageClause(node) ||
      ts.isDecorator(node)
    )
      return false;
    if (ts.isIdentifier(node)) return identifierSafe(node);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) return callSafe(node, depth + 1);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return handle && prototype(node) ? true : readSafe(node, depth + 1);
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
        return (
          safe(node.right, depth + 1) &&
          writeSafe(node.left, depth + 1, node) &&
          (op === ts.SyntaxKind.EqualsToken ||
            (isPrimitive(node.left, depth + 1) && isPrimitive(node.right, depth + 1)))
        );
      }
      const inert =
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.CommaToken;
      if (!inert && (!isPrimitive(node.left, depth + 1) || !isPrimitive(node.right, depth + 1))) return false;
      if (op === ts.SyntaxKind.InKeyword || op === ts.SyntaxKind.InstanceOfKeyword) return false;
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (node.operator !== ts.SyntaxKind.ExclamationToken && !isPrimitive(node.operand, depth + 1)) return false;
      if (
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
        !writeSafe(node.operand, depth + 1, node)
      )
        return false;
    }
    if (ts.isDeleteExpression(node)) return writeSafe(node.expression, depth + 1, node);
    if (ts.isTemplateExpression(node) && !node.templateSpans.every((span) => isPrimitive(span.expression, depth + 1)))
      return false;
    if (ts.isComputedPropertyName(node) && !isPrimitive(node.expression, depth + 1)) return false;
    let ok = true;
    forEachChild(node, (child) => {
      if (ok && !safe(child, depth + 1)) ok = false;
    });
    return ok;
  };
  const closed = new Set(context.closedCallables.values());
  const roots: FunctionLike[] = [];
  for (const sourceFile of context.sourceFiles) {
    const collect = (node: ts.Node): void => {
      if (policy.isFunctionLikeWithBody(node) && !closed.has(node)) roots.push(node);
      forEachChild(node, collect);
    };
    collect(sourceFile);
    if (!safe(sourceFile)) return false;
  }
  return roots.every((fn) => functionSafe(fn, 0));
}

/** Negative stability evidence only; primitive receiver identity is separate. */
function makeStringMethodStability<S extends SlotView>(
  context: StringEffectContext<S>,
  reflectiveGlobals: ReadonlySet<string>,
) {
  const { sourceFiles, policy, isKnownGlobal } = context;
  const { unwrap, assignmentPropertyName } = policy;
  const changedKeys = new Set<string>();
  let incomplete = reflectiveGlobals.has("String");
  const isPrototypeHandle = (expr: ts.Expression): boolean => {
    const value = unwrap(expr);
    if (!ts.isPropertyAccessExpression(value) && !ts.isElementAccessExpression(value)) return false;
    const root = unwrap(value.expression);
    return ts.isIdentifier(root) && root.text === "String" && assignmentPropertyName(value) === "prototype";
  };
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      // Binding AND assignment destructuring may acquire constructor/prototype
      // handles, including nested, defaulted, computed and rest shapes.
      if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) incomplete = true;
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const left = unwrap(node.left);
        if (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left)) incomplete = true;
      }
      const target =
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          ? unwrap(node.left)
          : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
              (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
            ? unwrap(node.operand)
            : ts.isDeleteExpression(node)
              ? unwrap(node.expression)
              : undefined;
      if (target && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))) {
        if (isPrototypeHandle(target.expression)) {
          const key = assignmentPropertyName(target);
          if (key === undefined) incomplete = true;
          else changedKeys.add(key);
        }
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const key = assignmentPropertyName(node);
        // These handles can expose the same intrinsic prototype without a
        // String identifier. Unknown provenance is a veto, not an alias graph.
        if (key === undefined || key === "__proto__" || key === "constructor" || key === "getPrototypeOf")
          incomplete = true;
        if (isPrototypeHandle(node)) {
          const parent = node.parent;
          const isMemberReceiver =
            (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
            parent.expression === node;
          if (!isMemberReceiver || assignmentPropertyName(parent) === undefined) incomplete = true;
          else {
            const use = parent.parent;
            const directCall = ts.isCallExpression(use) && use.expression === parent;
            const directWrite =
              (ts.isBinaryExpression(use) &&
                use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
                use.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
                unwrap(use.left) === parent) ||
              ((ts.isPrefixUnaryExpression(use) || ts.isPostfixUnaryExpression(use)) &&
                (use.operator === ts.SyntaxKind.PlusPlusToken || use.operator === ts.SyntaxKind.MinusMinusToken) &&
                unwrap(use.operand) === parent) ||
              (ts.isDeleteExpression(use) && unwrap(use.expression) === parent);
            // Member-handle aliases and nested assignment patterns do not
            // establish a complete write domain; do not silently ignore them.
            // Even a direct prototype call can install a legacy getter/setter
            // or invoke an unknown replacement. Only static writes are bounded.
            if (directCall || !directWrite) incomplete = true;
          }
        }
      }
      if (ts.isIdentifier(node) && node.text === "String") {
        if (!isKnownGlobal(node)) incomplete = true;
        const parent = node.parent;
        const directCall =
          ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) ||
          transparentCalleeCall(node, sourceFiles, unwrap) !== undefined;
        const prototypeReceiver =
          (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
          parent.expression === node &&
          assignmentPropertyName(parent) === "prototype";
        // A constructor/prototype alias or reflective argument can mutate the
        // method domain. This does NOT invalidate String(...) conversion unless
        // the existing binding-stability proof also withdraws that constructor.
        if (!directCall && !prototypeReceiver) incomplete = true;
      }
      if (ts.isIdentifier(node) && (node.text === "Object" || node.text === "Reflect")) {
        const parent = node.parent;
        const receiver =
          (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
        const directCall = (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node;
        // Escaping a reflection namespace or dynamically selecting its method
        // can hide getPrototypeOf; static unrelated operations remain allowed.
        if (!directCall && (!receiver || assignmentPropertyName(parent) === undefined)) incomplete = true;
      }
      forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  const effectsComplete = !incomplete && makeClosedStringEffectProof(context, changedKeys);
  return {
    isStringMethodDomainStable: (key: string) => effectsComplete && !changedKeys.has(key),
    keyUntouched: (key: string) => !incomplete && !changedKeys.has(key),
    effectsCompleteWith: (bridge: ReceiverEffectBridge) =>
      !incomplete && makeClosedStringEffectProof(context, changedKeys, bridge),
  };
}

/** (#6878) Private declaration, incoming-call and intrinsic-member stability domain. */
function makeLocalCallableDomain<S extends SlotView>(
  host: LocalProofHost,
  sourceFiles: readonly ts.SourceFile[],
  scopes: ScopeView<S>,
  policy: LocalProofPolicy,
) {
  const { unwrap, assignmentPropertyName, isFunctionLikeWithBody } = policy;
  const changedBindings = new Set<ts.Declaration>();
  const declaredCallables = new Map<ts.Declaration, number>();
  const closedCallables = new Map<ts.Declaration, FunctionLike>();
  const sourceBindingsByFrame = new Map<ts.Node, Set<string>>();
  const changedMembers = new Map<ts.Declaration, Set<string | undefined>>();
  const escapedNamespaces = new Set<ts.Declaration>();
  const reflectiveGlobals = new Set<string>();
  const intrinsicGlobals = ["Math", "Date", "Number", "String", "Boolean", "parseInt", "parseFloat", "NaN", "Infinity"];
  const standardDeclaration = (node: ts.Node): ts.Declaration | undefined => {
    const declaration = host.oracle?.valueDeclarationOf?.(node);
    const file = declaration?.getSourceFile();
    return file?.isDeclarationFile && /(?:^|\/)lib(?:\.[\w-]+)*\.d\.ts$/.test(file.fileName) ? declaration : undefined;
  };
  const namespaceDeclaration = (expr: ts.Expression): ts.Declaration | undefined => {
    const value = unwrap(expr);
    if (ts.isIdentifier(value) && (value.text === "Math" || value.text === "Date")) {
      return standardDeclaration(value);
    }
    if (ts.isPropertyAccessExpression(value) && (value.name.text === "Math" || value.name.text === "Date")) {
      return standardDeclaration(value.name);
    }
    return undefined;
  };
  // A declaration's original body is no longer the entire callable domain
  // after reassignment. Resolve mutations by identity, including nested writes.
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "globalThis") {
        const parent = node.parent;
        const receiver =
          (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
        const key = receiver ? assignmentPropertyName(parent) : undefined;
        // Element access need not resolve to a declaration (globalThis['Math']
        // is one such route). A static intrinsic access or an escaped/unknown
        // global receiver cannot establish a complete member mutation domain.
        // Text here only WITHDRAWS evidence, including lexical globalThis
        // shadows; it never grants intrinsic identity from a spelling.
        if (key === undefined) for (const name of intrinsicGlobals) reflectiveGlobals.add(name);
        else if (intrinsicGlobals.includes(key)) reflectiveGlobals.add(key);
      }
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
        const frame = scopes.frameOf(node.parent);
        let names = sourceBindingsByFrame.get(frame);
        if (!names) sourceBindingsByFrame.set(frame, (names = new Set()));
        names.add(node.name.text);
      }
      if (ts.isFunctionDeclaration(node) && node.name) {
        const binding = host.oracle?.valueDeclarationOf?.(node.name);
        if (binding) declaredCallables.set(binding, (declaredCallables.get(binding) ?? 0) + 1);
        if (
          binding &&
          isFunctionLikeWithBody(node) &&
          !node.modifiers?.some(
            (modifier) =>
              modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword,
          )
        ) {
          closedCallables.set(binding, node);
        }
      }
      const target =
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          ? unwrap(node.left)
          : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
              (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
            ? unwrap(node.operand)
            : ts.isDeleteExpression(node)
              ? unwrap(node.expression)
              : undefined;
      if (target && ts.isIdentifier(target)) {
        const binding = host.oracle?.valueDeclarationOf?.(target);
        if (binding) changedBindings.add(binding);
      }
      if (target && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))) {
        const binding = namespaceDeclaration(target.expression);
        if (binding) {
          let keys = changedMembers.get(binding);
          if (!keys) changedMembers.set(binding, (keys = new Set()));
          keys.add(assignmentPropertyName(target));
        }
      }
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
        const binding = namespaceDeclaration(node);
        if (binding) {
          const parent = node.parent;
          const isMemberReceiver =
            (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
            parent.expression === node;
          const isDateConstructor =
            ts.isIdentifier(node) && node.text === "Date" && ts.isNewExpression(parent) && parent.expression === node;
          if (!isMemberReceiver && !isDateConstructor) escapedNamespaces.add(binding);
        }
      }
      forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  // Recorded arguments are complete only for an unexported, unreassigned
  // declaration whose every reference is a direct call. An escape/alias/import
  // cannot be treated as an empty incoming population. This gate affects only
  // the local projection; the existing broad parameter agreement is untouched.
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isExportDeclaration(node) &&
        !node.moduleSpecifier &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      ) {
        // The resolver intentionally stops at an export alias. Conservatively
        // veto same-file names rather than following that alias as a call edge.
        for (const element of node.exportClause.elements) {
          const name = (element.propertyName ?? element.name).text;
          for (const [binding, fn] of closedCallables) {
            if (fn.getSourceFile() === sourceFile && fn.name && ts.isIdentifier(fn.name) && fn.name.text === name) {
              closedCallables.delete(binding);
            }
          }
        }
      }
      if (ts.isIdentifier(node)) {
        const binding = host.oracle?.valueDeclarationOf?.(node);
        const fn = binding && closedCallables.get(binding);
        if (
          fn &&
          node !== fn.name &&
          !(ts.isCallExpression(node.parent) && node.parent.expression === node && !node.parent.questionDotToken)
        ) {
          closedCallables.delete(binding!);
        }
      }
      forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  const eligibleParameters = new Set<S>();
  for (const [binding, fn] of closedCallables) {
    if (changedBindings.has(binding) || declaredCallables.get(binding) !== 1) continue;
    for (const parameter of fn.parameters) {
      if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) continue;
      const slot = scopes.resolve(fn, parameter.name.text);
      if (slot) eligibleParameters.add(slot);
    }
  }
  const isKnownGlobal = (identifier: ts.Identifier): boolean => {
    if (reflectiveGlobals.has(identifier.text) || scopes.resolve(identifier, identifier.text)) return false;
    let frame: ts.Node | undefined = scopes.frameOf(identifier);
    while (frame) {
      // A source/lib merged symbol can report DIFFERENT declaration identities
      // at its own name and a call. This lexical source-name check only VETOES
      // intrinsic evidence; it never supplies a positive callable proof.
      if (sourceBindingsByFrame.get(frame)?.has(identifier.text)) return false;
      if (ts.isSourceFile(frame) || !frame.parent) break;
      frame = scopes.frameOf(frame.parent);
    }
    const declaration = standardDeclaration(identifier);
    // TS may merge a source function with the lib's same-named symbol and
    // return the LIB declaration at calls. A visible source declaration is
    // still a veto; that resolution does not establish an intrinsic binding.
    return !!declaration && !changedBindings.has(declaration) && !declaredCallables.has(declaration);
  };
  // Library provenance alone does not prove evaluating a host global inert.
  // Calls/prototype/member identities retain their separate existing contracts.
  // Missing `undefined` provenance stays unknown; no spelling-only exception.
  const isInertGlobalRead = (identifier: ts.Identifier): boolean =>
    (identifier.text === "NaN" || identifier.text === "Infinity" || identifier.text === "undefined") &&
    isKnownGlobal(identifier);
  const mathMembers = new Set([
    "abs",
    "acos",
    "acosh",
    "asin",
    "asinh",
    "atan",
    "atanh",
    "atan2",
    "cbrt",
    "ceil",
    "clz32",
    "cos",
    "cosh",
    "exp",
    "expm1",
    "floor",
    "fround",
    "hypot",
    "imul",
    "log",
    "log1p",
    "log2",
    "log10",
    "max",
    "min",
    "pow",
    "random",
    "round",
    "sign",
    "sin",
    "sinh",
    "sqrt",
    "tan",
    "tanh",
    "trunc",
  ]);
  const isKnownIntrinsicMember = (callee: ts.PropertyAccessExpression): boolean => {
    const receiver = unwrap(callee.expression);
    if (!ts.isIdentifier(receiver) || !isKnownGlobal(receiver)) return false;
    const name = callee.name.text;
    if (!(receiver.text === "Math" ? mathMembers.has(name) : receiver.text === "Date" && name === "now")) return false;
    const namespace = standardDeclaration(receiver);
    const member = standardDeclaration(callee.name);
    if (
      !namespace ||
      !member ||
      !ts.isMethodSignature(member) ||
      !member.type ||
      member.type.kind !== ts.SyntaxKind.NumberKeyword ||
      escapedNamespaces.has(namespace)
    )
      return false;
    const writes = changedMembers.get(namespace);
    return !writes?.has(name) && !writes?.has(undefined);
  };
  const effectContext: StringEffectContext<S> = {
    host,
    sourceFiles,
    scopes,
    policy,
    isKnownGlobal,
    isInertGlobalRead,
    isKnownIntrinsicMember,
    eligibleParameters,
    declaredCallables,
    changedBindings,
    closedCallables,
  };
  const stringStability = makeStringMethodStability(effectContext, reflectiveGlobals);
  return {
    changedBindings,
    declaredCallables,
    eligibleParameters,
    isKnownGlobal,
    isKnownIntrinsicMember,
    makeInertCallProof: (primitive: ReceiverEffectBridge["primitive"]) =>
      makeInertIntrinsicCallProof(effectContext, primitive),
    ...stringStability,
  };
}

/**
 * Positive Number proof, separate from the broad Number-or-Boolean prover.
 * No verdict memo survives mutable grounded-slot iterations; in-flight calls
 * and exhausted depth decline rather than provisionally seeding a Number.
 */
function makeLocalNumberCarrierProof<S extends SlotView>(
  host: LocalProofHost,
  sourceFiles: readonly ts.SourceFile[],
  scopes: ScopeView<S>,
  groundedSlots: ReadonlySet<S>,
  prover: BroadProof,
  policy: LocalProofPolicy,
): { proves(expr: ts.Expression): boolean; parameterEligible(slot: S): boolean } {
  const {
    unwrap,
    ownReturnExpressions,
    isFunctionLikeWithBody,
    BOOLEAN_BINARY,
    ALWAYS_NUMERIC_BINARY,
    ALWAYS_NUMERIC_COMPOUND,
    NUMERIC_GLOBAL_CALLS,
    STRING_NUMERIC_METHODS,
    STRING_STRING_METHODS,
  } = policy;
  const MAX_DEPTH = 48;
  const inFlight = new Set<FunctionLike>();
  const {
    changedBindings,
    declaredCallables,
    eligibleParameters,
    isKnownGlobal,
    isKnownIntrinsicMember,
    isStringMethodDomainStable,
    keyUntouched,
    effectsCompleteWith,
    makeInertCallProof,
  } = makeLocalCallableDomain(host, sourceFiles, scopes, policy);
  const receiverDomain = makeLocalNumberReceiverDomain(sourceFiles, {
    ...policy,
    valueDeclarationOf: (node) => host.oracle?.valueDeclarationOf?.(node),
  });
  const stableString = (key: string, query?: ReceiverQuery): boolean =>
    query ? keyUntouched(key) : isStringMethodDomainStable(key);
  const both = (left: NumberCarrier, right: NumberCarrier): NumberCarrier =>
    left === "number" && right === "number"
      ? "number"
      : left === "non-number" || right === "non-number"
        ? "non-number"
        : "unknown";
  const isBoolean = (value: ts.Expression): boolean =>
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isDeleteExpression(value) ||
    (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isBinaryExpression(value) && BOOLEAN_BINARY.has(value.operatorToken.kind)) ||
    host.oracle?.typeFactOf(value).kind === "boolean";
  // ToNumeric can return BigInt. A proven Number/Boolean operand excludes it;
  // an unknown operand does not, even though the broad prover accepts it.
  const numericOperand = (expr: ts.Expression, depth: number, query?: ReceiverQuery): boolean =>
    prove(expr, depth, query) === "number" || isBoolean(unwrap(expr));
  const stringsInFlight = new Set<S>();
  const isPrimitiveString = (expr: ts.Expression, depth: number, query?: ReceiverQuery): boolean => {
    if (depth > MAX_DEPTH) return false;
    const value = unwrap(expr);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) || ts.isTemplateExpression(value)) {
      return true;
    }
    if (ts.isIdentifier(value)) {
      const slot = scopes.resolve(value, value.text);
      if (slot && stringsInFlight.has(slot)) return false;
      if (!slot || slot.defs.length === 0 || (slot.isParam && !eligibleParameters.has(slot))) {
        return !!query && (query.proveParameter(value, "string") || query.proveBinding(value, "string"));
      }
      stringsInFlight.add(slot);
      try {
        return slot.defs.every((def) => def.expr !== undefined && isPrimitiveString(def.expr, depth + 1, query));
      } finally {
        stringsInFlight.delete(slot);
      }
    }
    if (ts.isCallExpression(value) && !value.questionDotToken) {
      const callee = unwrap(value.expression);
      if (ts.isIdentifier(callee) && callee.text === "String" && isKnownGlobal(callee)) return true;
      if (
        ts.isPropertyAccessExpression(callee) &&
        STRING_STRING_METHODS.has(callee.name.text) &&
        callee.name.text !== "replace" &&
        callee.name.text !== "replaceAll"
      ) {
        if (
          !callee.questionDotToken &&
          stableString(callee.name.text, query) &&
          isPrimitiveString(callee.expression, depth + 1, query)
        )
          return true;
      }
      return !!query && (query.proveArrayJoin(value) || query.proveMethodCall(value, "string"));
    }
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return isPrimitiveString(value.left, depth + 1, query) || isPrimitiveString(value.right, depth + 1, query);
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      if (host.openWorldPropertyReads === true || value.questionDotToken) return false;
      const declaration = ts.isPropertyAccessExpression(value) && host.oracle?.valueDeclarationOf?.(value.name);
      if (declaration && ts.isAccessor(declaration)) return false;
      if (query?.permitsReceiverRead(value)) return query.proveField(value, "string");
      return host.oracle?.typeFactOf(value).kind === "string";
    }
    return false;
  };
  const proveCall = (call: ts.CallExpression, depth: number, query?: ReceiverQuery): NumberCarrier => {
    if (call.questionDotToken) return "unknown";
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee)) {
      const declaration = host.oracle?.valueDeclarationOf?.(callee);
      // Known global conversions remain Number-producing; a lexical binding
      // with that spelling must earn its own body proof instead.
      if (NUMERIC_GLOBAL_CALLS.has(callee.text) && isKnownGlobal(callee)) return "number";
      if (!declaration || changedBindings.has(declaration)) return "unknown";
      let fn: FunctionLike | undefined;
      if (ts.isFunctionDeclaration(declaration) && isFunctionLikeWithBody(declaration)) {
        if ((declaredCallables.get(declaration) ?? 0) !== 1) return "unknown";
        fn = declaration;
      } else if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        ts.isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        const initializer = unwrap(declaration.initializer);
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) fn = initializer;
      }
      if (!fn || !sourceFiles.includes(fn.getSourceFile())) return "unknown";
      if (
        ("asteriskToken" in fn && fn.asteriskToken) ||
        fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        return "non-number";
      }
      if (inFlight.has(fn)) return "unknown";
      const returns = ownReturnExpressions(fn);
      if (!returns) return "unknown";
      inFlight.add(fn);
      try {
        return returns.reduce<NumberCarrier>((result, expr) => both(result, prove(expr, depth + 1, query)), "number");
      } finally {
        inFlight.delete(fn);
      }
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = unwrap(callee.expression);
      if (callee.questionDotToken) return "unknown";
      if (isKnownIntrinsicMember(callee)) return "number";
      // codePointAt may return undefined for an out-of-range index.
      if (
        STRING_NUMERIC_METHODS.has(callee.name.text) &&
        callee.name.text !== "codePointAt" &&
        callee.name.text !== "search"
      ) {
        if (stableString(callee.name.text, query) && isPrimitiveString(receiver, depth + 1, query)) return "number";
      }
    }
    // Stratified plain-f64 call evidence still supplies broad admission, but
    // cannot override an unknown/mutated target in this stricter projection.
    return query?.proveMethodCall(call, "number") ? "number" : "unknown";
  };
  const prove = (expr: ts.Expression, depth: number, query?: ReceiverQuery): NumberCarrier => {
    if (depth > MAX_DEPTH) return "unknown";
    const value = unwrap(expr);
    if (isBoolean(value) || ts.isBigIntLiteral(value)) return "non-number";
    if (ts.isNumericLiteral(value)) return "number";
    if (ts.isConditionalExpression(value)) {
      return both(prove(value.whenTrue, depth + 1, query), prove(value.whenFalse, depth + 1, query));
    }
    if (ts.isBinaryExpression(value)) {
      const op = value.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.CommaToken)
        return prove(value.right, depth + 1, query);
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return both(prove(value.left, depth + 1, query), prove(value.right, depth + 1, query));
      }
      if (op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken) return "number";
      if (
        ALWAYS_NUMERIC_BINARY.has(op) ||
        ALWAYS_NUMERIC_COMPOUND.has(op) ||
        op === ts.SyntaxKind.PlusToken ||
        op === ts.SyntaxKind.PlusEqualsToken
      ) {
        return numericOperand(value.left, depth + 1, query) && numericOperand(value.right, depth + 1, query)
          ? "number"
          : "unknown";
      }
    }
    if (ts.isPrefixUnaryExpression(value) || ts.isPostfixUnaryExpression(value)) {
      if (value.operator === ts.SyntaxKind.PlusToken) return "number";
      return numericOperand(value.operand, depth + 1, query) ? "number" : "unknown";
    }
    if (ts.isIdentifier(value)) {
      const slot = scopes.resolve(value, value.text);
      if (slot) {
        if (groundedSlots.has(slot) && (!slot.isParam || eligibleParameters.has(slot))) return "number";
        return query && (query.proveParameter(value, "number") || query.proveBinding(value, "number"))
          ? "number"
          : "unknown";
      }
      if ((value.text === "NaN" || value.text === "Infinity") && isKnownGlobal(value)) {
        return "number";
      }
      return query && (query.proveParameter(value, "number") || query.proveBinding(value, "number"))
        ? "number"
        : "unknown";
    }
    if (ts.isCallExpression(value)) return proveCall(value, depth, query);
    // A field-name vote is insufficient. Only the host's concrete Number fact
    // can admit a native scalar property; open-world/optional reads decline.
    if (
      (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
      (host.openWorldPropertyReads === true || value.questionDotToken)
    ) {
      return "unknown";
    }
    if (ts.isPropertyAccessExpression(value)) {
      const declaration = host.oracle?.valueDeclarationOf?.(value.name);
      if (declaration && ts.isAccessor(declaration)) return "unknown";
    }
    if (
      (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
      query?.permitsReceiverRead(value)
    )
      return query.proveField(value, "number") ? "number" : "unknown";
    return host.oracle?.typeFactOf(value).kind === "number" ? "number" : "unknown";
  };
  return {
    proves: (expr) => {
      if (!prover.isNumeric(expr)) return false;
      if (prove(expr, 0) === "number") return true;
      // Raw query value facts never escape this AND. P2's original traversal
      // completes inside the callback; R's independent final scan runs after it.
      let intrinsicCallProof: ((call: ts.CallExpression) => boolean) | undefined;
      return receiverDomain.withQuery(
        {
          isNumber: (value, query) => prove(value, 0, query) === "number",
          isString: (value, query) => isPrimitiveString(value, 0, query),
          isStableStringMethod: (callee) => !callee.questionDotToken && keyUntouched(callee.name.text),
          isInertIntrinsicCall: (call, query) => {
            intrinsicCallProof ??= makeInertCallProof((value) =>
              isPrimitiveString(value, 0, query)
                ? "string"
                : prove(value, 0, query) === "number"
                  ? "primitive"
                  : "unknown",
            );
            return intrinsicCallProof(call);
          },
        },
        (query) =>
          prove(expr, 0, query) === "number" &&
          effectsCompleteWith({
            primitive: (value) =>
              isPrimitiveString(value, 0, query)
                ? "string"
                : prove(value, 0, query) === "number"
                  ? "primitive"
                  : "unknown",
            read: (member) => query.permitsReceiverRead(member),
            write: (target, node) => query.permitsReceiverWrite(target, node),
            call: (call) => query.permitsReceiverCall(call) || query.proveArrayJoin(call),
          }),
      );
    },
    parameterEligible: (slot) => eligibleParameters.has(slot),
  };
}

/**
 * Private local-carrier analysis boundary. Original slot identities, ASTs and
 * scope receiver are preserved; the broad factory observes this one live set.
 */
export function analyzeLocalNumberCarriers<S extends SlotView>(
  host: LocalProofHost,
  sourceFiles: readonly ts.SourceFile[],
  scopes: ScopeView<S>,
  candidateSlots: ReadonlySet<S>,
  makeBroadProof: (grounded: ReadonlySet<S>) => BroadProof,
  policy: LocalProofPolicy,
): Set<S> {
  // (#3765) A GROUNDED slot set, for the one consumer that types a wasm local.
  //
  // `numericSlots` above is a GREATEST fixpoint: it starts with every slot
  // optimistically numeric and withdraws. That is right for its own consumer —
  // the property verdicts apply their own groundedness filter afterwards — but
  // it lets a pure CYCLE survive with no numeric evidence anywhere in it:
  //
  //     var a = b;   // `b` is in the set, so `a` stays
  //     var b = a;   // `a` is in the set, so `b` stays
  //
  // Both are `undefined` at runtime. Promoting either to an f64 local would
  // read `0`. So the local-typing consumer gets a LEAST fixpoint instead:
  // start empty and only ever ADD a slot whose every definition is provable
  // against slots ALREADY admitted. A cycle can never enter, because entering
  // it requires a member to already be in — which is the definition of
  // groundedness. The result is by construction a subset of `numericSlots`.
  const groundedSlots = new Set<S>();
  const groundedProver = makeBroadProof(groundedSlots);
  const localNumberProof = makeLocalNumberCarrierProof(
    host,
    sourceFiles,
    scopes,
    groundedSlots,
    groundedProver,
    policy,
  );
  const groundedCandidates = [...candidateSlots];
  for (let pass = 0; pass <= groundedCandidates.length; pass++) {
    let added = false;
    for (const slot of groundedCandidates) {
      if (groundedSlots.has(slot)) continue;
      // (#6878) Every stored value must positively prove Number identity.
      // The broad prover's Boolean admission and a negative Booleanish test
      // cannot establish that for mixed branches or name-keyed function calls.
      // (#4122) SELF-REFERENCE. The accumulator `var s = 0; s = s + f();` is the
      // most common numeric-local shape in ordinary JS, and a plain least
      // fixpoint can never admit it: proving `s` numeric requires `s` to be
      // numeric already. So assume the slot numeric while judging its OWN
      // definitions — the same induction `withSelf` gives the property path
      // ("if every other write stores a number then the slot always holds
      // one"), just for a lexical slot instead of a property name.
      groundedSlots.add(slot);
      let allNumeric: boolean;
      try {
        const provesNumericCarrier = (def: LocalValueDef): boolean =>
          def.expr !== undefined
            ? localNumberProof.proves(def.expr)
            : def.forcedNumeric === true && groundedSlots.has(slot);
        allNumeric =
          slot.defs.length > 0 &&
          (!slot.isParam || localNumberProof.parameterEligible(slot)) &&
          slot.defs.every(provesNumericCarrier);
      } finally {
        groundedSlots.delete(slot);
      }
      if (!allNumeric) continue;
      // GROUNDEDNESS, re-checked with the assumption withdrawn: at least one
      // definition must be numeric on its own. Without this, `var s = s + 1;`
      // — whose only definition reads the slot before anything writes it — is
      // self-justifying, and an f64 carrier would read 0 where JS says NaN.
      // This is the slot analogue of the property path's `withoutSelf` pass,
      // and it is also what keeps a mutual cycle (`var a = b; var b = a;`) out:
      // the assumption covers a slot's own name, never its partner's.
      // A forced ToNumeric update has no recorded operand proof and cannot
      // independently ground Number (BigInt is possible). During induction it
      // preserves an already-Number slot on every successful update.
      const grounded = slot.defs.some((def) => def.expr !== undefined && localNumberProof.proves(def.expr));
      if (grounded) {
        groundedSlots.add(slot);
        added = true;
      }
    }
    if (!added) break;
  }
  return groundedSlots;
}
