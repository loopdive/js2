---
id: 5355
title: "`Intl.DateTimeFormat` is a shell — the constructor yields a value that is `=== undefined` with typeof 'object'; format()/formatToParts() return undefined (66 of 123 Temporal calendar rows)"
status: done
sprint: current
priority: high
horizon: l
goal: standalone-gap
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-06
assignee: ttraenkler/dev-5355
completed: 2026-09-06
# 2026-09-06 (#5355): the fix is ONE extern-class registration, and it has to
# live in the registry that owns "which extern classes exist" — the same block
# that already registers its two siblings `Intl.ListFormat` and
# `Intl.NumberFormat`. 36 of the lines are the rationale comment (why the typed
# spelling missed, and why this one entry is host-lane-gated when the siblings
# are not); the table itself is 12. Splitting one sibling entry out of a
# sibling list into a new module would make the list harder to read, not easier.
loc-budget-allow:
  - src/codegen/extern-declarations.ts
  - src/codegen/expressions/new-super.ts
  - src/runtime.ts
# 2026-09-06 (#5355): `compileNewExpression` grows by the 8-line dispatch hookup
# only — the standalone-refusal LOGIC lives in the new
# `src/codegen/expressions/new-intl-host-bridge.ts`. The arm must sit at this
# exact point (immediately before the terminal `reportError`) so it can only
# fire where every other arm declined, so it cannot be lifted out of the
# function. `registerBuiltinExternClasses` and `resolveImport` are the sibling
# lists described above.
func-budget-allow:
  - src/codegen/extern-declarations.ts::registerBuiltinExternClasses
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/runtime.ts::resolveImport
---

# #5355 — `Intl.DateTimeFormat` exists but does nothing

## Problem

#5206 provided the `Intl` global (its title: "Intl is not provided at all")
and is `status: done`. What landed is a SHELL. Measured by dev-5250 and
dev-5251 from a compiled consumer with no Temporal involved:

```
typeof Intl                                                    "object"
typeof Intl.DateTimeFormat                                     "function"
new Intl.DateTimeFormat("en-US").resolvedOptions()             undefined   (node: object)
new Intl.DateTimeFormat("en-US",{timeZone:"UTC"}).format(d)    undefined   (node: "1/1/2024")
new Intl.DateTimeFormat("en-US",{timeZone:"UTC"}).formatToParts(d)
      → single-module: RuntimeError: dereferencing a null pointer (a Wasm trap)
      → linked lane: `TypeError: invalid receiver`
```

The polyfill's `getCalendarParts` wraps `formatToParts` in
`try { … } catch { throw new RangeError("Invalid ISO date: …") }`, which is
where the reported error is minted. **66 of the 123 #5249 calendar rows** end
here after the dispatch/value layers were cleared (PRs for #5352/#5250/#5251).

Bound (dev-5251): only calendars whose `isoToCalendarDate` is pure arithmetic
(gregory, japanese, roc) can pass without real ICU; buddhist, indian, ethiopic
and coptic need `formatToParts` to return real calendar parts.

## Implementation Plan (Fable, 2026-09-06)

1. **Decide the capability shape** (this is the design call, do it first and
   write it down): the JS-host lane can forward `Intl.DateTimeFormat` to the
   HOST's real `Intl` through an externref bridge — construction, `format`,
   `formatToParts`, `resolvedOptions` as host-mirror calls with the receiver
   kept as an opaque externref. That is the #679/#682 dual-backend pattern:
   host fast path now, a standalone fallback declared out of scope with its
   bound (no ICU in pure Wasm). Do not attempt ICU in Wasm here.
2. **Find why the constructor answers `undefined`**: the #5206 implementation
   exists — read its issue file and PR; find the branch that yields a value
   `=== undefined` but `typeof "object"` (a boxed-null externref? a
   `ref.null.extern` default from a missing host import?). The
   single-module null-deref trap vs the linked `invalid receiver` says the two
   lanes take different paths; unify on the host bridge.
3. **Reduction** covering the four calls above, both lanes; base-failing.
4. **Measure** `family-123.txt` provider-linked; expect the 66 to move (the
   ICU-needing calendars only if the host bridge carries real parts — say
   which did and which did not).

## Acceptance criteria

1. `new Intl.DateTimeFormat(...)` is an object; `format`/`formatToParts`/
   `resolvedOptions` return node-equivalent values on the JS-host lane.
2. Standalone: a clear thrown `TypeError`/unsupported, never a trap, with the
   bound recorded.
3. 123-row re-measurement with counts.

## Notes

- Follow-up to #5206 (done: the global exists; this: it must work).
- Filed from dev-5250/dev-5251 measurements, 2026-09-06.
- Id reserved via `claim-issue --allocate` with a degraded open-PR scan.
