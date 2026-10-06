---
id: 6864
title: "Reject parser-recovered empty parenthesized expressions before code generation"
status: in-progress
sprint: backlog
created: 2026-10-06
updated: 2026-10-06
priority: high
horizon: s
complexity: M
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: compiler, parser
language_feature: early-errors
es_edition: es3
goal: ir-full-coverage
model: gpt-6.1-sol
parent: 3518
related: [3525, 537, 736, 4621]
loc-budget-allow:
  - src/compiler/early-errors/node-checks.ts
files:
  - src/compiler/early-errors/node-checks.ts
  - tests/issue-6864-empty-parenthesized-expression.test.ts
---

# Reject parser-recovered empty parenthesized expressions

The public compiler accepts syntactically invalid source after TypeScript
recovers a missing expression inside parentheses. The TS1109 diagnostic is
demoted to a warning, `success` is true, and the emitted helper later throws a
ReferenceError. The source must instead receive a located compile error before
code generation. Preserve the intentionally permissive semantic/type warning
policy and supported generated preludes.

## Observed reproducer and authority

```ts
export function broken(value: number): number {
  return (;
}
```

Exact source SHA256:
`52e2153ae3a071386f70358fd68a58208d0a66727786728bed85b3db52f066d5`.
On canonical main `4d42eec28e0aafbf242bb37150ca5ecac02136f0`, plain public
`compile(source, { target: "gc", moduleName: "failed.ts", sourceMap })`
returns `success: true` with TS1109 at start58/length1, severity warning,
line2/column11, in both source-map modes. No caller skip-semantic or permissive
syntax option was supplied. Actual generated-helper invocation `broken(2)`
throws ReferenceError; this is not an engine-validation failure.

The read-only discovery retained both raw results and original failed observer
assertions in the source-map capture worktree. Frozen report: 339651 bytes,
SHA256 `bf3574475767a25e646c7be305f1c501eb662b77818feab3c68a151096f5da59`.
Independent bounded syntax triage: 12334 bytes, SHA256
`af4d6b972f1285e79ad364c99ad1be518424c4a286d0f372e771c02af4f80121`.
Those local artifacts are discovery evidence; no regression fix or passing
syntax-guard suite is claimed. The SourceMap recorder change does not fix this
independent parser defect.

## Implementation plan

At this base, `src/compiler.ts` and
`src/compiler/import-manifest.ts` deliberately tolerate/downgrade TS1109 under
the historical #537 policy. Do not remove that global tolerance or promote all
TypeScript semantic diagnostics to errors. The existing #4621 switch/case
checks in `src/compiler/early-errors/node-checks.ts` already detect required
expressions that TypeScript replaced with a missing node.

Extend that narrow early-error visitor for a `ParenthesizedExpression` whose
required inner expression is the parser-created missing expression. Pure
TypeScript parsing of the reproducer yields a parenthesized node56..58 and a
missing identifier58..58. Use the existing missing-node helper/diagnostic
convention where appropriate; require actual malformed AST/source evidence,
not every zero-width generated node. Preserve valid empty function argument
lists, arrow parameter parentheses, `return;`, genuine parenthesized values,
semantic warnings and existing switch/case behavior. Do not replace the
reproducer or use a late runtime ReferenceError as acceptance.

## Acceptance

- The unchanged reproducer fails with a stable located compile error in public
  single/multi/file entry points and with maps requested/unrequested. It
  publishes no successful binary/WAT/helper/source-map artifacts.
- Valid parenthesized expressions, empty calls/arrow parameter lists,
  `return;`, existing semantic-warning behavior and #4621 controls remain.
- The genuine private prepared path cannot treat the recovered missing
  expression as a supported source unit or silently fall back to legacy.
- Add focused real public/private regression tests, run their actual strict
  collection/body and affected early-error tests, native typing and normal
  gates/hooks. Preserve original discovery failures and fixtures.

This issue is filed in `plan/issues`, with ID6864 reserved on canonical
`issue-assignments` after a fresh named-upstream scan. No GitHub issue exists
for it. Implementation is not dispatched by the SourceMap prerequisite.

## Source implementation evidence

The narrow parenthesized-expression registration adds seven lines (2351 to
2358), reusing the existing missing-node predicate. Native source typing,
scoped lint/format and the function budget pass. The original LOC refusal is
preserved; this issue grants only the measured seven-line growth in
`src/compiler/early-errors/node-checks.ts`, without changing the baseline.
Eight genuine parser/early-error controls pass; public/private regression
acceptance remains separately pending.

## Located source identity correction

