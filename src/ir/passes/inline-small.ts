// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// IR-to-IR inlining of small, non-recursive, single-block callees — spec #1167b.
//
// First slice of Phase 3b. This pass runs after the Phase 3a hygiene pipeline
// (CF → DCE → simplifyCFG) and before lowering to Wasm. It expands small
// callee bodies into the caller's blocks, avoiding a `call` instruction at
// lowering time.
//
// ## Scope (v1): single-block callees only
//
// A callee is inlinable iff ALL of:
//
//   - `callee.blocks.length === 1` — multi-block inlining (multiple `return`
//     terminators requiring continuation-block splicing + CFG rewrites) is
//     deferred to a follow-up. Two-return shapes like
//       if (x < 0) return -x;
//       return x;
//     fall out of this slice.
//   - Sole block's terminator is `return <value>` (exactly one value).
//   - Callee is non-recursive (not part of any SCC, including self-loops).
//   - Callee body ≤ N instructions (N = 10 by default).
//   - Callee body contains no `raw.wasm` — its `ops` may reference
//     function-local Wasm indices (local.get, etc.) which would be invalid
//     in a different caller's local frame. Plain SSA ops (const, binary,
//     select, ...) are safe to splice.
//   - A callee that crosses an external capability boundary (`extern.*` or a
//     direct import call) has at most one local call site. Duplicating such a
//     body at multiple sites grows every host-bound coercion/call sequence;
//     keeping the shared helper preserves that boundary. Single-site helpers
//     remain eligible, so this is a fan-out guard rather than a blanket ban on
//     external operations.
//
// ## Algorithm
//
// For each caller function, walk block instrs. For each `call` to an
// inlinable callee:
//
//   1. Allocate a fresh IrValueId for every value the callee's block
//      defines (instruction results). Parameters map directly to the
//      caller's call-site argument values.
//   2. Splice the callee's instructions into the caller's block at the
//      call-site position, with operands + results rewritten through the
//      rename map.
//   3. Replace the caller's use of the call's result with the renamed
//      callee-return value: set `callerRename[callSite.result] = renamedReturn`
//      and apply the map to every subsequent instruction and the terminator.
//
// A single pass over each block handles any number of inlined calls because
// `callerRename` accumulates mappings as we go; later uses are rewritten
// transparently.
//
// ## Size budget
//
// To avoid runaway code growth, a single caller will not grow beyond
// `max(4× original, original + 2× MAX_CALLEE_INSTRS)` instructions across
// all inline decisions. The floor lets a trivially-small caller (e.g. a
// one-instr thunk `return abs(n);`) absorb one or two small callees that
// would otherwise be blocked by the strict multiplicative bound.
//
// ## Post-conditions
//
// - `verifyIrFunction` returns zero errors on every modified function.
// - `valueCount` reflects the new high-water mark (old count + freshly
//   allocated inlined-value ids).
// - `blocks.length` is unchanged (we only splice into existing blocks;
//   single-block callees produce no new blocks).
//
// The caller (`integration.ts`) re-runs `constantFold` + `deadCode` on every
// modified function afterwards so the inlined constants / unused args get
// cleaned up before lowering.

import {
  asValueId,
  forEachInstrDeep,
  forEachNestedBuffer,
  type IrBlock,
  type IrBranch,
  type IrFunction,
  type IrInstr,
  type IrModule,
  type IrSiteId,
  type IrSlotDef,
  type IrTerminator,
  type IrValueId,
} from "../nodes.js";
import type { IrType } from "../core/types.js";
import type { AllocSiteRegistry } from "../alloc-registry.js";
import type { IrUnitId } from "../identity.js";
import { forkAllocInInstr, retireAllocsIn } from "./alloc-discipline.js";
import { renameInstrOperands } from "./rename-operands.js";
export { renameInstrOperands } from "./rename-operands.js";

