// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Intra-procedural ownership + access-semantics analysis (#1587, Phase 1).
//
// A flow-sensitive, intra-procedural, may-escape analysis. For each IR
// function it infers, per value:
//   - an ownership state (owned / borrowed / shared / escaped), and
//   - an access set (read / write / mutate / identity / escape).
//
// The result is *inference*, not rejection (ADR-0014). A value the analysis
// cannot reason about gets the conservative TOP element of each lattice. The
// pass is purely an optimization aid: it writes annotations to the
// `AllocSiteRegistry` ownership namespace (for allocated values) and to a
// parallel `ValueAnnot` map (for parameters / captures / non-allocated values),
// and NEVER mutates the IR. Removing the pass cannot change observable Wasm.
//
// Phase 1 is intra-procedural: unknown callees are treated as fully escaping.
// Inter-procedural summaries are Phase 2 (a follow-up issue).
//
// Algorithm — monotone worklist over the control-flow graph:
//   1. Seed: every allocation (`alloc`-carrying instr result) starts at
//      `owned` / `{}`. Every imported reference (param, block-arg, global read,
//      closure capture) starts at `shared` / `{ read }`.
//   2. Transfer: per block, walk instrs in order applying each op's effect to
//      its operands' state (widening only — joins are monotone increases).
//   3. Join: block entry states join the exit states of all predecessors;
//      block-args join the corresponding branch args.
//   4. Fixpoint: iterate the worklist until no block's entry state changes.
//
// Because every transfer either leaves a value's state unchanged or moves it
// strictly UP the (finite-height) lattice, the analysis is monotone and
// terminates.

import type { AllocSiteRegistry } from "../alloc-registry.js";
import { ALLOC_NAMESPACES } from "../alloc-registry.js";
import type { IrBlock, IrBlockId, IrFunction, IrInstr, IrTerminator, IrValueId } from "../nodes.js";
import {
  AccessSet,
  joinAnnotations,
  type AccessOp,
  type OwnershipAnnotation,
  type Ownership,
  annotationsEqual,
  topAnnotation,
} from "./lattice.js";

/**
 * The analysis result for one function. `of` returns the inferred annotation
 * for any value; values the analysis never saw resolve to the conservative
 * TOP, so consumers always get a correctness-preserving answer.
 */
export class OwnershipResult {
  constructor(
    private readonly annots: ReadonlyMap<IrValueId, OwnershipAnnotation>,
    /** Value -> the alloc id of the instr that defined it, when allocated. */
    private readonly allocOf: ReadonlyMap<IrValueId, number>,
  ) {}

  /** Inferred annotation for `value` — TOP if the value was never classified. */
  of(value: IrValueId): OwnershipAnnotation {
    return this.annots.get(value) ?? topAnnotation();
  }

  ownershipOf(value: IrValueId): Ownership {
    return this.of(value).ownership;
  }

  accessOf(value: IrValueId): AccessSet {
    return this.of(value).access;
  }

  /** True iff `value` is a heap allocation proven `owned` and never `escaped`. */
  isStackAllocatable(value: IrValueId): boolean {
    if (!this.allocOf.has(value)) return false;
    const { ownership, access } = this.of(value);
    return ownership === "owned" && !access.has("escape");
  }

  /** All classified values — for diagnostics / tests. */
  entries(): Iterable<[IrValueId, OwnershipAnnotation]> {
    return this.annots.entries();
  }
}

/**
 * Run the analysis on `fn`. When `registry` is supplied, the result for each
 * allocated value is also written under the `ownership` namespace keyed by the
 * defining instr's alloc id (the durable cross-pass channel). The returned
 * `OwnershipResult` is the in-function view keyed by `IrValueId`.
 */
