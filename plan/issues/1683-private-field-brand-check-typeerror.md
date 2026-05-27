---
id: 1683
title: "Private field brand-check TypeError for non-brand receiver — residual 6 of 17 privatefield*-typeerror tests"
status: ready
created: 2026-05-27
updated: 2026-05-27
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: class, class-fields-private, brand-checks
goal: spec-completeness
sprint: Backlog
related: [1365, 1456, 1680, 1681]
test262_fail: 6
---
# #1683 — Private field brand-check TypeError for non-brand receiver

> NOTE on numbering: tech lead assigned this as "#1682-brand", but `#1682`
> was already claimed for an unrelated concern (derived-constructor
> super-must-be-called, task #156). Filed under **#1683** to avoid the
> collision.

## Problem

When `obj.#x` is accessed where `obj` does not carry the brand of the class
that declared `#x`, ES2022 §15.7 (`PrivateFieldGet` / `PrivateFieldSet` /
`PrivateFieldAdd`) mandates a **TypeError**. The compiler implements a partial
brand check (#1365, `src/codegen/property-access.ts:998-1074`) which already
covers most cases.

## Current state (probe on main @ 4025b87b3)

Probed all 17 `privatefield(get|set|add)-typeerror-*.js` in
`language/statements/class/elements` via `runTest262File`:

**11 / 17 already PASS.** Only **6 fail**, in two distinct buckets:

### Bucket A — `returned 2` (TypeError not thrown), 3 tests — NEEDS REPRESENTATION CHANGE
- `privatefieldget-typeerror-1.js` — `class C { y = this.#x; #x; }` — field
  initializer reads `#x` **before** `#x` has been added to `this`.
- `privatefieldset-typeerror-1.js` — same, write form (`y = this.#x = 1`).
- `privatefieldadd-typeerror.js` — `[[PrivateFieldAdd]]` of `#x` to a receiver
  that **already has** `#x` (via a returned-`this` super trick) must throw.

These are NOT brand (`ref.test`) failures: the receiver IS a valid `C` struct.
They require modeling the spec's `[[PrivateFieldValues]]` **add/presence**
state — i.e. "has `#x` been added yet?" Our representation allocates the struct
with **all** fields present at construction, so there is no "not-yet-added"
state to observe. Implementing this needs a per-private-field presence bit (or
a separate add-set) threaded through struct layout, constructor field-init
codegen, and every private read/write/add site. Multi-day, architectural —
this is the `[[PrivateFieldAdd]]` slot the spec describes. **Needs architect
spec.**

### Bucket B — `compile_error` (invalid Wasm), 3 tests — HARNESS-ENTANGLED, == #1681
- `privatefieldget-typeerror-3.js` — `type error in fallthru[0]`
- `privatefieldget-typeerror-5.js` — `any.convert_extern[...]`
- `privatefieldset-typeerror-5.js` — `type error in fallthru[0]`

All three are the **nested-shadowed-private-name** shape: both `Outer` and the
inner `class extends Outer` declare `#x` (with **divergent field types** —
`42:number` vs `'not42':string`), and `#x` is read through `this` / a captured
`self` from inside the inner class's method.

**The brand-check codegen itself is correct** — a minimal standalone repro of
`-3` (`.tmp/r3.ts`) compiles to valid Wasm and returns `42`. The invalid Wasm
appears **only under the test262 harness wrapper** (`wrapTest`), which nests
the class declarations inside `function test()`. This is the same
harness-specific codegen interaction already documented in **#1681**
("the RUNFAIL only reproduces under the full test262 harness, not in any
minimal standalone repro"). Root cause is the closure-receiver / nested-class
lowering shared with #1681, plus the divergent-field-type `if`-block result
type in the #1365 brand path (the `then` arm returns the declaring class's
field type, but the two shadowed `#x` slots have different Wasm types).

## Recommendation — ESCALATE / carve, do NOT fix as a localized dev task

- **Bucket A (3 tests)**: fold into a new architect-spec issue for private-field
  **add/presence** representation (relates to #1365 brand-checks, #1456
  read-only TypeError). Not localized.
- **Bucket B (3 tests)**: **merge into #1681** — same nested-class /
  closure-receiver lowering bug, same "only-under-harness" signature. Add the
  divergent-shadowed-field-type `if`-block result-type fix to #1681's scope.

Net: 0 tests are fixable by a self-contained <2-day change. The 11 passing
tests confirm the #1365 brand check is already doing the bulk of the work; the
6 residuals are the two genuinely hard tails.

## Reproduce

```bash
# in a worktree with test262/test linked:
npx tsx .tmp/probe-brand.mts   # buckets the 17 tests by status
```

Probe scripts: `.tmp/probe-brand.mts`, `.tmp/probe-one.mts`, `.tmp/r3.ts`,
`.tmp/c3.mts`, `.tmp/wrapcheck.mts`.
