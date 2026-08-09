// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// BytecodeEmitter (#1715) — the backend-agnostic proof point.
//
// Throwaway-grade by design (issue #1715): the deliverable is *knowledge + a
// green triple-equivalence test*, not production code. It exists to de-risk the
// single architectural claim #1584's bytecode-VM investment rests on:
//
//   > Can the typed IR be lowered to a NON-Wasm execution target (a bytecode
//   > stream run by a dispatch loop) through the same backend seam (#1713) that
//   > targets WasmGC?
//
// ## What this proves
//
// The #1713 `BackendEmitter` trait abstracts *op emission* — `lower.ts` decides
// intent ("push a const", "add the top two operands", "branch if zero") and the
// emitter decides the concrete ops. `WasmGcEmitter` turns that intent into
// `Instr[]` (`{ op: "f64.add" }`). This `BytecodeEmitter` turns the SAME intent
// into a flat opcode stream (`OP_ADD`) for a stack VM (`bytecode-vm.ts`). Same
// primitive set, same operand-evaluation contract (caller pushes operand
// subtrees first), different execution model. That is the proof.
//
// ## The one seam generalisation this required (the #1715 finding)
//
// `BackendEmitter`'s methods take `out: Instr[]` and push `Instr` objects. That
// sink is WasmGC/linear-shaped — both share the `Instr` union (codegen-axes
// "types.ts stays shared"). It does NOT fit a bytecode target, whose natural
// sink is a flat `number[]`. So reaching bytecode needed exactly ONE seam
// change: generalise the sink from the concrete `Instr[]` to an abstract
// {@link BytecodeSink} here. Everything else about the trait — the primitive
// SET, the push-to-sink convention, the caller-owns-operand-order contract —
// transferred unchanged. **That single, well-contained generalisation is the
// answer #1715 set out to find**: the trait abstracts the *execution model*,
// and the sink type is the one place that is representation-specific. The
// encoding (stack vs register+accumulator) is a free choice *below* the seam —
// the seam does not care (see issue write-up §6).
//
// Scope is deliberately minimal (#1715): integer/f64 arithmetic (add/sub/mul),
// local get/set, const, return, ONE conditional branch. NO objects/arrays/
// closures/calls/strings/exceptions — those are #1584's job. This is exactly
// the IR subset `lower.ts` already handles for
// `function f(a, b) { return a > 0 ? a + b : a - b; }`.
//
// Encoding: STACK MACHINE (issue §6 tiebreaker — "a stack machine is acceptable
// for the proof if simpler"). `lower.ts`'s emission is already stack-oriented
// (operands pushed by `emitValue`, then the op consumes them), so a stack-VM
// opcode per primitive is a near-mechanical mirror of `WasmGcEmitter` and reuses
// the existing operand-ordering logic with the least throwaway code. #1584 wants
// register+accumulator for the eventual VM; this proof documents that that delta
// is purely an *encoding* concern downstream of the same seam.
//
// This file is behind no production code path — it is reached only by the
// #1715 test. It does NOT touch `lower.ts`, `WasmGcEmitter`, or the default
// compile pipeline, so it carries zero conformance risk (issue AC #5).

import type { IrBinop, IrInstr, IrType, IrUnop } from "../nodes.js";
import type { BlockType, Instr } from "../types.js";
import type { TypeConverter } from "./contract.js";
import type {
  BackendEmitter,
  BackendI32BitwiseOp,
  BackendNumericConversionOp,
  BackendScalarConstType,
} from "./emitter.js";
import type { IrClassLowering, IrObjectStructLowering } from "./handles.js";

/** The proof VM carries every legal IR value in one JavaScript number slot. */
export type BytecodeValueSlot = "number";

export class BytecodeTypeConverter implements TypeConverter<BytecodeValueSlot> {
  readonly backend = "bytecode" as const;

  convertType(_type: IrType): readonly BytecodeValueSlot[] {
    return ["number"];
  }
}