/** Preserve truthful source frames only where the removed call supplies one. */
function inlineSourceSite(
  site: IrSiteId | undefined,
  callSite: IrSiteId | undefined,
  ownerUnitId: IrUnitId,
): IrSiteId | undefined {
  const origin = site?.origin;
  if (!origin) return site;
  if (origin.kind === "source") {
    const callOrigin = callSite?.origin;
    if (callOrigin?.kind !== "source") return site;
    return {
      ...site,
      line: site.line!,
      column: site.column!,
      origin: {
        ...origin,
        inlinedAt: [...(origin.inlinedAt ?? []), callOrigin.point, ...(callOrigin.inlinedAt ?? [])],
      },
    };
  }
  return "ownerUnitId" in origin ? { origin: { ...origin, ownerUnitId } } : site;
}

/** Fresh inline allocations share the copied instruction's enriched site. */
function forkInlineAllocation(instr: IrInstr, registry: AllocSiteRegistry | undefined): IrInstr {
  if (!instr.site?.origin || !registry || instr.alloc === undefined) return forkAllocInInstr(instr, registry);
  const allocation = registry.resolve(instr.alloc);
  if (allocation === null) return instr;
  return {
    ...instr,
    alloc: registry.fresh(allocation.kind, allocation.type, instr.site),
  };
}

/** Transport DATA follows only the actual SSA substitutions performed here. */
function inlineClassArgumentTransport(
  original: IrInstr,
  rewritten: IrInstr,
  rename: ReadonlyMap<IrValueId, IrValueId>,
  types: ReadonlyMap<IrValueId, IrType>,
): IrInstr {
  if (original.kind !== "js.class.invoke" || rewritten.kind !== "js.class.invoke") return rewritten;
  let changed = false;
  const params = rewritten.signature.params.map((expected, index) => {
    if (!rename.has(original.args[index]!)) return expected;
    const actual = types.get(rewritten.args[index]!);
    if (
      !actual ||
      actual.kind !== "dynamic" ||
      expected.kind !== "dynamic" ||
      (expected.tag !== undefined && actual.tag !== expected.tag)
    )
      throw new Error("inlineSmall: class argument substitution contradicts its logical transport");
    if (actual.tag === expected.tag) return expected;
    changed = true;
    return actual;
  });
  return changed ? { ...rewritten, signature: { ...rewritten.signature, params } } : rewritten;
}

const MAX_CALLEE_INSTRS = 10;
const CALLER_SIZE_BUDGET_MULTIPLIER = 4;

function hasCountedStringAppendProvenance(fn: IrFunction): boolean {
  const buffers = [
    ...fn.blocks.map((block) => block.instrs),
    ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ...(fn.asyncRuntime?.states.map((state) => state.body) ?? []),
  ];
  for (const buffer of buffers) {
    for (const instr of buffer) {
      let found = false;
      forEachInstrDeep(instr, (nested) => {
        found ||= nested.kind === "string.repeat" && nested.countedStringAppendSite !== undefined;
      });
      if (found) return true;
    }
  }
  return false;
}

/**
 * Inline small, non-recursive, single-block callees across the module.
 * Returns the same `IrModule` reference when no function changes.
 */
export function inlineSmall(mod: IrModule, registry?: AllocSiteRegistry): IrModule {
  const byUnitId = new Map<IrUnitId, IrFunction>();
  for (const fn of mod.functions) {
    if (byUnitId.has(fn.unitId)) {
      throw new Error(`inlineSmall: duplicate IR function unit '${fn.unitId}'`);
    }
    byUnitId.set(fn.unitId, fn);
  }

  const recursiveSet = computeRecursiveSet(mod, byUnitId);
  const localUnitCallSiteCounts = computeLocalUnitCallSiteCounts(mod, byUnitId);
  const externalCapabilityBoundaryUnits = computeExternalCapabilityBoundaryUnits(mod);
  const provenanceBearingUnitIds = new Set(
    mod.functions.filter(hasCountedStringAppendProvenance).map((fn) => fn.unitId),
  );

  const newFunctions: IrFunction[] = [];
  let anyChanged = false;
  for (const fn of mod.functions) {
    const inlined = inlineIntoFunction(
      fn,
      byUnitId,
      recursiveSet,
      localUnitCallSiteCounts,
      externalCapabilityBoundaryUnits,
      provenanceBearingUnitIds,
      registry,
    );
    if (inlined !== fn) anyChanged = true;
    newFunctions.push(inlined);
  }
  if (!anyChanged) return mod;
  return { functions: newFunctions };
}

