// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) INLINE `__extern_get`'s per-key cache-hit arm at STATIC-NAME call
 * sites.
 *
 * ## Why this helper and not another
 *
 * `__extern_get` runs **506,752 times per acorn self-parse** and has not moved
 * by a single call across the whole programme, while every other helper on the
 * board fell 18–100 %. Six attempts are recorded in #4157 (entries 2, 4, 9, 12,
 * 13, 14, 21, 22) and they price out every obvious move:
 *
 * - The per-key cache (#3673) already serves **87.24 %** of those calls with
 *   3.77 % thrash, so "make the cache smarter" is worth at most 3.77 %.
 * - The cost is the HIT path (21.7 ns / ~45 cycles / ~40 instructions), not the
 *   misses. Two independent instruction-shaving attempts measured null at
 *   ±0.3–0.5 pp, and outlining the cold path measured null too.
 * - `wasm-opt` **cannot** inline `__extern_get` at any size budget: `-fimfs`
 *   applies only to functions with no loops and no calls, and this one calls.
 *
 * What is left is the shape that has worked three times in this tree
 * (`member-get-inline-ic.ts`, `is-truthy-inline-ic.ts`, `smi-box-fast-path.ts`):
 * a finalize pass that rewrites the CALL SITE into a guarded fast path with the
 * unmodified call as the `else` arm.
 *
 * ## The specific saving
 *
 * The cache is keyed on the interned key STRING (`$HashedString` fields 4–7).
 * At a static-name read the key is a compile-time constant — an immutable
 * global whose initializer is literally `struct.new $HashedString`. So at those
 * sites the helper's key `ref.test` + `ref.cast` + externref round trip are
 * provably unnecessary, and what remains is the 87.24 % hit path with the CALL
 * and the key work removed:
 *
 *     <receiver: externref>
 *     local.set $__eg_r
 *     block (result externref)
 *       <cache arm, copied verbatim; `return` rewritten to `br 0`>
 *       local.get $__eg_r ; global.get $key ; extern.convert_any
 *       call $__extern_get              ;; the unmodified helper
 *     end
 *
 * ## Why a wrong guess cannot be a wrong answer
 *
 * 1. **The arm is not written here.** `extractExternGetCacheArm` reads it out of
 *    the emitted `__extern_get` body and this pass copies it verbatim, with
 *    only local indices re-homed and the single `return` turned into a `br` to
 *    the site's own block. The extractor accepts the body ONLY when the arm is
 *    the first thing in it — which is exactly the property the arm's own
 *    soundness rests on (it is unshifted last so a hit short-circuits every
 *    ladder). On any module where a later fill unshifts in front of it, the
 *    extraction fails and the pass declines wholesale.
 * 2. **The terminal `else` is the unmodified call**, with the original operands.
 *    Everything the guards do not claim reaches today's helper, so the site's
 *    answer set is IDENTICAL to the helper's rather than a subset of it.
 * 3. **Accessors, tombstones, proto hits and non-`$Object` receivers are not
 *    special-cased here and cannot be.** The copied arm carries the helper's own
 *    `FLAG_TOMBSTONE | FLAG_ACCESSOR` re-check (a set flag falls through to the
 *    call), its own receiver classification (`ref.test $Object`, else the
 *    `__fnctor_proto_start` ladder, else a null owner that falls through), and
 *    its own `(cacheOwner, cacheProps)` `ref.eq` validity pair. A proto-chain
 *    hit is served because the cache stores the OWNER it was found on, and that
 *    owner is what is compared. Nothing in this pass can skip one of those
 *    checks without also deleting it from `__extern_get`.
 * 4. **The dropped key guard is discharged statically.** The site is patched
 *    only when the key operand is `global.get G ; extern.convert_any` where `G`
 *    is an IMMUTABLE module global whose initializer's last instruction is
 *    `struct.new $HashedString`. That is strictly stronger than the runtime
 *    `ref.test` it replaces.
 *
 * ## Flag — DEFAULT `1` since the #4157 tuned-set flip
 *
 * `JS2WASM_EXTERN_GET_IC` unset ⇒ inline mode. `=0` / `off` → the pass returns
 * before touching anything and the binary is byte-identical (sha256-verified)
 * to the pre-#4157 base. `=census` is the only other recognised value; anything
 * else takes the default rather than disabling (`src/perf-flags.ts`).
 *   - `=1` / `=on`  inline the cache arm at every eligible static-name site
 *   - `=census`     do NOT inline; only count static-name sites and route them
 *                   through a `__extern_get_sk` shim so `JS2WASM_EXEC_CENSUS`
 *                   reports the static-name share of the 506,752 calls
 *   - `JS2WASM_EXTERN_GET_IC_DEBUG=1` per-decline histogram
 *   - `JS2WASM_EXTERN_GET_IC_POISON=1` **deliberately corrupts the fast arm**
 *     (answers `null` on every cache hit). A workload whose answer is unchanged
 *     under poison did not execute the fast path — the only way to tell a real
 *     null from a mechanism that never fired (#4157 entry 22, where a confident
 *     null was reported twice from a flag that did not exist).
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { tunedFlagEnabled, tunedFlagExplicit } from "../perf-flags.js";
import type { CodegenContext } from "./context/types.js";
import { extractExternGetCacheArm, type ExternGetCacheArm } from "./extern-get-cache-arm.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { localTypeOf } from "./member-get-inline-ic.js";

type Mode = "off" | "inline" | "census";

function mode(): Mode {
  const raw = process.env.JS2WASM_EXTERN_GET_IC;
  if (!tunedFlagEnabled(raw)) return "off";
  if (raw !== undefined && raw.trim().toLowerCase() === "census") return "census";
  return "inline";
}

type AnyInstr = Instr & {
  op: string;
  index?: number;
  funcIdx?: number;
  typeIdx?: number;
  body?: Instr[];
  then?: Instr[];
  else?: Instr[];
  catches?: { body?: Instr[] }[];
  catchAll?: Instr[];
  blockType?: { kind: string; type?: ValType };
};

/**
 * True when global `index` is an immutable module global holding an interned
 * `$HashedString` literal — i.e. the key is a compile-time constant of exactly
 * the type the helper's outer `ref.test` screens for.
 */
function isConstHashedStringGlobal(ctx: CodegenContext, index: number): boolean {
  const g = ctx.mod.globals[index - ctx.numImportGlobals];
  if (!g || g.mutable) return false;
  const last = g.init[g.init.length - 1] as AnyInstr | undefined;
  return last?.op === "struct.new" && last.typeIdx === ctx.hashedStrTypeIdx;
}

/**
 * True when `instr` provably pushes exactly one externref. Same "refuse to
 * model" discipline as `producesExternref` in member-get-inline-ic.ts; kept
 * separate because this pass also accepts a value-producing `block`, which is
 * what IT emits (so a chained `a.b.c` can inline both hops).
 */
function producesOneExternref(ctx: CodegenContext, fn: WasmFunction, instr: Instr | undefined): boolean {
  if (!instr) return false;
  const a = instr as AnyInstr;
  if (a.op === "extern.convert_any") return true;
  if ((a.op === "local.get" || a.op === "local.tee") && a.index !== undefined) {
    return localTypeOf(ctx, fn, a.index)?.kind === "externref";
  }
  if ((a.op === "if" || a.op === "block" || a.op === "try_table") && a.blockType?.kind === "val") {
    return a.blockType.type?.kind === "externref";
  }
  return false;
}

/** Per-site scratch: the receiver plus one twin of each of the arm's locals. */
interface SiteLocals {
  recv: number;
  twin: Map<number, number>;
}

/**
 * Copy the arm, re-homing locals onto the site and turning its single `return`
 * into a `br` to the site's result block.
 *
 * `depth` is the number of structured frames between here and that block, so a
 * `return` at the top level of the arm becomes `br 0`.
 */
function copyArm(arm: ExternGetCacheArm, ls: SiteLocals, keyGlobal: number, poison: boolean, depth: number): Instr[] {
  const out: Instr[] = [];
  const src = arm.then;
  for (let i = 0; i < src.length; i++) {
    const a = src[i] as AnyInstr;
    if (a.op === "return") {
      // The value is already on the stack (the arm ends `struct.get value ;
      // extern.convert_any ; return`). Poison replaces it with `null`, which
      // makes every cache HIT answer `undefined` — a workload that still
      // agrees with the baseline never took this path.
      if (poison) out.push({ op: "drop" }, { op: "ref.null.extern" });
      out.push({ op: "br", depth });
      continue;
    }
    if (a.op === "local.get" && a.index === 1) {
      // The key. Constant at this site, so the helper's externref round trip
      // collapses: `local.get 1 ; any.convert_extern` IS `global.get G`.
      const next = src[i + 1] as AnyInstr | undefined;
      if (next?.op === "any.convert_extern") {
        out.push({ op: "global.get", index: keyGlobal });
        i++;
      } else {
        out.push({ op: "global.get", index: keyGlobal }, { op: "extern.convert_any" });
      }
      continue;
    }
    if ((a.op === "local.get" || a.op === "local.set" || a.op === "local.tee") && a.index !== undefined) {
      const idx = a.index === 0 ? ls.recv : (ls.twin.get(a.index) ?? -1);
      if (idx < 0) throw new Error(`extern-get-ic: unmapped local ${a.index}`);
      out.push({ ...a, index: idx } as Instr);
      continue;
    }
    const copy = { ...a } as AnyInstr;
    if (Array.isArray(a.body)) copy.body = copyArm({ ...arm, then: a.body }, ls, keyGlobal, poison, depth + 1);
    if (Array.isArray(a.then)) copy.then = copyArm({ ...arm, then: a.then }, ls, keyGlobal, poison, depth + 1);
    if (Array.isArray(a.else)) copy.else = copyArm({ ...arm, then: a.else }, ls, keyGlobal, poison, depth + 1);
    out.push(copy as Instr);
  }
  return out;
}

interface Stats {
  staticKeySites: number;
  patched: number;
  declinedProducer: number;
  otherKeySites: number;
}

/** Rewrite one instruction array in place, recursing into nested bodies. */
function rewriteInstrs(
  ctx: CodegenContext,
  fn: WasmFunction,
  instrs: Instr[],
  target: { getIdx: number; shimIdx: number; arm?: ExternGetCacheArm },
  locals: () => SiteLocals,
  stats: Stats,
): void {
  const out: Instr[] = [];
  for (const instr of instrs) {
    const a = instr as AnyInstr;
    if (Array.isArray(a.body)) rewriteInstrs(ctx, fn, a.body, target, locals, stats);
    if (Array.isArray(a.then)) rewriteInstrs(ctx, fn, a.then, target, locals, stats);
    if (Array.isArray(a.else)) rewriteInstrs(ctx, fn, a.else, target, locals, stats);
    if (Array.isArray(a.catches)) {
      for (const c of a.catches) if (Array.isArray(c.body)) rewriteInstrs(ctx, fn, c.body, target, locals, stats);
    }
    if (Array.isArray(a.catchAll)) rewriteInstrs(ctx, fn, a.catchAll, target, locals, stats);

    if (a.op !== "call" || a.funcIdx !== target.getIdx) {
      out.push(instr);
      continue;
    }
    const conv = out[out.length - 1] as AnyInstr | undefined;
    const key = out[out.length - 2] as AnyInstr | undefined;
    const staticKey =
      conv?.op === "extern.convert_any" &&
      key?.op === "global.get" &&
      key.index !== undefined &&
      isConstHashedStringGlobal(ctx, key.index);
    if (!staticKey) {
      stats.otherKeySites++;
      out.push(instr);
      continue;
    }
    stats.staticKeySites++;
    if (!producesOneExternref(ctx, fn, out[out.length - 3])) {
      stats.declinedProducer++;
      out.push(instr);
      continue;
    }
    const keyGlobal = key!.index!;
    if (!target.arm) {
      // Census: same call, routed through a shim so the executed-call counter
      // separates static-name sites from genuinely computed `o[k]` reads.
      out.push({ ...a, funcIdx: target.shimIdx } as Instr);
      stats.patched++;
      continue;
    }
    out.length -= 2; // the key operands; re-emitted in the miss arm
    const ls = locals();
    const miss: Instr[] = [
      { op: "local.get", index: ls.recv },
      { op: "global.get", index: keyGlobal },
      { op: "extern.convert_any" },
      instr,
    ];
    // local.SET, not tee: the producer's value is captured to the local and
    // re-materialised via `local.get` in both arms. A tee leaves the receiver
    // on the stack UNDER the block result — an extra value that surfaces as
    // "type error in fallthru" at whatever consumer sits downstream (found via
    // wasm-dis reconstructing a phantom scratch/drop pair around the site).
    out.push({ op: "local.set", index: ls.recv });
    out.push({
      op: "block",
      blockType: { kind: "val", type: { kind: "externref" } },
      body: [...copyArm(target.arm, ls, keyGlobal, process.env.JS2WASM_EXTERN_GET_IC_POISON === "1", 0), ...miss],
    });
    stats.patched++;
  }
  instrs.length = 0;
  instrs.push(...out);
}

/** Mint the census shim `__extern_get_sk(recv, key) -> call $__extern_get`. */
function mintCensusShim(ctx: CodegenContext, getIdx: number): number {
  const ext: ValType = { kind: "externref" };
  const typeIdx = addFuncType(ctx, [ext, ext], [ext]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__extern_get_sk",
    typeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: getIdx },
    ],
    exported: false,
  });
  return funcIdx;
}

