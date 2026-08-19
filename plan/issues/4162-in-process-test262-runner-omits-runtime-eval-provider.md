---
id: 4162
title: "In-process test262 runner omits the `js2wasm:runtime-eval` provider the worker supplies — standalone measurements silently die at instantiate and MASK their real signature"
status: done
sprint: 78
created: 2026-08-06
updated: 2026-08-18
completed: 2026-08-06
assignee: ttraenkler/W8-instrument-4162
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

## Resolution (2026-08-06)

`scripts/test262-import-object.mjs` is now the ONE seam every test262 lane calls
to turn a compiled binary into an instance. All five instantiate sites route
through it: the worker's main path and its `buildInvalidBinaryError` diagnostic,
the fixture-graph lane, `runOriginalHarnessVariant`, `runSyntheticTest262File`,
and `handleNegativeTest`'s validation probe. Tier selection, the fresh-per-test
provider instance and the stderr provenance line live there; the lanes only pass
`{ target, providerLabel }`.

The seam also normalises the return shape — `WebAssembly.instantiate` resolves
to an `Instance` for a `Module` argument but to `{ module, instance }` for a
`BufferSource`, and every lane was open-coding that distinction differently.

### Measured, not estimated

A/B on the 162-file L2 lever list, in-process runner, `--target standalone`.
`TEST262_DISABLE_RUNTIME_EVAL_PROVIDER=1` reproduces the pre-fix behaviour
exactly (no provider ⇒ unresolvable import), so both arms run the same binary:

| arm | pass | files reporting a `js2wasm:runtime-eval` link error |
| --- | ---: | ---: |
| pre-fix behaviour (provider disabled) | 26 | **82** |
| post-fix (refusal tier) | **44** | **0** |

- The pre-fix arm reproduces the reported **82 / 162** exactly — the instrument
  demonstrably responds, so the zero in the second row is believable.
- **18 of the 82 were already PASSING** and were being counted as failures. The
  instrument was eating +18 on one 162-file lever.
- `pass → non-pass` regressions: **0**.
- The recovered signatures are the predicted ones: 13 × `Expected obj[#] to be
  writable, but was not`, 12 × `Expected obj[#] to equal #, actually null`, etc.
- Local runs select the REFUSAL tier; CI standalone shards set
  `TEST262_FULL_RUNTIME_EVAL=1`, so the CI-side recovery is at least this large.

### Correction: the trigger named above is NOT the trigger

`propertyHelper.js:31`'s `Function.prototype.call.bind(...)` does **not** trip
`sourceUsesRuntimeEvalBoundary` — `isGlobalFunctionValueReference`
(`src/codegen/index.ts:3186`) explicitly excludes an identifier whose parent is a
property access, and that source compiles to **zero** imports. Verified directly.

The real trigger is the runner's own `$262.evalScript` shim — `return
eval(sourceText)` — which `assembleOriginalHarness` emits into **every**
assembled test, not only `includes: [propertyHelper.js]` ones. The blast radius
is therefore wider than "the descriptor corpus" and is bounded by which tests
keep that shim reachable after dead-code elimination rather than by their
`includes:` list. The measured 82/162 stands; the mechanism behind it does not.

### Second defect found while fixing this — same class

`handleNegativeTest` (`tests/test262-runner.ts`) built its compile options from a
bare `target` identifier that **was never bound in that scope**. The
`ReferenceError` was thrown inside the `try` whose `catch` reports
`status: "pass"`, so every parse/early/resolution-phase negative test routed
through it passed **vacuously, without compiling anything** (`compileMs` ≈ 0.05
was the tell). Fixed by threading the caller's `target` through as a real
parameter and constructing the options OUTSIDE the try, so a harness defect
crashes loudly instead of laundering itself into a conformance pass. This flipped
the two long-red assertions in `tests/issue-338.test.ts` to green.

### Guarded by

`tests/issue-4162.test.ts` — the bare-instantiate control, the seam's namespace
attachment, cross-lane namespace-set equality, an end-to-end
`includes: [propertyHelper.js]` run through `runTest262File`, the vacuity
regression, and a **structural routing guard** asserting no lane file calls
`WebAssembly.instantiate` on a test binary itself. The structural one is what
prevents a fourth instance of the drift class; behavioural parity between lanes
that already share an implementation is tautological.

### Validator

`pnpm run test:262:validate-baseline` (`SAMPLE_SIZE=50 FAIL_SAMPLE_SIZE=25
SEED=4162`) run on clean `main` and on this branch with the identical seed —
same sampled entries, same verdicts. See the PR body for the paired output.

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
