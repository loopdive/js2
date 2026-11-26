// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7354 U) Abort bodies. Under the `unlowerableBodies` policy of the Prepared producer, a function whose body the
// path cannot lower gets a body that is the run-time abort, instead of the compile-time refusal of the whole program:
// a program that never calls the function compiles and runs, one that calls it ends there.
//
// The abort is the `unreachable` terminator, a Wasm trap: no `catch` or `finally` of the program runs, so a program
// that expects a throw cannot be satisfied by it. Entering the function ends the program, which is why the effects its
// body would have had (writes to outer variables, calls) need no stand-in. Everything else about the function is its
// declaration's, not its body's: its parameters and result, its captures, its function object (`length`, `name`,
// identity, the constructor bit, its strictness), so a program that creates, stores, passes, compares or `typeof`s it
// sees JavaScript's answer.
//
// Who owns a refusal (one rule, `ordinaryOwner`): the innermost function expression or script-level function
// declaration around the refused construct. A refusal inside an arrow, a method, an accessor or a nested declaration
// belongs to the function around it: those are lowered with their enclosing function, and aborting the enclosing
// function never runs them either. A refusal with no such owner (top-level code) stays the program's. Async functions
// and generators refuse before any body is lowered (a declaration in signature planning, an expression in its
// enclosing function), so none is an owner today; the slice that lowers one must exclude it here, as its call runs no
// body.

import { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "./builder.js";
import type { IrFunction } from "./nodes.js";
import { IrUnsupportedError } from "./outcomes.js";
import type { AllocSiteRegistry } from "./analysis/alloc-registry.js";
import type { IrUnitId } from "./identity.js";

type OrdinaryFunction = ts.FunctionExpression | ts.FunctionDeclaration;

/** One function that got the abort body: its Wasm name (a trap's frame names it) and the refusal it replaces. */
export interface AbortBodyRow {
  readonly unit: IrUnitId;
  readonly name: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly detail: string;
}

/**
 * (#7486) One run-time abort site (`js.value.unsupported_at`), at the index of its program-wide id, which the trap
 * leaves in the exported global `__js_value_unsupported_site`: the function it was legalized in, and why it aborts.
 */
export interface AbortSiteRow {
  readonly name: string;
  readonly detail: string;
}

/** The function that owns a refusal raised at `node` (see the header), if any. */
function ordinaryOwner(node: ts.Node): OrdinaryFunction | undefined {
  // A transform may hand the lowering a clone; ownership is the original node's, so a retry meets the same owner.
  for (let current: ts.Node | undefined = ts.getOriginalNode(node); current; current = current.parent)
    if (ts.isFunctionExpression(current) || (ts.isFunctionDeclaration(current) && ts.isSourceFile(current.parent)))
      return current;
  return undefined;
}

const owners = new WeakMap<IrUnsupportedError, OrdinaryFunction>();

/**
 * `error` with an owner: the one of `node` (raised while lowering or legalizing it), unless a function inside `node`
 * already owns it. Anything but a named refusal passes through untouched: an invariant is never absorbed.
 */
export function ownRefusal(error: unknown, node: ts.Node | undefined): unknown {
  if (error instanceof IrUnsupportedError && node !== undefined && !owners.has(error)) {
    const owner = ordinaryOwner(node);
    if (owner) owners.set(error, owner);
  }
  return error;
}

/** `lower()`, whose named refusal `node` owns (see {@link ownRefusal}). */
export function owningRefusals<T>(node: ts.Node, lower: () => T): T {
  try {
    return lower();
  } catch (error) {
    throw ownRefusal(error, node);
  }
}

/** `builder`'s function (its parameters already added) with the abort as its whole body. */
export function abortBody(builder: IrFunctionBuilder, closureSubtype?: IrFunction["closureSubtype"]): IrFunction {
  builder.openBlock();
  builder.terminate({ kind: "unreachable" });
  return builder.finish(closureSubtype);
}

/**
 * The policy `unlowerableBodies: "abort"`, and its record, which has two roles: the abort bodies (which functions got
 * the abort body, `rows`) and (#7486) the site diagnostics (why each run-time abort site aborts, `sites`, whose ids
 * only a build with this record emits). The caller that switches it on reads both after the compile.
 */
export class AbortBodies {
  readonly #refusals = new Map<OrdinaryFunction, IrUnsupportedError>();
  readonly #rows = new Map<OrdinaryFunction, AbortBodyRow>();
  readonly #sites: AbortSiteRow[] = [];

  /** `node` gets the abort body. */
  has(node: ts.Node): boolean {
    return this.#refusals.has(ts.getOriginalNode(node) as OrdinaryFunction);
  }

  /**
   * `lower()` (one unit's lowering), repeated once per function that turns out to own a refusal, which then gets the
   * abort body. Deciding first and lowering again means the accepted lowering is one clean pass: no half-lowered
   * state of a refused body survives, only the allocation sites and (#7486) abort sites it minted, which are dropped.
   * A refusal no function owns (`unitDeclaration` is the unit's own, absent for top-level code), or owned by a
   * function that has the abort body already (its signature, not its body, refused), stays the program's.
   */
  lower<T>(allocations: AllocSiteRegistry, unitDeclaration: ts.Node | undefined, lower: () => T): T {
    for (;;) {
      const mark = allocations.size;
      const sites = this.#sites.length;
      try {
        return lower();
      } catch (error) {
        if (!(error instanceof IrUnsupportedError)) throw error;
        const owner = owners.get(error) ?? (unitDeclaration && ordinaryOwner(unitDeclaration));
        if (owner === undefined || this.#refusals.has(owner)) throw error;
        this.#refusals.set(owner, error);
        allocations.truncate(mark);
        this.#sites.length = sites;
      }
    }
  }

  /** Name the rows of the functions among `functions` that got the abort body. */
  report(functions: readonly IrFunction[], declarationOf: (unit: IrUnitId) => ts.Node | undefined): void {
    for (const fn of functions) {
      const node = declarationOf(fn.unitId) as OrdinaryFunction | undefined;
      const refusal = node && this.#refusals.get(node);
      if (!node || !refusal) continue;
      const source = node.getSourceFile();
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      this.#rows.set(node, {
        unit: fn.unitId,
        name: fn.name,
        line: line + 1,
        column: character + 1,
        code: refusal.code,
        detail: refusal.message,
      });
    }
  }

  /** (#7486) The id of a new run-time abort site in `fn` with `reason`. */
  site(fn: IrFunction, reason: string): number {
    return this.#sites.push({ name: fn.name, detail: reason }) - 1;
  }

  /** (#7486) The run-time abort sites, by id. */
  sites(): readonly AbortSiteRow[] {
    return [...this.#sites];
  }

  /** The functions that got the abort body, in source order. */
  rows(): readonly AbortBodyRow[] {
    return [...this.#rows]
      .sort(([a], [b]) => a.getSourceFile().fileName.localeCompare(b.getSourceFile().fileName) || a.pos - b.pos)
      .map(([, row]) => row);
  }
}
