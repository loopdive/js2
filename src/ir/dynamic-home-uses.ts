// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The uses scan for a value on #7280's dynamic module home: which references
 * to a binding the dynamic arms answer as node does. Every consumer must accept
 * all of a binding's references before the selector claims it. The scan is
 * shared; each consumer supplies only its allow-list as a {@link ServedUsePolicy}:
 *   - #7335's open `$Object` (`var o = {}`, `dynamic-home-open-object.ts`);
 *   - #7340's primitive wrapper (`var w = new String(s)`, `wrapper-construction.ts`).
 *
 * The member screen is shared. The dynamic member read (`__dyn_member_get`)
 * answers own properties only, so a key the value may inherit is never served,
 * and neither is a call, through which other code could install an own member.
 */

import { isStoreTarget, outermostParenthesized } from "../shared/binding-writes.js";
import { ts } from "../ts-api.js";

/** One consumer's allow-list. */
export interface ServedUsePolicy {
  /** Keys the value may inherit or own beyond what the program stores: never read through the dynamic arms. */
  readonly unreadableKeys: ReadonlySet<string>;
  /** A call on a member of the binding that the consumer lowers itself (`o.hasOwnProperty(k)`). */
  readonly servesMemberCall: (call: ts.CallExpression) => boolean;
  /** A plain member read that passed the shared screen, judged on where its value goes. */
  readonly servesMemberRead: (member: ts.PropertyAccessExpression) => boolean;
  /** A reference that is not a member access's receiver. */
  readonly servesReference: (use: ts.Expression, reference: ts.Identifier) => boolean;
}

/** Every identifier named like `name` in `owner`, `name` itself excluded: property names and shadowing bindings count, which can only refuse more. */
export function referencesNamed(name: ts.Identifier, owner: ts.Node): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (node.text === name.text && node !== name) references.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(owner, visit);
  return references;
}

/**
 * One reference, judged on its outermost parenthesized form. A member access
 * on the binding is served when:
 *   - it is the callee of a call the policy serves; or
 *   - it is not optional, its key is not one the policy cannot read, and the
 *     member is not called or used as a tag (that hands the value to arbitrary
 *     code as `this`), and then either:
 *     - it is a read the policy serves; or
 *     - it is a plain `v.<key> = x` in code whose strictness `dyn.member_set`
 *       is told.
 * Any other reference is the policy's.
 */
export function isServedUse(reference: ts.Identifier, policy: ServedUsePolicy): boolean {
  const use = outermostParenthesized(reference);
  const parent = use.parent;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== use) {
    return policy.servesReference(use, reference);
  }
  if (ts.isCallExpression(parent.parent) && policy.servesMemberCall(parent.parent)) return true;
  if (parent.questionDotToken !== undefined || policy.unreadableKeys.has(parent.name.text)) return false;
  const member = outermostParenthesized(parent);
  const user = member.parent;
  if (
    (ts.isCallExpression(user) && user.expression === member) ||
    (ts.isTaggedTemplateExpression(user) && user.tag === member)
  )
    return false;
  if (!isStoreTarget(parent) && !ts.isDeleteExpression(user)) return policy.servesMemberRead(parent);
  return isPlainAssignmentTarget(parent) && writerKnowsItsStrictness(parent);
}

/** `target = v`: a plain assignment, not compound, logical or destructuring. */
function isPlainAssignmentTarget(target: ts.Expression): boolean {
  const user = outermostParenthesized(target).parent;
  return (
    ts.isBinaryExpression(user) &&
    user.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    user.left === outermostParenthesized(target)
  );
}

/** The write sits in `<module-init>` or a top-level function, the code whose strictness lowering is told. */
function writerKnowsItsStrictness(node: ts.Node): boolean {
  const owner = ts.findAncestor(node.parent, ts.isFunctionLike);
  return owner === undefined || (ts.isFunctionDeclaration(owner) && ts.isSourceFile(owner.parent));
}
