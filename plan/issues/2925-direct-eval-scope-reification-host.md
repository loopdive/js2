---
id: 2925
title: "Direct-eval scope reification (JS-host): per-function tiering + $Frame name-map"
status: backlog
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: l
feasibility: hard
model: fable
reasoning_effort: high
task_type: feature
area: codegen
language_feature: eval
goal: runtime-eval
sprint: Backlog
parent: 1584
depends_on: [2864, 1164]
related: [1261, 1073, 1355]
---

# #2925 — Direct-eval scope reification in JS-host

Slice **C** of the runtime-eval roadmap
([docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md), §4.1, §6-C).
Unlocks the ~76 failing `language/eval-code/direct` tests (roadmap §5.2) that
fail because direct eval cannot see/mutate the caller's locals.

## Problem

Direct `eval(s)` **sees and mutates** the enclosing lexical scope
(**§19.2.1.1 PerformEval**, VariableEnvironment step). The JS-host meta-circular
shim (#1164, `createEvalShim`) compiles `s` into a **fresh** WasmGC module with
**no visibility** into the caller's locals — so
`function f(){ var x=1; eval("x=2"); return x }` returns `1`, not `2`. #1073
documented this gap as unimplemented.

## Root cause

AOT locals are unboxed Wasm locals or per-variable ref cells — not addressable
by name from a separately-compiled evaluator. To make them visible/mutable, the
function's capturable bindings must be **reified** into a heap environment record
the evaluator can resolve by name.

## Design (environment reification — converges with #2864 `$Frame`)

This is the existing closure ref-cell pattern generalized. Today each captured
mutable local is its own `struct (field $value (mut T))`. Reification batches
them into one environment record:

```
$EnvRecord = struct (
  field $slots  (ref $SlotArray)     ;; mutable binding slots (the $Frame carrier)
  field $names  (ref $NameMap)       ;; name -> slot-index (NEW vs a plain $Frame)
  field $parent (ref null $EnvRecord);; lexical scope chain link
)
```

- **Reuse #2864's `$Frame`** for `$slots` — do NOT define a competing frame
  type. #2864 builds `$Frame` as a heap activation record for generators/async;
  a reified direct-eval environment is the same carrier **plus** a `name→slot`
  map. Coordinate the shared type with the #2864 owner. **This issue must not
  edit #2864's files** — it consumes the landed `$Frame`.

### Per-function gating (the deopt)

Refine #1261's tiering from **module-wide** to **per-function**: compute a
`mayContainDirectEval` flag for each function (a direct-eval call
syntactically inside its body). Only flagged functions reify their locals;
every other function keeps unboxed locals and pays **nothing**. Indirect eval
and `new Function` never flag (global-scope only).

### Threading to the shim

Pass the reified `$EnvRecord` (as an externref) to `__extern_eval(src, isDirect,
env)` so `createEvalShim` resolves free identifiers in `s` against the live
slots and writes back through them. Extend the import signature
(`src/codegen/expressions/calls.ts` ~3998, currently `(externref, i32) ->
externref`) and the host shim (`src/runtime-eval.ts`).

## Edge cases

- `var`/`function` **declared inside** eval hoist into the **caller's**
  VariableEnvironment (§19.2.1.1) — the env record must be writable/extensible
  for new bindings, not just the pre-existing slots.
- `let`/`const` in eval create a **new** declarative environment for the eval
  scope (do NOT leak into the caller) — distinguish var-scope from lexical-scope.
- Strict-mode direct eval gets its **own** variable environment (no caller var
  injection) — respect the tier-4 (DirectStrict) vs tier-5 (DirectSloppy)
  distinction #1261 already computes.
- TDZ for `let`/`const` slots referenced before initialization inside eval.

## Acceptance criteria

- [ ] `function f(){ var x=1; eval("x=2"); return x }()` returns `2` (JS-host).
- [ ] `function f(){ var x=1; eval("var y=x+1"); return y }()` — sloppy-mode
      `var y` hoists into `f` and returns `2`.
- [ ] Strict-mode: `"use strict"` direct eval does NOT inject its `var` into the
      caller.
- [ ] Non-eval functions show **no** codegen change (byte-diff the emitted Wasm
      for a representative non-eval module — must be identical).
- [ ] ≥ 40 of the ~76 `eval-code/direct` failures flip to pass (JS-host).

## Notes

Depends on #2864 (`$Frame`). The `$EnvRecord`/name-map is the shared substrate
for standalone direct eval (#2929) and `with`/Proxy (#1355) — see roadmap §7.
Umbrella: #1584. Goal: `runtime-eval`.
