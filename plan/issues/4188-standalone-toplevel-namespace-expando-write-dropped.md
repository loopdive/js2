---
id: 4188
title: "standalone: top-level `Math.<p> = v` / `JSON.<p> = v` expando writes silently DROPPED from __module_init — the 46-file Math/JSON descriptor-carrier cluster (collection allow-list gap, #2992/#3592/#3615/#4179 family)"
status: done
assignee: ttraenkler/W10-namespace-error-carriers
sprint: current
created: 2026-08-06
updated: 2026-08-06
completed: 2026-08-06
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: property descriptors
goal: standalone-gap
related: [2907, 1907, 2623, 2671, 2992, 3468, 3592, 3615, 4179, 4180, 4160]
# The keep-arm must be CONSULTED inside collectDeclarations' module-init loop
# (the allow-list IS that function); all rationale + the predicate itself went
# to the subsystem module `module-init-collection.ts`, which is the direction
# the gate encourages. The residual is a 4-line pointer comment + the
# formatter-mandated multi-line `if` — there is no way to consult the
# predicate from the call site for zero lines. Same shape as #4179's grant.
loc-budget-allow:
  - src/codegen/declarations.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
origin: "2026-08-06 W10-namespace-error-carriers — verifying W5/#4180's residue census, which attributed the 46-file Math/JSON descriptor-carrier cluster to the #1907/#1888 S6-b compile refusal. That framing was WRONG; the refusal never fires on these tests."
---

# #4188 — top-level namespace-carrier expando writes never reach `__module_init` (standalone)

## TL;DR (root cause)

`collectDeclarations`' module-init collection (`src/codegen/declarations.ts`,
the source-order loop) is an **allow-list keyed on the assignment's root
identifier**, and `Math`/`JSON` are neither module globals nor top-level
functions. So the test262 §8.10.5 descriptor-carrier spelling

```js
Math.value = "Math";                          // ← silently DROPPED
Object.defineProperty(obj, "property", Math); // carrier read → EMPTY descriptor
```

emitted **no code at all** for the write — the tenth shape in the
collection-gap family (#1268, #2671, #2992, #3366, #3468, #3592, #3615,
#3956, #4179). WAT evidence: `__module_init` for the three-statement module
above contains the carrier materialization and the
`__obj_define_from_desc` call, and **no `__extern_set`, no `"value"` key, no
`"Math"` string** — the RHS is never even evaluated.

The write itself has been compilable since #2907: the bare identifier resolves
to the native namespace-carrier `$Object` singleton
(`identifiers.ts` → `emitBuiltinNamespaceObject`) and the write-arm routes
through `__extern_set` onto it. The SAME write inside a function body already
landed; only the top-level collection dropped it.

## What this refutes (the census framing)

#4180's residue census (W5) tabulated this cluster as

> Math / JSON: ✗ compile refusal — needs a namespace-object substrate, not a
> descriptor fix (#1907 / #1888 S6-b)

Both halves are wrong for these 46 files:

- the **substrate already exists** (#2907's carrier singletons, extensible
  `$Object`s that `__extern_set`/ToPropertyDescriptor can see);
- the **#1907 refusal never fires** on them — it gates the direct *value READ*
  of an unsupported static prop (`x = Math.value`), a shape these tests never
  use. They only *write* the expando and then pass `Math` as a value. The
  refusal W5 measured came from its own probe doing a direct read-back.

The tests were failing at *runtime* with an empty descriptor because the write
was dropped at *collection* time.

## Fix

`isNamespaceCarrierExpandoWriteTarget` (`src/codegen/module-init-collection.ts`)
+ a keep-arm in `collectDeclarations` that collects the statement into
`ctx.moduleInitStatements`. Scoped narrowly (full rationale at the predicate):

- **standalone only** — host/GC keeps its existing (dropped) lowering; the
  host-lane fix is the same one-line keep but separate, measured work;
- **plain `=` only** — a compound `Math.foo += 1` needs the expando READ,
  which IS the #1907 refusal; keeping it would flip a silent drop into a
  module-wide CE;
- **direct unshadowed `NS.<name> = …`** only (`isSupportedBuiltinNamespace`
  receivers: Math/JSON/Reflect/Error-family/Array/Object), mirroring the
  #2623 Promise keep's shadow guards.

## Measured (`--target standalone`, CI-aligned scoped runner + #4162 shim)

| list | base | fixed |
| --- | ---: | ---: |
| 46-file Math/JSON carrier cluster (from #4180's census) | **0 / 46** | **38 / 46** |
| 23 adjacent shape-matched files (top-level builtin-namespace writes outside the cluster) | — | **0 flips** |

The 8 residuals are all `-1` "of prototype object" variants
(`Object.prototype.value = "Math"` reaching Math via [[Get]] inheritance) —
the separately-tracked #4160 proto-chain cluster, deliberately not folded in.

Instrument responsiveness: base run 0/46 on the identical worktree pre-patch;
38/46 post-patch with only `declarations.ts`/`module-init-collection.ts`
changed (file-copy A/B for the adjacent-list base, never `git stash`).

## Permanent repro

`tests/issue-4188.test.ts` — 5 cases: the 15.2.3.6-3-144 data-carrier shape,
the 15.2.3.6-3-226 accessor-carrier shape, own-property visibility
(hasOwnProperty/gOPN), the top-level-function shadow guard, and the
inside-a-function-body control (never broken).
Conformance repro: `test262/test/built-ins/Object/defineProperty/15.2.3.6-3-144.js`.

## Left undone (deliberate)

- **The 8 `-1` proto-inheritance variants** — #4160 territory (widening
  `proto-index-store.ts` to named keys is the measured −40-risk shape from
  #2660 S2; needs its own slice).
- **Host/GC lane keep** — same mechanism, unmeasured there; the arm is gated
  `ctx.standalone` so host stays byte-identical.
- **Compound assignments on namespace expandos** — blocked behind making the
  expando READ not refuse (#1907 widening), which is a read-path decision.
- **Error-instance carriers (~27 files)** — different mechanism entirely
  (`new Error(); e.zz = 1` needs `$Error_struct.$props` wiring in
  `__extern_get`/`__extern_set`, #4008/#4098 notes); not touched here.
