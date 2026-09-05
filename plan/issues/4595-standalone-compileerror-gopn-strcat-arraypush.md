---
id: 4595
title: "STANDALONE emits invalid Wasm: `local.set/call expected (ref null 6), found ref.cast of (ref 112)` when Object.getOwnPropertyNames(fn) + string concat + array push combine in __module_init"
status: ready
sprint: current
created: 2026-08-21
updated: 2026-08-21
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
goal: es5
related: [4560, 4163]
origin: "2026-08-21 wave-2 function lane, found on the BASE tree while probing — pre-existing, not introduced by wave-2 work. Same validity-bug family as #4560 (a module the engine refuses to instantiate)."
---

# #4595 — invalid Wasm from gOPN + concat + push

## Severity

A `CompileError` at instantiation — a broken module, not a wrong answer. Same
class as #4560 (which was a `join`-fold arm assuming a string ref); different
site.

## Reproduction shape

A module combining, in `__module_init`:

1. `Object.getOwnPropertyNames(fn)` (a function receiver),
2. string concatenation of the result's elements,
3. pushing the concatenations into an array.

**Each ingredient compiles fine alone** — the invalid module needs the
combination. Error text:

```
CompileError: local.set/call expected type (ref null 6), found ref.cast of type (ref 112)
```

Verified pre-existing on the wave-2 base (`5176abc1`), before any wave-2 edits.

## First steps for whoever takes it

- Minimise from the three-ingredient shape to the exact pair that disagrees —
  the `(ref null 6)` vs `(ref 112)` mismatch says one site's declared local/param
  type and another site's cast target come from different type registries or a
  stale index, the same smell #4560's fix resolved with a total conversion.
- #4560's acceptance pattern applies: a minimal non-test262 repro under
  `tests/` pinning the emitted block/local types, not just the row.
