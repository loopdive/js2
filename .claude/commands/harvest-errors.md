# Harvest Test262 Errors

Analyze the latest test262 run results, cross-reference with existing issues, and create new issues for unaddressed error patterns.

## Data source — the `loopdive/js2wasm-baselines` repo (authoritative)

**Always harvest the full detailed run results published in
[`loopdive/js2wasm-baselines`](https://github.com/loopdive/js2wasm-baselines),
not any copy committed into the main repo.** CI (`promote-baseline` in
`test262-sharded.yml`) pushes the complete per-test results there on every merge
to `main`. The main repo no longer carries the JSONL blob (#1528); any local
`benchmarks/results/*.jsonl` is a trimmed, possibly-stale mirror — using it
under-reports the real pass rate (it read 61.5% on 2026-06-03 when the baselines
repo had 70.7%). Fetch fresh every run.

Baselines-repo file set (root of the repo, branch `main`):

| | Default (JS-host) lane | Standalone lane |
|---|---|---|
| Full results (one JSON/test) | `test262-current.jsonl` (~36 MB) | `test262-standalone-current.jsonl` (~53 MB) |
| Latest raw run | `test262-results.jsonl` | `test262-standalone-results.jsonl` |
| Summary counts | `test262-current.json` | `test262-standalone-current.json` |
| Report rollup | `test262-report.json` | `test262-standalone-report.json` |
| Trend history | `runs/index.json` (shared) | |

There are **two independent test262 lanes** — harvest each separately and never
mix their counts (they are distinct conformance metrics on different targets):

| Lane | Target flags | Goal tag |
|------|--------------|----------|
| **Default (JS-host)** | `gc` target, host imports allowed | (default) |
| **Standalone** | `--target standalone` `--no-host-imports`, `nativeStrings` | `goal: standalone-mode` |

The standalone lane measures pure-Wasm conformance (no JS runtime). Its failures
are dominated by **host-import leaks** — features that silently fall back to a JS
host import in the default lane but are *refused* in standalone mode. The
standalone lane's dominant signal is the `#NNNN` citation embedded in each
refusal's error string (see step 2). NOTE (verified 2026-08-01): the
`host_import_leak_class` field appears in BOTH lanes and is actually far more
common on the DEFAULT lane (41,276 records, single value
`dynamic_object_property`) than on standalone (2,679 records, four values) — an
earlier revision of this doc claimed the reverse. Do not use that field to tell
the lanes apart.

## Steps

Run the lane-agnostic steps (1–7) once per lane, against that lane's JSONL +
categories file, then emit the two summary tables (step 8).

1. Fetch the latest detailed results JSONL for the lane **from the baselines
   repo** (do not trust local committed copies — see "Data source" above):
   - **Default lane** — use the existing helper, which downloads + caches to
     `.test262-cache/test262-current.jsonl` (gitignored). Use `--force` alone
     (it prints the resolved path after downloading); **do not** add
     `--print-path`, which short-circuits and exits *before* downloading:
     ```bash
     node scripts/fetch-baseline-jsonl.mjs --force   # prints cache path when done
     ```
   - **Standalone lane** — fetch directly from the baselines repo (the helper
     only covers the default lane):
     ```bash
     curl -fsSL https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-standalone-current.jsonl \
       -o .test262-cache/test262-standalone-current.jsonl
     ```
     (or `gh api repos/loopdive/js2wasm-baselines/contents/test262-standalone-current.jsonl`
     if unauthenticated raw access is rate-limited).
   - Cross-check freshness against `runs/index.json` in the baselines repo (the
     last entry's timestamp) so you know the data isn't a stale promotion.
   - To **regenerate** a lane locally instead of fetching (slow; only when you
     need uncommitted compiler changes reflected):
     - Default: `bash scripts/run-test262-vitest.sh`
     - Standalone: `TEST262_TARGET=standalone bash scripts/run-test262-vitest.sh`
   - Build the categories rollup from the fetched JSONL if you want the
     bucketed report:
     - Default: `node scripts/build-test262-report.mjs`
     - Standalone: `node scripts/build-test262-report.mjs --target standalone`
       (writes `test262-standalone-categories.json`).

2. Parse all results and categorize errors:
   - **Extract embedded `#NNNN` issue citations from EVERY failing record's
     `error`, in BOTH lanes** (dedupe per record, rank by record count). Our
     codegen self-cites the tracking issue in many error strings — even
     regressions name the culprit (e.g. `… shift walker missed this entry
     (#1525b regression)`). This is the single highest-signal cross-reference
     and must run first. (Doing this only for standalone missed a 157-test
     default-lane crash on 2026-06-03 — run it for both.)
   - **Always sub-bucket the `other` / uncategorized error_category — do NOT
     skip it.** "other" is where genuinely new patterns hide (it held the
     157-test `pendingMethodTrampolines … shift walker missed this` codegen
     crash that the named-category pass skipped). Sub-bucket it by normalized
     error signature exactly like the named categories.
   - **Inspect `negative_test_fail`** (tests that should throw an early/parse
     error but compiled+ran, or vice-versa) — these are real conformance bugs,
     not noise (e.g. import-attributes duplicate-key early-error not enforced).
   - **Compile errors**: group by pattern (undefined .kind, stack underflow, local.set mismatch, struct error, call mismatch, missing import, stack fallthrough, unsupported, missing property, yield outside gen, await outside async, etc.)
   - **Runtime failures**: group by pattern (returned wrong with assert info, null pointer deref, timeout, illegal cast, array OOB, unreachable, uncaught exception)
   - Note: non-official proposal tests (e.g. `built-ins/Temporal/*`, marked
     `official: false` in the runner) still appear as `fail`/`other` in the raw
     JSONL (`Temporal is not defined`, ~2k records) but do NOT count against the
     official total — don't file issues for them; they are excluded by design.
   - **Standalone lane — PRIMARY signal is the `#NNNN` issue number embedded in
     the error string.** Standalone codegen refusals self-cite their tracking
     issue, e.g. `Codegen error: Proxy not supported in standalone mode
     (#1472 Phase…)`. Extract every `#\d{3,4}` from each failing record's
     `error` (dedupe per record) and rank issues by record count — this is the
     most accurate standalone cross-reference and needs no guessing. Typical
     ranking (verify live — it MOVES): on 2026-08-01 the top citations were
     **#2961** (2,125 — the strict leak-guard naming the leaked imports),
     #2928 (558, dynamic eval), #680 (320, native generators), #1472 (155,
     Proxy), #1474 (99, RegExp). An earlier revision predicted "#1472 by far
     the largest (~27k)"; that was stale by two orders of magnitude — most
     Proxy-harness cascades had been retired. Treat any ranking written here
     as a hypothesis to re-verify, never as the expected answer.
   - **Secondary: `host_import_leak_class`** (only ~10–15k records carry it;
     many refusals don't). Actual field values today (verify — they evolve):
     `host_import` (generic #1524 gate, catch-all), `dynamic_object_property`,
     `iterator_protocol` (#1471 family), `regexp` (#1474), `dynamic_code`
     (deferred). **Do NOT lead with this** — it has no `proxy` value, so leading
     on leak_class silently drops #1472, the #1 standalone blocker (learned the
     hard way 2026-06-03).
   - The remaining standalone `compile_error`s surface as `wasm_compile`
     ("invalid Wasm binary") — standalone codegen emitting invalid Wasm for
     constructs the host lane routes through an import. Sub-bucket by signature.
   - For each pattern, count occurrences and collect 3 sample file paths

3. Cross-reference with existing issues:
   - Read issue files in `plan/issues/`
   - Match error patterns to existing issue titles/descriptions
   - **Standalone lane**: the embedded `#NNNN` citations from step 2 ARE the
     cross-reference — each refusal names its tracking issue directly. Confirm
     each cited issue's status in `plan/issues/`; standalone issues carry
     `goal: standalone-mode` under umbrella **#1781**. Use `host_import_leak_class`
     only for the residual records that carry no citation.
   - Mark each pattern as: ADDRESSED (`status: done`), IN PROGRESS (`status: ready` / `in-progress` / `in-review`), or NEW

4. For NEW patterns with >50 occurrences:
   - Create issue files in `plan/issues/` with next available number
   - Include: priority (based on count), sample files, root cause analysis, suggested fix
   - **Standalone-lane issues**: set `goal: standalone-mode` and link the umbrella
     #1781 in `related:`.
   - Update `plan/issues/backlog/backlog.md`

5. For ADDRESSED patterns where count INCREASED vs the issue's original count:
   - Flag as potential regression
   - Add a note to the issue file

6. (per lane) Collect the lane's pattern/count/status rows for the summary.

7. Repeat steps 1–6 for the other lane.

8. Output **two separate** summary tables — never sum across lanes:

   **Default (JS-host) lane:**
   ```
   Pattern | Count | Status | Issue #
   --------|-------|--------|--------
   null deref | 2,560 | #663 done | regression?
   assert.throws | 4,738 | #695 open | tracked
   ...
   ```

   **Standalone lane** (lead with embedded `#NNNN` citation counts):
   ```
   Cited issue | Records | Status | Feature
   ------------|---------|--------|--------
   #1472 | 26,923 | ready | Proxy not supported (standalone)
   #1474 |  1,793 | ready | RegExp not supported (standalone)
   #682  |  1,614 | done  | dual RegExp backend
   #1387 |    283 | ready | with-statement
   ...
   ```

9. Commit all new/updated issue files with a descriptive message.

Always check `free -h` before running to ensure enough memory. Never delete test data.
