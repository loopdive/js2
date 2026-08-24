// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2134 — the IR effect model: ONE source of truth for "what does an
// instruction read/write/keep-alive", consumed by every pass that makes a
// decision based on effects:
//
//   - the emission scheduler (`lower.ts` anchor pass) — may a single-use def
//     be deferred to its use site, or must it anchor at def position?
//   - dead-code elimination (`passes/dead-code.ts`) — may an unused result's
//     instruction be dropped?
//   - the schedule verifier (#2134 slice 2, `verifyEmissionSchedule` below) —
//     did the scheduler's output preserve program order for conflicting ops?
//   - future consumers: the #2135 capability table and the #2856 selector
//     arms may consult effect facets; neither imports this file's consumers
//     (this stays a dependency-free `src/ir/` leaf, like `capability.ts`).
//
// Why this file exists (#2134): "what effects does instruction kind K have"
// used to be encoded twice with OPPOSITE failure polarities — the scheduler's
// `SchedFx` table (formerly private to lower.ts, #1982) defaults a new kind
// to a FULL BARRIER (safe: never re-orderable until classified), while DCE's
// `isSideEffecting` blocklist defaulted a new kind to "not side-effecting"
// (dangerous: silently droppable). Centralizing both here — next to each
// other, with a cross-table drift tripwire test (`tests/issue-2134.test.ts`)
// — makes the polarity gap visible and gives new instruction kinds ONE place
// to declare their effects. The TS `never` exhaustiveness check in
// `effectsOf` makes an unclassified new kind a compile error.
//
// Slots are Wasm locals of the current function: nothing but `slot.write`
// (and the loop headers that own dedicated slot indices) can modify them —
// calls cannot reach another function's locals, and mutable closure captures
// go through refcells. That keeps slot conflicts precise per index, which
// matters because `slot.read` is by far the most common deferred read.
//
// KNOWN DIVERGENCE (documented, not yet resolved — #2134 slice 3):
// `extern.regex` is DCE-kept (`isSideEffecting` → true: `RegExp_new` may
// throw on bad pattern syntax) but scheduler-PURE (`effectsOf` → no flags:
// re-ordering a fresh-allocation is treated as unobservable). A throw is an
// observable control effect, so the scheduler classification is arguably too
// permissive for a program that relies on the throw's position; changing it
// alters emission for regex-using functions and therefore needs its own
// equivalence-proven slice, not the slice-1 byte-identical move.

import type { IrInstr, IrValueId } from "./nodes.js";

/**
 * Per-instruction effect summary. (#1982 introduced this as `SchedFx`,
 * private to lower.ts; #2134 slice 1 moved it here verbatim and added the
 * `control` facet.)
 */
export interface IrEffects {
  /** Reads mutable heap state (struct fields, globals, vec elements, host objects). */
  readsHeap: boolean;
  /** Writes heap state or has arbitrary effects (calls, iterator advance, throw). */
  writesHeap: boolean;
  /**
   * Control effect — throw / await / async completion. Cannot be re-ordered
   * OR dropped. (#2134) Carried as its own facet: the scheduler already
   * treats these as full barriers via `readsHeap+writesHeap` (unchanged
   * behavior), but DCE and future consumers need "cannot drop" distinct
   * from "touches heap".
   */
  control: boolean;
  /** Touches statically-unknown slots (raw.wasm may local.set; gen.* use func-level slots). */
  allSlots: boolean;
  readSlots: Set<number>;
  writeSlots: Set<number>;
}

/**
 * Classify one instruction (recursing into nested buffers). Memoize with the
 * caller-provided cache — the scheduler calls this O(n²) per block.
 *
 * Classification groups (verbatim from the #1982 `schedFxOf`):
 *  - pure: constants, arithmetic, fresh allocation, immutable string ops;
 *  - heap reads: global/object/class/vec/refcell/closure-capture reads;
 *  - heap writes: global/object/class/refcell writes;
 *  - call-like full barrier: calls, extern ops, iterator protocol, throw,
 *    await/async (also `control: true` for throw/await/async.*);
 *  - slot-precise: slot.read / slot.write by index; loop headers write their
 *    pre-allocated state slots; gen.* / raw.wasm touch unknown slots.
 *
 * A NEW instruction kind is a TS compile error here (`never` check) and a
 * runtime full barrier until classified — it can never silently become
 * re-orderable (#2134's founding requirement).
 */