// ── Opcodes ───────────────────────────────────────────────────────────────
// A flat `number[]` instruction stream. Each opcode is one int; inline operands
// (a local index, a constant-pool index, a jump target) are the ints that
// follow it. f64 immediates live in a side constant pool (see BytecodeSink) so
// the code array stays integer-only — the dispatch loop reads them by index.
export const OP = {
  // ── #1715 base (numeric values 0..14 FROZEN — VM + proof depend on them) ──
  CONST: 0, //  CONST <poolIdx>      ; push constPool[poolIdx]
  LOAD: 1, //   LOAD  <localIdx>     ; push frame.locals[localIdx]
  STORE: 2, //  STORE <localIdx>     ; pop -> frame.locals[localIdx]
  ADD: 3, //    ADD                  ; pop b, pop a, push a + b
  SUB: 4, //    SUB                  ; pop b, pop a, push a - b
  MUL: 5, //    MUL                  ; pop b, pop a, push a * b
  // Comparisons (the conditional branch needs a compare). Result is 1.0 / 0.0.
  CMP_GT: 6, // CMP_GT               ; pop b, pop a, push (a >  b) ? 1 : 0
  CMP_LT: 7, // CMP_LT               ; pop b, pop a, push (a <  b) ? 1 : 0
  CMP_GE: 8, // CMP_GE               ; pop b, pop a, push (a >= b) ? 1 : 0
  CMP_LE: 9, // CMP_LE               ; pop b, pop a, push (a <= b) ? 1 : 0
  CMP_EQ: 10, // CMP_EQ              ; pop b, pop a, push (a == b) ? 1 : 0
  NEG: 11, //   NEG                  ; pop a, push -a
  JZ: 12, //    JZ <target>          ; pop c; if c == 0 goto target  (maps from emitBrIf/emitIf)
  JMP: 13, //   JMP <target>         ; goto target                   (maps from emitBr)
  RET: 14, //   RET                  ; halt, return top-of-stack
  // ── #1584 production additions (next free integers; additive, sdev-vm aligned) ──
  // Each entry grows the VM dispatch (slice b) in lockstep. STACK encoding for
  // the first increment per the #1584 contract §1a staging note; a later
  // reg+acc bump (slice a, coordinated with sdev-vm) changes operand layout +
  // VM model but not these names.
  DIV: 15, //   DIV                  ; pop b, pop a, push a / b
  CMP_NE: 16, // CMP_NE              ; pop b, pop a, push (a != b) ? 1 : 0
  TEE: 17, //   TEE <localIdx>       ; peek top -> frame.locals[localIdx] (leaves it on stack)
  GLOBAL_GET: 18, // GLOBAL_GET <gIdx> ; push globals[gIdx]
  GLOBAL_SET: 19, // GLOBAL_SET <gIdx> ; pop -> globals[gIdx]
  SELECT: 20, // SELECT              ; pop cond, pop b, pop a, push (cond != 0) ? a : b
  DROP: 21, //  DROP                 ; pop and discard
  UNREACHABLE: 22, // UNREACHABLE    ; trap (malformed / dead code path)
  // ── (a1) call family (#1584 §2a) — multi-function VM (program wrapper +
  // call-frame stack). Both mirror Wasm `call`/`call_ref` exactly: one inline
  // operand, args already on the stack (arg0 deepest), callee arity NOT inline
  // (read from the function-table entry). funcref ≡ f64(tableIndex), null ≡
  // f64(-1) (CALL_REF on -1 traps). See sdev-vm coordination + issue §2a.
  CALL: 23, //     CALL <funcIdx>     ; pop arity args, run functions[funcIdx], push result
  CALL_REF: 24, // CALL_REF <typeIdx> ; pop funcref(top)+arity args, run functions[idx], push result
  // ── (a2) struct/object family (#1584 §2a) — heap-backed structs. A struct
  // ref ≡ f64(heapIndex) into a VM-global heap of `{fields:number[]}`; null ≡
  // f64(-1) (STRUCT_GET/SET on -1 traps). The struct field that holds a funcref
  // stores f64(tableIndex) (a1's invariant) so CALL_REF dispatches it.
  STRUCT_NEW: 25, // STRUCT_NEW <fieldCount> ; pop fieldCount vals (field0 deepest), alloc heap obj, push ref
  STRUCT_GET: 26, // STRUCT_GET <fieldIdx>   ; pop structRef, push obj.fields[fieldIdx]
  STRUCT_SET: 27, // STRUCT_SET <fieldIdx>   ; pop value, pop structRef, obj.fields[fieldIdx]=value
  // ── (a3) control-flow family (#1584 §2a) — the structured `block`/`loop`/`br`/
  // `br_if` family lowers AWAY in the emitter to JZ/JNZ/JMP + backpatch labels
  // (issue §1c/§2a). The only new VM opcode is JNZ — the exact dual of JZ — so
  // `br_if`'s "branch if truthy" needs no `eqz`+`JZ` dance. block/loop add NO
  // opcode (they resolve to backpatched JMP/JNZ/JZ targets at splice time).
  JNZ: 28, //   JNZ <target>         ; pop c; if c != 0 goto target  (maps from emitBrIf / br_if)
  // ── (a4) try-throw family (#1584 §2a) — exception handling via a per-function
  // STATIC `exceptionTable` (table-scan model, sdev-vm locked). THROW unwinds:
  // scan the current fn's table for the innermost {tryStart ≤ pc < tryEnd}, on a
  // hit truncate the value stack to that entry's `spAtEntry` (always 0 — try is
  // a statement-level node, empty operand stack at entry), push the exn, jump to
  // `catchTarget`; no hit ⇒ pop the call frame and rescan the caller (mirrors
  // Wasm unwind); frames empty ⇒ abort with the thrown value. TRY_START/TRY_END
  // are RUNTIME NO-OP region markers (the table is authoritative) kept so the
  // stream is self-describing + region boundaries are testable.
  THROW: 29, //     THROW              ; pop exn; unwind to innermost covering handler (table-scan)
  TRY_START: 30, // TRY_START <catchTarget> ; no-op marker (region start; table carries coverage)
  TRY_END: 31, //   TRY_END            ; no-op marker (region end; normal-exit boundary)
} as const;

