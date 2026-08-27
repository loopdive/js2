---
id: 4769
title: "ES2015 standalone: remaining C02 native-generator parameter and self-binding residuals (27 rows)"
status: in-progress
created: 2026-08-27
updated: 2026-08-27
priority: high
feasibility: hard
model: gpt-5.6-luna
reasoning_effort: max
task_type: conformance
area: codegen
language_feature: generators
es_edition: 2015
goal: standalone-mode
sprint: current
related: [2864, 4444, 2175, 2906]
loc-budget-allow:
  - src/codegen/generators-native.ts
func-budget-allow:
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
---

# #4769 — remaining ES2015 generator C02 residual

## Problem

The #2864 closeout census isolated a 57-row C02 group. PR #5035 completes the
30 `arguments-object` rows by carrying the eagerly-created arguments vector
through native generator frames. The remaining 27 rows are distinct and must
not be appended to that completed fix. They cover destructuring/default
parameter forms, inferred function/class/generator names, generator method
shapes, and named-expression self-binding. The prior census measured 24/27
host-pass controls; three host failures must be identified rather than hidden
inside a standalone aggregate.

## Exact residual manifest and baseline

The manifest below is the C02 list recorded in commit `f43caf308`, with the
30 paths under `test/language/arguments-object/` removed. It is intentionally
kept as paths (rather than a glob) so a later rerun cannot silently change the
denominator.

```text
test/language/expressions/class/dstr/gen-meth-dflt-obj-ptrn-id-init-fn-name-class.js
test/language/expressions/class/dstr/gen-meth-obj-ptrn-id-init-fn-name-class.js
test/language/expressions/class/dstr/gen-meth-static-dflt-obj-ptrn-id-init-fn-name-class.js
test/language/expressions/class/dstr/gen-meth-static-obj-ptrn-id-init-fn-name-class.js
test/language/expressions/class/params-dflt-gen-meth-args-unmapped.js
test/language/expressions/class/params-dflt-gen-meth-static-args-unmapped.js
test/language/expressions/generators/dstr/dflt-obj-ptrn-id-init-fn-name-arrow.js
test/language/expressions/generators/dstr/dflt-obj-ptrn-id-init-fn-name-class.js
test/language/expressions/generators/dstr/dflt-obj-ptrn-id-init-fn-name-fn.js
test/language/expressions/generators/dstr/obj-ptrn-id-init-fn-name-arrow.js
test/language/expressions/generators/dstr/obj-ptrn-id-init-fn-name-class.js
test/language/expressions/generators/dstr/obj-ptrn-id-init-fn-name-fn.js
test/language/expressions/generators/params-dflt-args-unmapped.js
test/language/expressions/generators/scope-name-var-close.js
test/language/expressions/generators/scope-name-var-open-non-strict.js
test/language/expressions/generators/scope-name-var-open-strict.js
test/language/expressions/object/dstr/gen-meth-dflt-obj-ptrn-id-init-fn-name-class.js
test/language/expressions/object/dstr/gen-meth-obj-ptrn-id-init-fn-name-class.js
test/language/expressions/object/method-definition/params-dflt-gen-meth-args-unmapped.js
test/language/expressions/object/scope-gen-meth-param-rest-elem-var-close.js
test/language/expressions/object/scope-gen-meth-param-rest-elem-var-open.js
test/language/statements/class/dstr/gen-meth-dflt-obj-ptrn-id-init-fn-name-class.js
test/language/statements/class/dstr/gen-meth-obj-ptrn-id-init-fn-name-class.js
test/language/statements/class/dstr/gen-meth-static-dflt-obj-ptrn-id-init-fn-name-class.js
test/language/statements/class/dstr/gen-meth-static-obj-ptrn-id-init-fn-name-class.js
test/language/statements/class/params-dflt-gen-meth-args-unmapped.js
test/language/statements/class/params-dflt-gen-meth-static-args-unmapped.js
```

Provisioned test262 contents were the repository's maintained worktree
dependency. Both runs used two workers, `--official-scope-only`,
`TEST262_TARGET` as shown below, and the pinned QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`:

```sh
FILTER="$(git show f43caf308:plan/issues/2864-standalone-generator-carrier.md | awk '/^#### C02 \(57\)/{on=1; next} /^#### C03/{on=0} on && /^- test\// { sub(/^- /, ""); if ($0 !~ /^test\/language\/arguments-object\//) print }' | paste -sd'|' -)"
TEST262_TARGET=standalone TEST262_REPORTER=dot TEST262_WORKERS=2 \
  COMPILER_POOL_SIZE=2 TEST262_PATH_FILTER="$FILTER" \
  JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda \
  PATH=/opt/homebrew/opt/llvm@18/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH \
  bash scripts/run-test262-vitest.sh --official-scope-only

