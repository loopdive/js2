---
id: 2878
title: "Standalone: invalid Wasm residual — __str_flatten + user-body shapes (test/inner/fn) after #2868 URI-carrier fix"
status: ready
created: 2026-06-30
updated: 2026-06-30
priority: high
feasibility: medium
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: m
related: [2860, 2868]
umbrella: 2860
---

# Standalone: invalid Wasm — residual after #2868

#2868 fixed the `__uri_encode`/`__uri_decode` carriers (root cause: a shared
`throwURIError` `Instr[]` aliased the same `call`/`throw` Instr objects across
~13 spread sites, so `shiftLateImportIndices` over-shifted the shared `funcIdx`
once per occurrence — fixed by making it a fresh-Instr factory). This follow-on
tracks the **rest** of the #2868 invalid-Wasm surface that the URI fix did not
cover.

## Remaining buckets (from the #2868 measurement, 2026-06-30)

| function | tests | note |
| -------- | ----- | ---- |
| `test` (harness/user) | 199 | a common emitted body shape |
| `inner` | 81 | nested function shape |
| `fn` | 42 | |
| `__str_flatten` | 10 | native string flatten (String split RegExp-arg path) |
| `C_setPrivateReference` | 10 | private-field accessor |
| `gen` / `__closure_*` / `__cb_*` | ~40 | |

## Root-cause hypothesis

The `__uri_*` fix shows one concrete instance of the **shared-Instr-object
aliasing** hazard interacting with the late-import index-shift walker
(`shiftLateImportIndices` mutates `instr.funcIdx += delta` per occurrence; a
spread-shared `call`/`ref.func` Instr is shifted N×). The `test`/`inner`/`fn`
body-shape failures (322) may share this class (another emitter that spreads a
shared `Instr[]` containing a `call`/`ref.func`) **or** be a distinct
stack-balance / type-mismatch on a `ctx.standalone`-gated path. Triage one repro
per named function (disassemble with binaryen, read the exact validator error),
then cluster.

A defensive hardening worth evaluating: make `shiftLateImportIndices` (and the
sibling string-import shift in `index.ts`) **idempotent per Instr object** (track
a `Set<Instr>` of already-shifted call/ref.func nodes), so a shared Instr can
never be double-shifted regardless of emitter aliasing. That would neutralize the
whole bug class at the walker instead of fixing each emitter. Weigh against the
"never alias one Instr[]" convention (memory
`reference_shared_instr_object_dce_double_remap`).

## Test plan

Standalone CE → pass: `test/built-ins/String/prototype/split/**` (RegExp-arg
`__str_flatten`), plus the clustered `test`/`inner`/`fn` body-shape examples once
the shared construct is identified. Full `merge_group`.