export type Opcode = (typeof OP)[keyof typeof OP];

/**
 * The bytecode equivalent of `BackendEmitter`'s `Instr[]` sink — the ONE seam
 * generalisation #1715 required. A flat `code` opcode stream plus a side
 * constant pool for f64 immediates. A label backpatch list lets `emitIf`
 * forward-reference jump targets it does not yet know.
 */
export class BytecodeSink {
  readonly code: number[] = [];
  readonly constPool: number[] = [];

  /**
   * (a3 #1584) Structured-branch backpatch list. A `br` / `br_if` (`emitBr` /
   * `emitBrIf`) emits a `JMP` / `JNZ` placeholder whose target is the construct
   * `depth` levels out (De Bruijn) — UNKNOWN until the enclosing `block`/`loop`
   * splices this sink. Each entry pins the operand slot + its outward depth.
   * `emitBlock`/`emitLoop` resolve depth-0 entries (this construct) and carry
   * deeper ones outward (depth-1). A sink with a non-empty list at function exit
   * is an internal error (a `br` with no enclosing construct).
   */
  readonly pendingBranches: { slot: number; depth: number }[] = [];

  /**
   * (a4 #1584) Per-function exception table (table-scan model, §1c). One entry
   * per `try` region: the protected code range `[tryStart, tryEnd)` (absolute
   * code indices), the `catchTarget` THROW jumps to on a covered throw, and
   * `spAtEntry` — the value-stack depth to truncate to on catch (always 0: a
   * `try` is a statement-level node lowered at empty operand-stack depth).
   * The VM scans this for the innermost covering entry on THROW; TRY_START/
   * TRY_END are runtime no-ops (the table is authoritative). Travels with the
   * function on its FuncEntry, alongside `code`/`constPool`.
   */
  readonly exceptionTable: {
    tryStart: number;
    tryEnd: number;
    catchTarget: number;
    spAtEntry: number;
  }[] = [];

  /** Intern an f64 immediate into the constant pool, returning its index. */
  internConst(value: number): number {
    // Linear scan is fine — proof-grade, programs are tiny.
    const existing = this.constPool.indexOf(value);
    if (existing >= 0) return existing;
    this.constPool.push(value);
    return this.constPool.length - 1;
  }

  /** Current write position (a jump target / patch site is a code index). */
  here(): number {
    return this.code.length;
  }

  /** Emit an opcode followed by zero or more inline integer operands. */
  emit(op: Opcode, ...operands: number[]): void {
    this.code.push(op, ...operands);
  }

  /**
   * Emit a jump whose target is not yet known; returns the code index of the
   * *operand slot* to backpatch once the target is known.
   */
  emitJumpPlaceholder(op: typeof OP.JZ | typeof OP.JMP | typeof OP.JNZ | typeof OP.TRY_START): number {
    this.code.push(op, -1); // -1 = unpatched
    return this.code.length - 1; // index of the operand slot
  }

  /** Fill a previously-reserved jump operand slot with the resolved target. */
  patch(slot: number, target: number): void {
    this.code[slot] = target;
  }

  /**
   * (a3 #1584) Record a structured branch (`br`/`br_if`) whose target is the
   * construct `depth` levels out. The placeholder jump was just emitted; `slot`
   * is its operand index. Resolved by the enclosing `emitBlock`/`emitLoop`.
   */
  recordPendingBranch(slot: number, depth: number): void {
    this.pendingBranches.push({ slot, depth });
  }

