# W10 — namespace + Error descriptor carriers (2026-08-06)

**Agent**: `ttraenkler/W10-namespace-error-carriers` (senior-dev, fable lane).
**Issue**: #4188. **Branch**: `issue-4188-namespace-carrier-toplevel-write`
(pushed to `origin`). Claim verified on `origin/issue-assignments`.

---

## PR body (copy verbatim)

### Title

`fix(#4188): stop dropping top-level namespace-carrier expando writes from __module_init`

### Body

Under `--target standalone`, the test262 §8.10.5 descriptor-carrier spelling

```js
Math.value = "Math";                          // ← silently DROPPED
Object.defineProperty(obj, "property", Math); // carrier reads back EMPTY
```

failed because the *write* emitted **no code at all**. `collectDeclarations`'
module-init collection is an allow-list keyed on the assignment's root
identifier; `Math`/`JSON` are neither module globals nor top-level functions,
so the whole statement matched no arm — the **tenth** shape in the
collection-gap family (#1268, #2671, #2992, #3366, #3468, #3592, #3615,
#3956, #4179). WAT evidence: `__module_init` for the module above contains the
carrier materialization and the `__obj_define_from_desc` call and **no
`__extern_set`, no `"value"` key, no `"Math"` string** — the RHS is never even
evaluated.

The write itself has been compilable since #2907: the bare identifier resolves
to the native namespace-carrier `$Object` singleton and the write-arm routes
through `__extern_set` onto it. The same write inside a function body already
landed. Only the top-level collection dropped it.

#### What this refutes

#4180's residue census framed this cluster as "compile refusal (#1907 /
#1888 S6-b) — needs a namespace-object substrate". Both halves are wrong for
these 46 files: the substrate already exists (#2907), and the #1907 refusal
gates only the direct value *READ* of an unsupported static prop — a shape
these tests never use (the census's own probe introduced it). The tests failed
at runtime with an empty descriptor because the write was dropped at
collection time.

#### The fix

`isNamespaceCarrierExpandoWriteTarget` (`src/codegen/module-init-collection.ts`,
ctx-free like the rest of that module) + a keep-arm in `collectDeclarations`.
Scoped narrowly:

- **standalone only** — host/GC keeps its existing (dropped) lowering,
  byte-identical;
- **plain `=` only** — a compound `Math.foo += 1` needs the expando READ,
  which IS the #1907 refusal; keeping it would flip a silent drop into a
  module-wide CE;
- **direct unshadowed `NS.<name> = …`** (`isSupportedBuiltinNamespace`
  receivers), mirroring the #2623 Promise keep's shadow guards.

#### Measured (`--target standalone`, CI-aligned scoped runner + #4162 shim)

| list | base | fixed |
| --- | ---: | ---: |
| 46-file Math/JSON carrier cluster (#4180 census) | **0 / 46** | **38 / 46** |
| 23 adjacent shape-matched files (all other top-level builtin-namespace writes in test262) | — | **0 flips** |

The 8 residuals are all `-1` "of prototype object" variants
(`Object.prototype.value = "Math"` reaching Math via [[Get]]) — the
separately-tracked #4160 proto-chain cluster, deliberately not folded in.

#### Gates

`check:oracle-ratchet` +0/+0 · `check:coercion-sites` OK · `check:loc-budget` /
`check:func-budget` — the predicate + all rationale went to the subsystem
module; the residual call-site consult is **granted** with per-entry reasons in
#4188's frontmatter (same shape as #4179's grant). `tsc --noEmit` clean, biome
clean. `tests/issue-4188.test.ts` (5 cases incl. the shadow guard and the
inside-a-function control).

Does NOT touch `src/codegen/object-ops.ts` — no overlap with #4153/#4155 or
the #2372 reify gate.

---

## Findings for the next wave (measured, do not re-derive)

### The W5 carrier-matrix Math/JSON row is now CLOSED for the direct shapes

After this PR the row reads: store+read ✓ (via carrier), `hasOwn` ✓, `in` ✓
(untested but same `__extern_has` path), `defineProperty` ✓. The #1907 refusal
still fires on a **direct static-typed read** `x = Math.zz` — that is a
read-path decision (typed lane), not a substrate gap, and none of the 46
cluster files need it.

### Diagnostic technique that found this (reusable)

The bare-source WAT dump showed the write missing **before RHS evaluation** —
which eliminates every lowering-path hypothesis at once (all of them evaluate
the RHS). Anything absent that early is a *collection* drop, and the
collection allow-list in `collectDeclarations` is the known repeat offender
(ten shapes now). Check it FIRST for any "top-level statement has no effect,
same statement works inside a function" symptom.

### Error cluster (~27 files) — verified still open, mechanism confirmed different

`new Error(); e.zz = 1` — the receiver is a module global, so collection is
NOT the problem; the store falls off `__extern_set`'s carrier dispatch
(`$Error_struct` is deliberately excluded from `__is_closure_prop_carrier`
because its `$props` side-slot (fieldIdx 5, #2101a R5) is written directly by
the externref-backed-subclass own-field path — bagging it would create two
disagreeing stores, see closure-props.ts `builtinInstanceCarrierTypeIdxs`).
The stated route (wire `$Error_struct.$props` into `__extern_get`/
`__extern_set`/`__extern_has` as a dedicated arm, NOT via the bag) remains the
right one and is untaken. Note 3 of the 27 also hit
`[SITE-PROPS-BAG-NOT-AUTHORITATIVE]` (#1906) refusals in the plural path and
2 hit `illegal cast in __module_init` — the $props wiring alone will not clear
those 5.

### Instrument

`.tmp/w10-{run,child,probe}.mjs` in worktree
`/home/user/js2/.claude/worktrees/agent-ae83a32cc4913b9ec/` (W5's harness
renamed; includes the #4162 `js2wasm:runtime-eval` shim). Lists:
`.tmp/w10-mathjson-list.txt` (46), `.tmp/w10-extra-list.txt` (23 adjacent).
Results: `.tmp/w10-mathjson-{base,after,after2}.jsonl`,
`.tmp/w10-extra-{base,after}.jsonl`. WAT dumper: `.tmp/w10-wat.mjs`
(`node --import tsx .tmp/w10-wat.mjs <file.js> [grep]`).
