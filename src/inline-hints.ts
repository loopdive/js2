// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157 entry 15) `JS2WASM_INLINE_HINTS` — pass binaryen's inlining budget
 * knobs through to `wasm-opt`.
 *
 * ## Why this exists: the "inlining cliff" is not a cliff, it is a documented
 * threshold, and it has two clauses
 *
 * #4157 recorded two data points and inferred a cliff "somewhere between 11 and
 * 45 instructions": an 11-instruction helper was inlined at 1,255 sites, a
 * ~45-instruction one was declined at 1,812. Binaryen 125's own `--help` gives
 * the exact rule instead of the inference:
 *
 * | knob | flag | default |
 * | --- | --- | --- |
 * | always-inline max size | `-aimfs` | **2** |
 * | flexible-inline max size | `-fimfs` | **20** |
 * | one-caller-inline max size | `-ocimfs` | -1 (unlimited) |
 * | combined binary size cap | `-imcbs` | 409600 |
 * | inline functions with loops | `-ifwl` | off |
 * | partial-inlining ifs | `-pii` | 0 |
 *
 * `-fimfs`'s help text carries the clause that matters more than the number:
 * flexible inlining applies to functions that are **"lightweight (no loops or
 * function calls)"**. So a multi-caller helper is inlined only if it is
 * ≤ 20 instructions AND contains no call AND contains no loop.
 *
 * Two consequences for the size program in #4157:
 *
 * 1. **The 11-vs-45 pair is fully explained by `-fimfs=20`**, and every helper
 *    the issue wants inlined (`__extern_get`, `__str_flatten`, the `__dc_*`
 *    trampolines) fails the *lightweight* clause, not just the size clause — a
 *    trampoline exists to make a call. No amount of shrinking reaches those.
 * 2. **Outlining a cold path cannot make a hot path inlinable.** #4157 entry (9)
 *    split `__extern_get` so the residual would be small enough; the residual
 *    necessarily contains a `call` to the outlined half, which disqualifies it
 *    under the lightweight clause at ANY size. That is a structural reason for
 *    that experiment's null result, independent of the instruction count it
 *    was tuned against.
 *
 * What is left is raising the budget for the helpers that DO qualify — leaf,
 * loop-free helpers between 20 and N instructions. That is what this flag does.
 *
 * ## What was measured (standalone acorn, `wasm-opt -O4`, 2026-08-13)
 *
 * | args | binary | vs default |
 * | --- | ---: | ---: |
 * | `-O4` (today's shipped invocation) | 1,085,558 B | — |
 * | `-O4 -fimfs=60` | 1,208,325 B | **+11.3 %** |
 * | `-O4 --partial-inlining-ifs=2` | 1,085,584 B | +26 B |
 * | `-O4` + `no-inline@__new_TypeError` | **1,054,682 B** | **−2.85 %** |
 *
 * Three findings, and the third is why `cold` is the profile `1` selects:
 *
 * - **`-fimfs` reaches exactly the leaf helpers and nothing this issue cares
 *   about.** At 60 it inlines `__box_number` at all 993 sites (993 → 0 calls)
 *   and leaves `__extern_get` at 834 — because `__extern_get` has calls and
 *   loops, which disqualifies it at ANY budget. And #4157 entry (12) already
 *   priced inlining `__box_number` everywhere: indistinguishable from zero,
 *   sign flipped with run order. So the cheap path buys the one thing already
 *   measured worthless, for 11 % of binary size.
 * - **`--partial-inlining-ifs` does not fire on this module.** It is binaryen's
 *   native version of #4157 entry (9)'s hand-built cold-path outline, and it
 *   moves 26 bytes.
 * - **The default `-O4` inlines the COLD `__new_TypeError` constructor into all
 *   4,285 null-guard sites.** Marking it no-inline gives back 30,876 B and
 *   18,079 WAT lines for free — a cold constructor duplicated 4,285 times is
 *   pure caller bloat, and caller bloat is what blocks the callers' own
 *   inlining. This is the one knob that shrinks rather than grows.
 *
 * ## Usage
 *
 * - unset — **default `1`**, i.e. the `cold` profile, since the #4157 tuned-set
 *   flip (`src/perf-flags.ts`). This is the one knob measured to SHRINK.
 * - `0` / `off` / empty — no arguments added; argv byte-identical to the
 *   pre-#4157 invocation, which is the only way to get that emission back.
 * - `1` — the measured profile: `cold` (see above).
 * - `cold` — `--no-inline` over the cold-by-construction error constructors.
 * - `no-inline=<pat|pat>` — the same, with explicit `*`-wildcard patterns.
 * - an explicit comma list, e.g. `fimfs=64,aimfs=8,ifwl,pii=2,cold`.
 * - a spec that yields NO argument at all — every token unrecognised, or a
 *   rejected multi-pattern `no-inline=` — falls back to the default profile
 *   rather than to silence, so a typo cannot quietly un-tune the build.
 *
 * Only the `wasm-opt` CLI path honours these; the `binaryen` JS module fallback
 * exposes no equivalent setters, so a build that falls back to it is
 * unaffected.
 */

import { tunedFlagEnabled } from "./perf-flags.js";

/** Knobs binaryen 125 accepts, mapped to their long-form CLI flags. */
const NUMERIC_KNOBS: Record<string, string> = {
  aimfs: "--always-inline-max-function-size",
  fimfs: "--flexible-inline-max-function-size",
  ocimfs: "--one-caller-inline-max-function-size",
  imcbs: "--inline-max-combined-binary-size",
  pii: "--partial-inlining-ifs",
};

const BOOLEAN_KNOBS: Record<string, string> = {
  ifwl: "--inline-functions-with-loops",
};

/** The profile `JS2WASM_INLINE_HINTS=1` selects — the one measured shrink. */
const DEFAULT_PROFILE = "cold";

/**
 * Cold-by-construction callees: the JS error constructors, reached only on a
 * throw. ONE pattern, deliberately — see {@link inlineHintArgs}.
 */
const COLD_PATTERN = "__new_*";

export interface InlineHintArgs {
  /**
   * Arguments that MUST precede `-O<level>`. `--no-inline` is a PASS, and
   * binaryen runs passes in command order — placed after `-O4` it marks
   * functions no-inline once the inlining has already happened, which is a
   * silent no-op rather than an error.
   */
  pre: string[];
  /** Order-independent global option knobs. */
  post: string[];
}

/**
 * Translate `JS2WASM_INLINE_HINTS` into `wasm-opt` arguments. Both lists are
 * empty only when the flag is explicitly `0`/`off`/empty, so an OFF build
 * passes byte-identical arguments to the optimizer.
 *
 * ## `no-inline` takes ONE pattern, and a list is a SILENT no-op
 *
 * Measured against binaryen 125 on the standalone acorn build (baseline
 * 1,085,558 B):
 *
 * | `--pass-arg=no-inline@…` | binary | effect |
 * | --- | ---: | --- |
 * | `__new_TypeError` | 1,054,682 B | −30,876 B |
 * | `__new_*` | **1,052,620 B** | **−32,938 B** — wildcards work |
 * | `__new_TypeError,__new_Error` | 1,085,558 B | **byte-identical — IGNORED** |
 *
 * A comma-separated list matches nothing and `wasm-opt` still exits 0, so the
 * failure mode is an optimisation that silently does not happen. Hence exactly
 * one pattern is ever emitted, and a `no-inline=` value containing a comma is
 * rejected rather than forwarded.
 */
export function inlineHintArgs(raw = process.env.JS2WASM_INLINE_HINTS): InlineHintArgs {
  const empty: InlineHintArgs = { pre: [], post: [] };
  if (!tunedFlagEnabled(raw)) return empty;
  const value = (raw ?? "").trim();
  const spec = value === "" || value === "1" ? DEFAULT_PROFILE : value;
  const pre: string[] = [];
  const post: string[] = [];
  let noInline: string | undefined;
  for (const part of spec.split(",")) {
    const token = part.trim();
    if (token === "") continue;
    if (token === "cold") {
      noInline ??= COLD_PATTERN;
      continue;
    }
    const eq = token.indexOf("=");
    if (eq < 0) {
      const flag = BOOLEAN_KNOBS[token];
      if (flag) post.push(flag);
      continue;
    }
    const key = token.slice(0, eq).trim();
    const rest = token.slice(eq + 1).trim();
    if (key === "no-inline") {
      // `,` and `|` are the two shapes someone reaches for to express "several
      // patterns". Binaryen honours neither, so both are refused rather than
      // forwarded into a silent no-op.
      if (rest !== "" && !rest.includes(",") && !rest.includes("|")) noInline ??= rest;
      continue;
    }
    const num = Number(rest);
    const flag = NUMERIC_KNOBS[key];
    // A malformed knob is dropped rather than passed through: an unrecognised
    // argument makes wasm-opt exit non-zero, which `optimize.ts` reports as
    // "wasm-opt failed" and silently returns the UNOPTIMIZED binary — a far
    // more confusing failure than an ignored typo.
    if (flag && Number.isFinite(num)) post.push(`${flag}=${num}`);
  }
  // Every token was dropped — an all-typo spec, or a `no-inline=` the one-pattern
  // rule refused. That must not read as "off": off is `0`, and only `0`. Take
  // the default profile instead of silently shipping the untuned invocation.
  if (noInline === undefined && post.length === 0) noInline = COLD_PATTERN;
  if (noInline !== undefined) pre.push("--no-inline", `--pass-arg=no-inline@${noInline}`);
  return { pre, post };
}
