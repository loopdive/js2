---
id: 4785
title: "ES2015 standalone WeakMap/WeakSet reject primitive insertion keys"
status: in-progress
sprint: current
created: 2026-08-27
updated: 2026-08-27
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: conformance
area: codegen
language_feature: WeakMap/WeakSet CanBeHeldWeakly
es_edition: es6
goal: standalone-mode
assignee: "ttraenkler/codex-es2015-next-bounded-fix-6"
related: [3395, 864]
files:
  - src/codegen/weak-collections-runtime.ts
  - tests/issue-4785-weak-collection-primitive-keys.test.ts
  - plan/issues/4785-es2015-weak-collection-primitive-keys.md
loc-budget-allow:
  - src/codegen/weak-collections-runtime.ts
---

# #4785 — ES2015 standalone WeakMap/WeakSet reject primitive insertion keys

## Problem

The standalone native lowering for `WeakMap.prototype.set` and
`WeakSet.prototype.add` currently forwards every key/value to the map-backed
runtime. ECMAScript requires these insertion operations to throw `TypeError`
when the key/value cannot be held weakly. The host lane already enforces this
contract, but standalone silently accepts primitive literals and the two
maintained ES2015 rows below fail.

This is a two-row behavior cohort. It does not change the existing
`get`/`has`/`delete` behavior for primitive probes (which return an absent
result), and it must preserve valid object keys, unregistered `Symbol()` keys,
and host-mode lowering.

## Exact cohort and fresh baseline (2026-08-27)

The maintained Test262 checkout and current standalone snapshot were measured
from `upstream/main` at `84e86be2afb511fc8547cf2012abf4bbaa7200a2`, after the
merged #5056 class-descriptor fix. The exact cohort is:

- `test/built-ins/WeakMap/prototype/set/throw-if-key-cannot-be-held-weakly.js`
- `test/built-ins/WeakSet/prototype/add/throw-when-value-cannot-be-held-weakly.js`

Fresh authoritative runs used `--official-scope-only`, QuickJS standalone
evaluation, `COMPILER_POOL_SIZE=2`, and the repository runner. The host lane
measured **2/2 pass, 0 fail, 0 compile errors, 0 compile timeouts, 0 skips**.
The standalone lane measured **0/2 pass, 2 fail, 0 compile errors,
0 compile timeouts, 0 skips**; both failures had the same signature:
`Expected a TypeError to be thrown but no exception was thrown at all`.

The baseline reports and raw rows are:

- host: `benchmarks/results/test262-report-20260827-192328.json`,
  `benchmarks/results/test262-results-20260827-192328.jsonl`
- standalone: `benchmarks/results/test262-standalone-report-20260827-192459.json`,
  `benchmarks/results/test262-standalone-results-20260827-192459.jsonl`

The eight-row baseline control slice also included object-key and
unregistered-symbol insertion plus primitive `has` probes. Those six controls
passed in standalone and all eight passed in the host lane.

## Implementation plan

1. Add a narrow standalone-only guard to the native `WeakMap.prototype.set`
   and `WeakSet.prototype.add` lowering. Reject missing arguments, nullish,
   boolean, numeric, string, bigint, and `Symbol.for(...)` expressions that
   are statically known not to be weakly held, by emitting the existing
   catchable native `TypeError` path.
2. Keep `get`, `has`, and `delete` primitive probes unchanged; retain plain
   `Symbol()` support because unregistered symbols are valid weak keys in the
   current Test262 semantics. Leave host lowering and map-backed storage
   untouched for valid object/symbol keys.
3. Add focused compiler coverage for both rejection operations, valid object
   and plain-symbol controls, primitive probe behavior, and host/standalone
   parity. Run the exact two-row cohort in both lanes after the change.
4. Run focused tests, typecheck, lint/format checks, and the repository
   pre-push checks. Record exact counts, artifacts, residuals, commit SHAs,
   and the PR handoff here.

## Acceptance

- Both exact rows pass in host and standalone after the change.
- Standalone reports zero failures, compile errors, compile timeouts, and
  skips for the cohort and its controls, with no host imports.
- Valid object and unregistered-symbol insertion still succeeds, and
  primitive `get`/`has`/`delete` probes retain their absent-result semantics.
- The TypeError is catchable and does not regress host mode or unrelated weak
  collection methods.
- One upstream PR is opened from `ttraenkler/js2` with the repository's
  Description/CLA body. It becomes ready only after it is clean, mergeable,
  and CI-green; otherwise it remains draft with `hold` and no queue entry.

## Non-goals and handoff boundaries

This issue does not own WeakMap/WeakSet constructor iterable semantics,
receiver-brand checks, prototype metadata, the newer `getOrInsert*` proposal
methods, or garbage-collection/externref boxing. Those remain with their
existing issues. Dynamic aliases whose key type cannot be proven at compile
time are also outside this compact cohort and require a separate runtime type
guard issue if they remain after this fix.

