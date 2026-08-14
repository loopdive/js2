// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) INLINE the monomorphic fast path of a dynamic property READ at the
 * CALL SITE — js2wasm's equivalent of a V8 monomorphic inline cache.
 *
 * ## What it does
 *
 * A dynamic (`any`-receiver, static-name) property read compiles today to
 *
 *     <receiver: externref>
 *     call $__get_member_<name>          ;; -> externref
 *
 * and the callee's FIRST arm is already the map check V8 emits inline:
 * `ref.test $S` / `ref.cast $S` / `struct.get $S <slot>`. The wasm heap type IS
 * the hidden class and `ref.test` IS the map compare — one instruction, cheaper
 * than V8's map load + compare. The machinery is not missing; it is behind a
 * call. This pass moves the first arm to the site:
 *
 *     <receiver: anyref>                 ;; the site's own extern.convert_any is
 *     local.tee  $__ic                   ;; DROPPED — see `alreadyAny` below
 *     ref.test   $S
 *     if (result externref)
 *       local.get $__ic ; ref.cast $S ; struct.get $S <slot> ; <box>
 *     else
 *       local.get $__ic ; extern.convert_any ; call $__get_member_<name>
 *     end
 *
 * **9 total instructions** for a reference-typed slot (10 with an f64 box, 11
 * with an i32 widen + box) replacing 2, counted at FULL DEPTH — the `if` plus
 * everything inside both of its arms — because entry (9) of #4157 failed by
 * counting four TOP-LEVEL instructions when one of them was an `if` carrying
 * ~45. The executed hit path is 6 instructions and contains no conversion at
 * all: `local.tee`, `ref.test`, `if`, `local.get`, `ref.cast`, `struct.get`.
 * A guard MISS costs 4 instructions more than today, never a wrong answer.
 *
 * ## Why the #2674 hazard cannot recur under this design
 *
 * #2674 is the reason inline multi-struct dispatch was REMOVED from read sites:
 * the inline candidate set was frozen at that read's compile time, so a struct
 * registered later (acorn's `$__fnctor_Parser`, registered after `$__anon_5`)
 * was missing from the chain. Reads of the real instance fell through to
 * `__extern_get` → `undefined` while WRITES — which went through the
 * finalize-filled `__set_member_<name>` — hit the slot. Read and write diverged
 * and acorn's expression parser never terminated.
 *
 * Two independent properties of this pass make that impossible:
 *
 * 1. **There is no site-frozen candidate set.** The pass is a FINALIZE pass. It
 *    reads `findAlternateStructsForField(ctx, propName, -1)` — literally the
 *    same call, at the same point in the pipeline, as
 *    `fillMemberGetDispatch` — so it sees the COMPLETE type table including
 *    every late-registered fnctor struct. It runs immediately after that fill,
 *    and before every index-remapping pass (`brandCollidingShapeTypes`,
 *    dead-elim), so its `typeIdx`/`funcIdx` operands live in exactly the same
 *    regime as the dispatcher arms it copies.
 *
 * 2. **A wrong guess is a branch, never an answer.** The `then` arm is a literal
 *    copy of the dispatcher's arm for `candidates[0]`; the `else` arm is the
 *    unmodified `call $__get_member_<name>`. The site's answer set is therefore
 *    IDENTICAL to the dispatcher's, not a subset of it — which is precisely the
 *    property the frozen chain lacked. Even if the speculation never hit, the
 *    only cost would be the guard.
 *
 * Property 2 is what makes the design safe; property 1 is what makes it useful.
 * Note that only `candidates[0]` is ever speculated on: the dispatcher tests
 * arms in order, `ref.test` is subtype-inclusive, and structurally identical
 * structs share one canonical wasm type — so ANY receiver that satisfies the
 * inline `ref.test $S0` would also have taken the dispatcher's first arm. That
 * removes the need to reason about subtyping or canonicalization at all: the
 * fast path is not "a case the dispatcher would also handle", it is "the exact
 * code the dispatcher would have run".
 *
 * ## Why this does not repeat entry (13)'s 3.50 pp regression
 *
 * Entry (13) prepended a `__extern_get` per-key cache arm to EVERY
 * `__get_member_<name>` dispatcher. Because `reserveMemberGetDispatch` is
 * called unconditionally for static-name reads, most of those dispatchers
 * answer from a struct arm a few instructions later, so the added check could
 * never hit and every one of those reads paid it. This pass is gated the other
 * way round: it fires ONLY where a struct arm is the answer (`candidates.length
 * >= 1`), and by default only where the receiver shape is unambiguous
 * (`candidates.length === 1` — a genuinely monomorphic site). Sites with no
 * struct candidates — acorn's `options.locations` / `ranges` / `ecmaVersion`,
 * the population entry (13)/(14) is about — are left completely untouched.
 *
 * ## Why the #1269 consumer-side narrowing vote cannot move
 *
 * #4217's `generator` defect (one wrong field out of 64, a constant `false`,
 * invisible to a computed read) came from a candidate-set vote that silently
 * omitted a carrier. The Phase-3 narrowing vote is computed during EMISSION, in
 * `property-access-dispatch.ts`, from the field-kind finders. This pass runs
 * after all emission is finished and changes no finder, no reservation and no
 * `resultWasm`. It cannot be observed by the vote, because the vote has already
 * happened. (The per-field differential over all 64 ESTree names in BOTH read
 * paths is still the acceptance gate — a structural argument is a reason to
 * expect the gate to pass, not a substitute for running it.)
 *
 * ## Flag — DEFAULT `8` since the #4157 tuned-set flip
 *
 * `JS2WASM_INLINE_PROP_IC` unset ⇒ **ceiling 8**, the operating point entry (29)
 * measured (66.1 % of the dispatcher calls removed for +107 KB, versus 8.7 % for
 * +38 KB at ceiling 1). `=0` / `off` returns before touching anything, which is
 * the only way to get the pre-#4157 byte-identical emission back.
 *   - `=1`  monomorphic sites only (exactly one struct carries the name)
 *   - `=N`  speculate on `candidates[0]` at sites with up to N candidates
 *   - `=0` / `off` / empty  OFF
 *   - any other value ⇒ the default ceiling (see `src/perf-flags.ts` for why a
 *     malformed value never lands in a half-enabled state)
 *   - `JS2WASM_INLINE_PROP_IC_DEBUG=1` prints patch counts and a histogram of
 *     DECLINED property names keyed by reason.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { tunedFlagEnabled } from "../perf-flags.js";