export function effectsOf(instr: IrInstr, cache: Map<IrInstr, IrEffects> = new Map()): IrEffects {
  const hit = cache.get(instr);
  if (hit) return hit;
  const fx: IrEffects = {
    readsHeap: false,
    writesHeap: false,
    control: false,
    allSlots: false,
    readSlots: new Set(),
    writeSlots: new Set(),
  };
  // Memoize BEFORE recursing — buffers cannot be cyclic, but this keeps the
  // walk linear in total instr count.
  cache.set(instr, fx);
  const mergeBuffer = (body: readonly IrInstr[]): void => {
    for (const sub of body) {
      const s = effectsOf(sub, cache);
      fx.readsHeap ||= s.readsHeap;
      fx.writesHeap ||= s.writesHeap;
      fx.control ||= s.control;
      fx.allSlots ||= s.allSlots;
      for (const x of s.readSlots) fx.readSlots.add(x);
      for (const x of s.writeSlots) fx.writeSlots.add(x);
    }
  };
  switch (instr.kind) {
    // Pure: constants, arithmetic, allocation of fresh objects, immutable
    // string content ops. Re-ordering these is unobservable.
    case "const":
    case "string.const":
    case "intrinsic":
    case "binary":
    case "unary":
    case "select":
    case "box":
    case "unbox":
    case "tag.test":
    case "dyn.truthy": // #2949 S5.1 — ToBoolean read on the carrier: pure (no heap/control effect)
    case "dyn.to_number": // #2949 S5.3 — ToNumber read on the carrier: pure (no heap/control effect)
    case "dyn.eq": // #2949 S5.2 — equality read over two carriers: pure (no heap/control effect)
    case "coerce.to_externref":
    case "string.concat":
    case "string.eq":
    case "string.len":
    case "string.char_at":
    case "string.char_code_at":
    case "object.new":
    case "vec.new_fixed": // #1804 — fresh vec allocation, pure (like object.new)
    case "refcell.new":
    case "closure.new":
    case "extern.regex": // NOTE: DCE-kept (may throw) — see KNOWN DIVERGENCE above.
      break;
    // Reads of mutable heap state.
    case "global.get":
    case "object.get":
    case "class.get":
    case "class.instanceof": // (#3144) reads the receiver's __tag struct field
    case "vec.get":
    case "vec.len":
    case "refcell.get":
    case "closure.cap":
    case "fnctor.get":
      fx.readsHeap = true;
      break;
    // Writes of heap state (void-result, so only ever hazards).
    case "global.set":
    case "object.set":
    case "class.set":
    case "refcell.set":
    case "vec.set":
    case "vec.set_length":
      fx.writesHeap = true;
      break;
    // Call-like: may read AND write arbitrary heap state. `extern.prop` can
    // trigger a host getter; iterator ops advance host iterator state.
    case "call":
    case "class.call":
    case "class.super_init": // #3000-E — runs parent `_init` (writes parent fields on self)
    case "class.super_call": // #3000-E — static-dispatched parent method (arbitrary heap effect)
    case "class.static_call": // (#3144) — static method body, arbitrary heap effect
    case "closure.call":
    case "extern.call":
    case "class.new":
    case "fnctor.new":
    case "extern.new":
    case "extern.prop":
    case "extern.propSet":
    // #3053 U1 — `__dyn_member_get` walks the proto chain and may fire a getter
    // (`__extern_get` runs accessors), so a dynamic member read is call-like:
    // it may read AND write arbitrary heap state. Conservative like extern.prop.
    case "dyn.member_get":
    // #3795 — strict dynamic [[Set]] may invoke accessors/proxy-like runtime
    // hooks and always mutates observable heap state.
    case "dyn.member_set":
    case "iter.new":
    case "iter.next":
    case "iter.done":
    case "iter.value":
    case "iter.return":
      fx.readsHeap = true;
      fx.writesHeap = true;
      break;
    // Control effects: throw is a control effect treated as a full heap
    // barrier; await / async completions suspend/complete observably.
    // #2952 slice 2 — br.label is a pure control transfer (no heap access),
    // but like throw it must never be re-ordered across OR dropped, and
    // `effectsConflict` only consults the heap/slot facets, so it carries
    // the same full-barrier classification.
    case "throw":
    case "string.repeat":
    case "br.label":
    case "await":
    case "async.return":
    case "async.throw":
      fx.readsHeap = true;
      fx.writesHeap = true;
      fx.control = true;
      break;
    // Generator ops read/write the function-level buffer/pendingThrow slots
    // (slot indices live on IrFunction, not on the instr) plus the heap.
    case "gen.push":
    case "gen.epilogue":
    case "gen.yieldStar":
    case "gen.setReturn":
      fx.readsHeap = true;
      fx.writesHeap = true;
      fx.allSlots = true;
      break;
    // Raw embedded Wasm may contain arbitrary ops including local.set.
    case "raw.wasm":
      fx.readsHeap = true;
      fx.writesHeap = true;
      fx.allSlots = true;
      break;
    case "slot.read":
      fx.readSlots.add(instr.slotIndex);
      break;
    case "slot.write":
      fx.writeSlots.add(instr.slotIndex);
      break;
    // Loop headers write their pre-allocated state slots every iteration;
    // body/cond/update effects merge in recursively.
    case "forof.vec":
      fx.readsHeap = true;
      for (const s of [instr.counterSlot, instr.lengthSlot, instr.vecSlot, instr.dataSlot, instr.elementSlot]) {
        fx.writeSlots.add(s);
      }
      mergeBuffer(instr.body);
      break;
    case "forof.iter":
      fx.readsHeap = true;
      fx.writesHeap = true; // iterator protocol host calls
      for (const s of [instr.iterSlot, instr.resultSlot, instr.elementSlot]) fx.writeSlots.add(s);
      mergeBuffer(instr.body);
      break;
    case "forof.string":
      fx.readsHeap = true;
      for (const s of [instr.counterSlot, instr.lengthSlot, instr.strSlot, instr.elementSlot]) {
        fx.writeSlots.add(s);
      }
      mergeBuffer(instr.body);
      break;
    case "while.loop":
      mergeBuffer(instr.cond);
      mergeBuffer(instr.body);
      break;
    case "for.loop":
      mergeBuffer(instr.cond);
      mergeBuffer(instr.body);
      mergeBuffer(instr.update);
      break;
    case "try":
      mergeBuffer(instr.body);
      if (instr.catchClause) mergeBuffer(instr.catchClause.body);
      if (instr.finallyBody) mergeBuffer(instr.finallyBody);
      break;
    case "if":
      mergeBuffer(instr.then);
      mergeBuffer(instr.else);
      break;
    // #2952 slice 2 — statement-level if: effects are the union of both
    // arm buffers (cond is a plain SSA use, surfaced via directUses).
    case "if.stmt":
      mergeBuffer(instr.then);
      mergeBuffer(instr.else);
      break;
    // #2952 slice 4 — labeled block / switch: union of clause buffers
    // (disc is a plain SSA use, surfaced via directUses).
    case "labeled.block":
      mergeBuffer(instr.body);
      break;
    case "switch":
      for (const body of instr.bodies) mergeBuffer(body);
      break;
    // (#2856) Early return is a control effect (like throw): never
    // reordered, CSE'd, or dropped — treat as a full barrier.
    case "early.return":
      fx.readsHeap = true;
      fx.writesHeap = true;
      fx.control = true;
      break;
    default: {
      // Future instruction kinds default to a full barrier so a new kind can
      // never silently become re-orderable.
      const _exhaustive: never = instr;
      void _exhaustive;
      fx.readsHeap = true;
      fx.writesHeap = true;
      fx.control = true;
      fx.allSlots = true;
      break;
    }
  }
  return fx;
}

