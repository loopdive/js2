// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491, wave-4 lane I) BUILTIN-PROTOTYPE NAME CAPTURE — the computed-key half
 * of the #3033 "the program defines its own member of this name" refusal.
 *
 * `sourceDefinesFunctionMember` (source-function-members.ts) is what stops the
 * extern-class first-match loop in `tryExternClassMethodOnAny` from hijacking a
 * call whose method name merely COLLIDES with an ambient builtin's. It scanned
 * only the DOTTED spelling of a function-valued member write:
 *
 *     o.dispose = function () {};     // seen  → refusal fires  → generic call
 *     o['dispose'] = function () {};  // MISSED → the loop claims the name
 *
 * The bracket form is not an exotic spelling — it is the dominant one in the
 * ES5 sputnik corpus (`seat['move']=function(){position++}`,
 * `language/types/object/S8.6.2_A5_T2.js`) and in any code that builds a method
 * table from string keys. With it missed, `o.dispose()` on a plain object
 * reached the `DisposableStack` brand arm, whose MISS arm throws
 * `TypeError: DisposableStack.prototype.dispose requires a DisposableStack
 * receiver` — a live miscompile of a program that never mentioned
 * DisposableStack. `o['move']()` was worse: `move` has no native arm, so the
 * loop bound the `env::DisposableStack_move` HOST import, which standalone
 * cannot satisfy (the whole module then fails to instantiate).
 *
 * The fix belongs HERE, at the refusal, not in the brand arm's else branch:
 * the refusal runs BEFORE every claiming arm, so one recognizer covers the
 * whole capture set (every method name any registered extern class declares)
 * instead of one builtin at a time.
 *
 * Literal keys only. A computed key (`o[k] = fn`) names nothing at compile
 * time, and widening to "some member was written" would refuse extern dispatch
 * for every program that touches a dynamic property — far past the evidence.
 */
import { ts } from "../ts-api.js";

/** The literal property name a `<recv>[<key>] = <fn>` assignment writes, if any. */
export function elementAccessAssignedMemberName(node: ts.Node): string | undefined {
  if (!ts.isBinaryExpression(node)) return undefined;
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  if (!ts.isElementAccessExpression(node.left)) return undefined;
  // Same RHS shapes the dotted scan accepts: a function literal, or an
  // identifier that may hold one (the dotted scan is deliberately permissive
  // there — a name-collision hijack is wrong either way).
  const rhs = node.right;
  if (!ts.isFunctionExpression(rhs) && !ts.isArrowFunction(rhs) && !ts.isIdentifier(rhs)) return undefined;
  return literalPropertyKey(node.left.argumentExpression);
}

/** The compile-time property name of a literal element-access key, if it has one. */
function literalPropertyKey(key: ts.Expression): string | undefined {
  if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return key.text;
  if (ts.isNumericLiteral(key)) return key.text;
  return undefined;
}
