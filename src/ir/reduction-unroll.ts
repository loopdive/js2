// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3786) Unroll an i32-wrapping accumulator loop across k independent partial
 * sums, breaking the serial dependency chain on the accumulator.
 *
 * ## Why
 *
 * `for (let i = 0; i < N; i++) s = (s + i) | 0` lowers (post-#3741) to four
 * operations per iteration over native i32 slots — about as tight as a naive
 * lowering gets. It still loses to V8, because the limit is not instruction
 * count: at ~1.1 cycles/iteration the loop is bound by the LATENCY of the
 * dependency on `s`. Each `i32.add` must wait for the previous to retire.
 *
 * Measured (real node v26.5.0, --no-liftoff, wasm-opt -O4 fixpoint, median of 9,
 * every variant result-checked against the JS answer):
 *
 *   current shape                451.4us   1.22x SLOWER than JS
 *   unroll x4, ONE accumulator   383.6us   1.04x slower  <- barely helps
 *   k=4 independent accumulators 216.6us   0.59x faster
 *   k=8 independent accumulators 192.1us   0.52x -- 1.92x FASTER than JS
 *   k=16                         196.4us   0.53x (register pressure)
 *   JS (V8 TurboFan)             369.2us   1.00x
 *
 * Unrolling alone is nearly worthless here (it shortens nothing on the critical
 * path); splitting the accumulator is what converts the loop from latency-bound
 * to throughput-bound. k=8 is the knee.
 *
 * ## Why it is sound
 *
 * `(s + i) | 0` is ToInt32 of the sum, i.e. addition modulo 2^32, which is
 * associative and commutative. Partitioning the addends across k accumulators
 * and summing the partials at exit produces the identical bit pattern. This is
 * NOT true of float `+`, so the transform is gated on the i32 form: it only ever
 * fires when the recogniser has seen `i32.add` over i32 slots, which the
 * front-end emits only in ToInt32-guaranteed positions (see `IrBinop`'s
 * `i32.add` note and #3741).
 *
 * It is also an optimization V8 cannot perform for the JS original: there
 * `s + i` is float addition that V8 has only SPECULATIVELY narrowed to int32,
 * and it will not reassociate a reduction on speculation. The explicit `| 0`
 * is what entitles an AOT compiler to it.
 *
 * ## Why here and not on the AST
 *
 * The tempting design — synthesize `s0..s7` in the AST, unroll, lower normally,
 * inherit every existing proof — does not work. Synthetic `ts` nodes carry no
 * symbols, so the checker cannot type them, so `proveUnboxedNumberLocal`
 * (#2782/#2790) cannot discharge its proof on the new accumulators; they fail
 * the gate and the whole function demotes to legacy, losing the win. Operating
 * on already-typed IR buffers sidesteps that entirely: slots declared here are
 * i32 by construction and need no type proof.
 *
 * ## Scope
 *
 * Recognition is deliberately exact-shape and fails closed. First slice handles
 * a literal-bounded, step-1 counter with a single `+` accumulator; anything else
 * returns `null` and the caller lowers unchanged. Because the bound is a
 * literal, the trip count is known here, so the remainder is emitted as
 * STRAIGHT-LINE iterations rather than a residual loop — which is what keeps
 * this small enough to verify exhaustively.
 */

import { type IrInstr, type IrValueId, irVal } from "./nodes.js";
import type { IrFunctionBuilder } from "./builder.js";

/** Independent accumulators. 8 measured fastest; 16 regresses on registers. */
const UNROLL_WIDTH = 8;

/**
 * Below this trip count the transform is not worth the extra slots and the
 * straight-line remainder: the loop is short enough that the dependency chain
 * is not the dominant cost. Also keeps tiny loops byte-identical to today.
 */
const MIN_TRIP_COUNT = 64;

/**
 * A loop the recogniser accepted, reduced to the four facts the emitter needs.
 */
interface ReducibleLoop {
  /** Slot index of the counter. */
  readonly counterSlot: number;
  /** Slot index of the accumulator. */
  readonly accSlot: number;
  /** Exclusive upper bound, a compile-time literal. */
  readonly bound: number;
}

/**
 * Match `[slot.read(counter), const i32 N, i32.lt_s]` — the cond buffer of a
 * literal-bounded counted loop — and return `{counterSlot, bound}`.
 *
 * `condValue` must be the compare's result: if the buffer computes something
 * else and merely happens to contain a compare, this is not the loop's test.
 */
function matchCond(cond: readonly IrInstr[], condValue: IrValueId): { counterSlot: number; bound: number } | null {
  if (cond.length !== 3) return null;
  const [read, konst, cmp] = cond;
  if (read.kind !== "slot.read") return null;
  if (konst.kind !== "const" || konst.value.kind !== "i32") return null;
  if (cmp.kind !== "binary" || cmp.op !== "i32.lt_s") return null;
  if (cmp.lhs !== read.result || cmp.rhs !== konst.result) return null;
  if (cmp.result !== condValue) return null;
  return { counterSlot: read.slotIndex, bound: konst.value.value };
}

/**
 * Match `[slot.read(i), const i32 1, i32.add, slot.write(i)]` — a step-1
 * increment of exactly the counter the cond tests.
 */
function matchUnitStepUpdate(update: readonly IrInstr[], counterSlot: number): boolean {
  if (update.length !== 4) return false;
  const [read, konst, add, write] = update;
  if (read.kind !== "slot.read" || read.slotIndex !== counterSlot) return false;
  if (konst.kind !== "const" || konst.value.kind !== "i32" || konst.value.value !== 1) return false;
  if (add.kind !== "binary" || add.op !== "i32.add") return false;
  if (add.lhs !== read.result || add.rhs !== konst.result) return false;
  if (write.kind !== "slot.write" || write.slotIndex !== counterSlot) return false;
  return write.value === add.result;
}

/**
 * Match `[slot.read(acc), slot.read(i), i32.add, slot.write(acc)]` (either
 * operand order) — a single accumulate of the counter into a distinct slot.
 *
 * Exact-length match is doing real work: it rules out a body that also reads
 * `acc` for anything else, writes it twice, or contains any other instruction.
 * Anything richer returns null rather than risking a partial understanding.
 */
function matchAccumulateBody(body: readonly IrInstr[], counterSlot: number): number | null {
  if (body.length !== 4) return null;
  const [a, b, add, write] = body;
  if (a.kind !== "slot.read" || b.kind !== "slot.read") return null;
  if (add.kind !== "binary" || add.op !== "i32.add") return null;
  if (write.kind !== "slot.write") return null;
  if (write.value !== add.result) return null;

  // One read is the counter, the other is the accumulator, and the accumulator
  // is what gets written back.
  const reads = [a, b];
  const counterRead = reads.find((r) => r.slotIndex === counterSlot);
  const accRead = reads.find((r) => r.slotIndex !== counterSlot);
  if (!counterRead || !accRead) return null;
  if (write.slotIndex !== accRead.slotIndex) return null;

  // `i32.add` must consume exactly those two reads (in either order). A read
  // with no SSA result is not something to reason about — bail.
  if (counterRead.result === null || accRead.result === null) return null;
  const operands: readonly IrValueId[] = [add.lhs, add.rhs];
  if (!operands.includes(counterRead.result) || !operands.includes(accRead.result)) return null;

  return accRead.slotIndex;
}

/**
 * Recognise a reducible loop, or return `null`. Fails closed on every shape it
 * does not match exactly.
 */
function recognise(
  cond: readonly IrInstr[],
  condValue: IrValueId,
  body: readonly IrInstr[],
  update: readonly IrInstr[],
): ReducibleLoop | null {
  const head = matchCond(cond, condValue);
  if (!head) return null;
  if (!matchUnitStepUpdate(update, head.counterSlot)) return null;
  const accSlot = matchAccumulateBody(body, head.counterSlot);
  if (accSlot === null) return null;
  return { counterSlot: head.counterSlot, accSlot, bound: head.bound };
}

/**
 * Rewrite a recognised reduction into an unrolled loop over `UNROLL_WIDTH`
 * independent accumulators, plus a straight-line remainder, and emit it.
 *
 * Returns `true` if it emitted; `false` if the loop was not reducible and the
 * caller must lower it unchanged.
 *
 * The recogniser proves the loop's SHAPE; it cannot see the counter's entry
 * value, which lives in the (already-emitted) init. The caller supplies that as
 * `counterEntry`, and the transform refuses unless the init wrote the very slot
 * the condition tests — see that field's note.
 */
export function tryEmitUnrolledReduction(args: {
  readonly builder: IrFunctionBuilder;
  readonly cond: readonly IrInstr[];
  readonly condValue: IrValueId;
  readonly body: readonly IrInstr[];
  readonly update: readonly IrInstr[];
  /**
   * Compile-time value of the counter on loop entry, plus the slot it was
   * written to — or `null` when the initializer was not a literal.
   *
   * Both halves are load-bearing. Knowing "the init was `= 0`" is useless
   * unless that init declared the SAME binding the condition tests: a loop like
   * `for (let j = 0; i < N; i++)` initializes `j` while the counter is an outer
   * `i` of unknown entry value, and deriving a trip count from `bound - 0`
   * there would be silently wrong. So the caller reports which slot it
   * initialized, and the transform refuses unless it is the counter's.
   */
  readonly counterEntry: { readonly value: number; readonly slotIndex: number } | null;
  readonly loopLabel?: number;
}): boolean {
  const { builder, cond, condValue, body, update, counterEntry } = args;
  const loop = counterEntry === null ? null : recognise(cond, condValue, body, update);
  if (loop === null || counterEntry === null) return false;
  if (loop.counterSlot !== counterEntry.slotIndex) return false;

  const tripCount = loop.bound - counterEntry.value;
  if (!Number.isSafeInteger(tripCount) || tripCount < MIN_TRIP_COUNT) return false;

  const unrolledIters = Math.floor(tripCount / UNROLL_WIDTH);
  const remainder = tripCount - unrolledIters * UNROLL_WIDTH;
  if (unrolledIters < 1) return false;

  const I32 = irVal({ kind: "i32" });
  const i32c = (n: number): IrValueId => builder.emitConst({ kind: "i32", value: n }, I32);

  // k fresh partial accumulators, i32 by construction (no type proof needed).
  const partials: number[] = [];
  for (let j = 0; j < UNROLL_WIDTH; j++) {
    const slot = builder.declareSlot(`__ru_acc${j}`, { kind: "i32" });
    // Seed: partial 0 carries the accumulator's incoming value so any non-zero
    // starting `s` is preserved; the rest start at 0.
    builder.emitSlotWrite(slot, j === 0 ? builder.emitSlotRead(loop.accSlot) : i32c(0));
    partials.push(slot);
  }

  // The unrolled loop runs `unrolledIters` times. Its own counter is a fresh
  // slot so the source counter keeps exactly the value the remainder and any
  // post-loop code expect.
  const tripSlot = builder.declareSlot("__ru_trip", { kind: "i32" });
  builder.emitSlotWrite(tripSlot, i32c(0));

  const unrolledCond = builder.collectBodyInstrs(() => {
    void builder.emitBinary("i32.lt_s", builder.emitSlotRead(tripSlot), i32c(unrolledIters), I32);
  });
  const unrolledCondValue = unrolledCond[unrolledCond.length - 1]?.result;
  if (unrolledCondValue === null || unrolledCondValue === undefined) return false;

  const unrolledBody = builder.collectBodyInstrs(() => {
    // partial[j] += counter + j, for j in 0..k-1 — k independent chains.
    const base = builder.emitSlotRead(loop.counterSlot);
    for (let j = 0; j < UNROLL_WIDTH; j++) {
      const addend = j === 0 ? base : builder.emitBinary("i32.add", base, i32c(j), I32);
      builder.emitSlotWrite(partials[j], builder.emitBinary("i32.add", builder.emitSlotRead(partials[j]), addend, I32));
    }
    // Advance the source counter by k so it stays the loop's real induction
    // variable, and the remainder below just continues from where this left off.
    builder.emitSlotWrite(
      loop.counterSlot,
      builder.emitBinary("i32.add", builder.emitSlotRead(loop.counterSlot), i32c(UNROLL_WIDTH), I32),
    );
  });

  const unrolledUpdate = builder.collectBodyInstrs(() => {
    builder.emitSlotWrite(tripSlot, builder.emitBinary("i32.add", builder.emitSlotRead(tripSlot), i32c(1), I32));
  });

  builder.emitForLoop({
    cond: unrolledCond,
    condValue: unrolledCondValue,
    body: unrolledBody,
    update: unrolledUpdate,
    ...(args.loopLabel !== undefined ? { loopLabel: args.loopLabel as never } : {}),
  });

  // Combine the partials back into the source accumulator.
  let total = builder.emitSlotRead(partials[0]);
  for (let j = 1; j < UNROLL_WIDTH; j++) {
    total = builder.emitBinary("i32.add", total, builder.emitSlotRead(partials[j]), I32);
  }
  builder.emitSlotWrite(loop.accSlot, total);

  // Straight-line remainder — no residual loop, because the trip count is a
  // compile-time constant. Each step mirrors the original body + update exactly.
  for (let r = 0; r < remainder; r++) {
    builder.emitSlotWrite(
      loop.accSlot,
      builder.emitBinary("i32.add", builder.emitSlotRead(loop.accSlot), builder.emitSlotRead(loop.counterSlot), I32),
    );
    builder.emitSlotWrite(
      loop.counterSlot,
      builder.emitBinary("i32.add", builder.emitSlotRead(loop.counterSlot), i32c(1), I32),
    );
  }

  return true;
}