/** No observable effects at all — freely re-orderable and droppable. */
export function effectsArePure(fx: IrEffects): boolean {
  return (
    !fx.readsHeap &&
    !fx.writesHeap &&
    !fx.control &&
    !fx.allSlots &&
    fx.readSlots.size === 0 &&
    fx.writeSlots.size === 0
  );
}

/** May re-ordering `a` across `b` change observable behavior? */
export function effectsConflict(a: IrEffects, b: IrEffects): boolean {
  if (a.writesHeap && (b.readsHeap || b.writesHeap)) return true;
  if (b.writesHeap && a.readsHeap) return true;
  const aTouchesSlots = a.allSlots || a.readSlots.size > 0 || a.writeSlots.size > 0;
  const bTouchesSlots = b.allSlots || b.readSlots.size > 0 || b.writeSlots.size > 0;
  if (a.allSlots && bTouchesSlots) return true;
  if (b.allSlots && aTouchesSlots) return true;
  for (const s of a.writeSlots) {
    if (b.readSlots.has(s) || b.writeSlots.has(s)) return true;
  }
  for (const s of b.writeSlots) {
    if (a.readSlots.has(s)) return true;
  }
  return false;
}

// ── #2134 slice 2 — emission-schedule verification ──────────────────────────

/** One program-order violation found in a computed emission schedule. */
export interface EmissionScheduleViolation {
  /** Program-order index of the instruction that was moved. */
  readonly defIndex: number;
  /** Program-order index of the conflicting instruction it crossed. */
  readonly pastIndex: number;
  readonly reason: string;
}

