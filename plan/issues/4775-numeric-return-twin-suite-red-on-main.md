---
id: 4775
title: "tests/issue-3754-numeric-return-twin.test.ts is 9/10 RED on main and nothing gates it"
status: done
completed: 2026-08-27
assignee: ttraenkler/opus-4775
loc-budget-allow:
  # (2026-08-27) +26 lines on a god-file already at its ceiling, for an 11-line
  # fix. The growth is almost entirely the comment, and the comment is the
  # point: this is a TRY-ORDER invariant, invisible in the code itself, whose
  # silent breakage cost 27.8x on the `method` axis for three days with every
  # required check green. The next well-intentioned widening of the carrier
  # fallback re-breaks it unless the reason is written where the reorder is.
  # The long-form causal chain lives in this file; the source keeps only the
  # chain and the "do not move this" constraint.
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  # Same +26, same rationale — `compileReceiverMethodCall` is the god-function
  # inside the god-file, and the reorder has to happen at the exact point where
  # the struct-receiver arm would otherwise return. Splitting the function is
  # the right long-term move (#3399) and is not this bug fix's job.
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
sprint: current
created: 2026-08-27
updated: 2026-08-27
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: testing
related: [3754, 3753, 4406, 4405]
# (2026-08-27) Reserved with `--allow-unscanned` — no `gh` in this container, so
# `claim-issue.mjs`'s open-PR scan degrades unconditionally. The scan was run
# directly against the REST API with curl instead: 5 open PRs on loopdive/js2
# touch issue ids {2949, 4406, 4768, 4770, 4771, 4773}. 4775 is not among them.
---

# #4775 — the numeric-return-twin suite is red on main, unnoticed

## Problem

`tests/issue-3754-numeric-return-twin.test.ts` fails **9 of its 10 tests** on
`origin/main` @ `7e0b03ebb7`. Every failure is the same shape:

```
AssertionError: expected '' to be 'externref'   (and 'f64', and 'i32')
  at trampolineResultType("__dc_P_inc_0_g")
```

