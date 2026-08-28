---
id: 5109
title: "ES2015 standalone for-in let closures retain each iteration's key"
status: done
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: for-in-per-iteration-closure
es_edition: ES2015
goal: standalone-mode
assignee: "ttraenkler/codex/es6-next-lane-e"
related: [2705, 4672]
files:
  - src/codegen/statements/loops.ts
  - src/ir/analysis/loop-shape.ts
  - tests/issue-5109-forin-closure-capture.test.ts
  - plan/issues/5109-es2015-forin-closure-capture.md
loc-budget-allow:
  - src/codegen/statements/loops.ts
  - src/ir/analysis/loop-shape.ts
---

# #5109 — ES2015 standalone for-in `let` closures retain each iteration's key

## Exact cohort and duplicate gate

This record owns exactly one maintained official ES2015 row:

```text
test/language/block-scope/syntax/for-in/mixed-values-in-iteration.js
```

The row was selected from the fresh standalone JSONL
`/private/tmp/js2-baseline-standalone-current-20260828.jsonl` and the checked-in
edition map `website/public/benchmarks/results/test262-file-editions.json`.
The edition lookup is `ES2015`; the map SHA-256 is
`4e1b3409bb509052128fca642e1b982a0f27c4c9224a596753b498be5b421db1`.

The standalone snapshot row (oracle version 13, honest lane, official standard
scope) is:

```text
timestamp: 28.8.2026, 01:59:52
status: fail
error_category: assertion_fail
error: Test262Error: Expected SameValue(«"a"», «null») to be true
reached_test: true
```

The matching fresh host snapshot
`/private/tmp/js2-baseline-host-current-20260828.jsonl` records the same row as
`status: pass` (timestamp `28.8.2026, 02:12:16`, reached test true). Its
SHA-256 is `a395f2a88d289a8e0fd78ccd76e090215ef3a85f1960aa8fe96f7d3a0445bd49`;
the standalone snapshot SHA-256 is
`260a57b7fb4d53516fa81e1c949d81337968e30ce790d457bcc2d3945c2e9e1e`.
Both snapshots use oracle version 13 and the official standard population.
The current baseline source metadata is `4c2bc1de6a65e5abafa471881a64b441e501a4d4`.

The standalone row's test body creates closures during
`for (let p in x)` and calls them after the loop. The five keys are `a`, `b`,
`c`, `d`, and `e`; each closure must retain its own per-iteration binding. The
standalone failure proves the first closure instead observes the uninitialized
`null` value. The host pass is the positive lane control. No open upstream PR
targets this exact fixture, and the upstream assignment registry has no claim
for plan ID 5109 before this allocation. The open PR numbered 5109 tracks the
different plan ID 5102; it is not a duplicate of this record.

The fresh upstream source base is `upstream/main` at
`0ccc264fa183484edfa852af4084dd899f9b433f`, fetched before creating the
isolated worktree. Explicitly excluded neighboring lanes are plan IDs 4786,
4779, 5091, 5099, 5100, 5102, 5104, and 5107, plus any cohort owned by the
parallel `es6_next_lane_d`; this row is outside those cohorts.

## Root cause hypothesis to verify on current main

`compileForInStatement` allocates one `keyLocal` for a lexical identifier head.
When the loop body creates a closure that references the head, closure
capture promotes the name to a ref-cell view, but the per-iteration key write
continues to target the original local. In standalone's native dynamic-object
for-in path, the captured cell therefore retains its zero/null value. The host
path currently passes through its own callable/property bridge, which masks the
same storage mismatch.

This hypothesis must be re-probed against the current upstream base before
implementation. The fix must preserve the distinct receiver-evaluation TDZ
environment already handled by #2705 and must not conflate it with the
per-iteration body environment.

## Implementation plan and budget

1. Reproduce the exact row on `upstream/main` with the repository compiler and
   assembled harness, then compile a self-contained no-corpus equivalent that
   uses a dynamic `any` receiver and a numeric result. Confirm the known-good
   host control before trusting any standalone probe.
2. Extend the existing pure-AST loop-shape analysis only as needed to identify
   lexical for-in head names captured by a closure in the loop body. Keep the
   receiver-TDZ capture classification separate from body per-iteration
   capture, and only enter the new path for a simple identifier `let`/`const`
   head that is actually captured.
