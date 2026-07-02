---
id: 2944
title: "Substrate: poisoned $Object values escape into struct-typed slots — externref-typed escape discipline for hash-consumer vars"
status: ready
created: 2026-07-02
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: dynamic-object-property-type-inference
goal: acorn-dogfood
related: [2849, 2937, 2584, 2372, 2432, 2896, 1712]
depends_on: []
blocks: [2849, 2937]
---

# #2944 — externref-typed escape discipline for poisoned `$Object` (hash-consumer) vars

**[SENIOR-DEV ONLY] — substrate slice.** This is the proper home for BOTH #2849
(dynamic-object static-write shadows sidecar, host mode) and #2937 (the acorn
uniform null-deref that the #2849 host fix caused). A scoped resolver change
cannot satisfy both; a value-representation slice is required.

## The conflict (why a scoped fix is impossible)

The `#2584`/`#2372`/`#2849` **poison** (`ctx.objectHashConsumerVars`,
`markObjectHashConsumers` in `declarations.ts`) keeps a `{}` var that has BOTH
dynamic-key access (`o[k]=`, `k in o`, `for (k in o)`, `Object.keys/…`) AND
static-named access on the `$Object` **sidecar** — it suppresses widening into a
closed WasmGC struct so writes + reads share one representation.

**The gap (root-caused for #2937, instrumented):** the poison is honored **ONLY
at the widening DECISION**. `objectHashConsumerVars` is consulted nowhere in the
read/write codegen. So:

1. The poison keeps the _value_ a `$Object`, but the read/write paths still
   resolve the receiver via `resolveStructName(TS-type)`, which can bind the
   poisoned var to a colliding `__anon` struct registered under the SAME TS
   object type by a _different_ (non-poisoned) same-shaped var. Instrumented on
   acorn: `options.ecmaVersion` → `resolveStructName` returns `__anon_4`
   (idx 46, an `ecmaVersion`-bearing struct) while `poisoned=true` and
   `widenedVarStruct=undefined` → `struct.get` on a `$Object` value → null.
2. Worse, the poisoned `$Object` value **ESCAPES the identifier**: `getOptions`
   RETURNS `options`, the caller stores it in the struct-typed `this.options`
   field, then reads `this.options.ecmaVersion` via that struct binding — a
   **non-identifier** access. A receiver-identifier bail (attempted in #2937,
   commit on branch `issue-2937-acorn-host-poison`) fixes parser SETUP but only
   1/23 corpus inputs, because the escaped value is read through struct-typed
   slots the bail cannot reach.

Measured proof (#2937): host poison ON + identifier bail → 22/23 acorn corpus
inputs still throw; pure revert (poison OFF in host) → all 23 parse but #2849
reopens. The two constraints (**#2849 fixed AND compiled-acorn parses**) cannot
both hold with a scoped resolver change — the poison's "keep as `$Object`" only
half-propagates.

## Required fix (the substrate slice)

Propagate the "this value is a `$Object` (poisoned), not a struct" decision
through every place a poisoned value **escapes** the declaring identifier, so
downstream reads use the dynamic host/`$Object` path instead of `struct.get`:

- **Return type**: a function that returns a poisoned var must have its inferred
  return type lowered to externref/`$Object`, not the colliding anon struct.
- **Field assignment**: `this.f = <poisoned>` (and any `x.f = <poisoned>`) must
  type field `f` as externref so `x.f.prop` reads via `__extern_get`.
- **Param passing / aliasing**: passing a poisoned var as an argument, or
  `const y = <poisoned>`, must carry the externref typing to the callee/alias.

Equivalent alternative (broader, more work): unify the `$Object`/struct read
path so ANY read of a _possibly_-`$Object` value uses the dynamic host path —
this is the value-rep substrate direction (#2896 family). Either way the read
site must stop binding a poisoned/escaped value to a struct type it isn't.

Then RE-EXTEND the poison to host (re-drop the `ctx.standalone` gate that #2937
restored) — with escapes handled, host acorn stays green AND #2849's host bug
stays fixed.

## Acceptance

- Re-drop the host gate in `collectEmptyObjectWidening` AND land the escape
  discipline together: compiled-acorn dogfood corpus back to ≥ the 2026-06-30
  baseline (≥13 equal±quirks) in host mode.
- `tests/issue-2849.test.ts`: the 4 host arms currently marked `it.fails`
  (3 guard variants + DEAD_BRANCH) flip back to plain `it` and pass
  (host `2022 → 13`, unreached-write reads `2022`).
- Standalone codegen byte-identical (its poison is unchanged throughout).
- 0 test262 regressions; full `merge_group` + standalone floor.

## Seed material

- **The escape mechanism, instrumented firing site, and measured
  revert-vs-bail comparison** are captured in the "The conflict" section above
  (root-caused during #2937). The #2937 issue file has the symptom, the
  bisect to PR #2432, and the fixed-by-revert banner.
- **#2849 design** (the poison, `objectHashConsumerVars`, the sidecar-wins
  strategy (b) and why (a)/(c) were rejected): the #2849 issue file's
  "Corrected Root Cause & Design" section.
- WIP receiver-identifier bail (the incomplete first half — a foundation, NOT a
  fix): earlier commit on branch `issue-2937-acorn-host-poison` history
  (superseded by the revert; recover from git if useful).
- Instrumentation recipe: `DBG_THROW_SITES` env hooks in `typeErrorThrowInstrs`
  / `resolveStructNameForExpr` / `markObjectHashConsumers` (see #2937 analysis).