  /**
   * #1584: append another sink's code at the current position, relocating its
   * internal jump targets into this sink's address space and remapping its
   * const-pool indices into this sink's pool. Used by the production
   * `BytecodeEmitter.emitIf` to splice already-lowered `if`-arm buffers (the
   * real `lower.ts` builds each arm into its own sink, exactly as it builds the
   * WasmGC `if`'s `then`/`else` as separate `Instr[]`).
   *
   * (a3) An arm may carry UNPATCHED structured branches (`br`/`br_if` in
   * `pendingBranches`) bound for an enclosing `block`/`loop`. Those slots
   * relocate by `+base` and their depth-tagged entries migrate onto THIS sink's
   * `pendingBranches` so the enclosing construct can resolve them. A leftover
   * unpatched jump that is NOT a recorded structured branch is still an internal
   * error (a forward `if`/`block` exit the owner forgot to patch).
   */
  spliceArm(arm: BytecodeSink): void {
    const base = this.code.length;
    const code = arm.code;
    // Operand-slot → outward-depth for the arm's structured branches, so we can
    // recognise an unpatched jump as a legitimate pending branch (vs an error).
    const armPending = new Map<number, number>();
    for (const pb of arm.pendingBranches) armPending.set(pb.slot, pb.depth);
    let i = 0;
    while (i < code.length) {
      const op = code[i++] as Opcode;
      switch (op) {
        case OP.CONST: {
          const localPoolIdx = code[i++]!;
          this.code.push(OP.CONST, this.internConst(arm.constPool[localPoolIdx]!));
          break;
        }
        case OP.JZ:
        case OP.JMP:
        case OP.JNZ: {
          const slot = i; // operand index in the arm's code
          const target = code[i++]!;
          const relocSlot = this.code.length + 1; // operand index after we push `op`
          if (target < 0) {
            const depth = armPending.get(slot);
            if (depth === undefined) {
              throw new Error("BytecodeSink.spliceArm: arm contains an unpatched jump (internal error)");
            }
            // Carry the structured branch outward, relocated into this sink.
            this.code.push(op, -1);
            this.pendingBranches.push({ slot: relocSlot, depth });
          } else {
            this.code.push(op, target + base);
          }
          break;
        }
        // (a4) TRY_START carries an inline <catchTarget> that is a code POSITION
        // in the arm's address space — relocate it by +base like a jump target.
        // (The exceptionTable below is the VM-authoritative copy; this inline
        // operand is the self-describing marker, kept consistent.)
        case OP.TRY_START:
          this.code.push(op, code[i++]! + base);
          break;
        // Single-inline-operand opcodes (a local / global / const / func /
        // type index). CALL <funcIdx> / CALL_REF <typeIdx> carry exactly one
        // inline operand (no relocation needed — function/type indices are
        // program-global, not arm-local like jump targets/const-pool).
        case OP.LOAD:
        case OP.STORE:
        case OP.TEE:
        case OP.GLOBAL_GET:
        case OP.GLOBAL_SET:
        case OP.CALL:
        case OP.CALL_REF:
        case OP.STRUCT_NEW:
        case OP.STRUCT_GET:
        case OP.STRUCT_SET:
          this.code.push(op, code[i++]!);
          break;
        // Zero-operand opcodes (incl. (a4) THROW / TRY_END).
        default:
          this.code.push(op);
          break;
      }
    }
    // (a4) Relocate the arm's exception table into this sink's address space.
    // tryStart/tryEnd/catchTarget are code positions in the arm → shift by +base.
    for (const e of arm.exceptionTable) {
      this.exceptionTable.push({
        tryStart: e.tryStart + base,
        tryEnd: e.tryEnd + base,
        catchTarget: e.catchTarget + base,
        spAtEntry: e.spAtEntry,
      });
    }
  }
}

/**
 * Maps an IR binop tag to a stack-VM opcode for the #1715 subset. Ops outside
 * the subset throw `not-supported-in-proof` — exactly the #1715 contract
 * ("only the primitives the subset needs; the rest throw").
 */
function binopToOpcode(op: IrBinop): Opcode {
  switch (op) {
    case "f64.add":
      return OP.ADD;
    case "f64.sub":
      return OP.SUB;
    case "f64.mul":
      return OP.MUL;
    case "f64.div":
      return OP.DIV;
    case "f64.gt":
    case "i32.gt_s":
      return OP.CMP_GT;
    case "f64.lt":
    case "i32.lt_s":
      return OP.CMP_LT;
    case "f64.ge":
    case "i32.ge_s":
      return OP.CMP_GE;
    case "f64.le":
    case "i32.le_s":
      return OP.CMP_LE;
    case "f64.eq":
    case "i32.eq":
      return OP.CMP_EQ;
    case "f64.ne":
    case "i32.ne":
      return OP.CMP_NE;
    default:
      // Not-yet-migrated boundary: the op's family (js-bitwise, i32.and/or, …)
      // has not moved behind the BackendEmitter trait, so it has no bytecode
      // realization yet. Surface loudly rather than silently mis-lower.
      throw new Error(
        `BytecodeEmitter: binop '${op}' not in the #1584 production subset ` +
          `(add/sub/mul/div + compares). Its op family has not migrated behind ` +
          `the BackendEmitter trait yet — see plan/issues/1584 §2a.`,
      );
  }
}

/** Maps an IR unop to a stack-VM opcode. Out-of-subset unops throw. */
function unopToOpcode(op: IrUnop): Opcode {
  if (op === "f64.neg") return OP.NEG;
  throw new Error(
    `BytecodeEmitter: unary '${op}' not in the #1584 production subset (f64.neg). ` + `See plan/issues/1584 §2a.`,
  );
}

