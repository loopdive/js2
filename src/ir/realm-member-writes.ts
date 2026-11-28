// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7350, review RV-PR7549) The keys code may store or define on an object that can be a realm object: the write half
 * of `foldsBuiltinMember` (`builtin-global-binding.ts`). A realm object is reachable without spelling its name
 * (`(1).constructor`, `X.prototype.constructor`, `this` in a method `X` inherits, a re-export), so the question is
 * asked of every write in the program, by key: `X.k` keeps the built-in's value while no write that may reach `X`
 * names `k`. A write reaches no realm object when its receiver is a fresh value (a literal, a function or class
 * expression, an `Object.create(…)` result while `Object.create` is the built-in) or a name that only ever holds one.
 * A key writer can also be called without spelling its name, once its value is read out of a descriptor or a values
 * list; such a read counts as a write of every key on its operand. (#7628) A read by key (`Object["define" + p]`, a
 * computed pattern key) counts as a mention of every writer name its key may evaluate to (`key-values.ts`): it writes
 * nothing when the key's values are known and name no writer.
 */
import { ts } from "../ts-api.js";
import {
  isLogicalAssignmentTarget,
  isStoreTarget,
  occurrenceIsWriteTarget,
  skipOuterExpressions,
} from "../shared/binding-writes.js";
import { exactKey, keyValues, union, widen, type KeyValue, type KeyValues } from "./key-values.js";

/** One store or definition: its receiver and its key, each `undefined` where the source does not spell it. */
interface MemberStore {
  readonly receiver: ts.Expression | undefined;
  readonly key: string | undefined;
}

/** A write `memberWrites` finds: a store, or a read by key (its key expression). */
export type MemberWrite = MemberStore | { readonly computedKey: ts.Expression };

/**
 * One binding or assignment of a name (`builtin-global-binding.ts`'s `bindingFacts`): a function or class name
 * (`fresh`), a variable's initializer, the value an assignment stores, or a binding that may hold any value.
 */
export type NameBinding =
  | { readonly kind: "fresh" }
  | { readonly kind: "initializer"; readonly value: ts.Expression }
  | { readonly kind: "assigned"; readonly value: ts.Expression }
  | { readonly kind: "any" };

/** A write of every key on any object. */
const EVERY_KEY: MemberStore = { receiver: undefined, key: undefined };

/**
 * The calls that store or define keys on an operand, by member name: the `target` operand (`"receiver"`: the
 * member's object), and the `key` operand or the first operand whose own keys are stored (`keysFrom`). §20.1.2.1
 * `Object.assign`, .3 `defineProperties`, .4 `defineProperty` (and §28.1.3 `Reflect.defineProperty`), Annex B.2.2.2-3.
 * Beside them the calls that hand out the values of the `target` operand's keys: §20.1.2.8 / .9
 * `getOwnPropertyDescriptor(s)`, .5 `entries`, .23 `values`. A key writer read this way is called without its name,
 * so the read counts as a write of every key on its operand: a fresh object holds a key writer only by a write that
 * spells the writer or writes every key itself. A descriptor read by an exact key (`readKey`) hands out that key's
 * value only, which is a key writer only under the writer's own name (a counted mention) or where a write of every
 * key put one. `getOwnPropertyNames` and `keys` hand out names, which reach a value through a computed read (counted:
 * a name read back has an unknown key), a descriptor read or `Reflect`.
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

/** The names whose mention writes every key, unless it is a key writer's call: `KEY_WRITERS` and `Reflect`. */
const isWriterName = (name: string): boolean => name === "Reflect" || KEY_WRITERS.has(name);

/**
 * How fresh a value is: `"fresh"`, a fresh object or a primitive (a literal, `void`, a function or class expression);
 * `"created"`, an `Object.create(…)` result, fresh while `Object.create` is the built-in.
 */
type Freshness = "fresh" | "created";

/** The freshness of `value`, `undefined` when it may be any value. */
function freshnessOf(value: ts.Expression): Freshness | undefined {
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
    index < spelled ? exactKey(keyValues(operands[index])) : spread < 0 ? "undefined" : undefined;
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
        key:
          name === undefined
            ? undefined
            : ts.isComputedPropertyName(name)
              ? exactKey(keyValues(name.expression))
              : name.text,
      });
  }
}