// ---------------------------------------------------------------------------
// Per-function inlining
// ---------------------------------------------------------------------------

function inlineIntoFunction(
  caller: IrFunction,
  byUnitId: ReadonlyMap<IrUnitId, IrFunction>,
  recursiveSet: ReadonlySet<IrUnitId>,
  localUnitCallSiteCounts: ReadonlyMap<IrUnitId, number>,
  externalCapabilityBoundaryUnits: ReadonlySet<IrUnitId>,
  provenanceBearingUnitIds: ReadonlySet<IrUnitId>,
  registry?: AllocSiteRegistry,
): IrFunction {
  // Moving a provenance-bearing repeat across terminal owners requires an
  // explicit ownership-transfer receipt. Until that exists, inline neither
  // from nor into such a function.
  if (provenanceBearingUnitIds.has(caller.unitId)) return caller;
  // Nested instruction buffers have their own def/use walk and can retain
  // caller values defined outside the buffer. `callerRename` is intentionally
  // flat; applying it only to an instruction's direct operands leaves those
  // nested uses stale, while applying it blindly inside every buffer risks
  // rewriting a buffer-local id that happens to share a test-built namespace.
  // Keep such callers on ordinary symbolic calls until the IR has an explicit
  // scoped rename primitive. The shared exhaustive buffer authority makes this
  // barrier cover for/while, if, try, and for-of together. It runs before any
  // fresh ids or allocation forks, so a rejected caller is byte-for-byte
  // unchanged. Body-bearing callees are already rejected by `canInline`.
  for (const block of caller.blocks) {
    for (const instr of block.instrs) {
      let hasNestedBuffer = false;
      forEachNestedBuffer(instr, () => {
        hasNestedBuffer = true;
      });
      if (hasNestedBuffer) return caller;
    }
  }

  const originalSize = countInstrs(caller);
  let nextValueId = caller.valueCount;
  // #6921 — the caller's slot table grows by one fresh copy of the callee's
  // slots per inlined site (see `appendCalleeSlots`). Appending is
  // index-stable: lowering maps slot N to local `params + ssaLocals + N`.
  const callerSlots: IrSlotDef[] = [...(caller.slots ?? [])];
  let currentSize = originalSize;
  let anyFuncChange = false;

  // callerRename collects rewrites that apply to caller-scope SSA ids
  // produced by inlined calls. Each time we inline a call, we add:
  //   callSite.result  →  renamedReturn (callee's return value post-rename)
  // so every later instruction / terminator uses the inlined value
  // transparently.
  //
  // #3213 — this MUST be function-scoped, not per-block. An inlined call's
  // result can be a CROSS-BLOCK value: `const b = pred(n); if (…) …; use b`
  // defines `b` in the entry block but uses it in the then-block and the
  // continuation. When `callerRename` was reset per block, those downstream
  // uses of `b` were never repointed to the inlined return id, leaving `b`
  // undefined → `verifyIrFunction` reported "use of SSA value before def" and
  // demoted the whole function (an IR-first hard error). Blocks are visited in
  // definition/dominance order (from-ast emits reducible, forward-only CFGs —
  // loops are declarative instrs, not br_if back-edges), so a call's rename is
  // always recorded before the blocks that consume it are processed; SSA ids
  // are globally unique, so a rename only ever repoints its own def's uses.
  const callerRename = new Map<IrValueId, IrValueId>();
  const actualTypes = new Map<IrValueId, IrType>(caller.params.map((parameter) => [parameter.value, parameter.type]));
  for (const block of caller.blocks) {
    for (const [index, value] of block.blockArgs.entries()) {
      const type = block.blockArgTypes[index];
      if (type) actualTypes.set(value, type);
    }
    for (const instruction of block.instrs)
      if (instruction.result !== null && instruction.resultType)
        actualTypes.set(instruction.result, instruction.resultType);
  }

  const newBlocks: IrBlock[] = [];
  for (const block of caller.blocks) {
    const newInstrs: IrInstr[] = [];
    let blockChanged = false;

    for (const instr of block.instrs) {
      // First, apply any accumulated renames to this instruction's operands.
      const rewritten = inlineClassArgumentTransport(
        instr,
        renameInstrOperands(instr, callerRename),
        callerRename,
        actualTypes,
      );
      if (rewritten !== instr) blockChanged = true;

      if (rewritten.kind !== "call") {
        newInstrs.push(rewritten);
        continue;
      }

      const binding = rewritten.target.binding;
      const callee = binding.kind === "unit" ? byUnitId.get(binding.unitId) : undefined;
      if (
        !callee ||
        !canInline(
          callee,
          recursiveSet,
          localUnitCallSiteCounts,
          externalCapabilityBoundaryUnits,
          provenanceBearingUnitIds,
        )
      ) {
        newInstrs.push(rewritten);
        continue;
      }

      const body = callee.blocks[0]!;
      const calleeSize = body.instrs.length;
      const budget = Math.max(CALLER_SIZE_BUDGET_MULTIPLIER * originalSize, originalSize + 2 * MAX_CALLEE_INSTRS);
      if (currentSize + calleeSize > budget) {
        newInstrs.push(rewritten);
        continue;
      }

      // Return terminator shape — already guarded by `canInline`, but assert
      // locally so TypeScript narrows and we catch invariants slipping.
      const term = body.terminator;
      if (term.kind !== "return" || term.values.length !== 1) {
        newInstrs.push(rewritten);
        continue;
      }
      const returnValueId = term.values[0]!;

      // Build the callee-scope rename: params first (to call-site args),
      // then every instr result gets a fresh caller-scope id.
      const calleeRename = new Map<IrValueId, IrValueId>();
      if (rewritten.args.length !== callee.params.length) {
        // Arity mismatch would be a bug upstream — bail out safely rather
        // than emit malformed IR.
        newInstrs.push(rewritten);
        continue;
      }
      // #6921 — callee slot ops address the CALLEE's slot table. Give this
      // site its own fresh copy of those slots (after every other bailout,
      // so a rejected site leaves the table untouched).
      const slotOffset = appendCalleeSlots(callee, callerSlots);
      if (slotOffset === null) {
        newInstrs.push(rewritten);
        continue;
      }
      for (let i = 0; i < callee.params.length; i++) {
        calleeRename.set(callee.params[i]!.value, rewritten.args[i]!);
      }
      for (const inst of body.instrs) {
        if (inst.result !== null) {
          const fresh = asValueId(nextValueId++);
          calleeRename.set(inst.result, fresh);
          if (inst.resultType) actualTypes.set(fresh, inst.resultType);
        }
      }

      // Splice callee body into caller (renamed). `canInline` rejects
      // body-bearing instrs (forof.*, try, while.loop, for.loop), so we
      // never need to recurse into nested body buffers here — see
      // canInline's #1374 comment.
      for (const inst of body.instrs) {
        // Rule 1 / fork: a spliced copy is a genuinely distinct runtime
        // allocation, so fork a fresh AllocSiteId off the callee's site rather
        // than sharing it (inlining the same callee twice must not conflate
        // the two allocations — #747 escape analysis depends on this).
        const renamed = inlineClassArgumentTransport(
          inst,
          offsetSlotIndex(renameAllInInstr(inst, calleeRename), slotOffset),
          calleeRename,
          actualTypes,
        );
        const site = inlineSourceSite(renamed.site, rewritten.site, caller.unitId);
        const located = site === renamed.site ? renamed : { ...renamed, site };
        newInstrs.push(forkInlineAllocation(located, registry));
      }

      // The call's result becomes the renamed return value for all downstream
      // uses in this block and its terminator.
      const renamedReturn = calleeRename.get(returnValueId) ?? returnValueId;
      if (rewritten.result !== null) {
        callerRename.set(rewritten.result, renamedReturn);
      }

      // The removed call has its own analysis site, separate from the fresh
      // callee allocations. Retire it only after every inline bailout passed.
      retireAllocsIn(rewritten, registry);

      currentSize += calleeSize;
      blockChanged = true;
      anyFuncChange = true;
    }

    const newTerm = renameTerminatorOperands(block.terminator, callerRename);
    if (newTerm !== block.terminator) blockChanged = true;

    if (!blockChanged) {
      newBlocks.push(block);
    } else {
      newBlocks.push({
        id: block.id,
        blockArgs: block.blockArgs,
        blockArgTypes: block.blockArgTypes,
        instrs: newInstrs,
        terminator: newTerm,
      });
    }
  }

  if (!anyFuncChange) return caller;
  return {
    ...caller,
    blocks: newBlocks,
    valueCount: nextValueId,
    ...(callerSlots.length > 0 ? { slots: callerSlots } : {}),
  };
}

