---
id: 3227
title: "default (JS-host) lane: async-completion harness callbacks never execute → 1,690 vacuous fails (#2940 detector), dominated by for-await-of / dynamic-import / Promise"
status: ready
loc-budget-allow:
  - src/codegen/async-cps.ts
  - src/codegen/expressions.ts
  - src/runtime.ts
regressions-allow:
  count: 1100
  reason: "#3227 S4's own purpose (async post-drain verdict re-read in the CI worker lane, ORACLE_VERSION 6->7) produces exactly this reclassification shape -- the S1-approved honesty regression (lead-approved 2026-07-16, precedent #3086) finally materializing at corpus scale because S1's re-read never reached scripts/test262-worker.mjs. merge_group run 29558462964: 1007 non-excused wasm-change regressions, verified 100% async-flagged tests (0 non-async, checked per-file frontmatter against the merged report), categories assertion_fail 972 / other 15 / runtime_error 15 / type_error 4 / range_error 1 -- premature sync passes correctly becoming honest post-drain fails, clustered on async-gen yield* abrupt-completion shapes (class/elements 200+200, async-gen-method* 56x4, object/method-definition 58). Traps all flat (null_deref 184->184, illegal_cast 87->87, oob 51->51, unreachable 8->8), zero new. Net -659 (33294->32635), 348 improvements (vacuous->honest pass). Ceiling: 1007 + ~93 margin."
sprint: current
priority: high
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: research+bugfix
area: codegen
language_feature: async, promises, for-await-of, dynamic-import, test262-harness
related: [3074, 3086, 3001, 2940, 2903, 2939, 1014, 1116, 1326c]
created: 2026-07-13
updated: 2026-07-16
origin: "2026-07-13 /harvest-errors. Baselines run 20260713-085257 (gitHash bb27494f, 32,990 pass), default lane test262-current.jsonl. Count unchanged from run 179d73ca."
---

# #3227 — default-lane async harness callbacks are vacuous (no assertion runs)

## Summary