/** A computed key of a destructuring pattern: a binding element's, or a property's of an assignment pattern. */
function isPatternKey(name: ts.ComputedPropertyName): boolean {
  const property = name.parent;
  return (
    ts.isBindingElement(property) ||
    (ts.isPropertyAssignment(property) && property.name === name && isStoreTarget(property.parent))
  );
}

/**
 * The key of a read by key: an element access that is no store target, or a pattern's computed key. `isStoreTarget`
 * is exact where `occurrenceIsWriteTarget` is conservative: a default (`var {g = o[k]} = p`) is read, not stored, so
 * it must count as a read; the store arm may count it as a store as well. The target of `||=`, `&&=` or `??=` is a
 * read too: `o[k] ||= v` evaluates to `o[k]` when it holds a value (a writer).
 */
function computedReadKey(node: ts.Node): ts.Expression | undefined {
  if (ts.isElementAccessExpression(node))
    return isStoreTarget(node) && !isLogicalAssignmentTarget(node) ? undefined : node.argumentExpression;
  return ts.isComputedPropertyName(node) && isPatternKey(node) ? node.expression : undefined;
}

/**
 * The writes `node` makes: a store target `o.k` / `o["k"]` (an assignment, compound, `++` / `--`, `delete`,
 * destructuring or for-in / for-of target); a key writer called as a member (`o.defineProperty(t, "k", d)`), whose
 * keys are its operands' exact ones (`exactKey`); as a write of any key on any object, a key writer's other mention
 * (`var d = Object.defineProperty`, `o["assign"]`, `.call`), a `with` statement and any spelling of `Reflect`; and a
 * read by key (`o["define" + p]`, `var {[k]: d} = o`), weighed once the program's names are known
 * ({@link realmWrittenKeys}).
 */
export function memberWrites(node: ts.Node, write: (write: MemberWrite) => void): void {
  const computedKey = computedReadKey(node);
  if (computedKey) write({ computedKey });
  if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && occurrenceIsWriteTarget(node))
    write({
      receiver: node.expression,
      key: ts.isPropertyAccessExpression(node) ? node.name.text : exactKey(keyValues(node.argumentExpression)),
    });
  else if (ts.isWithStatement(node)) write(EVERY_KEY);
  else if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && isWriterName(node.text)) {
    const writer = KEY_WRITERS.get(node.text);
    const member = node.parent;
    const call = member.parent;
    if (
      writer !== undefined &&
      ts.isPropertyAccessExpression(member) &&
      member.name === node &&
      ts.isCallExpression(call) &&
      call.expression === member
    )
      keyWriterWrites(writer, member, call, write);
    else write(EVERY_KEY);
  }
}

/** A name the stores of which hold its values: a candidate of {@link nameKeyValues}. */
interface StoredName {
  readonly name: string;
  readonly values: readonly ts.Expression[];
}

/**
 * The key values of every name, as the least fixed point over the values its bindings store. A name is known only
 * when every binding of it is an initializer or an assignment and `rebound` (the keys a reaching write names, so the
 * global object's property of that name) does not hold it; any other name, or a name with no binding, is any value.
 * Each set only grows and is bounded (`widen`, `union`'s cap), so a worklist settles: evaluating a name records it as
 * a reader of every name it looks up, and a name whose set changes queues exactly its readers again.
 */
function nameKeyValues(
  bindings: ReadonlyMap<string, readonly NameBinding[]>,
  rebound: ReadonlySet<string>,
): (name: ts.Identifier) => KeyValues {
  const current = new Map<string, KeyValues>();
  const queue = new Set<StoredName>();
  for (const [name, records] of bindings) {
    const values = records.flatMap((binding) =>
      binding.kind === "initializer" || binding.kind === "assigned" ? [binding.value] : [],
    );
    if (rebound.has(name) || values.length !== records.length) continue;
    current.set(name, new Set<KeyValue>());
    queue.add({ name, values });
  }
  const readers = new Map<string, Set<StoredName>>();
  for (const stored of queue) {
    queue.delete(stored);
    const before = current.get(stored.name);
    if (before === undefined) continue;
    const lookup = (name: ts.Identifier): KeyValues => {
      readers.set(name.text, (readers.get(name.text) ?? new Set<StoredName>()).add(stored));
      return current.get(name.text);
    };
    let after: KeyValues = new Set<KeyValue>();
    for (const value of stored.values) {
      after = union(after, widen(keyValues(value, lookup)));
      if (after === undefined) break;
    }
    if (after !== undefined && after.size === before.size) continue;
    current.set(stored.name, after);
    readers.get(stored.name)?.forEach((reader) => queue.add(reader));
  }
  return (name) => current.get(name.text);
}

