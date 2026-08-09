// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3101 / E1 — the bytecode encoder: packs opcodes into the i32 `code` stream,
// interns the boxed-any constant pool, back-patches forward jumps, and builds
// the side exception table. It is the low-level writer the ESTree emitter drives;
// it knows nothing about ESTree. Authored in the js2wasm-compilable subset (E2
// self-compiles the runtime emitter, of which this is the sink).

import { A_SHIFT, B_SHIFT, Builtin, fitsOperand, Op, OPERAND_MASK, packWord, WIDE_FLAG } from "./opcodes.js";
import { type BcArray, type ConstPool, type ExnTable, FuncMeta, type JSValue } from "./types.js";

/** A back-patch handle: the code index of a jump's (WIDE) target word. */
export type JumpSlot = number;

/**
 * The bytecode writer for one function/script body. Emit calls append packed
 * words; `internConst` grows the pool; `emitJump`/`patch` handle forward
 * references; `addExnRow` accumulates try regions. `finish` freezes it all into
 * an immutable {@link FuncMeta}.
 */
export class Encoder {
  /** The packed i32 word stream (`array (mut i32)`). */
  readonly code: BcArray = [];
  /** The boxed-any constant pool. */
  readonly consts: ConstPool = [];
  /** Flat exception table (four ints per row); null-ish until a row is added. */
  private readonly exn: ExnTable = [];

  /** The next PC (index of the next word to be emitted). Jump targets are these. */
  here(): number {
    return this.code.length;
  }

  // ── constant pool ──────────────────────────────────────────────────────────
  /**
   * Add `value` to the constant pool and return its index. Primitive values
   * (number/string/boolean/undefined/null) are de-duplicated by a linear scan so
   * repeated literals/names share a slot; objects and nested FuncMeta are kept by
   * identity (never de-duplicated). Linear scan (not a Map) keeps this inside the
   * self-compile subset; pools are small.
   */
  internConst(value: JSValue): number {
    if (isDedupablePrimitive(value)) {
      const n = this.consts.length;
      let i = 0;
      for (;;) {
        if (i >= n) break;
        const existing = this.consts[i];
        // Strict equality, plus a NaN-pair check so two NaN literals share a slot
        // (NaN !== NaN). `Number.isNaN` is false for non-numbers, so this only
        // matches NaN↔NaN.
        if (existing === value || (Number.isNaN(value) && Number.isNaN(existing))) {
          return i;
        }
        i += 1;
      }
    }
    this.consts.push(value);
    return this.consts.length - 1;
  }

  // ── plain emits ────────────────────────────────────────────────────────────
  /** Emit an operand-less op (LdaUndef, Neg, Not, TypeOf, Return, Throw, …). */
  emit0(op: number): void {
    this.code.push(packWord(op, 0, 0));
  }

  /** Emit `op r` — one register operand (Star, Ldar, Add, GetElem, …). */
  emitReg(op: number, r: number): void {
    assertOperand(r, "register");
    this.code.push(packWord(op, r, 0));
  }

  /** Emit `op a, b` — two register operands (Mov, SetElem). */
  emitRegReg(op: number, a: number, b: number): void {
    assertOperand(a, "register");
    assertOperand(b, "register");
    this.code.push(packWord(op, a, b));
  }

  /**
   * Emit `op c` where `c` is a constant-pool index (LdaConst, LdGlobal, LdName,
   * StGlobal, StName, GetProp). Uses the WIDE form (a trailing full-width word)
   * when the index exceeds 12 bits.
   */
  emitConst(op: number, cIdx: number): void {
    if (fitsOperand(cIdx)) {
      this.code.push(packWord(op, cIdx, 0));
    } else {
      this.code.push(packWord(op | WIDE_FLAG, 0, 0));
      this.code.push(cIdx);
    }
  }

  /** Emit `SetProp c, r` — const-pool key index (WIDE-capable) + a register. */
  emitConstReg(op: number, cIdx: number, r: number): void {
    assertOperand(r, "register");
    if (fitsOperand(cIdx)) {
      this.code.push(packWord(op, cIdx, r));
    } else {
      this.code.push(packWord(op | WIDE_FLAG, 0, r));
      this.code.push(cIdx);
    }
  }