import type { CodegenContext } from "./context/types.js";
import { funcSignatureOf } from "./func-space.js";
import type { ReusePlan } from "./ic-guard-reuse.js";
import {
  emitReusedGuard,
  guardReuseStats,
  icGuardReuseEnabled,
  leaderTees,
  planGuardReuse,
  recordLeader,
  resetGuardReuseStats,
} from "./ic-guard-reuse.js";
import { isNativeGeneratorResultStruct } from "./generators-native.js";
import { classAccessorCandidatesForProp } from "./member-get-dispatch.js";
import { findAlternateStructsForField } from "./property-access.js";
import { coercionInstrs } from "./type-coercion.js";

/** One speculation: the dispatcher call this replaces, and the arm to inline. */
interface IcPlan {
  propName: string;
  /** Result type of the dispatcher being shadowed — the `if` block type. */
  resultType: ValType;
  structTypeIdx: number;
  fieldIdx: number;
  /** Instructions after `struct.get` — the arm's box/widen tail. */
  armTail: Instr[];
}

/** The ceiling `JS2WASM_INLINE_PROP_IC` selects when unset — entry (29)'s optimum. */
const DEFAULT_MAX_CANDIDATES = 8;

/**
 * Maximum struct candidates a site may have and still be speculated on.
 *
 * `0` when the flag is explicitly off. An explicit positive integer wins; every
 * other spelling — unset, or junk — is the tuned default, so a typo cannot
 * quietly demote the ceiling to a value nobody measured.
 */
function icMaxCandidates(): number {
  const raw = process.env.JS2WASM_INLINE_PROP_IC;
  if (!tunedFlagEnabled(raw)) return 0;
  if (raw === undefined) return DEFAULT_MAX_CANDIDATES;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CANDIDATES;
}

/** Declared type of local `index` in `fn` (params first, then declared locals). */
export function localTypeOf(ctx: CodegenContext, fn: WasmFunction, index: number): ValType | undefined {
  const t = ctx.mod.types[fn.typeIdx];
  const params = t && t.kind === "func" ? t.params : [];
  if (index < params.length) return params[index];
  return fn.locals[index - params.length]?.type;
}

