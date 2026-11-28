// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7628) The values a key expression may evaluate to, as a bounded set. One evaluator for two callers: the realm write
 * scan (`realm-member-writes.ts`), which resolves names and asks whether a computed read may name a key writer, and
 * the Prepared accessor key (`class-accessor-safety.ts`), which resolves no name and takes one exact value.
 */
import { ts } from "../ts-api.js";
import { skipOuterExpressions } from "../shared/binding-writes.js";

/** Any Number or BigInt. */
const SOME_NUMBER = Symbol("some number");
/** Any string longer than the longest key writer name: concatenation only grows it, so it never names a writer. */
const LONG_STRING = Symbol("long string");
export type KeyValue = string | number | typeof SOME_NUMBER | typeof LONG_STRING;
/** The values, or `undefined` for any value. */
export type KeyValues = ReadonlySet<KeyValue> | undefined;

/** A set past this size is any value: it bounds both a name's chain in a fixed point and one `+`'s pairs. */
const CAP = 64;
/**
 * `"getOwnPropertyDescriptors".length`, the longest key writer name. The writer names also contain none of the texts
 * `undefined`, `NaN`, `function`, `class` and `[object`: so the domain may leave out the value a `var` holds before its
 * initializer runs (`undefined`, or the realm's global property of that name), whose text or sum contains one of them,
 * and no operator of the domain removes text.
 */
const LONGEST_WRITER_NAME = 25;

const ARITHMETIC: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
]);
const COMPOUND: ReadonlyMap<ts.SyntaxKind, ts.SyntaxKind> = new Map([
  [ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.PlusToken],
  [ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.MinusToken],
  [ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.AsteriskToken],
  [ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.SlashToken],
  [ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.PercentToken],
  [ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.AsteriskAsteriskToken],
  [ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.LessThanLessThanToken],
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanToken],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken],
  [ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.AmpersandToken],
  [ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.BarToken],
  [ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.CaretToken],
]);

const ONE_SOME_NUMBER: KeyValues = new Set([SOME_NUMBER]);

const isNumber = (value: KeyValue): boolean => typeof value === "number" || value === SOME_NUMBER;

/** `+` of one pair; `undefined` when a string meets `SOME_NUMBER` (its text is not known). */
function plus(left: KeyValue, right: KeyValue): KeyValue | undefined {
  if (typeof left === "number" && typeof right === "number") return left + right;
  if (isNumber(left) && isNumber(right)) return SOME_NUMBER;
  if (left === SOME_NUMBER || right === SOME_NUMBER) return undefined;
  if (left === LONG_STRING || right === LONG_STRING) return LONG_STRING;
  return String(left) + String(right);
}

/**
 * An arithmetic operator of one pair: `-` `*` `/` `%` `**` of two exact numbers is exact, except `/ 0` and `% 0`;
 * anything else is `SOME_NUMBER`. The exact cases are the accessor key's grammar, which takes no other.
 */
function arithmetic(operator: ts.SyntaxKind, left: KeyValue, right: KeyValue): KeyValue {
  if (typeof left !== "number" || typeof right !== "number") return SOME_NUMBER;
  switch (operator) {
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.SlashToken:
      return right === 0 ? SOME_NUMBER : left / right;
    case ts.SyntaxKind.PercentToken:
      return right === 0 ? SOME_NUMBER : left % right;
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return left ** right;
    default:
      return SOME_NUMBER;
  }
}

/** The pairwise `combine` of two sets; any value past the cap, checked as the product grows. */
function product(
  left: KeyValues,
  right: KeyValues,
  combine: (left: KeyValue, right: KeyValue) => KeyValue | undefined,
): KeyValues {
  if (!left || !right) return undefined;
  const out = new Set<KeyValue>();
  for (const leftValue of left)
    for (const rightValue of right) {
      const value = combine(leftValue, rightValue);
      if (value === undefined) return undefined;
      out.add(value);
      if (out.size > CAP) return undefined;
    }
  return out;
}

/** The values of a unary `+` / `-`, `~`, `++` or `--`; `!` is a boolean and stays any value. */
function unaryValues(node: ts.PrefixUnaryExpression, values: (operand: ts.Expression) => KeyValues): KeyValues {
  if (node.operator === ts.SyntaxKind.ExclamationToken) return undefined;
  if (node.operator !== ts.SyntaxKind.MinusToken && node.operator !== ts.SyntaxKind.PlusToken) return ONE_SOME_NUMBER;
  const operand = values(node.operand);
  const sign = node.operator === ts.SyntaxKind.MinusToken ? -1 : 1;
  return operand
    ? new Set([...operand].map((value) => (typeof value === "number" ? sign * value : SOME_NUMBER)))
    : ONE_SOME_NUMBER;
}

/** The values of a binary `+`, an arithmetic operator or their compound assignment; any other operator is any value. */
function binaryValues(node: ts.BinaryExpression, values: (operand: ts.Expression) => KeyValues): KeyValues {
  const compound = COMPOUND.get(node.operatorToken.kind);
  // A compound assignment stores into a reference: `1 += 1` is an early error, not 2.
  if (compound !== undefined && !ts.isIdentifier(skipOuterExpressions(node.left))) return undefined;
  const operator = compound ?? node.operatorToken.kind;
  if (operator === ts.SyntaxKind.PlusToken) return product(values(node.left), values(node.right), plus);
  if (!ARITHMETIC.has(operator)) return undefined;
  const left = values(node.left) ?? ONE_SOME_NUMBER;
  const right = values(node.right) ?? ONE_SOME_NUMBER;
  return product(left, right, (leftValue, rightValue) => arithmetic(operator, leftValue, rightValue));
}

/** The values of `expression`; `nameValues` answers a name (by default: any value). */
export function keyValues(
  expression: ts.Expression,
  nameValues: (name: ts.Identifier) => KeyValues = () => undefined,
): KeyValues {
  const node = skipOuterExpressions(expression);
  const values = (operand: ts.Expression): KeyValues => keyValues(operand, nameValues);
  if (ts.isStringLiteralLike(node)) return new Set([node.text]);
  if (ts.isNumericLiteral(node)) return new Set([Number(node.text)]);
  if (ts.isIdentifier(node)) return nameValues(node);
  if (ts.isTemplateExpression(node)) {
    let text: KeyValues = new Set([node.head.text]);
    for (const span of node.templateSpans)
      text = product(product(text, values(span.expression), plus), new Set([span.literal.text]), plus);
    return text;
  }
  if (ts.isPostfixUnaryExpression(node)) return ONE_SOME_NUMBER;
  if (ts.isPrefixUnaryExpression(node)) return unaryValues(node, values);
  return ts.isBinaryExpression(node) ? binaryValues(node, values) : undefined;
}

/** The one exact value of `values` as a key, or `undefined`. */
export function exactKey(values: KeyValues): string | undefined {
  if (values?.size !== 1) return undefined;
  const [value] = values;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** `values` as a name holds them: a number is `SOME_NUMBER`, a string longer than any writer name `LONG_STRING`. */
export function widen(values: KeyValues): KeyValues {
  if (!values) return undefined;
  return new Set(
    [...values].map((value) =>
      typeof value === "number"
        ? SOME_NUMBER
        : typeof value === "string" && value.length > LONGEST_WRITER_NAME
          ? LONG_STRING
          : value,
    ),
  );
}

/** The union of two sets; any value past the cap. */
export function union(left: KeyValues, right: KeyValues): KeyValues {
  if (!left || !right) return undefined;
  const out = new Set([...left, ...right]);
  return out.size > CAP ? undefined : out;
}