/**
 * Independent post-hoc check of the scheduler's output (#2134 acceptance
 * criterion 2). The anchor pass in `lower.ts` DECIDES which single-use defs
 * may defer to their use site; this function RE-DERIVES legality from first
 * principles — pairwise over the emitted effectful instructions, not a re-run
 * of the anchor loop — so a bug in the pass cannot hide itself:
 *
 *   For every pair `i < k` (program order) of emitted instructions whose
 *   effects conflict, `i` must execute no later than `k`. Execution point is
 *   `emissionIdx[]`; an equal index means both execute within one lazy tree,
 *   which is legal only when `k`'s tree transitively consumes `i`'s result
 *   (operands execute before their consumer; `i` can never consume `k` —
 *   SSA def-before-use).
 *
 * `emissionIdx[i] === Infinity` marks a never-emitted instruction (dead pure
 * value, or a read consumed only by dead chains) — it executes nowhere and
 * constrains nothing. `usesOf` is injected by the caller so this leaf module
 * mirrors the scheduler's exact operand-surface semantics (`collectIrUses`)
 * without importing `lower.ts`.
 */
export function verifyEmissionSchedule(
  instrs: readonly IrInstr[],
  emissionIdx: readonly number[],
  isLazyAt: readonly boolean[],
  usesOf: (instr: IrInstr) => readonly IrValueId[],
  cache: Map<IrInstr, IrEffects> = new Map(),
): EmissionScheduleViolation[] {
  const out: EmissionScheduleViolation[] = [];
  const n = instrs.length;

  // Only emitted, non-pure instructions participate — a pure effect summary
  // conflicts with nothing (`effectsConflict` is false against it).
  const effectful: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(emissionIdx[i])) continue; // never emitted
    if (!effectsArePure(effectsOf(instrs[i], cache))) effectful.push(i);
  }
  if (effectful.length < 2) return out;

  const defIdxOf = new Map<IrValueId, number>();
  instrs.forEach((instr, i) => {
    if (instr.result !== null) defIdxOf.set(instr.result, i);
  });
  /** Does the lazy tree rooted at `k` transitively consume `target`? */
  const treeConsumes = (k: number, target: IrValueId): boolean => {
    const seen = new Set<number>();
    const stack = [k];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const u of usesOf(instrs[cur])) {
        if (u === target) return true;
        const d = defIdxOf.get(u);
        if (d !== undefined && isLazyAt[d]) stack.push(d);
      }
    }
    return false;
  };

  for (let a = 0; a < effectful.length; a++) {
    for (let b = a + 1; b < effectful.length; b++) {
      const i = effectful[a]!;
      const k = effectful[b]!;
      const fi = effectsOf(instrs[i]!, cache);
      const fk = effectsOf(instrs[k]!, cache);
      if (!effectsConflict(fi, fk)) continue;
      const ei = emissionIdx[i]!;
      const ek = emissionIdx[k]!;
      if (ei < ek) continue; // program order preserved
      if (ei === ek) {
        const r = instrs[i]!.result;
        if (r !== null && treeConsumes(k, r)) continue; // operand-before-consumer inside one tree
        out.push({
          defIndex: i,
          pastIndex: k,
          reason:
            `conflicting ${instrs[i]!.kind}@${i} and ${instrs[k]!.kind}@${k} emitted in the same ` +
            `tree (idx ${ei}) without consumption ordering`,
        });
        continue;
      }
      out.push({
        defIndex: i,
        pastIndex: k,
        reason: `deferred ${instrs[i]!.kind}@${i} (emits at ${ei}) crosses conflicting ${instrs[k]!.kind}@${k} (emits at ${ek})`,
      });
    }
  }
  return out;
}

