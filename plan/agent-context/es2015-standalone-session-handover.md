# Handover — 100% ES2015 standalone test262 session (2026-08-28/29)

Goal: 100% ES2015 test262 pass rate in standalone mode. Start of session:
8,757 / 11,704 ES2015-bucket official tests passing standalone (74.8%),
2,947 failing. Method: per-bucket plan/implement split — Fable planning agents
re-verified failures on head and filed one issue per work package with a full
`## Implementation Plan`; Opus (medium effort) implementers worked each plan in
an isolated worktree; this lane integrated, validated (equivalence gate,
loc/func/coercion/oracle/dead-export ratchets, per-bucket probe re-runs), and
landed batches through the merge queue.

## Landed on main (5 merged PRs)

| PR | packages | measured wins |
|----|----------|---------------|
| [#5173](https://github.com/loopdive/js2/pull/5173) | class #5139, proxy #5140, lang-semantics #5154 | +152 (incl. root-cause fix of the #5060 standalone generator-resume trap: V8 12.4 runs a result-typed `try_table` as `unreachable`) |
| [#5175](https://github.com/loopdive/js2/pull/5175) | function/error builtins #5156, modules-eval-with #5157, misc-statements #5158 | +66 |
| [#5179](https://github.com/loopdive/js2/pull/5179) | regexp #5142, promise #5143, generators #5141, typedarray #5138 | +51 |
| [#5191](https://github.com/loopdive/js2/pull/5191) | for-of #5144, array #5145, object-builtins #5148 | +119 |
| [#5203](https://github.com/loopdive/js2/pull/5203) | assignment #5146, iterators #5147 | +62 |

≈ +450 ES2015-standalone tests on main, plus cross-edition spillover
(ES5/ES2018+ share the fixed machinery). All 20 plan-file issues
(5138–5154, 5156–5158) are on main with full implementation plans, cluster
tables (file:function root causes), and per-package acceptance criteria.

## In flight

- **PR [#5213](https://github.com/loopdive/js2/pull/5213)** — "batch 6": second
  implementation passes over class/proxy/typedarray/regexp/generators/promise
  (same plans, fresh Opus pass on a base containing the first-pass fixes) plus
  the DBG-print removal and an origin/main merge. Validated locally: typecheck
  0 errors, all five ratchet gates green, equivalence gate green (1705 pass /
  24 known baseline failures), class spot-check 40/40. Currently `hold`-parked
  by the auto-park bot — see "Merge-queue situation" below before touching it.
- **Draft PR [#5224](https://github.com/loopdive/js2/pull/5224)** — buffers
  #5150 WIP, interrupted mid-implementation, UNVALIDATED. Plan in the issue
  file; finish or trim before review.
- **Draft PR [#5225](https://github.com/loopdive/js2/pull/5225)** — for-of
  second pass on a stale base; do NOT merge — mine its follow-up clusters onto
  a fresh branch instead.
- **Never started**: object-literal #5149, collections #5151, string #5152,
  super #5153 (plans are complete and on main; no implementation exists).

## Merge-queue situation (read before re-enqueueing anything)

Since ~02:26Z on 2026-08-29 most full merge-group runs fail the test262
re-validation with LARGE regression clusters (hundreds of tests), different
bucket signatures on consecutive runs, on unrelated PRs (selfhost #5204, IR
#5199/#5211, runner-classification #5209, and both of this session's late
PRs). The gate's own output warns the js2wasm-baselines JSONL is ~9
test262-relevant commits stale. Local re-runs of the exact flagged tests on
the merged content pass (e.g. the 99-test `async-generator/dstr`
host-import-leak cluster: 178/186 pass, 0 leaks locally; 5 of 6 sampled
host-lane "regressions" pass locally). Determination: predominantly baseline
drift + shard-level artifacts, not per-PR regressions — but each parked PR
still needs its own one-shot determination per the steward auto-park rules.

One REAL reproducible regression found and not yet fixed:
`built-ins/String/prototype/match/cstm-matcher-on-boolean-primitive.js` —
the sloppy variant now genuinely installs a non-configurable accessor on the
shared host `Boolean.prototype` (previously the compiled `defineProperty` was
silently dropped), so the in-process strict rerun throws "Cannot redefine
property: Symbol(Symbol.match)". `tests/test262-restore-builtins.ts` cannot
delete a non-configurable added key (worker lane recycles the fork for this
class). Worth its own small issue: either fork-recycle-equivalent isolation
for the in-process strict rerun, or accept as a known shared-realm-lane
limitation.

## Measurement state

- `.tmp/es2015/` (gitignored, this checkout) holds per-package fail lists,
  spot-check lists, and `wp-<pkg>-current-fails.txt` re-verified target lists.
- `.tmp/run-standalone.mts` / `.tmp/run-host.mts` — single-test probes over
  `runTest262File` (standalone / js-host lane).
- An interrupted full re-verify of the original 2,947 ES2015 failures on the
  batch-6 tree reached 723 tests with 162 flipped to pass
  (`.tmp/full-verify.out`); CI's post-merge baseline refresh will give the
  authoritative number.

## Method notes for the next session

- Twin-implementation collisions were the main integration tax: independent
  agents repeatedly implemented the same mechanism (OOB-undefined destructuring
  read ×2, dynamic element-set ×2, generator resume wrapper ×2, pre-root
  override slots ×2). Supersede one side, run `check:dead-exports`
  (it caught the orphaned twin every time), and probe the losing side's bucket
  after the merge.
- The workflow resume re-ran completed implementers (model-resolution changed
  the cache key) — accidentally productive: second passes over the same plans
  on a fixed base yielded +33..+66 per package. Deliberate "second pass over
  the plan on current main" is a cheap lever for the remaining buckets.
- Highest-value open lever (from #5138's follow-ups): the standalone
  `__iterator` classification breaks the harness `makeIterable` @@iterator
  delegation (`Array.from(makeIterable(...))` yields length 0), gating ALL
  8 TypedArray ctor-arg factories — ~500 tests behind one fix. Start there.
- eval-dependent (~196) and realm-dependent (~30+) ES2015 failures need the
  quickjs eval-engine artifact (not built in CCW containers) and a harness
  realm decision — carved out in #5156/#5157's acceptance criteria.
