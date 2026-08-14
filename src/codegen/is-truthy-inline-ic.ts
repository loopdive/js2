// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) INLINE the hot arms of `__is_truthy` at the CALL SITE.
 *
 * `__is_truthy` is the largest executed-call figure in the whole programme —
 * **997,454 calls per acorn self-parse** (entry 21), 3.93 % of runtime, 126 WAT
 * lines with ZERO inner calls, reached from 1,655 static sites in 18 files. It
 * is far past binaryen's inlining cliff so `wasm-opt` will never hoist it whole,
 * but it does not need to be: the ladder's first arms are two or three
 * instructions each and JS truthiness is false only for `undefined`, `null`,
 * `false`, `0`, `-0`, `NaN` and `""`.
 *
 * This is the same shape as `member-get-inline-ic.ts`, which measured
 * −563,343 executed calls per parse:
 *
 *     <operand: externref>              ;; the site's own extern.convert_any is
 *     local.tee  $__tr                  ;; DROPPED when it has one
 *     ref.test   $T0
 *     if (result i32)
 *       <arm 0, a literal copy of the helper's arm>
 *     else
 *       ref.test $T1 -> …               ;; further selected arms, ladder order
 *       else local.get $__tr ; extern.convert_any ; call $__is_truthy
 *
 * ## Why a wrong guess cannot be a wrong answer
 *
 * 1. **The arms are not written here.** `extractTruthyLadder` reads them out of
 *    the emitted `__is_truthy` body at finalize (see `is-truthy-ladder.ts`) and
 *    copies them verbatim, with only the helper's two scratch locals re-homed.
 *    If the helper's body ever changes shape, extraction fails and the pass
 *    declines wholesale — it cannot copy a stale arm.
 * 2. **The terminal `else` is the unmodified call.** Every value the guards do
 *    not claim reaches exactly today's helper, so the site's answer set is
 *    identical to the helper's rather than a subset of it. A guard that never
 *    hit would cost a `ref.test` and nothing else.
 * 3. **Order is preserved, and non-prefix selections are proved disjoint.** The
 *    helper answers with the FIRST arm that tests true, so inlining arm `k`
 *    while skipping arm `j < k` is only sound if no value can satisfy both.
 *    `mayAlias` refuses the arm unless the two heap types are provably
 *    unrelated — different field shape (so wasm's structural canonicalization
 *    cannot merge them) and neither in the other's declared supertype chain.
 *    i31 versus any struct is disjoint for free.
 * 4. **`ref.test` is the NON-null form** (`0x14`), so `null` fails every guard
 *    and falls to the helper, which answers `0`. `-0`, `NaN` and `""` are not
 *    special-cased anywhere here: they are whatever the copied arm says, and the
 *    copied arm is the helper (`-0` is never i31-encoded — `__box_number`
 *    excludes it — so it reaches `$box_number`'s `f64.ne 0`; `NaN` reaches the
 *    same arm's `v == v`; `""` reaches `$AnyString`'s `len != 0`). The
 *    `$undefined` singleton is a tag-1 `$AnyValue` and is answered by the
 *    `anyval` arm's `tag > 1`, exactly as the helper does.
 *
 * ## Flag — DEFAULT `1` since the #4157 tuned-set flip
 *
 * `JS2WASM_INLINE_TRUTHY_IC` unset ⇒ the two-arm {@link DEFAULT_ARMS} profile.
 * **Not `all`** — see the measured table on `DEFAULT_ARMS`: `boxnum` and
 * `bigint` fire zero times on acorn and cost +121 KB between them, and entry
 * (29) measured arm maximisation as a net wall regression. `=0` / `off` → the
 * pass returns before touching anything and the binary is byte-identical
 * (sha256-verified) to the pre-#4157 base.
 *   - `=1` / `=on`  the default arm set (`DEFAULT_ARMS`)
 *   - `=all`        every extracted arm
 *   - `=anyval,i31` an explicit ladder-order subset
 *   - `=0` / `off` / empty  OFF
 *   - a value naming no known arm falls back to `DEFAULT_ARMS` rather than
 *     silently disabling the pass (`src/perf-flags.ts`)
 *   - `JS2WASM_INLINE_TRUTHY_IC_DEBUG=1` per-arm patch counts + decline reasons
 *   - `JS2WASM_INLINE_TRUTHY_IC_POISON=1` **deliberately corrupts the fast arms**
 *     (appends `i32.eqz`). A workload whose answer is unchanged under poison did
 *     not execute the fast path, which is the only way to tell a real null from
 *     a flag that never fired (#4157 entry 22 — a confident null was reported
 *     twice this session from a mechanism that was never live).
 */
