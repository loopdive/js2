// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Constant folding for the middle-end IR — part of Phase 3a (#1167a).
//
// Two classes of rewrites:
//
//   1. `binary(const, const)` / `unary(const)` → `const <computed>`.
//      The instruction keeps its result IrValueId; only the `kind` +
//      operands are replaced with `{ kind: "const", value: <computed> }`.
//      Downstream uses of the result ID keep working with no rename.
//
//   2. `br_if(const cond, A, B)` → `br(A)` or `br(B)`.
//      A constant condition collapses the branch to an unconditional `br`.
//      The dead side becomes unreachable — `deadCode` removes it next.
//
// The pass walks block.instrs linearly, building up a value-id → IrConst
// map as it goes. Use-def information is NOT persistent — we rebuild the
// const-def map every call (see `lower.ts:293-326` `collectIrUses` /
// `collectTerminatorUses` for the same pattern).
//
// Opcode-specific folding goes through a dispatch table (see
// `BINARY_FOLD_TABLE`) so new Wasm ops can be added without bloating a
// single switch.
//
// `raw.wasm` is opaque — CF never rewrites it and never reads through it.

import {
  type IrBinop,
  type IrBlock,
  type IrConst,
  type IrFunction,
  type IrInstr,
  type IrInstrBinary,
  type IrInstrStringConcat,
  type IrInstrStringConst,
  type IrInstrUnary,
  type IrTerminator,
  type IrType,
  type IrUnop,
  type IrValueId,
  mapNestedBuffers,
} from "../nodes.js";
import type { AllocSiteRegistry } from "../alloc-registry.js";
import { retireAllocsIn } from "./alloc-discipline.js";

/**
 * Fold constant `prim`/`br_if` instructions. Returns the same reference
 * when no changes are made.
 */
export function constantFold(fn: IrFunction, registry?: AllocSiteRegistry): IrFunction {
  // Seed the const-def map from every existing `const` instruction. The
  // seed is global across blocks — inter-block constant references are
  // valid in Phase 2+ IR, so folding needs to see them.
  const constDefs = new Map<IrValueId, IrConst>();
  const stringDefs = new Map<IrValueId, IrInstrStringConst>();
  for (const block of fn.blocks) {
    for (const instr of block.instrs) {
      if (instr.kind === "const" && instr.result !== null) {
        constDefs.set(instr.result, instr.value);
      }
      if (instr.kind === "string.const" && instr.result !== null) {
        stringDefs.set(instr.result, instr);
      }
    }
  }

  let changed = false;

  // Fold one instr against `scope`, recording any new top-level const it folds
  // into back into `scope`, and recursively folding inside its nested buffers
  // (#1925). Buffers get a CHILD scope (a clone of `scope`): a const defined
  // inside a buffer is visible to later instrs in that buffer and its nested
  // buffers, but must NOT leak to siblings after the buffer — a `const` inside a
  // loop/if body does not dominate code following it. Valid structured IR only
  // references already-defined values, so inheriting the parent scope is sound.
  const foldInstr = (
    instr: IrInstr,
    scope: Map<IrValueId, IrConst>,
    stringScope: Map<IrValueId, IrInstrStringConst>,
  ): IrInstr => {
    // 0. A pre-existing `const` is visible to later ops in this scope. Top-level
    // consts are already globally pre-seeded; this records buffer-interior ones
    // (which are NOT pre-seeded) so a `binary(const, const)` later in the same
    // buffer can fold.
    if (instr.kind === "const" && instr.result !== null && !scope.has(instr.result)) {
      scope.set(instr.result, instr.value);
    }
    if (instr.kind === "string.const" && instr.result !== null && !stringScope.has(instr.result)) {
      stringScope.set(instr.result, instr);
    }
    // 1. Fold this instr's own operands (binary/unary → const).
    let rewritten = tryFoldInstr(instr, scope, stringScope);
    if (rewritten !== instr) {
      changed = true;
      if (instr.alloc !== undefined && rewritten.alloc === undefined) {
        retireAllocsIn(instr, registry);
      }
      if (rewritten.kind === "const" && rewritten.result !== null) {
        scope.set(rewritten.result, rewritten.value);
      }
      if (rewritten.kind === "string.const" && rewritten.result !== null) {
        stringScope.set(rewritten.result, rewritten);
      }
    }
    // 2. Recurse into nested buffers (loop/if/for-of/try) with a child scope.
    rewritten = mapNestedBuffers(rewritten, (buffer) => foldBuffer(buffer, scope, stringScope));
    if (rewritten !== instr) changed = true;
    return rewritten;
  };

  // Fold a buffer in order under a child scope cloned from `parent`. Returns the
  // same array reference when nothing inside changed (so mapNestedBuffers can
  // preserve instr identity up the chain).
  const foldBuffer = (
    buffer: readonly IrInstr[],
    parent: Map<IrValueId, IrConst>,
    stringParent: Map<IrValueId, IrInstrStringConst>,
  ): readonly IrInstr[] => {
    const child = new Map(parent);
    const stringChild = new Map(stringParent);
    let bufChanged = false;
    const out: IrInstr[] = [];
    for (const instr of buffer) {
      const folded = foldInstr(instr, child, stringChild);
      if (folded !== instr) bufChanged = true;
      out.push(folded);
    }
    return bufChanged ? out : buffer;
  };

  const newBlocks: IrBlock[] = fn.blocks.map((block) => {
    const newInstrs: IrInstr[] = [];
    let blockChanged = false;
    for (const instr of block.instrs) {
      const rewritten = foldInstr(instr, constDefs, stringDefs);
      if (rewritten !== instr) blockChanged = true;
      newInstrs.push(rewritten);
    }

    const newTerm = tryFoldTerminator(block.terminator, constDefs);
    if (newTerm !== block.terminator) changed = true;

    if (!blockChanged && newTerm === block.terminator) {
      // Nothing changed in this block.
      return block;
    }
    return {
      id: block.id,
      blockArgs: block.blockArgs,
      blockArgTypes: block.blockArgTypes,
      instrs: blockChanged ? newInstrs : block.instrs,
      terminator: newTerm,
    };
  });

  if (!changed) return fn;
  return {
    ...fn,
    blocks: newBlocks,
  };
}

