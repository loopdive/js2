# #3450 — Implementation Plan: HYBRID two-oracle test262 pipeline

- **Type**: build plan (architect spec). Concrete, dispatchable `## Implementation
  Plan` for the stakeholder-DECIDED hybrid design. Not a feasibility study — the
  build/no-build call is made.
- **Author**: architect, 2026-07-19.
- **Status**: spec complete; decomposed into child issues #3461–#3465.
- **Companion doc**: the A/B measurement + boundary-flip analysis lives in
  `plan/design/3450-native-harness-ab-findings.md` (PR #3395, spike branch
  `spike-3450-native-harness-ab`). This file is the *build plan*; that file is
  the *evidence*. Both fold into the #3450 issue file once #3389 lands. This
  plan is written as a companion (not an in-place extension of the spike doc)
  deliberately: the spike doc is in-flight on #3395, so a same-file edit would
  force a whole-file merge conflict. Cross-reference, don't overwrite.

> **Why HYBRID resolves the spike's NO-BUILD verdict.** The spike recommended
> NO-BUILD *as a verdict-oracle change* because the native-harness numbers would
> become **the published conformance number** — diluting the host lane toward
> measuring V8 and dropping ~839 net passes. The hybrid **never publishes the
> fast number**. The fast native-harness oracle is used **only to gate merges**,
> against **its own self-consistent baseline**; the honest in-wasm v8 oracle
> remains the sole source of the published number and the honest regression
> signal. The spike's core objection ("it dilutes honest signal") is answered by
> construction: the fast lane's ~24 % boundary flips are **baked into the fast
> baseline once** and never leak to the honest lane or the badge.

---

## 0. The two lanes at a glance

