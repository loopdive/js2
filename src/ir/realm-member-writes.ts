// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7350, review RV-PR7549) The keys code may store or define on an object that can be a realm object: the write half
 * of `foldsBuiltinMember` (`builtin-global-binding.ts`). A realm object is reachable without spelling its name
 * (`(1).constructor`, `X.prototype.constructor`, `this` in a method `X` inherits, a re-export), so the question is
 * asked of every write in the program, by key: `X.k` keeps the built-in's value while no write that may reach `X`
 * names `k`. A write reaches no realm object when its receiver is a fresh value (a literal, a function or class
 * expression, an `Object.create(…)` result while `Object.create` is the built-in) or a name that only ever holds one.
 * A key writer can also be called without spelling its name, once its value is read out of a descriptor or a values
 * list; such a read counts as a write of every key on its operand.
 */
import { ts } from "../ts-api.js";
import { isNonReferenceName, occurrenceIsWriteTarget, skipOuterExpressions } from "../shared/binding-writes.js";

/** One store or definition: its receiver and its key, each `undefined` where the source does not spell it. */
export interface MemberWrite {
  readonly receiver: ts.Expression | undefined;
  readonly key: string | undefined;
}

/** A write of every key on any object. */
const EVERY_KEY: MemberWrite = { receiver: undefined, key: undefined };

/**
 * The calls that store or define keys on an operand, by member name: the `target` operand (`"receiver"`: the
 * member's object), and the `key` operand or the first operand whose own keys are stored (`keysFrom`). §20.1.2.1
 * `Object.assign`, .3 `defineProperties`, .4 `defineProperty` (and §28.1.3 `Reflect.defineProperty`), Annex B.2.2.2-3.
 * Beside them the calls that hand out the values of the `target` operand's keys: §20.1.2.8 / .9
 * `getOwnPropertyDescriptor(s)`, .5 `entries`, .23 `values`. A key writer read this way is called without its name,
 * so the read counts as a write of every key on its operand: a fresh object holds a key writer only by a write that
 * spells the writer or writes every key itself. A descriptor read by a literal key (`readKey`) hands out that key's
 * value only, which is a key writer only under the writer's own name (a counted mention) or where a write of every
 * key put one. `getOwnPropertyNames` and `keys` hand out names, which reach a value through a computed read (not
 * counted, see `foldsBuiltinMember`), a descriptor read or `Reflect`.
 * Every spelling of a member name counts, a declaration's or a string's too: an intended over-approximation.
 */
type KeyWriter =
  | { readonly target: number | "receiver"; readonly key: number }
  | { readonly target: number; readonly keysFrom: number }
  | { readonly target: number; readonly readKey: number }
  | { readonly target: number };
const KEY_WRITERS: ReadonlyMap<string, KeyWriter> = new Map<string, KeyWriter>([
  ["defineProperty", { target: 0, key: 1 }],
  ["defineProperties", { target: 0, keysFrom: 1 }],
  ["assign", { target: 0, keysFrom: 1 }],
  ["__defineGetter__", { target: "receiver", key: 0 }],
  ["__defineSetter__", { target: "receiver", key: 0 }],
  ["getOwnPropertyDescriptor", { target: 0, readKey: 1 }],
  ["getOwnPropertyDescriptors", { target: 0 }],
  ["entries", { target: 0 }],
  ["values", { target: 0 }],
]);

/** The key a key operand spells as a literal (`"k"`, `0`, a template without substitutions). */
function literalKey(operand: ts.Expression | undefined): string | undefined {
  const key = operand && skipOuterExpressions(operand);
  return key && (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) ? key.text : undefined;
}

/**
 * How fresh a value is: `"fresh"`, a fresh object or a primitive (a literal, `void`, a function or class expression);
 * `"created"`, an `Object.create(…)` result, fresh while `Object.create` is the built-in.
 */
export type Freshness = "fresh" | "created";

/** The freshness of `value`, `undefined` when it may be any value. */
export function freshnessOf(value: ts.Expression): Freshness | undefined {
  if (isFreshValue(value)) return "fresh";
  return objectCreateCallee(value) ? "created" : undefined;
}

/** The `Object` of `value` when it is an `Object.create(…)` call. */
export function objectCreateCallee(value: ts.Expression): ts.Identifier | undefined {
  const node = skipOuterExpressions(value);
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const { expression: object, name } = node.expression;
  return name.text === "create" && ts.isIdentifier(object) && object.text === "Object" ? object : undefined;
}

/** `value` evaluates to a fresh object or a primitive: a literal, `void`, a function or class expression. */
function isFreshValue(value: ts.Expression): boolean {
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
 * operand throws before it writes or reads (§20.1.2.4 step 1; an iterator's `values()` / `entries()` reads its
 * receiver's elements, which hold a key writer only by a counted write); a missing key operand is the key
 * `"undefined"`; an operand at or after a spread is not spelled.
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
  const keyAt = (index: number): string | undefined =>
    index < spelled ? literalKey(operands[index]) : spread < 0 ? "undefined" : undefined;
  if ("key" in writer) {
    write({ receiver, key: keyAt(writer.key) });
    return;
  }
  if ("readKey" in writer && keyAt(writer.readKey) !== undefined) return;
  if (spread >= 0 || !("keysFrom" in writer)) {
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
    write(EVERY_KEY);
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
    else write(EVERY_KEY);
  }
}

/**
 * The keys the writes of a program may write on a realm object, or `undefined` for every key. `freshNames` are the
 * names every binding of which holds a fresh value and none of which is assigned, by freshness (`"created"` when a
 * binding holds an `Object.create(…)` result). A write reaches no realm object when its receiver is a fresh value, or a
 * fresh name that no other write may rebind: a top-level binding is a property of the global object, so a fresh name
 * stays one only while every write naming it as a key (or naming no key) reaches no realm object itself. A created
 * value is fresh while `Object.create` is the built-in: `createIsBuiltin` (every `Object` it is read off is pristine
 * and never escapes) and no reaching write names `create`. The largest such set is found by dropping names (and the
 * created values) until none is written.
 */
export function realmWrittenKeys(
  writes: readonly MemberWrite[],
  freshNames: ReadonlyMap<string, Freshness>,
  createIsBuiltin: boolean,
): ReadonlySet<string> | undefined {
  const fresh = new Map(freshNames);
  let created = createIsBuiltin;
  const holdsFresh = (receiver: ts.Expression): boolean => {
    const node = skipOuterExpressions(receiver);
    const freshness = freshnessOf(node) ?? (ts.isIdentifier(node) ? fresh.get(node.text) : undefined);
    return freshness === "fresh" || (freshness === "created" && created);
  };
  for (;;) {
    const reaching = writes.filter(({ receiver }) => receiver === undefined || !holdsFresh(receiver));
    const keys = new Set<string>();
    for (const { key } of reaching) {
      if (key === undefined) return undefined;
      keys.add(key);
    }
    const rebound = [...fresh.keys()].filter((name) => keys.has(name));
    const createWritten = created && keys.has("create");
    if (rebound.length === 0 && !createWritten) return keys;
    rebound.forEach((name) => fresh.delete(name));
    if (createWritten) created = false;
  }
}
