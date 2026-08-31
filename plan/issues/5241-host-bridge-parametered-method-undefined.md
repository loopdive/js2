---
id: 5241
title: "A compiled-class method with a declared parameter, reached through the host bridge on an Object.create-built instance, answers undefined — Temporal .from(…).add({days:1})"
status: done
completed: 2026-08-31
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-31
# Growth grants, 2026-08-31 (#5241). This branch is STACKED on the not-yet-
# merged #5221→#5239 chain, so every gate baseline is still main's: growth that
# predecessor PRs already granted in their own issue files re-surfaces here
# until those PRs land and the baselines refresh post-merge. The entries below
# are that inherited set plus this fix's own additions to the arity-selected
# class-member bridge (emission in class-bodies.ts, selection in runtime.ts).
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/index.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/index.ts::emitIteratorMethodExport
  - src/codegen/index.ts::generateModule
  - src/runtime.ts::resolveImport
---

# #5241 — arity-selected host bridge drops parametered method calls

## Problem

After #5239 (PR #5347), zero-argument members on an
`Object.create(C.prototype)`-built instance dispatch correctly (`.toString()`,
getters), but a method WITH a declared parameter answers `undefined` instead
of calling: `Temporal.PlainDate.from("2020-03-04").add({days: 1})` →
`undefined`. Control (dev-5239): identical on the long-standing *syntactic*
`Object.create(C.prototype)` path (`makeStatic(…).add(1)`, plain
single-module program), so it predates #5239 and is a distinct defect in the
arity-selected `__class_call_<key>_<n>` dispatch surface — the n>0 arm is
either not emitted for these members or not selected by the host resolver.

test262 Temporal arithmetic rows (`add`/`subtract`/`with`/`until`/`since`)
all take arguments, so this now bounds provider conformance alongside
#5225/#5226.

## Direction

Reduce with a plain class (`class K { add(n) { return this.v + n; } }`),
instance built via `Object.create(K.prototype)` (both spellings), method
called through the host bridge. Inspect which `__class_call_add_<n>` exports
exist and what `_resolveClassMember` selects for a 1-arg call; fix at the
emission or selection site, whichever is missing. Mind #5237's
`selectBridgeReceiver` (receiver must be the instance) and the #3903 hot
path.

## Acceptance criteria

1. Plain-class reduction answers correctly for 1- and 2-arg methods, both
   Object.create spellings, single-module and linked lanes; new
   `tests/issue-5241-*.test.ts` failing on base with controls.
2. `Temporal.PlainDate.from("2020-03-04").add({days: 1}).toString()` →
   `"2020-03-05"` through the provider; flip/assert harness rows.
3. No regressions in issue-5239/5237/5223/5221/4628 + linker family;
   equivalence gate at baseline. Gates green.

## Notes

- Found by dev-5239 (PR #5347 "Reported, NOT fixed") with the pre-existing
  control. Related family: #5223 (accessor-read bridge), #5237 (receiver
  selection), #5239 (instance minting).
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
