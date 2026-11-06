// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7274) The closed native ArrayBuffer / DataView surface a host-free lane
 * lowers through the IR, as ONE node-identity plan that the selector and
 * from-ast both consult (the #2135 rule; the shape of #4576's DOM plan).
 *
 * The values are the lane's native objects — a `$__vec_i32_byte` buffer (or
 * its `$__resizable_ab` subtype) and a `$__dv_window` view — carried as
 * `extern<ArrayBuffer>` / `extern<DataView>`, i.e. the same `externref`
 * legacy stores in a script var's `__mod_` slot. Every operation lowers to a
 * direct call of one externref-ABI adapter over legacy's own emitters
 * (`codegen/buffers/ir-native-buffer.ts`), never to dynamic member dispatch
 * (#7261). The admission table is `native-buffer-operands.ts`.
 *
 * The plan certifies:
 *  - a construction the table admits, whose DataView buffer operand is a
 *    certified ArrayBuffer;
 *  - a top-level script `var` every write of which is a certified producer of
 *    one class (a construction, or an ArrayBuffer `slice` result);
 *  - on a certified receiver (a producer, or such a var read in module-init
 *    after its declaration), the table's getters and calls.
 * A handle-producing operation is certified only where the plan itself
 * consumes the handle (see `planBufferOperations`). Anything else is not in
 * the plan and keeps its current route.
 */
import { ts } from "../ts-api.js";
import {
  hasDynamicScope,
  identifierWritesOf,
  isStoreTarget,
  outermostParenthesized,
  stripParens,
} from "../shared/binding-writes.js";
import { scriptVarUseFollowsDeclaration } from "./module-binding-class-instance.js";
import {
  makeIrNativeBufferOperands,
  nativeBufferMember,
  type IrNativeBufferClass,
  type IrNativeBufferConstruct,
  type IrNativeBufferMember,
  type IrNativeBufferOperands,
} from "./native-buffer-operands.js";

export type { IrNativeBufferClass } from "./native-buffer-operands.js";

export type IrNativeBufferOperation =
  | IrNativeBufferConstruct
  | {
      readonly kind: "get";
      readonly fn: string;
      readonly result: "number" | "boolean";
      readonly receiver: ts.Expression;
      readonly receiverClass: IrNativeBufferClass;
    }
  | {
      readonly kind: "call";
      readonly fn: string;
      readonly receiver: ts.Expression;
      readonly receiverClass: IrNativeBufferClass;
      readonly args: readonly ts.Expression[];
      /** The adapter's operand count; missing arguments are `undefined`. */
      readonly arity: number;
      readonly resultClass?: "ArrayBuffer";
    };

/** An operation's handle operand (receiver, or a view's buffer) and its other source operands. */
export function nativeBufferOperationParts(op: IrNativeBufferOperation): {
  readonly handle: ts.Expression | undefined;
  readonly operands: readonly ts.Expression[];
} {
  const present = (...exprs: (ts.Expression | undefined)[]): ts.Expression[] =>
    exprs.filter((expr): expr is ts.Expression => expr !== undefined);
  switch (op.kind) {
    case "construct":
      return { handle: undefined, operands: present(op.length, op.maxByteLength) };
    case "construct-view":
      return { handle: op.buffer, operands: present(op.offset, op.length) };
    case "get":
      return { handle: op.receiver, operands: [] };
    case "call":
      return { handle: op.receiver, operands: op.args };
  }
}

export interface IrNativeBufferSurfacePlan {
  /** The certified operation `node` is, if any. */
  operation(node: ts.Node): IrNativeBufferOperation | undefined;
  /** True when `expr` (parentheses aside) evaluates to a certified buffer or view. */
  isReceiver(expr: ts.Expression): boolean;
  /** True when this read of a certified var hands its handle to a certified operation. */
  consumesHandle(node: ts.Identifier): boolean;
  /** Certify a script var (and, when given, one value written to it) as native-buffer storage. */
  moduleBinding(
    declaration: ts.VariableDeclaration,
    writeValue?: ts.Expression,
  ): { readonly capability: "native-buffer"; readonly className: IrNativeBufferClass } | undefined;
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

/** `recv.name(args)` with no optional chain or spread. */
function isPlainCall(access: ts.PropertyAccessExpression): access is ts.PropertyAccessExpression & {
  readonly parent: ts.CallExpression;
} {
  const call = access.parent;
  return (
    access.questionDotToken === undefined &&
    ts.isCallExpression(call) &&
    call.expression === access &&
    call.questionDotToken === undefined &&
    !call.arguments.some(ts.isSpreadElement)
  );
}

/** Every source site the plan may certify, and every store into an identifier. */
interface BufferSites {
  readonly constructions: ReadonlyMap<ts.NewExpression, IrNativeBufferConstruct>;
  readonly reads: readonly ts.PropertyAccessExpression[];
  readonly calls: ReadonlySet<ts.CallExpression>;
  readonly writesBySymbol: ReadonlyMap<ts.Symbol, readonly ts.Expression[]>;
  /** Symbols stored to by anything but a plain value (`++`, `+=`, a for-in key, …). */
  readonly poisoned: ReadonlySet<ts.Symbol>;
}

function collectBufferSites(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  operands: IrNativeBufferOperands,
): BufferSites {
  const constructions = new Map<ts.NewExpression, IrNativeBufferConstruct>();
  const reads: ts.PropertyAccessExpression[] = [];
  const calls = new Set<ts.CallExpression>();
  const writesBySymbol = new Map<ts.Symbol, ts.Expression[]>();
  const poisoned = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const shape = operands.construction(node);
      if (shape !== undefined) constructions.set(node, shape);
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      if (isPlainRead(node)) reads.push(node);
      else if (isPlainCall(node)) calls.add(node.parent);
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
  return { constructions, reads, calls, writesBySymbol, poisoned };
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

/** A call the table admits on a certified receiver. */
interface AdmittedCall {
  readonly member: Extract<IrNativeBufferMember, { kind: "call" }>;
  readonly receiverClass: IrNativeBufferClass;
}

const accessOf = (call: ts.CallExpression): ts.PropertyAccessExpression =>
  call.expression as ts.PropertyAccessExpression;

interface CertifiedVar {
  readonly declaration: ts.VariableDeclaration;
  readonly cls: IrNativeBufferClass;
}

/**
 * Least fixpoint: a var is certified once every write is a certified producer
 * of one class, and a call's handle result is a producer once its receiver
 * is (so a self-justifying `ab = ab.slice(1)` never certifies).
 */
function certifyBufferVars(
  checker: ts.TypeChecker,
  sites: BufferSites,
  candidates: ReadonlyMap<ts.VariableDeclaration, ts.Symbol>,
  operands: IrNativeBufferOperands,
): {
  readonly certified: ReadonlyMap<ts.Symbol, CertifiedVar>;
  classOf(expr: ts.Expression): IrNativeBufferClass | undefined;
  /** The admitted call member of `call`: a certified receiver, a table entry, admitted arguments. */
  callMember(call: ts.CallExpression): AdmittedCall | undefined;
} {
  const certified = new Map<ts.Symbol, CertifiedVar>();
  const classOf = (expr: ts.Expression): IrNativeBufferClass | undefined => {
    const candidate = stripParens(expr);
    if (ts.isNewExpression(candidate)) {
      const shape = sites.constructions.get(candidate);
      if (shape?.kind === "construct") return "ArrayBuffer";
      return shape && classOf(shape.buffer) === "ArrayBuffer" ? "DataView" : undefined;
    }
    if (ts.isCallExpression(candidate)) {
      return sites.calls.has(candidate) ? callMember(candidate)?.member.resultClass : undefined;
    }
    if (!ts.isIdentifier(candidate)) return undefined;
    const symbol = checker.getSymbolAtLocation(candidate);
    const binding = symbol === undefined ? undefined : certified.get(symbol);
    return binding && scriptVarUseFollowsDeclaration(candidate, binding.declaration) ? binding.cls : undefined;
  };
  const callMember = (call: ts.CallExpression): AdmittedCall | undefined => {
    const access = accessOf(call);
    const receiverClass = classOf(access.expression);
    if (receiverClass === undefined) return undefined;
    const member = nativeBufferMember(receiverClass, access.name.text);
    if (member?.kind !== "call" || call.arguments.length > member.operands.length) return undefined;
    const admitted = call.arguments.every((arg, i) => operands.operand(member.operands[i]!, arg));
    return admitted ? { member, receiverClass } : undefined;
  };
  const producerClass = (expr: ts.Expression): IrNativeBufferClass | undefined =>
    ts.isIdentifier(stripParens(expr)) ? undefined : classOf(expr);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [declaration, symbol] of candidates) {
      if (certified.has(symbol)) continue;
      const classes = new Set((sites.writesBySymbol.get(symbol) ?? []).map(producerClass));
      const [cls] = classes;
      if (classes.size !== 1 || cls === undefined) continue;
      certified.set(symbol, { declaration, cls });
      changed = true;
    }
  }
  return { certified, classOf, callMember };
}

/**
 * The certified operations. A getter or a call with no handle result is
 * certified wherever its receiver is; a producer (a construction, a `slice`)
 * only where the plan itself consumes its handle — as a certified operation's
 * receiver or buffer operand, or as a write into a certified var. A handle
 * anywhere else (an argument, `typeof`, a conditional arm, a discarded
 * statement) keeps the legacy route, whose consumers know the native objects.
 */
function planBufferOperations(
  sites: BufferSites,
  certified: ReadonlyMap<ts.Symbol, CertifiedVar>,
  admitted: {
    classOf(expr: ts.Expression): IrNativeBufferClass | undefined;
    callMember(call: ts.CallExpression): AdmittedCall | undefined;
  },
): ReadonlyMap<ts.Node, IrNativeBufferOperation> {
  const { classOf, callMember } = admitted;
  const operations = new Map<ts.Node, IrNativeBufferOperation>();
  const certifyCall = (call: ts.CallExpression, { member, receiverClass }: AdmittedCall): void => {
    const receiver = accessOf(call).expression;
    operations.set(call, {
      kind: "call",
      fn: member.fn,
      receiver,
      receiverClass,
      args: call.arguments,
      arity: member.operands.length,
      ...(member.resultClass ? { resultClass: member.resultClass } : {}),
    });
    consume(receiver);
  };
  const consume = (expr: ts.Expression): void => {
    const candidate = stripParens(expr);
    const shape = ts.isNewExpression(candidate) ? sites.constructions.get(candidate) : undefined;
    if (shape !== undefined && classOf(candidate) !== undefined) {
      operations.set(candidate, shape);
      if (shape.kind === "construct-view") consume(shape.buffer);
    } else if (ts.isCallExpression(candidate) && sites.calls.has(candidate)) {
      const admitted = callMember(candidate);
      if (admitted !== undefined) certifyCall(candidate, admitted);
    }
  };
  for (const access of sites.reads) {
    const receiverClass = classOf(access.expression);
    if (receiverClass === undefined) continue;
    const member = nativeBufferMember(receiverClass, access.name.text);
    if (member?.kind !== "get") continue;
    operations.set(access, {
      kind: "get",
      fn: member.fn,
      result: member.result,
      receiver: access.expression,
      receiverClass,
    });
    consume(access.expression);
  }
  for (const call of sites.calls) {
    const admitted = callMember(call);
    if (admitted !== undefined && admitted.member.resultClass === undefined) certifyCall(call, admitted);
  }
  for (const symbol of certified.keys()) (sites.writesBySymbol.get(symbol) ?? []).forEach(consume);
  return operations;
}

export function makeIrNativeBufferSurfacePlan(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): IrNativeBufferSurfacePlan {
  const operands = makeIrNativeBufferOperands(checker);
  const sites = collectBufferSites(checker, sourceFile, operands);
  const candidates = scriptVarCandidates(checker, sourceFile, sites.poisoned);
  const admitted = certifyBufferVars(checker, sites, candidates, operands);
  const { certified, classOf } = admitted;
  const operations = planBufferOperations(sites, certified, admitted);
  return {
    operation: (node) => operations.get(node),
    isReceiver: (expr) => classOf(expr) !== undefined,
    consumesHandle(node) {
      const value = outermostParenthesized(node);
      const parent = value.parent;
      if (ts.isNewExpression(parent)) {
        const op = operations.get(parent);
        return op?.kind === "construct-view" && op.buffer === value;
      }
      if (!ts.isPropertyAccessExpression(parent) || parent.expression !== value) return false;
      const call = parent.parent;
      return (
        operations.get(parent)?.kind === "get" ||
        (ts.isCallExpression(call) && call.expression === parent && operations.get(call)?.kind === "call")
      );
    },
    moduleBinding(declaration, writeValue) {
      const symbol = candidates.get(declaration);
      const binding = symbol === undefined ? undefined : certified.get(symbol);
      if (binding?.declaration !== declaration) return undefined;
      if (writeValue !== undefined && operations.get(stripParens(writeValue)) === undefined) return undefined;
      return { capability: "native-buffer", className: binding.cls };
    },
  };
}
