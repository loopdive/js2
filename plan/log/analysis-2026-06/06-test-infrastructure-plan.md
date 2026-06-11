# 06 — Trust / Test-Infrastructure Plan (2026-06-11)

> Wave-2 analyst report. Inputs: sibling reports
> `01-bug-corpus-synthesis.md` (13-family taxonomy, #1945 promoted to "family
> detector"), `04-fail-loud-audit.md` (ratchet template §5, class-h mode
> leaks §2h), `02-value-representation-spec.md` (§4 — 8 permanent probe
> tables); issues #1945, #1897, #1941, #1862, #2073/#2075; harness sources
> `tests/equivalence/helpers.ts`, `tests/issue-1901.test.ts`,
> `tests/test262-runner.ts`, `scripts/equivalence-gate.mjs`,
> `scripts/diff-test262.ts`, `scripts/diff-test.ts`,
> `.github/workflows/{ci.yml,test262-sharded.yml}`, `docs/ci-policy.md`.

## 0. Executive summary

The June sweeps found ~170 bugs with ~600 ad-hoc probes that the existing
2,000+-file test corpus structurally could not see: equivalence tests are
hand-picked happy paths, the 801 `tests/issue-*.test.ts` files pin *past*
fixes, the test262 oracle deliberately discards error types and
undefined-asserts (#1945), no PR gate executes `--optimize` output (#1941),
and no fast PR-time signal exists for the standalone lane outside the slow
test262 matrix. The plan: (1) convert the probe corpus into a table-driven
**spec-conformance suite** under the already-required `equivalence-gate`
check, auto-diffed against Node, run in 4 lanes (host/standalone ×
O0/-O); (2) a CI rule that every new bugfix issue carries its repro into
the suite; (3) the cheapest #1945 oracle upgrade (trap ≠ catchable for
runtime negatives, then constructor-name checks) with an `oracle_version`
re-baselining protocol; (4) close the remaining standalone-lane gaps
(leak budget test, standalone baseline validator, tolerance ratchet);
(5) encode the flake-classification rules into `diff-test262.ts`.
Sprint 62 = items with S/M effort and the highest detection yield;
sprint 63 = oracle default-flip, probe-migration long tail, nightly -O.

---

## 1. Diagnosis — why the existing suite missed all 170 bugs

Four structural reasons, each fixed by a specific section below:

1. **Hand-written inputs, hand-picked features.** `assertEquivalent`
   (`tests/equivalence/helpers.ts:288-302`) does auto-diff wasm vs Node —
   but each test file supplies a handful of curated functions and inputs.
   Nobody wrote `String(v)` for `v ∈ {true, -0, undefined, [], …}` because
   nobody suspected it. The June probes were exactly such cross-products
   (e.g. #1986's 4-row `===` matrix; #2072's tag table). Table-driven
   value×operator sweeps are the missing shape → §2.
2. **Issue tests pin the past.** 801 `tests/issue-*.test.ts` files exist,
   but each is created *after* a bug is found, scoped to its mechanism.
   They are regression armor, not detection. The 170 new issues' repros
   currently live only in markdown (`## Repro` sections in 99 of the
   issue files; the rest embed repros in `## Problem` ```ts blocks,
   e.g. `plan/issues/1986-…md`) → §2.4 migration + §2.5 CI rule.
3. **The test262 oracle is deliberately blunted.** `assert.throws(T, fn)`
   → `assert_throws(fn)` discards `T` (`tests/test262-runner.ts:652-717`,
   shim at `:1474-1482` catches *anything*); runtime negatives pass on ANY
   throw **including Wasm traps** (`:3247-3251`); `sameValue(x, undefined)`
   stripped (`:840-933`); `throw new Error` → `return 0` (`:631-639`).
   Family F5 (error model, 10 issues) and much of F11 (spec shortcuts,
   11 issues) are invisible by construction (report 01 §3) → §3.
4. **Whole execution configurations are untested.** No gate executes
   optimized binaries (#1941; only `tests/wasm-opt-optimize.test.ts`'s
   6 validate-only tests); `-O` output is currently *rejected* by stock
   V8/JSC (#1973). Only 55 of 1,242 test files touch
   `target: "standalone"`; standalone semantics bugs #2072–#2081 were all
   found by ad-hoc probes, not CI → §4, §5.

---

## 2. Q1 — Probe-corpus conversion: the spec-conformance suite

### 2.1 Where it lives (zero new CI plumbing)

**`tests/equivalence/spec/<family>.test.ts`.** The required
`equivalence-gate` check (`docs/ci-policy.md:37`; `ci.yml:144-194`) runs
`vitest run tests/equivalence/` (`scripts/equivalence-gate.mjs:57-60`)
across 8 shards with a committed **known-failures baseline**
(`scripts/equivalence-baseline.json`, currently 100 entries). A subdirectory
is picked up for free. This baseline is the design's keystone: **probes for
OPEN bugs land immediately as baselined failures** — the issue's repro is
in CI from day one, and the fix PR ratchets it out via
`equivalence-gate.mjs --update`. No "wait until fixed" gap, no separate
gating machinery, no branch-protection change.

### 2.2 Harness — reuse, don't rebuild

New `tests/equivalence/spec/harness.ts` composed from existing parts:

- **Host lane**: `compileToWasm` (`tests/equivalence/helpers.ts:233-264`,
  full runtime imports + `setExports` fidelity per #1659) diffed against
  `evaluateAsJs` (`helpers.ts:270-283`, `ts.transpileModule` + `Function`)
  — **Node is the oracle**; expected values are computed, never
  hand-written. This is exactly how the June sweeps judged wrongness.
- **Standalone lane**: extract `runStandalone` from
  `tests/issue-1901.test.ts:42-49` into the shared harness:
  `compile(src, { target: "standalone" })` → assert `r.success` → assert
  **no banned env imports** (generalize the `BANNED` list at
  `issue-1901.test.ts:24-32` to "anything not in
  `src/codegen/host-import-allowlist.ts`") → `WebAssembly.validate` →
  instantiate with `{}` → call `run()`. Every standalone probe is therefore
  simultaneously a **semantics check and a #2073/#2075-class import-leak
  check**.
- **Optimize lanes**: a `{ optimize: true }` compile knob (per #1941 step 1)
  giving the 4-lane matrix `host`, `host-opt`, `standalone`,
  `standalone-opt`.

Probe record:

```ts
interface SpecProbe {
  id: string;            // "1986-3"
  issue: number;         // 1986 — drives the CI coverage rule (§2.5)
  src: string;           // canonical `export function run(): string|number`
  drain: "string" | "number";
  lanes?: Lane[];        // default: all 4
  expected?: unknown;    // override ONLY when Node can't be the oracle
                         //   (TS-typed semantics like `type i32`, or
                         //   harness-unsupported syntax)
}
```

Canonical drain convention (matches the sweep style): a single exported
`run()` returning a string like `String(a) + "," + String(b)`. **Standalone
caveat**: zero-import modules can't hand a JS string back through host
glue the same way; prefer `drain: "number"` for standalone-laned probes,
or let the harness compile a self-checking wrapper
(`return <expr> === <nodeComputedLiteral> ? 1 : 0`) — documented circularity
risk (string-eq is itself under test) is acceptable because the host lane
checks the same probe precisely, and the standalone lane's unique value is
the leak/instantiation/representation check.

### 2.3 Why not a new top-level suite

Considered `tests/spec/` + its own gate: rejected. It would need its own
required check (admin), its own baseline machinery, and would drift from
the equivalence harness exactly the way report 01's F8 (duplicated lowering
paths) warns about in the compiler itself. `tests/equivalence/spec/` rides
required CI today.

### 2.4 Migration of the ~600 June probes

- **Unit of migration = family file**, mirroring report 01's taxonomy:
  `spec/silent-fallback.test.ts` (F1), `spec/value-repr-*.test.ts` (F2 —
  adopt report 02 §4's eight T-tables verbatim: T-string, T-typeof,
  T-truth, T-eq, T-iter, T-undef, T-holes, T-backend; 02:423-453),
  `spec/coercion.test.ts` (F3), `spec/host-marshal.test.ts` (F4),
  `spec/error-model.test.ts` (F5), `spec/class-model.test.ts` (F6),
  `spec/bindings.test.ts` (F7), `spec/builtins-spec.test.ts` (F11),
  `spec/standalone-lane.test.ts` (F12).
- **Source of truth**: the issue files' fenced ```ts blocks — 99 issues have
  explicit `## Repro` sections; the rest carry repro tables in `## Problem`
  (`1986-…md` shows the canonical shape: snippet + wasm-vs-node table).
  Extraction is mostly mechanical (copy snippet, wrap in `run()`, set
  `issue:`); expected comes from Node automatically.
- **Effort**: ~2–3 families per dev-day; 6 bundled PRs (one per 2 families)
  so `equivalence-baseline.json` diffs stay reviewable. Each PR adds its
  open-bug probes to the baseline with the issue ID in the entry name.
- **Priority order** = report 01's leverage ranking: F2 T-tables first
  (they guard the sprint-62 value-representation work), then F1, F3, F5.

### 2.5 The "every new issue carries its repro" rule

New `scripts/check-issue-spec-coverage.mjs`, wired into the `quality` job
(`ci.yml:19`) beside the existing issue-integrity gate (`ci.yml:60`,
#1616). Logic:

1. Collect `plan/issues/<id>-*.md` with `task_type: bugfix|test` and
   `area: codegen|codegen-linear|stdlib` and `created >= 2026-06-15`
   (cutoff — no retroactive blocking; the migration §2.4 handles history).
2. For each, require a reference (`issue: <id>` field in a `SpecProbe`, or
   `#<id>` in a `tests/issue-<id>*.test.ts`) somewhere under `tests/`.
3. Enforcement levels (matches the issue lifecycle in CLAUDE.md):
   - issue file present, `status: ready|in-progress` → **warning** (PO may
     file before probing — but the sweep agents already *have* the probe,
     so the norm is: file issue + probe in the same PR, probe baselined
     as a known failure).
   - PR flips `status: done` → **hard fail** if no reference exists. The
     fix PR must carry (or already see) the repro and de-baseline it.

This makes the loop closed: probe lands red-but-baselined at discovery,
turns green at fix, and can never silently regress after.

---

## 3. Q2 — Oracle precision (#1945)

### 3.1 What the runner actually does today (verified)

- **Runtime negatives**: any exception OR trap = pass
  (`tests/test262-runner.ts:3247-3251` — `if (isRuntimeNegative) return
  pass` inside the catch-all). A test expecting a *catchable TypeError*
  that instead hits a Wasm `RuntimeError` trap is recorded **pass**. This
  is the exact blind spot hiding family F5 (10 issues: #2003, #2017,
  #2025, #2031, …).
- **`assert.throws(T, fn)`**: `transformAssertThrows` (`:652-717`) keeps
  only `fn`; the compiled shim (`:1474-1482`) catches anything. Note an
  important asymmetry: Wasm traps are NOT catchable by in-module
  `try/catch`, so a trap *escapes* the shim and the test records `fail` —
  trap-vs-throw is already (accidentally) detected on this path. The
  remaining gap here is **wrong error type** (RangeError where TypeError
  expected) — pure F11 territory.
- Plus the `sameValue(x, undefined)` strip (`:840-933`) and
  `throw new Error → return 0` (`:631-639`).

### 3.2 Cheapest upgrade, in order of cost

**Step 1 (~30 lines, runner-only, no compiled-code changes): make traps
fail runtime negatives.** In the catch block at `:3238`, before the
`isRuntimeNegative` early-pass:

- `err instanceof WebAssembly.RuntimeError` (or message matching the trap
  classifier already in `classifyError`, `:3329-3332`) → runtime negative
  **fails** with `expected catchable ${type}, got wasm trap`.
- Otherwise extract the message via the existing
  `extractWasmExceptionMessage(err, instance)` (`:3277`, #1155 — the
  `__exn_tag` payload extraction already works for standalone) and
  **prefix-match the expected constructor name** (`meta.negative.type`,
  parsed at `:269-273`): payloads/messages are already shaped
  `"TypeError: …"`. No instanceof gymnastics needed; string-prefix is the
  cheap 95% oracle.

**Step 2 (medium): typed `assert_throws`.** Change `transformAssertThrows`
to emit `assert_throws(fn, "TypeError")` when `args[0]` is a known global
error class; the shim's catch arm consults an error-name primitive — host
lane: a sandbox-provided `__error_ctor_name(e)` global (the runner already
injects a `globalSandbox`, `:3113-3115`); standalone: prefix of the
exception-tag payload. Land behind `TEST262_STRICT_THROWS=1` exactly as
#1945 proposes.

**Step 3**: re-audit the undefined-assert strip (the #1995 fix — `ref.null`
→ host `undefined` — removed much of its reason to exist) and the
`throw new Error` rewrite, per #1945 items 2–3.

### 3.3 Re-baselining cost and protocol

Every tightening flips current `pass` rows to `fail`. Two required checks
would otherwise block the flip PR itself: the #1668 catastrophic guard and
`check for test262 regressions` (both in `merge shard reports`,
`docs/ci-policy.md:35,38`) diff against the pre-flip baseline. Protocol:

1. Land step 1/2 **flag-gated** (`TEST262_STRICT_*`), default off. Zero
   baseline impact.
2. Measure on the PR's own sharded run via `workflow_dispatch` with the
   flag (the 57×2 matrix already runs at PR time — no extra infra), bucket
   the delta with `/harvest-errors`, mint issues (these are real F5/F11
   bugs, the point of the exercise).
3. **Stamp `oracle_version` into every JSONL row + merged report.** Teach
   `scripts/diff-test262.ts` to refuse cross-version diffs unless
   `ORACLE_REBASE=1` is set; the flip PR sets it once, and
   `promote-baseline` (runs on every push to main,
   `test262-sharded.yml`) re-seeds both host and standalone baselines at
   the new version on merge. Subsequent PRs diff like-for-like.
4. PO messaging: headline drops (that drop is honesty — #1945's own
   framing); dashboard gets the "oracle strictness" note per the issue's
   acceptance criteria.

Measured cost: one coordinated flip PR + one full sharded run (~35 min CI
wall) + a one-line validator note. The `test262-baseline-validate.yml`
spot-checker re-runs entries with the *current* runner, so it self-heals
after promotion — no manual baseline surgery.

---

## 4. Q3 — Differential testing (#1941), concretized

**Generator choice: corpus re-execution, not grammar fuzzing.** Three
concentric lanes, cheapest-first; a fuzzer (#1855) is deferred until these
are green (fuzz findings would currently drown in known-broken territory —
#1973 shows `-O` output doesn't even instantiate on stock V8/JSC).

| Lane | What runs | Where | Budget |
|---|---|---|---|
| **D1: spec-probe 4-lane matrix** (§2.2) | ~600 probes × {host, host-opt, standalone, standalone-opt} | per-PR, inside `equivalence-gate` shards | ≈4–8 min single-fork, parallel with the existing 8 shards — no wall-clock increase |
| **D2: #1941 steps 1–3 as written** | (a) one equivalence shard re-run with `{optimize:true}` — 9th matrix entry `shard: 1, optimize: 1` in `ci.yml:149`; (b) `scripts/diff-test.ts` optimize lane over the 104-program V8-oracle corpus (`tests/differential/corpus`, gated by `diff-test.yml`) | per-PR | ≈ one extra shard + ~2 min diff-test |
| **D3: test262 under `-O`** | full 57-shard matrix with `optimize: true`, own baseline `test262-opt-current.jsonl` in the baselines repo | `workflow_dispatch` first (size it, per #1941 step 4) → weekly `schedule` | one sharded run/week; not per-PR |

Notes:
- D1 is the *new* leverage this plan adds over #1941: the probe corpus is
  precisely the input set that found the 170 bugs, and the 4-combo matrix
  is what exposed the lane-divergent failures (report 02: "the lanes fail
  differently"). #1941's own corpus (playground examples + diff-test) never
  exercised those value/operator cross-products.
- D2's first run will **mass-fail on #1973** (`-O` rejected by stock
  engines, `optimize.ts:393-400` custom-descriptors workaround territory).
  Either fix #1973 first (it's sprint-61 adjacent) or seed the
  optimize-mode baseline with the wreckage — both are honest; fixing first
  is cleaner and #1941 already carries `priority: critical`.
- Per-PR budget total: ≤1 shard-equivalent of extra compute; merge-queue
  wall time unchanged (matrix parallelism).

---

## 5. Q4 — Standalone as a required lane

**Already done** (verify + bookkeep): the #1897 standalone net-regression
guard is live inside the required `merge shard reports` check
(`test262-sharded.yml:617-645`; `docs/ci-policy.md:35` documents it; the
guard reads `improvements − wasm-changing regressions` with
`compile_timeout` structurally excluded, tolerance 15). PR #1245's changes
are on main; the issue file is stale at `status: in-review` — flip to
`done` (the known self-merge-orphan pattern from CLAUDE.md).

**What's still missing for parity with the host lane:**

1. **No standalone baseline validator.** `test262-baseline-validate.yml`
   spot-checks 50 `pass` entries — host JSONL only. A rotted
   `test262-standalone-current.jsonl` silently weakens the #1897 floor
   (stale fails read as headroom). Add a standalone sample (even 15
   entries) to the same workflow. **S effort.**
2. **Tolerance leak.** The floor is *moving*: `promote-baseline` re-seeds
   on every push to main, so a sequence of −14-net PRs compounds
   ratchet-free. Add a slow absolute backstop: a weekly job (or a step in
   D3) asserting standalone pass-count ≥ (high-water mark − 50), with the
   high-water mark committed like `benchmarks/results/test262-current.json`.
   **S effort.**
3. **No fast PR-time standalone signal.** Today the only standalone gate is
   the full test262 matrix. The June standalone bugs (#2072–#2081) were
   found by probes in minutes. §2.2's standalone lane in `equivalence-gate`
   fills this — every probe asserts zero-leak instantiation + behavior.
4. **Import-leak structural gate (the #2073/#2075 family).** These leaks
   bypass the strict `addImport` gate (`src/codegen/registry/imports.ts:34-46`;
   report 04 §2h calls out the stale-funcMap bypass the file itself
   documents). Two cheap layers:
   - **Emit-time assertion**: post-link scan of the import section under
     `--target standalone` — any surviving non-allowlisted `env` import is
     a structured compile error (report 04 §3h: "cheap and absolute").
   - **Corpus leak-budget test**: compile `website/playground/examples/`
     (the #1376 corpus) with `target: standalone`, aggregate leaked import
     names into a ratcheted baseline — a clone of
     `tests/host-import-allowlist-budget.test.ts` (#1524/#1888 template).
     This catches leaks on constructs the spec probes don't cover yet.
5. **Coordination with the fail-loud ratchet**: report 04's
   `check-codegen-fallbacks` plan (§5) should count class-(h) mode leaks in
   the same baseline file so there is one ratchet dashboard
   (`plan/log/ir-adoption.md` section, per 04 §5.4).

---

## 6. Q5 — Baseline trust: residual gaps + flake rules worth encoding

1. **#1862 poisoned-worker residual** — the unified-worker fix merged
   (PR #1285, commit `2e5441064`): poison classifier shared
   (`scripts/test262-poison-error.mjs`), poison-class `compile_error` rows
   retried once in a recycled worker. **Open**: (a) acceptance boxes 2–3
   unchecked — confirm a fresh promoted baseline shows the
   `Binary emit error: offset is out of bounds` cluster at ~0 (was 269–271);
   (b) the issue's investigation item 3 — `promote-baseline` should
   **re-run rather than carry forward** any row matching
   `POISON_ERROR_RE` — is NOT implemented, so phantom rows can still
   persist across promotions (the #1080 drift class). **S effort.**
2. **Validator samples only `pass` rows**
   (`test262-baseline-validate.yml`, 50 entries). A stale `fail` row that
   actually passes on main inflates `improvements` in every PR diff,
   masking an equal number of real regressions via the net arithmetic.
   Add a small `fail`-row sample (assert they still fail). **S.**
3. **Unpinned baseline fetch**: `scripts/fetch-baseline-jsonl.mjs` pulls
   `loopdive/js2wasm-baselines@main` HEAD raw — a promote racing a PR's
   fetch yields a baseline newer than the PR's merge-base. The runner
   already surfaces `baseline_staleness_commits` in ci-status; cheap
   hardening: record the baseline `gitHash` in the diff output so
   `/dev-self-merge` can flag skew mechanically instead of by convention.
4. **Encode the flake-classification rules in `scripts/diff-test262.ts`**
   (it already excludes `pass → compile_timeout` from the gating count,
   `diff-test262.ts:224-233`, and wasm-unchanged noise, `:243-245`):
   - Memory rule, currently tribal: *pass→compile_timeout is runner-load
     flake **unless** baseline compile >5s*. JSONL rows carry
     `timing.compileMs` (runner `TestTiming`). Split CT transitions into
     `ct_flake` (baseline compileMs ≤ 5000 — excluded, as today) and
     `ct_suspect` (> 5000 — printed as a warning block, still non-gating).
   - Cross-PR drift heuristic (memory: "identical clusters across
     unrelated PRs are drift"): print a stable signature hash of the
     regression bucket set in the diff summary so two PRs' outputs can be
     compared with `grep` instead of eyeballs.
   Both are output-only changes — no gate semantics shift. **S.**

---

## 7. Q6 — Sequencing by trust-gained-per-effort

| # | Item | Effort | Trust gained | Sprint |
|---|---|---|---|---|
| 1 | Spec-suite harness (`tests/equivalence/spec/harness.ts`: host+standalone+opt lanes, Node oracle, baseline integration) + F2 T-tables + F1/F5 top probes (~150 probes) | M | Detection for the 3 worst families on every PR, both lanes; guards the sprint-62 value-repr work (report 02 dependency) | **62** |
| 2 | #1941 D2: optimize equivalence shard + diff-test `-O` lane (gated; fix or baseline #1973 first) | S (issue rated easy/critical, already `sprint: 61 ready`) | Closes the largest untested correctness surface | **62** |
| 3 | Standalone leak-budget corpus test + emit-time import-section assert | S | Kills the #2073/#2075 class structurally; standalone PR signal beyond test262 | **62** |
| 4 | Issue→probe CI rule (`check-issue-spec-coverage.mjs` in `quality`) | S | Loop closure: no future sweep-class bug lands without permanent armor | **62** |
| 5 | Oracle step 1 (trap ≠ pass for runtime negatives) flag-gated + measured dashboard run + bucket triage | S code / 1 sharded run | Makes F5 (10 issues) visible to CI for the first time | **62** |
| 6 | Validator: standalone sample + fail-row sample; flip #1897 issue to done | S | Baseline floor actually trustworthy in both lanes | **62** |
| 7 | Oracle step 2 (typed assert_throws) + `oracle_version` stamp in JSONL + diff-version guard + coordinated default flip & re-baseline | M | F11 wrong-error-type bugs visible; honest headline | **63** |
| 8 | Probe migration long tail (remaining families F3/F4/F6/F7/F11/F12, ~6 bundled PRs, parallelizable across devs) | M | Full 600-probe corpus permanent | **63** |
| 9 | D3 weekly test262 `-O` lane + absolute standalone floor backstop | S | Slow-drift detection in both untrusted dimensions | **63** |
| 10 | Flake rules in diff-test262 (`ct_suspect`, bucket signature hash) + #1862 promote-baseline poison re-run | S | Less triage noise; phantom rows can't persist | **63** |
| 11 | Grammar fuzzer (#1855); linear-backend lane in the spec suite (report 02 T-backend / #1854) | L | New-input discovery — only pays once corpus lanes are green | 64+ |

Rationale for the split: everything in sprint 62 is S/M, lands the
*mechanisms* (suite, lanes, rules, gated oracle), and none of it moves the
headline number — so it can't collide with the in-flight conformance work.
Sprint 63 contains the two items that intentionally move baselines (oracle
flip, `-O` baselines) and the parallelizable migration grind, scheduled
after the mechanisms have a sprint of soak.