import type { Instr, WasmFunction } from "../ir/types.js";
import { tunedFlagEnabled, tunedFlagExplicit } from "../perf-flags.js";
import type { CodegenContext } from "./context/types.js";
import { extractTruthyLadder, type TruthyArm } from "./is-truthy-ladder.js";
import { producesExternref } from "./member-get-inline-ic.js";

/**
 * Arms inlined by `=1`, chosen from the MEASURED per-arm hit counts on the
 * acorn self-parse (#4157; baseline 997,454 executed calls, arm hits are
 * additive because the arms are disjoint — the six singleton runs sum to the
 * all-arms delta exactly):
 *
 * | arm      | hits/parse | share | +bytes @O0 |
 * | -------- | ---------: | ----: | ---------: |
 * | `boxbool`|    493,911 | 49.5% |    +43,817 |
 * | `anyval` |    263,779 | 26.4% |    +48,746 |
 * | `str`    |     11,241 |  1.1% |    +45,460 |
 * | `i31`    |      5,622 |  0.6% |    +42,174 |
 * | `boxnum` |          0 |     — |    +74,674 |
 * | `bigint` |          0 |     — |    +47,103 |
 *
 * `anyval,boxbool` takes **76.0 %** of all executed calls for +81,789 B; adding
 * `str` buys 1.1 pp for another +34,685 B and `i31` 0.6 pp for +31,399 B, so
 * both are left out of the default and remain selectable by name. `boxnum` and
 * `bigint` never fire once on this corpus — entry (17) predicted i31 integers
 * would dominate and they do not: on acorn, ToBoolean sees boxed BOOLEANS and
 * the `undefined` singleton, essentially never a number.
 */
const DEFAULT_ARMS = ["anyval", "boxbool"];

/**
 * Names `armName` (`is-truthy-ladder.ts`) can produce, plus the `t<idx>`
 * positional escape hatch. Used only to tell an explicit arm SELECTION from a
 * malformed value: a selection naming nothing recognisable is a typo, and a
 * typo must land on the tuned default rather than silently disabling the pass.
 */
const KNOWN_ARMS = new Set(["i31", "anyval", "boxnum", "boxbool", "bigint", "str"]);
const isArmName = (s: string): boolean => KNOWN_ARMS.has(s) || /^t\d+$/.test(s);

/** Selected arm names, or `undefined` when the pass is explicitly off. */
function selectedArms(): string[] | undefined {
  const raw = process.env.JS2WASM_INLINE_TRUTHY_IC;
  if (!tunedFlagEnabled(raw)) return undefined;
  if (raw === undefined) return DEFAULT_ARMS;
  const norm = raw.trim().toLowerCase();
  if (norm === "1" || norm === "on") return DEFAULT_ARMS;
  if (norm === "all") return ["*"];
  const names = norm
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return names.some(isArmName) ? names : DEFAULT_ARMS;
}

/** Did the operator name this flag, as opposed to inheriting the tuned default? */
function truthyIcExplicit(): boolean {
  return tunedFlagExplicit(process.env.JS2WASM_INLINE_TRUTHY_IC);
}

/** Declared supertype chain of `typeIdx`, itself first. */
function superChain(ctx: CodegenContext, typeIdx: number): number[] {
  const out: number[] = [];
  let cur = typeIdx;
  for (let guard = 0; guard < 64 && cur >= 0; guard++) {
    out.push(cur);
    const t = ctx.mod.types[cur];
    const sup = t && t.kind === "struct" ? t.superTypeIdx : undefined;
    if (sup === undefined) break;
    cur = sup;
  }
  return out;
}