// ---------------------------------------------------------------------------
// Instruction folding
// ---------------------------------------------------------------------------

function tryFoldInstr(
  instr: IrInstr,
  constDefs: ReadonlyMap<IrValueId, IrConst>,
  stringDefs: ReadonlyMap<IrValueId, IrInstrStringConst>,
): IrInstr {
  if (instr.kind === "binary") return tryFoldBinary(instr, constDefs);
  if (instr.kind === "unary") return tryFoldUnary(instr, constDefs);
  if (instr.kind === "string.concat") return tryFoldStringConcat(instr, stringDefs);
  // (#1392) `if` is value-producing but its arms are sequences of IR
  // instrs, not constants. We DON'T fold the arms themselves here (the
  // arm buffers hold their own instrs that constant-fold can be re-run
  // on as a follow-up pass). However, when the cond is a known const,
  // we COULD collapse to one branch — left as a future optimization.
  // Leaving the if-instr unmodified preserves correctness; we miss the
  // dead-arm DCE opportunity but the lowerer still emits valid Wasm.
  return instr;
}

function tryFoldBinary(instr: IrInstrBinary, constDefs: ReadonlyMap<IrValueId, IrConst>): IrInstr {
  const l = constDefs.get(instr.lhs);
  const r = constDefs.get(instr.rhs);
  if (!l || !r) return instr;
  const folded = foldBinary(instr.op, l, r, instr.resultType);
  if (!folded) return instr;
  return {
    kind: "const",
    value: folded,
    result: instr.result,
    resultType: instr.resultType,
    site: instr.site,
  };
}

function tryFoldStringConcat(
  instr: IrInstrStringConcat,
  stringDefs: ReadonlyMap<IrValueId, IrInstrStringConst>,
): IrInstr {
  const lhs = stringDefs.get(instr.lhs);
  const rhs = stringDefs.get(instr.rhs);
  if (!lhs || !rhs) return instr;
  return {
    kind: "string.const",
    value: lhs.value + rhs.value,
    result: instr.result,
    resultType: instr.resultType,
    ...(instr.site === undefined ? {} : { site: instr.site }),
    // A concat and its value-preserving literal replacement are both string
    // allocations. Keep the stable allocation identity so registry hygiene
    // and later ownership passes observe one continuous site.
    ...(instr.alloc === undefined ? {} : { alloc: instr.alloc }),
  };
}

function tryFoldUnary(instr: IrInstrUnary, constDefs: ReadonlyMap<IrValueId, IrConst>): IrInstr {
  const o = constDefs.get(instr.rand);
  if (!o) return instr;
  const folded = foldUnary(instr.op, o);
  if (!folded) return instr;
  return {
    kind: "const",
    value: folded,
    result: instr.result,
    resultType: instr.resultType,
    site: instr.site,
  };
}

