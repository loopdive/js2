// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";

/**
 * (#7106) Ambient intrinsics the IR reads as VALUES — `assert.throws(TypeError,
 * fn)`, `typeof Symbol`. Each is a property of the realm's
 * global object (§19.1, §19.3), so the IR reads it as `dyn.member_get` off
 * `dyn.global_object`: the same object, and so the same constructor identity,
 * legacy's own `globalThis` read yields. Names outside this list keep the
 * existing refusal; the selector also requires the identifier to resolve to
 * its lib declaration (never a user binding of the same name). `globalThis`
 * itself is not listed: the checker synthesizes it without a lib declaration.
 *
 * Admission criterion: the names the #7118 census found blocking test262
 * bodies (`TypeError`, `Object`, `Array`, `String`, `RangeError`,
 * `ReferenceError`) plus the rest of the Error family and the primitive
 * wrappers, each measured identical to legacy's `globalThis.<Name>` on
 * standalone. `AggregateError`, `Date`, `RegExp`, `Math`, `JSON`, `Promise`,
 * `Map`, `Set` were not measured and stay refused until they are. `Function`
 * is listed for the same measurement but in practice never claims: a bare
 * `Function` value pulls the runtime-eval provider and stays legacy.
 */
const AMBIENT_INTRINSIC_VALUE_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "Function",
]);

function isAmbientIntrinsicName(name: string): boolean {
  return AMBIENT_INTRINSIC_VALUE_NAMES.has(name);
}

/**
 * (#7118) The ONE admission predicate for an ambient intrinsic read as a value,
 * shared by the selector (`isAmbientIntrinsicValue`) and the from-ast producer
 * (the identifier arm of `lowerExprUnchecked`), so the two cannot drift: the
 * selector adds only lane checks on top, and the producer demotes when this
 * says no. All of:
 *   - the name is on the allowlist;
 *   - every declaration of the symbol is a lib one (a module's
 *     `function Number() {}` merges with the lib's `declare var Number`), and
 *     nothing in the same file declares the name — for a SCRIPT's top-level
 *     `function Error() {}` the checker reports the lib declarations alone
 *     (measured, TypeScript 5.9), so the file is checked as well;
 *   - the value reaches only opaque uses — see {@link isOpaqueIntrinsicUse} —
 *     or, once the module's builtin-prototype companion is seeded, is the
 *     receiver of an exact `<Receiver>.prototype.<method>` value read (#7127,
 *     {@link isExactProtoMethodValueRead}).
 */
export function isAmbientIntrinsicValueUse(
  node: ts.Identifier,
  isLibOnlyBinding: (node: ts.Identifier) => boolean,
  seed?: { builtinProtoCompanionSeeded?(): boolean },
): boolean {
  return (
    isAmbientIntrinsicName(node.text) &&
    isLibOnlyBinding(node) &&
    !declaredNames(node.getSourceFile()).has(node.text) &&
    (isOpaqueIntrinsicUse(node) ||
      (seed?.builtinProtoCompanionSeeded?.() === true && isExactProtoMethodValueRead(node)))
  );
}

const declaredNamesCache = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/** Every name the file itself declares (function, class, variable, parameter, binding). */
function declaredNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const cached = declaredNamesCache.get(sourceFile);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  declaredNamesCache.set(sourceFile, names);
  return names;
}

/**
 * Where an intrinsic (or an alias carrying one) is used. Parentheses,
 * conditional branches, `||`/`&&`/`??` operands and the comma's right operand
 * forward the value, so the position is that of the forwarding expression.
 *   - `opaque`: `typeof x`, `!x`, `x === y`/`!==`/`==`/`!=`, a truthiness test,
 *     a statement, or an argument to a callee whose body the IR cannot own
 *     (a member call such as `assert.throws`); the value's identity is all
 *     that is observed, and it IS the realm's object.
 *   - `alias`: the value is stored into a local (`var C = x`, `C = x`) or
 *     passed to a same-file function declaration's parameter — `names` are
 *     the bindings that now carry it, to be checked in turn.
 *   - `member`: the receiver of a member/element read (#7123).
 *   - `other`: anything else (`return x`, `[x]`, `"" + x`, an unresolvable
 *     callee, …) — refused rather than reasoned about.
 */
type UsePosition =
  | { readonly kind: "opaque" | "member" | "other" }
  | { readonly kind: "alias"; readonly names: readonly string[] };

const OPAQUE: UsePosition = { kind: "opaque" };
const MEMBER: UsePosition = { kind: "member" };
const OTHER: UsePosition = { kind: "other" };

const EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const FORWARDING_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.CommaToken,
]);

