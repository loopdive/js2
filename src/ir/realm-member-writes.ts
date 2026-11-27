// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7350, review RV-PR7549) The keys code may store or define on an object that can be a realm object: the write half
 * of `foldsBuiltinMember` (`builtin-global-binding.ts`). A realm object is reachable without spelling its name
 * (`(1).constructor`, `X.prototype.constructor`, `this` in a method `X` inherits, a re-export), so the question is
 * asked of every write in the program, by key: `X.k` keeps the built-in's value while no write that may reach `X`
 * names `k`. A write reaches no realm object when its receiver is a fresh value (a literal, a function or class
 * expression) or a name that only ever holds one.
 */
import { ts } from "../ts-api.js";
import { isNonReferenceName, occurrenceIsWriteTarget, skipOuterExpressions } from "../shared/binding-writes.js";

/** One store or definition: its receiver and its key, each `undefined` where the source does not spell it. */
export interface MemberWrite {
  readonly receiver: ts.Expression | undefined;
  readonly key: string | undefined;
}

/**
 * The calls that store or define keys on an operand, by member name: the `target` operand (`"receiver"`: the
 * member's object), and the `key` operand or the first operand whose own keys are stored (`keysFrom`). §20.1.2.1
 * `Object.assign`, .3 `defineProperties`, .4 `defineProperty` (and §28.1.3 `Reflect.defineProperty`), Annex B.2.2.2-3.
 */
type KeyWriter =
  | { readonly target: number | "receiver"; readonly key: number }
  | { readonly target: number; readonly keysFrom: number };
const KEY_WRITERS: ReadonlyMap<string, KeyWriter> = new Map([
  ["defineProperty", { target: 0, key: 1 }],
  ["defineProperties", { target: 0, keysFrom: 1 }],
  ["assign", { target: 0, keysFrom: 1 }],
  ["__defineGetter__", { target: "receiver", key: 0 }],
  ["__defineSetter__", { target: "receiver", key: 0 }],
]);

/** The key a key operand spells as a literal (`"k"`, `0`). */
function literalKey(operand: ts.Expression | undefined): string | undefined {
  const key = operand && skipOuterExpressions(operand);
  return key && (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) ? key.text : undefined;
}

/** `value` evaluates to a fresh object or a primitive: a literal, `void`, a function or class expression. */
export function isFreshValue(value: ts.Expression): boolean {
  const node = skipOuterExpressions(value);
  switch (node.kind) {
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.ClassExpression:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.VoidExpression:
      return true;
    default:
      return false;
  }
}

/**
 * The writes of a key writer's call `call` (`KEY_WRITERS`), whose member is `member`. A call without its target
 * operand throws before it writes (§20.1.2.4 step 1); a missing key operand is the key `"undefined"`; an operand at
 * or after a spread is not spelled.
 */
function keyWriterWrites(
  writer: KeyWriter,
  member: ts.PropertyAccessExpression,
  call: ts.CallExpression,
  write: (write: MemberWrite) => void,
): void {
  const operands = call.arguments;
  const spread = operands.findIndex(ts.isSpreadElement);
  const spelled = spread < 0 ? operands.length : spread;
  if (spread < 0 && writer.target !== "receiver" && writer.target >= operands.length) return;
  const receiver =
    writer.target === "receiver" ? member.expression : writer.target < spelled ? operands[writer.target] : undefined;
  if ("key" in writer) {
    write({
      receiver,
      key: writer.key < spelled ? literalKey(operands[writer.key]) : spread < 0 ? "undefined" : undefined,
    });
    return;
  }
  if (spread >= 0) {
    write({ receiver, key: undefined });
    return;
  }
  for (const operand of operands.slice(writer.keysFrom)) {
    const source = skipOuterExpressions(operand);
    if (!ts.isObjectLiteralExpression(source)) {
      if (!isFreshValue(source)) write({ receiver, key: undefined });
      continue;
    }
    for (const { name } of source.properties)
      write({
        receiver,
        key: name === undefined || ts.isComputedPropertyName(name) ? literalKey(name?.expression) : name.text,
      });
  }
}

/**
 * The writes `node` makes: a store target `o.k` / `o["k"]` (an assignment, compound, `++` / `--`, `delete`,
 * destructuring or for-in / for-of target); a key writer called as a member (`o.defineProperty(t, "k", d)`), whose
 * keys are its operands' literal ones; and, as a write of any key on any object, a key writer's other mention
 * (`var d = Object.defineProperty`, `o["assign"]`, `.call`), a `with` statement and a reference to `Reflect`.
 */
export function memberWrites(node: ts.Node, write: (write: MemberWrite) => void): void {
  if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && occurrenceIsWriteTarget(node))
    write({
      receiver: node.expression,
      key: ts.isPropertyAccessExpression(node) ? node.name.text : literalKey(node.argumentExpression),
    });
  else if (ts.isWithStatement(node) || (ts.isIdentifier(node) && node.text === "Reflect" && !isNonReferenceName(node)))
    write({ receiver: undefined, key: undefined });
  else if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
    const writer = KEY_WRITERS.get(node.text);
    if (writer === undefined) return;
    const member = node.parent;
    const call = member.parent;
    if (
      ts.isPropertyAccessExpression(member) &&
      member.name === node &&
      ts.isCallExpression(call) &&
      call.expression === member
    )
      keyWriterWrites(writer, member, call, write);
    else write({ receiver: undefined, key: undefined });
  }
}

/**
 * The keys the writes of a program may write on a realm object, or `undefined` for every key. `freshNames` are the
 * names every binding of which holds a fresh value and none of which is assigned. A write reaches no realm object when
 * its receiver is a fresh value, or a fresh name that no other write may rebind: a top-level binding is a property of
 * the global object, so a fresh name stays one only while every write naming it as a key (or naming no key) reaches no
 * realm object itself. The largest such set of names is found by dropping names until none is written.
 */
export function realmWrittenKeys(
  writes: readonly MemberWrite[],
  freshNames: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  const fresh = new Set(freshNames);
  const holdsFresh = (receiver: ts.Expression): boolean => {
    const node = skipOuterExpressions(receiver);
    return isFreshValue(node) || (ts.isIdentifier(node) && fresh.has(node.text));
  };
  for (;;) {
    const reaching = writes.filter(({ receiver }) => receiver === undefined || !holdsFresh(receiver));
    const keys = new Set<string>();
    for (const { key } of reaching) {
      if (key === undefined) return undefined;
      keys.add(key);
    }
    const rebound = [...fresh].filter((name) => keys.has(name));
    if (rebound.length === 0) return keys;
    rebound.forEach((name) => fresh.delete(name));
  }
}