TEST262_TARGET=gc TEST262_REPORTER=dot TEST262_WORKERS=2 \
  COMPILER_POOL_SIZE=2 TEST262_PATH_FILTER="$FILTER" \
  JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda \
  PATH=/opt/homebrew/opt/llvm@18/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH \
  bash scripts/run-test262-vitest.sh --official-scope-only
```

The complete 27-row baseline is **standalone 0/27 (0%), all 27
`compile_error` host-import leaks** (`env::__create_generator`,
`env::__gen_create_buffer`, `env::__gen_next`); report run
`20260827-080640`, artifact
`benchmarks/results/test262-standalone-report-20260827-080640.json`.
The host control is **24/27 (88.9%), 3 fail, 0 compile errors, 0 skips**;
report run `20260827-080818`, artifact
`benchmarks/results/test262-report-20260827-080818.json`.
The three pre-existing host failures are:

- `.../generators/dstr/dflt-obj-ptrn-id-init-fn-name-arrow.js`: the parameter
  closure observes `null` instead of the immutable generator binding.
- `.../generators/scope-name-var-open-strict.js`: modifying the named
  generator binding does not throw `TypeError`.
- `.../object/scope-gen-meth-param-rest-elem-var-open.js`: the parameter
  closure observes `outside` instead of `inside`.

The 27 rows partition by the gates observed in the baseline:

| partition | rows | host pass | current gate / handoff |
| --- | ---: | ---: | --- |
| class/object dstr `class {}` inferred-name defaults | 10 | 10 | Initially rejected by `buildNativeGeneratorPlan`; six class/object method rows landed first, and the four class-expression rows are covered by the next bounded cluster below |
| dstr arrow/function/class defaults in generator function expressions | 6 | 5 | function-expression host lane and class/generator closure safety; retain conservative bails |
| `args-unmapped` parameter-default methods | 6 | 6 | arguments/frame plumbing; separate from the excluded 30 paths and hand off to the arguments work |
| named generator self-binding scope | 3 | 2 | `bodyReferencesOwnName`; strict mutation remains a host failure |
| object-method rest-parameter scope | 2 | 1 | rest parameter / eval-environment semantics; open scope remains a host failure |

The initial selected six rows were the two object-literal method forms and the
four class-declaration method forms whose only shared residual is a class-valued
destructuring default. The four class-expression method forms had the same
host-pass baseline but initially null-dereferenced the class value in a
zero-suspend experiment. They are addressed by the next bounded cluster below;
the other 17 rows remain measured handoffs until their own runtime invariant is
proved.

## Bounded implementation and outcome

The owning seam for the initial six-row checkpoint was the class-valued
element-default gate in
`buildNativeGeneratorPlan` (`src/codegen/generators-native.ts`). It admitted
the initializer only when the generator is a method in a class declaration or
object literal and `nodeContainsYield(decl.body)` is false. This is a
zero-suspend exception: the factory packs the default class through the frame
field, the initial resume executes immediately, and no class value crosses a
yield. Class-expression methods, free generator declarations, generator
function expressions, and any yielding method retain the existing bail. The
candidate and registration paths still share the plan result, so no
host-import/undefined-funcidx disagreement is introduced.

The focused semantic pin is
`tests/issue-4769-c02-class-defaults.test.ts`. Before the source change it
failed because the six-row source emitted
`env::__gen_create_buffer`/`env::__create_generator`; after the change it
validates, instantiates with `{}`, returns `42`, and keeps a class-expression
method on the host path.

Post-change exact-run evidence, all with the pinned QuickJS artifact and two
workers:

| run | target | paths | result | artifact |
| --- | --- | ---: | --- | --- |
| `20260827-082656` | standalone | 6 selected | **6/6 pass**, 0 CE, 0 skip, host-free | `benchmarks/results/test262-standalone-report-20260827-082656.json` |
| `20260827-082808` | gc host control | 6 selected | **6/6 pass**, 0 CE, 0 skip | `benchmarks/results/test262-report-20260827-082808.json` |
| `20260827-083020` | standalone | full 27 | **6/27 pass**, 21 host-import CE, 0 skip | `benchmarks/results/test262-standalone-report-20260827-083020.json` |
| `20260827-083211` | gc host control | full 27 | **24/27 pass**, the same 3 pre-existing failures, 0 CE, 0 skip | `benchmarks/results/test262-report-20260827-083211.json` |

After the final `el.initializer !== undefined` guard (commit `5118e8c61`),
the acceptance reruns were:

| run | target | paths | result | artifact |
| --- | --- | ---: | --- | --- |
| `20260827-084008` | standalone | 6 selected | **6/6 pass**, 0 CE, 0 skip, host-free | `benchmarks/results/test262-standalone-report-20260827-084008.json` |
| `20260827-084129` | gc host control | 6 selected | **6/6 pass**, 0 CE, 0 skip | `benchmarks/results/test262-report-20260827-084129.json` |
| `20260827-084243` | standalone | full 27 | **6/27 pass**, 21 host-import CE, 0 skip | `benchmarks/results/test262-standalone-report-20260827-084243.json` |
| `20260827-084527` | gc host control | full 27 | **24/27 pass**, 3 fail, 0 CE, 0 skip | `benchmarks/results/test262-report-20260827-084527.json` |

The six-row acceptance denominator is exactly:

```text
test/language/expressions/object/dstr/gen-meth-dflt-obj-ptrn-id-init-fn-name-class.js
test/language/expressions/object/dstr/gen-meth-obj-ptrn-id-init-fn-name-class.js
test/language/statements/class/dstr/gen-meth-dflt-obj-ptrn-id-init-fn-name-class.js
test/language/statements/class/dstr/gen-meth-obj-ptrn-id-init-fn-name-class.js
test/language/statements/class/dstr/gen-meth-static-dflt-obj-ptrn-id-init-fn-name-class.js
test/language/statements/class/dstr/gen-meth-static-obj-ptrn-id-init-fn-name-class.js
```

The full standalone run flips exactly the selected six rows. Its 21-row
residual is unchanged host-import leakage, grouped as follows:

- four class-expression dstr class-name rows (the zero-suspend
  class-expression null-deref lane);
- six `args-unmapped` rows (arguments/frame plumbing);
- six generator function-expression dstr name rows (closure/function-expression
  lane; all six are host-pass controls after the final guard, but remain
  standalone host-import bails);
- three named-generator self-binding scope rows; and
- two object-method rest-parameter scope rows.

The final full host control fails exactly these three paths:

- `test/language/expressions/generators/scope-name-var-open-strict.js` — the
  named inner binding does not reject modification with `TypeError`;
- `test/language/expressions/generators/scope-name-var-open-non-strict.js` —
  the parameter closure observes the native function instead of `null`; and
- `test/language/expressions/object/scope-gen-meth-param-rest-elem-var-open.js`
  — the parameter closure observes `outside` instead of `inside`.

The dstr-arrow host control that failed in the initial baseline is a host pass
after the final guard, but remains in the standalone residual because its
generator still emits host imports.

The related native-generator regression command was:

```sh
PATH=/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
  node_modules/.bin/vitest run \
  tests/issue-4769-c02-class-defaults.test.ts \
  tests/issue-3952.test.ts tests/issue-3386.test.ts \
  tests/issue-2756.test.ts tests/issue-2864-s2-generator-arguments.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism \
  --reporter=dot