/**
 * #6921 — append one fresh copy of `callee.slots` to `callerSlots` and return
 * the offset to add to every spliced slot index, or `null` when the callee's
 * slot table is not dense (`index === position`, which
 * `IrFunctionBuilder.declareSlot` guarantees) — the site then stays a call and
 * nothing is appended. Each inlined copy gets its own slots, mirroring the
 * fresh SSA ids: two inlined copies must never share mutable state, and
 * without the remap the callee's slot 0 aliased the caller's slot 0.
 */
function appendCalleeSlots(callee: IrFunction, callerSlots: IrSlotDef[]): number | null {
  const defs = callee.slots ?? [];
  if (defs.some((def, i) => def.index !== i)) return null;
  const offset = callerSlots.length;
  for (const def of defs) {
    callerSlots.push({
      index: offset + def.index,
      name: `${callee.name}$${def.name}`,
      type: def.type,
    });
  }
  return offset;
}

/**
 * #6921 — shift a spliced instruction's slot reference into the caller's
 * table. Only top-level `slot.read` / `slot.write` can reference a callee
 * slot here: `canInline` rejects every buffer-bearing kind and every other
 * slot-indexed kind. The buffer assertion keeps a future `canInline`
 * relaxation from silently reintroducing unremapped nested slot uses.
 */