The `#2940` vacuous-pass detector ("harness-wrapper callback never executed —
no assertion ran") fires **1,690 times in the DEFAULT (JS-host) lane**, making
it the single largest cited pattern in that lane's failing set. These were
previously _dishonest_ passes (the test compiled + ran to completion but its
assertion-bearing callback never executed, so nothing was actually checked);
the detector now honestly reclassifies them to `fail`.

This is **distinct from #3074** (done 2026-07-08), which cleared the
_TypedArray_ harness-wrapper vacuous cluster (`testWithTypedArrayConstructors`)
— that family is now gone from the top buckets. What remains, and what this
issue tracks, is the **async-completion** harness family (`.then` continuations
/ `$DONE` / for-await-of bodies). It is also distinct from the standalone
host-independence work in **#2903 / #2940** — that tracks removing the
`env::__make_callback` host _import_ in `--target standalone`. Here the host import **is available**, yet
the async-completion callback still never runs. That points to a genuine
dropped-async-continuation correctness bug in the JS-host lane, not a
host-leak/representation problem. No existing issue tracks the default-lane
side of this.

## Distribution (top feature buckets, default lane, 1,690 total)

| Count | Feature area                                                               |
| ----- | -------------------------------------------------------------------------- |
| 383   | `language/statements/for-await-of`                                         |
| 234   | `language/expressions/dynamic-import`                                      |
| 168   | `annexB/language/eval-code`                                                |
| 180   | `language/{statements,expressions}/class` (async methods)                  |
| 218   | `built-ins/Promise/{any,race,all,allSettled,prototype}`                    |
| 46    | `language/expressions/async-function`, `async-generator`                   |
| …     | remainder across Temporal ZonedDateTime/Instant async harness, direct eval |

Sample files:

- `language/expressions/dynamic-import/namespace/promise-then-ns-set-prototype-of.js`
- `language/expressions/async-function/nameless-dflt-params-ref-later.js`
- `language/expressions/async-generator/dstr/ary-ptrn-elem-id-iter-complete.js`
- `language/expressions/dynamic-import/catch/nested-async-function-eval-script-code-target.js`

## Root-cause hypothesis

test262 async tests wrap their assertions in a continuation that the harness
only invokes once a promise settles (the `$DONE` / `asyncTest` /
`.then(assertions)` pattern). The dominant buckets — `for-await-of`,
`dynamic-import` `.then` continuations, and the `Promise` combinators — all
depend on a microtask-scheduled callback firing. The callback body compiling
but never being _invoked_ is the same failure family flagged in #2903's TL;DR
("host-backed builtin methods: Promise.then/.catch, Iterator helpers"), but
manifesting as a _dropped continuation_ in the default lane rather than a host
leak. Likely candidates: the async continuation / microtask scheduling path
(`async-scheduler.ts`) not driving the queued `.then` callback for these
harness shapes, or the dynamic-dispatch arity/type tolerance from **#2939**
(marked done) covering only a subset.

## Acceptance criteria

- Pick one representative from each of the two largest buckets
  (`for-await-of`, `dynamic-import`) and confirm via a `.tmp/` repro that the
  assertion callback is genuinely never invoked (not merely asserting the
  wrong value).
- Identify why the continuation is dropped in the JS-host lane and fix so the
  callback runs; the vacuous detector count for these buckets drops
  materially.
- No regression to the standalone `__make_callback` front (#2903).

## Notes

- Detector mechanism: #2940 (done). Dynamic-dispatch arity/type fix: #2939
  (done) — clearly leaves a large residual here.
- Standalone counterpart of the vacuous flag is 779 records, tracked under
  #2903 (`ready`, host-independence). Keep the two fronts separate; a fix here
  targets the JS-host continuation path.
- **Not** covered by #3086 (honest-vacuity oracle scorer / rebaseline,
  in-progress) or #3001 (remove #2940 reclassification excusal, blocked) — those
  are detector/oracle _infrastructure_; #3227 is the underlying _feature_ fix
  (make the async continuation actually run).

## Root cause — VERIFIED (2026-07-16, fable-3, slice 1)

The hypothesis ("dropped continuation") is WRONG in an interesting way — the
continuations are NOT dropped. Two verified mechanisms:

1. **Verdict read before host microtasks drain (the 1,690-record driver).**
   The runner calls `testFn()` synchronously (tests/test262-runner.ts,
   `runTest262File`) and reads the verdict from its return value. In the
   JS-host lane, `.then`/await continuations are scheduled on the HOST
   microtask queue, which structurally cannot drain while `test()` is still on
   the Wasm→JS stack. `__drain_microtasks()` is a deliberate no-op on this
   lane (#2895 PATH B). So the callbacks run — _immediately after `test()`
   returns_ — but the verdict was already read: `__assert_count === 1` → -262
   → "vacuous". Empirically verified: `Promise.resolve(42).then(v => count =
v)` shows count=0 sync, count=42 one macrotask later.

2. **`await <host promise>` yields NaN, synchronously (value corruption).**
   `const v = await Promise.resolve(7); count = v` sets count=NaN _before
   test() returns_ — the continuation runs eagerly with a garbage value
   (externref→f64 read of the promise, not its settled value). `await 7`
   (non-promise) is fine. This is a separate compiler bug (slice 2) and is
   the root of most honest-fail flips below (`v.value` NaN, `done` wrong).

## Slice plan (dispatchable)

- **S1 (PR #3161, fable-3, merged 2026-07-16) — async post-drain verdict re-read + ORACLE_VERSION 5.**
  `wrapTest` exports `__result()` (same verdict logic as the `test()` epilogue)
  for async-flagged tests; `runTest262File` yields 2× `setImmediate` after a
  sync `1`/`-262` and re-reads. A deferred continuation THROW during the drain
  window is captured via temporary `uncaughtException`/`unhandledRejection`
  handlers and scored a fail for that test (pre-S1 it fired unattributed
  between tests and could kill the fork worker). Verdict-logic change ⇒
  ORACLE_VERSION bumped (drafted as 3→4; landed as 4→5 — see the merge
  reconciliation note below; forward-monotonic auto-rebase in diff-test262).
  Measured on samples: 1,680 vacuous-callback records → ~25% flip to honest
  PASS (~420), ~62% to honest assert-fail (real signal, already scored fail
  today), ~8% stay vacuous; BUT ~25% of the 3,503 currently-passing
  async-flagged tests flip pass→honest-fail (~875, CI 525–1,225) because their
  post-await assertions finally run and hit real bugs. Net raw pass ≈ −455.
  Needs lead/PO sign-off (precedent: #3086 owner-approved honesty regression).
  **Post-merge observed net (promote-baseline at oracle v5, baseline_sha
  `bba9ac76`, 2026-07-16 19:43Z): 32,493 → 32,494 host — the corpus-scale
  flips nearly cancelled; the sampled −455 net did not materialize.**
- **S2 (PR #3165) — `await <host promise>` NaN corruption (JS-host lane).** Fix the await
  value read so the settled value is delivered (repro above; also the likely
  root of the `class-elements async-gen … v.value = 42` flip cluster). Expect
  this to recover a large share of the S1 pass→fail flips + convert many of
  the 1,680 into passes. Repro: `.tmp/repro-3227c.mts` shapes C1/C2/C4/C5.
  Fixed — see the S2 section below.
- **S3 — async-generator `.next().then(...)` result delivery.** Flip cluster
  `yield-star-next-then-*` / `named-yield-*`: `done`/`value` read wrong in the
  `.then` continuation (assert #2 `done === false/true` fails). Distinct
  receiver: the IteratorResult object crossing the host boundary.
- **S4 — still-vacuous residual (~8%).** Callbacks that genuinely never run
  even post-drain (e.g. `Array.fromAsync` thenable chains, some
  dynamic-import namespace shapes). Diagnose per-family after S2/S3 land.

## S1 measured delta (sampled, for merge_group park-diagnosis)

| Population                            | n sampled | Flip                                               | Extrapolated                                                 |
| ------------------------------------- | --------- | -------------------------------------------------- | ------------------------------------------------------------ |
| 1,680 vacuous-callback records        | 60        | → honest **pass**                                  | **+~420**                                                    |
| 1,680 vacuous-callback records        | 60        | → honest fail (already `fail` today)               | ~1,040 (no pass-count change; now carry real assert indices) |
| 1,680 vacuous-callback records        | 60        | stay vacuous (S4 residual)                         | ~140                                                         |
| 3,503 currently-passing async-flagged | 80        | → honest **fail** (post-await asserts finally run) | **−~875** (CI 525–1,225)                                     |

Net raw pass ≈ **−455** (intentional honesty regression, lead-approved
2026-07-16, precedent #3086). The −875 clusters are the S2/S3 work
definitions:

- **S2 cluster — await-NaN**: `class-elements async-gen … v.value === 42`
  fails (value is NaN); root = `await <host promise>` reads NaN synchronously.
- **S3 cluster — async-gen `.next().then(...)` IteratorResult**:
  `yield-star-next-then-*` / `named-yield-*` fail assert #2 (`done` wrong) —
  the IteratorResult crossing the host boundary delivers wrong `done`/`value`.

ORACLE_VERSION: S1 drafted **v4** assuming it landed first — it did NOT.
#3285 (PR #3104, assert_throws error-type precision) landed its own 3→4 bump
first, so per the whichever-lands-second-re-bumps rule S1 landed as **v5**
(see the merge reconciliation note below). Draft PR #3111 (standalone
host-backed rejection, another drafted 3→4) — or any later oracle change —
must take **v6** with its own history entry.

## Merge reconciliation with #3285 / PR #3104 (2026-07-16, sendev-3161-conflict)

PR #3161 went DIRTY when #3104 merged — both PRs bumped ORACLE_VERSION 3→4
and both touched `tests/test262-runner.ts`. Resolution decisions and WHY:

- **Oracle version**: main's v4 entry (#3285) kept verbatim; S1's entry
  re-labeled **v5** and `ORACLE_VERSION = 5`. Each verdict-logic change needs
  its own bump — re-claiming 4 would make v4 rows ambiguous between two
  different verdict policies, breaking same-version row comparability (the
  entire point of the version stamp).
- **Runner**: git auto-merged cleanly and the composition was verified by
  hand, not assumed. #3104's shim rework (name-string side channel
  `__expected_throw_name`, strict `.name` match — deliberately avoiding the
  2-arg call shape that triggers the #3315 standalone corruption) is
  untouched. #3227's `__result()` export + post-drain re-read is untouched.
  They compose additively: the shims consume `__expected_throw_name`
  synchronously at entry (no clobber risk inside the #3227 drain window), and
  shim failures set the sticky `__fail` that `__result()` re-reads — so an
  `assert.throws` inside a deferred continuation now gets #3104's type
  precision AND #3227's post-drain visibility.
- **Carried-over caveat**: like #3104's shim, the `__result()` export
  compiles INTO the wasm wrapper, so wasm_sha changes for every async-flagged
  test — the #3086 same-wasm auto-rebase does NOT excuse these flips; the v5
  note documents the promote-baseline/force-refresh requirement, mirroring v4.

## Test Results (slice 1)

- Issue-cited sample `async-generator/dstr/ary-ptrn-elem-id-iter-complete.js`:
  vacuous → **pass**. `dynamic-import/namespace/promise-then-ns-set-prototype-of.js`
  and `for-await-of/ticks-…`: vacuous → honest fail with real assert index.
- 60-record vacuous sample: 15 pass / 37 fail / 5 fail-vacuous / 3 skip.
- 80-record currently-passing async sample: 60 pass / 20 fail (all honest
  post-await assertion failures; clusters above).
- wrapTest consumer unit tests: issue-1049/1450/1385/1567/1318-locator — 24/24 pass.

## S2 — `await Promise.resolve(x)` yields NaN (JS-host lane) — FIXED (PR #3165)

**Root cause (verified 2026-07-16, fable-s2, current main).** The
static-resolution census (`awaitIsStaticallyResolved`, #1936) classifies
`await Promise.resolve(<static>)` as a no-suspension await, so the async fn
skips the CPS/$AsyncFrame lanes entirely and the await reaches the legacy
JS-host passthrough in `src/codegen/expressions.ts` (the #2613 arm). That
passthrough compiled the OPERAND — a host call returning the Promise OBJECT
(externref) — while claiming "already the resolved value on the stack"; a
numeric consumer's externref→f64 coercion then read **NaN, synchronously**.
Differential proof (predecessor probes `.tmp/repro-3227{c,d}.mts`): `await p`
(variable), `await ….then(…)`, `await new Promise(…)` all take the real
suspension lane and deliver 7; only the `Promise.resolve(…)`-operand forms
(declaration/expression/arrow, 1 or 2 awaits) read NaN.

**Fix.** New `staticPromiseResolveSettledExpr` (async-cps.ts, next to the
census predicate) maps the recognised `Promise.resolve(...)` operand to the
expression it settles to — the single resolve argument (nested
`Promise.resolve(Promise.resolve(x))` unwraps), or `undefined` for the
zero-arg form — and the passthrough arm in expressions.ts compiles THAT with
the caller's `expectedType` instead of the operand. Non-`Promise.resolve`
operands keep the identity passthrough; standalone/WASI lane untouched (its
`emitStandaloneAwaitUnwrap` branch returns earlier).

### Test Results (S2)

- Probes: C1–C5 all `7` (were NaN except C3); D3 `7`, D5 `34` (were NaN);
  genuinely-suspending D1/D2/D4 unchanged (`0` sync → `7` drained).
- `tests/issue-3227-s2.test.ts`: 6/6 pass (declaration/expression/arrow,
  sequential awaits, zero-arg → undefined, nested resolve, suspension guards).
- Regression sweep: async-await, async-census, issue-2895-async-frame,
  issue-2906-async-multiawait, issue-2967-engine-convergence — all pass.
  issue-2865-standalone (WASI) has 2 failures **pre-existing on main**
  (verified on the main checkout; untouched lane).

## S3 — async-gen `yield*` delegation drained zero values — FIXED (PR #3165)

**Root cause (verified 2026-07-16, fable-s2).** `yield* <async generator>`
inside an `async function*`: `__gen_yield_star` (src/runtime.ts) drains the
inner iterable with a sync `for...of` gated on `Symbol.iterator` — but an
async-generator object carries only `Symbol.asyncIterator`, so ZERO values
were pushed and the outer async generator reported `{value: undefined,
done: true}` on the first `.next()` (probe S3-3). Plain `.next().then`
(S3-1/2) and `yield*` over arrays / `yield* await <array>` — including the
class-elements static-async-gen shape (S3-4/5) — were already correct.

**Fix.** Our async generators are EAGERLY buffered (`_AsyncGeneratorState` →
`{buf, index, pendingThrow}`), so the settled values are synchronously
available: `__gen_yield_star` now drains the remaining inner buffer directly
and rethrows a `pendingThrow` (§27.6.3.8 — inner abrupt completion propagates
out of the `yield*`; probe S3-6 confirms reject delivery). Non-asyncgen
iterables keep the exact prior path. Residual (S4 territory): custom host
async iterables (promise-returning `next`) still can't be drained in the
eager model.

### Test Results (S3)

- Probes `.tmp/repro-3227-s3.mts`: S3-3 `value=5,done=false` (was
  `undefined,true`); S3-6 `[1,false][reject]` (inner throw propagates);
  S3-1/2/4/5 unchanged-correct.
- `tests/issue-3227-s3.test.ts`: asyncgen-inner delegation, chained
  exhaustion, inner-throw propagation, array-inner control.

## Merge reconciliation for S2 / PR #3165 (2026-07-16, sendev-3165-conflict)

PR #3165 went DIRTY when S1 (PR #3161) merged — both slices extend this
tracking doc. Resolution decisions and WHY:

- **Issue body**: S1's landed sections (root cause, slice plan, measured
  delta, #3104 reconciliation, slice-1 results) kept verbatim; S2's section
  appended after them. Frontmatter deduplicated (S2's pre-S1 copy had a
  duplicate `horizon:` and a stale assignee).
- **`regressions-allow` STRIPPED, deliberately.** S1's `count: 1300`
  declaration served exactly one purpose: covering S1's own wasm-change
  honest-tightening flips while the committed baseline was still pre-v5. That
  re-seed HAS happened — promote-baseline at oracle v5, baseline_sha
  `bba9ac76`, 2026-07-16 19:43Z. `changeSetNumericAllowances` (#3303) is
  PR-scoped: it consults only issue files IN THE PR DIFF, and its contract
  says a follow-up PR re-touching a landed granting issue file should strip
  the key — otherwise this PR would silently inherit a 1,300-regression mask.
  S2 is a pure compiler fix diffing v5-vs-v5 against the post-S1 baseline; it
  must be judged unmasked (expected net-positive: it recovers the await-NaN
  fail flips). If S2 somehow needs its own allowance, that is a new, measured
  declaration — not S1's leftover.
- **No oracle bump for S2.** S2 touches only `src/codegen/` (compiler
  output), not the runner/verdict logic — `ORACLE_VERSION` stays 5. Verified:
  the PR diff contains no `tests/test262-runner.ts` / oracle-file change.
- **`src/codegen/async-cps.ts` / `expressions.ts`**: main did NOT modify
  either file since the S2 branch base (verified `git diff <base>
origin/main -- <files>` is empty), so the auto-merge trivially kept the S2
  side — no cross-composition to reconcile in code. S1 (runner-side) and S2
  (compiler-side) compose by construction: S1 makes post-await assertions
  actually score; S2 makes `await Promise.resolve(x)` deliver x, so those
  assertions now pass.

## S4 — S1's re-read never reached the CI lane (fable-s4, 2026-07-17)

**Measurement first (fresh merged baseline, baseline_sha `956e09b9`,
oracle v6, 2026-07-17 03:40Z — post-S1/S2/S3):** 1,861 async-flagged fail
rows; **1,679 files still carry the vacuous verdict** — barely moved from the
original 1,690, and the S1-sampled corpus flips (+420 / −875) "nearly
cancelled" in the post-S1 promote-baseline. The per-path distribution is
byte-identical to the original inventory (383 for-await-of, 234
dynamic-import, …). Yet the issue-cited representatives PASS locally through
`runTest262File`.

**Root cause (verified through the real worker):** S1 (PR #3161) added the
post-drain `__result()` re-read to `tests/test262-runner.ts` only. The
authoritative sharded-CI baseline rows are produced by
`scripts/test262-worker.mjs` (fork worker; used by `tests/test262-shared.ts`
chunk shards), which still scored the premature sync `1`/`-262` — so the v5
verdict policy structurally never applied to a single baseline row. The wasm
side was fine all along (the `__result` export ships in every async wrapper
since v5, and the disk cache keys on the WRAPPED source); only the read side
was missing. Two smaller lanes had the same gap: the in-process fixture path
in `tests/test262-shared.ts` and `scripts/wasm-exec-worker.mjs`
(`tests/test262-vitest.test.ts` arm). The ESM module-goal worker delegates to
`runTest262File` and was already covered.

**Fix (this PR):** port the S1 drain + re-read into all three lanes —
`scripts/test262-worker.mjs` (full parity incl. deferred-continuation-throw
capture; the module-level `unhandledRejection` suppressor was silently
swallowing those throws), `tests/test262-shared.ts` fixture path and
`scripts/wasm-exec-worker.mjs` (minimal drain + re-read; no process-wide
capture in concurrent/thread contexts). Verdict-logic change in the CI lane ⇒
**ORACLE_VERSION 6 → 7** with its own history entry. No wasm change ⇒ the
flips are same-wasm oracle skew; the forward-monotonic bump auto-rebases in
`diff-test262.ts` (wasm-change drift tolerance untouched), and
promote-baseline re-seeds at v7 on merge.

**Measured on the REAL fixed worker (seed 3227, fork-worker protocol):**

| Sample                                 | n   | → pass       | → honest fail | stays vacuous | skip/artifact                                     |
| -------------------------------------- | --- | ------------ | ------------- | ------------- | ------------------------------------------------- |
| A: baseline vacuous rows (1,680)       | 60  | 12           | ~35 (ret ≥ 2) | ~5 (−262)     | 4 Temporal-scope + ~4 probe module-resolution     |
| B: baseline passing async rows (3,505) | 60  | 38 stay pass | 22 (ret ≥ 2)  | —             | 1 of the 22 is a probe module-resolution artifact |

Extrapolated: ≈ +350 vacuous→pass, ≈ −1,200 pass→honest-fail, net ≈ −850 raw
— the S1-approved honesty regression (lead-approved 2026-07-16, precedent
#3086) finally materializing at corpus scale. The B-flips cluster on
async-generator `yield*` abrupt-completion shapes (`yield-star-getiter-*`,
`yield-star-next-then-*`, `yield-spread-arr-*`) — post-drain assertions
exposing real delegation bugs; these are the S5+ feature-fix clusters.

Side effect fixed: since S1, `validate-test262-baseline` (which runs through
the S1-patched `runTest262File`) has been diverging from the v6 baseline on
sampled async rows; once promote-baseline re-seeds at v7 the two agree again.

### Test Results (S4)

- `tests/issue-3227-s4.test.ts`: 4/4 (all three lanes carry the re-read,
  positioned before the −262 scoring; oracle v7 entry present).
- Real-worker samples above; representative
  `for-await-of/async-func-decl-dstr-obj-rest-skip-non-enumerable.js`
  vacuous → pass through both the fixed worker and `runTest262File`.
- `check-verdict-oracle-bump` (#3003): pass (bump 6→7 detected).
- `tests/issue-1862.test.ts` has 2 failures **pre-existing on upstream/main**
  (its searched source-shape strings were removed by earlier PRs; verified
  against `upstream/main` blobs — untouched by this PR).