export function analyzeOwnership(fn: IrFunction, registry?: AllocSiteRegistry): OwnershipResult {
  const blocks = fn.blocks;
  if (blocks.length === 0) {
    return new OwnershipResult(new Map(), new Map());
  }

  // value -> defining instr's alloc id, for the registry write-back + the
  // stack-allocatable query. Only allocation results appear here.
  const allocOf = new Map<IrValueId, number>();
  collectAllocs(fn, allocOf);
  const aliases = collectAliases(fn);

  const blockIndex = new Map<IrBlockId, number>();
  blocks.forEach((b, i) => blockIndex.set(b.id, i));

  // Seed the entry block's params/globals/captures as `shared`/{read}.
  // Allocations are seeded lazily in the transfer (they start at BOTTOM).
  const entryState: State = new Map();
  for (const p of fn.params) {
    entryState.set(p.value, { ownership: "shared", access: AccessSet.of("read") });
  }

  const blockEntry: State[] = blocks.map(() => new Map());
  blockEntry[0] = cloneState(entryState);

  // Worklist of block indices to (re)process.
  const worklist: number[] = [];
  const inWorklist = new Set<number>();
  const enqueue = (i: number): void => {
    if (!inWorklist.has(i)) {
      inWorklist.add(i);
      worklist.push(i);
    }
  };
  enqueue(0);

  // Per-block exit states, recomputed each visit.
  const blockExit: State[] = blocks.map(() => new Map());

  const MAX_VISITS = blocks.length * 8 + 64; // generous monotone-convergence guard
  let visits = 0;

  while (worklist.length > 0) {
    if (++visits > MAX_VISITS) break; // monotone lattice guarantees fixpoint; guard is defensive
    const bi = worklist.shift()!;
    inWorklist.delete(bi);
    const block = blocks[bi]!;

    const state = cloneState(blockEntry[bi]!);
    runBlock(block, state, allocOf, aliases.derived);
    blockExit[bi] = state;

    // Propagate to successors: join exit state into their entry, and join the
    // branch args into the successor's block-args.
    for (const succ of successors(block.terminator)) {
      const sIdx = blockIndex.get(succ.target);
      if (sIdx === undefined) continue;
      let changed = joinInto(blockEntry[sIdx]!, state);

      // Block-args: the j-th arg flows into the successor's j-th block-arg.
      const succBlock = blocks[sIdx]!;
      for (let j = 0; j < succ.args.length && j < succBlock.blockArgs.length; j++) {
        const argVal = succ.args[j]!;
        const paramVal = succBlock.blockArgs[j]!;
        const argAnnot = state.get(argVal) ?? bottomFor(argVal, allocOf);
        if (mergeValue(blockEntry[sIdx]!, paramVal, argAnnot)) changed = true;
      }
      if (changed) enqueue(sIdx);
    }
  }

  // Final per-value annotations: the join of every block's exit state (a value
  // may be classified differently along different paths; the meet-over-paths
  // result is the join of all of them).
  const finalAnnots = new Map<IrValueId, OwnershipAnnotation>();
  for (const exit of blockExit) {
    for (const [v, a] of exit) {
      const prev = finalAnnots.get(v);
      finalAnnots.set(v, prev ? joinAnnotations(prev, a) : a);
    }
  }
  // Params/captures that never appeared in any exit state still carry their seed.
  for (const [v, a] of entryState) {
    if (!finalAnnots.has(v)) finalAnnots.set(v, a);
  }
  propagateAliasAnnotations(finalAnnots, aliases, allocOf);

  // Write-back to the registry ownership namespace for allocated values.
  if (registry) {
    for (const [value, allocId] of allocOf) {
      const annot = finalAnnots.get(value) ?? { ownership: "owned", access: AccessSet.empty() };
      registry.annotate(allocId as never, ALLOC_NAMESPACES.ownership, {
        state: annot.ownership,
        ops: annot.access.toArray(),
      });
    }
  }

  return new OwnershipResult(finalAnnots, allocOf);
}

// ---------------------------------------------------------------------------
// Transfer function
// ---------------------------------------------------------------------------

/** Run one block's instrs over `state`, mutating it in place (widening only). */
function runBlock(
  block: IrBlock,
  state: State,
  allocOf: Map<IrValueId, number>,
  aliasDerived: ReadonlySet<IrValueId>,
): void {
  for (const instr of block.instrs) {
    // An allocation result is seeded at BOTTOM (owned / {}) when first seen.
    if (instr.result !== null && instr.alloc !== undefined && !state.has(instr.result)) {
      state.set(instr.result, { ownership: "owned", access: AccessSet.empty() });
    }
    applyInstrEffect(instr, state, allocOf, aliasDerived);
  }
  applyTerminatorEffect(block.terminator, state, allocOf);
}

type State = Map<IrValueId, OwnershipAnnotation>;

/** Widen `value`'s ownership to at least `o` and add access op `op` (if any). */
function touch(
  state: State,
  value: IrValueId,
  allocOf: Map<IrValueId, number>,
  o: Ownership | null,
  op: AccessOp | null,
): void {
  const cur = state.get(value) ?? bottomFor(value, allocOf);
  let { ownership, access } = cur;
  if (o !== null) ownership = joinAnnotations({ ownership, access }, { ownership: o, access }).ownership;
  if (op !== null) access = access.with(op);
  state.set(value, { ownership, access });
}