function offsetSlotIndex(inst: IrInstr, offset: number): IrInstr {
  forEachNestedBuffer(inst, () => {
    throw new Error(`inlineSmall: cannot remap slots inside nested buffer of '${inst.kind}'`);
  });
  if (offset === 0) return inst;
  if (inst.kind === "slot.read" || inst.kind === "slot.write") {
    return { ...inst, slotIndex: inst.slotIndex + offset };
  }
  return inst;
}

// ---------------------------------------------------------------------------
// Inlinability check
// ---------------------------------------------------------------------------

function canInline(
  callee: IrFunction,
  recursiveSet: ReadonlySet<IrUnitId>,
  localUnitCallSiteCounts: ReadonlyMap<IrUnitId, number>,
  externalCapabilityBoundaryUnits: ReadonlySet<IrUnitId>,
  provenanceBearingUnitIds: ReadonlySet<IrUnitId>,
): boolean {
  if (provenanceBearingUnitIds.has(callee.unitId)) return false;
  if (callee.blocks.length !== 1) return false;
  if (recursiveSet.has(callee.unitId)) return false;
  // Preserve a shared host/capability boundary when duplicating it would fan
  // out across multiple local call sites. This is deliberately keyed by exact
  // unit identity and exact structural import bindings: compatibility labels
  // neither create nor erase the boundary. Single-site helpers still inline.
  if ((localUnitCallSiteCounts.get(callee.unitId) ?? 0) > 1 && externalCapabilityBoundaryUnits.has(callee.unitId)) {
    return false;
  }
  const body = callee.blocks[0]!;
  if (body.instrs.length > MAX_CALLEE_INSTRS) return false;
  const term = body.terminator;
  if (term.kind !== "return") return false;
  if (term.values.length !== 1) return false;
  // #1374 — body-bearing instrs (forof.*, try, while.loop, for.loop) carry
  // their own SSA def-spaces inside nested body buffers AND reference slot
  // indices declared on the callee's `IrFunction.slots`. Splicing such a
  // callee body into a caller without a deep SSA rename + slot migration
  // would either leave duplicate SSA defs (caught later by `lower.ts`'s
  // `registerInstrDefs` walk), produce stale local-index references that
  // fail Wasm validation, or — when both happen at once — cause `lower.ts`
  // emitter to infinite-recurse on a circular operand→result reference.
  // Skip these conservatively. The caller still goes through IR; it just
  // emits a regular `call` instr to the standalone callee. Lifting this
  // restriction would require migrating callee slots into the caller and
  // rewriting nested body-buffer SSA — out of scope for this slice.
  // raw.wasm carries function-local backend indices that don't survive a
  // change of enclosing function — conservative skip in the same spirit.
  // #6921 — callee slots are remapped into the caller, which serves only
  // top-level `slot.read` / `slot.write`. The pass does not transfer a
  // captured environment or a suspension protocol, so callees carrying one
  // are rejected outright (guards composed from #5387 / PR 5748), including a
  // `PreparedIrFunction.asyncRuntime` backend attachment.
  if (
    callee.generatorBufferSlot !== undefined ||
    callee.closureSubtype !== undefined ||
    callee.asyncPlan !== undefined ||
    callee.asyncRuntime !== undefined ||
    (callee.funcKind ?? "regular") !== "regular"
  ) {
    return false;
  }
  for (const inst of body.instrs) {
    if (inst.kind === "raw.wasm" || inst.kind === "closure.cap") return false;
    if (inst.kind.startsWith("gen.")) return false;
    if (
      inst.kind === "forof.vec" ||
      inst.kind === "forof.iter" ||
      inst.kind === "forof.string" ||
      inst.kind === "try" ||
      inst.kind === "while.loop" ||
      inst.kind === "for.loop" ||
      // (#2856) The value-producing `if` (#1392) carries then/else arm
      // buffers with their OWN SSA defs, which `renameAllInInstr` does not
      // deep-rename — splicing one into a caller produced duplicate SSA
      // defs (post-inline verify failure → silent legacy demote). It was
      // missed when #1392 added the kind; latent until #2856's call-arg
      // ref→ref_null widening made single-block callees with bounds-checked
      // vec reads (emitSafeVecGet emits an `if`) actually inlinable.
      inst.kind === "if" ||
      // #2952 slice 2 — if.stmt carries nested body buffers (same deep-SSA
      // concern as the loop kinds above); br.label references a loop label
      // scoped to the callee (and is verifier-invalid at a block's top
      // level anyway). Both skip conservatively.
      inst.kind === "if.stmt" ||
      inst.kind === "br.label" ||
      // #2952 slice 4 — labeled.block / switch carry nested body buffers
      // + callee-scoped labels; skip conservatively like if.stmt.
      inst.kind === "labeled.block" ||
      inst.kind === "switch" ||
      // (#2856) early.return lowers to a Wasm `return` — spliced into a
      // caller it would return from the CALLER, not simulate the callee's
      // return, so it is never inlinable.
      inst.kind === "early.return"
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// External-boundary fan-out analysis
// ---------------------------------------------------------------------------

/**
 * Count every exact call to a locally-visible unit, including calls nested in
 * declarative instruction buffers. The count describes the input module, not
 * only callers that this pass can currently rewrite: a nested or otherwise
 * non-inlinable site still makes duplicating the same external boundary at a
 * different site a multi-site expansion.
 */
function computeLocalUnitCallSiteCounts(
  mod: IrModule,
  byUnitId: ReadonlyMap<IrUnitId, IrFunction>,
): Map<IrUnitId, number> {
  const counts = new Map<IrUnitId, number>();
  for (const fn of mod.functions) {
    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        forEachInstrDeep(instr, (nested) => {
          if (
            nested.kind !== "call" ||
            nested.target.binding.kind !== "unit" ||
            !byUnitId.has(nested.target.binding.unitId)
          ) {
            return;
          }
          const unitId = nested.target.binding.unitId;
          counts.set(unitId, (counts.get(unitId) ?? 0) + 1);
        });
      }
    }
  }
  return counts;
}

/** Exact units whose bodies contain an external capability boundary. */
function computeExternalCapabilityBoundaryUnits(mod: IrModule): Set<IrUnitId> {
  const units = new Set<IrUnitId>();
  for (const fn of mod.functions) {
    let found = false;
    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        forEachInstrDeep(instr, (nested) => {
          if (isExternalCapabilityBoundary(nested)) found = true;
        });
        if (found) break;
      }
      if (found) break;
    }
    if (found) units.add(fn.unitId);
  }
  return units;
}