/**
 * DCE facet: side-effecting instructions are always kept regardless of use
 * count. (#2134 slice 1: moved VERBATIM from `passes/dead-code.ts` — an
 * explicit hand-audited list, deliberately NOT derived from `effectsOf` yet.
 * Today's list carries policy quirks (e.g. `slot.read` is always-keep for the
 * for-of body's load/use pattern; a dead `object.get` whose read could trap
 * IS droppable) whose honest table-derivation needs per-quirk equivalence
 * proofs — #2134 slice 3.)
 *
 * - `raw.wasm` — opaque Wasm ops with unknown effects (spec #1167a mandates
 *    this stays live).
 * - `call` — conservatively treated as having side effects. Purity analysis
 *    is a later pass.
 * - `global.set` — writes observable state.
 */
export function isSideEffecting(i: IrInstr): boolean {
  return (
    i.kind === "raw.wasm" ||
    i.kind === "call" ||
    i.kind === "global.set" ||
    // Slice 3 (#1169c): closure.call may invoke a body with arbitrary
    // effects (mutates ref cells, sets globals, calls other functions).
    // Conservatively keep it live regardless of result use count.
    i.kind === "closure.call" ||
    // refcell.set writes observable state through the cell ref.
    // refcell.new is pure (allocates a fresh struct), so leave it
    // out — DCE may strip it when its result is dead.
    i.kind === "refcell.set" ||
    // object.set mutates the struct (slice 2 didn't add this, but is
    // currently void-result so the existing `result === null → keep`
    // catches it; explicit listing is a no-op for now).
    i.kind === "object.set" ||
    // Slice 4 (#1169d): class.call invokes a method body with potentially
    // arbitrary effects. class.set mutates the instance. class.new calls
    // a constructor (which may run side-effecting user code, e.g.
    // `this.x = computeAndLogX()`). Conservatively keep all three live.
    i.kind === "class.call" ||
    i.kind === "class.set" ||
    i.kind === "class.new" ||
    i.kind === "fnctor.new" ||
    // #3000-E: super(...) runs the parent `_init` (writes parent fields on self);
    // super.method() invokes the parent method body — both arbitrary effects, and
    // super_init is void-result so DCE MUST keep it (and its operands) live via
    // this predicate, not the `result === null` path (which keeps the instr but
    // does NOT seed its operand uses — that dropped `super(<const>)`'s arg, #3000-E).
    i.kind === "class.super_init" ||
    i.kind === "class.super_call" ||
    // (#3144): a static method call runs an arbitrary user body; keep live.
    i.kind === "class.static_call" ||
    // Slice 6 (#1169e): slot.write and forof.vec are statement-level
    // side effects — the loop's body executes for every element.
    // slot.read is pure (load a Wasm local) but always-keep to avoid
    // breaking the for-of body's load/use pattern.
    i.kind === "slot.write" ||
    // #3795: strict dynamic [[Set]] is void-result but its three carrier
    // operands must seed DCE liveness. The generic null-result keep rule
    // preserves only the instruction itself, not the definitions it uses.
    i.kind === "dyn.member_set" ||
    i.kind === "forof.vec" ||
    // Slice 6 part 3 (#1182): host-iterator protocol ops mutate iterator
    // state (advance pointer, dispose). DCE must not eliminate them
    // even when their results are unused — a `iter.next` whose value is
    // dropped still has the side effect of advancing the iterator.
    // forof.iter is statement-level (result: null) and is kept by the
    // generic null-result rule, but the explicit listing makes the
    // intent obvious.
    i.kind === "iter.new" ||
    i.kind === "iter.next" ||
    i.kind === "iter.return" ||
    i.kind === "forof.iter" ||
    // Slice 7a (#1169f): gen.push pushes a value onto the eager
    // generator buffer (observable through __gen_next). gen.epilogue
    // calls __create_generator with the buffer and is materially
    // referenced as the function's return value — but DCE's
    // propagation only flows through `result`-bearing instrs, so
    // explicitly pinning here is the simplest correctness rule.
    // Without this, DCE would consider gen.push's `value` operand
    // dead and strip the const that produces it, leaving a stale
    // SSA reference that the verifier rejects.
    i.kind === "gen.push" ||
    i.kind === "gen.epilogue" ||
    // Slice 7b (#1169f): gen.yieldStar drains every value from the
    // inner iterable onto the buffer — observable through __gen_next
    // downstream. Pin for the same reason as gen.push: the operand
    // (`inner`) must stay live, but DCE's propagation only flows
    // through `result`-bearing instrs.
    i.kind === "gen.yieldStar" ||
    // #2951: gen.setReturn stashes the generator's terminal return value on
    // the buffer (observable through the terminal `{value, done:true}`).
    // Pin for the same reason as gen.push: its `value` operand must stay
    // live even though the instr is result-less.
    i.kind === "gen.setReturn" ||
    // Slice 6 part 4 (#1183): forof.string is statement-level (result:
    // null) so the generic null-result rule already keeps it; explicit
    // listing for clarity.
    i.kind === "forof.string" ||
    // Slice 9 (#1169h): throw / try are statement-level side effects
    // (control flow). DCE must always preserve them.
    i.kind === "throw" ||
    i.kind === "try" ||
    // Slice 12 (#1280): while.loop / for.loop are statement-level control
    // flow (result: null). They must always run AND their cond/body/update
    // buffers must be use-walked so a value referenced only inside the loop
    // stays live. They are seeded here (not merely kept by the null-result
    // rule) so `collectUses(_, { deep: true })` runs over their buffers.
    // (#1922 — fixes the ordinary `while (i < limit)` IR demotion.)
    i.kind === "while.loop" ||
    i.kind === "for.loop" ||
    // #2952 slice 2 — br.label is a control transfer (must always run);
    // if.stmt is statement-level control flow whose arm buffers must be
    // use-walked so values referenced only inside an arm stay live (same
    // rationale as while.loop / for.loop above).
    i.kind === "br.label" ||
    i.kind === "if.stmt" ||
    // #2952 slice 4 — labeled.block / switch are statement-level control
    // flow whose clause buffers must be use-walked (same as if.stmt).
    i.kind === "labeled.block" ||
    i.kind === "switch" ||
    // Slice 10 (#1169i): extern class ops invoke host imports with
    // arbitrary side effects. Conservatively keep all five live so DCE
    // never strips a `RegExp_new` or `Uint8Array_set` whose result is
    // unused but whose execution is observable.
    i.kind === "extern.new" ||
    i.kind === "extern.call" ||
    i.kind === "extern.propSet" ||
    // extern.prop is a getter call — most are pure but some (Date.now,
    // Map.size after concurrent mutation) reflect external state. Keep
    // conservatively until a purity analysis distinguishes them.
    i.kind === "extern.prop" ||
    // extern.regex calls RegExp_new which is morally pure (allocates
    // a fresh value), but it may throw on bad pattern syntax — keep
    // the side-effect of the throw observable to user code.
    i.kind === "extern.regex" ||
    // `String.prototype.repeat` validates ToIntegerOrInfinity and may throw
    // for negative/+Infinity counts. Keep an unused result and anchor it as a
    // full control barrier until separately verified non-throwing evidence
    // exists on the instruction.
    i.kind === "string.repeat" ||
    // (#1373 Phase B) Async / await IR nodes are control-flow with
    // observable suspension / Promise side effects. DCE must always
    // preserve them. Phase C lowering (CPS transform) does not change
    // this — even unused-result awaits need to suspend.
    i.kind === "await" ||
    i.kind === "async.return" ||
    i.kind === "async.throw" ||
    // (#2856) early.return is a control transfer — never droppable.
    // (if.stmt is already seeded above with br.label, #2952 s2.)
    i.kind === "early.return"
  );
}
