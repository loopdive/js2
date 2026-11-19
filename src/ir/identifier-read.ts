// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7354 Ty) Which provider resolves an identifier read, in from-ast's resolution order. The ONE authority for
 * that order: the identifier read lowers by switching on the answer, and every other question about a read (the
 * `typeof` of a global the program does not declare) asks the same function, so the two cannot drift. It emits nothing (it throws
 * only on a DOM preparation mismatch).
 */
import ts from "typescript";
import { builtinGlobalValueAdmitted } from "./builtin-globals.js";
import { outermostParenthesized } from "../shared/binding-writes.js";
import { IrInvariantError } from "./outcomes.js";
import type { IrFromAstResolver } from "./from-ast.js";
import type { FunctionValueLoweringPlans } from "./function-object-lowering.js";
import type { UnresolvedGlobalTypeof } from "./ambient-typeof.js";

type ModuleBinding = NonNullable<ReturnType<NonNullable<IrFromAstResolver["resolveModuleBinding"]>>>;
type HostGlobal = NonNullable<ReturnType<NonNullable<IrFromAstResolver["getHostGlobalInfo"]>>>;
type TopLevelFunction = NonNullable<
  ReturnType<NonNullable<FunctionValueLoweringPlans["topLevelFunctionValues"]>["get"]>
>;

export type IdentifierRead<Binding> =
  | { readonly kind: "top-level-function"; readonly plan: TopLevelFunction }
  | { readonly kind: "scope"; readonly binding: Binding }
  | { readonly kind: "module-binding"; readonly binding: ModuleBinding }
  /** The global `undefined` as a value: the carrier's undefined (#7106 item 1). */
  | { readonly kind: "global-undefined" }
  /** `NaN` / `Infinity` (#7104, legacy's `identifiers.ts` arm). */
  | { readonly kind: "global-number"; readonly value: number }
  /** A host ambient global (`document`, …) through the declared-globals registry (#2856). */
  | { readonly kind: "host-global"; readonly global: HostGlobal; readonly certifiedDom: boolean }
  /** An ambient intrinsic as a value, read off the realm's global object (#7106). */
  | { readonly kind: "ambient-intrinsic" }
  /**
   * (#7354 Ty) A `typeof` operand no provider resolves: a global the program does not declare, with the resolver's
   * `typeof` answer for it (the realm catalog's tag, "undefined" for a name nothing declares, or a named refusal).
   */
  | { readonly kind: "global-typeof"; readonly tag: UnresolvedGlobalTypeof }
  | { readonly kind: "unresolved" };

interface IdentifierReadContext<Binding> extends FunctionValueLoweringPlans {
  readonly scope: ReadonlyMap<string, Binding>;
  readonly resolver?: IrFromAstResolver;
  readonly funcName: string;
}

export function classifyIdentifierRead<Binding>(
  expr: ts.Identifier,
  cx: IdentifierReadContext<Binding>,
): IdentifierRead<Binding> {
  const plan = cx.topLevelFunctionValues?.get(expr);
  if (plan) return { kind: "top-level-function", plan };
  const binding = cx.scope.get(expr.text);
  // Scope bindings take priority: a local named `document` or `undefined` shadows the global.
  if (binding !== undefined) return { kind: "scope", binding };
  const resolver = cx.resolver;
  const moduleBinding = resolver?.resolveModuleBinding?.(expr);
  if (moduleBinding) return { kind: "module-binding", binding: moduleBinding };
  // Selector-admitted on the dynamic host-free lanes only.
  if (expr.text === "undefined" && resolver?.stringIsExternref?.() !== true) return { kind: "global-undefined" };
  if (expr.text === "NaN" || expr.text === "Infinity")
    return { kind: "global-number", value: expr.text === "NaN" ? NaN : Infinity };
  const dom = resolver?.standaloneDomOperation?.(expr);
  const global = resolver?.getHostGlobalInfo?.(expr.text);
  if (dom?.kind === "global-get" && !global)
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "build",
      `ir/from-ast: certified DOM global ${expr.text} has no prepared import (${cx.funcName})`,
    );
  if (global)
    return {
      kind: "host-global",
      global,
      certifiedDom: dom?.kind === "global-get" && dom.identifier === expr && dom.importName === global.importName,
    };
  if (builtinGlobalValueAdmitted(expr, resolver ?? {})) return { kind: "ambient-intrinsic" };
  const tag = isTypeofOperand(expr) ? resolver?.unresolvedGlobalTypeof?.(expr) : undefined;
  return tag === undefined ? { kind: "unresolved" } : { kind: "global-typeof", tag };
}

function isTypeofOperand(expr: ts.Identifier): boolean {
  return ts.isTypeOfExpression(outermostParenthesized(expr).parent);
}
