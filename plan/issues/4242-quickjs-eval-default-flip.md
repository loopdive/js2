---
id: 4242
title: "Eval engine parity measurement + default flip to QuickJS — interpreter STAYS selectable behind the flag, nothing is deleted"
status: ready
sprint: current
created: 2026-08-08
updated: 2026-08-09
priority: medium
horizon: l
feasibility: medium
model: fable
reasoning_effort: high
task_type: feature
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [2928, 2929, 4013, 4229, 4236, 4238, 4245]
blocked_by: [4238, 4245]
# id 4242 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-08 (gh CLI unavailable; pr_scan=degraded). Equivalent open-PR scan
# via the GitHub MCP at reservation time: sole open PR was PR 4250 (#4238
# slice 1, edits the existing 4238 issue file, introduces no new issue ids).
# The id coincides with a merged PR number — shared sequence, not a namespace
# (precedent: 4235/4236/4237, 4245).
---

# #4242 — parity measurement + default flip to QuickJS (no removals)

## The directive this issue encodes (project lead, 2026-08-08)

> do that, but dont delete or remove our interpreter or ir code that it
> needs.

So the migration endgame is a **default flip, not a retirement**:

- `JS2WASM_EVAL_ENGINE` unset → **quickjs** (after this issue lands).
- `JS2WASM_EVAL_ENGINE=interpreter` → the Acorn+bytecode interpreter
  provider, exactly as today, **kept working indefinitely**.
- **Non-goal, permanently out of scope here: deleting or degrading
  `src/interp/`, the interpreter provider build, acorn, or any IR/codegen
  substrate the interpreter needs.** Any future retirement is a separate
  decision for the project lead, not part of this migration.

## Phase 1 — parity measurement (the decision artifact)

- [ ] Run the full eval-dependent test262 set (the ~826-file eval bucket +
      Annex B eval families + `new Function` buckets) under
      `JS2WASM_EVAL_ENGINE=quickjs` on the #4238+#4245 stack; produce a
      three-way diff: quickjs-vs-interpreter-vs-baseline, bucketed by root
      cause (scope fidelity, membrane residuals, engine differences,
      genuine wins where QuickJS fixes interpreter residuals).
- [ ] Record the table in this file. Gate: proceed to Phase 2 only if the
      quickjs engine is **net ≥ interpreter** on the measured set, or every
      net-negative bucket has an explicit accepted-residual entry approved
      in this file.

## Phase 2 — the flip

- [ ] Default branch in `scripts/runtime-eval-provider.mjs` flips to
      quickjs; `interpreter` remains a first-class selectable engine; the
      unknown-value error lists both.
- [ ] Artifact availability becomes a default-path concern: wire the
      QuickJS artifact into the #4013 provider-artifact CI pattern (shared
      cache, key folds the pinned quickjs-ng sha + shim hash) so default
      runs never build from scratch; offline/cache-miss behavior defined
      (hard error with the build command — never a silent fallback to the
      interpreter, which would make conformance numbers lie).
- [ ] Re-baseline test262 (the flip will move eval-bucket results; the
      regression gates must compare like-with-like), following the
      #1528/#3467 baseline-refresh discipline.
- [ ] The QuickJS eval lane becomes the default-exercised path in CI;
      an **interpreter lane** (small, scheduled or per-merge scoped subset
      under `JS2WASM_EVAL_ENGINE=interpreter`) is ADDED so the kept engine
      can't rot silently — mirror image of #4238's constraint 3.
