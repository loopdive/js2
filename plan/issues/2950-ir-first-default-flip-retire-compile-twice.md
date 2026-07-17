---
id: 2950
title: "IR-first default flip: JS2WASM_IR_FIRST default-ON, then delete the flag + compile-twice path"
status: backlog
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: codegen, ir
language_feature: compiler-internals
goal: ir-full-coverage
depends_on: [2138, 2135, 2951, 2945]
related: [2855, 2947, 1916]
origin: "2026-07-02 July Fable audit §1 (Wave-3 sequencing anchor; no issue existed for the default flip)"
---

# #2950 — make compile-once the default, then the only, behavior

## Problem

#2138 landed the inversion behind `JS2WASM_IR_FIRST=1`: legacy body
compilation is skipped for fully-claimed closures, and a post-claim IR
failure on a skipped slot is a hard error (`src/codegen/index.ts:1753-1789`).
Flag-off (the default) still compiles every claimed function **twice** —
and the always-available legacy body is the mechanism that keeps silent
fallback free (#2855's root enabler). "Retire the legacy front-end" has no
endgame until the flag flips and then disappears.

## Scope (three slices, each its own PR)

1. **Default-ON** (`JS2WASM_IR_FIRST` unset ⇒ on; explicit `=0` opts out):
   gated on (a) a clean #2138 Slice-3 full test262 measurement via the
   #2947 `ir_first` dispatch lane (all divergences filed + fixed or
   defer-listed in capability.ts), (b) #2135 statement/call/access
   capability families landed (selector↔builder drift is hard-error-class
   once slots are skipped), (c) #2951 (generators + class members in the
   skip set) or an explicit carve-out note keeping them compile-twice.
2. **Delete the flag + the compile-twice path**: `compileDeclarations`
   always receives the skip set; the IR overlay fills exactly the skipped
   slots; post-claim demotion on any claimed function becomes a hard
   compile error (the demote-to-warning channel loses its safety-net
   rationale for claimed code — coordinates with #2855 AC 4).
3. **Ratchet the win**: record compile-time delta (the original #2138
   motivation) on an idle box/CI; assert index-layout invariance test stays.

## Acceptance criteria

- Full merge_group test262 net-zero (±flake) with default-ON before slice 2.
- After slice 2: no `JS2WASM_IR_FIRST` reads remain; a post-claim IR
  failure on a claimed function fails the compile loudly.
- Compile-time delta recorded.

## Risk

High blast radius (changes which front-end emits every claimed body for
every user). Validate on the full merge_group run, never a scoped sweep
(`project_broad_impact_validate_full_ci`). Slice 2 only after slice 1 has
soaked through at least one budget window on main.

## Audit note 2026-07-17 (IR audit 01)

STALE/SUPERSEDED IN PART: the default-ON flip this issue titles was
delivered by #3143 (done, sprint 71) — `experimentalIR` defaults true and
IR-first runs unless `JS2WASM_IR_FIRST=0` (one-release escape hatch,
`src/codegen/index.ts:2327-2338`). The undelivered remainder (delete the
compile-twice machinery + phase out the demote channel) overlaps #2855
AC4. This issue should be re-scoped to exactly that remainder or closed
in favor of #2855/#3143 — do not dispatch it as an independent "flip"
task. See `plan/log/analysis-2026-07/01-ir-audit-2026-07-17.md` §6.
