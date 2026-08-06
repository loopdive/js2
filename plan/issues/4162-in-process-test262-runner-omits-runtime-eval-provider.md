---
id: 4162
title: "In-process test262 runner omits the `js2wasm:runtime-eval` provider the worker supplies — standalone measurements silently die at instantiate and MASK their real signature"
status: ready
sprint: current
created: 2026-08-06
updated: 2026-08-06
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: testing, standalone
language_feature: n/a
goal: standalone-mode
related: [3441, 3613, 3251, 2663, 2095]
origin: "Hit independently by three agents in one session (2026-08-06) while A/B-measuring separate ES5 standalone levers"
---

# #4162 — the in-process test262 runner drops the runtime-eval provider

## Problem

There are two test262 execution lanes and they disagree about import namespaces:

| | supplies `js2wasm:runtime-eval`? |
| --- | --- |
| `scripts/test262-worker.mjs` (the sharded CI lane) | **yes** — `test262-worker.mjs:1849` inspects `WebAssembly.Module.imports(...)` for `RUNTIME_EVAL_IMPORT_MODULE` and, when present, instantiates a **fresh** provider per test (per-test isolation: the interpreter roots dynamic functions at global env records) |
| `tests/test262-runner.ts` (`runTest262File`, used in-process) | **no** — `test262-runner.ts:4242` is a bare `await WebAssembly.instantiate(result.binary, imports)` with no such check |

So any standalone module that links `js2wasm:runtime-eval` **fails at instantiation** under the in-process runner, with a link error like `module is not an object or func`.

## Why this is worse than "some tests fail"

It does not merely lose those tests — **it overwrites their real error signature with an instantiation artifact.** A test that would have failed with a genuine, informative `Test262Error: Expected obj[0] to be writable` instead reports a link failure. Any bucket histogram, cluster analysis, or A/B built on the in-process runner is therefore measuring the instrument's own gap and attributing it to the compiler.

The trigger is broad, not exotic: `test262/harness/propertyHelper.js:31` reads the global `Function` value, which trips `sourceUsesRuntimeEvalBoundary` (`src/codegen/index.ts:3196`). **Every test with `includes: [propertyHelper.js]` links the namespace in standalone** — which is most of the descriptor corpus.

## Measured blast radius (2026-08-06, three independent agents)

| Lever | affected / list size |
| --- | ---: |
| Array exotic `[[DefineOwnProperty]]` §15.4.5.1 | **82 / 162** |
| `with` statement | **44 / 152** |
| AnnexB B.3.3 hoisting | hit independently, count not recorded |

Two of the three had to hand-roll the same shim (a monkey-patch on
`WebAssembly.instantiate`) before their numbers meant anything. The `with` agent
reports that **after** shimming, its bucket histogram reproduces the published
2026-08-06 baseline header exactly — which is the check that tells you the shim
is right and the un-shimmed run was wrong.

Had any of them skipped the shim, the likely outcome was a **false +0** on half
the lever, read as "this mechanism does not matter" — the same failure mode that
produced the bogus ~297-file sizing on #4160.

## This is the third instance of one drift class

- **#3441** — the sandbox-globals list drifted between the two lanes; fixed by
  extracting `scripts/test262-sandbox-globals.mjs` as a single shared source
  imported by both. Before that it stranded ~2,069 TypedArray-ctor tests.
- **#3613** — the exception renderer drifted between the two lanes; unified.
- **This issue** — the import-namespace supply drifted; **not** unified.

The pattern is that `test262-worker.mjs` accretes fidelity fixes and
`test262-runner.ts` does not. Each was diagnosed as a one-off. It is worth
fixing this one *as a class*: make the import-object construction a single
shared module both lanes call, so a future namespace cannot be added to one lane
only.

## Constraint on the fix

`scripts/validate-test262-baseline.ts` also uses the in-process runner (#2095),
and the standalone regression floor (#1897) depends on that validator. Changing
what the in-process runner links changes what the validator sees. The change
should make **more** tests run correctly rather than fewer, but it must be
verified rather than assumed — spot-check the validator before and after and
confirm the sampled `pass` entries still pass.

Both agents deliberately did **not** touch the shared runner for exactly this
reason, and shimmed locally instead. That was the right call for them and is why
this is filed rather than silently fixed.

## Acceptance criteria

- `runTest262File` supplies a fresh `js2wasm:runtime-eval` provider instance per
  test whenever the compiled module imports that namespace, matching
  `test262-worker.mjs`'s behaviour including the per-test isolation.
- Import-object construction is shared between the two lanes (one module, both
  callers), not duplicated — otherwise this recurs a fourth time.
- A `includes: [propertyHelper.js]` standalone test that currently dies at
  instantiate under `runTest262File` instead reports its real status.
- `pnpm run test:262:validate-baseline` still passes, and the sampled entries
  are unchanged.
- Regression guard: a test asserting the two lanes construct the same import
  namespace set for the same binary.

## Notes

- **Id provenance:** reserved via `claim-issue.mjs --allocate --by
  ttraenkler/lead-es5`. The allocator's open-PR scan degraded (`gh` unavailable
  in this container), so `--allow-unscanned` was used *after* scanning the open
  PR set through the GitHub API: #4131, #4124, #4106, #4132, #4133; the highest
  issue id introduced by any of them is 4150. The required
  `check:issue-ids:against-main` gate remains the backstop.
- Reference shims and the validation method are in
  `plan/agent-context/L2-array-exotic-define.md` and
  `plan/agent-context/L4-with-statement.md`.
