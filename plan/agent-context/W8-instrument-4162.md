# W8 — #4162, the instrument bug

**Branch**: `issue-4162-shared-test262-imports` (pushed to `origin` =
`loopdive/js2`) · **Commit**: `751abd291a` · **PR**: not opened — no `gh` and no
usable token in this container. Body below, ready to paste.

---

## PR title

`fix(test262): one shared import object for every execution lane (#4162)`

## PR body

The in-process test262 runner never supplied the `js2wasm:runtime-eval`
namespace that `scripts/test262-worker.mjs` supplies. A standalone module
linking it therefore died at instantiate — and the link error **overwrote the
test's real signature**. A descriptor test that would report `Test262Error:
Expected obj[0] to be writable` reported

```
TypeError: WebAssembly.instantiate(): Import #0 module="js2wasm:runtime-eval":
           module is not an object or function
```

instead, so every bucket histogram, cluster label and A/B built on that lane was
measuring the instrument's own gap and attributing it to the compiler.

### The fix

`scripts/test262-import-object.mjs` is the ONE seam every lane now calls. Five
instantiate sites route through it:

| site | lane |
| --- | --- |
| `test262-worker.mjs` main path | sharded CI fork worker |
| `test262-worker.mjs` `buildInvalidBinaryError` | worker diagnostic probe |
| `test262-shared.ts` fixture graph | in-process fixture lane |
| `test262-runner.ts` `runOriginalHarnessVariant` | `runTest262File` |
| `test262-runner.ts` `runSyntheticTest262File` + `handleNegativeTest` | legacy wrapper lane |

Tier selection, the fresh-per-test provider instance and the stderr provenance
line live in the shared module; lanes pass only `{ target, providerLabel }`. The
seam also normalises `WebAssembly.instantiate`'s two return shapes (an
`Instance` for a `Module` argument, `{ module, instance }` for a `BufferSource`),
which each lane was open-coding differently.

Behaviour per lane is otherwise unchanged: standalone goes module-first so the
import list is inspectable; the host lane keeps the binary-form async
instantiate, since it never carries a conditional namespace and
`new WebAssembly.Module()` compiles synchronously on the calling thread.

### Measured, not estimated

A/B on the 162-file `L2-array-exotic-defineownproperty-15.4.5.1` lever list,
in-process runner, `--target standalone`.
`TEST262_DISABLE_RUNTIME_EVAL_PROVIDER=1` reproduces the pre-fix behaviour
exactly, so one binary measures both arms:

| arm | pass | files reporting a `js2wasm:runtime-eval` link error |
| --- | ---: | ---: |
| pre-fix behaviour (provider disabled) | 26 | **82** |
| post-fix (refusal tier) | **44** | **0** |

* The pre-fix arm reproduces the reported **82 / 162** exactly — the instrument
  demonstrably responds, so the `0` is believable rather than assumed.
* **18 of the 82 were already PASSING** and were counted as failures. The
  instrument was eating +18 on one 162-file lever.
* `pass → non-pass` regressions: **0**.
* Recovered signatures are the predicted family: 13 × `Expected obj[#] to be
  writable, but was not`, 12 × `Expected obj[#] to equal #, actually null`, …
* Local runs select the REFUSAL tier; CI standalone shards set
  `TEST262_FULL_RUNTIME_EVAL=1`, so the CI-side recovery is at least this large.

### Validator (the one real constraint)

`scripts/validate-test262-baseline.ts` shares this runner and the #1897
standalone floor rests on it, so it was run on clean `main` and on this branch
with an identical seed:

```
SAMPLE_SIZE=50 FAIL_SAMPLE_SIZE=25 SEED=4162 npx tsx scripts/validate-test262-baseline.ts
```

Both arms: **150 rows, 5 discrepancies, the same five files.** No sampled entry
changed verdict.

Two of those five, **on clean main**, were the #4162 link error itself:

```
test/annexB/language/eval-code/direct/func-if-decl-else-stmt-eval-func-skip-early-err-for.js
  main:   TypeError: WebAssembly.instantiate(): Import #0 module="js2wasm:runtime-eval": …
  branch: TypeError: dynamic code evaluation is not supported in this standalone build …
```

So the bug was corrupting the floor's own validator: baseline-`pass` rows read
as regressions purely from the instrument gap. They still fail locally, because
the local REFUSAL tier genuinely cannot evaluate — but the reason is now honest
and CI-comparable instead of an artifact. The other three discrepancies are
pre-existing real drift, unrelated to this change.

### Two findings that correct the issue

**1 — the named trigger is not the trigger.** #4162 attributes it to
`propertyHelper.js:31` reading the global `Function` via
`Function.prototype.call.bind(...)`. That construct compiles to **zero
imports**: `isGlobalFunctionValueReference` (`src/codegen/index.ts:3186`)
explicitly excludes an identifier whose parent is a property access. Verified
directly.

The real trigger is the runner's **own** `$262.evalScript` shim — `return
eval(sourceText)` — which `assembleOriginalHarness` injects into **every**
assembled test, not only `includes: [propertyHelper.js]` ones. So the blast
radius is bounded by which tests keep that shim reachable after DCE, not by
their `includes:` list, and is wider than "the descriptor corpus". The measured
82/162 stands; the mechanism behind it does not.

**2 — a second vacuity bug in the same file, same class.** `handleNegativeTest`
built its compile options from a bare `target` identifier that was **never bound
in that scope**. The `ReferenceError` was thrown inside the `try` whose `catch`
reports `status: "pass"`, so every parse/early/resolution-phase negative test
routed through it passed **vacuously without compiling anything** —
`compileMs ≈ 0.05` was the tell. Fixed by threading the caller's `target`
through as a real parameter and constructing the options *outside* the try, so a
harness defect crashes loudly instead of laundering itself into a conformance
pass. This flips the two long-red assertions in `tests/issue-338.test.ts` to
green.

### Guard

`tests/issue-4162.test.ts` (13 tests): the bare-instantiate control, the seam's
namespace attachment with a real return value, cross-lane namespace-set
equality, host-lane no-op, an end-to-end `includes: [propertyHelper.js]` run
through `runTest262File`, the vacuity regression, and a **structural routing
guard** asserting that no lane file calls `WebAssembly.instantiate` on a test
binary itself.

The structural one is the load-bearing assertion. This was the third instance of
one drift class (#3441 sandbox globals, #3613 exception renderer — both since
unified), and behavioural parity between lanes that already share an
implementation is tautological; what actually prevents a fourth is that a lane
cannot grow its own instantiate again.

### Local verification

| check | result |
| --- | --- |
| `tests/issue-4162.test.ts` | 13/13 pass |
| `tests/issue-338.test.ts` | 11/11 pass (was 9/11 on main) |
| `check:oracle-ratchet`, `check:loc-budget`, `check:func-budget`, `check:coercion-sites` | all OK (0 changed `src/` files) |
| `check:test-vacuity-shapes`, `check:issue-spec-coverage`, `check:done-status-integrity`, `check:issue-ids:against-main` | all OK |
| `lint` (biome), `prettier --check` | clean |
| `issue-2095-baseline-validator-lanes`, `issue-2928-e6-provider-cache` | pass |

Pre-existing failures on clean `main`, unchanged by this PR and verified
identical in both checkouts: `issue-3613-render-parity` (2),
`issue-2940` (1), `issue-3086` (1).

---

## Left undone, deliberately

* **The three non-eval validator discrepancies** on clean main
  (`DisposableStack/prototype/use/…`, `Iterator/prototype/map/this-non-object`,
  `Iterator/prototype/flatMap/argument-validation-failure-closes-underlying`).
  Real baseline drift, unrelated mechanism, not this PR's scope.
* **The 4 pre-existing red tests** listed above.
* **`buildImports` itself is still not shared** between the lanes — the worker
  builds its sandbox with `node:vm` `runInContext`, the in-process runner with
  `createTestSandbox`. Unifying that is a much larger change with real
  behavioural risk, and it is not the axis that drifted. What the seam
  guarantees is that the *conditional* namespaces — the ones whose supply
  depends on the compiled module's own import list, which is exactly what
  drifted three times — have one home.
* **No re-measurement of the other levers** (L1/L3/L4/L5/L6, W2). Their owners
  should re-run against this branch; the un-shimmed halves of their lists are
  now measurable.

## For whoever opens the PR

```
git fetch origin issue-4162-shared-test262-imports
gh pr create -R loopdive/js2 --head issue-4162-shared-test262-imports \
  --title "fix(test262): one shared import object for every execution lane (#4162)" \
  --body-file plan/agent-context/W8-instrument-4162.md
```

Open it READY, not draft. Do not enqueue — `auto-enqueue.yml` owns that.
