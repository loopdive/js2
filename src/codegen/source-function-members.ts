// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import { elementAccessAssignedMemberName } from "./element-access-member-names.js";

const functionMemberNames = new WeakMap<ts.SourceFile, Set<string>>();
const aliasedFunctionMembers = new WeakMap<ts.SourceFile, Map<string, Set<string>>>();

export function sourceDefinesFunctionMember(sourceFile: ts.SourceFile, name: string): boolean {
  let names = functionMemberNames.get(sourceFile);
  if (names) return names.has(name);
  names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right) || ts.isIdentifier(node.right))
    ) {
      names!.add(node.left.name.text);
    } else if (elementAccessAssignedMemberName(node) !== undefined) {
      // (#4491) `o['dispose'] = function () {}` — the bracket spelling of the
      // same write. See element-access-member-names.ts for why the miss was a
      // live miscompile, not a cosmetic gap.
      names!.add(elementAccessAssignedMemberName(node)!);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isMethodDeclaration(property) && ts.isIdentifier(property.name)) names!.add(property.name.text);
        else if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          (ts.isFunctionExpression(property.initializer) || ts.isArrowFunction(property.initializer))
        ) {
          names!.add(property.name.text);
        }
      }
    } else if (ts.isClassLike(node)) {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) names!.add(member.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  functionMemberNames.set(sourceFile, names);
  return names.has(name);
}

/**
 * Does this file assign `<receiver>.<name> = <alias>` somewhere?
 *
 * `alias` is an identifier by default. `includeMemberAliases` additionally
 * admits a PROPERTY-ACCESS right-hand side — `o.match = String.prototype.match`
 * (#4439), the dominant ES5-sputnik spelling of borrowing a builtin method.
 *
 * Why that spelling had to be admitted, and why it is opt-in:
 *
 * - **The miss is not cosmetic.** With the property-access RHS unrecognized,
 *   `o.match(v)` fell through to the extern-class first-match loop, which binds
 *   the FIRST registered extern class declaring `match` — the DOM `Cache`
 *   interface — and emitted `env::Cache_match`. That is a host import the
 *   standalone runtime cannot satisfy (measured on
 *   `built-ins/String/prototype/match/this-val-obj.js` and `this-val-bool.js`,
 *   which the compiler's own host-import-leak diagnostic named).
 * - **It stays RECEIVER-SCOPED.** The answer is `members[name] ∋ receiver.text`,
 *   so only the very identifier this file assigned the member to declines the
 *   extern binding; every other receiver keeps it.
 * - **It is opt-in because the JS-HOST lane must stay byte-identical.** There
 *   the `Cache_match` import is satisfiable, so widening the refusal would
 *   change host-lane output for no host-lane benefit. The caller gates on
 *   `noJsHost`.
 */
export function sourceAssignsAliasedFunctionMember(
  sourceFile: ts.SourceFile,
  receiver: ts.Expression,
  name: string,
  includeMemberAliases = false,
): boolean {
  if (!ts.isIdentifier(receiver)) return false;
  let members = aliasedFunctionMembers.get(sourceFile);
  if (!members) {
    members = new Map<string, Set<string>>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        ts.isIdentifier(node.left.expression) &&
        (ts.isIdentifier(node.right) || ts.isPropertyAccessExpression(node.right))
      ) {
        // Key by RHS shape so the identifier-only answer stays exactly what it
        // was; the widened answer is a superset the caller opts into.
        const key = ts.isIdentifier(node.right) ? node.left.name.text : `member:${node.left.name.text}`;
        const receivers = members!.get(key) ?? new Set<string>();
        receivers.add(node.left.expression.text);
        members!.set(key, receivers);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    aliasedFunctionMembers.set(sourceFile, members);
  }
  if (members.get(name)?.has(receiver.text) === true) return true;
  return includeMemberAliases && members.get(`member:${name}`)?.has(receiver.text) === true;
}