/** Declared type of global `index` in the combined (imports-first) index space. */
export function globalTypeOf(ctx: CodegenContext, index: number): ValType | undefined {
  let seen = 0;
  for (const imp of ctx.mod.imports) {
    const desc = imp.desc as { kind: string; type?: ValType };
    if (desc.kind !== "global") continue;
    if (seen === index) return desc.type;
    seen++;
  }
  return ctx.mod.globals[index - seen]?.type;
}

/**
 * True when `instr` provably pushes exactly one `externref` and is the sole
 * producer of the following call's argument.
 *
 * This is the same "refuse to model" discipline `instrPopsPushes` uses in
 * fixups.ts: the rewrite inserts `any.convert_extern` directly on top of this
 * value, so a producer whose type is not KNOWN to be extern-typed must be
 * declined rather than guessed at. Every real member-read emitter lands in one
 * of these cases (`extern.convert_any` at the main dynamic-read chokepoint, an
 * externref local at the accessor/method-arm sites).
 */
export function producesExternref(ctx: CodegenContext, fn: WasmFunction, instr: Instr | undefined): boolean {
  if (!instr) return false;
  const a = instr as { op: string; index?: number; funcIdx?: number };
  if (a.op === "extern.convert_any") return true;
  if ((a.op === "local.get" || a.op === "local.tee") && a.index !== undefined) {
    return localTypeOf(ctx, fn, a.index)?.kind === "externref";
  }
  if (a.op === "global.get" && a.index !== undefined) {
    // The global index space starts with IMPORTED globals, so `mod.globals[i]`
    // is the wrong entry in any module that imports one (#1623 bit
    // `fixupExternConvertAny` with exactly this).
    return globalTypeOf(ctx, a.index)?.kind === "externref";
  }
  if (a.op === "call" && a.funcIdx !== undefined) {
    // `funcSignatureOf`, not `definedFuncAt` — the producer is very often an
    // IMPORT (`__extern_get` and friends all return externref), and resolving
    // only defined functions declined those sites for no reason.
    const t = funcSignatureOf(ctx, a.funcIdx);
    return t !== undefined && t.results.length === 1 && t.results[0]!.kind === "externref";
  }
  // A value-producing `if` whose block type is externref — which is, among
  // other things, exactly what THIS pass emits, so a chained read
  // (`a.b.c` where both hops are patchable) can inline both hops.
  if (a.op === "if") {
    const bt = (instr as { blockType?: { kind: string; type?: ValType } }).blockType;
    return bt?.kind === "val" && bt.type?.kind === "externref";
  }
  return false;
}

/**
 * Build the speculation plan for the GENERIC `__get_member_<name>` dispatcher,
 * or `undefined` (with a decline reason) when the site is not eligible.
 *
 * Every gate below exists to keep the inline arm a LITERAL copy of
 * `fillMemberGetDispatch`'s first arm. Where replicating an arm shape would
 * require more than a `struct.get` plus a box — a `$shape` collision stamp, a
 * packed presence bit, the #2979 generator-sentinel f64 — the site is declined
 * instead. A declined site keeps today's plain call; there is no half-copy.
 */
function planGeneric(ctx: CodegenContext, propName: string, max: number): { plan?: IcPlan; reason?: string } {
  // The dispatcher tries get-accessor arms BEFORE any field arm (#3041), so an
  // inline field read would shadow a getter. Refuse outright.
  if (classAccessorCandidatesForProp(ctx, propName).length > 0) return { reason: "accessor-arms" };
  const candidates = findAlternateStructsForField(ctx, propName, -1);
  if (candidates.length === 0) return { reason: "no-struct-candidates" };
  if (candidates.length > max) return { reason: "polymorphic" };
  const c0 = candidates[0]!;
  // `$shape` collision stamp (structurally canonicalized shapes) — the
  // dispatcher's arm is stamp-guarded and falls through on a mismatch.
  if (c0.shapeId !== undefined && c0.shapeFieldIdx !== undefined) return { reason: "shape-stamped" };
  // (#3780) packed own-presence bit — the arm answers `undefined` when clear.
  if (c0.presenceSlot !== undefined) return { reason: "presence-tracked" };
  // (#2979) native generator IteratorResult `value`: the f64 slot carries the
  // UNDEF_F64 sentinel and needs sentinel-aware boxing plus an f64 scratch.
  if (c0.fieldType.kind === "f64" && ctx.funcMap.get("__box_number") !== undefined) {
    if (isNativeGeneratorResultStruct(ctx, c0.structTypeIdx)) return { reason: "generator-sentinel" };
  }
  // (#3050) boolean-branded i32 boxes via `__box_boolean`, exactly as the arm
  // does — `__box_number` would answer 1 instead of `true`.
  const boxBoolIdx =
    c0.fieldType.kind === "i32" && c0.fieldType.boolean === true ? ctx.funcMap.get("__box_boolean") : undefined;
  const armTail: Instr[] =
    boxBoolIdx !== undefined
      ? [{ op: "call", funcIdx: boxBoolIdx }]
      : coercionInstrs(ctx, c0.fieldType, { kind: "externref" });
  return {
    plan: {
      propName,
      resultType: { kind: "externref" },
      structTypeIdx: c0.structTypeIdx,
      fieldIdx: c0.fieldIdx,
      armTail,
    },
  };
}