/**
 * (#4157) Inline `__extern_get`'s per-key cache-hit arm at every static-name
 * call site.
 *
 * MUST run AFTER `unshiftExternGetProtoCacheArm` and after every other
 * `__extern_get` body fill (the extractor's first-instruction check is what
 * proves nothing runs ahead of the arm), and BEFORE `brandCollidingShapeTypes`
 * / dead elimination, so the `typeIdx` and `funcIdx` operands it copies stay in
 * the helper's own regime.
 *
 * Runs by default; a no-op only when `JS2WASM_EXTERN_GET_IC` is explicitly off.
 */
export function inlineExternGetCallSites(ctx: CodegenContext): void {
  const m = mode();
  if (m === "off") return; // explicitly OFF — byte-identical to the pre-#4157 base.
  const debug = process.env.JS2WASM_EXTERN_GET_IC_DEBUG === "1";
  const getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined || getIdx < ctx.numImportFuncs) {
    if (debug) process.stderr.write(`[extern-get-ic] no defined __extern_get (host-import mode) — declined\n`);
    return;
  }
  // (#4157) Look the helper up BY NAME. `ctx.funcMap` holds mint-time handles
  // (import-space at registration, before dead-import elimination), not final
  // list positions, so `functions[getIdx - numImportFuncs]` lands on an
  // unrelated function and this pass silently declines — the same trap
  // `alloc-census.ts` records ("recomputing final index from list position
  // matched zero of 261k measured calls"). Name lookup is what every other
  // finalize fill in `object-runtime.ts` uses.
  const helper = ctx.mod.functions.find((f) => f.name === "__extern_get");
  if (!helper) {
    if (debug) process.stderr.write(`[extern-get-ic] no defined __extern_get in module — declined\n`);
    return;
  }

  let arm: ExternGetCacheArm | undefined;
  if (m === "inline") {
    const got = extractExternGetCacheArm(ctx, helper);
    if (!got.arm) {
      // NOT a defect, and NOT rare: `extern-get-cache-arm.ts` states that a
      // module where `fillDynamicForinVecArms` / `fillObjVecReflectionHelpers`
      // unshifted in front of the cache arm declines by design. That refusal
      // was loud while the flag was opt-in — someone who typed the flag needs
      // to know it did nothing. Now that the pass runs on EVERY compile, an
      // unconditional line here would print on every module of that (common)
      // class, so it moves to the debug channel and stays loud only for an
      // operator who asked for the flag by name.
      if (debug || tunedFlagExplicit(process.env.JS2WASM_EXTERN_GET_IC)) {
        process.stderr.write(`[extern-get-ic] REFUSED: __extern_get body is not the cache-arm shape (${got.reason})\n`);
      }
      return;
    }
    arm = got.arm;
  }
  const shimIdx = m === "census" ? mintCensusShim(ctx, getIdx) : -1;

  const helperParams = 2;
  const stats: Stats = { staticKeySites: 0, patched: 0, declinedProducer: 0, otherKeySites: 0 };
  let fnsTouched = 0;
  const snapshot = [...ctx.mod.functions];
  for (const fn of snapshot) {
    // Never patch inside the helper family: a guard on the path where the arm
    // has already run (or is about to) is pure tax by construction.
    if (fn.name.startsWith("__extern_get")) continue;
    const before = stats.patched;
    let cached: SiteLocals | undefined;
    const locals = (): SiteLocals => {
      if (cached) return cached;
      const t = ctx.mod.types[fn.typeIdx];
      const nparams = t && t.kind === "func" ? t.params.length : 0;
      const next = (): number => nparams + fn.locals.length;
      const recv = next();
      fn.locals.push({ name: "__eg_r", type: { kind: "externref" } });
      const twin = new Map<number, number>();
      for (const idx of arm?.scratchLocals ?? []) {
        const decl = helper.locals[idx - helperParams]!;
        twin.set(idx, next());
        fn.locals.push({ name: `__eg_s${idx}`, type: decl.type });
      }
      cached = { recv, twin };
      return cached;
    };
    rewriteInstrs(ctx, fn, fn.body, { getIdx, shimIdx, arm }, locals, stats);
    if (stats.patched > before) fnsTouched++;
  }

  // Printed only when the flag was asked for: the pass runs on every default
  // build now, and this line is a flag-experiment diagnostic, not a message.
  if (debug || tunedFlagExplicit(process.env.JS2WASM_EXTERN_GET_IC)) {
    process.stderr.write(
      `[extern-get-ic] mode=${m} static-key-sites=${stats.staticKeySites} other-key-sites=${stats.otherKeySites} ` +
        `patched-sites=${stats.patched} functions=${fnsTouched} declined-producer-shape=${stats.declinedProducer}` +
        `${process.env.JS2WASM_EXTERN_GET_IC_POISON === "1" ? " POISON=ON" : ""}\n`,
    );
  }
  if (debug && arm) {
    process.stderr.write(
      `[extern-get-ic] arm: ${arm.then.length} top-level instr(s), scratch locals ` +
        `${arm.scratchLocals.join(",")}, return at depth ${arm.returnDepth}\n`,
    );
  }
}
