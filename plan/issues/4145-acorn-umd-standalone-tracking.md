---
id: 4145
title: "tracking: acorn 8.18 UMD compiles and runs on --target standalone"
status: ready
sprint: Backlog
priority: medium
goal: standalone-gap
feasibility: hard
horizon: l
created: 2026-08-03
requested_by: ttraenkler/claude-bench
related: [4088, 4138, 4139, 4144]
---

# #4145 — tracking: acorn UMD end-to-end on standalone

The UMD bundle (`dist/acorn.js`) wraps every top-level binding in one IIFE,
turning the whole parser into frame locals + capturing siblings. Compiling it
with a `bench()` export surfaced five distinct compiler defects, fixed or
filed in this order (each fix un-masked the next):

1. ✅ Cross-frame capture argument from a dead slot — PR #4088 (`ae6f9cb6`).
2. ✅ Name-matched shape arm emits an unbridgeable `struct.get` — PR #4088
   (`433b553f`).
3. ✅ Selector/build vec-ABI disagreement on numeric-array module vars —
   PR #4088 (`c7a57f35`).
4. ✅ Fnctor twin sibling captures — #4139 (standalone; `2ef595b7`).
   ⛔ gc-target twins remain: no `__constructor_identity` param there.
5. ⛔ #4144 — stack-balance types an unknown slot's temp from the struct
   field's DECLARED type (`$NativeString`) while the value is its supertype
   (`$AnyString`); underneath, the producer passes unflattened strings into
   a NativeString-typed field. Current blocker: `__closure_0` validation.

Unknown whether more defects hide behind (5) — each fix so far revealed the
next. The benchmark meanwhile vendors the ESM-script form
(test262-data `02b19d4`), which works end-to-end after PR #4088; UMD stays
the harder exercise and this issue is done when it passes too.

## Acceptance

- acorn 8.18 UMD + CJS shim compiles to a validating module on standalone,
  runs `parse` of its own source, and the parse agrees with node acorn.
- Same on gc (needs the twin-capture mechanism without the identity param).