/** Mark `value` escaped — widens ownership to `escaped` and adds `escape`. */
function markEscaped(state: State, value: IrValueId, allocOf: Map<IrValueId, number>): void {
  touch(state, value, allocOf, "escaped", "escape");
}

function applyInstrEffect(
  instr: IrInstr,
  state: State,
  allocOf: Map<IrValueId, number>,
  aliasDerived: ReadonlySet<IrValueId>,
): void {
  if (instr.result !== null && aliasDerived.has(instr.result) && !state.has(instr.result)) {
    state.set(instr.result, { ownership: "owned", access: AccessSet.empty() });
  }
  switch (instr.kind) {
    // --- field reads -> `read` on the receiver -------------------------------
    case "object.get":
    case "class.get":
    case "class.instanceof": // (#3144) tag read on the receiver
      touch(state, instr.value, allocOf, null, "read");
      break;
    case "refcell.get":
      touch(state, instr.cell, allocOf, null, "read");
      break;
    case "vec.get":
      touch(state, instr.vec, allocOf, null, "read");
      break;
    case "vec.len":
      touch(state, instr.vec, allocOf, null, "read");
      break;
    case "string.len":
      touch(state, instr.value, allocOf, null, "read");
      break;

    // --- field writes -> `write` on the receiver; value may escape into it ---
    case "object.set":
      touch(state, instr.value, allocOf, null, "write");
      markEscaped(state, instr.newValue, allocOf); // stored into a heap-reachable field
      break;
    case "class.set":
      touch(state, instr.value, allocOf, null, "write");
      markEscaped(state, instr.newValue, allocOf);
      break;
    case "refcell.set":
      // A ref cell is the canonical escape channel for a mutable capture.
      touch(state, instr.cell, allocOf, null, "write");
      markEscaped(state, instr.value, allocOf);
      break;
    case "vec.set":
      touch(state, instr.vec, allocOf, null, "write");
      markEscaped(state, instr.newValue, allocOf);
      break;
    case "global.set":
      markEscaped(state, instr.value, allocOf);
      break;

    // --- read-modify-write -> `mutate` ---------------------------------------
    // (no dedicated RMW instr in Phase-1 IR; reserved for when one lands.)

    // --- identity (===) on references ----------------------------------------
    case "binary":
      if (instr.op === "i32.eq" || instr.op === "i32.ne") {
        touch(state, instr.lhs, allocOf, null, "identity");
        touch(state, instr.rhs, allocOf, null, "identity");
      }
      break;
    case "string.eq":
      touch(state, instr.lhs, allocOf, null, "read");
      touch(state, instr.rhs, allocOf, null, "read");
      break;

    // --- opaque calls -> every ref arg escapes with full access --------------
    case "call":
      for (const a of instr.args) markEscaped(state, a, allocOf);
      break;
    case "class.call":
      markEscaped(state, instr.receiver, allocOf);
      for (const a of instr.args) markEscaped(state, a, allocOf);
      break;
    // #3000-E: super(...) / super.method() reach into an opaque parent function;
    // `self`/receiver + args escape with full access, same as class.call.
    case "class.super_init":
      markEscaped(state, instr.self, allocOf);
      for (const a of instr.args) markEscaped(state, a, allocOf);
      break;
    case "class.super_call":
      markEscaped(state, instr.receiver, allocOf);
      for (const a of instr.args) markEscaped(state, a, allocOf);
      break;
    // (#3144): static method call — opaque body, every ref arg escapes.
    case "class.static_call":
      for (const a of instr.args) markEscaped(state, a, allocOf);
      break;
    case "closure.call":
      markEscaped(state, instr.callee, allocOf);
      for (const a of instr.args) markEscaped(state, a, allocOf);
      break;
    case "extern.call":
    case "extern.new":
    case "extern.prop":
    case "extern.propSet":
      // Extern ops cross into host code — everything they touch escapes.
      for (const v of operandsOf(instr)) markEscaped(state, v, allocOf);
      break;

    // --- captures: a closure stores its captured values (they escape) --------
    case "closure.new":
      for (const cap of instr.captures) markEscaped(state, cap, allocOf);
      break;

    // --- iterators / coercions reach into opaque host iterator protocol ------
    case "iter.new":
      markEscaped(state, instr.iterable, allocOf);
      break;
    case "coerce.to_externref":
      markEscaped(state, instr.value, allocOf);
      break;

    // --- async: awaited / returned / thrown values escape the frame ----------
    case "await":
      markEscaped(state, instr.operand, allocOf);
      break;
    case "async.return":
      markEscaped(state, instr.value, allocOf);
      break;
    case "async.throw":
      markEscaped(state, instr.reason, allocOf);
      break;
    case "throw":
      markEscaped(state, (instr as { value: IrValueId }).value, allocOf);
      break;

    // Control-flow-bearing instrs carry nested bodies; recurse into them so
    // effects inside arms / loop bodies are observed. The nested instrs
    // reference the same function-level SSA values, so a shared `state` is
    // correct for an intra-procedural may-escape result.
    case "if":
      for (const sub of instr.then) applyInstrEffect(sub, state, allocOf, aliasDerived);
      for (const sub of instr.else) applyInstrEffect(sub, state, allocOf, aliasDerived);
      break;
    case "forof.vec":
    case "forof.iter":
    case "forof.string":
      for (const sub of (instr as { body: readonly IrInstr[] }).body)
        applyInstrEffect(sub, state, allocOf, aliasDerived);
      break;
    case "while.loop":
    case "for.loop":
    case "try":
      for (const sub of nestedInstrArrays(instr)) applyInstrEffect(sub, state, allocOf, aliasDerived);
      break;

    default:
      // Pure / structural instrs (const, select, box, unbox, tag.test,
      // string.const, string.concat, slot.read/write, global.get, unary,
      // closure.cap, gen.*, raw.wasm, …) impose no ownership effect on their
      // operands in Phase 1.
      break;
  }
}