- [ ] Consumers audited: playground/REPL (#4229) and any
      `selectCachedRuntimeEvalProvider` caller picks the intended engine
      explicitly or inherits the new default knowingly (grep audit recorded
      here).
- [ ] Docs: `docs/architecture/runtime-eval-interpreter.md` gains the
      two-engine section; CLAUDE.md test262 notes updated if eval-bucket
      counts shift.

## Acceptance criteria

- [ ] Flip lands with the parity table recorded and the gate above
      satisfied.
- [ ] `JS2WASM_EVAL_ENGINE=interpreter` still passes the interpreter's own
      eval lane after the flip (proof the kept engine still works).
- [ ] No file under `src/interp/` deleted; no acorn/IR removal; diff
      audited for accidental interpreter-path changes.
- [ ] Zero regressions outside the eval buckets; eval-bucket deltas match
      the parity table's accepted entries.

## Implementation Plan

(architect, 2026-08-09 — grounded in the #4238 spec + slice-1 implementation
record and the #4245 plan; every `file:line` anchor verified against
loopdive/main @ e541dcad9. Prerequisite state this plan assumes: #4238
slices 2–3 landed (value bridge, `qjs_call`, error mapping, direct-eval
scope snapshot) and #4245 landed or explicitly waived by the project lead —
without #4238 slice 3, every assembled test262 file carries the
direct-eval-bearing `$262.evalScript` shim (`scripts/test262-import-object.mjs:103-113`
rationale block) and a full run under the flag measures the refusal, not the
engine. Where something depends on #4245's final residual record, it is
marked **resolved-at-implementation-time** rather than guessed.)

### Decision summary (read this first)

| decision | choice |
| --- | --- |
| measured set | four path buckets (concrete globs, §P1.1; 1,351 files) + a scan-generated eval-dependent manifest for partitioning full-run diffs. Both engines run the identical set. |
| runner | the EXISTING vitest runner, unmodified: `TEST262_TARGET=standalone` + `TEST262_PATH_FILTER` (`tests/test262-runner.ts:466-492`) + the already-landed prebuild hook (`scripts/run-test262-vitest.sh:203-206`). No new runner path. |
| diff tool | new `scripts/eval-engine-parity.mjs` — a THREE-WAY wrapper that reuses `scripts/diff-test262.ts`'s jsonl reading + bucket conventions (`REGRESSION_BUCKET_PATH_DEPTH`, `diff-test262.ts:34-40`); it does not reimplement pairwise diffing semantics. |
| gate | mechanical: script exits non-zero unless `quickjs.pass ≥ interpreter.pass` on the measured set OR every net-negative bucket matches an `accepted-residuals` entry in THIS file, approved by the project lead. |
| flip | ONE default constant change (`scripts/runtime-eval-provider.mjs:611`) + the inventory in §P2.1. `interpreter` stays a first-class engine forever; **nothing under `src/interp/`, no acorn, no IR substrate is deleted or edited** (§P2.5 makes that machine-checked). |
| artifact on the default path | #4013 pattern: the `runtime-eval-provider` CI job (`test262-sharded.yml:551-598`) grows a quickjs build+cache+distribute leg, content-keyed on the pinned quickjs-ng sha ∥ shim hash ∥ build.sh hash (= `quickjsArtifactCacheKey`) + adapter keyed on compiler-bundle hash. Cache-miss offline ⇒ HARD error naming `node scripts/build-quickjs-eval-provider.mjs` — the selector already does this (`scripts/quickjs-eval-provider.mjs:518-535`); the flip must NOT soften it into an interpreter fallback. |
| interpreter anti-rot | new small non-required workflow `eval-interpreter-lane.yml` (weekly cron + dispatch): interpreter unit suites + the scoped `language/eval-code/` test262 run against a committed floor. Mirror image of #4238 constraint 3. |

### Phase 1 — parity measurement

#### P1.1 The measured set (concrete)

Path buckets (counts from the pinned test262 checkout, `_FIXTURE` excluded):

| bucket | glob (relative to `test262/test/`) | files |
| --- | --- | --- |
| eval-code, standard | `language/eval-code/**` | 347 |
| eval-code, Annex B | `annexB/language/eval-code/**` | 469 |
| `eval` builtin surface | `built-ins/eval/**` | 10 |
| `new Function` / CreateDynamicFunction | `built-ins/Function/**` (incl. `prototype/` — harmless, identical on both engines) | 509 |
| Annex B Function | `annexB/built-ins/Function/**` | 6 |
| direct-eval call semantics | `language/expressions/call/eval-*` | 10 |
| **total** | | **1,351** |

This is a superset of the interpreter's authoritative 816-file
`language/eval-code/` measurement (797/816 pass, Annex B 469/469 — the
number the gate compares against; remeasurement template in
`plan/issues/2928-bytecode-interpreter-core-standalone-eval.md:419-427`).

`TEST262_PATH_FILTER` is substring-match on pipe-separated patterns
(`tests/test262-runner.ts:466-492`, applied BEFORE compile/cache), so the
whole set is one env var:

```
TEST262_PATH_FILTER='language/eval-code/|built-ins/eval/|built-ins/Function/|language/expressions/call/eval-'
```

(`language/eval-code/` matches both the standard and `annexB/` trees —
verified precedent at `2928-…md:429-430`; same for `built-ins/Function/`.)

**Eval-dependent manifest** (for partitioning FULL-run diffs, not for
scoping runs): `scripts/eval-engine-parity.mjs --manifest` writes
`.test262-cache/eval-dependent-manifest.json` = the path buckets ∪ every
test file `scripts/eval-const-classifier.mjs --json` reports as carrying an
`eval(...)`/`(0,eval)(...)` call-site (1,460 files logged 2026-07-02,
classifier header) ∪ a `\bnew\s+Function\b|\bFunction\s*\(` grep over
`test262/test/`. Dedup, sort, record the test262 submodule sha. The
manifest partitions a full standalone diff into *inside-set* (engine may
move it) and *outside-set* (must be zero-delta — §P1.4 invariant 3).

#### P1.2 Runner mechanics (the three runs)

All runs are `TEST262_TARGET=standalone` (the provider namespace exists only
there — `test262-import-object.mjs:105-113`); the QuickJS artifact reaches
workers through the shared `.test262-cache` (the prebuild hook builds once;
workers only load — the 30s pool rule, `runtime-eval-provider.mjs:16-20`).

**Run A — quickjs, scoped** (local, this box):

```sh
JS2WASM_EVAL_ENGINE=quickjs \
TEST262_TARGET=standalone \
TEST262_PATH_FILTER='language/eval-code/|built-ins/eval/|built-ins/Function/|language/expressions/call/eval-' \
TEST262_REPORTER=dot TEST262_WORKERS=4 COMPILER_POOL_SIZE=4 \
TEST262_MAX_UNCLASSIFIED_ROOT_CAUSES=9999 \
pnpm run test:262 -- --official-scope-only
cp benchmarks/results/test262-standalone-results-<ts>.jsonl \
   benchmarks/results/eval-parity/quickjs-scoped.jsonl
```

The `run-test262-vitest.sh:203-206` hook prebuilds the quickjs provider and
**fails the run** on error (never degrades to the interpreter — comment at
`:194-202` is the contract). Note the jsonl filename does not encode the
engine: **copy each run's timestamped jsonl to an engine-named file under
`benchmarks/results/eval-parity/` immediately**, before the next run
re-links the `test262-standalone-results.jsonl` symlink.

**Run B — interpreter, scoped** (same command with
`JS2WASM_EVAL_ENGINE=interpreter TEST262_FULL_RUNTIME_EVAL=1`; the FULL
flag is required or the refusal tier answers — `runtime-eval-provider.mjs:634-646`;
it is ignored under quickjs, `quickjs-eval-provider.mjs:548-550`). Copy to
`eval-parity/interpreter-scoped.jsonl`. Compile caches are shared between
runs A and B (user modules compile identically under both engines — the
#4238 frozen-seam invariant), so run B is mostly execution time.

**Tier-pinning is load-bearing, not hygiene (lead-verified on live main,
2026-08-09).** Selection is THREE-way: REFUSAL is the no-env default
("fast local diagnostic only, NOT CI-comparable" — every dynamic-code call
throws TypeError), INTERPRETER needs `TEST262_FULL_RUNTIME_EVAL=1`
("authoritative CI-comparable"), QUICKJS needs the engine flag and
**ignores** the FULL flag. An "interpreter" run that forgot the FULL flag
measures the REFUSAL tier and hands quickjs a fake landslide win. So each
run's provenance MUST capture the lazily-announced tier line
(`[test262] runtime-eval tier: …`, `test262-import-object.mjs:84` — grep it
out of `/tmp/test262-vitest-run.log` after each run) and the parity script
stores it as `inputs.<engine>.tier_announcement`; gate invariant 5 (§P1.4)
rejects the diff unless run A's announcement contains `QUICKJS` and run B's
contains `INTERPRETER` (specifically NOT `REFUSAL`).

Both engines are proven executable through the frozen seam today (lead
probe, 2026-08-09: same compiled module, runtime-assembled eval argument —
interpreter passes number + string cases; quickjs passes number, throws an
opaque `Exception: undefined` on the string case, which is exactly the
slice-2 value-bridge + error-mapping gap in flight). That probe shape —
one module, both engines, per-engine expected outcome, runtime-assembled
source so `tryStaticEvalInline` cannot vacuously fold it — is the template
for `eval-engine-parity.test.ts`'s live smoke case (the probe itself lives
in `.tmp/` and is not committed).

**Run C — committed baseline**: `node scripts/fetch-baseline-jsonl.mjs
--standalone` → `.test262-cache/test262-standalone-current.jsonl`
(freshness-by-default, #3629; the STANDALONE baseline, not the host one —
`fetch-baseline-jsonl.mjs:67,81,337`). This is the interpreter-engine
truth as CI last promoted it; it cross-checks run B (B vs C flips on the
measured set ≈ 0 modulo drift; a large B↔C gap means the local
environment is broken — stop and fix before trusting A).

**Expected wall-clock**: 1,351 files ≈ 1.6 % of a full run; with warm
compile cache, ~10–20 min per engine at 4 workers on the 8-core box.
Budget ≤ 1.5 h for A+B+C including the cold quickjs artifact build (~3 min).

**Optional full-suite confirmation (Tier B, recommended before Phase 2):**
one full standalone run per engine, to prove the outside-set invariant and
surface per-test instantiation-overhead timeouts (the quickjs bundle
instantiates `libquickjs.wasm` + adapter fresh per test — a cost class the
scoped run underweights). Cheapest path: the `eval_engine` dispatch input
added in §P2.2 (land that slice FIRST, it is default-neutral), then
`workflow_dispatch` `test262-sharded.yml` with `eval_engine=quickjs` and diff
the merged `test262-standalone-results-merged.jsonl` (`test262-sharded.yml:1158`)
against run C. Fallback if CI capacity is tight: a local full standalone run
(~60–90 min); accept it as Tier B with the caveat recorded.

#### P1.3 `scripts/eval-engine-parity.mjs` — the three-way diff artifact

New script. Subcommands:

- `--manifest` — write the manifest (§P1.1).
- `--diff --quickjs <a.jsonl> --interpreter <b.jsonl> --baseline <c.jsonl>
  [--full]` — the three-way diff. `--full` activates the manifest partition
  (outside-set invariant); scoped mode skips it.
- `--gate --diff-json <parity.json> --issue plan/issues/4242-…md` — evaluate
  the gate (§P1.4), exit 0/1.

Reuse, do not reinvent: import the jsonl loader + status normalization from
`scripts/diff-test262.ts` (export a `loadResults` helper if not already
exported — S-size refactor, no behavior change) and its bucket convention
(`REGRESSION_BUCKET_PATH_DEPTH = 5`). `/analyze-regression` stays the
ad-hoc skill; this script is its reproducible, attributed sibling.

Output `benchmarks/results/eval-parity/parity-<ts>.json`:

```jsonc
{
  "schema_version": 1,
  "generatedAt": "2026-08-…",
  "inputs": {
    "quickjs":     { "path": "…", "runTimestamp": "…",
                     "tier_announcement": "QUICKJS (artifact …)" },
    "interpreter": { "path": "…", "runTimestamp": "…",
                     "tier_announcement": "INTERPRETER (key …)" },
    "baseline":    { "path": "…", "fetchedAt": "…" }
  },
  "set": { "mode": "scoped|full", "manifest": "…", "files": 1351,
           "test262_sha": "…" },
  "summary": {
    "quickjs":     { "pass": 0, "fail": 0, "compile_error": 0, "total": 0 },
    "interpreter": { "…": 0 },
    "baseline":    { "…": 0 },
    "net_vs_interpreter": 0            // quickjs.pass − interpreter.pass
  },
  "sanity": { "interpreter_vs_baseline_flips": 0 },   // run-B health check
  "flips": [ { "file": "language/eval-code/…",
               "interpreter": "pass", "quickjs": "fail",
               "baseline": "pass", "error": "…first line…",
               "bucket": "scope-fidelity", "rule": "R3" } ],
  "buckets": { "<name>": { "wins": 0, "losses": 0, "net": 0,
                           "files": ["…"] } },
  "outside_set_delta": { "count": 0, "files": [] },   // --full only
  "gate": { "verdict": "PROCEED|BLOCKED", "reason": "…",
            "unaccepted_negative_buckets": [] }
}
```

plus a `parity-<ts>.md` markdown table (the thing that gets pasted into
this issue file under `## Parity Measurement (Phase 1)`).

**Bucket rules** — an ordered `RULES` table in the script, first match wins,
each rule = `{ name, pathPrefixes?, errorPatterns?, bucket }`:

1. `win` — quickjs `pass`, interpreter non-`pass`. (Genuine wins where
   QuickJS fixes interpreter residuals — e.g. the interpreter's 19
   remaining `language/eval-code/` failures.)
2. `scope-fidelity` — the #4238 §4 slice-3 residual families, keyed by path
   + error text: `new.target`/`super`-in-direct-eval (~10 files, #4194
   census), `var-env-*` (~13), strict-caller write-back, mapped-`arguments`
   severing, TDZ interleaving.
3. `membrane-residual` — the #4245 §5 list: proto-chain crossing /
   `instanceof`, descriptor fidelity + `defineProperty`-on-wrapper
   TypeError, Symbol-keyed access, `Array.isArray` on wrappers, outward
   trap-error flattening, tombstone TypeError. **The final
   pattern set is resolved-at-implementation-time from the #4245 slice-3
   record** (its measured residual list is the authoritative source; the
   plan cannot pre-write regexes for messages that don't exist yet).
4. `engine-difference` — QuickJS-vs-spec divergence not attributable to the
   bridge: error-message text mismatches asserted by tests, Annex B
   `Function` legacy behaviors, RegExp-in-eval differences.
5. `harness-infra` — link errors (`Import #… module="js2wasm:runtime-eval"`),
   artifact/instantiation failures, timeouts. **Any entry here means the
   measurement itself is broken — fix and re-run, never gate on it** (the
   #4162 lesson: an instrument artifact overwrites the real signature).
6. `unattributed` — remainder. The gate treats `unattributed` losses as
   BLOCKING (they are un-reviewed net-negatives by construction); they must
   be manually triaged into 2–4 (extending `RULES`) or accepted explicitly.

#### P1.4 The gate (mechanically checkable)

Compared quantity: `summary.net_vs_interpreter` on the measured set —
quickjs pass-count minus interpreter pass-count, same set, same runner,
same day. Invariants the `--gate` subcommand enforces:

1. `net_vs_interpreter ≥ 0`, **OR** every bucket with `net < 0` has a
   matching entry in the `accepted-residuals` JSON block in this issue file
   (schema below) whose `count_ceiling ≥ losses` for that bucket.
2. `buckets["harness-infra"].losses === 0` and
   `buckets["unattributed"].losses === 0` (or each unattributed file is
   individually listed in an accepted-residuals entry).
3. Full mode only: `outside_set_delta.count === 0` — the engine flip moves
   NOTHING outside the eval-dependent manifest. Non-zero = a link/perf
   regression class the flip may not carry.
4. `sanity.interpreter_vs_baseline_flips ≤ 10` (drift tolerance; more means
   run B is not a trustworthy interpreter reference — re-run).
5. Tier-announcement pins (see P1.2): `inputs.quickjs.tier_announcement`
   contains `QUICKJS`, `inputs.interpreter.tier_announcement` contains
   `INTERPRETER` and not `REFUSAL`. Absent announcements = BLOCKED (the
   run's tier is unproven — the refusal-tier fake-landslide hazard).

`accepted-residuals` block (added to this file only when needed, in the
same commit as the parity table):

```jsonc
// accepted-residuals (#4242) — parsed by eval-engine-parity.mjs --gate
[ { "bucket": "scope-fidelity", "count_ceiling": 13,
    "rationale": "var-env EvalDeclarationInstantiation approximation, #4238 §4 residual 2",
    "approved_by": "project-lead", "date": "…" } ]
```

**Sign-off**: the project lead (author of the no-removal directive) approves
each entry; the tech lead commits the block. The gate is evaluated in the
Phase-2 flip PR's description (paste the `--gate` output) and re-run by the
reviewer — it is a script, not a judgment call.

Record in this file: the markdown table, the gate verdict line, and the
exact three input jsonl provenance lines (run timestamps + baseline
`generatedAt`).

### Phase 2 — the flip

#### P2.1 Flip-site inventory (every place that changes, and every place that must NOT)

| file | function / site | change |
| --- | --- | --- |
| `scripts/runtime-eval-provider.mjs:611` | `selectCachedRuntimeEvalProvider` | `const engine = process.env.JS2WASM_EVAL_ENGINE ?? "quickjs";` — the ONE semantic flip. The unknown-value throw (`:612-616`) already lists both engines; keep verbatim. The interpreter branch body (`:627-659`) is untouched — `interpreter` remains first-class. |
| `scripts/quickjs-eval-provider.mjs:547-550` | `selectQuickjsEvalProvider` message | drop "flag-gated engine (#4238), NOT CI-comparable" — post-flip this IS the CI-comparable tier, and leaving the old wording would make the two engines' messages mutually contradictory (each disclaiming comparability with the other). New: `QUICKJS (artifact <sha12>, adapter key <key>) — DEFAULT engine (#4242); JS2WASM_EVAL_ENGINE=interpreter for the kept legacy engine; TEST262_FULL_RUNTIME_EVAL is ignored under this engine`. |
| `scripts/runtime-eval-provider.mjs:643-645` | interpreter tier message | append `— selected via JS2WASM_EVAL_ENGINE=interpreter (kept engine, #4242)` so provenance lines stay unambiguous post-flip. |
| `scripts/run-test262-vitest.sh:203-215` | prebuild hooks | hoist `EVAL_ENGINE="${JS2WASM_EVAL_ENGINE:-quickjs}"` once near `:19`; quickjs hook condition becomes `[ "$TEST262_TARGET" = standalone ] && [ "$EVAL_ENGINE" = quickjs ]`; the interpreter/refusal prebuild block (`:207-215`) becomes the `[ "$EVAL_ENGINE" = interpreter ]` arm — unchanged inside. Two default literals total (here + `:611`); the default-assertion test below pins them together. |
| `scripts/build-quickjs-eval-provider.mjs` | new `--require-cache` flag | mirror of `build-runtime-eval-provider.mjs:216`'s `--require-full-cache`: verify keyed artifact + adapter exist, never build. Used by CI shard cells (§P2.2). |
| `tests/quickjs-eval-provider.test.ts` | case 1 "default-untouched" | inverts: env deleted + `resetTest262RuntimeEvalProviderForTest()` ⇒ `selection.engine === "quickjs"` (artifact present) or the §5 hard error (absent) — assert ONE of exactly those two, never an interpreter selection. Add the twin: `JS2WASM_EVAL_ENGINE=interpreter` ⇒ `engine === "interpreter" \| "refusal"` and the exact kept-engine message (proves the branch is alive — feeds §P2.5). |
| `tests/issue-2929-cd-global-materialization.test.ts:27` | calls `selectCachedRuntimeEvalProvider` with ambient env | pin `JS2WASM_EVAL_ENGINE=interpreter` (set + save/restore in before/after, plus `resetTest262RuntimeEvalProviderForTest()`), it asserts interpreter-tier semantics. **Audit result (grep, 2026-08-09): the only other selection-calling test is `quickjs-eval-provider.test.ts` itself; `issue-2928-refusal-provider` / `issue-1102` / `issue-2960` / `issue-4197-consumer-mode-decl-getter` call `instantiateRuntimeEvalNamespace` on modules they build directly — default-flip-immune, no change.** Without this pin the flip PR's own `quality`/vitest gate goes red on machines without the artifact (selection throws) — this is the failure mode to catch locally before pushing. |
| `.github/workflows/test262-sharded.yml` | provider job + shard cells | §P2.2. |
| `scripts/validate-test262-baseline.ts` (+ its callers) | standalone sample validation | post-flip a sampled standalone eval test selects quickjs ⇒ hard error without the artifact. Add a prebuild step to the validator's standalone path (`node scripts/build-quickjs-eval-provider.mjs`, cache-hit ≈ instant) — no fallback-to-interpreter, same rationale as everywhere. |
| `docs/architecture/runtime-eval-interpreter.md` | new "Two engines" section | default = quickjs, `JS2WASM_EVAL_ENGINE=interpreter` contract, the no-removal directive quoted, pointer to the parity table here. |
| `CLAUDE.md` test262 notes | eval-bucket counts | only if they shift; goes in the standing docs PR, not the flip PR. |
| `plan/issues/4229-…` (playground REPL, backlog) | consumer note | it plans to ship the **interpreter** provider as a static asset — add a note that post-flip it must pick its engine EXPLICITLY (either is legitimate; interpreter is smaller to ship, quickjs is the default story). No code exists yet; nothing else to change. |
| **NOT changed** | `scripts/test262-import-object.mjs`, `src/**` (all of it — compiler, `src/interp/`, `src/ir/`), the 4-import seam, `build-runtime-eval-provider.mjs`, cache-key functions, `qjs_shim.c` | the flip is selection-layer only. Any `src/` diff in the flip PR is a review REJECT. |

#### P2.2 CI artifact wiring (#4013 pattern; land BEFORE the flip, default-neutral)

Extend the `runtime-eval-provider` job (`test262-sharded.yml:551-598`) —
do not add a parallel job, the cascade-skip plumbing (`:887-898`) is
already wired to this one:

1. **`eval_engine` workflow input/env** — a `workflow_dispatch` input
   (default: empty = repo default) exported as `JS2WASM_EVAL_ENGINE` to the
   provider job and both standalone shard matrices (`:752-754` env block and
   the mg twin at `:926`). Pre-flip this gives Phase 1 its Tier-B run;
   post-flip `eval_engine=interpreter` is the full-matrix escape hatch.
2. **Provider job builds the pair for the ACTIVE engine**: quickjs ⇒
   `actions/cache` on the **artifact dir only**, keyed
   `quickjs-wasi-${{ hash }}` where hash = the same content key the
   existing `quickjs-wasi-artifact.yml:56-79` computes (pinned quickjs-ng
   sha ∥ wasi-libc ref ∥ builtins url ∥ OPT ∥ `qjs_shim.c` ∥ `build.sh` —
   this is `quickjsArtifactCacheKey()`'s input set; keep the two in
   lockstep by hashing the same files), then
   `node scripts/build-quickjs-eval-provider.mjs` (artifact cache hit ⇒
   adapter compile only; miss ⇒ ~50 s clang build, lead-measured
   2026-08-09 — the job's 12-min timeout holds comfortably), upload
   `.test262-cache/quickjs-artifact-*/` + `quickjs-eval-adapter-*.wasm` as
   the run artifact. Interpreter ⇒ the existing steps (`:582-588`)
   unchanged. **Do NOT `actions/cache` the adapter across commits**: the
   adapter key deliberately folds the compiler-bundle hash
   (`runtimeEvalProviderCacheKey`, same discipline as the interpreter
   provider), so any compiler change invalidates it — that is correct
   behavior, and a per-run adapter compile against the cached artifact is
   the cheap path. A cross-commit adapter cache would either thrash (keyed
   on bundle hash, misses every merge) or serve stale adapters (keyed on
   anything else). Reference warm keys at spec time: artifact
   `0c848fd169d84e0f`, adapter `24b25990cf116fd5`.
3. **Shard cells**: download the artifact into `.test262-cache`, then the
   verify step runs `node scripts/build-quickjs-eval-provider.mjs
   --require-cache` (quickjs) or the existing
   `build-runtime-eval-provider.mjs --require-full-cache` (interpreter) —
   both mirrored at `:789-802` and `:955-964`. `TEST262_FULL_RUNTIME_EVAL`
   stays set on standalone cells (harmless under quickjs — explicitly
   ignored; load-bearing under the interpreter escape hatch).
4. **Offline/cache-miss on the default path is a HARD, ACCURATE error** —
   already true at every layer (selector `quickjs-eval-provider.mjs:518-535`,
   prebuild `build-quickjs-eval-provider.mjs:119-125`, run-script hook).
   The flip PR's job is to not regress this: NO code path may fall back to
   the interpreter on a quickjs acquisition failure, because the resulting
   conformance numbers would be interpreter numbers labeled quickjs.

**Default-path stale-bundle trap (diagnosed 2026-08-09, encode it):**
`build-quickjs-eval-provider.mjs:59-72` (`loadCompile`) prefers a prebuilt
`scripts/compiler-bundle.mjs` over `src/`, and a STALE bundle compiles an
adapter whose externs land in `env`, failing `verifyQuickjsProvider` with
`env::store8 — an extern leaked outside the provider namespace`
(`:150-159`) — which reads as an adapter bug, not a bundle-freshness bug.
`run-test262-vitest.sh` is safe (it rebuilds the bundle at `:173-174`
before the hook), but direct invocations and future CI steps are exposed.
#4238 slice 2 is adding the first robustness fix; the Phase-2 requirement
(regardless of that fix's final shape) is: **on the default path, adapter
acquisition must either establish bundle freshness before compiling or,
at minimum, wrap the extern-leak verify failure with the probable cause
and the remedy** (`compiler bundle may be stale — pnpm run
build:compiler-bundle, or run under tsx`). Acceptance: a deliberately
staled bundle produces an error naming the bundle, verified by a unit test
in the flip PR.

#### P2.3 Re-baselining (compare like-with-like — #1528/#3467 discipline)

Scope of movement: **standalone lane only.** The host/gc lane never links
the provider (`test262-import-object.mjs:105-113`), so
`test262-current.jsonl` and the landing-page badge are untouched by the
flip; only `test262-standalone-current.jsonl` moves.

Sequence for the flip PR:

1. The PR enters the merge queue; the `merge_group` standalone matrix runs
   under the NEW default (quickjs) and the #1897 floor gate diffs against
   the interpreter-era `test262-standalone-current.jsonl`
   (`test262-sharded.yml:1314-1404`, tolerance 15 at `:1345`). Eval-bucket
   deltas WILL appear.
2. If Phase 1's verdict was net ≥ 0 with reshuffling ≤ tolerance: nothing
   to do — the gate passes, `promote-baseline` refreshes the standalone
   baseline on the merge-to-main push, and the floor holds at the new
   (higher) level.
3. If accepted residuals put any diff over tolerance: declare them via the
   **named `regressions-allow` mechanism** (#3303/#3649,
   `diff-test262.ts:267-349` — declared count + named test list, machine-
   checked against the actual diff). The list comes verbatim from the
   parity artifact's accepted buckets — no hand-curation.
4. High-water check (`scripts/check-standalone-highwater.mjs`, #2097, keys
   on `host_free_pass`): net ≥ 0 ⇒ untouched or rises. Only if the lead
   accepted a small net-negative may `--update` be used, in the flip PR,
   citing this issue — never silently.
5. Post-merge: verify the promoted baseline reflects the quickjs run
   (`node scripts/fetch-baseline-jsonl.mjs --standalone --force`, then
   spot-check 2–3 accepted-residual files show their new status).

**Do NOT split the flip across multiple queue entries**: default change +
test pins + CI verify steps must be ONE PR, or an intermediate main has a
default engine its own CI cannot supply artifacts for.

#### P2.4 Interpreter lane (the kept engine must not rot)

New `.github/workflows/eval-interpreter-lane.yml` — weekly cron +
`workflow_dispatch`, **non-required** (not in the six-check ruleset,
`docs/ci-policy.md` §7; and since it does not run on `pull_request` it
cannot drive any PR to `UNSTABLE`). One job, ~30-min timeout:

1. checkout (submodules) + setup-node-pnpm + `pnpm install`.
2. `pnpm run build:compiler-bundle` +
   `node scripts/build-runtime-eval-provider.mjs` (full interpreter).
3. Unit tier: `JS2WASM_EVAL_ENGINE=interpreter npx vitest run
   tests/issue-2928-refusal-provider.test.ts tests/issue-2929-cd-global-materialization.test.ts
   tests/issue-2960.test.ts tests/issue-1102.test.ts
   tests/issue-4197-consumer-mode-decl-getter.test.ts`.
4. Conformance tier: the #2928 remeasurement template —
   `JS2WASM_EVAL_ENGINE=interpreter TEST262_FULL_RUNTIME_EVAL=1
   TEST262_TARGET=standalone TEST262_PATH_FILTER='language/eval-code/'
   pnpm run test:262 -- --official-scope-only`, then assert
   `report.summary.pass ≥ floor − 3` against a committed
   `benchmarks/results/eval-interpreter-lane-floor.json`
   (`{ "pass": 797, "total": 816, "recorded": "<date>", "issue": 4242 }`;
   tolerance 3 absorbs known flake classes without hiding a real rot). On
   breach: red run + the workflow opens nothing — the tech lead's loop or
   the shepherd files the `[CI-FIX]`; this is deliberate (a weekly
   non-required lane must not auto-file issues).

The acceptance criterion "interpreter still passes its own lane after the
flip" is discharged by a green `workflow_dispatch` of this lane on the
flip PR's merged sha, linked in this file.

#### P2.5 No-removal audit (the directive, machine-checked)

The flip PR must include and pass ALL of:

1. **Diff-level**: `git diff --name-only --diff-filter=D origin/main...HEAD`
   contains nothing under `src/interp/`, `src/ir/`, and does not remove
   `acorn` from `package.json`/lockfile. Also
   `git diff --stat origin/main...HEAD -- src/` is **empty** (the flip is
   selection-layer only, per §P2.1's NOT-changed row). Run manually,
   paste output into the PR description.
2. **New `tests/issue-4242-no-removal.test.ts`** (perpetual, runs in the
   default vitest suite): (a) `src/interp/` exists and its entry modules
   resolve (import the module list from a small manifest, e.g.
   `eval-environment.ts` + the interpreter core — enumerate at
   implementation from `src/interp/` contents); (b) `require.resolve("acorn")`
   succeeds; (c) with `JS2WASM_EVAL_ENGINE=interpreter` (+ reset), selection
   returns `engine ∈ {interpreter, refusal, none-with-interpreter-message}`
   and NEVER the quickjs branch — proving the kept branch is reachable, not
   just present; (d) with an unknown engine value the selection throw still
   names BOTH engines.
3. **Behavioral**: the interpreter-lane workflow green on the flip sha
   (§P2.4), recorded here.

### Slice order (one implementer per slice, with done-signals)

**Phase 1**

- **P1-S1 — parity tooling (M).** `scripts/eval-engine-parity.mjs`
  (manifest + three-way diff + buckets + gate), the `loadResults` export
  from `diff-test262.ts` if needed, `tests/eval-engine-parity.test.ts` with
  synthetic 10-line jsonls covering every rule + all four gate invariants
  (incl. a BLOCKED verdict). *Done-signal:* synthetic-input test green;
  script produces schema-valid JSON + markdown from two real (tiny,
  path-filtered smoke) runs.
- **P1-S2 — CI `eval_engine` plumbing (M, default-neutral, lands before
  any measurement is trusted).* §P2.2 items 1–3 with the dispatch input
  defaulting to the CURRENT default (interpreter until the flip PR).
  *Done-signal:* a `workflow_dispatch` with `eval_engine=quickjs` runs the
  standalone matrix green-or-analyzably (shards execute; provider job
  builds+distributes the quickjs pair); a plain push run is byte-identical
  to today.
- **P1-S3 — the measurement (M).** Runs A/B/C (+ Tier B via the S2
  dispatch), parity artifact, bucket triage until `unattributed = 0`,
  paste table + verdict + provenance into this file; if needed, the
  `accepted-residuals` block with project-lead approval. *Done-signal:*
  `## Parity Measurement (Phase 1)` section committed here with a
  `--gate` verdict of PROCEED (or an explicit BLOCKED + follow-up issues
  routed to #4238/#4245 — Phase 2 does not start).

**Phase 2** (only after P1-S3's PROCEED)

- **P2-S1 — the flip (L).** Everything in §P2.1 + the CI verify-step
  switch (§P2.2 item 3's quickjs arm becomes the default arm) + the
  no-removal test (§P2.5.2) + the stale-bundle error-accuracy test
  (§P2.2 trap) + the `regressions-allow` declaration if Phase 1 accepted
  residuals. ONE PR through the queue. *Done-signal:* merged with the
  standalone floor gate satisfied; post-merge baseline spot-check (§P2.3.5)
  recorded here; `git diff --stat …merged-sha -- src/` empty, pasted in
  the PR.
- **P2-S2 — interpreter anti-rot lane + docs (S/M).**
  `eval-interpreter-lane.yml` + floor file + the
  `runtime-eval-interpreter.md` two-engine section + the #4229 consumer
  note. *Done-signal:* dispatch run green on post-flip main, linked here;
  acceptance box "interpreter still passes after the flip" checked.

### Risks / conflicts

- **#4238 slice-2/3 and #4245 branches touch `scripts/runtime-eval-provider.mjs`,
  `scripts/quickjs-eval-provider.mjs`, `scripts/build-quickjs-eval-provider.mjs`
  and `run-test262-vitest.sh`** — every Phase-1/2 slice must
  predecessor-stack on whichever of those is in flight (branch from the
  live branch, enqueue after it lands) rather than racing it on main.
- **Do not soften the hard-error discipline while "fixing" CI ergonomics.**
  Three separate layers intentionally hard-fail on a missing quickjs
  artifact; a helpful-looking `catch → interpreter` in any of them makes
  post-flip conformance numbers lie. Reviewer checklist item.
- **The scoped set underweights instantiation overhead.** Per-test fresh
  instantiation of the 2-module quickjs bundle is a timeout-class risk that
  only the Tier-B full run exposes — do not skip Tier B to save an hour.
- **`tests/issue-2929-cd-global-materialization.test.ts` is the known
  unpinned selection caller**; if new selection callers land between now
  and the flip, re-run the §P2.1 grep
  (`grep -rln selectCachedRuntimeEvalProvider tests/ scripts/`) in the flip
  PR and pin any new interpreter-semantics test the same way.
- **Baseline freshness**: every diff against run C must state the
  baseline's `generatedAt`/fetch age (the #3629 stderr report) in the
  recorded provenance — a stale standalone baseline resurrects the
  5,386-test-gap failure mode inside this issue's numbers.

### Out of scope (explicit, reinforcing the directive)

- Deleting or degrading ANYTHING: `src/interp/`, acorn, the IR/codegen
  substrate the interpreter uses, `build-runtime-eval-provider.mjs`, the
  refusal tier, `TEST262_FULL_RUNTIME_EVAL` semantics under the
  interpreter engine. Retirement is a separate future project-lead
  decision; this issue's PRs must be revertible to interpreter-default by
  flipping the one constant back.
- Membrane internals, interpreter fixes, quickjs-ng version bumps, the
  `--evalEngine` CLI surface (still reserved for the #2527 packaging CLI),
  host/gc-lane eval behavior.