/**
 * #1584 PRODUCTION emitter. Implements the {@link BackendEmitter}<{@link
 * BytecodeSink}> trait surface so the REAL `lower.ts` drives it identically to
 * how it drives {@link WasmGcEmitter}<Instr[]> — same primitive set, same
 * caller-owns-operand-order contract, different execution model. (This
 * supersedes the #1715 proof's hand-driven emitter: the proof's thunked
 * `emitIf` is replaced by the trait's pre-built-arm `emitIf`, since real
 * `lower.ts` builds each arm into its own sink then hands them over.)
 *
 * STACK encoding for the first increment (contract §1a staging note). The opcode
 * set lives above (`OP`, the single source of truth the VM imports read-only);
 * this class only decides which opcode each primitive emits.
 */
export class BytecodeEmitter implements BackendEmitter<BytecodeSink> {
  readonly backend = "bytecode" as const;

  /** Factory for a child sink — used by `lower.ts` to build `if`-arm buffers. */
  newSink(): BytecodeSink {
    return new BytecodeSink();
  }

  /**
   * The raw-`Instr` escape hatch (the #1584 contract §0a-1). `lower.ts` still
   * has ~119 inline `out.push({op})` sites for op families not yet migrated
   * behind the trait. On the WasmGC path those append to the `Instr[]`; on the
   * bytecode path they reach a node family with no opcode realization yet, so
   * this throws — surfacing the not-yet-migrated boundary loudly rather than
   * silently mis-lowering. As each op family migrates (§2a), its `lower.ts`
   * sites move from `pushRaw` to a typed emitter primitive + opcode.
   */
  pushRaw(_out: BytecodeSink, instr: Instr): void {
    throw new Error(
      `BytecodeEmitter: raw Instr '${instr.op}' reached the bytecode sink — its ` +
        `op family has not migrated behind the BackendEmitter trait yet, so the ` +
        `function is out of the #1584 production subset. See plan/issues/1584 §2a.`,
    );
  }

  emitStringConst(): void {
    throw new Error("BytecodeEmitter: string primitives are not in the #1584 numeric subset.");
  }
  emitStringConcat(): void {
    throw new Error("BytecodeEmitter: string primitives are not in the #1584 numeric subset.");
  }
  emitStringEquals(): void {
    throw new Error("BytecodeEmitter: string primitives are not in the #1584 numeric subset.");
  }
  emitStringLength(): void {
    throw new Error("BytecodeEmitter: string primitives are not in the #1584 numeric subset.");
  }
  emitStringCharAt(): void {
    throw new Error("BytecodeEmitter: string primitives are not in the #1584 numeric subset.");
  }
  emitStringCharCodeAt(): void {
    throw new Error("BytecodeEmitter: string primitives are not in the #1584 numeric subset.");
  }

  emitConst(instr: Extract<IrInstr, { kind: "const" }>, funcName: string, out: BytecodeSink): void {
    const v = instr.value;
    switch (v.kind) {
      case "i32":
      case "f32":
      case "f64":
        out.emit(OP.CONST, out.internConst(v.value));
        return;
      case "bool":
        out.emit(OP.CONST, out.internConst(v.value ? 1 : 0));
        return;
      case "i64":
      case "null":
      case "undefined":
        throw new Error(`BytecodeEmitter: const '${v.kind}' not in the #1584 numeric subset (${funcName})`);
    }
  }

  emitBinary(op: IrBinop, out: BytecodeSink): void {
    out.emit(binopToOpcode(op));
  }

  emitUnary(op: IrUnop, out: BytecodeSink): void {
    out.emit(unopToOpcode(op));
  }

  emitScalarConst(_type: BackendScalarConstType, value: number, out: BytecodeSink): void {
    out.emit(OP.CONST, out.internConst(value));
  }

  emitNumericConversion(op: BackendNumericConversionOp, _out: BytecodeSink): void {
    throw new Error(`BytecodeEmitter: numeric conversion '${op}' not in the #1584 production subset`);
  }

  emitI32Bitwise(op: BackendI32BitwiseOp, _out: BytecodeSink): void {
    throw new Error(`BytecodeEmitter: i32 bitwise op '${op}' not in the #1584 production subset`);
  }

  emitLocalGet(index: number, out: BytecodeSink): void {
    out.emit(OP.LOAD, index);
  }

  emitLocalSet(index: number, out: BytecodeSink): void {
    out.emit(OP.STORE, index);
  }

  emitLocalTee(index: number, out: BytecodeSink): void {
    out.emit(OP.TEE, index);
  }

  emitGlobalGet(index: number, out: BytecodeSink): void {
    out.emit(OP.GLOBAL_GET, index);
  }

  emitGlobalSet(index: number, out: BytecodeSink): void {
    out.emit(OP.GLOBAL_SET, index);
  }

  emitDrop(out: BytecodeSink): void {
    out.emit(OP.DROP);
  }