/**
 * Conservative: can ONE value satisfy `ref.test $a` and `ref.test $b`?
 *
 * Sound because a wasm heap type's ancestry is a chain: any subtype `S` of `a`
 * has ancestors `{a} ∪ ancestors(a)`, so `S <: b` implies `b` is `a`, an
 * ancestor of `a`, or (when `b <: a`) `S` itself — all three are caught by
 * comparing the two chains. The remaining way two distinct declarations can be
 * one type is structural canonicalization, which is ruled out only when the
 * declarations differ in field count, in a field's value-type kind or
 * mutability, or in whether they declare a supertype at all. Anything not ruled
 * out returns `true` (= refuse to inline).
 */
export function mayAlias(ctx: CodegenContext, a: number, b: number): boolean {
  if (a === b) return true;
  if (a < 0 || b < 0) {
    // i31 is disjoint from every concrete (struct/array) type; any other
    // abstract heap type is not modelled here, so refuse.
    const abstractOk = (x: number, y: number): boolean => x === -20 && y >= 0;
    return !(abstractOk(a, b) || abstractOk(b, a));
  }
  const ca = superChain(ctx, a);
  const cb = superChain(ctx, b);
  if (ca.includes(b) || cb.includes(a)) return true;
  const ta = ctx.mod.types[a];
  const tb = ctx.mod.types[b];
  if (!ta || !tb) return true;
  if (ta.kind !== "struct" || tb.kind !== "struct") return ta.kind === tb.kind;
  if ((ta.superTypeIdx === undefined) !== (tb.superTypeIdx === undefined)) return false;
  if (ta.fields.length !== tb.fields.length) return false;
  for (let i = 0; i < ta.fields.length; i++) {
    const fa = ta.fields[i]!;
    const fb = tb.fields[i]!;
    if (fa.mutable !== fb.mutable) return false;
    if (fa.type.kind !== fb.type.kind) return false;
  }
  return true; // same shape as far as this check can see — refuse.
}

/** The arms to inline, in ladder order, after selection and disjointness. */
function planArms(ctx: CodegenContext, all: TruthyArm[], want: string[], declines: string[]): TruthyArm[] {
  const takeAll = want.length === 1 && want[0] === "*";
  const chosen: TruthyArm[] = [];
  for (let k = 0; k < all.length; k++) {
    const arm = all[k]!;
    if (!takeAll && !want.includes(arm.name)) continue;
    // Sound only if no EARLIER arm of the helper's ladder could also claim this
    // arm's values — otherwise the helper would have answered differently.
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (mayAlias(ctx, arm.typeIdx, all[j]!.typeIdx)) {
        declines.push(`${arm.name}:aliases-${all[j]!.name}`);
        ok = false;
        break;
      }
    }
    if (ok) chosen.push(arm);
  }
  return chosen;
}

interface SiteCtx {
  arms: TruthyArm[];
  callInstr: Instr;
  anyScratch: number;
  f64Scratch: number;
  /** The helper's own local indices, as reported by the ladder extraction. */
  helperAnyLocal: number;
  poison: boolean;
}

/** Build the nested guard chain for arm `k` and beyond. */
function chainFrom(s: SiteCtx, k: number): Instr[] {
  if (k >= s.arms.length) {
    return [{ op: "local.get", index: s.anyScratch }, { op: "extern.convert_any" }, s.callInstr];
  }
  const arm = s.arms[k]!;
  // Re-home the helper's two scratch locals onto this function's. Extraction
  // already proved the tail touches no other local, so this rewrite is total.
  const tail = arm.tail.map((i) => {
    const c = { ...i } as Instr & { op: string; index?: number };
    if ((c.op === "local.get" || c.op === "local.tee") && c.index !== undefined) {
      c.index = c.index === s.helperAnyLocal ? s.anyScratch : s.f64Scratch;
    }
    return c as Instr;
  });
  return [
    { op: "local.get", index: s.anyScratch },
    { op: "ref.test", typeIdx: arm.typeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "local.get", index: s.anyScratch }, ...tail, ...(s.poison ? ([{ op: "i32.eqz" }] as Instr[]) : [])],
      else: chainFrom(s, k + 1),
    },
  ];
}

