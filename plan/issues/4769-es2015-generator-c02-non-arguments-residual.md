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
  PATH=/opt/homebrew/opt/llvm@18/bin:$PATH \
  bash scripts/run-test262-vitest.sh --official-scope-only

TEST262_TARGET=gc TEST262_REPORTER=dot TEST262_WORKERS=2 \
  COMPILER_POOL_SIZE=2 TEST262_PATH_FILTER="$FILTER" \
  JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda \
  PATH=/opt/homebrew/opt/llvm@18/bin:$PATH \
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
| class/object dstr `class {}` inferred-name defaults | 10 | 10 | `buildNativeGeneratorPlan` rejects class-valued element defaults; selected largest cohesive subset |
| dstr arrow/function/class defaults in generator function expressions | 6 | 5 | function-expression host lane and class/generator closure safety; retain conservative bails |
| `args-unmapped` parameter-default methods | 6 | 6 | arguments/frame plumbing; separate from the excluded 30 paths and hand off to the arguments work |
| named generator self-binding scope | 3 | 2 | `bodyReferencesOwnName`; strict mutation remains a host failure |
| object-method rest-parameter scope | 2 | 1 | rest parameter / eval-environment semantics; open scope remains a host failure |

The selected ten rows are the four class-expression method forms, the two
object-literal method forms, and the four class-declaration method forms whose
only shared residual is a class-valued destructuring default. They all pass on
the host baseline; the other 17 remain measured handoffs until their own
runtime invariant is proved.

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