const namesWriter = (value: KeyValue): boolean => typeof value === "string" && isWriterName(value);

/** Whether no computed read may read a key writer: each key's values are known under `rebound` and name no writer. */
function computedReadsNameNoWriter(
  keys: readonly ts.Expression[],
  bindings: ReadonlyMap<string, readonly NameBinding[]>,
  rebound: ReadonlySet<string>,
): boolean {
  const names = nameKeyValues(bindings, rebound);
  return keys.every((key) => {
    const values = keyValues(key, names);
    return values !== undefined && ![...values].some(namesWriter);
  });
}

/**
 * The names every binding of which holds a fresh value, by freshness: a function or class name, or a variable whose
 * initializer is fresh (`"created"` when one holds an `Object.create(…)` result).
 */
function freshNames(bindings: ReadonlyMap<string, readonly NameBinding[]>): Map<string, Freshness> {
  const fresh = new Map<string, Freshness>();
  for (const [name, records] of bindings) {
    const freshness = records.map((binding) =>
      binding.kind === "fresh" ? "fresh" : binding.kind === "initializer" ? freshnessOf(binding.value) : undefined,
    );
    if (freshness.every((each) => each !== undefined))
      fresh.set(name, freshness.includes("created") ? "created" : "fresh");
  }
  return fresh;
}

/**
 * The keys the writes of a program may write on a realm object, or `undefined` for every key. A write reaches no
 * realm object when its receiver is a fresh value, or a fresh name ({@link freshNames} of `bindings`) that no other
 * write may rebind: a top-level binding is a property of the global object, so a fresh name stays one only while
 * every write naming it as a key (or naming no key) reaches no realm object itself. A created value is fresh while
 * `Object.create` is the built-in: `createIsBuiltin` (every `Object` it is read off is pristine and never escapes)
 * and no reaching write names `create`. The largest such set is found by dropping names (and the created values)
 * until none is written. Then the computed reads write nothing or every key ({@link computedReadsNameNoWriter}, a name
 * those keys name being any value); they add no key, so the loop is not run again.
 */
export function realmWrittenKeys(
  writes: readonly MemberWrite[],
  bindings: ReadonlyMap<string, readonly NameBinding[]>,
  createIsBuiltin: boolean,
): ReadonlySet<string> | undefined {
  const stores = writes.filter((write): write is MemberStore => "receiver" in write);
  const computedKeys = writes.flatMap((write) => ("computedKey" in write ? [write.computedKey] : []));
  const fresh = freshNames(bindings);
  let created = createIsBuiltin;
  const holdsFresh = (receiver: ts.Expression): boolean => {
    const node = skipOuterExpressions(receiver);
    const freshness = freshnessOf(node) ?? (ts.isIdentifier(node) ? fresh.get(node.text) : undefined);
    return freshness === "fresh" || (freshness === "created" && created);
  };
  for (;;) {
    const reaching = stores.filter(({ receiver }) => receiver === undefined || !holdsFresh(receiver));
    const keys = new Set<string>();
    for (const { key } of reaching) {
      if (key === undefined) return undefined;
      keys.add(key);
    }
    const rebound = [...fresh.keys()].filter((name) => keys.has(name));
    const createWritten = created && keys.has("create");
    if (rebound.length === 0 && !createWritten)
      return computedReadsNameNoWriter(computedKeys, bindings, keys) ? keys : undefined;
    rebound.forEach((name) => fresh.delete(name));
    if (createWritten) created = false;
  }
}