| | **Fast lane** (gate) | **Honest lane** (truth) |
|---|---|---|
| Oracle | native-harness (harness runs as native JS; body-only wasm compile) | in-wasm v8 (compile literal assembly, current #3370) |
| Applies to | **host lane only** (standalone can't host-exec the harness — oracle v6 rejects host imports) | host + standalone |
| Runs on | every `pull_request`-relevant `merge_group` (the merge gate) | **daily cron, change-gated** (not per-push) |
| Baseline | `test262-fast-current.jsonl` (host only), oracle lane `fast-nativeharness` | `test262-current.jsonl` (host) + `test262-standalone-current.jsonl`, oracle v8 |
| Purpose | fast merge gate; ~4.5–5× cheaper host compile | published number + honest regression detection |
| Latency of regression detection | at-merge (fast-vs-fast) | ~1 day (accepted tradeoff) |

**Key structural simplification — only the HOST lane bifurcates.** The standalone
lane cannot run the harness natively (it forbids host imports by construction,
oracle v6 / #2961), so standalone stays single-oracle **v8 in both lanes**. That
means:

- The fast lane needs **one** new baseline (host-only): `test262-fast-current.jsonl`.
- The standalone baseline `test262-standalone-current.jsonl` (v8) is **shared** —
  the merge_group standalone shards and the honest cron standalone shards gate/
  promote against the same file. No standalone changes at all.

**Revised trigger model (2026-07-19 stakeholder revision).** The honest lane is a
**daily change-gated cron**, NOT a per-`push:main` job. The published badge moving
at most once/day is acceptable for a slow-moving metric, and it drops the
expensive full-suite honest run from ~per-merge to ~once/day.

---

## 1. Fast-oracle build (host lane) — child issue #3461

**Goal.** Productionize the spike's throwaway native-harness compile path
(`.tmp/spike-3450/native-harness-worker.mjs`) into `scripts/test262-worker.mjs`
behind a mode flag, off by default.

### Root of the mechanism (already proven in the spike)

- `assembleOriginalHarness` (`tests/test262-original-harness.ts:122`) currently
  concatenates `prefix + body` into one `.source` string and the worker compiles
  the whole thing. The fast path needs prefix and body **separated**.
- The `declared_global` bridge (`runtime.ts:~13985`): an undeclared identifier in a
  body-only compile becomes a host import resolved against `globalSandbox[name]`.
  So a **bare** call `assert(...)` resolves to `sandbox.assert` for free.
- **Gap the prototype exposed (finding #3 in the spike doc):** a **member** call
  `assert.sameValue(...)` compiles to `__throw_reference_error("assert")` — a
  member-get on an undeclared global does NOT consult the sandbox. So the body-only
  compile fails every `assert.*`/`verifyProperty` test unless we prepend a
  **binding shim** that binds the harness symbols the body references into body
  scope.

### Changes

**File: `tests/test262-original-harness.ts`**

- Add a new export `assembleNativeHarness(source, meta)` that returns the SAME
  strata as `assembleOriginalHarness` but split:
  ```ts
  interface NativeHarnessVariant {
    harnessPrefix: string;   // runtime shim + includes + assert.js + sta.js [+ doneprintHandle]
    bindingShim: string;     // `var assert = globalThis.assert; var verifyProperty = ...;`
    body: string;            // untouched upstream test body
    bodyLineOffset: number;  // lines in (bindingShim) so body error line-mapping stays exact
    strict: boolean;
  }
  ```
  Reuse `assembleVariant`'s prefix-assembly verbatim (including
  `dedupeTopLevelFunctionDeclarations`) to build `harnessPrefix`; do NOT concat the
  body onto it. The strict variant still exists (see strict-rerun below).
- **Binding shim generation.** Scan `body` for member-accessed harness roots and
  emit `var <name> = globalThis.<name>;` for **only** the harness symbols the body
  references. The candidate set is the harness's exported globals — enumerate them
  from `ORIGINAL_HARNESS_SANDBOX_GLOBALS` ∪ the well-known harness API surface
  (`assert`, `Test262Error`, `verifyProperty`, `verifyEqualTo`,
  `verifyWritable`/`verifyNotWritable`, `verifyEnumerable`/`verifyNotEnumerable`,
  `verifyConfigurable`/`verifyNotConfigurable`, `compareArray`, `arrayContains`,
  `isConstructor`, `testWithTypedArrayConstructors`, `assertRelativeDateMs`,
  `dataPropertyAttributesAreCorrect`, `isSameValue`, `isWritable`, `$DONE`,
  `$ERROR`, `asyncTest`, `byteConversionValues` — `NaN`/`Infinity` are already
  handled by `buildOriginalHarnessSandbox`). Match `\b<name>\b` in the body; bind
  the ones present. **Match on identifier tokens only** — do not bind a name that
  only appears in a string/comment (accept the false-positive cost of a harmless
  extra `var`; a wrongly-omitted binding is the only failure mode, an extra binding
  is inert). `bodyLineOffset` = `lineCount(bindingShim)` so the `sourceMap` body
  line mapping the worker already does stays exact.

**File: `scripts/test262-worker.mjs`**

- Add a mode flag read once at module load:
  `const NATIVE_HARNESS = process.env.TEST262_ORACLE_MODE === 'fast';`
  (default honest — absent env ⇒ current behavior, zero change).
- The worker message (`msg` at `~1196`) gains, when the caller is in fast mode
  and target is host: `nativeHarness: true`, `harnessPrefix`, `bindingShim`
  (per variant). Standalone target NEVER sets `nativeHarness` even in fast mode.
- In `doCompile` (`~890`): when `msg.nativeHarness`, compile **only**
  `bindingShim + body` (NOT the prefix), keeping the existing
  `originalHarness`/`deferTopLevelInit` options. Compile count / GC accounting
  unchanged.
- In the execute path (`~1420–1520`): before instantiation, when
  `msg.nativeHarness`, run `harnessPrefix` **natively** in the per-test sandbox via
  `runInContext(harnessPrefix, createContext(sandbox))` (the sandbox from
  `buildOriginalHarnessSandbox`). This populates `sandbox.assert`,
  `sandbox.Test262Error`, `sandbox.verifyProperty`, etc. Then instantiate the
  body-only module with `globalSandbox: sandbox` exactly as today — the
  `declared_global` bridge + binding shim resolve the harness symbols.
- **Verdict tail is UNCHANGED.** `originalHarnessExceptionMatches` (`~1054`),
  negative-phase matching, `__module_init` run-without-throw, async post-drain
  re-read (v7) — all identical. The only boundary that moved is *where the harness
  code executes*.

### Strict-rerun handling (the 1.7× multiplier stays)

The native harness is **strict-neutral** — running `assert.js`/`sta.js` natively is
identical sloppy or strict, so `harnessPrefix` is executed **once**. But the
**body** still needs both compilations: the primary (sloppy or `onlyStrict`) and,
when `strictRerun` applies, a second `"use strict";\n` + `bindingShim` + `body`
compile. So the fast lane keeps the 1.7× body-compile multiplier; it saves only the
harness bytes from each compile (that's where the 4.5× comes from — the harness is
the bulk of every assembly). Spec: `assembleNativeHarness` returns `primary` +
optional `strictRerun` split variants (mirroring `assembleOriginalHarness`), and
the worker runs the native prefix once but compiles/instantiates each body variant.

### Acceptance criteria (#3461)

1. `TEST262_ORACLE_MODE=fast` + host target compiles body-only, runs the harness
   natively, and reproduces the spike's flip set on the 252-test stratified sample
   (deterministic; the categorizer in `.tmp/spike-3450/analyze.mjs` is the oracle
   for "did we reproduce it").
2. `TEST262_ORACLE_MODE` unset ⇒ **byte-identical** behavior to today (the honest
   path is untouched). Guard with a diff of a 400-test sample host run old-vs-new
   with the flag off — zero row deltas.
3. Standalone target ignores the flag entirely (no `nativeHarness`, no split).
4. Binding shim binds only referenced harness symbols; `bodyLineOffset` keeps body
   error-line mapping exact (verify on a sample with a deliberate body throw — the
   reported line matches the honest lane's).
5. No new host import beyond the existing `globalSandbox` bridge; standalone lane
   unaffected (no dual-mode violation).

---

## 2. Two baselines, two oracle identities — child issue #3462

The fast lane must gate **fast-vs-fast** so the ~18 sampled boundary flips
(≈9,244 corpus-projected) are baked into the fast baseline **once** and never
cause a per-PR false failure. That requires a distinct oracle identity so
`diff-test262` refuses to compare a fast candidate against the honest baseline.

### Oracle identity: add a lane discriminator, don't overload the integer

**Do NOT** reuse `ORACLE_VERSION` integer 9 for the fast lane — a future honest v9
bump would then collide and `diff-test262` would wrongly treat a fast baseline and
an honest v9 candidate as comparable. Instead:

**File: `tests/test262-oracle-version.ts`**

- Keep `ORACLE_VERSION = 8` (honest, untouched).
- Add `export const ORACLE_FAST_REV = 1;` and an `ORACLE_FAST_HISTORY` log entry
  describing the native-harness verdict boundary (error-identity + MOP/marshaling
  flips per the spike findings). Increment `ORACLE_FAST_REV` whenever the
  native-harness verdict boundary changes (binding-shim policy, realm handling,
  etc.), on its own axis independent of the honest integer.

**File: `tests/test262-shared.ts`** (`recordResult`, line ~347)

- Stamp a compound oracle identity. Add a field
  `oracle_lane: "honest" | "fast-nativeharness"` (default `"honest"`, absent on
  existing rows ⇒ treated as honest — backward-compatible), and when
  `oracle_lane === "fast-nativeharness"` also stamp `oracle_fast_rev: ORACLE_FAST_REV`.
  Select the lane from the same `TEST262_ORACLE_MODE` env the worker reads AND the
  target: `fast` mode + host ⇒ `fast-nativeharness`; everything else ⇒ `honest`
  (so standalone rows in a fast-mode merge_group run are still stamped `honest`
  v8 — they ARE honest v8).

**File: `scripts/diff-test262.ts`**

- Extend the cross-version refusal: refuse to diff unless BOTH `oracle_version`
  AND `oracle_lane` (and, when fast, `oracle_fast_rev`) match — unless
  `ORACLE_REBASE=1`. This is the mechanism that keeps a fast candidate from ever
  being diffed against the honest baseline and vice-versa.

### Baseline files in `loopdive/js2wasm-baselines`

| file | lane | oracle identity | refreshed by |
|---|---|---|---|
| `test262-current.jsonl` | honest host | v8 / `honest` | **daily honest cron** promote (§3) |
| `test262-standalone-current.jsonl` | honest standalone | v8 / `honest` | **daily honest cron** promote (§3) |
| `test262-fast-current.jsonl` | **fast host** (NEW) | v8 / `fast-nativeharness` rev N | fast promote on push:main (via #3448 reuse, §4) |

**File: `scripts/fetch-baseline-jsonl.mjs`**

- Add `FAST_BASELINE_REMOTE_URL` (`…/js2wasm-baselines/main/test262-fast-current.jsonl`)
  + `FAST_BASELINE_CACHE_PATH` + `ensureFastBaselineJsonl()`, mirroring the existing
  host/standalone helpers. The regression gate selects the fast baseline when the
  run is fast-mode (§3 wiring).

### Acceptance criteria (#3462)

1. Fast-mode host rows carry `oracle_lane: "fast-nativeharness"` + `oracle_fast_rev`;
   honest + standalone rows carry `oracle_lane: "honest"` (or omit it) + `oracle_version: 8`.
2. `diff-test262` refuses fast-vs-honest (and honest-vs-fast) comparisons without
   `ORACLE_REBASE=1`; accepts fast-vs-fast and honest-vs-honest.
3. `fetch-baseline-jsonl.mjs` exposes a fast-baseline fetch with the same
   graceful-fallback semantics as the existing helpers.
4. Existing honest baselines and their consumers are byte-unaffected (the new
   field is additive and defaults to honest).

---

## 3. CI wiring — child issue #3463

### 3a. Fast lane gates the queue (merge_group), unchanged trigger

**File: `.github/workflows/test262-sharded.yml`**

- The `test262-shard-mg` job (merge_group consolidated matrix, #3431) exports
  `TEST262_ORACLE_MODE=fast` into the **host** shard env. Standalone shards keep
  the honest v8 path (no env). The host shards now compile body-only ⇒ ~4.5×
  cheaper; re-derive the mg host/standalone chunk split accordingly (coordinate
  with L6 / the `gen-test262-mg-matrix.mjs` constants — host is no longer the long
  pole once it's 4.5× cheaper; standalone becomes it).
- `merge-report` (required check **"merge shard reports"**) aggregates as today —
  it is oracle-agnostic (it sums pass/fail). No change to the required-check name.
- `regression-gate` (required check **"check for test262 regressions"**) must
  select the **fast** host baseline when the run stamped `oracle_lane:
  fast-nativeharness` on its host rows, and the **shared** standalone baseline for
  standalone rows. Wire it to call the new `ensureFastBaselineJsonl()` for the host
  diff when `TEST262_ORACLE_MODE=fast` is in the job env. Standalone diff unchanged.
- **Required-check graph stays exactly as today** (`cheap gate`, `merge shard
  reports`, `check for test262 regressions`, `quality`). The fast lane changes only
  WHAT the host shards compute + WHICH host baseline the regression gate diffs — not
  the check topology. This is the load-bearing property: the queue gate is
  unchanged in shape, only cheaper and fast-vs-fast.

### 3b. Honest lane = daily change-gated cron (NEW)

**File: NEW `.github/workflows/test262-honest-daily.yml`** (or a scheduled arm of
the existing workflow — a separate file is cleaner and avoids entangling the
queue-critical workflow's concurrency group).

- `on: schedule: - cron: '0 6 * * *'` (once daily) + `workflow_dispatch` (manual
  force / seed).
- **Change-gate job `honest-change-probe`** (runs first, cheap): compares
  the last-honest baseline's recorded SHA against current `main` HEAD and skips the
  expensive matrix when nothing relevant changed. Precise gate:
  - Read the last honest SHA from a marker committed alongside the honest baseline
    (add `last_honest_sha` + `bundle_hash` to the promote step's metadata; store in
    `js2wasm-baselines` next to `test262-current.jsonl`, e.g.
    `test262-current.meta.json`).
  - Compute the set of changed paths `git diff --name-only <last_honest_sha>..HEAD`
    and gate on any match of: `src/**`, `tests/test262-*.{ts,mjs}`,
    `scripts/test262-*.mjs`, `scripts/test262-fyi-runtime.js`, `test262/harness/**`,
    the compiler bundle hash (`TEST262_BUNDLE_HASH` / `hashFiles('src/**')`), and the
    submodule pin (`test262` gitlink). **No match ⇒ honest numbers cannot have moved
    ⇒ skip** (emit `run=false`; publish nothing; leave the badge as-is).
  - Fail-safe: missing/unreadable marker, or a `workflow_dispatch` ⇒ `run=true`
    (always run).
- **`honest-shard` matrix**: the full 57×2 honest matrix (host = honest v8
  full-assembly, NO `TEST262_ORACLE_MODE` env; standalone = v8) — this is the
  current `test262-shard` job body, moved/reused. This is the expensive run, now
  ~once/day instead of ~per-merge.
- **`honest-merge-report` + `honest-regression-gate`**: aggregate + diff the honest
  host rows against `test262-current.jsonl` and standalone against
  `test262-standalone-current.jsonl` (both honest v8). This is the honest regression
  detector (§5).
- **`honest-promote-baseline`**: on a clean daily run, promote the honest host +
  standalone baselines to `js2wasm-baselines` AND publish the landing-page number
  (`benchmarks/results/test262-current.json` + standalone summary). Update the
  `test262-current.meta.json` `last_honest_sha`/`bundle_hash` marker. This is the
  ONLY writer of the published number (§6).

### Acceptance criteria (#3463)

1. merge_group host shards run fast oracle; standalone honest; both required checks
   green on a self-consistent (seeded) fast baseline with no false failures.
2. The daily honest workflow runs the full honest matrix, promotes both honest
   baselines, and publishes the number — but SKIPS when the change-gate finds no
   relevant diff since `last_honest_sha`.
3. Required-check topology on PRs/merge_group is unchanged (same four contexts).
4. The daily workflow's concurrency group is independent of the queue-critical
   `test262-sharded` group (a daily run never cancels or contends a merge_group).

---

## 4. The #3448 rework — folded into child issue #3463

**#3448 today**: on `push:main`, `mg-artifact-probe` finds the merge_group's own
`test262-group-<sha>` merged JSONL and promotes the baseline from it, skipping the
114-job rerun.

**Under the hybrid, the merge_group JSONL host rows are FAST-oracle** — they are NOT
honest, so they cannot seed the honest baseline. Resolution:

- **#3448 SURVIVES, re-scoped to the FAST lane.** The merge_group's host JSONL is
  exactly the fast-oracle output. Keep `mg-artifact-probe` + the reuse path on
  `push:main`, but have it promote the **fast host baseline** (`test262-fast-current.jsonl`,
  `oracle_lane: fast-nativeharness`) — NOT the honest baseline. This is legitimate:
  the fast baseline SHOULD be the merge_group's own fast output, keyed by the exact
  SHA that lands on main. The standalone half of the merge_group JSONL is honest v8
  and MAY also seed `test262-standalone-current.jsonl` on push (it's the same oracle).
- **The honest HOST baseline does NOT come from push:main at all** anymore — it comes
  only from the **daily honest cron** (§3b). So #3448's reuse is simply repurposed:
  it feeds the *fast* host baseline (cheap, correct) on every merge, while the
  *honest* host baseline refreshes ~daily.
- **What of #3448 is kept vs changed:**
  - KEPT: the `mg-artifact-probe` job, the artifact-download-by-SHA path, the
    `SHARD_SKIP_OK` green-skip semantics, the 3-day-retention assumption.
  - CHANGED: the promote step writes the **fast** host baseline (not honest host);
    it stamps/validates `oracle_lane: fast-nativeharness`. The honest-host promote is
    removed from `push:main` (it now lives in the daily cron).
  - Standalone promote on push:main from the reused artifact is OPTIONAL (it's honest
    v8 either way); simplest is to let the daily cron own BOTH honest baselines and
    have push:main own ONLY the fast host baseline. Pick that: **push:main promotes
    the fast host baseline only; the daily cron promotes both honest baselines.** One
    writer per file, no races.

### Acceptance criteria (#3448-rework, in #3463)

1. `push:main` promotes `test262-fast-current.jsonl` from the merge_group's fast
   host JSONL (reuse path preserved), stamped `fast-nativeharness`.
2. `push:main` no longer promotes any honest baseline or the published number.
3. The daily cron is the sole writer of `test262-current.jsonl`,
   `test262-standalone-current.jsonl`, and the landing-page summary JSONs.
4. Each baseline file has exactly one writer (no promote races).

---

## 5. Honest-lane regression / revert path — child issue #3464

Because the fast gate can pass a PR that regresses under the honest oracle, and
`main` is **append-only**, the honest regression is caught **post-merge, at daily
latency**, and repaired with a **revert PR** (never a force-push).

### Mechanism

- The daily `honest-regression-gate` (§3b) diffs the fresh honest host + standalone
  reports against the honest baselines, reusing the existing regression machinery:
  the #1668 catastrophic-regression guard, the #1897 standalone net-regression
  floor, and **#3457 flap-tolerance** (so a handful of flaky flips don't trip a
  false revert). If the honest diff shows a real net regression above tolerance:
  - Do NOT promote the honest baseline (it would bake in the regression).
  - Surface it via the **auto-park machinery** repurposed for post-merge: the daily
    workflow opens (or the bot flags) a **revert PR** for the offending commit range
    `<last_honest_sha>..HEAD`, labeled `honest-regression`, with the regressed-row
    delta (the JSONL diff) in the body — mirroring the `auto-park-bot:merge-group-failure`
    comment format so the shepherd's existing playbook applies.
  - **Bisection note**: a daily run may cover multiple merged commits. The revert
    candidate is the commit range since `last_honest_sha`. If more than one src PR
    landed, the workflow attaches the range + the per-bucket delta and escalates to
    the tech lead to pick the offending commit (a follow-up could add
    `git bisect`-style per-commit honest re-runs, but that's out of scope for the
    first cut — daily granularity + human bisect is the accepted first version).
- Until the revert lands, the honest baseline stays at the last-good SHA (not
  advanced past the regression), so the next daily run keeps flagging until repaired.

### Acceptance criteria (#3464)

1. A synthetic honest-only regression (passes fast gate, fails honest) is detected
   by the next daily honest run and NOT promoted into the honest baseline.
2. The detection opens/flags a `honest-regression`-labeled revert PR with the
   regressed-row delta and the `<last_honest_sha>..HEAD` range.
3. #3457 flap-tolerance is applied so sub-threshold flakiness does not trigger a
   false revert.
4. The honest baseline is never advanced past an un-reverted regression.

---

## 6. Landing page — cross-cut, verified in #3463

- The published conformance number + the host/standalone site lanes read **only**
  honest-lane data: `benchmarks/results/test262-current.json` (host) and the
  standalone summary, both written **only** by the daily honest promote (§3b/§4).
- The fast baseline (`test262-fast-current.jsonl`) is NEVER read by any site/badge
  path. Add a guard in the site data-build (`scripts/build-test262-report.mjs` /
  the pages build) that asserts the summary it publishes carries `oracle_lane:
  honest` (or no lane) and rejects any `fast-nativeharness` input — so a fast number
  can never leak to the badge even by a mis-wired artifact.
- **Cross-reference #3458** (cumulative-number fix): ensure the daily honest promote
  feeds the same cumulative aggregation #3458 corrects, and that both site lanes
  (host + standalone) draw from the honest daily output. Confirm the #3458 fix and
  the daily-promote source are the same JSON.

### Acceptance (in #3463)

1. Badge + both site lanes render honest daily numbers; a `fast-nativeharness`
   JSONL fed to the site build is rejected, not published.
2. #3458's cumulative fix operates on the honest daily output.

---

## 7. Migration / seed sequence — child issue #3465

The fast lane needs an **initial native-harness host baseline** before the
merge_group gate can diff against it. This is an `ORACLE_REBASE`-equivalent for the
**fast lane only**; honest v8 is untouched throughout. Sequence so nothing breaks
mid-rollout:

1. **Land #3461** (fast oracle behind `TEST262_ORACLE_MODE`, default OFF). No CI
   behavior change — merge_group still runs honest v8.
2. **Land #3462** (oracle-lane plumbing + fast baseline fetch + `diff-test262` lane
   guard). Still no CI behavior change (fast mode not yet wired into CI).
3. **Seed the fast baseline** (`workflow_dispatch` on the daily honest workflow's
   manual arm, OR a dedicated one-shot dispatch): run the **full corpus in fast
   mode** (`TEST262_ORACLE_MODE=fast`, host lane) → produce `test262-fast-current.jsonl`
   stamped `fast-nativeharness` rev 1 → commit to `js2wasm-baselines`. This bakes in
   the ~18/9,244 boundary flips **once**. Honest baseline untouched.
4. **Land #3463** (CI wiring): flip merge_group host to fast mode + gate against the
   now-seeded fast baseline; add the daily honest cron; re-scope #3448 to the fast
   baseline. Because step 3 seeded the fast baseline, the first merge_group fast run
   diffs fast-vs-fast with ~zero delta → no false failures.
5. **Land #3464** (honest daily regression/revert path).
6. First daily honest cron run establishes/confirms the honest baseline + published
   number (unchanged from today's v8 — it IS today's oracle).

**Ordering invariant**: fast mode is never active in CI (step 4) before its baseline
exists (step 3); the honest lane is never modified (only relocated to cron in step
4, reading the same v8 baseline that exists today). At every step, both required
checks remain green against a self-consistent baseline.

### Acceptance criteria (#3465)

1. A one-shot fast-mode full-corpus run produces `test262-fast-current.jsonl`
   committed to `js2wasm-baselines`, stamped `fast-nativeharness` rev 1.
2. The seed runs BEFORE #3463's merge_group flip (documented ordering; CI wiring PR
   depends on the seed being present).
3. Post-seed, the first merge_group fast run shows ~zero regression delta (fast-vs-
   fast self-consistency), no false failures.
4. Honest v8 baseline + published number unchanged across the entire rollout.

---

## 8. Child-issue summary

| id | title | horizon | depends on |
|---|---|---|---|
| **#3461** | Productionize native-harness fast oracle (worker mode flag + harness split + binding shim) | L | — |
| **#3462** | Two-baseline + fast-oracle-lane plumbing (oracle_lane stamp, diff-test262 guard, fast baseline fetch) | M | — |
| **#3463** | CI two-oracle wiring: fast merge_group gate + daily honest cron + #3448 fast-lane rework + landing-page honest-only guard | L | #3461, #3462, #3465 |
| **#3464** | Honest-lane (daily) regression detection + revert-PR path (reuse #3457 tolerance + auto-park) | M | #3463 |
| **#3465** | Fast-baseline seed / migration (one-shot fast-mode full-corpus rebase for the fast lane) | S | #3461, #3462 |

## 9. Single biggest implementation risk

**Fast-baseline drift vs. honest reality causing silent gate erosion.** The fast
lane gates against a baseline that measures native-harness verdicts — which, per the
spike, are **partly V8-delegated** (`Array.prototype.slice.length` etc. read from
the host, not js2wasm) and carry the error-identity/MOP boundary artifacts. The
danger is NOT a wrong published number (that's fenced off by §6), but **gate
erosion**: a genuine compiler regression whose failure mode happens to fall in a
native-harness blind spot (e.g. an error-identity case the fast oracle already
tolerates, or a builtin the native harness reads from V8) passes the fast gate
silently and is only caught ~1 day later by the honest cron — then requires a
revert of already-merged, possibly-built-upon commits. The mitigations are all in
the plan (honest daily gate + #3457 tolerance + revert path), but the **latency and
blast radius of a honest-only regression are the real cost of optimistic gating**,
and the fast baseline's `ORACLE_FAST_REV` must be re-seeded promptly whenever the
native-harness boundary shifts, or the fast gate drifts further from honest reality.
Recommend the daily honest run also emit a **fast-vs-honest divergence metric**
(count of rows where the two lanes disagree) as an early-warning signal that the
optimistic gate is eroding faster than expected — cheap to compute (both JSONLs
exist daily), and the canary for when to invest in the spike's realm-aware
error-construction fix.
