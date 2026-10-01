---
id: 6789
title: "codegen: calling an extracted object-literal method (`const m = obj.m; m()`) traps with an uncatchable null dereference — regression of #2025"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: this-binding
goal: crash-free
related: [2025, 1671, 1669, 1672]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H7"
---

# #6789 — `#2025` regressed: the trampoline's null-`this` branch has no throw arm

## Problem

```ts
const obj = { x: 1, m() { return this.x; } };
const m = obj.m;
try { m(); } catch (e) { log("caught " + (e instanceof TypeError)); }
```

wasm: `RuntimeError: dereferencing a null pointer` in
`__obj_meth_tramp___anon_0_m_1`, escaping the `try/catch` and killing the
instance. JS: `TypeError` (strict) or `undefined` (sloppy `this` → global),
either way catchable. #2025 (done) fixed exactly this shape; the review's
probe on `e303c5c7` reproduces it again.

## Root cause

`src/codegen/closures/method-trampolines.ts:254`:

```ts
if (currentThisGlobalIdx < 0) return nullThis;
```

returns the null receiver straight into the method body, which dereferences
it. The catchable-`TypeError` arm at `:236-282` covers the other trampoline
paths but not this early return.

## Correction

At `:254`, instead of returning `nullThis`, emit the same catchable
`__new_TypeError("Cannot read properties of undefined")` throw the sibling
arm uses (or, when the module is compiled in sloppy mode and the method does
not touch `this`, the sloppy-global receiver). Add a guard test to
`tests/guard-suite.json` so the next regression is caught by a required
check — #2025's own test evidently is not in the pinned/guard sets (see
#6783).

## Acceptance

- The probe logs `caught true`; the instance survives and later exports still
  work.
- Class methods extracted the same way (`const f = inst.method; f()`) behave
  identically (they may already; assert it).
- The regression test is added to `tests/guard-suite.json`.