  emitSelect(out: BytecodeSink): void {
    out.emit(OP.SELECT);
  }

  emitReturn(out: BytecodeSink): void {
    out.emit(OP.RET);
  }

  emitUnreachable(out: BytecodeSink): void {
    out.emit(OP.UNREACHABLE);
  }

  /**
   * Structured two-arm conditional. Mirrors `WasmGcEmitter.emitIf(blockType,
   * then: Instr[], els: Instr[], out)`: the caller (real `lower.ts`) pre-lowers
   * each arm into its own {@link BytecodeSink} (via `newSink()`), then hands
   * them here. The cond value is already on the stack. The stack VM has no
   * structured block, so we lower to JZ/JMP + spliced arms with backpatched
   * targets:
   *
   *   <cond on stack>
   *   JZ elseLabel
   *   <then arm>
   *   JMP endLabel
   *   elseLabel: <else arm>
   *   endLabel:
   *
   * `blockType` is ignored (the bytecode VM is untyped over boxed values); it is
   * part of the trait signature for the WasmGC realization.
   */
  emitIf(_blockType: BlockType, then: BytecodeSink, els: BytecodeSink, out: BytecodeSink): void {
    const toElse = out.emitJumpPlaceholder(OP.JZ);
    out.spliceArm(then);
    const toEnd = out.emitJumpPlaceholder(OP.JMP);
    out.patch(toElse, out.here());
    out.spliceArm(els);
    out.patch(toEnd, out.here());
  }

  // ---- (a3) control-flow family (#1584 §2a) — `block`/`loop`/`br`/`br_if`
  // lower AWAY to JZ/JNZ/JMP + backpatch labels. The VM gains exactly one
  // opcode (JNZ); block/loop add none (issue §1c/§2a). Targets are intra-
  // function absolute code indices in the SAME address space `emitIf` uses.

  // `br depth` — unconditional branch to the construct `depth` levels out. We
  // emit a JMP placeholder and record it as a pending structured branch; the
  // enclosing `emitLoop` (depth→header) / `emitBlock` (depth→exit) patches it.
  emitBr(depth: number, out: BytecodeSink): void {
    const slot = out.emitJumpPlaceholder(OP.JMP);
    out.recordPendingBranch(slot, depth);
  }

  // `br_if depth` — branch to the construct `depth` levels out IF the popped
  // condition is truthy. JNZ is the dual of JZ, so `br_if` needs no `eqz`. The
  // placeholder is recorded as a pending structured branch (same as `br`).
  emitBrIf(depth: number, out: BytecodeSink): void {
    const slot = out.emitJumpPlaceholder(OP.JNZ);
    out.recordPendingBranch(slot, depth);
  }

  /**
   * Structured `block`. Splices the pre-lowered `body` sink at the current
   * position, then resolves the body's pending structured branches: a branch
   * with `depth === 0` targets THIS block, so it jumps to the block's EXIT (the
   * code position just past the spliced body); deeper branches belong to an
   * outer construct and migrate outward with `depth - 1`. `blockType` is ignored
   * (the VM is untyped over boxed values) — it is part of the trait signature
   * for the WasmGC realization.
   */
  emitBlock(_blockType: BlockType, body: BytecodeSink, out: BytecodeSink): void {
    const firstNew = out.pendingBranches.length;
    out.spliceArm(body);
    this.resolveSplicedBranches(out, firstNew, out.here());
  }

  /**
   * Structured `loop`. Like `emitBlock`, but a `depth === 0` branch targets the
   * loop HEADER (the code position where the body begins) — `br 0` is "continue"
   * — so the back-edge target is captured BEFORE the splice.
   */
  emitLoop(_blockType: BlockType, body: BytecodeSink, out: BytecodeSink): void {
    const header = out.here();
    const firstNew = out.pendingBranches.length;
    out.spliceArm(body);
    this.resolveSplicedBranches(out, firstNew, header);
  }

  /**
   * Resolve the structured branches `spliceArm` just migrated onto `out`
   * (`out.pendingBranches[firstNew..]`): patch each `depth === 0` branch to
   * `selfTarget` (block exit / loop header) and drop it; decrement the depth of
   * each deeper branch so the next-outer construct resolves it. Entries added
   * before `firstNew` (already-pending outer branches) are untouched.
   */
  private resolveSplicedBranches(out: BytecodeSink, firstNew: number, selfTarget: number): void {
    const migrated = out.pendingBranches.splice(firstNew);
    for (const pb of migrated) {
      if (pb.depth === 0) {
        out.patch(pb.slot, selfTarget);
      } else {
        out.pendingBranches.push({ slot: pb.slot, depth: pb.depth - 1 });
      }
    }
  }