/**
 * Build the speculation plan for the TYPED `__get_member_<name>__f64` twin
 * (#3673). Its first arm is a bare `struct.get` (+ `f64.convert_i32_s` for an
 * i32 slot) with NO stamp guard — this mirrors that exactly, including the
 * absence of the guard, because the contract is "identical to today", not
 * "what the arm arguably should be".
 */
function planTypedF64(ctx: CodegenContext, propName: string, max: number): { plan?: IcPlan; reason?: string } {
  // The typed fill zeroes its candidate list outright when accessors exist.
  if (classAccessorCandidatesForProp(ctx, propName).length > 0) return { reason: "accessor-arms" };
  const candidates = findAlternateStructsForField(ctx, propName, -1);
  if (candidates.length === 0) return { reason: "no-struct-candidates" };
  if (candidates.length > max) return { reason: "polymorphic" };
  const c0 = candidates[0]!;
  if (c0.presenceSlot !== undefined) return { reason: "presence-tracked" };
  const numericSlot =
    (c0.fieldType.kind === "f64" && !isNativeGeneratorResultStruct(ctx, c0.structTypeIdx)) ||
    c0.fieldType.kind === "i32";
  if (!numericSlot) return { reason: "non-numeric-slot" };
  return {
    plan: {
      propName,
      resultType: { kind: "f64" },
      structTypeIdx: c0.structTypeIdx,
      fieldIdx: c0.fieldIdx,
      armTail: c0.fieldType.kind === "i32" ? [{ op: "f64.convert_i32_s" }] : [],
    },
  };
}

/**
 * Rewrite one instruction array IN PLACE, recursing into nested bodies.
 * In-place (rather than returning a fresh array) so any reference another pass
 * still holds to a nested `then`/`body` array stays valid.
 */
