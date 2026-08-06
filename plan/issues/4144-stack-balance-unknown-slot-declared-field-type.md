---
id: 4144
title: "stack-balance: unknown stack slot typed from the struct field's declared type — supertype value fails validation"
status: ready
sprint: Backlog
priority: medium
goal: core-semantics
feasibility: medium
horizon: m
created: 2026-08-03
requested_by: ttraenkler/claude-bench
related: [4088, 4139]
func-budget-allow:
  - src/codegen/stack-balance.ts::updateTypeStack
loc-budget-allow:
  - src/codegen/stack-balance.ts
---

# #4144 — stack-balance temp typed from declared field type breaks on supertype values

## Problem

`stack-balance.ts`'s struct.new arg-coercion fixup saves the top N stack
values into temps typed from its inference:

    const actualType = widenPackedToI32(fieldTypes[fi] ?? fields[fi]!.type);

When inference has NO type for a slot (`fieldTypes[fi]` null — e.g. the value
crossed a control-flow join), the temp falls back to the **field's declared
type**. If the runtime value is a SUPERTYPE of the field type, the emitted
`local.set` fails engine validation:

    __closure_0: local.set[0] expected type (ref null 7),   ;; $NativeString
                 found local.tee of type (ref null 6)       ;; $AnyString

Observed compiling acorn 8.18 UMD on --target standalone (function #1612,
after the #4088 + #4139 fixes cleared the four defects ahead of it).

## Two layers

1. **The balancer's fallback is unsound**: a temp for an UNKNOWN slot must be
   typed to hold whatever arrives (or the slot's coercion must be resolved
   from the true type), never narrowed to the field's declared type.
2. **The upstream producer is the real defect**: the pre-fixup code was
   already passing an `$AnyString` where the struct field is declared
   `$NativeString` — the producer should have flattened (Cons → Native)
   before construction. The balancer only moves the failure earlier.

## Progress

**Root cause found and fixed 2026-08-03 — it was neither of the two layers
above.** Inference had a TYPE for the slot; it was WRONG: `updateTypeStack`
treated `local.tee` as a pass-through ("type doesn't change, just peek"), but
wasm types a tee's result as the LOCAL's declared type (set-then-get). A
`$NativeString` stored through an `$AnyString`-typed local re-reads as
`$AnyString`; the walker kept `$NativeString`, typed the save-temp too
narrowly, and the emitted `local.set` failed validation. One-line fix: tee
now pops and pushes `localTypes[idx]`. With it (plus PR #4088 + #4139),
**acorn 8.18 UMD compiles to a VALIDATING 2.3 MB module on standalone** —
this issue's first acceptance criterion, minus the run.

Running it then throws a module-level wasm exception (`__exn_tag`, payload an
internal error struct the host cannot decode) even for
`acorn.parse("var x = 1;")` — a runtime semantic defect, input-independent,
somewhere in Parser setup. Diagnosing needs the standalone error-model
tooling (payload message extraction); not yet chased.

## Acceptance

- acorn 8.18 UMD (`dist/acorn.js` + CJS shim) compiles to a validating
  module on --target standalone.
- A reduced repro (struct.new with a NativeString field receiving a value
  the checker only knows as AnyString across a join) compiles and runs.
