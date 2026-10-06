---
id: 6819
title: "runtime: an `any`-typed receiver bypasses DOM containment (`(el as any).appendChild(outside)` escapes the domRoot), and the containment tests are red on main (dom-containment 4/19, issue-4576/4577 14/28)"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: runtime
language_feature: dom
goal: correctness
related: [6792, 4576, 4577]
requested_by: ttraenkler/claude-review
origin: "found by the #6792 implementation (2026-10-02) while removing src/runtime-containment.ts; test counts are its measurement on 9d977a7e, not re-measured by the filer"
---
# #6819 — containment must live at the host-import boundary, not in the static type

## Problem

#6792 made the containment refuse outward mutations on `domRoot` itself. The
check keys on the receiver's static type: when the receiver is `any` (a value
from `querySelector` cast, `JSON.parse`, a host import typed `any`) the
compiler emits the plain host call and the mutation reaches a node outside the
root. Containment that can be switched off with a cast is not containment.

The same implementation measured the containment suites red on main before
its change: `tests/dom-containment.test.ts` 4 of 19 failing,
`tests/issue-4576-*.test.ts` + `tests/issue-4577-*.test.ts` 14 of 28 failing —
pre-existing, not caused by #6792.

## Correction

1. Enforce containment inside the DOM host-import shims (`src/runtime.ts` /
   the DOM import table): every mutating method the shim exposes checks that
   the target is inside the configured root, whatever the compiled call site
   knew about the type. The static-type fast path can stay as an optimisation
   that skips the check only when the compiler proved the receiver is inside.
2. Triage the red tests: each failing case is either a real gap (fix) or a
   stale expectation (update with a reason in the test).

## Acceptance

- `(el as any).appendChild(outsideNode)` and `(outside as any).innerHTML = …`
  are refused exactly like the typed forms (same error class and message).
- `tests/dom-containment.test.ts`, `tests/issue-4576-*.test.ts`,
  `tests/issue-4577-*.test.ts` green or each remaining failure excused by name.
