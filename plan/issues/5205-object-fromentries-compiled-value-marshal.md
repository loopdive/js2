---
id: 5205
title: __object_fromEntries hands a compiled value straight to the host — "object is not iterable" blocks Temporal module init
status: ready
sprint: current
priority: high
horizon: s
goal: standalone-gap
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
---

# #5205 — `__object_fromEntries` does not marshal compiled iterables

## Problem

Seventh Temporal module-init blocker (#4628 Option A). On a probe tree with
#5252 + #5256 + #5258 + #5262 (+#5264), the polyfill bundle advances past
`__clz30` and stops at:

```
TypeError: object is not iterable (cannot read property Symbol(Symbol.iterator))
```

Stack: `Object.fromEntries → src/runtime.ts:14436 → __module_init`.
`moduleInitRuns` stays `false`.

## Mechanism (located by dev-5203)

The handler is a one-liner that hands the compiled value straight to the
host `Object.fromEntries`, which needs `Symbol.iterator`; an opaque WasmGC
vec has none:

```ts
if (name === "__object_fromEntries") return (iterable: any): any => Object.fromEntries(iterable);
```

Its immediate neighbour `__object_assign` DOES marshal
(`_isWasmStruct(s) ? _wrapForHost(s, exports) : s`). Expected to be a
small, well-scoped fix — the same marshalling shape as the neighbour, plus
the #5193/#5202 start-export channel so it also works during the init
window (the failing call IS at init).

## Acceptance criteria

1. Reduced repro: `Object.fromEntries` over a compiled array of pairs, at
   module init AND after init, host lane; new tests/issue-5205-*.test.ts
   failing on base, passing with fix.
2. Temporal harness advances past this error on the full probe stack. New
   later blocker → file it (coordinator allocates ids); `moduleInitRuns`
   true → say so LOUDLY.
3. No regressions in issue-5193/5202/5203 test files + Object.fromEntries /
   Object.assign scoped runs (name them). Gates green.

## Notes

- Blocker chain: #5191 → #5193 → #5201 → #5202 → #5203 → (#5204 capability)
  → this.
- Stack on PR #5264's branch (issue-5204-bridge-f64-params) — sanctioned
  predecessor-stacking; lands after #5252 → #5258 → #5262 → #5264.
- Id #5205 reserved with a degraded PR scan (gh offline); manually verified
  against open PR head branches 2026-08-29. `check:issue-ids:against-main`
  arbitrates.