  /** Emit `Call`/`Construct rBase, argc`. */
  emitCall(op: number, rBase: number, argc: number): void {
    assertOperand(rBase, "register base");
    assertOperand(argc, "argc");
    this.code.push(packWord(op, rBase, argc));
  }

  /** Emit `CallBuiltin id, rBase, argc` (base word packs id/rBase; trailing argc). */
  emitCallBuiltin(builtinId: number, rBase: number, argc: number): void {
    assertOperand(builtinId, "builtin id");
    assertOperand(rBase, "register base");
    this.code.push(packWord(Op.CallBuiltin, builtinId, rBase));
    this.code.push(argc);
  }

  // ── jumps (always WIDE, so forward back-patching needs no size guessing) ─────
  /** Emit `op` (Jump/JumpIfTrue/JumpIfFalse) with a placeholder target; returns
   *  the {@link JumpSlot} to {@link patch} once the target PC is known. */
  emitJump(op: number): JumpSlot {
    this.code.push(packWord(op | WIDE_FLAG, 0, 0));
    const slot = this.code.length;
    this.code.push(0); // placeholder absolute target
    return slot;
  }

  /** Emit `op t` with an already-known absolute target (backward jumps). */
  emitJumpTo(op: number, target: number): void {
    this.code.push(packWord(op | WIDE_FLAG, 0, 0));
    this.code.push(target);
  }

  /** Emit a jump whose trailing target word is a temporary unique marker. */
  emitJumpMarker(op: number, marker: number): void {
    this.code.push(packWord(op | WIDE_FLAG, 0, 0));
    this.code.push(marker);
  }

  /** Back-patch a forward jump's target word to an explicit target. Requiring
   * the operand avoids the self-compiler's unstable optional-argument path. */
  patch(slot: JumpSlot, target: number): void {
    this.code[slot] = target;
  }

  /** Replace every deferred sentinel jump marker with one final target. This
   * avoids retaining growable jump-slot vectors through self-compiled object
   * fields, whose later growth is not a stable carrier operation. */
  patchTargetMarker(marker: number, target: number): void {
    for (let i = 0; i < this.code.length; i += 1) {
      if (this.code[i] === marker) this.code[i] = target;
    }
  }

  // ── exception table ──────────────────────────────────────────────────────────
  /**
   * Record a protected region `[startPC, endPC)` whose handler is at `handlerPC`
   * and binds the caught value into `regs[handlerReg]`. Rows are appended in the
   * order the emitter closes try-blocks; because the emitter closes inner blocks
   * first, the table ends up innermost-first for any given PC — but the loop does
   * a tightest-span scan, so order is not load-bearing (see loop.ts).
   */
  addExnRow(startPC: number, endPC: number, handlerPC: number, handlerReg: number): void {
    this.exn.push(startPC, endPC, handlerPC, handlerReg);
  }

  // ── finish ───────────────────────────────────────────────────────────────────
  /** Freeze the accumulated stream into an immutable {@link FuncMeta}. */
  finish(regCount: number, paramCount: number, name: JSValue, flags: number): FuncMeta {
    const exnTable: ExnTable | null = this.exn.length > 0 ? this.exn : null;
    return new FuncMeta(this.code, this.consts, regCount, paramCount, exnTable, name, flags);
  }
}

function isDedupablePrimitive(v: JSValue): boolean {
  const t = typeof v;
  return t === "number" || t === "string" || t === "boolean" || t === "undefined" || v === null;
}

function assertOperand(v: number, what: string): void {
  if (!(v >= 0 && v <= OPERAND_MASK)) {
    throw new Error(`interp/encoder: ${what} ${v} exceeds the 12-bit packed operand field (0..${OPERAND_MASK})`);
  }
}

// Re-export the builtin ids so emitter code has one import site for encoding.
export { Builtin };
export { A_SHIFT, B_SHIFT };
