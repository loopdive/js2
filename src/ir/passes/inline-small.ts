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
  type IrTerminator,
  type IrValueId,
} from "../nodes.js";
import type { AllocSiteRegistry } from "../alloc-registry.js";
import type { IrUnitId } from "../identity.js";
import { forkAllocInInstr } from "./alloc-discipline.js";

const MAX_CALLEE_INSTRS = 10;
const CALLER_SIZE_BUDGET_MULTIPLIER = 4;

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

  const newFunctions: IrFunction[] = [];
  let anyChanged = false;
  for (const fn of mod.functions) {
    const inlined = inlineIntoFunction(
      fn,
      byUnitId,
      recursiveSet,
      localUnitCallSiteCounts,
      externalCapabilityBoundaryUnits,
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
  registry?: AllocSiteRegistry,
): IrFunction {
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

  const newBlocks: IrBlock[] = [];
  for (const block of caller.blocks) {
    const newInstrs: IrInstr[] = [];
    let blockChanged = false;

    for (const instr of block.instrs) {
      // First, apply any accumulated renames to this instruction's operands.
      const rewritten = renameInstrOperands(instr, callerRename);
      if (rewritten !== instr) blockChanged = true;

      if (rewritten.kind !== "call") {
        newInstrs.push(rewritten);
        continue;
      }

      const binding = rewritten.target.binding;
      const callee = binding.kind === "unit" ? byUnitId.get(binding.unitId) : undefined;
      if (!callee || !canInline(callee, recursiveSet, localUnitCallSiteCounts, externalCapabilityBoundaryUnits)) {
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
      for (let i = 0; i < callee.params.length; i++) {
        calleeRename.set(callee.params[i]!.value, rewritten.args[i]!);
      }
      for (const inst of body.instrs) {
        if (inst.result !== null) {
          calleeRename.set(inst.result, asValueId(nextValueId++));
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
        const renamed = renameAllInInstr(inst, calleeRename);
        newInstrs.push(forkAllocInInstr(renamed, registry));
      }

      // The call's result becomes the renamed return value for all downstream
      // uses in this block and its terminator.
      const renamedReturn = calleeRename.get(returnValueId) ?? returnValueId;
      if (rewritten.result !== null) {
        callerRename.set(rewritten.result, renamedReturn);
      }

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
  };
}

// ---------------------------------------------------------------------------
// Inlinability check
// ---------------------------------------------------------------------------

function canInline(
  callee: IrFunction,
  recursiveSet: ReadonlySet<IrUnitId>,
  localUnitCallSiteCounts: ReadonlyMap<IrUnitId, number>,
  externalCapabilityBoundaryUnits: ReadonlySet<IrUnitId>,
): boolean {
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
  for (const inst of body.instrs) {
    if (inst.kind === "raw.wasm") return false;
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

function mapId(rename: ReadonlyMap<IrValueId, IrValueId>, v: IrValueId): IrValueId {
  return rename.get(v) ?? v;
}

/**
 * Rewrite operand IDs in an instruction. Does NOT touch `result` — reserved
 * for caller-scope renames (where we only redirect uses, not definitions).
 */
export function renameInstrOperands(inst: IrInstr, rename: ReadonlyMap<IrValueId, IrValueId>): IrInstr {
  if (rename.size === 0) return inst;
  switch (inst.kind) {
    case "const":
    case "global.get":
    case "raw.wasm":
      return inst;
    case "call":
    case "intrinsic": {
      let changed = false;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, args: newArgs };
    }
    case "global.set": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "binary": {
      const l = mapId(rename, inst.lhs);
      const r = mapId(rename, inst.rhs);
      if (l === inst.lhs && r === inst.rhs) return inst;
      return { ...inst, lhs: l, rhs: r };
    }
    case "unary": {
      const r = mapId(rename, inst.rand);
      if (r === inst.rand) return inst;
      return { ...inst, rand: r };
    }
    case "select": {
      const c = mapId(rename, inst.condition);
      const t = mapId(rename, inst.whenTrue);
      const f = mapId(rename, inst.whenFalse);
      if (c === inst.condition && t === inst.whenTrue && f === inst.whenFalse) return inst;
      return { ...inst, condition: c, whenTrue: t, whenFalse: f };
    }
    case "if": {
      // (#1392) Renames in the cond + carrier values; arm-buffer instrs
      // are walked recursively (each gets its own renameInstrOperands
      // call). Conservative — if any sub-instr changed, rebuild the if;
      // otherwise return unchanged.
      const c = mapId(rename, inst.cond);
      const t = mapId(rename, inst.thenValue);
      const e = mapId(rename, inst.elseValue);
      const newThen: IrInstr[] = [];
      const newElse: IrInstr[] = [];
      let armChanged = false;
      for (const sub of inst.then) {
        const r = renameInstrOperands(sub, rename);
        if (r !== sub) armChanged = true;
        newThen.push(r);
      }
      for (const sub of inst.else) {
        const r = renameInstrOperands(sub, rename);
        if (r !== sub) armChanged = true;
        newElse.push(r);
      }
      if (c === inst.cond && t === inst.thenValue && e === inst.elseValue && !armChanged) return inst;
      return { ...inst, cond: c, thenValue: t, elseValue: e, then: newThen, else: newElse };
    }
    case "box":
    case "unbox":
    case "tag.test":
    case "dyn.truthy":
    case "dyn.to_number": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "string.const":
      return inst;
    case "dyn.eq":
    case "string.concat":
    case "string.eq": {
      const l = mapId(rename, inst.lhs);
      const r = mapId(rename, inst.rhs);
      if (l === inst.lhs && r === inst.rhs) return inst;
      return { ...inst, lhs: l, rhs: r };
    }
    case "string.repeat": {
      const value = mapId(rename, inst.value);
      const count = mapId(rename, inst.count);
      if (value === inst.value && count === inst.count) return inst;
      return { ...inst, value, count };
    }
    case "dyn.member_get": {
      const recv = mapId(rename, inst.recv);
      const key = mapId(rename, inst.key);
      if (recv === inst.recv && key === inst.key) return inst;
      return { ...inst, recv, key };
    }
    case "dyn.member_set": {
      const recv = mapId(rename, inst.recv);
      const key = mapId(rename, inst.key);
      const value = mapId(rename, inst.value);
      if (recv === inst.recv && key === inst.key && value === inst.value) return inst;
      return { ...inst, recv, key, value };
    }
    case "string.len": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "string.char_at":
    case "string.char_code_at": {
      const value = mapId(rename, inst.value);
      const index = mapId(rename, inst.index);
      if (value === inst.value && index === inst.index) return inst;
      return { ...inst, value, index };
    }
    case "fnctor.new": {
      let changed = false;
      const captureArgs = inst.captureArgs.map((value) => {
        const next = mapId(rename, value);
        changed ||= next !== value;
        return next;
      });
      const args = inst.args.map((value) => {
        const next = mapId(rename, value);
        changed ||= next !== value;
        return next;
      });
      const constructorIdentity = inst.constructorIdentity === null ? null : mapId(rename, inst.constructorIdentity);
      changed ||= constructorIdentity !== inst.constructorIdentity;
      if (!changed) return inst;
      return { ...inst, captureArgs, args, constructorIdentity };
    }
    case "fnctor.get": {
      const value = mapId(rename, inst.value);
      if (value === inst.value) return inst;
      return { ...inst, value };
    }
    case "object.new": {
      let changed = false;
      const newValues: IrValueId[] = [];
      for (const a of inst.values) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newValues.push(n);
      }
      if (!changed) return inst;
      return { ...inst, values: newValues };
    }
    case "object.get": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "object.set": {
      const v = mapId(rename, inst.value);
      const nv = mapId(rename, inst.newValue);
      if (v === inst.value && nv === inst.newValue) return inst;
      return { ...inst, value: v, newValue: nv };
    }
    // Slice 3 (#1169c): closure / ref-cell ops.
    case "closure.new": {
      let changed = false;
      const newCaps: IrValueId[] = [];
      for (const c of inst.captures) {
        const n = mapId(rename, c);
        if (n !== c) changed = true;
        newCaps.push(n);
      }
      if (!changed) return inst;
      return { ...inst, captures: newCaps };
    }
    case "closure.cap": {
      const s = mapId(rename, inst.self);
      if (s === inst.self) return inst;
      return { ...inst, self: s };
    }
    case "closure.call": {
      const c = mapId(rename, inst.callee);
      let changed = c !== inst.callee;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, callee: c, args: newArgs };
    }
    case "refcell.new": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "refcell.get": {
      const c = mapId(rename, inst.cell);
      if (c === inst.cell) return inst;
      return { ...inst, cell: c };
    }
    case "refcell.set": {
      const c = mapId(rename, inst.cell);
      const v = mapId(rename, inst.value);
      if (c === inst.cell && v === inst.value) return inst;
      return { ...inst, cell: c, value: v };
    }
    // Slice 4 (#1169d): class ops.
    case "class.new": {
      let changed = false;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, args: newArgs };
    }
    case "class.get": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "class.set": {
      const v = mapId(rename, inst.value);
      const nv = mapId(rename, inst.newValue);
      if (v === inst.value && nv === inst.newValue) return inst;
      return { ...inst, value: v, newValue: nv };
    }
    case "class.call": {
      const r = mapId(rename, inst.receiver);
      let changed = r !== inst.receiver;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, receiver: r, args: newArgs };
    }
    case "class.super_init": {
      const s = mapId(rename, inst.self);
      let changed = s !== inst.self;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, self: s, args: newArgs };
    }
    case "class.super_call": {
      const r = mapId(rename, inst.receiver);
      let changed = r !== inst.receiver;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, receiver: r, args: newArgs };
    }
    // (#3144): class.instanceof / class.static_call operand renames.
    case "class.instanceof": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "class.static_call": {
      let changed = false;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, args: newArgs };
    }
    // Slice 6 (#1169e): slot / vec / for-of ops.
    case "slot.read":
      return inst;
    case "slot.write": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "vec.len": {
      const v = mapId(rename, inst.vec);
      if (v === inst.vec) return inst;
      return { ...inst, vec: v };
    }
    case "vec.get": {
      const v = mapId(rename, inst.vec);
      const idx = mapId(rename, inst.index);
      if (v === inst.vec && idx === inst.index) return inst;
      return { ...inst, vec: v, index: idx };
    }
    case "vec.set": {
      const v = mapId(rename, inst.vec);
      const idx = mapId(rename, inst.index);
      const newValue = mapId(rename, inst.newValue);
      if (v === inst.vec && idx === inst.index && newValue === inst.newValue) return inst;
      return { ...inst, vec: v, index: idx, newValue };
    }
    case "vec.set_length": {
      const vec = mapId(rename, inst.vec);
      const length = mapId(rename, inst.length);
      if (vec === inst.vec && length === inst.length) return inst;
      return { ...inst, vec, length };
    }
    case "vec.new_fixed": {
      // #1804 — rewrite each element operand (mirrors object.new).
      let changed = false;
      const newElements: IrValueId[] = [];
      for (const e of inst.elements) {
        const n = mapId(rename, e);
        if (n !== e) changed = true;
        newElements.push(n);
      }
      if (!changed) return inst;
      return { ...inst, elements: newElements };
    }
    case "forof.vec": {
      const v = mapId(rename, inst.vec);
      // Body instrs must also have their operands rewritten.
      let bodyChanged = v !== inst.vec;
      const newBody: IrInstr[] = [];
      for (const sub of inst.body) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) bodyChanged = true;
        newBody.push(renamed);
      }
      if (!bodyChanged) return inst;
      return { ...inst, vec: v, body: newBody };
    }
    // Slice 6 part 3 (#1182) — coercion + iterator protocol ops.
    case "coerce.to_externref": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "iter.new": {
      const v = mapId(rename, inst.iterable);
      if (v === inst.iterable) return inst;
      return { ...inst, iterable: v };
    }
    case "iter.next": {
      const v = mapId(rename, inst.iter);
      if (v === inst.iter) return inst;
      return { ...inst, iter: v };
    }
    case "iter.done":
    case "iter.value": {
      const v = mapId(rename, inst.resultObj);
      if (v === inst.resultObj) return inst;
      return { ...inst, resultObj: v };
    }
    case "iter.return": {
      const v = mapId(rename, inst.iter);
      if (v === inst.iter) return inst;
      return { ...inst, iter: v };
    }
    case "forof.iter": {
      const v = mapId(rename, inst.iterable);
      let bodyChanged = v !== inst.iterable;
      const newBody: IrInstr[] = [];
      for (const sub of inst.body) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) bodyChanged = true;
        newBody.push(renamed);
      }
      if (!bodyChanged) return inst;
      return { ...inst, iterable: v, body: newBody };
    }
    // Slice 7a (#1169f): generator ops.
    case "gen.push": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "gen.epilogue":
      // No operands to rewrite.
      return inst;
    // Slice 7b (#1169f): yield* delegation.
    case "gen.yieldStar": {
      const v = mapId(rename, inst.inner);
      if (v === inst.inner) return inst;
      return { ...inst, inner: v };
    }
    // #2951 — generator `return <value>` stash.
    case "gen.setReturn": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    // Slice 6 part 4 (#1183) — string for-of.
    case "forof.string": {
      const v = mapId(rename, inst.str);
      let bodyChanged = v !== inst.str;
      const newBody: IrInstr[] = [];
      for (const sub of inst.body) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) bodyChanged = true;
        newBody.push(renamed);
      }
      if (!bodyChanged) return inst;
      return { ...inst, str: v, body: newBody };
    }
    // Slice 9 (#1169h) — exception handling.
    case "throw": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "try": {
      let changed = false;
      const newBody: IrInstr[] = [];
      for (const sub of inst.body) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) changed = true;
        newBody.push(renamed);
      }
      let newCatch = inst.catchClause;
      if (inst.catchClause) {
        const newCatchBody: IrInstr[] = [];
        let catchBodyChanged = false;
        for (const sub of inst.catchClause.body) {
          const renamed = renameInstrOperands(sub, rename);
          if (renamed !== sub) catchBodyChanged = true;
          newCatchBody.push(renamed);
        }
        if (catchBodyChanged) {
          changed = true;
          newCatch = { payloadSlot: inst.catchClause.payloadSlot, body: newCatchBody };
        }
      }
      let newFinally = inst.finallyBody;
      if (inst.finallyBody) {
        const newFinBody: IrInstr[] = [];
        let finBodyChanged = false;
        for (const sub of inst.finallyBody) {
          const renamed = renameInstrOperands(sub, rename);
          if (renamed !== sub) finBodyChanged = true;
          newFinBody.push(renamed);
        }
        if (finBodyChanged) {
          changed = true;
          newFinally = newFinBody;
        }
      }
      if (!changed) return inst;
      return {
        ...inst,
        body: newBody,
        ...(newCatch ? { catchClause: newCatch } : {}),
        ...(newFinally ? { finallyBody: newFinally } : {}),
      };
    }
    // Slice 10 (#1169i): extern class ops.
    case "extern.new": {
      let changed = false;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, args: newArgs };
    }
    case "extern.call": {
      const recv = mapId(rename, inst.receiver);
      let changed = recv !== inst.receiver;
      const newArgs: IrValueId[] = [];
      for (const a of inst.args) {
        const n = mapId(rename, a);
        if (n !== a) changed = true;
        newArgs.push(n);
      }
      if (!changed) return inst;
      return { ...inst, receiver: recv, args: newArgs };
    }
    case "extern.prop": {
      const recv = mapId(rename, inst.receiver);
      if (recv === inst.receiver) return inst;
      return { ...inst, receiver: recv };
    }
    case "extern.propSet": {
      const recv = mapId(rename, inst.receiver);
      const v = mapId(rename, inst.value);
      if (recv === inst.receiver && v === inst.value) return inst;
      return { ...inst, receiver: recv, value: v };
    }
    case "extern.regex":
      return inst;
    // Slice 12 (#1280): while.loop / for.loop. The cond/body/update
    // buffers carry their own SSA values and are renamed via the
    // recursive walker in inline-small's body-buffer pass (mirrors
    // the forof.* handling above). Renaming the condValue keeps the
    // instr-level reference consistent.
    case "while.loop": {
      const cv = mapId(rename, inst.condValue);
      if (cv === inst.condValue) return inst;
      return { ...inst, condValue: cv };
    }
    // #2952 slice 2 — br.label carries no SSA operands (label is a control
    // identity, untouched by value renames).
    case "br.label":
      return inst;
    // #2952 slice 2 — if.stmt: rename the cond + recurse into both arm
    // buffers (same pattern as `try` above), so a caller-scope rename
    // reaches arm-interior uses of the redirected value.
    case "if.stmt": {
      const cv = mapId(rename, inst.cond);
      let changed = cv !== inst.cond;
      const newThen: IrInstr[] = [];
      for (const sub of inst.then) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) changed = true;
        newThen.push(renamed);
      }
      const newElse: IrInstr[] = [];
      for (const sub of inst.else) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) changed = true;
        newElse.push(renamed);
      }
      if (!changed) return inst;
      return { ...inst, cond: cv, then: newThen, else: newElse };
    }
    // #2952 slice 4 — labeled block / switch: honest deep rename of the
    // clause buffers (+ disc), mirroring the if.stmt pattern. (canInline
    // skips functions containing these, so this is defensive parity.)
    case "labeled.block": {
      let changed = false;
      const newBody: IrInstr[] = [];
      for (const sub of inst.body) {
        const renamed = renameInstrOperands(sub, rename);
        if (renamed !== sub) changed = true;
        newBody.push(renamed);
      }
      if (!changed) return inst;
      return { ...inst, body: newBody };
    }
    case "switch": {
      const dv = mapId(rename, inst.disc);
      let changed = dv !== inst.disc;
      const newBodies: IrInstr[][] = [];
      for (const body of inst.bodies) {
        const newBody: IrInstr[] = [];
        for (const sub of body) {
          const renamed = renameInstrOperands(sub, rename);
          if (renamed !== sub) changed = true;
          newBody.push(renamed);
        }
        newBodies.push(newBody);
      }
      if (!changed) return inst;
      return { ...inst, disc: dv, bodies: newBodies };
    }
    case "for.loop": {
      const cv = mapId(rename, inst.condValue);
      if (cv === inst.condValue) return inst;
      return { ...inst, condValue: cv };
    }
    // (#1373 Phase B) Async / await IR nodes — rename single operand.
    // Phase C may need richer renaming (continuation-closure capture
    // sets); for now the simple operand rename is sufficient.
    case "await": {
      const op = mapId(rename, inst.operand);
      if (op === inst.operand) return inst;
      return { ...inst, operand: op };
    }
    case "async.return": {
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    case "async.throw": {
      const r = mapId(rename, inst.reason);
      if (r === inst.reason) return inst;
      return { ...inst, reason: r };
    }
    // (#2856) Early return — rename the optional value. NB inlining a
    // function CONTAINING an early.return is unsound (the return would
    // exit the CALLER); the inline pass's eligibility check excludes the
    // kind in `canInline`.
    case "early.return": {
      if (inst.value === null) return inst;
      const v = mapId(rename, inst.value);
      if (v === inst.value) return inst;
      return { ...inst, value: v };
    }
    // (#4070) Exhaustiveness gate. The runtime arm throws rather than
    // returning `inst` unchanged: skipping the rename for an unknown kind
    // would splice callee-scope SSA ids into the caller, which is a silent
    // miscompile rather than a missed optimisation.
    default: {
      const _exhaustive: never = inst;
      void _exhaustive;
      // invariant (producer-promise): union/switch agreement, per #4035/#4502.
      throw new Error(
        `ir/inline-small: renameInstrOperands has no case for IR instruction kind ${(inst as { readonly kind: string }).kind}`,
      );
    }
  }
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
