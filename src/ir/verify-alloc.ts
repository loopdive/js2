// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Allocation-site provenance invariant checker (#1586).
//
// Walks an IrFunction after a pass and asserts that allocation-site identity
// is honest:
//
//   1. Every value-creating (allocation) instr carries an `alloc` id, and that
//      id resolves to a LIVE site in the registry (not retired/aliased-away).
//      A pass that drops an alloc must `retire` its id; a pass that folds it
//      away must `retire` it; the surviving instr must still resolve.
//   2. Any instr that carries an `alloc` id has a known id whose registered
//      `kind` matches the kind implied by the instr.
//
// This is the conservative gate from the issue's Risks section: an
// allocation-bearing instr without a live id, or a dangling/kind-mismatched
// id, is flagged so audit gaps and pass-discipline drift surface in CI rather
// than later. Intermediate pass checks are gated behind a debug flag; the
// final publication boundary is always checked.
//
// Like `verifyIrFunction`, this returns errors rather than throwing, so the
// caller decides whether to bail. `assertAllocProvenance` is the optional
// intermediate wrapper; `assertFinalAllocProvenance` is the required final
// wrapper.

import type { AllocSiteRegistry } from "./alloc-registry.js";
import type { AllocKind, AllocSiteId, IrFunction, IrInstr } from "./nodes.js";
import { IrInvariantError } from "./outcomes.js";

export interface AllocVerifyError {
  readonly message: string;
  readonly func: string;
}

/**
 * Maps each value-creating instr kind to the `AllocKind` its emitter registers.
 * Kinds absent here are not allocation sites and must NOT carry an `alloc`.
 */
const ALLOC_INSTR_KIND: Readonly<Record<string, AllocKind>> = {
  "object.new": "object",
  "closure.new": "closure",
  "refcell.new": "refcell",
  // class.new constructs an object via its <Class>_new ctor (black-box body).
  "class.new": "object",
  "extern.new": "extern",
  "extern.regex": "extern",
  "string.const": "string",
  "string.concat": "string",
  "vec.new_fixed": "array",
  box: "box",
  "iter.new": "iterator",
  "gen.epilogue": "generator",
};

/** True iff the env/debug flag enables the alloc-provenance walk. */
export function allocVerifyEnabled(): boolean {
  return process.env.IR_VERIFY_ALLOC === "1" || process.env.IR_VERIFY_ALLOC === "true";
}

/**
 * Walk every instr (including nested bodies of if / loops / for-of / try) and
 * check the two provenance invariants against `registry`.
 */
export function verifyAllocProvenance(func: IrFunction, registry: AllocSiteRegistry): AllocVerifyError[] {
  const errors: AllocVerifyError[] = [];

  const visit = (instr: IrInstr): void => {
    const expectedKind = ALLOC_INSTR_KIND[instr.kind];
    const alloc = instr.alloc;

    if (expectedKind !== undefined) {
      // Allocation site: must carry a live id of the matching kind.
      if (alloc === undefined) {
        errors.push({
          func: func.name,
          message: `allocation instr "${instr.kind}" is missing an AllocSiteId (provenance lost)`,
        });
      } else {
        checkId(func, registry, alloc, expectedKind, instr.kind, errors);
      }
    } else if (alloc !== undefined) {
      // Non-alloc instr should never carry an id; if it does, it must at least
      // be known + kind-consistent (defensive — flags accidental copying onto
      // a non-alloc instr).
      checkId(func, registry, alloc, undefined, instr.kind, errors);
    }

    for (const child of nestedInstrs(instr)) visit(child);
  };

  for (const block of func.blocks) {
    for (const instr of block.instrs) visit(instr);
  }

  return errors;
}

function checkId(
  func: IrFunction,
  registry: AllocSiteRegistry,
  alloc: AllocSiteId,
  expectedKind: AllocKind | undefined,
  instrKind: string,
  errors: AllocVerifyError[],
): void {
  if (!registry.isKnown(alloc)) {
    errors.push({
      func: func.name,
      message: `instr "${instrKind}" references unknown AllocSiteId ${alloc as number} (dangling)`,
    });
    return;
  }
  const site = registry.resolve(alloc);
  if (site === null) {
    errors.push({
      func: func.name,
      message: `live instr "${instrKind}" references retired/aliased-away AllocSiteId ${alloc as number} (stale provenance)`,
    });
    return;
  }
  if (expectedKind !== undefined && site.kind !== expectedKind) {
    errors.push({
      func: func.name,
      message: `instr "${instrKind}" has AllocSiteId ${alloc as number} of kind "${site.kind}", expected "${expectedKind}"`,
    });
  }
}

/**
 * Throwing wrapper for intermediate integration verify boundaries. No-op
 * unless the debug flag is on, so production does not repeat the walk after
 * every pass.
 */
export function assertAllocProvenance(func: IrFunction, registry: AllocSiteRegistry): void {
  if (!allocVerifyEnabled()) return;
  assertVerifiedAllocProvenance(func, registry);
}

/**
 * Required final-artifact gate. This deliberately ignores `IR_VERIFY_ALLOC`:
 * every artifact must pass once after all transforms and before publication or
 * lowering.
 */
export function assertFinalAllocProvenance(func: IrFunction, registry: AllocSiteRegistry): void {
  assertVerifiedAllocProvenance(func, registry);
}

function assertVerifiedAllocProvenance(func: IrFunction, registry: AllocSiteRegistry): void {
  const errors = verifyAllocProvenance(func, registry);
  if (errors.length > 0) {
    const lines = errors.map((e) => `  - [${e.func}] ${e.message}`).join("\n");
    throw new IrInvariantError(
      "allocation-provenance-failure",
      "verify",
      `IR alloc-provenance check failed (#1586):\n${lines}`,
      errors,
    );
  }
}

/**
 * Yield the nested instruction arrays carried by control-flow instrs (if arms,
 * while/for cond+body+update, for-of bodies, try/catch/finally). Generic over
 * the instr shape: any own property that is an array of instr-like objects, or
 * a nested object holding such an array (the `catchClause`), is descended into.
 * This stays correct as new control-flow instrs are added.
 */
function* nestedInstrs(instr: IrInstr): Iterable<IrInstr> {
  for (const value of Object.values(instr as unknown as Record<string, unknown>)) {
    yield* fromValue(value);
  }
}

function* fromValue(value: unknown): Iterable<IrInstr> {
  if (Array.isArray(value)) {
    for (const el of value) {
      if (isInstrLike(el)) yield el as IrInstr;
    }
  } else if (value !== null && typeof value === "object") {
    // e.g. catchClause: { payloadSlot, body: IrInstr[] }
    for (const inner of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(inner)) {
        for (const el of inner) {
          if (isInstrLike(el)) yield el as IrInstr;
        }
      }
    }
  }
}

function isInstrLike(v: unknown): boolean {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as { kind?: unknown }).kind === "string" &&
    "result" in (v as object)
  );
}