interface Stats {
  patched: number;
  declinedProducer: number;
  perFn: number;
  /** The helper's anyref scratch index, needed to re-home copied arm tails. */
  helperAnyLocal: number;
}

/** Rewrite one instruction array in place, recursing into nested bodies. */
function rewriteInstrs(
  ctx: CodegenContext,
  fn: WasmFunction,
  instrs: Instr[],
  truthyIdx: number,
  arms: TruthyArm[],
  scratch: (f64: boolean) => number,
  stats: Stats,
): void {
  const out: Instr[] = [];
  for (const instr of instrs) {
    const a = instr as { op: string; funcIdx?: number; body?: Instr[]; then?: Instr[]; else?: Instr[] } & {
      catches?: { body?: Instr[] }[];
      catchAll?: Instr[];
    };
    if (Array.isArray(a.body)) rewriteInstrs(ctx, fn, a.body, truthyIdx, arms, scratch, stats);
    if (Array.isArray(a.then)) rewriteInstrs(ctx, fn, a.then, truthyIdx, arms, scratch, stats);
    if (Array.isArray(a.else)) rewriteInstrs(ctx, fn, a.else, truthyIdx, arms, scratch, stats);
    if (Array.isArray(a.catches)) {
      for (const c of a.catches)
        if (Array.isArray(c.body)) rewriteInstrs(ctx, fn, c.body, truthyIdx, arms, scratch, stats);
    }
    if (Array.isArray(a.catchAll)) rewriteInstrs(ctx, fn, a.catchAll, truthyIdx, arms, scratch, stats);

    if (a.op !== "call" || a.funcIdx !== truthyIdx) {
      out.push(instr);
      continue;
    }
    const prev = out[out.length - 1];
    if (!producesExternref(ctx, fn, prev)) {
      stats.declinedProducer++;
      out.push(instr);
      continue;
    }
    // The site already holds the internal reference and converted it purely to
    // satisfy the helper's externref ABI; the guard wants it back. Dropping the
    // site's own conversion is 2 instructions cheaper than adding the inverse,
    // and leaves the hit path with no conversion at all.
    const alreadyAny = (prev as { op: string }).op === "extern.convert_any";
    if (alreadyAny) out.pop();
    const anyScratch = scratch(false);
    const needsF64 = arms.some((x) => x.usesF64Scratch);
    const f64Scratch = needsF64 ? scratch(true) : -1;
    const helperAnyLocal = stats.helperAnyLocal;
    if (!alreadyAny) out.push({ op: "any.convert_extern" });
    const site: SiteCtx = {
      arms,
      callInstr: instr,
      anyScratch,
      f64Scratch,
      helperAnyLocal,
      poison: process.env.JS2WASM_INLINE_TRUTHY_IC_POISON === "1",
    };
    // `local.tee` feeds the first `ref.test` straight from the stack, so the
    // chain's own leading `local.get` is dropped — one instruction per site.
    const chain = chainFrom(site, 0);
    chain.shift();
    out.push({ op: "local.tee", index: anyScratch });
    out.push(...chain);
    stats.patched++;
    stats.perFn++;
  }
  instrs.length = 0;
  instrs.push(...out);
}

/** Resolve the DEFINED `__is_truthy`, or `undefined` in host-import mode. */
function definedTruthy(ctx: CodegenContext): { funcIdx: number; fn: WasmFunction } | undefined {
  const funcIdx = ctx.funcMap.get("__is_truthy");
  if (funcIdx === undefined || funcIdx < ctx.numImportFuncs) return undefined;
  const fn = ctx.mod.functions[funcIdx - ctx.numImportFuncs];
  if (!fn || fn.name !== "__is_truthy" || fn.body.length === 0) return undefined;
  return { funcIdx, fn };
}

