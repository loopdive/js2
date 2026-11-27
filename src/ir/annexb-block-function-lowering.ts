// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7372 slice 2a) The two run-time steps of an Annex B block function (`annexb-block-function-values.ts`):
 *   - {@link instantiateBlockFunctions}: BlockDeclarationInstantiation of a declaring scope stores each block
 *     function's new function object in its block home before the scope's first statement. For a `switch` that is
 *     after the discriminant and before any clause is selected, so every clause sees the functions;
 *   - {@link evaluateBlockFunction}: the declaration's own evaluation copies the block binding's current value into
 *     the var binding (§B.3.2.2 step b), by the declaration's identity, never through a lookup of its name (a
 *     `catch (f)` parameter in between would take an identifier write).
 */
import { ts } from "../ts-api.js";
import type { BlockFunctionHomeRefs } from "./annexb-block-function-values.js";
import type { IrFunctionBuilder } from "./builder.js";
import type { IrValueId } from "./nodes.js";

export type { BlockFunctionHomeRefs };

/** The slice of the lowering context the two steps use. */
export interface BlockFunctionLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly homesOf: (declaration: ts.FunctionDeclaration) => BlockFunctionHomeRefs | undefined;
  /** The declaration's new function object, in the dynamic carrier. */
  readonly functionValue: (declaration: ts.FunctionDeclaration) => IrValueId;
  /** Unbind a name in the scope's own lowering scope: there it means the block binding, not an outer local. */
  readonly unbind: (name: string) => void;
  /** A host over a copy of this one's lowering scope (an `if` clause's function is a scope of its own). */
  readonly scoped: () => BlockFunctionLoweringHost;
}

/**
 * Store the function objects of the block functions `scope` declares (a Block or a CaseBlock), in source order. Each
 * name means its block binding everywhere in the scope, so an outer local of the name (a `catch (f)` parameter) is
 * unbound there first.
 */
export function instantiateBlockFunctions(scope: ts.Block | ts.CaseBlock, host: BlockFunctionLoweringHost): void {
  const statements: readonly ts.Statement[] = ts.isBlock(scope)
    ? scope.statements
    : scope.clauses.flatMap((clause) => clause.statements);
  const declared = statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && host.homesOf(statement) !== undefined,
  );
  for (const fn of declared) host.unbind(fn.name!.text);
  for (const fn of declared) instantiate(fn, host.homesOf(fn), host);
}

/**
 * The declaration's evaluation; false when it is no admitted block function. An `if` clause's declaration is its own
 * scope, which is entered right here, in a copy of the enclosing lowering scope where the name is unbound.
 */
export function evaluateBlockFunction(declaration: ts.FunctionDeclaration, host: BlockFunctionLoweringHost): boolean {
  const homes = host.homesOf(declaration);
  if (!homes) return false;
  if (ts.isIfStatement(declaration.parent)) {
    const clause = host.scoped();
    clause.unbind(declaration.name!.text);
    instantiate(declaration, homes, clause);
  }
  if (homes.var) {
    const value = host.builder.emitGlobalGet(homes.block.globalRef, homes.block.type);
    host.builder.emitGlobalSet(homes.var.globalRef, value);
  }
  return true;
}

function instantiate(
  declaration: ts.FunctionDeclaration,
  homes: BlockFunctionHomeRefs | undefined,
  host: BlockFunctionLoweringHost,
): void {
  if (homes) host.builder.emitGlobalSet(homes.block.globalRef, host.functionValue(declaration));
}
