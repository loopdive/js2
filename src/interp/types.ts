// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3101 / E1 — the WasmGC struct layouts, authored as TS classes so js2wasm
// (E2) lowers each to a `struct`. Field order is the frozen ABI from #3101's
// "Types (WasmGC)" section — do NOT reorder `$Frame`'s fields without
// coordinating with #2864 (the generator/async carrier shares it).
//
// ── Value representation (design constraint 1, normative) ─────────────────────
// Every operand — accumulator, register, const-pool entry, EnvRec slot — holds
// the AOT boxed-any substrate. In this Node-authored source that is TypeScript
// `any` (a real JS value); when js2wasm self-compiles the library it is the
// `anyref`/`$Object` rep the AOT path already produces. There are NO
// interpreter-private value kinds, and `ref.eq` identity crosses the boundary by
// construction. `JSValue` is the alias for that boxed-any type.
export type JSValue = any;

/** A per-frame register file: `array (mut anyref)` in WasmGC. */
export type Regs = JSValue[];

/** The bytecode stream: `array (mut i32)` in WasmGC (integer-valued `number[]`
 *  in Node — every packed word is a ≤32-bit integer, f64-exact; the loop reads
 *  it back with `& 0x7f` / `>>> shift` which coerce to i32 in js2wasm). */
export type BcArray = number[];

/** The boxed-any constant pool: `array (mut anyref)` — literals, property/name
 *  strings, and nested `FuncMeta` for function declarations/expressions. */
export type ConstPool = JSValue[];

/** The side exception table: a flat `array (mut i32)`, four ints per row —
 *  `[startPC, endPC, handlerPC, handlerReg]`. A `Throw` (or a host throw caught
 *  by the loop) consults it for the innermost row whose `[startPC, endPC)`
 *  covers the throwing PC, writes the caught value into `regs[handlerReg]`, and
 *  jumps to `handlerPC`. Half-open interval; rows are stored innermost-last so a
 *  linear scan finds the tightest cover (see loop.ts). */
export type ExnTable = number[];

/** Width of one exception-table row (`[startPC, endPC, handlerPC, handlerReg]`). */
export const EXN_ROW = 4;

// FuncMeta flag bits (the `flags` i32). bit1/bit2 are reserved for #2929.
export const FLAG_STRICT = 1; //      bit0 — the function body is strict-mode
export const FLAG_GENERATOR = 2; //   bit1 — reserved (#2929)
export const FLAG_ASYNC = 4; //       bit2 — reserved (#2929)
export const FLAG_SCRIPT = 8; //      E1 addition: this FuncMeta is a Script/eval
//                                    body, so the final expression statement's
//                                    completion value is returned (§ completion
//                                    semantics) rather than dropped.
export const FLAG_CLASS_CONSTRUCTOR = 16; // class constructors reject ordinary Call
export const FLAG_RUNTIME_EVAL = 32; // provider-owned realm `%eval%` closure
export const FLAG_RUNTIME_FUNCTION = 64; // provider-owned realm `%Function%` closure

/**
 * `$FuncMeta` — the immutable metadata for one interpreted function (or the
 * top-level script/eval body). Produced by the emitter, consumed by the loop.
 * Nested functions live as further `FuncMeta` values in the enclosing pool.
 */
export class FuncMeta {
  /** `code` — the packed bytecode stream (`array (mut i32)`). */
  code: BcArray;
  /** `consts` — the boxed-any constant pool (literals, names, nested FuncMeta). */
  consts: ConstPool;
  /** `regCount` — size of a frame's register file for this function. */
  regCount: number;
  /** `paramCount` — declared parameter count (params occupy regs[1..1+paramCount)). */
  paramCount: number;
  /** `exnTable` — the flat exception table (null when the body has no try). */
  exnTable: ExnTable | null;
  /** `name` — `Function.prototype.name` (a string, or undefined). */
  name: JSValue;
  /** `flags` — strict / generator* / async* / script bits (see FLAG_*). */
  flags: number;