  // ---- (a1) call family (#1584 §2a) — the first migrated family -----------
  // The args are already on the stack (caller-owns-operand-order, same as
  // WasmGC). `OP.CALL <funcIdx>` carries ONE inline operand; the callee arity
  // is NOT inline — the VM reads it from the function-table entry, mirroring
  // Wasm `call $f`. The multi-function VM (program wrapper + call-frame stack)
  // is sdev-vm's slice (see issue §2a + the locked contract).
  emitCall(funcIdx: number, out: BytecodeSink): void {
    out.emit(OP.CALL, funcIdx);
  }

  // `OP.CALL_REF <typeIdx>` — the funcref is already on top of the stack
  // (lower.ts pushes the callee/funcref LAST). funcref ≡ f64(tableIndex),
  // null ≡ f64(-1) which traps. `typeIdx` is informational (func-type id).
  emitCallRef(funcTypeIdx: number, out: BytecodeSink): void {
    out.emit(OP.CALL_REF, funcTypeIdx);
  }

  // ---- (a2) struct/object family (#1584 §2a) — heap-backed structs --------
  // STRUCT_NEW carries the field COUNT (the untyped VM needs no typeIdx, only
  // how many to pop); STRUCT_GET/SET carry the numeric field INDEX (lower.ts
  // resolves name→fieldIdx via the layout, so the VM gets the index directly).
  emitAggregateNew(_layout: IrObjectStructLowering, fieldCount: number, out: BytecodeSink): void {
    out.emit(OP.STRUCT_NEW, fieldCount);
  }

  emitFieldGet(layout: IrObjectStructLowering | IrClassLowering, name: string, out: BytecodeSink): void {
    out.emit(OP.STRUCT_GET, layout.fieldIdx(name));
  }

  emitFieldSet(layout: IrObjectStructLowering | IrClassLowering, name: string, out: BytecodeSink): void {
    out.emit(OP.STRUCT_SET, layout.fieldIdx(name));
  }

  // ---- (a4) try-throw family (#1584 §2a) — table-scan exception model -------
  // sdev-vm-locked: per-function STATIC exceptionTable + THROW unwinds to the
  // innermost covering entry (frame-walking across CALL); TRY_START/TRY_END are
  // runtime no-op region markers (the table is authoritative). The thrown value
  // is a single boxed JSValue on the stack; catch binds it via STORE; rethrow =
  // re-push the caught value + THROW; finally is compiled away in lower.ts.

  // `throw v` — v already on the stack; THROW pops it and unwinds to the
  // innermost handler covering the current pc (table-scan), walking call frames.
  emitThrow(_tagIdx: number, out: BytecodeSink): void {
    out.emit(OP.THROW);
  }

  // `rethrow 0` — re-throw the currently-caught value. lower.ts only emits
  // depth 0 (the immediately-enclosing handler's caught value, still bound to
  // the payload slot). The caught value is already on the stack at the rethrow
  // point in our lowering (the catch_all/finally arm leaves it there before
  // rethrow), so this is a bare THROW. `depth` is informational (single tag).
  emitRethrow(_depth: number, out: BytecodeSink): void {
    out.emit(OP.THROW);
  }

  /**
   * Structured `try`. Table-scan realization:
   *
   *   TRY_START <catchTarget>     ; no-op marker
   *   <tryBody>
   *   TRY_END                     ; no-op marker (end of protected region)
   *   JMP endLabel                ; normal exit skips the handler
   *   catchTarget: <handler>      ; THROW lands here (VM pushed exn, truncated sp)
   *   endLabel:
   *
   * + an exceptionTable entry {tryStart, tryEnd, catchTarget, spAtEntry:0}.
   * The protected region is [tryStart, tryEnd) = the spliced tryBody (between the
   * markers). spAtEntry is 0: `try` is a statement-level node lowered at empty
   * operand-stack depth, so on catch the VM truncates back to the empty base.
   *
   * Handler selection: our system has ONE exception tag (`__exn`), so a thrown
   * value always matches a source `catch` if present; `catchAll` (emitted for
   * the finally-leak path) is the handler only when there is no `catch`. With a
   * single tag, `catchAll`-alongside-`catch` is the unreachable non-`__exn`
   * leak path — we still splice it after the catch for structural fidelity, but
   * `catchTarget` points at the live handler.
   */
  emitTry(
    _blockType: BlockType,
    body: BytecodeSink,
    catches: { tagIdx: number; body: BytecodeSink }[],
    catchAll: BytecodeSink | undefined,
    out: BytecodeSink,
  ): void {
    // TRY_START marker carries the (forward) catchTarget — backpatched below.
    const catchTargetSlot = out.emitJumpPlaceholder(OP.TRY_START);
    const tryStart = out.here();
    out.spliceArm(body);
    const tryEnd = out.here();
    out.emit(OP.TRY_END);
    // Normal exit skips the handler.
    const toEnd = out.emitJumpPlaceholder(OP.JMP);
    // Handler entry — THROW jumps here with the exn pushed + sp truncated.
    const catchTarget = out.here();
    out.patch(catchTargetSlot, catchTarget);
    // The live handler: the source `catch` if present, else the `catchAll`
    // (try/finally-only). When both exist, `catchAll` is the unreachable
    // non-`__exn` leak path, spliced after for fidelity.
    if (catches.length > 0) {
      out.spliceArm(catches[0]!.body);
      if (catchAll) out.spliceArm(catchAll);
    } else if (catchAll) {
      out.spliceArm(catchAll);
    }
    out.patch(toEnd, out.here());
    // Record the static table entry (innermost-covering selection on THROW).
    out.exceptionTable.push({ tryStart, tryEnd, catchTarget, spAtEntry: 0 });
  }