function rewriteInstrs(
  ctx: CodegenContext,
  fn: WasmFunction,
  instrs: Instr[],
  plans: Map<number, IcPlan>,
  scratch: () => number,
  stats: { patched: number; declinedProducer: number },
  reuse: ReusePlan | undefined,
): void {
  const out: Instr[] = [];
  for (const instr of instrs) {
    const a = instr as { op: string; funcIdx?: number; body?: Instr[]; then?: Instr[]; else?: Instr[] } & {
      catches?: { body?: Instr[] }[];
      catchAll?: Instr[];
    };
    // Recurse first (pre-order over the array, depth-first into children). This
    // order is what lets a nested site reuse a guard from an ANCESTOR array: by
    // the time a child is rewritten, the parent's `out` already carries
    // everything that dominates it.
    if (Array.isArray(a.body)) rewriteInstrs(ctx, fn, a.body, plans, scratch, stats, reuse);
    if (Array.isArray(a.then)) rewriteInstrs(ctx, fn, a.then, plans, scratch, stats, reuse);
    if (Array.isArray(a.else)) rewriteInstrs(ctx, fn, a.else, plans, scratch, stats, reuse);
    if (Array.isArray(a.catches)) {
      for (const c of a.catches)
        if (Array.isArray(c.body)) rewriteInstrs(ctx, fn, c.body, plans, scratch, stats, reuse);
    }
    if (Array.isArray(a.catchAll)) rewriteInstrs(ctx, fn, a.catchAll, plans, scratch, stats, reuse);

    const plan = a.op === "call" && a.funcIdx !== undefined ? plans.get(a.funcIdx) : undefined;
    if (!plan) {
      out.push(instr);
      continue;
    }
    const prev = out[out.length - 1];
    if (!producesExternref(ctx, fn, prev)) {
      stats.declinedProducer++;
      out.push(instr);
      continue;
    }
    // The dominant read site emits `…; extern.convert_any; call $disp` — it had
    // the anyref and converted it purely to satisfy the dispatcher's externref
    // ABI. The guard wants the anyref back, so instead of appending the inverse
    // conversion (a round trip that only `wasm-opt` would clean up, and only at
    // `-O`), DROP the site's own conversion and re-add it in the miss arm. That
    // is 2 instructions off every patched site and leaves the hit path free of
    // any conversion at all.
    const alreadyAny = (prev as { op: string }).op === "extern.convert_any";
    const hitTail: Instr[] = [
      { op: "struct.get", typeIdx: plan.structTypeIdx, fieldIdx: plan.fieldIdx },
      ...plan.armTail.map((i) => ({ ...i }) as Instr),
    ];
    // (#4157 defect C) A follower's guard was already decided by its leader and
    // its receiver's heap type cannot have changed since, so both the `ref.test`
    // and the hit arm's `ref.cast` are dead here. Pop the producer only once the
    // reuse is confirmed — every decline inside leaves `out` untouched.
    const reused = reuse && emitReusedGuard(reuse, instr, out, alreadyAny, plan.resultType, hitTail, [instr]);
    if (reused) {
      out.push(...reused);
      stats.patched++;
      continue;
    }
    if (alreadyAny) out.pop();
    const scratchIdx = scratch();
    const lead = reuse?.leaders.has(instr) === true ? leaderTees(ctx, fn, plan.structTypeIdx) : undefined;
    if (!alreadyAny) out.push({ op: "any.convert_extern" });
    out.push({ op: "local.tee", index: scratchIdx });
    out.push({ op: "ref.test", typeIdx: plan.structTypeIdx });
    if (lead) {
      out.push(lead.guardTee);
      // Recorded with the tee as the LAST entry of `out`, which is what the
      // relocation probe re-verifies at every reuse.
      recordLeader(reuse!, instr, lead.entry, lead.guardTee, out);
    }
    out.push({
      op: "if",
      blockType: { kind: "val", type: plan.resultType },
      then: [
        { op: "local.get", index: scratchIdx },
        { op: "ref.cast", typeIdx: plan.structTypeIdx },
        ...(lead ? [lead.castTee] : []),
        ...hitTail,
      ],
      else: [{ op: "local.get", index: scratchIdx }, { op: "extern.convert_any" }, instr],
    });
    stats.patched++;
  }
  instrs.length = 0;
  instrs.push(...out);
}

/**
 * (#4157) Inline the monomorphic member-read fast path at every eligible
 * `call $__get_member_<name>` / `call $__get_member_<name>__f64` site.
 *
 * MUST run AFTER `fillMemberGetDispatch` / `fillTypedMemberGetF64Dispatch`
 * (the arm it copies is defined by those fills, and the complete struct table
 * is what makes the copy the right one) and BEFORE any pass that remaps type
 * or function indices (`brandCollidingShapeTypes`, dead elimination), so the
 * operands it bakes are in the same regime as the dispatcher's own arms.
 *
 * Runs at ceiling 8 by default; a no-op only when `JS2WASM_INLINE_PROP_IC` is
 * explicitly off.
 */