function usePosition(node: ts.Expression): UsePosition {
  let child: ts.Node = node;
  let parent = node.parent;
  // Climb through the expressions that forward the value unchanged.
  for (;;) {
    if (parent === undefined) return OTHER;
    if (ts.isParenthesizedExpression(parent)) {
      child = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isConditionalExpression(parent) && (parent.whenTrue === child || parent.whenFalse === child)) {
      child = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isBinaryExpression(parent) && FORWARDING_OPERATORS.has(parent.operatorToken.kind)) {
      // The comma forwards only its right operand; the logical operators may
      // yield either side.
      if (parent.operatorToken.kind === ts.SyntaxKind.CommaToken && parent.left === child) return OPAQUE;
      child = parent;
      parent = parent.parent;
      continue;
    }
    break;
  }
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === child) {
    return MEMBER;
  }
  if (ts.isTypeOfExpression(parent)) return OPAQUE;
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return OPAQUE;
  if (ts.isBinaryExpression(parent)) {
    if (EQUALITY_OPERATORS.has(parent.operatorToken.kind)) return OPAQUE;
    if (
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === child &&
      ts.isIdentifier(parent.left)
    ) {
      return { kind: "alias", names: [parent.left.text] };
    }
    return OTHER;
  }
  if (ts.isConditionalExpression(parent) && parent.condition === child) return OPAQUE;
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) return OPAQUE;
  if (ts.isForStatement(parent) && parent.condition === child) return OPAQUE;
  if (ts.isExpressionStatement(parent)) return OPAQUE;
  if (ts.isVariableDeclaration(parent) && parent.initializer === child) {
    return ts.isIdentifier(parent.name) ? { kind: "alias", names: [parent.name.text] } : OTHER;
  }
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== child) {
    return argumentPosition(parent, child);
  }
  return OTHER;
}

/**
 * An intrinsic passed as an argument. A callee the IR might own — a same-file
 * function declaration named by the identifier — receives it in a parameter
 * that is then checked like any alias; a callee it cannot own (`assert.throws`)
 * only sees the realm's object, so the use is opaque; an identifier callee
 * that resolves to nothing in the file (a parameter, an import) is refused.
 */
function argumentPosition(call: ts.CallExpression | ts.NewExpression, argument: ts.Node): UsePosition {
  if (call.arguments?.some(ts.isSpreadElement)) return OTHER;
  const index = call.arguments?.indexOf(argument as ts.Expression) ?? -1;
  if (index < 0) return OTHER;
  const callee = call.expression;
  if (!ts.isIdentifier(callee)) return OPAQUE;
  const declarations = sameFileFunctionDeclarations(callee);
  if (declarations.length === 0) return OTHER;
  const names: string[] = [];
  for (const declaration of declarations) {
    const parameter = declaration.parameters[index];
    if (parameter === undefined) continue;
    if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) return OTHER;
    names.push(parameter.name.text);
  }
  return { kind: "alias", names };
}

function sameFileFunctionDeclarations(callee: ts.Identifier): ts.FunctionDeclaration[] {
  const found: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === callee.text) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(callee.getSourceFile());
  return found;
}

const opaqueUseCache = new WeakMap<ts.Identifier, boolean>();

/**
 * (#7123) Does this intrinsic occurrence reach only opaque uses? A member read
 * off an intrinsic (`Error.prototype`, `TypeError.call`, `Object["keys"]`)
 * stays on the legacy path: legacy lowers `<Builtin>.prototype.<m>` and the
 * inherited `Function.prototype` members syntactically, so its pre-scan
 * (`isProtoMemberValueUse`, in the codegen proto pre-pass) seeds no runtime
 * companion for them, and the IR's `__extern_get` chain then finds only some
 * members. Measured on standalone and gc: `typeof Error.prototype.toString`,
 * `TypeError.prototype.constructor === TypeError`, `typeof TypeError.call`,
 * `typeof Function.prototype` all answered differently from legacy and node.
 *
 * The value is `dynamic` and flows into locals and parameters, and a member
 * read off such an alias (`var C = TypeError; C.prototype.constructor`) goes
 * through the same chain — a check on the intrinsic's own receiver position is
 * bypassed by any alias. So every binding the value reaches (locals by
 * initializer or assignment, parameters of same-file function declarations,
 * transitively) is followed, and the use is refused unless each read of each
 * carrier is itself opaque. Names are flat: shadowing is already refused by
 * the Phase-1 scope rules, and a same-named binding elsewhere in the file
 * only over-refuses.
 */
function isOpaqueIntrinsicUse(node: ts.Identifier): boolean {
  const cached = opaqueUseCache.get(node);
  if (cached !== undefined) return cached;
  const result = computeOpaqueIntrinsicUse(node);
  opaqueUseCache.set(node, result);
  return result;
}