```

It produced **4 files passed, 46 tests passed, 1 skipped, 1 failed**. The only
failure was the pre-existing `tests/issue-2756.test.ts` class-expression
default-materialization case (`TypeError: [object Object] is not a
constructor`), reproduced with the source gate reverted; the four task-related
files passed and no new skip was introduced.

The initial implementation is carried by commits `eaa7b48e5` (bounded
zero-suspend class-default admission and focused semantic pin) and `5118e8c61`
(guard the class-default syntax probe for absent initializers). The issue-plan
checkpoint is `8e116f40b`. The next class-expression checkpoint is
`ba6331110a8711537400eca5a646b41f7bf331a2`, carrying the bounded source,
focused controls, and refreshed evidence below. These commits are the pending
checkpoint for the separate upstream draft PR
[#5037](https://github.com/loopdive/js2/pull/5037), sourced from
`ttraenkler/js2` and targeting `loopdive/js2:main`; the PR remains draft until
the parent agent confirms the implementation push and refreshed CI.

## Next bounded cluster: class-expression method defaults

The next largest cohesive host-pass partition is the four class-expression
method rows in the manifest (two instance and two static forms). A direct
admission probe initially reproduced the recorded null dereference: the
class-expression method's native resume plan inferred an anonymous class-valued
binding as the enclosing class's GC ref, while the factory emitted the default
class as a closure-backed externref. The narrow correction keeps only
zero-suspend class-expression methods in this partition and records those
class-valued bindings at the boundary `externref` representation. Yielding
class-expression methods, generator-valued defaults, and function-expression
generator lanes retain their existing bails.

The focused control `tests/issue-4769-c02-class-defaults.test.ts` now has
**3/3 tests passing**: the prior six class/object methods, four zero-suspend
class-expression methods, and a yielding class-expression host-path guard.

The exact four-row acceptance denominator is:

```text
test/language/expressions/class/dstr/gen-meth-dflt-obj-ptrn-id-init-fn-name-class.js
test/language/expressions/class/dstr/gen-meth-obj-ptrn-id-init-fn-name-class.js
test/language/expressions/class/dstr/gen-meth-static-dflt-obj-ptrn-id-init-fn-name-class.js
test/language/expressions/class/dstr/gen-meth-static-obj-ptrn-id-init-fn-name-class.js
```

Exact post-change runs used the pinned QuickJS artifact, two workers, and
`--official-scope-only`:

| run | target | paths | result | artifact |
| --- | --- | ---: | --- | --- |
| `20260827-090824` | standalone | 4 selected | **4/4 pass**, 0 CE, 0 skip, host-free | `benchmarks/results/test262-standalone-report-20260827-090824.json` |
| `20260827-090948` | gc host control | 4 selected | **4/4 pass**, 0 CE, 0 skip | `benchmarks/results/test262-report-20260827-090948.json` |
| `20260827-091351` | standalone | full 27 | **10/27 pass**, 17 host-import CE, 0 skip | `benchmarks/results/test262-standalone-report-20260827-091351.json` |
| `20260827-091542` | gc host control | full 27 | **24/27 pass**, 3 fail, 0 CE, 0 skip | `benchmarks/results/test262-report-20260827-091542.json` |

The full standalone run flips exactly the four class-expression rows in this
cluster in addition to the prior six. The remaining 17 host-import compile
errors are unchanged: six `args-unmapped` rows (arguments/frame plumbing), six
generator function-expression dstr-name rows (known function-expression
generator trap), three named-generator self-binding scope rows, and two
object-method rest-parameter scope rows. The host full run retains the same
three pre-existing failures documented above.

## Implementation plan

1. Reconstruct the exact remaining 27-path manifest from #2864's C02 census,
   excluding the 30 `language/arguments-object` paths delivered by PR #5035.
   Run every path in standalone and host with at most two workers and record
   outcome, reached-test status, and error signature.
2. Partition the rows by proven compiler gate. Start with the largest cohesive
   host-pass subset; do not combine destructuring/default plumbing, name
   inference, and self-binding merely because they share the C02 label.
3. Add a focused semantic pin for the selected subset before source changes.
   Implement the shared native-generator frame/resume correction at its owning
   seam, preserving the existing conservative bails for unsupported shapes.
4. Re-run the selected exact standalone rows, their host controls, the full
   27-row manifest, and the related native-generator regression suite. Record
   flips and losses explicitly in this issue.
5. Deliver this task through one upstream `loopdive/js2:main` PR from
   `ttraenkler/js2`. Open it as draft at the first pushed checkpoint and mark it
   ready only when the selected bounded fix is complete and all its acceptance
   checks pass. Leave unrelated residual partitions for separate issue/PR
   tasks.

## Acceptance

- The selected root-cause subset has an explicit path denominator and passes
  100% in standalone.
- Every host-pass control in the subset remains passing; any pre-existing host
  failure is named and is not credited as a regression-free control.
- Focused semantics and the related native-generator regression suite pass
  without new skips, host imports, timeout changes, fixture changes, or oracle
  allowances.
- The issue records exact commands, artifacts, commit SHA, PR URL/state, and a
  handoff for the residual rows outside the delivered subset.

## Handoff

Root created this separate task after the bounded frame-carried `arguments`
fix completed on PR #5035. This worktree owns only #4769; it must not amend or
push to #5035.
