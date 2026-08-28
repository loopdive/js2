// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4406) The RETURN-TYPE UNBOXING ABI — its flag family and its census.
 *
 * ## What the flag turns on
 *
 * A fnctor prototype method whose whole-program verdict is "returns a boolean
 * on every path" gets a typed twin whose wasm result is a **boolean-branded
 * `i32`** instead of the declaration-derived `externref`. See
 * `refinedTwinReturnType` in `typed-this.ts` for the decision point, which
 * stays the single one both consumers (the twin's minting and the trampoline
 * reservation) ask.
 *
 * ## Why it is DEFAULT-ON as of Phase 4 (it was opt-in for Phases 0–3)
 *
 * Phases 0–3 shipped opt-in on a deliberate rule: a mechanism that has not been
 * through a measured gate must not inherit the tuned set's inverted default,
 * because "byte-identical when off" is untestable when there is no "off" until
 * someone sets a variable they do not know exists.
 *
 * Phase 4 retires that reasoning for this flag, on two grounds and not on a
 * perf argument:
 *
 * 1. **The OFF position is the miscompile.** With the flag off,
 *    `refinedTwinReturnType` reaches its numeric arm for a predicate method and
 *    mints an `f64` twin, because `Prover.isNumeric` deliberately answers true
 *    for booleans and the `numericFunctions` loop carries no `isBooleanish`
 *    filter (the plan's §1.2). Measured on `origin/main` @ `f727d529ab`, four
 *    witnesses answer wrongly by default and correctly with the flag on:
 *    `("" + p.pred(5)).length` reads 1 (`"1"`) where node reads 4 (`"true"`),
 *    the false case reads 1 (`"0"`) where node reads 5 (`"false"`), and
 *    `typeof p.pred(5)` reads `"number"`. Keeping a correctness fix behind an
 *    opt-in flag ships the defect.
 * 2. **It HAS been through the gate**, three times: Phase 1's funnel + poison,
 *    Phase 2's lever-4 decline tally, Phase 3's parameter census — each with a
 *    reproduced acorn checksum of 422 and a byte-identity sweep.
 *
 * The "off" stays testable because the family's OFF tokens are unchanged: this
 * predicate now uses `tunedFlagEnabled`, so unset ⇒ ON while
 * `0` / `off` / `false` / `no` / empty ⇒ OFF, and `JS2WASM_RET_UNBOX_ABI=0`
 * reproduces the pre-Phase-4 default artifact byte-for-byte.
 *
 * ## What the flag now also gates (Phase 4)
 *
 * The ADMISSION FILTER on the `numericFunctions` fixpoint
 * (`numeric-property-analysis.ts`). The flag's boolean arm keeps a predicate
 * out of an `f64` twin, but `numericFunctionNames` has a SECOND consumer —
 * `provenNumericOperand` in `binary-ops.ts` — which the arm cannot reach, and
 * which mis-lowers `this.tag + this.eq(x)` as f64 arithmetic. Withdrawing the
 * boolean names from the verdict itself is what makes the two consumers agree.
 * See {@link retUnboxNumericFilterEnabled}.
 *
 * ## Module shape
 *
 * A LEAF — types plus `perf-flags.js`, nothing else — so both `typed-this.ts`
 * (the emission decisions) and `statements/control-flow.ts` (the ToBoolean
 * return arm) can read the same predicate without a cycle, and so the census
 * lives beside the flag rather than inside a god-file.
 */
import type { ValType } from "../ir/types.js";
import { tunedFlagEnabled } from "../perf-flags.js";
import type { CodegenContext } from "./context/types.js";

/**
 * Is the refined boolean return ABI enabled? Unset ⇒ **true** (Phase 4; it was
 * `optInFlagEnabled` for Phases 0–3 — the module header records why it moved).
 */
export function retUnboxAbiEnabled(): boolean {
  return tunedFlagEnabled(process.env.JS2WASM_RET_UNBOX_ABI);
}

/**
 * (Phase 4) Is the ADMISSION FILTER on the `numericFunctions` fixpoint on?
 *
 * `Prover.isNumeric` answers true for booleans by design, and the
 * `numericFunctions` loop — alone among the three loops in that fixpoint —
 * applies no `isBooleanish` filter, so `booleanFunctionNames` is a strict
 * SUBSET of `numericFunctionNames`. Phase 1 worked around that inside
 * `refinedTwinReturnType` by testing boolean BEFORE numeric. That fixes the
 * twin, and nothing else: the plan's §3.2 deliberately deferred subtracting the
 * names from the verdict because the set's other consumer
 * (`provenNumericOperand`, `binary-ops.ts`) would change behaviour.
 *
 * Phase 4 is where that is paid. It rides the SAME variable as the rest of the
 * ABI on purpose — the two are a matched pair, and splitting them is the one
 * combination that regresses: withdrawing a name from `numericFunctions` while
 * the boolean arm is off costs it an `f64` twin and gives it no `i32` one,
 * which is exactly the ordering hazard the plan's §6 Phase 4 warns about.
 */
export function retUnboxNumericFilterEnabled(): boolean {
  return retUnboxAbiEnabled();
}

/**
 * (Phase 2) Is the MERGE half of the ABI on?
 *
 * Phase 1 typed the CALLEE's result. Phase 2 types the logical-value MERGE that
 * consumes it: `expressions/logical-ops.ts` unifies `i32 || externref` to
 * `externref`, so a proven-boolean arm re-boxes at the merge even though the
 * merged value is about to be ToBoolean'd again. The plan (§3.4) prefers
 * reusing lever 4 (`box-boolean-fuse.ts`, #4157) over building a second
 * merge-typing pass, so this predicate gates a new LEAF KIND inside that pass
 * rather than a pass of its own — and it therefore also requires
 * `JS2WASM_UNBOXED_BOOL_FUSE`, which is lever 4's own default-OFF gate.
 *
 * It rides the SAME `JS2WASM_RET_UNBOX_ABI` variable on purpose: the two halves
 * compose (every callee Phase 1 retypes turns a merge arm from a sink leaf into
 * a free box leaf), so a lane that measures one without the other measures a
 * shape that will never ship.
 */
export function retUnboxMergeSinkEnabled(): boolean {
  return retUnboxAbiEnabled();
}

/**
 * Companion POISON switch (#4157 entry 22's lesson): with BOTH this and the
 * main flag on, every refined boolean result is INVERTED at the trampoline
 * edge, and (Phase 2) so is every merge whose fusion used a sunk consumer. A
 * workload whose answer is unchanged under poison did not execute a single
 * refined boolean call — which is the only way to tell a real null from a path
 * that never ran. Poison alone (main flag off) is inert.
 */
export function retUnboxAbiPoisoned(): boolean {
  return retUnboxAbiEnabled() && process.env.JS2WASM_RET_UNBOX_ABI_POISON === "1";
}

/** Is `type` the boolean-branded i32 this ABI carries? */
export function isBrandedBoolean(type: ValType | undefined): boolean {
  return type !== undefined && type.kind === "i32" && type.boolean === true;
}

/** Compact one-token spelling of a twin/trampoline result list, for the census. */
function describeResults(results: readonly ValType[]): string {
  if (results.length === 0) return "void";
  const only = results[0]!;
  return isBrandedBoolean(only) ? "i32b" : only.kind;
}

/**
 * (Phase 0) The return-ABI funnel, printed at finalize when
 * `JS2WASM_RET_UNBOX_STATS=1`.
 *
 * Reports `names → twins → trampolines`, not just a top line, because the two
 * facts this issue turns on are both invisible from a total: that
 * `booleanFunctionNames` is a strict SUBSET of `numericFunctionNames` (so a
 * numeric-first test would claim every predicate as f64), and how many of those
 * names reach a twin or a trampoline at all.
 *
 * House rule, same as `alloc-census.ts` / `receiver-spec-census.ts`: the caller
 * makes this call as a STATEMENT, never as part of a condition, so no emission
 * decision anywhere can depend on whether the census is enabled.
 */
export function noteRetUnboxStats(ctx: CodegenContext): void {
  if (process.env.JS2WASM_RET_UNBOX_STATS !== "1") return;
  const booleans = ctx.booleanFunctionNames ?? new Set<string>();
  const numerics = ctx.numericFunctionNames ?? new Set<string>();
  const overlap = [...booleans].filter((n) => numerics.has(n));
  const twinResultOf = new Map<string, string>();
  for (const [key, twin] of ctx.directCallTwins ?? []) {
    twinResultOf.set(key.slice(key.indexOf("/") + 1), describeResults(twin.results));
  }
  const trampolineResultOf = new Map<string, string>();
  for (const t of ctx.directCallTrampolines?.values() ?? []) {
    trampolineResultOf.set(t.methodName, describeResults(t.results));
  }
  const rows = [...booleans]
    .sort()
    .map((n) => `${n}[twin=${twinResultOf.get(n) ?? "-"} tramp=${trampolineResultOf.get(n) ?? "-"}]`);
  const i32bCount = (m: Map<string, string>): number => [...m.values()].filter((r) => r === "i32b").length;
  process.stderr.write(
    `[ret-unbox] flag=${retUnboxAbiEnabled() ? "on" : "off"}` +
      `${retUnboxAbiPoisoned() ? " POISON=ON" : ""} numericFunctions=${numerics.size} ` +
      `booleanFunctions=${booleans.size} overlap=${overlap.length} booleanOnly=${booleans.size - overlap.length}\n` +
      `[ret-unbox] twins=${twinResultOf.size} i32Boolean=${i32bCount(twinResultOf)} ` +
      `trampolines=${trampolineResultOf.size} i32Boolean=${i32bCount(trampolineResultOf)}\n` +
      `[ret-unbox] booleanNames: ${rows.join(" ")}\n`,
  );
}
