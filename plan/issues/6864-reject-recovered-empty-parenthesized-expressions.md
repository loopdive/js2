---
id: 6864
title: "Reject parser-recovered empty parenthesized expressions before code generation"
status: ready
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