The independent candidate-1 suite observed 9/25 passing rows and 16 failures
solely at the new filename expectation: rejection, exact line/column and zero
artifacts were already correct. The new parenthesized diagnostic now includes
the actual `ctx.sourceFile.fileName`, using the existing structured error
shape and `ctx.pos(node)`; all other diagnostics retain their prior shape.
This supersedes the seven-line measurement above: the complete registration
adds twelve lines (2351 to 2363). Native typing, scoped lint/format, function
budget and eight genuine AST controls pass. The LOC gate recognizes the
existing path allowance for +12, explicitly approved by root for this revised
measured growth on this path only. The original candidate-1 failures remain
preserved, and independent candidate-2 runtime acceptance is pending.

The unchanged valid-arrow baseline fixture remains a separate IR coverage gap.
Public single-source WasmGC executes `calculate(7)` as 32 and `finish()` as
undefined. Both genuine private host targets return located typed unsupported:
WasmGC cannot materialize the lifted closure parameter carrier, and Linear
rejects the closure type plus `closure.new`/`closure.call`. Public Linear also
rejects the arrow. This belongs to [IR-only R3: compile-once classes, members,
and closures](3522-ir-r3-classes-closures-compile-once.md); [Linear backend
consumes the IR front-end: wire the selector + LinearEmitter into
generateLinearModule](2956-linear-backend-consumes-ir.md) explicitly defers
closures. No parser-scope expansion or closure implementation is claimed.
The bounded triage retains its unawaited initial public-observer attempt,
missing-import multisource instantiation and census-printer error separately;
none is credited as successful runtime evidence.

## Independent regression acceptance — 2026-10-06

The final unchanged25-case suite collects25 and executes25/25 (actual child
39504, exit0), covering public single/multi/files and genuine private paths,
both host targets and both map flags. The new error has the exact source
filename, line2/column10; rejected transactions publish zero successful
binary/WAT/declaration/helper/map artifacts. Healthy controls genuinely
execute numeric parentheses, empty direct calls and void returns on both
targets; exact arrow source syntax and public GC execution remain separate.
Existing semantic-warning and required switch/case controls remain.
Unchanged ordinary issue736 affected suite42/42 (child39679, exit0); these
are67 distinct cases, not Test262, complete IR equivalence or CI delivery.
Native TS7, Biome and formatting pass; exact7670 before/list/body custody
vectors hold. Final receipt163117/SHA256
`d660317c3c8e3b16ac09766b2deb7ecf0b61ed5d32e51faefec40538d3d99c77`.

Retained original23 prototype6pass/17fail includes the independent Linear
arrow limitation. Its exact source and failed fixture remain; an explicitly
recorded new-test split separates syntax acceptance from unsupported runtime
capability. Final25 original-source baseline9pass/16fail and epoch1 file
absence9pass/16fail remain byte-frozen. Epoch2 uses THE SAME frozen25 test
bytes7902/SHA256
`21eac491009ffdab2342be90714b727dd690a07b6c262e93644af08aa1d5e60b`;
no malformed-source assertion or existing test was weakened. The source
110407/SHA256
`50b584800b0f810aa871e0db9b048350c526702ee2e9f71e8b7ec93f7cc85ee0`
adds exactly12lines on the approved path; other diagnostic shapes stay exact.
Root publication/normal hooks/protected main verification remain required;
this issue is not marked delivered from local tests.

Root integration independently collected/executed the exact new25 plus the
inherited recursive-recorder13:38/38, exit0 with14,868 tracked/harness input
records unchanged. This explicitly exercises the changed-root set even if the
normal inherited >32 changed-root lane self-skips. Actual canonical main and
recorder parent were freshly verified: main4d, PR6507 still OPEN at exactf0.
Dependency-first protected delivery remains pending; root does not claim a
main merge or completed IR migration from this checkpoint.


## Main composition and delivered recorder dependency (2026-10-06)

Recorder PR6507 is delivered as 7e11e5d5ff916e9e48897d3daa695c51ccf5881b, ancestral to exact main76e559f46687617b8e103560818fbea2a9eadc46. Both binary recorder and its13-case test match the delivered90a source bytes and modes. This existing parser PR6509 merges that exact main without conflicts; its source and25-case regression test remain byte-identical to aa42e3b0df5dff214441ced5e2b5013affc3b6f2, and the old42-case parser cohort remains intact.

Independent main-composed verification executes the same25 new +42 existing +13 recorder cases:80/80, collection and ordinary child exits0, full14887-input before/list/body custody equal, no ordinary errors or pending cases. Evidence is retained in source-capture-tests worktree .tmp/source-map-source-capture/6509-main-composed-verification/actual. This proves this cohort, not full conformance or full IR migration. Public legacy remains retained. Normal commit/pre-push checks and protected exact-head admission are still required; only verified main delivery completes the narrow claims.
