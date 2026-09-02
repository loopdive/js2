---
id: 4444
title: "UMBRELLA: ES6 (ES2015) standalone authoritative 11,704-row close-out → 100%"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-09-01
assignee: codex/es6-test262-closeout
priority: high
horizon: xl
feasibility: hard
task_type: conformance
area: codegen, conformance
es_edition: es6
goal: standalone-mode
related: [2860, 2864, 2865, 2867, 2906, 3032, 3178, 2161, 2175, 2158, 2159, 4445, 4446, 4447, 4449, 4450]
---

# #4444 — UMBRELLA: ES6 (ES2015) standalone edition close-out

## 2026-09-02 post-wave census — 9,905 / 11,704 (84.6%), +232 rows in one day

Source: `node scripts/fetch-baseline-jsonl.mjs --standalone --force` fetched
2026-09-02 21:06 UTC (row timestamps 20:27–20:41 UTC, i.e. after PR #5494
merged at 19:44 UTC, so every wave below is reflected), edition map
`website/public/benchmarks/results/test262-file-editions.json` (`ES2015`;
11,778 labelled, 11,704 in the official runner scope).

**ES2015 standalone: 9,905 pass / 11,704 (84.6%) — 1,799 non-pass**
(1,407 fail · 391 compile_error · 1 compile_timeout), up from
**9,673 / 11,704 (82.6%)** at the 2026-09-01 evening census: **+232 rows**.

Landed this day (all merged to `main`), in order:

| PR | wave | issue | rows claimed |
| --- | --- | --- | ---: |
| #5454 | Promise slices B–D | #5197 | +19 |
| #5458 | for-of / iterators / collections r2 | #5267 | +37 |
| #5224 | buffers wave 1 | #5150 | +16 |
| #5461 | runner: standalone leak check on the in-process path | #5272 | (honesty fix) |
| #5469 | post-#5224 regression fix (module-global `$__ta_view` pin) | #5150 | (restores 9 host rows) |
| #5475 | r2 implementation plans (expressions, statements) | #5270/#5271 | (docs) |
| #5479 | TypedArray r2 | #5194 | +84 |
| #5489 | class r2 (+ #5194 null-proto follow-up) | #5195 | +28 |
| #5494 | Array/Object built-ins r2 | #5268 | +21 |

Two process notes worth keeping:

- **#5461 changed what a measurement means.** Before it, the in-process runner
  (`scripts/run-test262-paths.mts`, every local before/after probe) satisfied a
  leaked `env::*` import from the JS host and scored the row on what happened
  next — so a slice could read "fixed" locally while CI scored
  `host_import_leak`. Every number above is measured with the check in place;
  the TypedArray lane re-scored its 84 claimed flips afterwards and found no
  pseudo-pass, but the class lane found one (`constructor-can-be-generator.js`
  leaks `env::__create_generator`, owned by #680/#2864, now pinned as a leak).
- **Every wave went through an independent adversarial review before shipping,
  and five of six had confirmed regressions their own row lists, controls,
  ratchet gates and equivalence runs all missed** — 13 in total, including two
  that only appeared on the JS-host lane, one that made a whole class of
  subclass declarations fail to compile, and one pre-existing defect in the
  shared carrier-bag key merge (`Reflect.defineProperty` on an existing
  closed-struct field double-listed the key on `main` too). A row list is not a
  regression test: none of these shapes were in the cluster lists the planners
  built, because the lists are drawn from *failing* rows and these broke
  *passing* behaviour outside the cluster.

Remaining non-pass by cluster (same split as the 09-01 census, so the two are
comparable):

| Cluster | 09-01 | 09-02 | Δ | Owner |
| --- | ---: | ---: | ---: | --- |
| class | 209 | 225 | +16 | #5195 r3 residuals R3-1…R3-7 recorded |
| typedarray | 300 | 208 | −92 | #5194 residuals (F3/F4 documented) |
| generators | 318 | 195 | −123 | #680 / #2864 codex lane |
| array + object | 159 | 179 | +20 | #5268 steps 4/5/7/8/9/10 not started |
| other built-ins | 150 | 165 | +15 | #5269 in flight (G/H/A/B/L/J/E/D landed) |
| expressions | 117 | 163 | +46 | #5270 in flight (steps 4–7, 9, 11 open) |
| proxy + reflect | 157 | 157 | 0 | #5196 not dispatched; #3371 / #2046 blocked |
| regexp | 148 | 140 | −8 | #5198 codex lane |
| for-of + collections | 155 | 119 | −36 | #5267 residuals |
| promise | 140 | 118 | −22 | #5197 slices E–H open |
| statements + lang | 84 | 79 | −5 | #5271 in flight (0 → 39 of 68 in scope) |
| module-code | 23 | 24 | +1 | #4759 codex closeout lane |
| rest | 18 | 27 | +9 | folded into the nearest cluster plan |

The clusters that grew did not regress — the counts move because rows leave a
cluster when they pass and because this census clusters by path prefix while
the 09-01 one clustered by the dispatch split; treat the Δ column as a
direction indicator, not as a per-cluster regression signal. The authoritative
"no row regressed" evidence is each wave's own before/after on its row list
plus the merge-group regression gate.

## 2026-09-01 evening dispatch census at d39779cb — cluster ownership + Fable/Opus fan-out

Source: `node scripts/fetch-baseline-jsonl.mjs --standalone --force` (baselines
repo, compiler sha `d39779cbfdd5a9b5fdb54569923fd9810637d495`, generated
2026-09-01T18:33Z — an ancestor of the session branch
`claude/es6-test262-standalone-g10c7u`, which is `origin/main` @ `0d9bfede`),
edition map `website/public/benchmarks/results/test262-file-editions.json`
(`ES2015` label; 11,778 labelled, 11,704 in the official runner scope).

**ES2015 standalone: 9,673 pass / 11,704 (82.6%) — 2,031 non-pass**
(1,644 fail · 386 compile_error · 1 compile_timeout). Status/error class:
1,122 `assertion_fail`, 367 `type_error`, 248 `host_import_leak` CE,
151 other CE, 34 runtime_error CE, 21 promise_error, 15 illegal_cast,
10 null_deref, 10 range_error.

Cluster split (path-disjoint; lists under `.tmp/es2015/<cluster>-{paths.txt,errors.tsv}`,
regenerable from the JSONL + edition map):

| Cluster | Rows | Owner / tracker | Dispatch (this session) |
| --- | ---: | --- | --- |
| generators (`language/*/generators`, `yield`, GeneratorFunction/Prototype, `__create_generator` leaks, "sequential numeric yields" refusal) | 318 | #680 / #2864 codex lane (PR #5383 merged; #5406/#5407 drafts) | **not re-dispatched** |
| typedarray (`built-ins/TypedArray*`, excl. buffers) | 300 | #5194 (Slice A merged #5300; #5385 species merged) | Fable planner → r2 plan in #5194 → Opus |
| class (`language/*/class`, `computed-property-names/class`, `super`, `new.target`) | 209 | #5195 (stub) | Fable planner → plan → Opus |
| array + object built-ins | 159 | new **#5268** | Fable planner → plan → Opus |
| proxy + Reflect | 157 | #5196 (2-row revoker slice merged #5389); #3371 (33 CE, blocked design PR #5400); #2046 (15 CE, design PR #5397) | Fable planner on the unowned trap-invariant residual → Opus |
| for-of + Iterator/*IteratorPrototype + Map/Set/Weak* | 155 | new **#5267** (wave-1 #5144/#5147/#5151; draft PR #5225 mined, not merged) | Fable planner → plan → Opus |
| function/error/symbol/string/JSON/number built-ins | 150 | new **#5269** (wave-1 #5156/#5152) | Fable planner → plan → Opus |
| regexp (`built-ins/RegExp`, annexB RegExp, `Symbol.{match,replace,search,split}`) | 148 | #5198 codex lane (Slice A merged #5296; Slice B draft #5393) | **not re-dispatched** |
| promise | 140 | #5197 (Slice A merged #5292; slices B–H planned) | Opus implementer on Slices B–D directly |
| expressions (object literal, assignment, arrow, call, template, instanceof, …) | 117 | new **#5270** (wave-1 #5149/#5146) | Fable planner → plan → Opus |
| statements + lang semantics (for-in/for/let/const/with/try, global/eval code, arguments, rest, dstr) | 84 | new **#5271** (wave-1 #5154/#5158/#5157) | Fable planner → plan → Opus |
| buffers (ArrayBuffer/DataView) | 53 | #5150 (full plan; WIP draft PR #5224 unvalidated) | Opus implementer directly (mines the WIP) |
| module-code | 23 | #4759 codex closeout lane | not re-dispatched |
| rest (misc singletons) | 18 | — | folded into the nearest cluster plan |

Ids #5267–#5271 were reserved via `claim-issue.mjs --allocate`
(`--no-pr-scan --allow-unscanned`: no `gh` in this container, so the open-PR
scan could not run; the `check:issue-ids:against-main` gate backstops).

Method (unchanged from the 08-28/29 session): Fable planners re-verify each
list on HEAD with `scripts/run-test262-paths.mts --standalone`, cluster by
root cause with file:function sites, and write the `## Implementation Plan`
into the issue; Opus implementers work each plan in an isolated worktree and
commit validated slices; this lane integrates them into the session branch,
runs the ratchet + equivalence gates, and lands batches through PRs.

## Latest forced census (2026-09-01; replaces the stale dispatch headline below)

This is the latest immutable dispatch baseline for this umbrella. It replaces
the older 2026-08-15/27/30 planning headline below, but it is not final
acceptance evidence: upstream `main` advanced after the fetch from the measured
`f841cddc` source to release head `7fffec53`. A complete maintained-runner census on the
final integrated head is still required before any current pass-rate or
completion claim.

- **Compiler source:** detached `upstream/main`
  `f841cddc0f0ea665b63700d9944a4372a34a8b57`.
- **Baseline provenance:** a forced official fetch with
  `node scripts/fetch-baseline-jsonl.mjs --standalone --force` retrieved
  `test262-standalone-current.jsonl` from immutable
  `loopdive/js2wasm-baselines` commit
  `8a39bd1d4ddf200f8db3751c878ece02aa8688fe` (GitHub Actions commit time
  `2026-09-01T00:28:18Z`).  The 22,858,445-byte cache has SHA-256
  `4426cbf6f305ab4a092468b201cc5854d4470b5fe87edf2fe47ba0195a6e8cbf`.
  Its row timestamps span `2026-09-01T02:02:14Z` through
  `2026-09-01T02:24:30Z`. The baselines repository's `main` moved after this
  fetch; cite the immutable commit above, not the moving branch tip.
- **Schema/completeness check:** all 48,735 JSONL rows parse; every row has
  the required string/number/boolean baseline fields, one of
  `pass|fail|compile_error|compile_timeout|skip`, and a unique `(file,strict)`
  identity.  Optional timing/error fields are absent only where the maintained
  runner schema permits them.
- **Edition authority:**
  `website/public/benchmarks/results/test262-file-editions.json` maps every
  fetched row.  Selecting entries whose exact label is `ES2015` produces
  11,704 rows, all `scope_official: true` (11,536 standard and 168 Annex B).
- **Measured result at `f841cddc`:** **9,616 pass / 11,704 total** (82.16%);
  **1,644 fail, 444 compile_error, 0 compile_timeout, 0 skip** — **2,088
  non-pass**. This
  is progress, not completion; the umbrella remains `in-progress` until the
  complete exact population is 11,704 pass with all other status counts zero.

### Acceptance runner and positive control

Do not infer acceptance from this fetched baseline.  A subsequent implementation
must use the maintained runner, an exact 11,704-path filter derived from the
authoritative edition map, and the runner's completion-manifest validator.  The
shape is:

```bash
COMPILER_POOL_SIZE=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=3072 \
TEST262_TARGET=standalone JS2WASM_EVAL_ENGINE=quickjs \
JS2WASM_QUICKJS_ARTIFACT_DIR=/absolute/prebuilt-quickjs-artifact-dir \
TEST262_PATH_FILTER_FILE=/absolute/path/to/exact-es2015-paths.txt \
TEST262_PUBLISH_HISTORY=0 TEST262_REPORTER=dot \
pnpm run test:262 -- --official-scope-only
```

As a focused positive control for the free #2046 slice, the fetched baseline
records `test/built-ins/Reflect/set/set-value-on-accessor-descriptor.js` as a
standalone **pass** (the supported three-argument native `Reflect.set` path).
Before and after any receiver implementation, it can be exercised without a
full suite via:

```bash
printf '%s\n' \
  'test/built-ins/Reflect/set/set-value-on-accessor-descriptor.js' \
  > /absolute/path/to/reflect-set-positive-control.txt
COMPILER_POOL_SIZE=1 TEST262_TARGET=standalone \
JS2WASM_EVAL_ENGINE=quickjs \
JS2WASM_QUICKJS_ARTIFACT_DIR=/absolute/prebuilt-quickjs-artifact-dir \
TEST262_PATH_FILTER_FILE=/absolute/path/to/reflect-set-positive-control.txt \
TEST262_PUBLISH_HISTORY=0 TEST262_REPORTER=dot \
pnpm run test:262 -- --official-scope-only
```

### Current handoff: owned work versus free exact slices

- **Do not duplicate:** the three ES2015 dynamic-`RegExp` `Symbol.match`
  flag-refusal paths are isolated, but a live sibling worktree owns #5198
  (`codex/5198-regexp-exec-r2-f841-20260901`).  Generator continuations are
  covered by open PR #5383; TypedArray species work by #5385; and builtin
  prototype/null-prototype work by #5384.
- **Free, bounded implementation candidate:** #2046's explicit
  `Reflect.set(target,key,value,receiver)` refusal has **15 exact
  compile-error paths**, all with the same fail-loud diagnostic.  The single
  gate is `src/codegen/expressions/call-namespace-static.ts:903-920`; #2046 is
  in progress, no current GitHub PR matches it, and its visible remote branches
  are June-era checkpoints.  The implementation must preserve the positive
  control above and add receiver plumbing rather than drop the fourth argument.
- **Unowned but not yet a safe parallel coding slice:** #3371's arbitrary
  distinct-`Reflect.construct` NewTarget refusal remains on **33 exact
  compile-error paths** at
  `src/codegen/expressions/call-namespace-static.ts:1620-1627`, despite its
  tracker being marked done.  It needs a reopened/new bounded owner before
  implementation; it is not a substitute for the #2046 slice.  The apparent
  three-row `Array.prototype.flat` refusal is already a tail of #5145's
  in-review ArraySpecies/target-property wave, so do not duplicate it.

## Historical measurement (2026-08-15, superseded as a headline)

Source: fresh `test262-standalone-current.jsonl` (baselines repo, fetched
`--force`, 48,735 entries, baseline_sha `734fab88`), classified per-test with
`scripts/generate-editions.ts` `classifyEdition` (host-free pass definition,
`host_import_leak_class` excluded). Reproduction: `.tmp/es6-standalone-clusters.ts`.

**ES2015 standalone: 7,695 pass / 11,704 total (66%) — 3,401 fail, 607
compile_error, 1 skip = 4,009 non-passing.**

## Cluster map → owning issues

Counts are non-passing ES2015-classified tests in the standalone lane; clusters
overlap paths (a generator test under `language/statements/class` counts in the
generator row).

| # | Cluster (root cause) | ~Tests | Owning issue(s) | State |
|---|---|---|---|---|
| 1 | **Native generator carrier** — standalone lowering only supports "sequential numeric yields"; everything else leaks `__create_generator`/`__gen_*` host imports (CE) or mis-executes. Spread across `language/{expressions,statements}/generators`, `yield`, `class` (gen methods), `object` (gen shorthand), for-of/dstr | ~500 | #2864 (in-progress), #2906 (in-progress), #3032, #680; umbrella #3178 | tracked — do NOT duplicate |
| 2 | **Promise/microtask carrier** — `Promise.all/race` leak `Promise_all`/`Promise_race`/`__js_array_new` (CE); `Promise.resolve` "not yet implemented"; `illegal cast [__then_fulfill_N]` in the async drive layer | ~233 | #2867 (ready), #2906, umbrella #3178 | tracked |
| 3 | **Built-in method reflection** — `length.js`/`name.js`/`prop-desc.js`/`not-a-constructor.js`/`invoked-as-func.js` across every built-in: methods are not reified function objects (`Object.getOwnPropertyDescriptor` → "Cannot convert undefined or null to object", `typeof m === "undefined"`) | ~324 | #2175 (ready, arch spec written), #2158, #2159; sibling lane PR #4553 (method name/length meta) is in flight | tracked — architectural |
| 4 | **TypedArray.prototype semantics** — species-constructor protocol (`speciesctor-*`, 55), custom-ctor paths, detached-buffer TypeErrors (~41), coercion/validation order. Excludes row-3 reflection files | ~556 | **#4449** (filed this session, triage-first; reflection part stays #2159) | tracked |
| 5 | **RegExp `@@replace`/`@@match`/`@@split`/`@@search`** — function replacer refusal (CE, "#1913 follow-up"), coercion order, `lastIndex` protocol | ~161 | #2161 (blocked on #2175), F7 dynamic-receiver arch spec pending | tracked/blocked |
| 6 | **for-of destructuring residual** — iterator close/return/throw propagation, trailing-iterator state (`trlg-iter`, 23), nested patterns, fn-name inference, TDZ | ~200 (non-generator) | **#4447 — slice 1 LANDED** (standalone dstr 342→400/569, gc +51, assignment/dstr +6, 0 lost; binding form + eval-order deferred, see issue) | landed |
| 7 | **Class semantics residual** — `class/dstr` method-param destructuring dominates (112, shares #4447's machinery), subclass (46), definition (36), NamedEvaluation `NaN vs undefined` | ~321 (non-generator) | **#4450** (filed this session; re-measure after #4447 lands; overlaps #2158/#2175) | tracked |
| 8 | **annexB String HTML methods** — the direct-call lowering existed (#3069); the gap was the value-erased proto-closure shape | 79 | **#4445 — DONE** (filter 17→95/111 standalone, 13 HTML dirs 82/82, gc identical; reflection files flipped free via method-meta) | done |
| 9 | **Array.prototype extern fallback leak** — `compileArrayConcatExtern` emits `__array_concat_any`/`__js_array_new`/`__js_array_push` → standalone leak-guard CE | ~30 | **#4446 (this session)** | dispatched |
| 10 | Long tail — `Object.prototype` (38), `Function.prototype` (35), `let`/TDZ (26), `arrow-function` (25), `switch` (23), DataView (45), Iterator.prototype (55) | ~250 | untracked — file per-cluster on pickup | open |

## Strategy

1. **The two umbrella dependencies dominate**: rows 1–2 (generator + promise
   carriers, ~733 tests) are owned by the in-flight #3178 machinery retirement
   lane; row 3 (#2175 reflection, ~324 direct + unlocks rows 4/5/7 residuals)
   has an architect spec and sibling-lane momentum (PR #4553). This umbrella
   does not re-dispatch them.
2. **This session dispatches the unowned, bounded clusters** — #4445, #4446,
   #4447 — to Opus implementation agents in parallel worktrees (plans in the
   issue files).
3. **Next-wave triage issues filed**: #4449 (row 4, TypedArray) and #4450
   (row 7, class residual). Row 10's long tail gets per-cluster issues as the
   dispatched wave lands, so counts stay attributable.

## Session results (2026-08-15, wave 1)

- **#4445 landed** (`5b715e1`): annexB String filter 17→95/111 standalone, 13
  HTML dirs 4/82→82/82, gc unchanged (108/111 before/after, official wrapper —
  an earlier 92/111 figure was a fast-driver artifact). Free follow-up found:
  `trimLeft`/`trimRight` miss the same `STRING_PROTO_METHODS` CSV (6 tests;
  `reference-*` also needs alias identity `trimLeft === trimStart`).
- **#4447 slice 1 landed** (`8dcbc88`): standalone for-of/dstr 342→400/569,
  gc 344→395 (+51 — three of four fixes are lane-independent), standalone
  assignment/dstr 240→246, 0 lost anywhere. Deferred: eval-order interleaving,
  §7.4.9 refinements, fn.name, binding form (~30 tests,
  `destructureParamArray`).
- **#4446**: in flight (interim: concat 13→23 pass, 29→1 CE, 0 lost).

## Acceptance

- ES2015 standalone (host-free) reaches 100% of its 11,704-test bucket.
- Interim checkpoints: each cluster row either has an owning issue with a plan
  or a landed fix; the edition table in this file is refreshed per measurement
  (name the artifact + date per project measurement discipline).

## 2026-08-27 authoritative standalone closeout status

The active goal is the standalone ES2015 edition score. Host measurements are
retained as regression controls but are not part of the completion denominator.
The latest complete maintained-runner ES2015 measurements on the combined
closeout lineage are:

- host run `20260826-180615`: 9,435 pass / 11,704 total, 2,163 fail,
  59 compile errors, 46 compile timeouts, 1 skip;
- standalone run `20260826-194014`: 8,402 pass / 11,704 total, 2,728 fail,
  571 compile errors, 2 compile timeouts, 1 skip.

Later bounded checkpoints have fixed or classified #4758 (40 host
destructuring timeouts), #4759 (20 module-namespace self-import bindings),
#4760 (Promise poisoned-thenable slice), #4762 (mutation-safe realm cleanup),
#4763 (Set replaced-adder abrupt completion), and #3423 (11 nested-object
destructuring rows). Those bounded results do not replace a fresh full 11,704
measurement and are not added arithmetically to the headline.

The active Luna/max wave is issue-backed and isolated: #4449 owns the exact
55-row TypedArray species cohort, #4450 owns four class static `name`/`length`
precedence rows, and #2765 owns three `instanceof` getter/prototype rows. The
single integration target remains upstream draft PR #5010.

Completion requires a fresh authoritative standalone run on the final
integrated head reporting exactly 11,704 pass / 11,704 total with zero fail,
compile error, compile timeout, or skip. Host runs remain required per-slice
regression controls, not a second completion bar. Until the standalone proof
exists, this umbrella remains in progress. Individual completed fixes may be
ready and landed; draft state is reserved for an incomplete or non-mergeable
checkpoint.

## 2026-08-30 Codex resumption and implementation handoff

The 2026-08-27 reference above to a single draft integration PR #5010 is
historical and no longer governs delivery. Current delivery uses one separate
upstream PR per completed fix; only an incomplete or non-mergeable checkpoint
may be draft.

The latest complete exact-filter artifact available at resumption is the
2026-08-28 maintained standalone snapshot. Selecting the frozen 11,704-row
ES2015 map produces **8,681 pass / 2,513 fail / 509 compile_error / 1
compile_timeout / 0 skip**. The artifact SHA-256 is
`260a57b7fb4d53516fa81e1c949d81337968e30ce790d457bcc2d3945c2e9e1e`; the
exact path-map SHA-256 is
`45de809c6bfce7371cee1d20e327758246b0524ecd75481a08b8c03344fced8a`.
Because that artifact does not embed its source commit and predates the
current upstream tree, it is a dispatch baseline, not final acceptance
evidence. Per-slice gains are never added arithmetically to this headline.

Coordination refreshed `loopdive/js2` upstream main to
`a62aacba5ccc154f6fc378235aaaeeb4a7204231`; a fresh fetch immediately after
the diagnostic confirmed that this is still the authoritative upstream head.
The #5194/#5195/#5197/#5198 worktrees and the new #5212/#5213/#5214 lanes are
based on that exact commit. #5131 has integrated it locally but still requires
validation and a corrected commit trailer before its published draft can be
updated.

The full maintained-runner diagnostic on detached source
`1f1004f3df195cc5f9e804efcbb2896d3871ca37` finished all 16 shards of the
11,704-row map with standalone target, two workers, the QuickJS artifact, and
official-scope-only filtering. Vitest's own final summary proves it registered
and executed **11,704 tests**. The canonical JSONL is nevertheless incomplete:
it has **11,685 physical rows / 11,685 unique paths / 8,974 pass / 2,258 fail /
447 compile_error / 6 compile_timeout / 0 skip**. It contains no malformed
rows, duplicate identities, or paths outside the filter, but is missing 19
selected paths. Its SHA-256 is
`47f34c307c43b06c9c40bb0df754bc22d94435a23cccfdd6de857816e199214a`;
the generated partial report SHA-256 is
`f6255daef57aa971bf121b98ea629b53985cf591d47bfc579b54dab538babe59`.

The deficit is localized exactly: shard 10 registered 731 tests and recorded
712, while every other shard reconciled. Vitest grouped the 19 abandoned
callbacks under `Error: Test timed out in 90000ms` at
`tests/test262-shared.ts:644`; the runner then overwrote shard 10's completion
file with later shards and printed `COMPLETED: 8974 pass / 11685 total`. The
atomically allocated markdown issue #5215 records all 19 paths and the
implementation plan for bounded Test262 concurrency, durable per-shard
completion manifests, and a fail-before-publication completeness validator.
This artifact remains exact dispatch evidence for the 11,685 emitted paths,
not an authoritative edition census and not final integrated-head acceptance.

All six recorded timeouts are detached-buffer TypedArray rows: shard 16
reported `byteLength/detached-buffer.js` and
`lastIndexOf/detached-buffer.js`; shard 10 reported
`findIndex/predicate-may-detach-buffer.js` and
`every/callbackfn-detachbuffer.js`; and shard 1 reported
`indexOf/detached-buffer.js` and `buffer/detached-buffer.js`. They remain under
the active #4449 residual and require bounded solo rechecks. The shared census
test lock is now released. After #5212 and #5214 completed their bounded lanes,
#5215 and #5213 each received one compiler/test worker; the global ceiling
remains two and root does not start an overlapping compiler/test lane.

The active work is repository-issue-backed and isolated:

- #5131 owns strict iterator materialization for dynamic spread. Its published
  PR #5272 remains draft because that published checkpoint is conflicting and
  non-mergeable (the shepherd measured 2 commits ahead / 525 behind current
  main); the newer local implementation must integrate current main, pass its
  full focused matrix, and replace the stale handoff before becoming ready.
- #5194 owns the exact 25-row TypedArray `set` Slice A and its host regression
  controls.
- #5195 owns the exact 12-row faithful builtin-subclass slice, with the
  generator carrier explicitly delegated to #5199.
- #5212 is the completed atomically allocated, markdown-only Map/Set provider
  sub-slice from #5195. Its two exact rows pass host and standalone, and its
  single non-draft upstream PR is #5286 at final published head
  `cc653e1cd162ca33a95e659df15a40764d9e7c82`; the dedicated shepherd owns its
  CI/readiness/queue audit.
- #5213 is the atomically allocated, markdown-only two-row class instance
  accessor sub-slice; a separate Luna Max worktree owns the `prototype` key
  collision without touching the collection provider.
- #5214 is the completed atomically allocated, markdown-only six-row NativeError
  prototype-`name` configurability slice. Its exact host/standalone matrix is
  12/12 pass, and its single non-draft upstream PR is #5287 at final published
  head `e7fbfda3bdb6f8ea25acd59ba1cdb376a0aa0f23`; the dedicated shepherd owns
  its CI/readiness/queue audit.
- #5215 is the atomically allocated, markdown-only Test262 verdict-completeness
  repair. Its root-filed implementation plan prevents a timed-out shard from
  being overwritten and published as a complete report; a fresh Luna Max
  worktree now owns the implementation and one-worker validation.
- #5197 owns the exact three-row Promise symbol object-model Slice A.
- #5198 owns the exact nine-row RegExp `exec`/`test` observable-`lastIndex`
  Slice A.

These numbers refer only to markdown files under `plan/issues`; no GitHub
issues are to be created. Implementations use Luna Max agents in separate
provisioned worktrees. Every completed, mergeable fix gets its own non-draft
PR from `ttraenkler/js2` to `loopdive/js2`; only an incomplete or genuinely
non-mergeable checkpoint may remain draft. A separate shepherd agent verifies
the required PR body, mergeability, reviews, CI, exact tested head, and
ready/queue state before landing.

## 2026-08-30 current integrated-head census implementation plan

The numeric title no longer repeats the stale 2026-08-28 snapshot. Historical
measurements above remain useful dispatch evidence, but none is the acceptance
numerator. The next headline will be written only from a complete maintained-
runner census on one exact integrated upstream commit.

At this checkpoint, freshly fetched `loopdive/js2` main is
`01fb67624e2f645b7e92dd9f8e47478e3face9ba`. RegExp Slice A PR #5296 is merged
there. TypedArray `set` Slice A PR #5300 is non-draft at exact tested head
`a6bd6301007e37d289e9378a97891a44846e33f9` and is already in the upstream
merge queue; the census must not start until that exact change lands and this
worktree is fast-forwarded or merged to the resulting current main. The
documentation-only ES2018 tracker PR #5304 does not affect the ES2015
denominator. #5131's two fixed empty-spread rows are unclassified, and #5216's
object-spread rows classify as ES2018, so neither may be added to the ES2015
numerator.

The selection authority is the frozen 11,704-path artifact
`/private/tmp/js2-es2015-11704-pr5008.txt`, whose LF-normalized SHA-256 is
`45de809c6bfce7371cee1d20e327758246b0524ecd75481a08b8c03344fced8a`.
Every entry has a leading `test/`; removing only that prefix produces 11,704
unique `test262/test`-relative paths with SHA-256
`90d5e85a13e3721c8e53734e21c01ec894f736412048cf4d8b15ca7ecc47c2cd`.
Before execution, regenerate that normalized file in this worktree's temporary
area, require exact set equality and 11,704 existing files, and record the
Test262 gitlink/checkout `b363f29d3c43c626dc852744ad64a0b48a003693`.

Execution uses the maintained `scripts/run-test262-vitest.sh` path, not a
hand-written verdict approximation: `TEST262_TARGET=standalone`,
`TEST262_PATH_FILTER_FILE=<normalized exact map>`, official scope only,
`TEST262_WORKERS=1`, `COMPILER_POOL_SIZE=1`, `VITEST_MAX_FORKS=1`, and the
pinned QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`. Keep one compiler/test
worker for this lane and at most two globally. Disable history publication for
the scoped run. Preserve the timestamped JSONL, report, per-shard completion
manifests, source commit, filter hashes, command, and elapsed time in this
tracker before making any claim.

Completeness is a hard gate, not an inference from Vitest's console summary.
The final report must reconcile exactly 11,704 registered tests, 11,704 started
callbacks, 11,704 settled callbacks, 11,704 physical canonical rows, and
11,704 unique selected paths, with no duplicate, malformed, outside-filter, or
missing row. The acceptance result is exactly **11,704 pass / 11,704 total, 0
fail, 0 compile_error, 0 compile_timeout, 0 skip**, with every passing module
host-import free. Any other result keeps this umbrella in progress.

If non-pass rows remain, cluster only this fresh integrated-head artifact by
stable error signature and provider boundary. Root first updates or allocates
one repository-local `plan/issues/*.md` tracker per bounded cluster (new IDs
only through `node scripts/claim-issue.mjs --allocate`), records its exact path
set and implementation plan, and only then fans implementation to Luna Max
agents in separate provisioned worktrees. Each completed fix gets one
mergeable non-draft upstream PR from `ttraenkler/js2`; a genuinely incomplete
or non-mergeable checkpoint alone may remain draft. The dedicated PR shepherd
owns exact head/body/repository/readiness/check/conflict/queue verification.
No GitHub issue is created.
