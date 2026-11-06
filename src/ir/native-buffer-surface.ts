// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7274) The closed native `ArrayBuffer` surface a host-free lane lowers
 * through the IR, as ONE node-identity plan that the selector and from-ast
 * both consult (the #2135 rule; the shape of #4576's DOM plan).
 *
 * The values are the lane's native buffers — a `$__vec_i32_byte` or its
 * `$__resizable_ab` subtype — carried as `extern<ArrayBuffer>`, i.e. the same
 * `externref` legacy stores in a script var's `__mod_` slot. Every operation
 * lowers to a direct call of one externref-ABI adapter over legacy's own
 * emitters (`codegen/buffers/ir-native-buffer.ts`), never to dynamic member
 * dispatch (#7261).
 *
 * The plan certifies:
 *  - a construction `new ArrayBuffer()`, `(n)`, `(n, {})`,
 *    `(n, {maxByteLength: m})` or `(n, {maxByteLength: undefined})` of the
 *    lib-only, unshadowed `ArrayBuffer` (a script `function ArrayBuffer(){}`
 *    is not it, though the checker resolves only the lib declaration: the
 *    #7264 lesson), with a number-typed `n` and a number-literal `m`;
 *  - a top-level script `var` every write of which is a certified producer
 *    (a construction or a certified `slice` result);
 *  - on a certified receiver (a producer, or such a var read in module-init
 *    after its declaration): the reads `byteLength`, `maxByteLength`,
 *    `resizable`, and a value-position `slice(start?, end?)`.
 * Anything else is not in the plan and keeps its current route.
 */
import { ts } from "../ts-api.js";
import { isUnshadowedLibBinding, isUnshadowedUndefined } from "../shared/ambient-intrinsics.js";
import {
  hasDynamicScope,
  identifierWritesOf,
  isStoreTarget,
  outermostParenthesized,
  stripParens,
} from "../shared/binding-writes.js";
import { makeIrAmbientBindingPredicate, makeIrPrimitiveExpressionClassifier } from "./module-bindings.js";
import { scriptVarUseFollowsDeclaration } from "./module-binding-class-instance.js";
import {
  IR_NATIVE_AB_BYTE_LENGTH_FN,
  IR_NATIVE_AB_MAX_BYTE_LENGTH_FN,
  IR_NATIVE_AB_RESIZABLE_FN,
} from "../shared/contracts/native-buffer-adapters.js";

/** The adapter each certified getter calls. */
export const IR_NATIVE_BUFFER_GETTER_FNS = {
  byteLength: IR_NATIVE_AB_BYTE_LENGTH_FN,
  maxByteLength: IR_NATIVE_AB_MAX_BYTE_LENGTH_FN,
  resizable: IR_NATIVE_AB_RESIZABLE_FN,
} as const;

export type IrNativeBufferGetter = keyof typeof IR_NATIVE_BUFFER_GETTER_FNS;

export const IR_NATIVE_BUFFER_CLASS = "ArrayBuffer";

export type IrNativeBufferOperation =
  | {
      readonly kind: "construct";
      readonly length: ts.Expression | undefined;
      /** Absent for a fixed buffer (no options, `{}`, or `maxByteLength: undefined`). */
      readonly maxByteLength: ts.Expression | undefined;
    }
  | { readonly kind: "get"; readonly member: IrNativeBufferGetter; readonly receiver: ts.Expression }
  | { readonly kind: "slice"; readonly receiver: ts.Expression; readonly bounds: readonly ts.Expression[] };

type Construct = Extract<IrNativeBufferOperation, { kind: "construct" }>;

export interface IrNativeBufferSurfacePlan {
  /** The certified operation `node` is, if any. */
  operation(node: ts.Node): IrNativeBufferOperation | undefined;
  /** True when `expr` (parentheses aside) evaluates to a certified buffer. */
  isReceiver(expr: ts.Expression): boolean;
  /** True when this read of a certified var hands its handle to a certified operation. */
  consumesHandle(node: ts.Identifier): boolean;
  /** Certify a script var (and, when given, one value written to it) as native-buffer storage. */
  moduleBinding(
    declaration: ts.VariableDeclaration,
    writeValue?: ts.Expression,
  ): { readonly capability: "native-buffer"; readonly className: typeof IR_NATIVE_BUFFER_CLASS } | undefined;
}

function isGetter(name: string): name is IrNativeBufferGetter {
  return Object.hasOwn(IR_NATIVE_BUFFER_GETTER_FNS, name);
}

/** A property that is only read: not stored to, deleted or called. */
function isPlainRead(access: ts.PropertyAccessExpression): boolean {
  const parent = access.parent;
  return (
    access.questionDotToken === undefined &&
    !isStoreTarget(access) &&
    !ts.isDeleteExpression(parent) &&
    !(ts.isCallExpression(parent) && parent.expression === access)
  );
}

/** Every source site the plan may certify, and every store into an identifier. */
interface BufferSites {
  readonly constructions: ReadonlyMap<ts.NewExpression, Construct>;
  readonly sliceCalls: ReadonlySet<ts.CallExpression>;
  readonly getterReads: readonly ts.PropertyAccessExpression[];
  readonly writesBySymbol: ReadonlyMap<ts.Symbol, readonly ts.Expression[]>;
  /** Symbols stored to by anything but a plain value (`++`, `+=`, a for-in key, …). */
  readonly poisoned: ReadonlySet<ts.Symbol>;
}

/** A number-typed operand: lowers to an f64 or the dynamic carrier. */
function makeNumberOperand(checker: ts.TypeChecker): (expr: ts.Expression) => boolean {
  const classify = makeIrPrimitiveExpressionClassifier(checker);
  return (expr) => classify(expr) === "number";
}

/**
 * An `undefined` slice bound: the global `undefined`, or a read of a `var`
 * initialized to it (whose lowering is the dynamic carrier, whatever is
 * written to it later). Name resolution only, like the number classifier's
 * own provenance walk.
 */
function isUndefinedOperand(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  const candidate = stripParens(expr);
  if (isUnshadowedUndefined(candidate)) return true;
  if (!ts.isIdentifier(candidate)) return false;
  const declaration = checker.getSymbolAtLocation(candidate)?.valueDeclaration;
  return (
    declaration !== undefined &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    isUnshadowedUndefined(declaration.initializer)
  );
}

/**
 * A `maxByteLength` operand that cannot throw or run code: a number literal,
 * possibly negated. Legacy validates the length BEFORE evaluating the option
 * (new-indexed.ts) while the IR's call evaluates both first; with a literal
 * option (even a TDZ read could throw) the two orders cannot be told apart.
 */
function isLiteralNumber(expr: ts.Expression): boolean {
  const candidate = stripParens(expr);
  return (
    ts.isNumericLiteral(candidate) ||
    (ts.isPrefixUnaryExpression(candidate) &&
      candidate.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(candidate.operand))
  );
}

/** The construction shape of `expr`, or `undefined` outside the table. */
function makeConstructShape(
  checker: ts.TypeChecker,
  isNumber: (expr: ts.Expression) => boolean,
): (expr: ts.NewExpression) => Construct | undefined {
  const isLibOnly = makeIrAmbientBindingPredicate(checker, "every");
  return (expr) => {
    if (!ts.isIdentifier(expr.expression) || expr.expression.text !== IR_NATIVE_BUFFER_CLASS) return undefined;
    if (!isUnshadowedLibBinding(expr.expression, isLibOnly) || (expr.typeArguments?.length ?? 0) > 0) return undefined;
    const args = expr.arguments ?? [];
    if (args.length > 2 || args.some(ts.isSpreadElement)) return undefined;
    const length = args[0];
    if (length !== undefined && !isNumber(length)) return undefined;
    const options = args[1];
    if (options === undefined) return { kind: "construct", length, maxByteLength: undefined };
    if (!ts.isObjectLiteralExpression(options) || options.properties.length > 1) return undefined;
    const property = options.properties[0];
    if (property === undefined) return { kind: "construct", length, maxByteLength: undefined };
    if (
      !ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
      property.name.text !== "maxByteLength"
    ) {
      return undefined;
    }
    const max = property.initializer;
    if (isUnshadowedUndefined(max)) return { kind: "construct", length, maxByteLength: undefined };
    return isLiteralNumber(max) ? { kind: "construct", length, maxByteLength: max } : undefined;
  };
}

/** `x.slice(start?, end?)` whose bounds are each a number or `undefined`, which box into the dynamic carrier. */
function isSliceCall(
  access: ts.PropertyAccessExpression,
  isBound: (expr: ts.Expression) => boolean,
): access is ts.PropertyAccessExpression & { readonly parent: ts.CallExpression } {
  const call = access.parent;
  return (
    access.name.text === "slice" &&
    access.questionDotToken === undefined &&
    ts.isCallExpression(call) &&
    call.expression === access &&
    call.questionDotToken === undefined &&
    call.arguments.length <= 2 &&
    call.arguments.every(isBound)
  );
}

function collectBufferSites(checker: ts.TypeChecker, sourceFile: ts.SourceFile): BufferSites {
  const isNumber = makeNumberOperand(checker);
  const isBound = (expr: ts.Expression): boolean => isNumber(expr) || isUndefinedOperand(checker, expr);
  const constructShape = makeConstructShape(checker, isNumber);
  const constructions = new Map<ts.NewExpression, Construct>();
  const sliceCalls = new Set<ts.CallExpression>();
  const getterReads: ts.PropertyAccessExpression[] = [];
  const writesBySymbol = new Map<ts.Symbol, ts.Expression[]>();
  const poisoned = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const shape = constructShape(node);
      if (shape !== undefined) constructions.set(node, shape);
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      if (isGetter(node.name.text) && isPlainRead(node)) getterReads.push(node);
      if (isSliceCall(node, isBound)) sliceCalls.add(node.parent);
    }
    for (const write of identifierWritesOf(node)) {
      const symbol = checker.getSymbolAtLocation(write.target);
      if (symbol === undefined) continue;
      if (write.kind !== "value") poisoned.add(symbol);
      else writesBySymbol.set(symbol, [...(writesBySymbol.get(symbol) ?? []), write.expr]);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return { constructions, sliceCalls, getterReads, writesBySymbol, poisoned };
}

/**
 * Top-level script vars with one declaration and an initializer. `let` /
 * `const` are excluded: their legacy slot is not the externref dynamic home.
 */
function scriptVarCandidates(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  poisoned: ReadonlySet<ts.Symbol>,
): Map<ts.VariableDeclaration, ts.Symbol> {
  const candidates = new Map<ts.VariableDeclaration, ts.Symbol>();
  if (hasDynamicScope(sourceFile)) return candidates;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
      const symbol = checker.getSymbolAtLocation(declaration.name);
      if (symbol === undefined || symbol.declarations?.length !== 1 || poisoned.has(symbol)) continue;
      candidates.set(declaration, symbol);
    }
  }
  return candidates;
}

const receiverOfSlice = (call: ts.CallExpression): ts.Expression =>
  (call.expression as ts.PropertyAccessExpression).expression;

/**
 * Least fixpoint: a var is certified once every write is a certified
 * producer, and a `slice` result is a producer once its receiver is (so a
 * self-justifying `ab = ab.slice(1)` never certifies).
 */
function certifyBufferVars(
  checker: ts.TypeChecker,
  sites: BufferSites,
  candidates: ReadonlyMap<ts.VariableDeclaration, ts.Symbol>,
): { readonly certified: ReadonlyMap<ts.Symbol, ts.VariableDeclaration>; isReceiver(expr: ts.Expression): boolean } {
  const certified = new Map<ts.Symbol, ts.VariableDeclaration>();
  const isReceiver = (expr: ts.Expression): boolean => {
    const candidate = stripParens(expr);
    if (ts.isNewExpression(candidate)) return sites.constructions.has(candidate);
    if (ts.isCallExpression(candidate))
      return sites.sliceCalls.has(candidate) && isReceiver(receiverOfSlice(candidate));
    if (!ts.isIdentifier(candidate)) return false;
    const symbol = checker.getSymbolAtLocation(candidate);
    const declaration = symbol === undefined ? undefined : certified.get(symbol);
    return declaration !== undefined && scriptVarUseFollowsDeclaration(candidate, declaration);
  };
  const isProducer = (expr: ts.Expression): boolean => !ts.isIdentifier(stripParens(expr)) && isReceiver(expr);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [declaration, symbol] of candidates) {
      if (certified.has(symbol) || !(sites.writesBySymbol.get(symbol) ?? []).every(isProducer)) continue;
      certified.set(symbol, declaration);
      changed = true;
    }
  }
  return { certified, isReceiver };
}