function isExternalCapabilityBoundary(instr: IrInstr): boolean {
  if (instr.kind.startsWith("extern.")) return true;
  return instr.kind === "call" && instr.target.binding.kind === "import";
}

// ---------------------------------------------------------------------------
// Recursion detection (transitive closure over the local call graph)
// ---------------------------------------------------------------------------

/**
 * Return the set of function identities that are part of any call cycle
 * (including direct self-recursion) within the IR module. Only exact unit
 * bindings to locally-visible callees count — imports and providers do not
 * enter the graph even when their compatibility label matches a local unit.
 */
function computeRecursiveSet(mod: IrModule, byUnitId: ReadonlyMap<IrUnitId, IrFunction>): Set<IrUnitId> {
  const edges = new Map<IrUnitId, Set<IrUnitId>>();
  for (const fn of mod.functions) {
    const set = new Set<IrUnitId>();
    for (const block of fn.blocks) {
      for (const instr of block.instrs) {
        if (
          instr.kind === "call" &&
          instr.target.binding.kind === "unit" &&
          byUnitId.has(instr.target.binding.unitId)
        ) {
          set.add(instr.target.binding.unitId);
        }
      }
    }
    edges.set(fn.unitId, set);
  }
  const recursive = new Set<IrUnitId>();
  for (const fn of mod.functions) {
    if (reachesSelf(fn.unitId, edges)) recursive.add(fn.unitId);
  }
  return recursive;
}