/**
 * (#4157) Inline the selected `__is_truthy` ladder arms at every eligible call
 * site.
 *
 * MUST run at the same finalize point as `inlineMemberGetCallSites` — after the
 * helper bodies are final and BEFORE any pass that remaps type or function
 * indices — so the `typeIdx` operands it copies stay in the helper's own
 * regime. Runs by default; a no-op only when `JS2WASM_INLINE_TRUTHY_IC` is
 * explicitly off.
 */
export function inlineIsTruthyCallSites(ctx: CodegenContext): void {
  const want = selectedArms();
  if (!want) return; // explicitly OFF — byte-identical to the pre-#4157 base.
  const debug = process.env.JS2WASM_INLINE_TRUTHY_IC_DEBUG === "1";
  const target = definedTruthy(ctx);
  if (!target) {
    if (debug) process.stderr.write(`[truthy-ic] no defined __is_truthy (host-import mode) — pass declined\n`);
    return;
  }
  const t = ctx.mod.types[target.fn.typeIdx];
  const numParams = t && t.kind === "func" ? t.params.length : 1;
  const ladder = extractTruthyLadder(ctx, target.fn.body, numParams);
  if (!ladder) {
    process.stderr.write(`[truthy-ic] REFUSED: __is_truthy body does not match the accepted ladder shape\n`);
    return;
  }
  const declines: string[] = [];
  const arms = planArms(ctx, ladder.arms, want, declines);
  if (arms.length === 0) {
    process.stderr.write(
      `[truthy-ic] no arms selected (available: ${ladder.arms.map((x) => x.name).join(",")}` +
        `${declines.length > 0 ? `; declined: ${declines.join(" ")}` : ""})\n`,
    );
    return;
  }

  const stats: Stats = { patched: 0, declinedProducer: 0, perFn: 0, helperAnyLocal: ladder.anyLocal };
  let fnsTouched = 0;
  for (const fn of ctx.mod.functions) {
    if (fn.name === "__is_truthy") continue;
    let anyIdx = -1;
    let f64Idx = -1;
    const scratch = (f64: boolean): number => {
      const ty = ctx.mod.types[fn.typeIdx];
      const nparams = ty && ty.kind === "func" ? ty.params.length : 0;
      if (f64) {
        if (f64Idx < 0) {
          f64Idx = nparams + fn.locals.length;
          fn.locals.push({ name: "__tr_f64", type: { kind: "f64" } });
        }
        return f64Idx;
      }
      if (anyIdx < 0) {
        anyIdx = nparams + fn.locals.length;
        fn.locals.push({ name: "__tr_val", type: { kind: "anyref" } });
      }
      return anyIdx;
    };
    stats.perFn = 0;
    rewriteInstrs(ctx, fn, fn.body, target.funcIdx, arms, scratch, stats);
    if (stats.perFn > 0) fnsTouched++;
  }

  // The "it fired" line is evidence for someone experimenting with the flag,
  // and pure noise on every ordinary compile now that the pass runs by default
  // — so it is printed only when the flag (or the debug channel) was asked for.
  if (debug || truthyIcExplicit()) {
    process.stderr.write(
      `[truthy-ic] arms=${arms.map((x) => x.name).join(",")} patched-sites=${stats.patched} ` +
        `functions=${fnsTouched} declined-producer-shape=${stats.declinedProducer}` +
        `${declines.length > 0 ? ` declined-arms=${declines.join(" ")}` : ""}` +
        `${process.env.JS2WASM_INLINE_TRUTHY_IC_POISON === "1" ? " POISON=ON" : ""}\n`,
    );
  }
  if (debug) {
    process.stderr.write(
      `[truthy-ic] ladder: ${ladder.arms.map((x) => `${x.name}#${x.typeIdx}(${x.tail.length})`).join(" ")}\n`,
    );
  }
}