The helper returns `''` when the module has no function of that name — so the
`__dc_P_inc_0_g` direct-call trampoline that file was written to observe is no
longer emitted for its `methodAxis` shape. The one passing test is the
value-level one ("a dynamic call still reaches the same value through the
shim"), which does not read the WAT.

Found while implementing
[#4406](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4406-return-type-unboxing-abi)
Phase 0+1 (PR #5061). **Verified pre-existing**: every source file that PR
touches was reverted to `HEAD` and the suite re-run — the same 9 failures.

## Why nobody noticed

The file is not in a required check. The required six are `cheap gate`,
`quality`, `merge shard reports`, `check for test262 regressions`,
`equivalence-gate` and `cla-check`; this file lives under `tests/`, not
`tests/equivalence/`, so `equivalence-gate` does not run it, and the general
`npm test` lane does not gate. A shape-assertion suite that silently stopped
observing its subject is exactly the failure family #4157 entry 22 names: a
green (here: unwatched) run over a path that no longer exists proves nothing.

## The question this issue has to answer first

**Is the mechanism regressed, or is the test stale?** Both are plausible and
they need opposite fixes:

- *Stale test* — the direct-call admission rules moved (arity padding,
  receiver-flow proof, the `no-write-once-verdict` decline) and the file's
  `methodAxis` shape no longer reserves a trampoline. Then the fix is to
  re-derive the shape, not to relax the assertions: #3754's whole point is
  that the trampoline's result must FOLLOW the twin's, and an assertion
  loosened to keep the file green would prove nothing.
- *Regressed mechanism* — a devirtualization that used to happen no longer
  does, which would be a silent perf regression on the `method` axis #3754 was
  measured against (6.21× node at the time).

The instrument that distinguishes them already exists:
`JS2WASM_DIRECT_CALLS_DEBUG=1` prints `sites / trampolines / twinFills /
genericFills / legacyFills` plus a decline histogram. On the acorn lane today
that reads `sites=3976 trampolines=545 twinFills=516 genericFills=29
legacyFills=0`, so the machinery is alive at scale — which makes "the test's
own shape stopped qualifying" the more likely of the two. Run it on the file's
`methodAxis` source and read the decline reason.

`JS2WASM_RET_UNBOX_STATS=1` (added by #4406 Phase 0) prints the per-name
`twin=` / `tramp=` table for the same program and is the quicker read.

## Acceptance criteria

- The suite is green on main, with each assertion still pinning what its name
  claims (the trampoline result follows the twin; the negative cases still keep
  the boxed ABI).
- The issue records WHICH of the two causes it was, with the decline reason or
  the mechanism delta quoted.
- If the file's shape had to change, say what changed about admission and when
  — a shape that silently stopped qualifying once will do it again.
- Consider whether this suite (and its siblings under `tests/issue-37*.test.ts`)
  belong in a gating lane. A shape suite nobody runs is a comment.

---

## Answer (2026-08-27) — it is the REGRESSED-MECHANISM branch, on all 9 rows

The issue above framed this as "stale test or regressed mechanism?" and leaned
toward stale, on the strength of the acorn census. **It is the other one.** All
nine failures are one root cause, the test file is correct as written, and it
caught a **27.8x** performance regression on the very axis #3754 was measured
against — one that nothing else in the repo can see.

**No assertion was re-grounded, because none had rotted.** With the offending
lowering disabled the suite is **10/10 green, unmodified**. There is no stale
figure to re-pin and no wrong runtime value to structuralise (#4743/#4747
class): every value-level assertion in the file already passes today.

### Per-test verdict

| # | test | verdict | cause |
| --- | --- | --- | --- |
| 1 | the twin returns f64 and no longer boxes on the way out | **(b) regression** | `ad543a660e` |
| 2 | the trampoline's result follows the twin's (point 2) | **(b) regression** | `ad543a660e` |
| 3 | the call site consumes the f64 directly — no `__to_primitive` / `__unbox_number` | **(b) regression** | `ad543a660e` |
| 4 | produces the same value as the boxed ABI (kill-switch differential) | **(b) regression** | `ad543a660e` |
| 5 | a dynamic (non-devirtualized) call still reaches the same value through the shim | passes on main | — (never read the WAT) |
| 6 | a MIXED-return method keeps the boxed ABI | **(b) regression** | `ad543a660e` |
| 7 | a BARE `return;` keeps the boxed ABI | **(b) regression** | `ad543a660e` |
| 8 | a body that can FALL OFF THE END keeps the boxed ABI | **(b) regression** | `ad543a660e` |
| 9 | a STRING-returning method is not refined, and keeps its value | **(b) regression** | `ad543a660e` |
| 10 | a same-named method elsewhere that returns a non-number demotes BOTH | **(b) regression** | `ad543a660e` |

Rows 6–10 are the NEGATIVE cases, and they fail for the same reason as the
positive ones: they assert the trampoline keeps the **boxed** ABI, and there is
no trampoline at all to inspect. `trampolineResultType` answers `""` both for
"no such function" and for "function exists, no `__dc_res` local" — here it is
the first.

### Root cause

Landing commit **`ad543a660ecdee9811d5ae725431cf872ee06159`** — *"fix(npm-compat):
advance upstream package test execution"*, 2026-08-24, the Axios 61→135 /
React 14/14 / Hono 44/44 / Marked 8/8 change. Found by `git bisect` over the
3517 commits between `df9f73ebc9` (good) and `2a7548ca81` (bad), using a
self-contained probe rather than the test file, so the verdict does not depend
on the file's own content at the bisected commit.

The commit added a **wasm-carrier fallback** to the struct-receiver resolution.
It has since been refactored into `resolveStructNameForExpr`, and today lives at
`src/codegen/property-access.ts:1097-1099`:

```ts
if (!typeName && (resolvedCarrier?.kind === "ref" || resolvedCarrier?.kind === "ref_null")) {
  typeName = ctx.typeIdxToStructName.get(resolvedCarrier.typeIdx);
}
```

A fnctor local — `var p = new P(0)` — has no checker-resolvable struct name, but
its physical wasm carrier IS `(ref null $__fnctor_P)`. So the fallback now
resolves it, the struct-receiver block at
`src/codegen/expressions/call-receiver-method.ts:2100` claims `p.inc()`, finds no
`__fnctor_P_inc` in `funcMap`, and hands the call to
`compileCallablePropertyCall`. That function's #1712 arm routes an approved
standalone fnctor to `emitFnctorSubclassDynamicMethodCall` — the fully dynamic
`__fsd_*` ladder — and **returns**.

The return is the whole bug. `tryEmitDirectTwinCall`, which owns #3754's and
#3685's devirtualization, is reached from
`tryCompileLateFnctorPrototypeMethodCall` at line **3503** of the same function.
The new arm answers at line 2114 and the call never gets there. Of the three
admission routes into the trampoline machinery, this kills exactly route **(c)**
(`recv.m()` on a non-`this` receiver); routes (a) and (b) (`this.m()` inside a
twin / a pinned generic body) are untouched.

### What it costs — 27.8x, measured

Interleaved A/B in one container, three rounds, `benchmarks/cross-engine`,
min-of-5 per reading. Checksums matched on every axis in every round.

| axis | HEAD (fallback ON) | fallback disabled |
| --- | ---: | ---: |
| **method** | **25.74 / 25.59 / 25.68** | **0.924 / 0.905 / 0.918** |
| numeric | 2.45 / 2.44 / 2.42 | 2.47 / 2.45 / 2.49 |
| prop | 1.19 / 1.18 / 1.19 | 1.21 / 1.17 / 1.18 |
| alloc | 0.236 / 0.236 / 0.237 | 0.245 / 0.236 / 0.236 |
| tokenizer | 0.521 / 0.507 / 0.513 | 0.489 / 0.717 / 0.471 |
| string | 0.378 / 0.371 / 0.383 | 0.387 / 0.373 / 0.373 |

`numeric` is the noise probe — an axis this lowering cannot touch — and it is
flat across all six arms, so the `method` column is signal, not drift.

**Re-measured on the shipping tree**, fixed vs clean `main`, alternating
A/B/A/B/A/B in one container. Checksums identical on every axis in every round
(`method` reads `45000150000` in both arms — only the speed differs, which is
what makes this a pure perf finding and not a correctness one):

| axis | fixed (this branch) | clean main | |
| --- | ---: | ---: | --- |
| **method** | **0.940 / 0.903 / 0.903** | **25.24 / 25.80 / 26.07** | **28.5x** |
| numeric | 2.530 / 2.406 / 2.423 | 2.433 / 2.456 / 2.479 | probe, flat |
| prop | 1.227 / 1.186 / 1.169 | 1.169 / 1.200 / 1.178 | flat |
| alloc | 0.257 / 0.239 / 0.236 | 0.237 / 0.236 / 0.242 | flat |
| tokenizer | 0.512 / 0.491 / 0.495 | 0.512 / 0.510 / 0.524 | flat |
| string | 0.383 / 0.382 / 0.429 | 0.389 / 0.371 / 0.386 | flat |

This is **worse than the pre-#3754 baseline**, not merely a lost win. #3754
recorded `method` at 4.22 ms with numeric twins off and 0.95 ms with them on;
today's 25.7 ms is ~6x worse than the boxed-ABI arm it improved on, because the
call no longer reaches a trampoline of either kind — it goes all the way to the
dynamic dispatch ladder. Against the node figure recorded in #3754
(0.426–0.474 ms), the axis has gone from **1.99x to ~54x**.

### Why the acorn census pointed the wrong way

The issue cited `sites=3976 trampolines=545 twinFills=516 genericFills=29
legacyFills=0` on the acorn lane as evidence the mechanism was alive, and
concluded the test's shape must have stopped qualifying. Re-measured here in
**both** arms, that census is **byte-identical**:

```
carrier fallback ON  → sites=3976 trampolines=545 twinFills=516 genericFills=29 legacyFills=0
carrier fallback OFF → sites=3976 trampolines=545 twinFills=516 genericFills=29 legacyFills=0
```

Acorn devirtualizes almost entirely through `this.m()` inside twins — routes (a)
and (b) — which never pass through the struct-receiver arm. Acorn is
**structurally blind** to a route-(c) regression, so its being healthy carried no
information about the thing in question. This is the #4157 entry-22 shape
exactly: a green reading over a path the change does not traverse.

### Non-vacuity

The suite's assertions are load-bearing, demonstrated by mutating the mechanism
rather than the test:

- Disable the carrier fallback (restore the pre-`ad543a660e` resolution): the
  unmodified suite goes **10/10 green** and `method` returns to 0.905 ms.
- Leave it enabled (HEAD): **9/10 red**, `method` 25.7 ms.
- The file's own kill switch is independently non-vacuous — row 4 asserts
  `JS2WASM_NUMERIC_TWINS=0` really does flip the trampoline result to
  `externref`, so its differential compares two genuinely different modules.

### The fix

Eleven lines at `src/codegen/expressions/call-receiver-method.ts:2107`: when
`structTypeName` names a `__fnctor_*` and no method `funcIdx` resolved, try
`tryEmitDirectTwinCall` before `compileCallablePropertyCall`. A decline falls
through to exactly today's lowering.

**This is not a revert of `ad543a660e`.** The carrier fallback stays; nothing is
removed or narrowed. Only the try-ORDER changes, and only for a receiver whose
struct name begins `__fnctor_`. Every receiver that does not devirtualize —
which is every receiver the npm-compat work cares about — reaches
`compileCallablePropertyCall` exactly as before, so its lowering is unchanged.
`tryEmitDirectTwinCall` is itself already narrow: it declines unless
`ctx.standalone`, and route (c) additionally requires `provenReceiverClass` to
prove the receiver denotes exactly one approved fnctor class.

#### Adjudication (project lead, 2026-08-27)

Landed here rather than routed to the owning lane, on the record:

- It is a try-order restoration, not a revert — `ad543a660e`'s change and its
  intent are preserved intact.
- Its own test surface was validated under the fix before landing (below).
- The owning codex lane was not addressable at the time, and a 27.8x regression
  on the flagship devirtualization path with **zero** gating coverage should not
  wait on an unreachable lane.

#### For the npm-compat lane

Your change is intact and your functionality is preserved — verified, not
assumed. `ad543a660e`'s own tests were run under this fix:
`issue-3995-hono-class-boundary`, `issue-4527-call-dyn-bridge`, all three
`issue-4618` files, `issue-1279`, `issue-3097` — **131 passed, 1 failed**, and
that one failure is **pre-existing red on clean `main`** with this fix absent
(now tracked as
[#4782](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4782-issue-4527-mixed-spread-arguments-red-on-main)).
The acorn standalone lane is byte-identical before and after. If the carrier
fallback needs to widen further, this reorder does not stand in the way — it
only asks that a proven fnctor receiver be offered devirtualization first.

### Validation on the shipping tree

| gate | result |
| --- | --- |
| `tests/issue-3754-numeric-return-twin.test.ts` | **10/10** (was 9/10 red) |
| `test:changed-root` | selects the suite, green |
| 8 equivalence shards (`SHARD=n/8`, separate processes, as `ci.yml` runs them) | **8/8 exit 0**, "no new equivalence regressions" on every shard |
| typecheck (`typescript7`) / `lint` (biome) | clean |
| `check:loc-budget` / `check:func-budget` | +26 on the god-file/god-function, granted in this file's frontmatter with rationale |
| `check:coercion-sites` / `check:oracle-ratchet` / `check:dead-exports` | clean, no net growth |
| `check:ir-fallbacks` | **unchanged** — no unintended/post-claim/module-level increases; baseline file untouched |
| acorn standalone lane, fixed vs clean main | **byte-identical: 1,665,854 bytes both arms**, census identical, all four canaries pass, 0 imports |
| `ad543a660e`'s own tests (7 files) | 131 passed / 1 failed, that 1 pre-existing red on clean main (#4782) |

Test262 is not run locally; CI's `merge_group` re-validation owns conformance.

### Residuals filed

- [#4782](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4782-issue-4527-mixed-spread-arguments-red-on-main)
  — `tests/issue-4527-call-dyn-bridge.test.ts` mixed-spread row is red on clean
  `main` (expected 52, got 46; spread-sourced `arguments` elements read as 0).
  Another ungated suite.
- [#4780](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4780-route-c-devirtualization-perf-floor)
  — no gated floor exists for route-c devirtualization. Proposal only, with the
  interleaved-A/B + noise-probe method recorded so it need not be re-derived.

### On the gating question

The last acceptance bullet asks whether this suite belongs in a gating lane. The
evidence answers it: an unwatched shape suite let a **27.8x** regression on a
headline benchmark axis live on `main` for three days with every required check
green, and the one corpus anybody would have reached for (acorn) was
structurally unable to see it. Touching this file brings it into
`test:changed-root`; keeping it in a gating lane permanently is #4780's call.
