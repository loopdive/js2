// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
/**
 * (#4491 wave-5 T4) `"valueOf" in {}` answered **false**.
 *
 * ## The defect
 *
 * §7.3.12 HasProperty is prototype-inclusive, and every ordinary object's chain
 * ends at %Object.prototype%, whose seven own properties (§20.1.3) are therefore
 * `in` every object ever created. Standalone answered `false` for all of them on
 * a plain `{}`:
 *
 * ```js
 * var o = {};
 * "valueOf" in o                 // false   (spec: true)
 * "toString" in o                // false   (spec: true)
 * typeof o.valueOf               // "function"  — the READ was right all along
 * ```
 *
 * The read and the presence test disagree because they take different routes:
 * `o.valueOf` is resolved statically against the checker's apparent type, while
 * `in` folds from the receiver's *own* struct fields and then, on a miss, asks
 * the runtime `__extern_has`. That helper walks `$Object.$proto` — and an
 * ordinary object's `$proto` is `null`, because %Object.prototype% is a
 * `$NativeProto` VALUE object, not an `$Object` (the representation wall priced
 * in this issue's "$Object.$proto vs $NativeProto" section). So the walk ends
 * immediately and the miss point answers 0.
 *
 * The failure is easy to miss precisely because the spelling one reaches for
 * when checking — `o.valueOf` — is the one that was never broken.
 *
 * ## Why a front-end fold rather than a runtime-walk fix
 *
 * Making the walk find these names means giving `$Object.$proto` a
 * representation that can hold a `$NativeProto`, plus teaching four runtime
 * helpers to traverse it — the priced-and-declined change. But `in` does not
 * need the prototype OBJECT; it needs its NAME SET, which is fixed by the spec
 * and already written down for the value-read CSV
 * (`array-object-proto.ts`'s `OBJECT_PROTO_METHODS`). Answering from the name
 * set costs one membership test at the one call site that asks.
 *
 * ## Scope, and what deliberately does NOT move
 *
 * - **Only `in`.** `hasOwnProperty` / `Object.hasOwn` / `propertyIsEnumerable`
 *   are OWN-only by spec and are untouched — widening those is the #4017 −684
 *   blast radius this file records.
 * - **Only an affirmative answer.** The fold turns a wrong `false` into `true`;
 *   it can never turn a `true` into `false`, so no receiver loses an answer it
 *   already had.
 * - **`for…in` cannot gain keys from it.** The enumerator produces its key list
 *   from `__object_keys_forin` and only re-checks liveness with `__extern_has`
 *   (#2066), so a name that was never enumerated cannot appear because presence
 *   now answers 1.
 * - **A null-prototype receiver stays wrong, and was already wrong.** Measured
 *   on this head BEFORE the change: `"toString" in Object.create(null)` already
 *   answered `true` (the non-`$Object` boundary arm), so the fold introduces no
 *   new disagreement — it makes the ORDINARY receiver agree with the exotic one
 *   rather than the reverse.
 */
/**
 * %Object.prototype%'s own property names (ES2024 §20.1.3): the six methods
 * plus `constructor` (§20.1.3.1). Annex B's `__proto__` accessor and the four
 * `__define*__` / `__lookup*__` methods are deliberately excluded — they are
 * legacy web-compat additions that this compiler does not otherwise model, and
 * an `in` answer must not claim a member the read side cannot serve.
 */
export const OBJECT_PROTOTYPE_OWN_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
]);

/**
 * True when `staticKey` is inherited from %Object.prototype% by ANY ordinary
 * object, so a `key in receiver` whose own-property analysis came up empty must
 * still answer `true`.
 *
 * `receiverIsObjectShaped` is the caller's own verdict, not a re-derivation: the
 * `in` dispatch site has already thrown §13.10.1's TypeError for a statically
 * primitive right operand, so by the time this is asked the receiver is an
 * object. The parameter exists so a future caller on a path WITHOUT that guard
 * cannot silently inherit the assumption.
 */
export function objectPrototypeInheritsInName(staticKey: string | null, receiverIsObjectShaped: boolean): boolean {
  if (staticKey === null || !receiverIsObjectShaped) return false;
  return OBJECT_PROTOTYPE_OWN_NAMES.has(staticKey);
}

/**
 * The receiver-shape half of the verdict: a `ValType` kind that denotes a JS
 * object rather than a value. Kept beside the name set so the two halves of the
 * gate live in one file.
 */
export function inReceiverIsObjectShaped(kind: string): boolean {
  return kind === "externref" || kind === "anyref" || kind === "ref" || kind === "ref_null";
}

/** Prove the source expression explicitly creates a null-prototype object. */
export function hasExplicitNullObjectPrototype(
  ctx: CodegenContext,
  expr: ts.Expression,
  seen = new Set<ts.Node>(),
): boolean {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  if (seen.has(current)) return false;
  seen.add(current);

  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.some(
      (member) =>
        ts.isPropertyAssignment(member) &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
        member.name.text === "__proto__" &&
        member.initializer.kind === ts.SyntaxKind.NullKeyword,
    );
  }

  if (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    ts.isIdentifier(current.expression.expression) &&
    current.expression.expression.text === "Object" &&
    current.expression.name.text === "create"
  ) {
    return current.arguments[0]?.kind === ts.SyntaxKind.NullKeyword;
  }

  if (ts.isIdentifier(current)) {
    const initializer = ctx.oracle.variableInitializerOf(current);
    if (initializer && initializer !== current) return hasExplicitNullObjectPrototype(ctx, initializer, seen);
  }
  return false;
}
