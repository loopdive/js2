// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4077 / #4157) The EXACT forward stack model used for call-argument
 * attribution, shared by `fixups.ts` and `stack-balance.ts`.
 *
 * Extracted verbatim from `fixups.ts` (#4077) with no behavioural change so a
 * SECOND consumer can use it: `stack-balance.ts`'s call-argument coercion is a
 * BACKWARD walk that stops dead at any `if`/`block`/`loop` between an
 * argument's producer and its call, and the #4157 tuned set introduces exactly
 * such shapes (`smi-box-fast-path.ts` inserts an `if`, `ir-inline.ts` a
 * `block`). See `repairCrossHierarchyCallArgs` there for what that cost.
 *
 * The model is deliberately PARTIAL: it stops at the first instruction it
 * refuses to model and every call recorded up to that point is still exact.
 */

import type { FuncTypeDef, Instr, WasmModule } from "../ir/types.js";
import { absoluteFuncIndexCached } from "../emit/resolve-layout.js"; // (#1916 S3)

/**
 * (#4077) EXACT (pops, pushes) for a single instruction.
 *
 * Deliberately NOT the same thing as {@link instrStackDelta}, which returns the
 * NET delta and is documented as "a conservative approximation". Net delta
 * cannot distinguish a pure consumer from a value-producing consumer — `drop`
 * and `i32.add` both net -1 — and that distinction is exactly what argument
 * attribution needs. Returns `null` for any instruction whose effect we refuse
 * to model (terminators, `end`, anything unknown); callers must treat `null` as
 * "cannot model this region".
 */
export function instrPopsPushes(instr: Instr, mod: WasmModule): { pops: number; pushes: number } | null {
  const op = instr.op as string;
  if (OPERAND_DEPENDENT_EFFECT_OPS.has(op)) return computeInstrPopsPushes(instr, mod);
  // (#6759) Every other op's effect is a function of the opcode alone, so the
  // regex ladder below runs once per distinct opcode per process instead of
  // once per instruction. Cached results are frozen: callers only read them.
  let effect = OPCODE_EFFECT_CACHE.get(op);
  if (effect === undefined) {
    effect = computeInstrPopsPushes(instr, mod);
    if (effect) Object.freeze(effect);
    OPCODE_EFFECT_CACHE.set(op, effect);
  }
  return effect;
}

/** Ops whose (pops, pushes) read an immediate or the module's type/function tables. */
const OPERAND_DEPENDENT_EFFECT_OPS: ReadonlySet<string> = new Set([
  "struct.new",
  "array.new_fixed",
  "call",
  "call_ref",
  "call_indirect",
  "block",
  "loop",
  "try",
  "try_table",
  "if",
]);
const OPCODE_EFFECT_CACHE = new Map<string, { readonly pops: number; readonly pushes: number } | null>();

function computeInstrPopsPushes(instr: Instr, mod: WasmModule): { pops: number; pushes: number } | null {
  const op = instr.op as string;

  // (#6759) Operand-dependent ops first — `instrPopsPushes` caches every other
  // op, so these are the per-instruction path. Every test here is an exact
  // opcode match that no later pattern can also match, so order is immaterial.
  if (op === "struct.new") {
    const typeIdx = (instr as { typeIdx: number }).typeIdx;
    const t = mod.types[typeIdx];
    if (!t || t.kind !== "struct") return null;
    return { pops: t.fields.length, pushes: 1 };
  }
  if (op === "array.new_fixed") {
    const len = (instr as { length?: number }).length;
    if (typeof len !== "number") return null;
    return { pops: len, pushes: 1 };
  }

  if (op === "call") {
    const ft = callTargetFuncType(instr, mod);
    if (!ft) return null;
    return { pops: ft.params.length, pushes: ft.results.length };
  }
  if (op === "call_ref" || op === "call_indirect") {
    const typeIdx = (instr as { typeIdx?: number }).typeIdx;
    if (typeIdx === undefined) return null;
    const ft = mod.types[typeIdx];
    if (!ft || ft.kind !== "func") return null;
    // call_ref pops the funcref, call_indirect pops the table index.
    return { pops: ft.params.length + 1, pushes: ft.results.length };
  }

  // Structured blocks: exact, from the block type. `if` additionally pops the
  // condition. The nested bodies are separate instruction lists and are walked
  // on their own, so from this list's point of view the block is one opaque
  // instruction with a known signature.
  if (op === "block" || op === "loop" || op === "try" || op === "try_table" || op === "if") {
    const condPop = op === "if" ? 1 : 0;
    const bt = (instr as { blockType?: { kind: string; typeIdx?: number } }).blockType;
    if (!bt || bt.kind === "empty") return { pops: condPop, pushes: 0 };
    if (bt.kind === "val") return { pops: condPop, pushes: 1 };
    if (bt.kind === "type" && bt.typeIdx !== undefined) {
      const ft = mod.types[bt.typeIdx];
      if (!ft || ft.kind !== "func") return null;
      return { pops: condPop + ft.params.length, pushes: ft.results.length };
    }
    return null;
  }

  // Pure pushers.
  if (
    op === "i32.const" ||
    op === "i64.const" ||
    op === "f32.const" ||
    op === "f64.const" ||
    op === "v128.const" ||
    op === "local.get" ||
    op === "global.get" ||
    op === "ref.null" ||
    op === "ref.null.extern" ||
    op === "ref.null.eq" ||
    op === "ref.null.func" ||
    op === "ref.func" ||
    op === "memory.size"
  ) {
    return { pops: 0, pushes: 1 };
  }

  if (op === "nop") return { pops: 0, pushes: 0 };

  // Pure consumers.
  if (op === "drop" || op === "local.set" || op === "global.set" || op === "br_if") {
    return { pops: 1, pushes: 0 };
  }
  if (op === "struct.set") return { pops: 2, pushes: 0 };
  if (op === "array.set") return { pops: 3, pushes: 0 };
  if (op === "array.fill") return { pops: 4, pushes: 0 };
  if (op === "array.copy") return { pops: 5, pushes: 0 };
  if (op.endsWith(".store") || /\.store(8|16|32)$/.test(op)) return { pops: 2, pushes: 0 };

  // Unary transformers (pop 1, push 1).
  if (
    op === "local.tee" ||
    op === "ref.as_non_null" ||
    op === "ref.cast" ||
    op === "ref.cast_null" ||
    op === "ref.test" ||
    op === "ref.is_null" ||
    op === "ref.i31" ||
    op === "i31.get_s" ||
    op === "any.convert_extern" ||
    op === "extern.convert_any" ||
    op === "array.len" ||
    op === "array.new_default" ||
    op === "struct.get" ||
    op === "memory.grow" ||
    op === "v128.not" ||
    op === "v128.any_true" ||
    op === "i32.eqz" ||
    op === "i64.eqz" ||
    op === "i32.clz" ||
    op.endsWith(".splat") ||
    op.endsWith(".all_true") ||
    op.endsWith(".bitmask") ||
    op.includes(".extract_lane") ||
    op.endsWith(".load") ||
    /\.load(8|16|32|64)(_[su]|_splat|_zero)?$/.test(op) ||
    /^f(32|64)\.(abs|neg|floor|ceil|trunc|nearest|sqrt|promote_f32|demote_f64|convert_i(32|64)_[su]|reinterpret_i(32|64))$/.test(
      op,
    ) ||
    /^i(32|64)\.(trunc_f64_[su]|trunc_sat_f64_[su]|extend_i32_[su]|wrap_i64|reinterpret_f(32|64))$/.test(op) ||
    op === "f32.reinterpret_i32" ||
    op === "f32.demote_f64"
  ) {
    return { pops: 1, pushes: 1 };
  }

  // Ternary producers.
  if (op === "select" || op === "v128.bitselect") return { pops: 3, pushes: 1 };

  // Binary producers (pop 2, push 1).
  if (
    op === "ref.eq" ||
    op === "array.new" ||
    op === "array.get" ||
    op === "array.get_s" ||
    op === "array.get_u" ||
    op === "i8x16.swizzle" ||
    op === "i8x16.shuffle" ||
    op.includes(".replace_lane") ||
    /^(i32|i64|f32|f64)\.(add|sub|mul|div|div_s|div_u|rem_s|rem_u|and|or|xor|shl|shr_s|shr_u|eq|ne|lt|le|gt|ge|lt_s|le_s|gt_s|ge_s|lt_u|le_u|gt_u|ge_u|min|max|copysign)$/.test(
      op,
    ) ||
    /^(i8x16|i16x8|i32x4|i64x2|f32x4|f64x2|v128)\.(add|sub|mul|div|eq|ne|lt_s|gt_s|shl|shr_s|shr_u|max_u|min_u|and|andnot|or|xor)$/.test(
      op,
    )
  ) {
    return { pops: 2, pushes: 1 };
  }

  // Terminators, `end`, and anything unrecognised: refuse to model.
  return null;
}

/** Resolve the {@link FuncTypeDef} a `call`/`return_call` instruction targets. */
/**
 * (#4423) Func-import type indices, cached per module.
 *
 * `callTargetFuncType` runs per call instruction and did TWO O(imports) passes
 * every time: a `.filter()` that allocated a whole array merely to count the
 * func imports, then a second linear scan to find the n-th one. A CPU profile
 * of a 512-function compile put it at 2.4% of total compile time.
 *
 * Keyed on `mod.imports.length` because imports are **append-only** —
 * `addImport` pushes, and the index fixups renumber `global.get`/`global.set`
 * operands without adding or removing entries. So an unchanged length means an
 * unchanged import list, and the cache cannot go stale while remaining valid
 * for the common case of many calls between two import additions.
 */
const funcImportTypeIdxCache = new WeakMap<WasmModule, { len: number; typeIdxs: (number | undefined)[] }>();

function funcImportTypeIdxs(mod: WasmModule): (number | undefined)[] {
  const hit = funcImportTypeIdxCache.get(mod);
  if (hit && hit.len === mod.imports.length) return hit.typeIdxs;
  const typeIdxs: (number | undefined)[] = [];
  for (const imp of mod.imports) {
    const desc = (imp as { desc?: { kind?: string; typeIdx?: number } }).desc;
    if (desc?.kind === "func") typeIdxs.push(desc.typeIdx);
  }
  funcImportTypeIdxCache.set(mod, { len: mod.imports.length, typeIdxs });
  return typeIdxs;
}

export function callTargetFuncType(instr: Instr, mod: WasmModule): FuncTypeDef | null {
  const rawFuncIdx = (instr as { funcIdx?: number }).funcIdx;
  if (rawFuncIdx === undefined) return null;
  const importTypeIdxs = funcImportTypeIdxs(mod);
  const numImports = importTypeIdxs.length;
  // (#1916 S3) normalize a possibly-stable handle to the absolute index.
  const funcIdx = absoluteFuncIndexCached(mod, numImports, rawFuncIdx);
  const typeIdx = funcIdx < numImports ? importTypeIdxs[funcIdx] : mod.functions[funcIdx - numImports]?.typeIdx;
  if (typeIdx === undefined) return null;
  const ft = mod.types[typeIdx];
  return ft && ft.kind === "func" ? (ft as FuncTypeDef) : null;
}

/**
 * (#4077) Map every `call` / `return_call` in a LINEAR instruction list to the
 * instruction index that finally produces each of its arguments.
 *
 * WHY THIS EXISTS — the bug it replaces. The previous implementation walked
 * *backwards* from the call and assumed "one instruction == one argument",
 * with a hand-maintained exception list (`local.tee`, `struct.new`,
 * `array.new_fixed`, `call`). Every stack-neutral op missing from that list
 * burned one parameter index and shifted the whole pairing by one. Concretely,
 * `extern.convert_any` — which codegen emits on essentially every boxed
 * argument — was absent, so in
 *
 *     call $obj ; global.get $str ; ref.null.extern ; struct.new $closure ;
 *     extern.convert_any ; call $f
 *
 * the walk paired `ref.null.extern` (argument 2, an `externref` parameter)
 * with parameter *1* (a `(ref null $AnyString)`) and rewrote it to
 * `ref.null $AnyString`. The module then failed Wasm validation with
 * `call[2] expected type externref, found ref.null of type (ref null 6)` and
 * the whole file lost every assertion. This is the same shape as #3989: two
 * halves that must agree about a slot's type living apart and drifting.
 *
 * The exception list is not fixable by adding one more op — `f(null, a + b)`
 * mis-paired too, and always had. So this models the stack for real: a single
 * forward pass carrying a producer-index per stack slot. Slot attribution
 * rules:
 *   - a producing instruction (pushes >= 1) owns every slot it pushes;
 *   - a stack-neutral transformer (pop 1 / push 1, e.g. `local.tee`,
 *     `extern.convert_any`, `ref.cast`) therefore owns the slot it rewrites —
 *     we deliberately do NOT see through it, because the value's type at the
 *     call is the transformer's output type, not the underlying producer's.
 *
 * The result is deliberately PARTIAL: the walk stops at the first instruction
 * it refuses to model (an unrecognised op, a terminator such as `return`/`br`,
 * or a stack underflow), and every call recorded up to that point is still
 * exact. Calls absent from the map fall back to the legacy backwards walk, so
 * this pass can never rewrite fewer call sites than it did before.
 */
export function locateCallArgProducers(instrs: Instr[], mod: WasmModule): Map<number, number[]> {
  return locateOperandProducers(instrs, mod, isCallConsumer);
}

function isCallConsumer(op: string): boolean {
  return op === "call" || op === "return_call";
}

/**
 * (#4157 park 6) The same forward model, generalised to EVERY consumer.
 *
 * `locateCallArgProducers` is the `call`-only view of this. The generalisation
 * exists because `local.set` / `local.tee` / `global.set` have exactly the same
 * attribution problem and were repaired by an even weaker rule — "look at
 * `body[i - 1]`" (`fixLocalSetCoercion` in `stack-balance.ts`) — which is wrong
 * the moment the value's producer is not the immediately preceding
 * instruction. That is routine once the #4157 tuned set inserts a guard or an
 * inlined block between the two:
 *
 *     global.get $__mod_c   ;; (ref null $C) — the value the local.set consumes
 *     call $C_2             ;; devirtualised 0-param method, pushes f64
 *     …guard/inlined block consuming the f64…
 *     local.set $x          ;; externref local — `body[i-1]` is NOT the producer
 *
 * Returns, for each instruction index it could model, the producer index of
 * every value that instruction POPS, bottom-of-stack first. Partial by the same
 * rule as the call-only view: it stops at the first instruction it refuses to
 * model, and everything recorded up to there is exact.
 */
export function locateOperandProducers(
  instrs: Instr[],
  mod: WasmModule,
  record?: (op: string) => boolean,
): Map<number, number[]> {
  const producers: number[] = []; // one entry per live stack slot
  const out = new Map<number, number[]>();
  for (let i = 0; i < instrs.length; i++) {
    const instr = instrs[i]!;
    if (instr.op === "return_call") {
      // A tail call is a terminator (the stack after it is polymorphic), so
      // `instrPopsPushes` refuses it — but its arguments are exact. Record them
      // and stop: otherwise every `return_call` fell back to the one-instruction-
      // per-argument backward walk, which mis-pairs across a `global.set` and
      // retyped an unrelated `ref.null extern` (lodash `baseUpdate`).
      const ft = callTargetFuncType(instr, mod);
      if (ft && ft.params.length <= producers.length && (!record || record(instr.op)))
        out.set(i, producers.slice(producers.length - ft.params.length));
      break;
    }
    const eff = instrPopsPushes(instr, mod);
    if (!eff) break;
    if (eff.pops > producers.length) break; // underflow — cannot model
    // (#6759) `record` only filters which consumers are REPORTED; the walk
    // itself (and so where it stops) is identical for every caller.
    if (eff.pops > 0 && (!record || record(instr.op))) out.set(i, producers.slice(producers.length - eff.pops));
    producers.length -= eff.pops;
    for (let p = 0; p < eff.pushes; p++) producers.push(i);
  }
  return out;
}

/**
 * (#6759) Whether an instruction of this opcode can own nested instruction
 * lists — exactly the structured members of the `Instr` union (`block`,
 * `loop`, `if`, `try`, `try_table`). The whole-module repair walks test
 * this before probing `body`/`then`/`else`/`catches`/`catchAll`: on the
 * hundreds of distinct instruction shapes those probes are megamorphic misses,
 * and they were the largest single cost of the walks. The repairs only ever
 * edit lists the binary emitter encodes, and it encodes nested lists for these
 * opcodes only, so a stray list under any other opcode could not reach the
 * output anyway.
 */
export function ownsInstrArrays(op: string): boolean {
  return op === "block" || op === "loop" || op === "if" || op === "try" || op === "try_table";
}

/**
 * (#6759) Push every nested instruction list a structured instruction owns onto
 * `out` — the non-allocating form of the per-file `nestedBodies` helpers. The
 * whole-module repair passes call this once per instruction, so returning a
 * fresh array (plus a temporary arm array) per call was measurable GC load.
 */
function pushNestedInstrArrays(instr: Instr, out: Instr[][]): void {
  const a = instr as {
    body?: Instr[];
    then?: Instr[];
    else?: Instr[];
    catches?: { body?: Instr[] }[];
    catchAll?: Instr[];
  };
  if (Array.isArray(a.body)) out.push(a.body);
  if (Array.isArray(a.then)) out.push(a.then);
  if (Array.isArray(a.else)) out.push(a.else);
  if (Array.isArray(a.catchAll)) out.push(a.catchAll);
  if (Array.isArray(a.catches)) for (const c of a.catches) if (Array.isArray(c.body)) out.push(c.body);
}

/**
 * Instruction arrays reached from more than one function root. Such an array
 * has no single local namespace, so function-local repairs must decline it.
 * The result does not depend on traversal order: an array is shared iff two
 * distinct functions reach it.
 */
export function crossFunctionInstrArrays(mod: WasmModule): Set<Instr[]> {
  return instrArraySharing(mod).shared;
}

/**
 * (#6759) The instruction-array sharing of a module's function bodies: the
 * cross-function {@link crossFunctionInstrArrays} set, and the few arrays
 * reached more than once by any path (within or across functions). A repair
 * that only inserts or replaces LEAF instructions (and at most drops dead
 * code) adds neither, so one analysis can serve several such repairs in a row.
 */
export interface InstrArraySharing {
  readonly shared: Set<Instr[]>;
  /** Arrays with more than one incoming edge — the only ones a walk can revisit. */
  readonly multiParent: ReadonlySet<Instr[]>;
}

/** Visited-set of a walk over a module or function in which no array has two parents. */
export const TREE_VISITED: WeakSet<Instr[]> = {
  has: () => false,
  add(): WeakSet<Instr[]> {
    return TREE_VISITED;
  },
  delete: () => false,
  [Symbol.toStringTag]: "WeakSet",
};

/**
 * (#6759) A visited-set for one walk that records only the arrays that CAN be
 * revisited — a module typically has tens of multi-parent arrays among tens of
 * thousands, and a single-parent array is reached exactly once, so remembering
 * it is dead weight (a large weak table the collector must also process).
 */
export function visitedFor(sharing: InstrArraySharing): WeakSet<Instr[]> {
  const { multiParent } = sharing;
  if (multiParent.size === 0) return TREE_VISITED;
  const seen = new Set<Instr[]>();
  const visited: WeakSet<Instr[]> = {
    has: (body) => seen.has(body),
    add(body) {
      if (multiParent.has(body)) seen.add(body);
      return visited;
    },
    delete: (body) => seen.delete(body),
    [Symbol.toStringTag]: "WeakSet",
  };
  return visited;
}

export function instrArraySharing(mod: WasmModule): InstrArraySharing {
  type Func = WasmModule["functions"][number];
  // `owners` doubles as the per-function "seen" set: an array owned by the
  // function being walked was necessarily first reached by this walk, so
  // reaching it again is a revisit. Only foreign-owned (i.e. shared) arrays
  // need a separate per-function seen set, allocated on first need.
  const owners = new WeakMap<Instr[], Func>();
  const shared = new Set<Instr[]>();
  const multiParent = new Set<Instr[]>();
  const pending: Instr[][] = [];
  for (const func of mod.functions) {
    let seenForeign: Set<Instr[]> | undefined;
    pending.push(func.body);
    while (pending.length > 0) {
      const body = pending.pop()!;
      const owner = owners.get(body);
      if (owner === undefined) owners.set(body, func);
      else {
        multiParent.add(body);
        if (owner === func) continue;
        if (seenForeign?.has(body)) continue;
        (seenForeign ??= new Set()).add(body);
        shared.add(body);
      }
      for (const instr of body) if (ownsInstrArrays(instr.op)) pushNestedInstrArrays(instr, pending);
    }
  }
  return { shared, multiParent };
}