// ---------------------------------------------------------------------------
// Terminator folding
// ---------------------------------------------------------------------------

function tryFoldTerminator(t: IrTerminator, constDefs: ReadonlyMap<IrValueId, IrConst>): IrTerminator {
  if (t.kind !== "br_if") return t;
  const cond = constDefs.get(t.condition);
  if (cond === undefined) return t;
  const truthy = isConstTruthy(cond);
  if (truthy === null) return t; // unknown truthiness (e.g., f64 NaN edge case)
  const taken = truthy ? t.ifTrue : t.ifFalse;
  return { kind: "br", branch: taken, site: t.site };
}

/**
 * Extract a boolean from a const used as a `br_if` condition. `br_if`
 * conditions are i32 — `null` means we can't decide (shouldn't happen in
 * well-typed IR, but being defensive).
 */
function isConstTruthy(c: IrConst): boolean | null {
  switch (c.kind) {
    case "bool":
      return c.value;
    case "i32":
      return c.value !== 0;
    case "f64":
      // Wasm br_if expects i32; f64-typed conditions shouldn't reach here in
      // well-typed IR. If they do, treat as undecidable.
      return null;
    case "i64":
    case "f32":
    case "null":
    case "undefined":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Opcode dispatch tables
// ---------------------------------------------------------------------------

type BinaryFolder = (l: IrConst, r: IrConst, resultType: IrType | null) => IrConst | null;

const BINARY_FOLD_TABLE: Readonly<Record<IrBinop, BinaryFolder>> = {
  // f64 arithmetic — IEEE-754 semantics match JS number math, so plain
  // JS operators give the right result including NaN / Infinity cases.
  "f64.add": (l, r) => f64Arith(l, r, (a, b) => a + b),
  "f64.sub": (l, r) => f64Arith(l, r, (a, b) => a - b),
  "f64.mul": (l, r) => f64Arith(l, r, (a, b) => a * b),
  "f64.div": (l, r) => f64Arith(l, r, (a, b) => a / b),
  // Preserve the sign bit of NaN as well as ordinary numbers. The constant
  // lattice does not retain NaN payload/sign bits, so leave this to Wasm.
  "f64.copysign": () => null,
  // f64 comparison → bool. JS comparison returns the right values for NaN
  // (always false) except for f64.ne, which must be true for NaN != NaN.
  "f64.eq": (l, r) => f64Cmp(l, r, (a, b) => a === b),
  "f64.ne": (l, r) => f64Cmp(l, r, (a, b) => a !== b),
  "f64.lt": (l, r) => f64Cmp(l, r, (a, b) => a < b),
  "f64.le": (l, r) => f64Cmp(l, r, (a, b) => a <= b),
  "f64.gt": (l, r) => f64Cmp(l, r, (a, b) => a > b),
  "f64.ge": (l, r) => f64Cmp(l, r, (a, b) => a >= b),
  // i32 comparison (bool === / !==) → bool.
  "i32.eq": (l, r) => i32Cmp(l, r, (a, b) => a === b),
  "i32.ne": (l, r) => i32Cmp(l, r, (a, b) => a !== b),
  // i32 logical (bool && / bool ||, operands are 0|1).
  "i32.and": (l, r) => i32Bool(l, r, (a, b) => a !== 0 && b !== 0),
  "i32.or": (l, r) => i32Bool(l, r, (a, b) => a !== 0 || b !== 0),
  "i64.eq": (l, r) => (l.kind === "i64" && r.kind === "i64" ? { kind: "bool", value: l.value === r.value } : null),
  // (#3758) native i32 arithmetic — only ever emitted (see `ir/from-ast.ts`'s
  // `emitI32PureArithmetic`) for operands already proven int32-range under a
  // guard that keeps the true result f64-exact, so folding via plain JS
  // arithmetic + `| 0` wrap is exact here (see `i32Arith`'s doc comment).
  "i32.add": (l, r) => i32Arith(l, r, (a, b) => a + b),
  "i32.sub": (l, r) => i32Arith(l, r, (a, b) => a - b),
  "i32.mul": (l, r) => i32Arith(l, r, (a, b) => a * b),
  "i64.rem_s": (l, r) => {
    if (l.kind !== "i64" || r.kind !== "i64" || r.value === 0n) return null;
    if (l.value === -(1n << 63n) && r.value === -1n) return null;
    return { kind: "i64", value: l.value % r.value };
  },
  // #1126 Stage 3 — i32 magnitude compares. Signed ops compare values as
  // signed 32-bit integers; unsigned ops as unsigned. We coerce constants
  // to i32 first then compare in the appropriate domain. JS `>>>0` gives
  // the unsigned 32-bit interpretation of an i32 bit pattern.
  "i32.lt_s": (l, r) => i32CmpSigned(l, r, (a, b) => a < b),
  "i32.le_s": (l, r) => i32CmpSigned(l, r, (a, b) => a <= b),
  "i32.gt_s": (l, r) => i32CmpSigned(l, r, (a, b) => a > b),
  "i32.ge_s": (l, r) => i32CmpSigned(l, r, (a, b) => a >= b),
  "i32.lt_u": (l, r) => i32CmpUnsigned(l, r, (a, b) => a < b),
  "i32.le_u": (l, r) => i32CmpUnsigned(l, r, (a, b) => a <= b),
  "i32.gt_u": (l, r) => i32CmpUnsigned(l, r, (a, b) => a > b),
  "i32.ge_u": (l, r) => i32CmpUnsigned(l, r, (a, b) => a >= b),
  // Slice 11 (#1169n) — JS bitwise ops over f64 operands. ToInt32 each
  // operand (JS coerces) and apply the i32 op; result is the int32 value
  // re-coerced to f64. Uses native JS operators which already implement
  // ToInt32 and ToUint32 — so the constants we produce match what the
  // backend would produce at runtime.
  "js.bitand": (l, r, resultType) => jsBitwise(l, r, resultType, (a, b) => a & b),
  "js.bitor": (l, r, resultType) => jsBitwise(l, r, resultType, (a, b) => a | b),
  "js.bitxor": (l, r, resultType) => jsBitwise(l, r, resultType, (a, b) => a ^ b),
  "js.shl": (l, r, resultType) => jsBitwise(l, r, resultType, (a, b) => a << b),
  "js.shr_s": (l, r, resultType) => jsBitwise(l, r, resultType, (a, b) => a >> b),
  // `>>>` returns a Uint32 in JS — wrap explicitly so TS doesn't widen
  // the lambda return to `number` ambiguously, and so the const f64 we
  // produce is the unsigned interpretation.
  "js.shr_u": (l, r, resultType) => jsBitwise(l, r, resultType, (a, b) => a >>> b),
};

function foldBinary(op: IrBinop, l: IrConst, r: IrConst, resultType: IrType | null): IrConst | null {
  return BINARY_FOLD_TABLE[op](l, r, resultType);
}

function foldUnary(op: IrUnop, rand: IrConst): IrConst | null {
  switch (op) {
    case "f64.neg":
      if (rand.kind !== "f64") return null;
      return { kind: "f64", value: -rand.value };
    case "i32.eqz": {
      const v = toI32(rand);
      if (v === null) return null;
      return { kind: "bool", value: v === 0 };
    }
    case "i32.trunc_sat_f64_s": {
      // Slice 12 (#1169o) — saturating f64 → i32. Match Wasm semantics:
      //   NaN → 0, +∞ → INT32_MAX, -∞ → INT32_MIN, otherwise truncate
      //   toward zero with saturation at int32 range.
      if (rand.kind !== "f64") return null;
      const v = rand.value;
      if (Number.isNaN(v)) return { kind: "i32", value: 0 };
      if (v >= 2147483647) return { kind: "i32", value: 2147483647 };
      if (v <= -2147483648) return { kind: "i32", value: -2147483648 };
      return { kind: "i32", value: Math.trunc(v) };
    }
    case "i64.trunc_f64_s":
      if (rand.kind !== "f64" || !Number.isFinite(rand.value) || !Number.isInteger(rand.value)) return null;
      if (rand.value < -(2 ** 63) || rand.value >= 2 ** 63) return null;
      return { kind: "i64", value: BigInt(rand.value) };
    case "f64.convert_i64_s":
      if (rand.kind !== "i64") return null;
      return { kind: "f64", value: Number(rand.value) };
    // (#1392) `ref.is_null` is non-foldable — we don't track ref-typed
    // constants in the IrConst lattice, so we can't statically decide
    // whether a Wasm reference is null at compile time. The runtime
    // Wasm `ref.is_null` instruction handles this dynamically.
    case "ref.is_null":
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Const-operand helpers
// ---------------------------------------------------------------------------

function f64Arith(l: IrConst, r: IrConst, fn: (a: number, b: number) => number): IrConst | null {
  if (l.kind !== "f64" || r.kind !== "f64") return null;
  return { kind: "f64", value: fn(l.value, r.value) };
}

function f64Cmp(l: IrConst, r: IrConst, fn: (a: number, b: number) => boolean): IrConst | null {
  if (l.kind !== "f64" || r.kind !== "f64") return null;
  return { kind: "bool", value: fn(l.value, r.value) };
}

function i32Cmp(l: IrConst, r: IrConst, fn: (a: number, b: number) => boolean): IrConst | null {
  const la = toI32(l);
  const ra = toI32(r);
  if (la === null || ra === null) return null;
  return { kind: "bool", value: fn(la, ra) };
}

function i32Bool(l: IrConst, r: IrConst, fn: (a: number, b: number) => boolean): IrConst | null {
  const la = toI32(l);
  const ra = toI32(r);
  if (la === null || ra === null) return null;
  return { kind: "bool", value: fn(la, ra) };
}

/**
 * (#3758) Fold native i32 arithmetic — WRAPS modulo 2^32 like real
 * `i32.add`/`i32.sub`/`i32.mul`, via `| 0` (JS bitwise ops coerce through
 * ToInt32, matching Wasm i32 wraparound exactly). This must NOT use
 * `i32.trunc_sat_f64_s`-style saturation — that was the exact bug (#3745's
 * revert) this op exists to avoid; the constant folder has to reproduce the
 * same wrap semantics the runtime instruction has, not saturate.
 */
function i32Arith(l: IrConst, r: IrConst, fn: (a: number, b: number) => number): IrConst | null {
  const la = toI32(l);
  const ra = toI32(r);
  if (la === null || ra === null) return null;
  return { kind: "i32", value: fn(la, ra) | 0 };
}

function toI32(c: IrConst): number | null {
  if (c.kind === "i32") return c.value;
  if (c.kind === "bool") return c.value ? 1 : 0;
  return null;
}

/**
 * #1126 Stage 3 — fold a signed i32 magnitude compare over two i32 / bool
 * constants. JS `<`, `<=`, etc. on signed `number`s match Wasm `i32.lt_s`
 * etc. directly because the values fit in [-2^31, 2^31).
 */
function i32CmpSigned(l: IrConst, r: IrConst, fn: (a: number, b: number) => boolean): IrConst | null {
  const la = toI32(l);
  const ra = toI32(r);
  if (la === null || ra === null) return null;
  // Sign-extend by `| 0` to ensure values are interpreted as signed Int32
  // even if a const slipped through with the bit-pattern of a Uint32.
  return { kind: "bool", value: fn(la | 0, ra | 0) };
}

/**
 * #1126 Stage 3 — fold an unsigned i32 magnitude compare. `>>> 0` reads the
 * bit pattern as a Uint32 (range [0, 2^32)); the comparison then works on
 * the unsigned interpretation.
 */
function i32CmpUnsigned(l: IrConst, r: IrConst, fn: (a: number, b: number) => boolean): IrConst | null {
  const la = toI32(l);
  const ra = toI32(r);
  if (la === null || ra === null) return null;
  return { kind: "bool", value: fn(la >>> 0, ra >>> 0) };
}

/**
 * Slice 11 (#1169n) — fold a `js.bit*` op over two f64 constants. JS
 * coerces each operand to ToInt32/ToUint32, applies the i32 op, and the
 * result is a 32-bit integer that we re-coerce to f64 for IR const land.
 *
 * Native JS `&`, `|`, `^`, `<<`, `>>`, `>>>` implement ToInt32/ToUint32 by
 * spec, so applying the JS operator inside the lambda gives a correct
 * result; we just box it back as `kind: "f64"` so downstream IR sees an
 * f64-typed constant matching the result type the lowerer will emit.
 */
function jsBitwise(
  l: IrConst,
  r: IrConst,
  resultType: IrType | null,
  fn: (a: number, b: number) => number,
): IrConst | null {
  const left = jsNumericConst(l);
  const right = jsNumericConst(r);
  if (left === null || right === null || resultType?.kind !== "val") return null;
  const value = fn(left, right);
  if (resultType.val.kind === "f64") return { kind: "f64", value };
  if (resultType.val.kind === "i32") return { kind: "i32", value: value | 0 };
  return null;
}

function jsNumericConst(value: IrConst): number | null {
  if (value.kind === "f64" || value.kind === "i32") return value.value;
  if (value.kind === "bool") return value.value ? 1 : 0;
  return null;
}
