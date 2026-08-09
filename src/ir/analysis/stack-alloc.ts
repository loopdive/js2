// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Demonstration consumer of the ownership analysis (#1587).
//
// The ownership pass is only worth keeping if a real consumer uses its output
// (ADR-0014, "one demonstration consumer" requirement). This is that consumer:
// it identifies allocations the analysis proved `owned` and never `escaped` —
// the precondition for stack-allocation / scalar-replacement of a small,
// short-lived object.
//
// IMPORTANT — Phase 1 is *annotation-only*. It does NOT rewrite the IR to
// actually stack-allocate; it records a candidacy marker on the registry under
// the ownership namespace (`stackCandidate: true`). The real lowering change is
// a follow-up that flips proven candidates to a stack/scalar representation.
// Keeping Phase 1 inert preserves the "removing the pass cannot change emitted
// Wasm" guarantee while giving a measurable signal (candidate count) that the
// analysis output is precise enough to build on.

import type { AllocSiteRegistry } from "../alloc-registry.js";
import { ALLOC_NAMESPACES } from "../alloc-registry.js";
import type { AllocKind, IrFunction } from "../nodes.js";
import { analyzeOwnership, type OwnershipResult } from "./ownership.js";

/** A value-creating instr the analysis proved safe to stack-allocate. */
export interface StackAllocCandidate {
  readonly allocId: number;
  readonly kind: AllocKind;
}

/** Allocation kinds small enough to be worth stack-allocating in Phase 1. */
const SMALL_ALLOC_KINDS: ReadonlySet<AllocKind> = new Set<AllocKind>(["object", "refcell", "box"]);

/**
 * Find stack-allocation candidates in `fn` using an ownership result (computed
 * fresh when not supplied). A candidate is an allocation that is:
 *   - of a "small" kind (object / refcell / box — not array/closure/string),
 *   - proven `owned`, and
 *   - never `escaped`.
 *
 * When `registry` is supplied, each candidate's site is marked with a
 * `stackCandidate: true` flag merged into its existing ownership annotation.
 * The marker is inert at lowering — it changes no emitted Wasm.
 */
export function findStackAllocCandidates(
  fn: IrFunction,
  registry?: AllocSiteRegistry,
  precomputed?: OwnershipResult,
): StackAllocCandidate[] {
  const result = precomputed ?? analyzeOwnership(fn, registry);
  const candidates: StackAllocCandidate[] = [];

  const visit = (instr: IrFunction["blocks"][number]["instrs"][number]): void => {
    if (instr.result !== null && instr.alloc !== undefined) {
      const kind = (instr as { kind: string }).kind;
      const allocKind = allocKindOfInstr(kind);
      if (allocKind !== null && SMALL_ALLOC_KINDS.has(allocKind) && result.isStackAllocatable(instr.result)) {
        const allocId = instr.alloc as unknown as number;
        candidates.push({ allocId, kind: allocKind });
        if (registry) {
          const prev = registry.read<Record<string, unknown>>(instr.alloc, ALLOC_NAMESPACES.ownership) ?? {};
          registry.annotate(instr.alloc, ALLOC_NAMESPACES.ownership, { ...prev, stackCandidate: true });
        }
      }
    }
    for (const sub of nestedInstrs(instr)) visit(sub);
  };

  for (const block of fn.blocks) {
    for (const instr of block.instrs) visit(instr);
  }
  return candidates;
}

/** Map a value-creating instr kind to its AllocKind, or null if not one. */
function allocKindOfInstr(kind: string): AllocKind | null {
  switch (kind) {
    case "object.new":
      return "object";
    case "refcell.new":
      return "refcell";
    case "box":
      return "box";
    case "closure.new":
      return "closure";
    case "string.const":
      return "string";
    case "class.new":
      return "object";
    default:
      return null;
  }
}

function* nestedInstrs(
  instr: IrFunction["blocks"][number]["instrs"][number],
): Iterable<IrFunction["blocks"][number]["instrs"][number]> {
  for (const value of Object.values(instr as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const el of value) if (isInstrLike(el)) yield el as never;
    } else if (value !== null && typeof value === "object") {
      for (const inner of Object.values(value as Record<string, unknown>)) {
        if (Array.isArray(inner)) {
          for (const el of inner) if (isInstrLike(el)) yield el as never;
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