/**
 * A producer is certified only where the plan itself consumes its handle: as
 * a certified member's receiver or as a write into a certified var. A handle
 * anywhere else (an argument, `typeof`, a conditional arm, a discarded
 * statement) keeps the legacy route, whose consumers know the native vec.
 */
function planBufferOperations(
  sites: BufferSites,
  certified: ReadonlyMap<ts.Symbol, ts.VariableDeclaration>,
  isReceiver: (expr: ts.Expression) => boolean,
): ReadonlyMap<ts.Node, IrNativeBufferOperation> {
  const operations = new Map<ts.Node, IrNativeBufferOperation>();
  const consume = (expr: ts.Expression): void => {
    const candidate = stripParens(expr);
    const construct = ts.isNewExpression(candidate) ? sites.constructions.get(candidate) : undefined;
    if (construct !== undefined) {
      operations.set(candidate, construct);
    } else if (ts.isCallExpression(candidate) && sites.sliceCalls.has(candidate) && isReceiver(candidate)) {
      const receiver = receiverOfSlice(candidate);
      operations.set(candidate, { kind: "slice", receiver, bounds: candidate.arguments });
      consume(receiver);
    }
  };
  for (const access of sites.getterReads) {
    if (!isReceiver(access.expression)) continue;
    const member = access.name.text as IrNativeBufferGetter;
    operations.set(access, { kind: "get", member, receiver: access.expression });
    consume(access.expression);
  }
  for (const symbol of certified.keys()) (sites.writesBySymbol.get(symbol) ?? []).forEach(consume);
  return operations;
}

export function makeIrNativeBufferSurfacePlan(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): IrNativeBufferSurfacePlan {
  const sites = collectBufferSites(checker, sourceFile);
  const candidates = scriptVarCandidates(checker, sourceFile, sites.poisoned);
  const { certified, isReceiver } = certifyBufferVars(checker, sites, candidates);
  const operations = planBufferOperations(sites, certified, isReceiver);
  return {
    operation: (node) => operations.get(node),
    isReceiver,
    consumesHandle(node) {
      const access = outermostParenthesized(node).parent;
      if (!ts.isPropertyAccessExpression(access)) return false;
      const call = access.parent;
      return (
        operations.get(access)?.kind === "get" ||
        (ts.isCallExpression(call) && call.expression === access && operations.get(call)?.kind === "slice")
      );
    },
    moduleBinding(declaration, writeValue) {
      const symbol = candidates.get(declaration);
      if (symbol === undefined || certified.get(symbol) !== declaration) return undefined;
      if (writeValue !== undefined && operations.get(stripParens(writeValue)) === undefined) return undefined;
      return { capability: "native-buffer", className: IR_NATIVE_BUFFER_CLASS };
    },
  };
}
