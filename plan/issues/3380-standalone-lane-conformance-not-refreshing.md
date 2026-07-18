---
id: 3380
title: "Standalone-lane test262 dashboard number appears frozen — promote-pipeline fragility + single-scalar visibility gap masks real churn (not a cache/skip bug)"
status: ready
sprint: current
created: 2026-07-17
priority: high
horizon: m
feasibility: medium
area: ci, dashboard
goal: standalone-mode
related: [1781, 2097, 1897, 1668, 3344]
origin: "Investigation requested after standalone-lane pass count sat at exactly 24,711/43,106 across 6+ js2wasm-baselines commits from 03:18Z-12:18Z on 2026-07-17 while the host lane moved 32,553 -> 32,671 -> 32,788 -> 32,138 in the same window."
---

# #3380 — standalone-lane dashboard number appears frozen

## Summary

The `test262-standalone-current.json` pass count sat at exactly
**24,711/43,106** across 6 consecutive `loopdive/js2wasm-baselines` commits
spanning 03:18Z-12:18Z on 2026-07-17, while the host-lane number moved
32,553 -> 32,671 -> 32,788 -> 32,138 in the same window. This made
standalone-mode progress (goal: standalone-mode, umbrella #1781) invisible
on the dashboard and looked like a caching/skip/copy-forward bug.

**It is not.** Direct inspection of CI run logs and the raw baseline JSONL
content across the freeze window shows the promote pipeline genuinely
re-executes and re-scores every standalone row on every successful run.
The frozen scalar is a **coincidence of timing + an exact regression/fix
cancellation**, surfaced by two real, separate problems worth fixing:

1. **Promote-pipeline fragility** — a single flaky shard (1 of 114 matrix
   jobs) fails the whole `merge shard reports` job, which **entirely skips**
   `promote-baseline` (no partial credit, both lanes together). Combined
   with a fragile/slow SSH push to the baselines repo (documented 40min-2.5h
   stalls, #3344), this creates multi-hour gaps between real baseline
   refreshes, so a lane's true state lags its actual code by hours.
2. **Single-scalar dashboard visibility gap** — the dashboard shows only
   `pass/total`. When a fix and a regression land in the same window and
   exactly cancel (see below, a real find from this investigation), the
   scalar shows *zero visible signal* even though real code churned in both
   directions.

## Investigation (ruling out the cache/skip/copy-forward hypotheses)

### 1. Disk cache — not the cause, and not even reachable in CI

`tests/test262-shared.ts` computes cache paths via `getCachePaths()`
(md5 of wrapped source + compiler hash + `TEST262_TARGET`), which correctly
differentiates host (`"gc"`) vs `standalone` — **but this function is dead
code**. The actual call site (`tests/test262-shared.ts:900-903`) hardcodes
`wasmPath = ""` / `metaPath = ""` unconditionally:

```
// Cache disabled — stale cache entries caused false baselines.
const wasmPath = "";
const metaPath = "";
```

The CI workflow's own comment confirms this (`.github/workflows/test262-sharded.yml:485-493`):
"there is deliberately NO actions/cache step for `.test262-cache` here...
the on-disk wasm/meta result cache is DISABLED in the runner." So a
cache-mis-key theory (target-agnostic key clobbering standalone with host
results, or vice versa) cannot be the cause in CI — the cache path is
compiled out entirely.

### 2. Shards are NOT conditionally skipped

The 57x2 chunk/target matrix (`.github/workflows/test262-sharded.yml:~368-440`)
runs both `js-host` and `standalone` targets in the **same** `test262-shard`
job for every `push`/`merge_group` (subject only to the `changes` job's
doc-only skip, which applies identically to both lanes — never
standalone-only). Confirmed via `gh api .../check-runs`: individual
`test262 standalone shard N` jobs run and complete on every push, e.g. run
29604243812 shows 40+ standalone shard jobs each with fresh
`completed_at` timestamps.

### 3. The coordinator's specific hypothesis (S1/#3161 + S4/#3227 verdict-field
mismatch) is **falsified** by direct code inspection

Checked whether the async post-drain verdict re-read (S1 `PR #3161`,
ported to the CI worker in S4 `6fd5d760da`, "#3227 S4") writes the verdict
to a field the standalone report-builder doesn't read:

- `scripts/test262-worker.mjs:1417-1509` — the `__result()` post-drain
  re-read block has **no `target` conditional**. It applies identically to
  host and standalone (gated only on `typeof instance.exports.__result ===
  "function"` and `ret === 1 || ret === -262`), and writes the same
  `status`/`vacuous`/`ret` fields for both.
- `scripts/build-test262-report.mjs:965-989` — reads `record.status`
  generically; no target-conditional field name anywhere in the tally path.
- The actual observed status flips in the freeze window (below) are
  synchronous destructuring-pattern tests, unrelated to async/microtask
  timing — inconsistent with an async-verdict-read bug being the cause.

**Conclusion: S1/S4 did not introduce a standalone-specific scoring bug.**
The CI-worker parity fix (S4) is orthogonal to this freeze.

### 4. Concrete confirmation: fresh execution, not a stale replay

Downloaded the raw `test262-standalone-current.jsonl` from 3
`js2wasm-baselines` commits across the freeze window (03:18Z / `ec2c097d`,
08:29Z / `536bbb5e`, 12:18Z / `236a3777`) and diffed by `file` -> `status`:

| Comparison | Total rows | Status flips |
|---|---|---|
| 03:18Z vs 08:29Z | 48,088 | 9 |
| 08:29Z vs 12:18Z | 48,088 | **0** |
| 03:18Z vs 12:18Z | 48,088 | 9 |

Per-row `timestamp`/`oracle_version`/`compile_ms` fields differ between
snapshots even where `status` is unchanged (e.g. `Array/prototype/join/length.js`
went from `oracle_version:6` at 04:29 to `oracle_version:7` at 13:28 with a
different `compile_ms`, `status: pass` both times) — this **proves the
standalone shards re-execute and re-score every row on every run**; nothing
is being copied forward or replayed from a cache.

The 9 flips between 03:18Z and 08:29Z are:

```
test/language/expressions/{function,arrow-function,async-generator}/dstr/dflt-obj-ptrn-rest-val-obj.js   fail -> pass   (3 files)
test/language/expressions/{function,arrow-function,async-generator}/dstr/dflt-obj-ptrn-rest-getter.js    pass -> fail   (3 files)
test/language/expressions/async-generator/dstr/named-dflt-obj-ptrn-rest-getter.js                        pass -> fail   (1 file)
test/language/expressions/async-generator/dstr/named-dflt-obj-ptrn-rest-val-obj.js                       fail -> pass   (1 file)
test/built-ins/GeneratorPrototype/next/result-prototype.js                                               compile_timeout -> fail (1 file, likely CI-load flake, no net pass/fail change either way)
```

This is a **real, connected fix+regression pair**: whatever landed in that
window correctly fixed default-value-with-rest destructuring (`rest.a ===
undefined`, i.e. excluded-property construction — `dflt-obj-ptrn-rest-val-obj.js`,
+4 pass) but simultaneously broke the sibling getter-invocation-count
assertion in the same file family (`dflt-obj-ptrn-rest-getter.js`,
`assert.sameValue(count, 1)` now fails, -4 fail). Net effect on the
top-line scalar: **exactly zero**, which is why the dashboard number looked
frozen even though real code changed. **This regression is not yet
tracked** — recommend filing it separately (see Fix direction below).

Between 08:29Z and 12:18Z (the 4-hour window with the biggest host swing,
-650 host tests) there is **zero** standalone row churn — see "Timing
explanation" below for why that's not itself a bug.

### 5. Timing explanation for zero movement on the cited standalone fixes

The task cited #3150 (Uint8Array toHex/toBase64), #3363 (Array.flat),
#3342 (standalone join), #3364 (widening) as having "landed in code" during
the observation window. Checked each against the actual merge timestamps
and the 12:18Z snapshot content:

- **#3363 (Array.flat native depth-1)** — its issue file
  (`plan/issues/3363-standalone-array-flat-native-depth1.md`) frontmatter
  says `status: in-progress` despite `completed: 2026-07-17`. The actual
  merge (`PR #3264`, commit `93e86d7178`) landed at **17:09:48Z** — nearly
  5 hours *after* the last examined baseline snapshot (12:18Z) and *after*
  the most recent push-promote attempt (18:33Z, which itself **failed** —
  see below). Confirmed directly: the 12:18Z standalone jsonl still shows
  the pre-fix refusal for every `Array/prototype/flat/*` test —
  `"error":"L47:3 Codegen error: Array.prototype.flat() is not yet
  supported in --target standalone/wasi (#2717)..."`. The fix genuinely had
  not reached any promoted baseline yet when the "freeze" was reported.
- **#3150 (Uint8Array base64/hex)** — split across 3 separate PRs merging
  at 11:36Z, 13:15Z, and 16:21Z. Only the first slice (11:36Z) predates the
  12:18Z snapshot, and by a margin (~40min) comparable to the pipeline's own
  observed shard+merge+promote latency, so it may not have been reflected
  even in the 12:18Z run. `scope_official: true` for these tests (not
  proposal-excluded, contrary to an earlier guess) — `toBase64`/
  `setFromBase64` do show mixed fail/pass, `fromBase64` still hits an
  unrelated `__get_builtin` dynamic-shape refusal (#1472 Phase B), so this
  slice's tests were not expected to flip to `pass` yet regardless.
- **#3342 (standalone join misclassify)** — targets
  `Object.values(o).join`/`Object.getOwnPropertyNames(o).join`, not
  `Array.prototype.join` (checked the wrong suite initially — flag this for
  whoever picks up a follow-up: re-verify #3342's specific test262 rows,
  not covered by this investigation).
- **#3364 (widened-object shape collision)** — general `goal: correctness`
  fix, not standalone-specific; plausibly the actual source of the
  destructuring-rest-getter regression identified in #4 above (same
  landing window), but not confirmed by bisection here.

### 6. Latest push-promote attempt (18:33Z) failed — separate pipeline
   fragility, worth its own fix

`gh run view` for the push at 18:33Z (commit `2356d658`, after #3363's
17:09Z merge) shows job **`test262 standalone shard 40` failed**, which
cascades: `test262-shard` job result != `success` -> `merge shard reports`
job's "Fail if required test262 shards did not succeed" step fails ->
`promote-baseline` job is **entirely skipped** (`needs: merge-report`, no
`always()`, so a single-shard flake blocks the *whole* refresh — the
already-fresh, unaffected 113 other shards' results are thrown away). This
means the #3363 flat() fix's actual effect on the standalone baseline is
still **not promoted** as of this investigation, purely due to one flaky
shard job. Separately, the "Push baseline artifacts" step logs show a
~40-minute stall on `git clone --depth=1` of the baselines repo on at least
one recent successful run (`02:34:27Z` clone start -> `03:14:47Z` first
file-checkout progress), consistent with the multi-hour SSH-push fragility
already tracked informally in `a961761087 fix(#3344)`.

## Fix direction

Not a scoring/cache bug — no change needed to `test262-worker.mjs` or
`build-test262-report.mjs` verdict logic. Recommended follow-ups, roughly
in priority order:

1. **Make shard failures partially-tolerant in `merge shard reports`.**
   Today one failed shard (1/114) discards all 113 successful ones and
   skips the entire baseline promotion (both lanes). Consider: (a) retry a
   failed shard once before failing the job (cheap, likely absorbs most
   flakes — the runner already has a `#1589` serial-retry pattern for
   individual *tests*, worth extending to the shard-job level), or (b) let
   `merge-report`/`promote-baseline` proceed with a per-shard success
   threshold (e.g. 56/57 chunks present per target) and flag the missing
   chunk's tests as unknown rather than voiding the whole run. Either
   closes the multi-hour promotion gaps that make the dashboard look
   stalled.
2. **Investigate the baselines-repo SSH clone/push latency** (~40min-2.5h
   stalls per #3344) — a `git clone --depth=1` of a JSONL-heavy repo should
   not take 40 minutes; likely worth a shallower/partial-clone strategy or
   moving off git-over-SSH for this hot path.
3. **Surface more than the top-line scalar on the dashboard for the
   standalone lane** — e.g. a delta callout ("+7 / -7 this run") or
   category-level breakdown (the report already computes
   `error_categories`/root-cause buckets — just not surfaced prominently),
   so a net-zero cancellation reads as "N flipped each way" instead of "no
   change." This is the actual fix for the reported symptom (the number
   "looks frozen").
4. **File the destructuring-rest-getter regression separately** — 3 tests
   (`dflt-obj-ptrn-rest-getter.js` under function/arrow-function/
   async-generator) regressed pass->fail between 02:45Z and 03:18Z on
   2026-07-17, most likely a side effect of whichever fix landed
   `dflt-obj-ptrn-rest-val-obj.js` (fail->pass) in the same window —
   possibly #3364. Needs bisection against the actual PR to confirm and
   fix the getter-invocation-count regression without reverting the
   rest-value correctness fix.
5. **Re-verify #3342's actual test262 coverage** — this investigation
   checked `Array.prototype.join` (wrong suite; #3342 targets
   `Object.values/getOwnPropertyNames().join`) and did not confirm its
   effect either way.

## Evidence artifacts (for whoever picks this up)

- Downloaded standalone JSONL snapshots compared: baselines-repo commits
  `ec2c097dd8af2540d58cffb9766744a5c224c920` (03:18Z),
  `536bbb5e424e130f43aaa596a15cccc382ab8446` (08:29Z),
  `236a3777d988abe81fc458e5b62dfc333567a189` (12:18Z).
- Failing shard confirmed via `gh api repos/loopdive/js2wasm/commits/<sha>/check-runs`
  (NOT `gh run view --json jobs`, which truncates to ~30 jobs and hides the
  standalone-shard failure among the merge-queue bot's park/enqueue/check-floor
  runs — see memory `reference_park_diagnosis_check_runs_on_sha_not_run_jobs`).
- Push run 29604243812 (commit `2356d6582af2a5aa13b3b6eb6affe9b717d06569`,
  18:33Z): `test262 standalone shard 40` job `87963547733` failed;
  `merge shard reports` job `87965207105` failed as a result;
  `promote merged report to main baseline` job `87965742470` shows
  `conclusion: "skipped"`.
