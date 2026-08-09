// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Hoist CONSTANT number boxing to module-level globals.
 *
 * ## What it does
 *
 * `__box_number(f64) -> externref` is the f64→`any` boxing helper. When its
 * operand is a compile-time constant the emitted pair
 *
 *     f64.const K
 *     call $__box_number
 *
 * recomputes the same box on every execution. This pass replaces each such pair
 * with a single `global.get` of a module global that `__module_init` seeds once
 * by calling the very same helper. The `i32.const N; f64.convert_i32_s; call`
 * triple (the `type-coercion.ts` i32→f64→box round trip on a constant) is the
 * same population and is rewritten the same way.
 *
 * ## Why it is sound
 *
 * Measured on the acorn standalone-dynamic self-parse (#4157, 2026-08-07):
 * `__box_number` is called 556,923 times; 99.31 % take #3673's `ref.i31` fast
 * path and allocate nothing, and **every single one of the 3,862 calls that
 * does allocate boxes the constant `Infinity`**. So the population this pass
 * targets is exactly the parse's entire boxed-number allocation stream, plus
 * 689 further constant sites that are i31-able.
 *
 * The only thing hoisting changes is REFERENCE IDENTITY: two boxes of the same
 * constant become one reference. Three facts make that unobservable.
 *
 * 1. **For i31-able constants it is already true.** `ref.i31` is not a heap
 *    object; two `ref.i31` with the same payload are already `ref.eq`-equal
 *    today. 99.31 % of boxing already has shared identity, so hoisting merely
 *    extends the regime that is already load-bearing.
 * 2. **Every consumer that compares boxed numbers compares them BY VALUE, and
 *    is written to do so precisely because distinct boxes of equal values
 *    exist.** `__extern_strict_eq` (any-helpers.ts) takes `ref.eq` as a
 *    fast path but explicitly EXCLUDES the `$BoxedNumber` carrier from it
 *    (#3174) and falls through to `f64.eq`; the standalone `===` tag dispatch
 *    (binary-ops-typed-dispatch.ts, #1776) tries "both typeof number → unbox +
 *    f64 compare" BEFORE any identity arm; `__same_value_zero` (map-runtime.ts)
 *    takes identity ⇒ equal, which is what SameValueZero wants.
 * 3. **Sharing can only turn "two distinct refs" into "one ref", so it can only
 *    flip an identity test from false to true.** For every constant except one
 *    that is the answer the spec already requires (`Infinity === Infinity` is
 *    true; `-0 === -0` is true), so a consumer that trusted `ref.eq` gets *more*
 *    correct, not less.
 *
 * The one exception is **`NaN`**, where `NaN === NaN` must be FALSE even for the
 * same reference — the case #3174 documents. Both `===` paths above handle a
 * self-identical NaN box correctly, but the value is the single one where
 * sharing is a semantic risk rather than a semantic improvement, and it was
 * absent from the measured constant population entirely. So `NaN` is excluded:
 * it buys nothing and it is the only value whose carve-out removes a whole risk
 * class. `+0` and `-0` are keyed apart (`Object.is`), so `-0` never collapses
 * into `+0`.
 *
 * ## Why `__module_init` and not a constant global initializer
 *
 * `ref.i31` / `struct.new` / `extern.convert_any` are all valid constant
 * instructions, so the boxes COULD be built in the global's own init
 * expression. That would require this pass to re-derive #3673's i31-ability
 * rule (integral, in `[-2^30, 2^30-1]`, not `-0`) — a second encoding of a rule
 * that lives in `registerNative("__box_number", …)`, and a silent
 * miscompilation the day the two drift. Seeding by CALLING the helper keeps
 * exactly one boxing implementation in the compiler.
 *
 * The seed block is self-guarded by its own `i32` flag global rather than
 * relying on where it lands relative to `applyModuleInitGuard`'s `__init_done`
 * prologue (which is applied before this pass under WASI and not at all under
 * gc/host, where `__module_init` is the `start` function). Cost is a
 * three-instruction flag test per `__module_init` entry.
 *
 * ## What it is worth
 *
 * The boxed-number allocation stream goes to zero and ~12 % of boxing calls
 * disappear. It is NOT expected to move wall clock: #4157 priced the entire
 * helper — call, checks and all, at 100 % of calls — at ≲2 % of parse, with the
 * sign of a two-thirds-of-the-body probe flipping with run order. This is a
 * deterministic allocation/call result, not a timing one.
 *
 * ## Code size, and why there is no minimum-use threshold
 *
 * Per distinct constant this costs ~21 bytes (a global plus its three seed
 * instructions) and saves ~8 bytes per SITE (a 9-byte `f64.const` plus a 2-byte
 * `call` become a 2–3 byte `global.get`), so it breaks even at about three
 * sites per constant. Acorn averages 14 (697 sites, 49 constants) and its
 * binary shrinks by 1,040 bytes; a toy module with one site per constant grows
 * by tens of bytes.
 *
 * A "only hoist constants used ≥3 times" threshold would remove that growth and
 * is deliberately NOT applied: the site count is STATIC, and the highest-value
 * case in the measured workload is the opposite shape — 12 static `Infinity`
 * sites executing 3,862 times. Gating on static count would trade the actual
 * deliverable (the allocation stream) for bytes on modules too small for the
 * bytes to matter.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { nextModuleGlobalIdx } from "./registry/imports.js";
import { walkChildren } from "./walk-instructions.js";

/** Escape hatch: `JS2WASM_HOIST_CONST_BOXES=0` restores the pre-#4157 emission. */
function enabled(): boolean {
  return process.env.JS2WASM_HOIST_CONST_BOXES !== "0";
}

/**
 * Key a constant by SameValue, not by `===`: `+0` and `-0` are different
 * boxes with different observable behaviour (`1/x`, `Object.is`) and must not
 * share a global.
 */
function constKey(value: number): string {
  if (value === 0) return Object.is(value, -0) ? "-0" : "+0";
  return String(value);
}

/** Every instruction array in a body, including nested `if`/`block`/`loop` arms. */
function everyArray(instrs: Instr[]): Instr[][] {
  const out: Instr[][] = [];
  const stack: Instr[][] = [instrs];
  // Instruction builders may reuse one immutable child array in more than one
  // branch.  The resulting object graph is a DAG even though the emitted Wasm
  // is a tree.  Visiting the shared array once per incoming edge makes this
  // collection exponential (and a malformed cycle would never terminate),
  // while rewriting the array once is both sufficient and required.
  const visited = new WeakSet<Instr[]>();
  while (stack.length > 0) {
    const arr = stack.pop()!;
    if (visited.has(arr)) continue;
    visited.add(arr);
    out.push(arr);
    for (const instr of arr) walkChildren(instr, (child) => stack.push(child));
  }
  return out;
}

interface HoistedConst {
  /** The f64 value the global holds, boxed. */
  value: number;
  /** Absolute Wasm global index. */
  globalIdx: number;
}

/**
 * Replace `f64.const K; call __box_number` (and the equivalent `i32.const N;
 * f64.convert_i32_s; call __box_number`) with a `global.get` of a once-seeded
 * module global.
 *
 * MUST run after every import global has settled (i.e. after
 * `finalizeInModuleInitFlag`) so the module-global range is final, and BEFORE
 * dead elimination, so the `call __box_number` this pass adds to the seed block
 * is remapped along with every other call — the same placement contract
 * `applyModuleInitGuard`'s injected `call __module_init` relies on.
 *
 * No-op when there is no `__box_number`, no compiler-created `__module_init`,
 * or no constant boxing site.
 */
export function hoistConstantBoxedNumbers(ctx: CodegenContext): void {
  if (!enabled()) return;
  const debug = process.env.JS2WASM_HOIST_CONST_BOXES_DEBUG === "1";
  const boxIdx = ctx.funcMap.get("__box_number");
  const initFn = ctx.programAbiModuleInitCallables?.firstFunction();
  if (boxIdx === undefined || !initFn) {
    // Both are ordinary: a module that never boxes an f64 into `any` has no
    // `__box_number`, and one with no top-level state has no `__module_init`
    // to seed from. Say which, so a "why did nothing happen" question is one
    // env var away from an answer.
    if (debug) {
      process.stderr.write(
        `[const-box-hoist] no-op: ${boxIdx === undefined ? "no __box_number" : "no __module_init"}\n`,
      );
    }
    return;
  }

  const hoisted = new Map<string, HoistedConst>();
  const missed = new Map<string, number>();
  let rewrittenSites = 0;

  /**
   * The constant an instruction contributes as the `f64` operand of a boxing
   * call, or `undefined` if it is not a constant producer. `i32.const` only
   * counts through an intervening `f64.convert_i32_s`, which is handled by the
   * caller consuming two instructions.
   */
  const f64ConstValue = (instr: Instr | undefined): number | undefined =>
    instr !== undefined && instr.op === "f64.const" ? instr.value : undefined;

  const i32ConstValue = (instr: Instr | undefined): number | undefined =>
    instr !== undefined && instr.op === "i32.const" ? instr.value : undefined;

  const globalFor = (value: number): number => {
    const key = constKey(value);
    const existing = hoisted.get(key);
    if (existing) return existing.globalIdx;
    const globalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__const_box_${key.replace(/[^A-Za-z0-9_]/g, "_")}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    hoisted.set(key, { value, globalIdx });
    return globalIdx;
  };

  // Collect the arrays first, then rewrite — splicing while walking would make
  // the walk revisit what it just inserted.
  for (const fn of ctx.mod.functions) {
    for (const arr of everyArray(fn.body)) {
      // Cheap pre-filter: most arrays contain no boxing call at all.
      let hit = false;
      for (const instr of arr) {
        if (instr.op === "call" && instr.funcIdx === boxIdx) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;

      const rewritten: Instr[] = [];
      for (const instr of arr) {
        if (!(instr.op === "call" && instr.funcIdx === boxIdx)) {
          rewritten.push(instr);
          continue;
        }
        // `rewritten` holds everything already emitted in this array, so its
        // tail is exactly the boxing call's producer sequence.
        const last = rewritten[rewritten.length - 1];
        const beforeLast = rewritten[rewritten.length - 2];
        let value: number | undefined;
        let consumed = 0;
        const direct = f64ConstValue(last);
        if (direct !== undefined) {
          value = direct;
          consumed = 1;
        } else if (last !== undefined && last.op === "f64.convert_i32_s") {
          const int = i32ConstValue(beforeLast);
          if (int !== undefined) {
            value = int;
            consumed = 2;
          }
        }
        // NaN is the one value whose shared identity is a semantic risk rather
        // than a semantic improvement — see the header. `Number.isNaN` is the
        // right test: it is true only for NaN, and never for `Infinity`.
        if (value === undefined || Number.isNaN(value)) {
          if (debug) {
            const key = `${last?.op ?? "<empty>"}|${beforeLast?.op ?? "<empty>"}`;
            missed.set(key, (missed.get(key) ?? 0) + 1);
          }
          rewritten.push(instr);
          continue;
        }
        rewritten.length -= consumed;
        rewritten.push({ op: "global.get", index: globalFor(value) });
        rewrittenSites++;
      }
      arr.splice(0, arr.length, ...rewritten);
    }
  }

  if (hoisted.size === 0) return;

  // Seed flag — a dedicated i32 rather than a null test on one of the boxes, so
  // "seeded" never depends on `__box_number` being unable to return null.
  const seededIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__const_box_seeded",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });

  const seeds: Instr[] = [
    { op: "i32.const", value: 1 },
    { op: "global.set", index: seededIdx },
  ];
  for (const { value, globalIdx } of hoisted.values()) {
    seeds.push({ op: "f64.const", value }, { op: "call", funcIdx: boxIdx }, { op: "global.set", index: globalIdx });
  }
  initFn.body = [
    { op: "global.get", index: seededIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: seeds },
    ...initFn.body,
  ];

  if (debug) {
    process.stderr.write(`[const-box-hoist] ${rewrittenSites} site(s) → ${hoisted.size} global(s)\n`);
    // The declined histogram is keyed by the two instructions preceding the
    // boxing call — i.e. by PRODUCER SHAPE. It is what says whether a residual
    // population is genuinely non-constant or merely not adjacent, which is the
    // first question anyone extending this pass will ask.
    const top = [...missed].sort((a, b) => b[1] - a[1]).slice(0, 12);
    process.stderr.write(`[const-box-hoist] declined: ${top.map(([k, v]) => `${k}=${v}`).join(" ")}\n`);
  }
}
