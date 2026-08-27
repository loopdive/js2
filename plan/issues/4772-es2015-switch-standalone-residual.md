---
id: 4772
title: "ES2015 standalone switch-statement residuals"
status: done
created: 2026-08-27
updated: 2026-08-27
completed: 2026-08-27
priority: high
goal: test262-conformance
assignee: ttraenkler/codex-es6-switch
parent: 4444
es_edition: ES2015
language_feature: switch
task_type: conformance
area: codegen
related: [4444, 4674]
files:
  - src/codegen/annexb-cancel.ts
  - tests/issue-4772-switch-residual.test.ts
  - plan/issues/4772-es2015-switch-standalone-residual.md
---

# #4772 — ES2015 standalone switch-statement residuals

## Problem

The ES2015 closeout umbrella records an approximately 23-row long-tail cluster
under switch statements after the earlier broad switch issues (#2, #134, #162,
#198, #245, #297, and #2063) were completed. Those historical issues prove
basic lowering, fallthrough, string cases, and cross-type strict-equality
matching, but they do not disposition the current authoritative standalone
non-passes. The current edition snapshot is not sufficient evidence for this
cluster because it does not publish a dedicated switch feature row.

This issue owns a fresh exact census and the largest cohesive current root
cause. It must not reopen already-correct behavior or fold unrelated lexical,
generator, parser, or Annex B failures into one patch merely because their
fixture contains a `switch` statement.

## Implementation plan

1. Reconstruct the exact ES2015 switch cohort from the maintained runner's
   11,704-path edition filter and current standalone result rows. Include paths
   whose owned failure is switch lowering; exclude generator, async, parser,
   and unrelated binding failures after solo confirmation.
2. Rerun every candidate alone in standalone and host modes with the pinned
   Test262 checkout, QuickJS artifact, LLVM 18 toolchain, and at most two
   compiler workers. Record pass/fail/compile-error/timeout/skip counts and raw
   signatures in this issue.
3. Partition by semantic cause: discriminant evaluation/coercion, per-case
   StrictEquality, default placement, fallthrough/break completion, and lexical
   declaration/TDZ setup. Select the largest cohesive host-pass cluster whose
   fix belongs to switch lowering.
4. Add focused controls proving discriminant and case expressions evaluate
   once and in source order, case matching uses StrictEquality without a
   shared coercion domain, default may appear anywhere, and abrupt/fallthrough
   completion is preserved.
5. Implement the shared semantic fix in the owning subsystem. Keep driver and
   declaration changes to narrow wiring; do not add fixture rewrites, runner
   exemptions, host-oracle shortcuts, or skip/timeout changes.
6. Rerun the selected exact standalone and host slices, focused controls, and
   one adjacent already-passing switch control. Run mandatory repository gates
   and record exact artifacts, counts, commit SHAs, residuals, and handoff.

## Acceptance

- The candidate census has an exact denominator and every row has a solo
  disposition in both execution lanes.
- The selected cohesive cluster reaches 100% standalone and host pass with
  zero failures, compile errors, compile timeouts, or skips.
- Focused controls cover evaluation count/order, StrictEquality, default
  placement, fallthrough, break, and abrupt completion without regressions.
- Any non-switch root causes are explicitly handed off rather than hidden in
  the denominator.
- The PR follows the repository Description/CLA template and remains draft
  until its scoped implementation is complete, mergeable, and CI-green.

## Initial handoff

Start from current `upstream/main` in the isolated #4772 worktree. The roughly
23-row count in #4444 is a routing estimate from an older snapshot, not the
acceptance denominator. The first checkpoint must publish the fresh manifest
and signature partition before broad source edits.

## Exact census and artifacts

The maintained edition filter was regenerated from the authoritative raw
standalone result rows rather than inferred from the old umbrella count:

```text
PATH=/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH \
  node --experimental-strip-types scripts/generate-editions.ts \
  --results /Users/thomas/Code/js2/.test262-cache/test262-standalone-current.jsonl \
  --output .tmp/test262-editions.json \
  --test262 /private/tmp/js2-4772-es2015-switch-residual/test262 \
  --target standalone
```

That command reports the authoritative ES2015 denominator as **11,704**
paths (8,251 pass, 2,888 fail, 564 compile errors, 1 skip). The exact switch
candidate manifest is `.tmp/es2015-switch-candidates.txt` (41 paths): the 39
ES2015 rows directly under `language/statements/switch/`, plus the two strict
global-code CaseBlock rows that the content/edition partition identified as
switch-owned:

```text
language/statements/switch/tco-dftl-body.js
language/statements/switch/cptn-no-dflt-no-match.js
language/statements/switch/syntax/redeclaration/class-name-redeclaration-attempt-with-generator.js
language/statements/switch/cptn-b-final.js
language/statements/switch/cptn-b-fall-thru-nrml.js
language/statements/switch/cptn-a-abrupt-empty.js
language/statements/switch/syntax/redeclaration/function-name-redeclaration-attempt-with-generator.js
language/statements/switch/scope-lex-open-case.js
language/statements/switch/syntax/redeclaration/generator-name-redeclaration-attempt-with-generator.js
language/statements/switch/cptn-dflt-abrupt-empty.js
language/statements/switch/syntax/redeclaration/var-name-redeclaration-attempt-with-generator.js
language/statements/switch/syntax/redeclaration/generator-name-redeclaration-attempt-with-function.js
language/statements/switch/cptn-no-dflt-match-fall-thru-nrml.js
language/statements/switch/cptn-no-dflt-match-abrupt-empty.js
language/statements/switch/syntax/redeclaration/let-name-redeclaration-attempt-with-generator.js
language/statements/switch/scope-lex-open-dflt.js
language/statements/switch/tco-case-body.js
language/statements/switch/tco-case-body-dflt.js
language/statements/switch/scope-lex-close-dflt.js
language/statements/switch/cptn-dflt-final.js
language/statements/switch/cptn-dflt-b-final.js
language/statements/switch/cptn-dflt-b-fall-thru-nrml.js
language/statements/switch/syntax/redeclaration/generator-name-redeclaration-attempt-with-const.js
language/statements/switch/syntax/redeclaration/generator-name-redeclaration-attempt-with-class.js
language/statements/switch/cptn-abrupt-empty.js
language/statements/switch/cptn-no-dflt-match-final.js
language/statements/switch/syntax/redeclaration/const-name-redeclaration-attempt-with-generator.js
language/statements/switch/syntax/redeclaration/generator-name-redeclaration-attempt-with-let.js
language/statements/switch/cptn-dflt-fall-thru-nrml.js
language/statements/switch/cptn-dflt-b-abrupt-empty.js
language/statements/switch/cptn-dflt-b-fall-thru-abrupt-empty.js
language/statements/switch/cptn-b-abrupt-empty.js
language/statements/switch/cptn-a-fall-thru-nrml.js
language/statements/switch/cptn-b-fall-thru-abrupt-empty.js
language/statements/switch/cptn-a-fall-thru-abrupt-empty.js
language/statements/switch/scope-lex-close-case.js
language/statements/switch/cptn-dflt-fall-thru-abrupt-empty.js
language/statements/switch/syntax/redeclaration/generator-name-redeclaration-attempt-with-var.js
language/statements/switch/cptn-no-dflt-match-fall-thru-abrupt-empty.js
language/global-code/switch-case-decl-strict.js
language/global-code/switch-dflt-decl-strict.js
```

The authentic original-harness runner was invoked solo, sequentially (one
candidate at a time, within the two-worker limit), with the structural
must-pass/must-fail controls enabled by `harness-flip-probe`:

```text
PATH=/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH \
  node --import tsx scripts/harness-flip-probe.ts \
  --files .tmp/es2015-switch-candidates.txt \
  --out .tmp/es2015-switch-before-host.jsonl --timeout 120000

PATH=/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH \
  node --import tsx scripts/harness-flip-probe.ts \
  --files .tmp/es2015-switch-candidates.txt --target standalone \
  --out .tmp/es2015-switch-before-standalone.jsonl --timeout 120000
```

Both baseline artifacts contain 41 solo rows and the controls passed. Each
lane measured **39 pass, 2 fail, 0 compile_error, 0 compile_timeout, 0 skip**.
The same two rows failed in both lanes, with the original-harness signature
`Expected a ReferenceError to be thrown but no exception was thrown at all`:

- `test/language/global-code/switch-case-decl-strict.js`
- `test/language/global-code/switch-dflt-decl-strict.js`

The direct 39-row statement-switch subset was already green in both lanes.
Broader textual switch hits were inspected and solo-partitioned out when their
owned behavior was Proxy/RegExp or an unrelated unclassified Annex B shape;
they are not hidden in this denominator.

## Root-cause partition and implementation

The two failing rows declare a `FunctionDeclaration` directly in a strict
switch CaseBlock. In strict code this declaration is lexical to the CaseBlock;
Annex B's sloppy-only web-compat `var` binding must not make the function name
readable before or after the switch. The existing declaration walk compiled
the function but `collectAnnexBCancelSites` treated the case/default position
as an eligible Annex B declaration, allowing the flat function map to leak the
name outside the CaseBlock. This was a binding-lifetime defect, not a selector,
StrictEquality, default, fallthrough, break, or abrupt-completion defect.

`src/codegen/annexb-cancel.ts` now detects a strict `FunctionDeclaration` whose
parent is a `CaseClause` or `DefaultClause`, records a position-sensitive
cancellation site when the enclosing var scope has no independent binding, and
leaves the existing sloppy Annex B eligibility path unchanged. The existing
read-side unresolved-name path therefore emits the required `ReferenceError`
outside the CaseBlock while the ordinary declaration walk still supports
in-switch references. This aligns with ECMA-262 §14.12.2's temporary
CaseBlock lexical environment and Annex B.3.2.5/B.3.2.6's non-strict-only
extension. The earlier #4674 CaseBlock lexical-scope implementation remains
the owner of `let`/`const`/class and closure-slot setup; this patch does not
duplicate or broaden it.

## Post-fix evidence

The exact two-row post-probe artifacts are:

- `.tmp/es2015-switch-after-probe-host.jsonl`: 2/2 pass
- `.tmp/es2015-switch-after-probe-standalone.jsonl`: 2/2 pass

The complete 41-row reruns used the same manifest and commands above, writing
`.tmp/es2015-switch-after-host.jsonl` and
`.tmp/es2015-switch-after-standalone.jsonl` (adding the corresponding
`--target standalone` flag to the latter). Both controls passed and both
artifacts contain **41 pass, 0 fail, 0 compile_error, 0 compile_timeout, 0
skip**. Thus the same-base partition is 2 fail→pass, 39 unchanged pass, 0
pass→fail, and no residual in the selected switch cohort.

Focused controls are in
`tests/issue-4772-switch-residual.test.ts` and run both host and standalone
lanes (12/12 passed):

```text
PATH=/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/Users/thomas/Code/js2/node_modules/.bin:$PATH \
  node_modules/.bin/vitest run tests/issue-4772-switch-residual.test.ts \
  --reporter=verbose
```

The six controls cover: strict CaseBlock function non-leakage; selector
evaluation count and source order; StrictEquality without coercion; default
placement with fallthrough and break; abrupt completion; and an adjacent
ordinary-switch pass control.

## Acceptance and handoff

- ✅ Exact denominator: 41 switch-owned ES2015 candidates, each run solo in
  host and standalone lanes.
- ✅ Selected strict CaseBlock declaration cluster: 2/2 baseline failures
  fixed, 41/41 post-fix in both lanes, with no compile errors/timeouts/skips.
- ✅ Focused semantic controls: 12/12; the adjacent control remains green.
- ✅ No pass-to-nonpass transitions; no residuals in the selected cohort.
- ✅ Test262 checkout was provisioned through
  `scripts/provision-worktree-deps.sh`; no Test262 gitlink content was staged.

The broader ES2015 edition still contains unrelated residuals outside this
switch-owned 41-row slice; those remain with their owning issues and are not
claimed by #4772. The implementation and evidence are handed off to PR #5047
(`https://github.com/loopdive/js2/pull/5047`), which must remain draft until
the current-main reconciliation and required CI are green. No merge or
auto-merge is part of this handoff.