  constructor(
    code: BcArray,
    consts: ConstPool,
    regCount: number,
    paramCount: number,
    exnTable: ExnTable | null,
    name: JSValue,
    flags: number,
  ) {
    this.code = code;
    this.consts = consts;
    this.regCount = regCount;
    this.paramCount = paramCount;
    this.exnTable = exnTable;
    this.name = name;
    this.flags = flags;
  }
}

// EnvRec kinds (the `kind` i32).
export const ENV_DECLARATIVE = 0; // declarative record (name→slot map + slots)  — #2925/#2929
export const ENV_OBJECT = 1; //      object record over an arbitrary $Object     — `with` (#2929)
export const ENV_GLOBAL = 2; //      global record wrapping globalThis            — Phase 1

/** Private shared-global slot carrying `[name, EvalBindingCell, ...]` for the
 * declarative half of GlobalEnvironmentRecord. Keep byte-for-byte aligned
 * with the caller-side codegen constant; this is data, not a function ABI. */
export const RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY = "__js2wasm_runtime_eval_global_lexical_cells__";

/**
 * One mutable boxed binding shared by AOT code and the interpreter.
 *
 * Direct-eval functions re-use the compiler's mutable-capture cell lowering,
 * but deliberately give every eval-visible cell the universal `JSValue` field
 * type. The caller and separately compiled runtime-eval provider therefore
 * emit the same one-field WasmGC struct, which Core Wasm canonicalises across
 * the module boundary. `StName` updates the exact cell later AOT identifier
 * reads dereference; there is no copy-back shadow environment.
 */
export interface EvalBindingCell {
  value: JSValue;
}

/**
 * `$EnvRec` — one link in the lexical environment-record chain (doc §14, shared
 * with #2925/#2864 — coordinate, do not fork). Phase 1 (this slice) only ever
 * constructs the **global** record (`kind = ENV_GLOBAL`, `backing = globalThis`,
 * `names`/`slots` null); the declarative-record internals (name-map carrier +
 * mutable slots) land with #2925/#2929. `LdName`/`StName` walk `parent` links.
 */
export class EnvRec {
  /** `kind` — declarative | object | global (see ENV_*). */
  kind: number;
  /** `parent` — the lexical parent record (null at the root). */
  parent: EnvRec | null;
  /** `names` — declarative/global-lexical: the name→slot map carrier. */
  names: JSValue;
  /** `slots` — declarative/global-lexical: mutable boxed slots; else null. */
  slots: Regs | null;
  /** `backing` — object/global: the backing `$Object` (globalThis for global). */
  backing: JSValue;

  constructor(kind: number, parent: EnvRec | null, names: JSValue, slots: Regs | null, backing: JSValue) {
    this.kind = kind;
    this.parent = parent;
    this.names = names;
    this.slots = slots;
    this.backing = backing;
  }
}

/**
 * `$Frame` — one activation record. FROZEN field order (coordinate with #2864
 * before changing): `{ meta, pc, regs, envRec, parent }`. The dispatch loop
 * caches `pc`/`regs`/`code`/`consts` in Wasm locals and writes `pc` back only at
 * `Call` / cross-boundary `Throw` / `Return` (and, later, suspension). `parent`
 * is the CALLER frame — for stack traces / suspension, NOT control flow (control
 * flow is the explicit frame stack in the loop).
 */
export class Frame {
  /** `meta` — the function being executed. */
  meta: FuncMeta;
  /** `pc` — the program counter (index into `meta.code`). */
  pc: number;
  /** `regs` — this activation's register file (`length === meta.regCount`). */
  regs: Regs;
  /** `envRec` — the §14 chain head (Phase 1: the global record). */
  envRec: EnvRec | null;
  /** `parent` — the caller frame (debug/stack traces / suspension). */
  parent: Frame | null;

  constructor(meta: FuncMeta, pc: number, regs: Regs, envRec: EnvRec | null, parent: Frame | null) {
    this.meta = meta;
    this.pc = pc;
    this.regs = regs;
    this.envRec = envRec;
    this.parent = parent;
  }
}