3. In the captured body path, allocate a ref-cell-backed per-iteration binding.
   Before compiling the body, point identifier reads and closure capture at the
   cell; at runtime, create a fresh cell from the just-materialized key before
   each body invocation. Restore all surrounding `localMap`, TDZ, const, and
   boxed-capture descriptors after the loop. Retain the existing fast path for
   non-capturing heads and the mandatory receiver TDZ path.
4. Wire the same narrow cell update into whichever for-in emitter the exact
   receiver uses (dynamic object, array, or static unroll), or document and
   test a deliberately corpus-backed gate if a path cannot soundly share it.
   Do not add host imports, skip filters, broad closure rewrites, or changes to
   for-of/counting-loop semantics.
5. Add `tests/issue-5109-forin-closure-capture.test.ts` with the exact row's
   five-key closure behavior, host/standalone parity, a non-capturing for-in
   control, and a real self-contained no-corpus standalone shape. Assert the
   standalone module has no `env::*` imports.
6. Run focused tests with at most two workers, exact host/standalone cohort
   probes plus one repeat, and scoped type/lint/format/issue-integrity and
   repository pre-push gates. Sync latest upstream once at the end, rerun the
   focused controls, and record all counts, hashes, residuals, and SHAs here.

Budget: one small-horizon lane; source LOC target ≤45, one focused test file,
and no more than two compiler workers for any concurrent validation. If the
fix requires a general closure or loop-environment rewrite, stop and hand the
expanded design to the lead rather than widening this one-row lane.

## Acceptance

- The exact Test262 row passes in both host and standalone, with no compile
  errors, compile timeouts, skips, or nondeterminism.
- The standalone module for the exact row and the self-contained equivalent
  has zero `env::*` host imports; the host lane remains passing.
- Every closure made by a captured `for (let p in x)` body observes its own
  enumerated key (`a`, `b`, `c`, `d`, `e`) after the loop; a non-capturing for-in
  and receiver-TDZ control retain their prior behavior.
- No changes are made to the excluded active cohorts or to generic closure,
  for-of, array, generator, or host-property semantics beyond the proven
  captured lexical for-in body path.
- The final branch is based on current upstream `main`, has this checked-in
  plan/handoff, and is represented by exactly one ready, mergeable upstream
  PR using the repository Description/CLA template. The PR title and all
  commit subjects end with `✓`; commits are authored by Thomas Tränkler with
  `Co-authored-by: Codex <codex@openai.com>`.

## Handoff

Initial worktree: `/private/tmp/js2-es6-next-lane-e`.
Branch: `codex/es6-next-lane-e`.

Implementation complete in the narrow dynamic-object path. The existing
receiver-TDZ capture remains separate; a body-only loop-shape pass now gates
simple captured `let`/`const` identifier heads, which receive a fresh
externref-backed cell initialized from the materialized key before each body
invocation. Non-capturing heads, static unroll, array paths, binding patterns,
member/call targets, and for-of/counting loops retain their prior lowering.

Checkpoint commits (all pushed to `fork/codex/es6-next-lane-e`):

- `8699f36fca` — plan allocation and exact-row evidence.
- `ab66758a65` — codegen/analysis fix and host/standalone regression tests.
- `76fb4fa2bd` — standalone host-import assertion.
- `75b491b55ee7` — final sync merge of `upstream/main` at `7dd9f3b5b9`.

Post-sync validation:

- `pnpm exec vitest run tests/issue-5109-forin-closure-capture.test.ts tests/issue-2705.test.ts tests/issue-4561-forin-break-continue.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot` — 25/25 passed.
- The exact pinned Test262 source was run through `runSyntheticTest262File` three times per lane: host 3/3 pass; standalone 3/3 pass.
- The exact wrapped source compiled with zero errors and returned `[1, 1, 1]` in both lanes; its import manifest had 24 `env` imports in host mode and 0 in standalone mode.
- The no-corpus dynamic-receiver/mutation test passed in both lanes; the focused file asserts standalone `env` imports are empty.
- Typecheck, lint, format, function-budget, oracle/coercion ratchets, numeric-local parity, issue-integrity, and pre-push gates passed at the implementation checkpoint; the post-sync focused controls above remained green.

The raw authoritative `runTest262File` path was not used for the acceptance
count because its current-main import-manifest setup throws before execution;
the repository's synthetic wrapper path (with the exact pinned source and
runner options) is the passing reproduction recorded above.

PR: https://github.com/loopdive/js2/pull/5120 (open, non-draft, mergeable).