function reachesSelf(start: IrUnitId, edges: ReadonlyMap<IrUnitId, ReadonlySet<IrUnitId>>): boolean {
  const visited = new Set<IrUnitId>();
  const stack: IrUnitId[] = [];
  const seed = edges.get(start);
  if (seed) for (const n of seed) stack.push(n);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === start) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const next = edges.get(cur);
    if (next) for (const n of next) stack.push(n);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Value-id remapping helpers
// ---------------------------------------------------------------------------

function countInstrs(fn: IrFunction): number {
  let n = 0;
  for (const b of fn.blocks) n += b.instrs.length;
  return n;
}

/** Native JS operands only; canonical descriptor identities and source provenance are not SSA values. */
function mapId(rename: ReadonlyMap<IrValueId, IrValueId>, v: IrValueId): IrValueId {
  return rename.get(v) ?? v;
}

/**
 * Rewrite operands AND result through `rename`. Used when splicing a callee
 * instruction into the caller — every callee-scope id (including results)
 * must be mapped to a caller-scope id.
 */
function renameAllInInstr(inst: IrInstr, rename: ReadonlyMap<IrValueId, IrValueId>): IrInstr {
  const operandsRenamed = renameInstrOperands(inst, rename);
  if (operandsRenamed.result === null) return operandsRenamed;
  const newResult = rename.get(operandsRenamed.result) ?? operandsRenamed.result;
  if (newResult === operandsRenamed.result) return operandsRenamed;
  return { ...operandsRenamed, result: newResult };
}

function renameTerminatorOperands(t: IrTerminator, rename: ReadonlyMap<IrValueId, IrValueId>): IrTerminator {
  if (rename.size === 0) return t;
  switch (t.kind) {
    case "return": {
      let changed = false;
      const vals: IrValueId[] = [];
      for (const v of t.values) {
        const n = mapId(rename, v);
        if (n !== v) changed = true;
        vals.push(n);
      }
      if (!changed) return t;
      return { ...t, values: vals };
    }
    case "br": {
      const b = renameBranchOperands(t.branch, rename);
      if (b === t.branch) return t;
      return { ...t, branch: b };
    }
    case "br_if": {
      const c = mapId(rename, t.condition);
      const tt = renameBranchOperands(t.ifTrue, rename);
      const ff = renameBranchOperands(t.ifFalse, rename);
      if (c === t.condition && tt === t.ifTrue && ff === t.ifFalse) return t;
      return { ...t, condition: c, ifTrue: tt, ifFalse: ff };
    }
    case "unreachable":
      return t;
  }
}

function renameBranchOperands(br: IrBranch, rename: ReadonlyMap<IrValueId, IrValueId>): IrBranch {
  let changed = false;
  const args: IrValueId[] = [];
  for (const a of br.args) {
    const n = mapId(rename, a);
    if (n !== a) changed = true;
    args.push(n);
  }
  if (!changed) return br;
  return { target: br.target, args };
}