export function inlineMemberGetCallSites(ctx: CodegenContext): void {
  const max = icMaxCandidates();
  if (max <= 0) return; // explicitly OFF — byte-identical to the pre-#4157 base.
  const debug = process.env.JS2WASM_INLINE_PROP_IC_DEBUG === "1";
  resetGuardReuseStats(); // the reported line is per module, not per process

  // Plan building calls `coercionInstrs`, which may register union box imports.
  // Every plan's coercion is one `fillMemberGetDispatch` already emitted for the
  // same (propName, fieldType) pair, so this is provably a funcMap read — but a
  // late import here would shift the function index space UNDER the funcIdx
  // operands already baked into the plans, i.e. a silent miscompile. Snapshot
  // and refuse rather than trust the argument.
  const importsBefore = ctx.numImportFuncs;

  const plans = new Map<number, IcPlan>();
  const declines = new Map<string, number>();
  const decline = (r: string): void => {
    declines.set(r, (declines.get(r) ?? 0) + 1);
  };

  for (const propName of ctx.memberGetDispatchNames ?? []) {
    const dispIdx = ctx.funcMap.get(`__get_member_${propName}`);
    if (dispIdx === undefined) continue;
    const { plan, reason } = planGeneric(ctx, propName, max);
    if (plan) plans.set(dispIdx, plan);
    else decline(reason ?? "unknown");
  }
  for (const propName of ctx.memberGetTypedF64DispatchNames ?? []) {
    const dispIdx = ctx.funcMap.get(`__get_member_${propName}__f64`);
    if (dispIdx === undefined) continue;
    const { plan, reason } = planTypedF64(ctx, propName, max);
    if (plan) plans.set(dispIdx, plan);
    else decline(`f64:${reason ?? "unknown"}`);
  }

  if (ctx.numImportFuncs !== importsBefore) {
    process.stderr.write(
      `[inline-prop-ic] REFUSED: plan building added ${ctx.numImportFuncs - importsBefore} import(s); ` +
        `baked funcIdx operands would be stale. Pass disabled for this module.\n`,
    );
    return;
  }
  if (plans.size === 0) {
    if (debug) process.stderr.write(`[inline-prop-ic] no eligible dispatchers (max=${max})\n`);
    return;
  }

  const stats = { patched: 0, declinedProducer: 0 };
  let fnsTouched = 0;
  const touched: string[] = [];
  for (const fn of ctx.mod.functions) {
    // Never patch inside a dispatcher: the typed f64 twin's fallback calls the
    // generic dispatcher on the path where the arm has ALREADY missed, so a
    // guard there is pure tax by construction.
    if (fn.name.startsWith("__get_member_")) continue;
    const before = stats.patched;
    let scratchIdx = -1;
    const scratch = (): number => {
      if (scratchIdx < 0) {
        const t = ctx.mod.types[fn.typeIdx];
        const nparams = t && t.kind === "func" ? t.params.length : 0;
        scratchIdx = nparams + fn.locals.length;
        fn.locals.push({ name: "__ic_recv", type: { kind: "anyref" } });
      }
      return scratchIdx;
    };
    // (#4157 defect C) Pair same-receiver / same-struct sites across the whole
    // function BEFORE rewriting, so a leader only pays the two extra
    // `local.tee`s when a follower will actually use them. `undefined` (flag
    // off, or nothing pairs) keeps this function on the untouched path.
    const reuse = planGuardReuse(
      fn.body,
      (index) => localTypeOf(ctx, fn, index)?.kind,
      (i) => {
        const c = i as { op: string; funcIdx?: number };
        return c.op === "call" && c.funcIdx !== undefined ? plans.get(c.funcIdx)?.structTypeIdx : undefined;
      },
    );
    rewriteInstrs(ctx, fn, fn.body, plans, scratch, stats, reuse);
    if (stats.patched > before) {
      fnsTouched++;
      if (debug && touched.length < 24) touched.push(`${fn.name}×${stats.patched - before}`);
    }
  }

  // (#4157 defect C) One unconditional line whenever the reuse flag is on: a
  // size delta alone cannot tell "the pass fired" from "the pass declined
  // everything", and this class of change is invisible to the executed-call
  // census by construction (it removes inline instructions, not calls).
  if (icGuardReuseEnabled()) {
    process.stderr.write(
      `[ic-guard-reuse] leaders=${guardReuseStats.leaders} reuses=${guardReuseStats.reuses} ` +
        `declined-relocated=${guardReuseStats.declinedRelocated} sites=${guardReuseStats.sites} ` +
        `unkeyed-producer=${guardReuseStats.unkeyedProducer} unpaired=${guardReuseStats.unpaired}\n`,
    );
  }
  if (debug) {
    const hist = [...declines.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`);
    process.stderr.write(
      `[inline-prop-ic] max=${max} eligible-dispatchers=${plans.size} patched-sites=${stats.patched} ` +
        `functions=${fnsTouched} declined-producer-shape=${stats.declinedProducer}\n` +
        `[inline-prop-ic] declined dispatchers: ${hist.join(" ") || "(none)"}\n` +
        `[inline-prop-ic] first patched functions: ${touched.join(" ") || "(none)"}\n`,
    );
  }
}
