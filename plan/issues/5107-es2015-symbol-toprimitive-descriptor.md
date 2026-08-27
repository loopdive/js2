---
id: 5107
title: "Standalone Symbol prototype toPrimitive descriptor"
status: in-progress
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: s
feasibility: medium
task_type: conformance
area: codegen
language_feature: Symbol.prototype[Symbol.toPrimitive]
es_edition: 2015
goal: standalone-mode
sprint: current
assignee: "ttraenkler/codex-es2015-next-lane-a"
related: [4743, 4776]
---

# 5107 — standalone Symbol prototype toPrimitive descriptor

## Scope and baseline evidence

The implementation branch starts at upstream `main` commit
`caeaa2e1cf2aa225297c53076d27f97c8449a527`. The fresh authoritative baseline
JSONL snapshot was fetched on 2026-08-28 from the maintained baseline source;
the exact row carries oracle version 13 and the honest lane in both snapshots.

Claimed row:

```text
test/built-ins/Symbol/prototype/Symbol.toPrimitive/prop-desc.js
```

Baseline verdicts (the test is reached and runs under both strictness modes):

| lane | snapshot row timestamp | verdict | diagnostic |
| --- | --- | --- | --- |
| JS-host | 28.8.2026, 00:44:49 | pass | — |
| standalone | 28.8.2026, 00:58:11 | fail | `Test262Error: Symbol() should be an own property` |

This is a one-row residual selected after the requested neighboring Reflect
row was rechecked: `test/built-ins/Reflect/Symbol.toStringTag.js` is already
standalone-pass and is covered by the existing namespace metadata plan. The
current row has no exact path mention in an existing plan.

## Problem

In standalone mode, `Symbol.prototype[Symbol.toPrimitive]` is not exposed as
an own property with the ES2015 descriptor `{ writable: false,
enumerable: false, configurable: true }`. The host lane's primordial Symbol
prototype supplies the property, while the native-symbol standalone carrier
does not currently present the corresponding prototype metadata to
`verifyProperty`.

The fix must preserve the well-known-symbol identity and the existing native
Symbol value/`valueOf` behavior. It must not broaden generic ToPrimitive
coercion or alter unrelated Symbol prototype methods.

## Implementation plan

1. Trace the standalone Symbol prototype construction/read/descriptor paths
   and identify the narrow missing `@@toPrimitive` own-property metadata seam.
2. Add the smallest standalone-only metadata or descriptor arm at that seam,
   using the existing native Symbol key mapping and canonical descriptor
   flags. Keep host behavior and generic Symbol coercion byte-stable.
3. Add focused regression coverage for the claimed Test262 row plus exact
   descriptor, identity, read, and deletion controls. Verify that deletion
   does not make an inherited or synthetic property appear as an own property.
4. Run paired authoritative host and standalone rows with repeats and
   controls using no more than two workers; record exact counts, transitions,
   and scoped type/lint/oracle gates here before handoff.

## Acceptance criteria

- The claimed row is pass in both host and standalone lanes.
- Standalone descriptor flags and `Symbol.toPrimitive` identity match the
  Test262 expectations, including own-property and delete controls.
- The paired run has exactly one standalone fail-to-pass transition, zero
  pass-to-fail transitions, zero compile errors/timeouts/skips, and repeat
  determinism.
- No new standalone host imports are introduced and no unrelated Symbol
  ToPrimitive coercion behavior changes.
- The branch contains one focused regression test, this md-only plan, and one
  compliant upstream PR when all local gates are complete.

## Test results

Pending implementation.

## Handoff

Worktree: `/private/tmp/js2-es2015-next-lane-a-20260828`

Branch: `codex/es2015-next-lane-a`

Tracking is intentionally md-only; no GitHub issue is created for this lane.