## Implementation

`src/codegen/weak-collections-runtime.ts` now classifies only statically known
invalid insertion expressions after compiling them: missing arguments,
nullish/boolean/numeric/string/bigint literals, and the global `Symbol.for`
call shape. It drops the evaluated key/value operands and emits the existing
standalone/WASI native `TypeError` constructor, preserving argument evaluation
order. The guard is not enabled for JS-host lowering. Dynamic aliases and
plain `Symbol()` remain on the existing map-backed path, so the compact fix
does not change valid-symbol storage or primitive lookup behavior.

## Post-fix evidence (2026-08-27)

The exact eight-row A/B slice was rerun with `--official-scope-only`,
QuickJS standalone evaluation, and `COMPILER_POOL_SIZE=2`:

- host: **8/8 pass, 0 fail, 0 compile errors, 0 compile timeouts, 0 skips**
- standalone: **8/8 pass, 0 fail, 0 compile errors, 0 compile timeouts, 0 skips**

The slice contains the two target rows plus six controls (object and
unregistered-symbol insertion and primitive `has` probes). The standalone
rows report no `env::*` host imports. Raw artifacts are:

- host report/results: `benchmarks/results/test262-report-20260827-193643.json`,
  `benchmarks/results/test262-results-20260827-193643.jsonl`
- standalone report/results: `benchmarks/results/test262-standalone-report-20260827-193835.json`,
  `benchmarks/results/test262-standalone-results-20260827-193835.jsonl`

The focused Vitest regression `tests/issue-4785-weak-collection-primitive-keys.test.ts`
reports **16/16 passed** with at most two compiler workers. Prettier checks,
TypeScript 7 typecheck, and `git diff --check` pass. The final implementation
commit and upstream PR handoff remain to be recorded after the repository
push gates complete.

## Current-main verification (2026-08-27)

After the implementation checkpoint, the branch was synchronized with
`upstream/main` at `4d1001a8cf9dc8f0fd0cbd83385d82e3e3110141` through merge
commit `2226ffd28`. The exact eight-row A/B slice was then rerun from that
current-main merge with the same `--official-scope-only`, QuickJS standalone,
and `COMPILER_POOL_SIZE=2` settings:

- host: **8/8 pass, 0 fail, 0 compile errors, 0 compile timeouts, 0 skips**;
  all eight rows are expected host-import passes
- standalone: **8/8 pass, 0 fail, 0 compile errors, 0 compile timeouts, 0
  skips**; all eight rows are host-import-free
- the two target rows and six controls therefore show zero losses after the
  current-main synchronization

Current-main artifacts:

- host report/results: `benchmarks/results/test262-report-20260827-200143.json`,
  `benchmarks/results/test262-results-20260827-200143.jsonl`
- standalone report/results: `benchmarks/results/test262-standalone-report-20260827-200340.json`,
  `benchmarks/results/test262-standalone-results-20260827-200340.jsonl`

The focused Vitest regression remains **16/16 passed** after the merge. The
scoped Biome lint, Prettier, TypeScript, diff, oracle-ratchet,
coercion-site-ratchet, numeric-local IR parity, and issue-integrity checks are
the repository gates for the pushed checkpoint. PR #5077 remains draft with
`hold` until its final pushed head is current-main, mergeable, and CI-green;
the queue entry is intentionally null until then.

## Final current-main verification (2026-08-27)

Upstream advanced again after the preceding verification. This branch now
includes `upstream/main` at `db872cf39ffcda8775fa11b0385c896337ab611e`
through non-rewriting merge commit `228f028fb`. From that merge, the exact
eight-row A/B slice and focused regression were rerun with at most two
workers:

- host: **8/8 pass, 0 fail, 0 compile errors, 0 compile timeouts, 0 skips**
- standalone: **8/8 pass, 0 fail, 0 compile errors, 0 compile timeouts, 0
  skips**, with **0 host-import rows**
- focused Vitest: **16/16 passed**, including both target rows and all six
  object/symbol/probe controls in both lanes

Final current-main artifacts:

- host report/results: `benchmarks/results/test262-report-20260827-204836.json`,
  `benchmarks/results/test262-results-20260827-204836.jsonl`
- standalone report/results: `benchmarks/results/test262-standalone-report-20260827-205557.json`,
  `benchmarks/results/test262-standalone-results-20260827-205557.jsonl`

The prior CI quality failure was solely the stale issue-ID collision between
this branch's original #4782 plan and open PR #5076. Atomic allocation moved
this cohort to #4785; the local `--against-open-prs` gate passes with no
collisions. The final pushed checkpoint is now ready for a fresh CI run;
leave PR #5077 draft+`hold` with no queue entry until that run is green and
GitHub reports current, mergeable, and thread-clean.
