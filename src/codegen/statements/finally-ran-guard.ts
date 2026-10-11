// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 U4) §14.15.3 — a throw raised BY a `finally` block completes the try
 * statement. None of that statement's OWN handlers may observe it.
 *
 * `compileTryStatement` inlines the finally body at every exit: the normal exit
 * of the try body, each break/continue/return site inside the try or catch body
 * (through the `finallyStack` entry) and the catch-body wrapper. All of those
 * copies are emitted INSIDE the statement's handlers, so before this a
 * `finally { i++; throw e }` re-entered its own catch_all and ran twice
 * (`language/statements/for-of/throw-from-finally.js`), and a catch clause
 * caught the throw of its own finally.
 *
 * The guard is one i32 local per try-with-finally: cleared on entry to the try
 * body, raised immediately before every inlined finally copy, and tested first
 * by every handler of the statement, which then propagates the exception
 * untouched — no catch body, no second finally. A finally that completes
 * normally is followed by a branch out of (or the end of) the try body, so the
 * raised flag is never consulted again; re-entering the statement (a loop)
 * clears it again.
 *
 * Both exception encodings: the standardized `try_table` form (standalone/WASI)
 * re-throws the payload through the shared tag; the legacy `try` form
 * (JS host) uses `rethrow 1` — the handler's own `if` is label 0.
 *
 * NOT inside an `async` function (the guard is then a no-op and allocates
 * nothing). Measured 2026-10-05 on standalone: `try { await rejected } catch
 * { … }` resumes NORMALLY instead of throwing, base and branch alike, and nine
 * `harness/asyncHelpers-throwsAsync-*.js` rows passed only because their
 * `finally { assert(caught) }` threw, its own catch clause caught that throw
 * and set `caught`, and the finally ran a second time. Guarding those bodies
 * turns the nine into honest failures; they belong with the await-rejection
 * defect, and the guard extends to async bodies when that lands.
 */
import { ts } from "../../ts-api.js";
import type { Instr } from "../../ir/types.js";
import type { allocLocal } from "../context/locals.js";
import type { FunctionContext } from "../context/types.js";

type FinallyClones = {
  cloneFinally: () => Instr[];
  cloneFinallyAtDepth: (extraDepth: number) => Instr[];
};

export interface FinallyRanGuard {
  /** First instructions of the try body. */
  reset(): Instr[];
  /** Emitted immediately before an inlined finally copy. */
  mark(): Instr[];
  /** The `finallyStack` clone pair, each copy preceded by {@link mark}. */
  guarded(clones: FinallyClones): FinallyClones;
  /**
   * Handler prologue: propagate untouched when the finally threw. Standardized
   * handlers pass the local holding the caught payload; legacy handlers pass
   * nothing and `rethrow`.
   */
  rethrowIfRan(exnLocal?: number): Instr[];
  /** Prologue for a standardized `catch $tag` body whose payload is on the stack. */
  payloadPrologue(): Instr[];
}

const NO_GUARD: FinallyRanGuard = {
  reset: () => [],
  mark: () => [],
  guarded: (clones) => clones,
  rethrowIfRan: () => [],
  payloadPrologue: () => [],
};

/** Is `node` inside an `async` function (the nearest enclosing function-like)? */
function inAsyncFunction(node: ts.Node): boolean {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionLike(n)) {
      return (
        (ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined)?.some(
          (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
        ) === true
      );
    }
  }
  return false;
}

/**
 * `alloc` is `allocLocal`, injected by the caller so this leaf stays out of the
 * codegen import-cycle SCC (`check:import-cycles`).
 */
export function createFinallyRanGuard(
  fctx: FunctionContext,
  tagIdx: number,
  stmt: ts.TryStatement,
  alloc: typeof allocLocal,
): FinallyRanGuard {
  if (inAsyncFunction(stmt)) return NO_GUARD;
  const flag = alloc(fctx, `__finally_ran_${fctx.locals.length}`, { kind: "i32" });
  const set = (value: 0 | 1): Instr[] => [
    { op: "i32.const", value },
    { op: "local.set", index: flag },
  ];
  const rethrowIfRan = (exnLocal?: number): Instr[] => {
    const propagate: Instr[] =
      exnLocal === undefined
        ? [{ op: "rethrow", depth: 1 } as Instr]
        : [
            { op: "local.get", index: exnLocal },
            { op: "throw", tagIdx },
          ];
    return [
      { op: "local.get", index: flag },
      { op: "if", blockType: { kind: "empty" }, then: propagate },
    ];
  };
  return {
    reset: () => set(0),
    mark: () => set(1),
    guarded: (clones) => ({
      cloneFinally: () => [...set(1), ...clones.cloneFinally()],
      cloneFinallyAtDepth: (extraDepth) => [...set(1), ...clones.cloneFinallyAtDepth(extraDepth)],
    }),
    rethrowIfRan,
    payloadPrologue: () => {
      const pending = alloc(fctx, `__finally_exn_${fctx.locals.length}`, { kind: "externref" });
      return [{ op: "local.set", index: pending }, ...rethrowIfRan(pending), { op: "local.get", index: pending }];
    },
  };
}
