---
id: 5203
title: Dynamic static-method dispatch during module init — `_wrapForHost` needs exports, so `JSBI.__clz30(t)` throws in the init window
status: ready
sprint: current
priority: high
horizon: m
goal: standalone-gap
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
---

# #5203 — init-window dynamic static-method dispatch (closure/`_wrapForHost` facet)

## Problem

Fifth Temporal module-init blocker (#4628 Option A). With #5191 (merged),
#5193 (PR #5252), #5201 (PR #5256) and #5202 (PR #5258) applied, the
polyfill bundle advances past `__clzmsd` and stops at:

```
TypeError: __clz30 is not a function
```

`jsbi.mjs` calls `JSBI.__clz30(t)` — a STATIC method on the builtin-derived
class, reached dynamically — during module init. `moduleInitRuns` stays
`false`.

## Reduced repro (from dev-5202, with after-init control)

```ts
class D extends Array {
  constructor(n: number) { super(n); }
  static clz(): number { return 9; }
}
function g(c: any): number { return c.clz(); }
const A: number = g(D);                              // THROWS: clz is not a function
export function test(): number { return g(D); }      // 9 — the control
```

Same family as #5193/#5202 (works after init, throws during it), different
surface: a static reaches the host as a raw closure struct in the
`__register_class_static_method` sidecar, and `_wrapForHost` needs `exports`
to turn it into a callable — the CLOSURE facet, not the dispatch-export
facet #5202 closed. Statically-resolved static calls (`D.clz()` written
directly) already work at init and are unaffected.

## Direction

Extend the #5193/#5202 start-exports channel to whatever export(s)
`_wrapForHost` needs, OR route init-window closure wrapping through the
registered funcrefs. Caution from dev-5202: `_wrapForHost`'s export argument
feeds a lot of unrelated behaviour — widening it deserves its own
measurement; keep the late path untouched and standalone/WASI out of scope.

## Acceptance criteria

1. Reduced repro above: `A === 9` at init, control still 9; new
   tests/issue-5203-*.test.ts failing on base (= the #5202 stack), passing
   with fix.
2. Temporal harness advances past `__clz30` on a probe tree with
   #5252+#5256+#5258+this. New later blocker → file it (coordinator
   allocates ids); `moduleInitRuns` true → say so LOUDLY.
3. No regressions in issue-5193/5201/5202 test files + scoped
   static-method/class runs (name them). Gates green.

## Notes

- Blocker chain: #5191 → #5193 → #5201 → #5202 → this.
- Stack on PR #5258's branch (issue-5202-init-window-prototypes) —
  sanctioned predecessor-stacking; lands after #5252 and #5258.
- Sibling issue #5204 covers the NON-timing parameter-bridge gap that will
  hit right after this (methods with arguments).
- Id #5203 reserved with a degraded PR scan (gh offline); manually verified
  against open PR head branches 2026-08-29. `check:issue-ids:against-main`
  arbitrates.
