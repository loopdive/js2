---
id: 2005
title: "template literal interpolation stringifies booleans as '1'/'0' and undefined as '0' (i32 spans bypass emitBoolToString)"
status: done
completed: 2026-06-12
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: template-literals
goal: core-semantics
related: [1931, 2006]
origin: "2026-06-10 spec-conformance sweep (strings agent): verified on main"
---

# #2005 — compileTemplateExpression lacks the boolean/undefined branches

## Problem

```ts
const b = true;      `b=${b}`   // wasm: "b=1"   node: "b=true"
const u = undefined; `u=${u}`   // wasm: "u=0"   node: "u=undefined"
```

Also `${false}` → "0". Plain `"" + b` concatenation is correct.

## Root cause

`src/codegen/string-ops.ts:272-284` (`compileTemplateExpression`) — every
i32 span goes through `f64.convert_i32_s` + `number_toString` with no
`isBooleanType` check. The binary `+` concat path has the fix
(string-ops.ts:1461/1538 `emitBoolToString`); the template path never got
it. The undefined half (also reproducible in plain concat: `"u=" + u` →
"u=0") is the undefined-lowers-to-type-default family (#1931).

## Fix direction

Mirror the `emitBoolToString` branch in the template span loop; route
undefined-typed spans to the literal `"undefined"` constant.

## Acceptance criteria

- `${true}`/`${false}`/`${undefined}` match Node in templates and concat
- Numeric spans unchanged

## Dupe check

#183 (done, wasm-validation only); #1931 same family different trigger.
New.

## Frontmatter reconcile (2026-06-12)

Fixed by merged PR #1321; frontmatter was stale at `ready`. Flipped to `done` during sprint-62 planning triage.