function applyTerminatorEffect(term: IrTerminator, state: State, allocOf: Map<IrValueId, number>): void {
  if (term.kind === "return") {
    for (const v of term.values) markEscaped(state, v, allocOf);
  }
  // br / br_if / unreachable carry no escaping effect; branch args flow into
  // successor block-args via the caller's join (they do not escape).
}

// ---------------------------------------------------------------------------
// CFG + helpers
// ---------------------------------------------------------------------------

function successors(term: IrTerminator): { target: IrBlockId; args: readonly IrValueId[] }[] {
  switch (term.kind) {
    case "br":
      return [term.branch];
    case "br_if":
      return [term.ifTrue, term.ifFalse];
    case "return":
    case "unreachable":
      return [];
  }
}

/** Lazy BOTTOM for a value: owned/{} for allocations, shared/{read} otherwise. */
function bottomFor(value: IrValueId, allocOf: Map<IrValueId, number>): OwnershipAnnotation {
  if (allocOf.has(value)) return { ownership: "owned", access: AccessSet.empty() };
  // Non-allocated, never-seeded value (e.g. a global read result, a capture
  // read, a value defined by a pure instr). Treat conservatively as shared.
  return { ownership: "shared", access: AccessSet.of("read") };
}

function cloneState(s: State): State {
  return new Map(s);
}

/** Join `src` into `dst` (component-wise). Returns true if `dst` changed. */
function joinInto(dst: State, src: State): boolean {
  let changed = false;
  for (const [v, a] of src) {
    if (mergeValue(dst, v, a)) changed = true;
  }
  return changed;
}

/** Join annotation `a` into `dst[value]`. Returns true if `dst` changed. */
function mergeValue(dst: State, value: IrValueId, a: OwnershipAnnotation): boolean {
  const prev = dst.get(value);
  if (prev === undefined) {
    dst.set(value, a);
    return true;
  }
  const merged = joinAnnotations(prev, a);
  if (annotationsEqual(prev, merged)) return false;
  dst.set(value, merged);
  return true;
}

/** Record every allocation result (instr carrying `alloc`) into `allocOf`. */
function collectAllocs(fn: IrFunction, allocOf: Map<IrValueId, number>): void {
  const walk = (instr: IrInstr): void => {
    if (instr.result !== null && instr.alloc !== undefined) {
      allocOf.set(instr.result, instr.alloc as unknown as number);
    }
    for (const sub of nestedInstrArrays(instr)) walk(sub);
  };
  for (const block of fn.blocks) {
    for (const instr of block.instrs) walk(instr);
  }
}

interface AliasInfo {
  readonly edges: readonly (readonly [IrValueId, IrValueId])[];
  readonly derived: ReadonlySet<IrValueId>;
}

