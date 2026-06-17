// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Shared allocation-site pass-discipline helpers (#1586).
//
// The three rules every pass must follow (see docs/adr/0013-ir-allocation-sites.md):
//   1. Preserve ids through value-preserving rewrites (copy `alloc` verbatim).
//   2. Alias ids through fusion (registry.alias).
//   3. Retire ids on deletion (registry.retire) — and on FOLD-AWAY.
//
// `retireAllocsIn` walks an instr (and its nested control-flow bodies) and
// retires every `alloc` id it carries. It is the workhorse for rule 3 — DCE
// drops instrs, CF folds them away. `forkAllocsIn` is the inline/monomorphize
// path: a statically-duplicated allocation is a genuinely distinct runtime
// allocation, so a clone gets a FRESH id (kind/type copied from the source
// site) rather than sharing the original's id.

import type { AllocSiteRegistry } from "../alloc-registry.js";
import { type AllocSiteId, type IrInstr, forEachNestedBuffer } from "../nodes.js";

/**
 * Inline/monomorphize path — a statically-duplicated allocation is a distinct
 * runtime allocation, so its clone gets a FRESH id (kind/type copied from the
 * source site). Returns `instr` unchanged when there is no registry or the
 * instr carries no `alloc`. Only the top-level `alloc` is forked here; nested
 * bodies are handled by recursing through the caller (inline never splices
 * body-bearing instrs — see canInline). For safety this also forks nested
 * allocs when present.
 */
export function forkAllocInInstr(instr: IrInstr, registry: AllocSiteRegistry | undefined): IrInstr {
  if (!registry) return instr;
  if (instr.alloc === undefined) return instr;
  const site = registry.resolve(instr.alloc);
  if (site === null) return instr; // retired/aliased — leave as-is, checker will flag if truly wrong
  const fresh = registry.fresh(site.kind, site.type, site.origin);
  return { ...instr, alloc: fresh };
}

/** Walk an instr + nested bodies, yielding every `alloc` id present. */
export function* allocIdsIn(instr: IrInstr): Iterable<AllocSiteId> {
  if (instr.alloc !== undefined) yield instr.alloc;
  // Descend through every nested buffer via the single shared authority
  // (#1922 — replaced a reflection-based walker that descended any
  // array-of-instr property).
  const children: IrInstr[] = [];
  forEachNestedBuffer(instr, (buffer) => {
    for (const sub of buffer) children.push(sub);
  });
  for (const child of children) yield* allocIdsIn(child);
}

/**
 * Rule 3 — retire every allocation id carried by `instr` (and nested bodies).
 * No-op when no registry is supplied (test builders never minted ids).
 */
export function retireAllocsIn(instr: IrInstr, registry: AllocSiteRegistry | undefined): void {
  if (!registry) return;
  for (const id of allocIdsIn(instr)) registry.retire(id);
}