function computeOpaqueIntrinsicUse(node: ts.Identifier): boolean {
  const position = usePosition(node);
  if (position.kind !== "alias") return position.kind === "opaque";
  const carriers = new Set<string>(position.names);
  const pending = [...carriers];
  const sourceFile = node.getSourceFile();
  while (pending.length > 0) {
    const carrier = pending.pop() as string;
    let ok = true;
    const visit = (child: ts.Node): void => {
      if (!ok) return;
      if (ts.isIdentifier(child) && child.text === carrier && child !== node && isValueRead(child)) {
        const use = usePosition(child);
        if (use.kind === "opaque") return;
        if (use.kind !== "alias") {
          ok = false;
          return;
        }
        for (const name of use.names) {
          if (!carriers.has(name)) {
            carriers.add(name);
            pending.push(name);
          }
        }
        return;
      }
      ts.forEachChild(child, visit);
    };
    visit(sourceFile);
    if (!ok) return false;
  }
  return true;
}

/** A read of the binding, not its declaration name or the target of `=`. */
function isValueRead(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (parent === undefined) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === id) return false;
  if (ts.isParameter(parent) && parent.name === id) return false;
  if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)) {
    return parent.name !== id;
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === id) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (ts.isBindingElement(parent) && parent.name === id) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  return true;
}

/**
 * (#7127) Intrinsics whose `.prototype.<method>` value read is exact through
 * the dynamic `__extern_get` chain once the module's brand companion is seeded
 * (legacy's `protoMemberDirty`). The NativeError constructors are left out:
 * their prototypes inherit `toString` from `Error.prototype`, and legacy itself
 * answers `RangeError.prototype.toString === Error.prototype.toString` false.
 */
const PROTO_METHOD_RECEIVERS: ReadonlySet<string> = new Set([
  "Object",
  "Array",
  "Function",
  "Error",
  "String",
  "Number",
  "Boolean",
  "Symbol",
]);

/**
 * (#7127) Methods measured exact as `<Receiver>.prototype.<m>` values (typeof
 * and identity against `Object.prototype.<m>`, standalone and gc, against
 * node). Data and accessor members stay refused: legacy itself mis-answers
 * `Function.prototype.length`, `String.prototype.length` and
 * `Symbol.prototype.description`, and `constructor` reads a different identity
 * from the global-object constructor through the IR.
 */
const PROTO_METHOD_NAMES: ReadonlySet<string> = new Set([
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "call",
  "apply",
  "bind",
  "push",
  "pop",
  "concat",
  "join",
  "slice",
  "splice",
  "indexOf",
  "lastIndexOf",
  "forEach",
  "map",
  "filter",
  "reduce",
  "every",
  "some",
  "charAt",
  "charCodeAt",
  "toFixed",
]);

type MemberAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

function memberAccessOf(node: ts.Expression): MemberAccess | undefined {
  let child: ts.Node = node;
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  return parent !== undefined &&
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === child
    ? parent
    : undefined;
}

function staticMemberName(access: MemberAccess): string | undefined {
  if (ts.isPropertyAccessExpression(access)) return access.name.text;
  return ts.isStringLiteralLike(access.argumentExpression) ? access.argumentExpression.text : undefined;
}

/**
 * (#7127) The intrinsic itself (never an alias) is the receiver of
 * `<Receiver>.prototype.<method>`, read as a plain VALUE: not called (the
 * receiver would become `this`), not read further (`.call(x)` keeps the S1c
 * `Object.prototype.toString.call` arm and the legacy call paths), not a
 * write, `delete` or update target. The method value itself is an ordinary
 * function, so where it flows afterwards needs no tracking.
 */
function isExactProtoMethodValueRead(node: ts.Identifier): boolean {
  const protoAccess = memberAccessOf(node);
  if (protoAccess === undefined || !PROTO_METHOD_RECEIVERS.has(node.text)) return false;
  if (staticMemberName(protoAccess) !== "prototype") return false;
  const methodAccess = memberAccessOf(protoAccess);
  const method = methodAccess && staticMemberName(methodAccess);
  if (methodAccess === undefined || method === undefined || !PROTO_METHOD_NAMES.has(method)) return false;
  if (memberAccessOf(methodAccess) !== undefined) return false;
  let use: ts.Node = methodAccess;
  while (use.parent && ts.isParenthesizedExpression(use.parent)) use = use.parent;
  const parent = use.parent;
  if (parent === undefined) return false;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === use) return false;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === use) return false;
  if (ts.isDeleteExpression(parent) || ts.isPostfixUnaryExpression(parent)) return false;
  if (ts.isPrefixUnaryExpression(parent)) return parent.operator === ts.SyntaxKind.ExclamationToken;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === use &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return false;
  }
  return !(ts.isForInStatement(parent) || ts.isForOfStatement(parent)) || parent.expression === use;
}