/** Collect SSA carriers that preserve the identity of one of their inputs. */
function collectAliases(fn: IrFunction): AliasInfo {
  const edges: [IrValueId, IrValueId][] = [];
  const derived = new Set<IrValueId>();
  const slotValues = new Map<number, IrValueId[]>();
  const connect = (result: IrValueId, input: IrValueId): void => {
    edges.push([result, input]);
  };
  const recordSlot = (slotIndex: number, value: IrValueId): void => {
    const values = slotValues.get(slotIndex) ?? [];
    values.push(value);
    slotValues.set(slotIndex, values);
  };
  const walk = (instr: IrInstr): void => {
    switch (instr.kind) {
      case "select":
        if (instr.result !== null) {
          derived.add(instr.result);
          connect(instr.result, instr.whenTrue);
          connect(instr.result, instr.whenFalse);
        }
        break;
      case "if":
        if (instr.result !== null) {
          derived.add(instr.result);
          connect(instr.result, instr.thenValue);
          connect(instr.result, instr.elseValue);
        }
        break;
      case "slot.read":
        if (instr.result !== null) {
          derived.add(instr.result);
          recordSlot(instr.slotIndex, instr.result);
        }
        break;
      case "slot.write":
        recordSlot(instr.slotIndex, instr.value);
        break;
    }
    for (const sub of nestedInstrArrays(instr)) walk(sub);
  };

  for (const block of fn.blocks) {
    for (const instr of block.instrs) walk(instr);
    for (const successor of successors(block.terminator)) {
      const target = fn.blocks.find((candidate) => candidate.id === successor.target);
      if (!target) continue;
      for (let index = 0; index < successor.args.length && index < target.blockArgs.length; index++) {
        const blockArg = target.blockArgs[index]!;
        derived.add(blockArg);
        connect(blockArg, successor.args[index]!);
      }
    }
  }
  for (const values of slotValues.values()) {
    const first = values[0];
    if (first === undefined) continue;
    for (const value of values.slice(1)) connect(first, value);
  }
  return { edges, derived };
}

/** Join use effects across alias carriers until every component reaches a fixpoint. */
function propagateAliasAnnotations(
  annots: Map<IrValueId, OwnershipAnnotation>,
  aliases: AliasInfo,
  allocOf: Map<IrValueId, number>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [left, right] of aliases.edges) {
      const leftAnnot = annots.get(left) ?? aliasBottom(left, aliases.derived, allocOf);
      const rightAnnot = annots.get(right) ?? aliasBottom(right, aliases.derived, allocOf);
      const joined = joinAnnotations(leftAnnot, rightAnnot);
      if (!annotationsEqual(leftAnnot, joined)) {
        annots.set(left, joined);
        changed = true;
      }
      if (!annotationsEqual(rightAnnot, joined)) {
        annots.set(right, joined);
        changed = true;
      }
    }
  }
}

function aliasBottom(
  value: IrValueId,
  derived: ReadonlySet<IrValueId>,
  allocOf: Map<IrValueId, number>,
): OwnershipAnnotation {
  return derived.has(value) ? { ownership: "owned", access: AccessSet.empty() } : bottomFor(value, allocOf);
}

/** Yield every nested instr carried by control-flow-bearing instrs. */
function* nestedInstrArrays(instr: IrInstr): Iterable<IrInstr> {
  for (const value of Object.values(instr as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const el of value) if (isInstrLike(el)) yield el as IrInstr;
    } else if (value !== null && typeof value === "object") {
      for (const inner of Object.values(value as Record<string, unknown>)) {
        if (Array.isArray(inner)) {
          for (const el of inner) if (isInstrLike(el)) yield el as IrInstr;
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

/** Best-effort: yield every IrValueId-typed operand of an instr (for extern ops). */
function* operandsOf(instr: IrInstr): Iterable<IrValueId> {
  for (const [key, value] of Object.entries(instr as unknown as Record<string, unknown>)) {
    if (key === "result") continue;
    if (typeof value === "number" && looksLikeValueId(instr, key)) {
      yield value as unknown as IrValueId;
    } else if (Array.isArray(value)) {
      for (const el of value) {
        if (typeof el === "number") yield el as unknown as IrValueId;
      }
    }
  }
}

// Operand fields that hold IrValueIds across the instr union. Used to keep the
// generic `operandsOf` from mistaking structural numbers (slot indices, capture
// counts) for value ids.
const VALUE_OPERAND_FIELDS = new Set([
  "value",
  "newValue",
  "lhs",
  "rhs",
  "rand",
  "cond",
  "condition",
  "callee",
  "receiver",
  "cell",
  "vec",
  "index",
  "operand",
  "reason",
  "iterable",
  "iter",
  "resultObj",
  "self",
  "whenTrue",
  "whenFalse",
]);

function looksLikeValueId(_instr: IrInstr, key: string): boolean {
  return VALUE_OPERAND_FIELDS.has(key);
}