  // ---- vec (array) primitives — out of the #1584 numeric subset -----------
  emitVecLen(): void {
    throw new Error("BytecodeEmitter: vec primitives not in the #1584 numeric subset — see §2a struct/object family.");
  }
  emitVecDataPtr(): void {
    throw new Error("BytecodeEmitter: vec primitives not in the #1584 numeric subset — see §2a struct/object family.");
  }
  emitElemGet(): void {
    throw new Error("BytecodeEmitter: vec primitives not in the #1584 numeric subset — see §2a struct/object family.");
  }
  emitElemSet(): void {
    throw new Error("BytecodeEmitter: vec primitives not in the #1584 numeric subset — see §2a struct/object family.");
  }
  emitVecSetLength(): void {
    throw new Error("BytecodeEmitter: vec primitives not in the #1584 numeric subset — see §2a struct/object family.");
  }
  emitVecNewFixed(): void {
    throw new Error("BytecodeEmitter: vec primitives not in the #1584 numeric subset — see §2a struct/object family.");
  }

  // ---- ref-coercion / null family (#2953) — the VM's boxed-value sentinel
  // and cast semantics are not wired yet. Keep the representation boundary
  // loud instead of admitting raw WasmGC ref instructions into the sink.
  emitNull(): void {
    throw new Error("BytecodeEmitter: null materialization not yet wired — see §2a ref-coercion family.");
  }
  emitToExternref(): void {
    throw new Error("BytecodeEmitter: externref coercion not yet wired — see §2a ref-coercion family.");
  }
  emitDowncast(): void {
    throw new Error("BytecodeEmitter: reference downcast not yet wired — see §2a ref-coercion family.");
  }
  emitFromExternref(): void {
    throw new Error("BytecodeEmitter: externref conversion not yet wired — see §2a ref-coercion family.");
  }

  // ---- function-reference family (#2953) — callable values need a VM handle
  // representation; do not admit a raw WasmGC ref.func through pushRaw.
  emitFuncRef(): void {
    throw new Error("BytecodeEmitter: function references not yet wired — see §2a closure family.");
  }

  // ---- Promise aggregate family (#2953) — the VM needs a Promise record
  // representation before construction or semantic field reads are valid.
  emitPromiseNew(): void {
    throw new Error("BytecodeEmitter: Promise construction not yet wired — see §2a struct/object family.");
  }
  emitPromiseStateGet(): void {
    throw new Error("BytecodeEmitter: Promise state reads not yet wired — see §2a struct/object family.");
  }
  emitPromiseValueGet(): void {
    throw new Error("BytecodeEmitter: Promise value reads not yet wired — see §2a struct/object family.");
  }

  // ---- closure family (#2953) — closure records and callable handles are not
  // yet represented by the bytecode VM. Keep the trait boundary loud instead
  // of falling back to WasmGC struct instructions through pushRaw.
  emitClosureNew(): void {
    throw new Error("BytecodeEmitter: closure construction not yet wired — see §2a closure family.");
  }
  emitClosureFuncGet(): void {
    throw new Error("BytecodeEmitter: closure function reads not yet wired — see §2a closure family.");
  }
  emitCaptureGet(): void {
    throw new Error("BytecodeEmitter: closure capture reads not yet wired — see §2a closure family.");
  }

  // ---- (a5) ref-cell family (#2953) — a 1-field mutable struct. Not yet wired
  // into the VM heap model; a future wiring mirrors the (a2) struct family
  // (STRUCT_NEW fieldCount=1 / STRUCT_GET|SET fieldIdx=0).
  emitRefCellNew(): void {
    throw new Error("BytecodeEmitter: ref-cell ops not yet wired — see §2a struct/object family (STRUCT_NEW).");
  }
  emitRefCellGet(): void {
    throw new Error("BytecodeEmitter: ref-cell ops not yet wired — see §2a struct/object family (STRUCT_GET).");
  }
  emitRefCellSet(): void {
    throw new Error("BytecodeEmitter: ref-cell ops not yet wired — see §2a struct/object family (STRUCT_SET).");
  }
}
