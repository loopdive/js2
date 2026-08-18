---
id: 4032
title: "Built-in / non-$Object carriers have no [[Extensible]] slot — every Array, function and built-in prototype reads back non-extensible, sealed and frozen in standalone"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
completed: 2026-08-02
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: object-integrity
goal: standalone-gap
assignee: ttraenkler/M-cleanwins
related: [3537, 3468, 4010, 2744]
# The substantive growth was EXTRACTED, not allowanced: the new subsystem module
# `src/codegen/object-integrity-carrier.ts` absorbs +165 lines that would
# otherwise have landed in `object-runtime-descriptors.ts` (+111) and
# `call-builtin-static.ts` (+54), both of which are now under budget. What
# remains in the barrel is ONE line — the `import` for the
# `OBJECT_INTEGRITY_OBJ_PREDICATES` spread into `OBJECT_RUNTIME_HELPER_NAMES`.
# That registry lives in this file by design (`ensureLateImport` must bind the
# defined native rather than emit an `env::` host import, #2961), so the entry
# cannot move out with it.
loc-budget-allow:
  - src/codegen/object-runtime.ts
---

# Built-in / non-`$Object` carriers have no `[[Extensible]]` slot

## Problem

In `--target standalone`, the object-integrity predicates answer the ES rule for
a **non-object argument** for every receiver that is not the open-object
`$Object` carrier:

| expression | Node | standalone (before) |
| --- | --- | --- |
| `Object.isExtensible(function foo(){})` | `true` | **`false`** |
| `Object.isExtensible(Object.prototype)` | `true` | **`false`** |
| `Object.isExtensible(Array.prototype)` | `true` | **`false`** |
| `Object.isExtensible(Error.prototype)` | `true` | **`false`** |
| `Object.isExtensible(String.prototype)` | `true` | **`false`** |
| `Object.isExtensible([1,2])` | `true` | **`false`** |
| `Object.isSealed(Object.prototype)` | `false` | **`true`** |
| `Object.isSealed(Array.prototype)` | `false` | **`true`** |
| `Object.isFrozen(Object.prototype)` | `false` | **`true`** |
| `Object.isFrozen(function foo(){})` | `false` | **`true`** |

13 of 21 probe cases wrong; the **host lane is correct on all 21**, so this is
standalone-specific. `Math`, `JSON`, a plain object literal and the `Object`
constructor were already correct — they reach the `$Object` carrier.

## Root cause

`emitIntegrityPredicate` (`src/codegen/object-runtime-descriptors.ts`) decides
object-ness with a single `ref.test $Object`, and when that fails it returns the
ES **non-object** constant (`isExtensible(5) === false`,
`isFrozen(5) === isSealed(5) === true`).

**`ref.test $Object` false does not mean "not an object".** In standalone an
Array is a `__vec_*` struct, a function is a closure struct, a built-in
prototype is its own brand struct and a typed object literal is an `__anon_*`
shape. All of those are objects. All of them were answered with the primitive
rule.

The matching mutators (`__object_preventExtensions` / `_seal` / `_freeze`,
`src/codegen/object-runtime-integrity.ts`) have the same `ref.test $Object`
gate and are **silent no-ops** for those carriers — there is nowhere to record
`[[Extensible]]`. That is why the predicates had to be wrong in the pristine
direction: it is the only way `Object.freeze(arr); Object.isFrozen(arr)` came
out `true`. Two wrongs cancelling is exactly the "green for the wrong reason"
shape, and it is load-bearing for 41 currently-passing goal-scope files.

`prependBuiltinFnObjectSemantics` (`object-runtime.ts`) already patches this for
**one** subtype set — reified builtin function closures — by splicing a
`ref.test` chain in front of the three predicates. That is a symptom patch: a
growing list of type-index sets prepended to three functions, one family at a
time.

## Fix — two independent halves, no new side table

**(a) Storage: reuse the bags that already exist.** `__vec_bag_ensure` (#3537,
Array expando bag) and `__closure_bag_ensure` (#3468, closure own-property bag)
already map a carrier to a per-object `$Object`. A `$Object` **has** a real
flags slot, so the bag *is* the missing `[[Extensible]]`/sealed/frozen storage.
A new `__integrity_bag(externref) -> externref` resolves a receiver to its bag
(or null), and both the predicates and the mutators route through it.

The `ensure` (not `lookup`) choice is deliberate: a freshly created bag has
`flags == 0`, which decodes to exactly the pristine-ordinary-object answer. One
code path serves both "never mutated" and "mutated", with no extra state.

Deliberately **not** a third receiver side-table — that is what #4010 exists to
undo.

**(b) Object-ness: ask the type system, not the carrier.** Three `_obj` variants
(`__object_isExtensible_obj` / `_isFrozen_obj` / `_isSealed_obj`) keep the same
body but flip the terminal fallback to the ordinary-object rule. The call site
(`call-builtin-static.ts`) selects them when
`ctx.oracle.staticJsTypeOf(arg)` proves the receiver is an object/function.
That covers built-in prototypes, for which no bag carrier exists, and it does
not depend on which WasmGC carrier a value happens to use.

`null` is excluded: the oracle folds it to the `"object"` tag for `typeof`
fidelity, but `Object.isExtensible(null)` is `false` and `Object.isFrozen(null)`
is `true` — the non-object rule. Nullable/possibly-undefined receivers keep the
conservative helper.

Host mode is byte-identical throughout: `__object_is*` are host imports there,
the bag substrates are standalone/wasi-only, so `integrityBagIdx` is `undefined`
and both emitters reproduce the previous bodies exactly.

## Known residual (deliberate, documented, measured)

A receiver lowered to a plain typed struct (`const o = { a: 1 }` → `__anon_*`)
has **no** bag carrier, so `Object.preventExtensions(o)` there is still a no-op.
For that shape the old non-object answer is accidentally *right* after a
mutation, so `provenJsObject` returns false once
`Object.freeze/seal/preventExtensions` has been seen for that declaration
(`ctx.nonExtensibleVars`, the pre-existing per-declaration tracking).

`nonExtensibleVars` is populated in **codegen order**, which lines up with the
family this unlocks:

```js
assert(Object.isExtensible(obj));      // compiled first → ordinary-object rule → true  ✓
Object.preventExtensions(obj);         // records the declaration
assert(!Object.isExtensible(obj));     // now restricted → false ✓
```

Not tracked (unchanged from the pre-existing `frozenVars` tracking): mutation
through an alias, or inside a callee. Giving `__anon_*` shapes a real bag is the
follow-on; it belongs with #4010's receiver-substrate consolidation, not here.

## Measurement

Corpus revision **`b363f29d`** (tc39/test262, 2026-07-31) — the same revision CI
scores against. Baseline `test262-standalone-current.jsonl`, rows
`1.8.2026 22:26:58 → 22:32:46`, `oracle_version` 12, lane `honest`;
43,505 `scope_official` / 25,929 pass; goal scope 8,545 run / 6,242 pass / 2,303
non-pass.

Population is enumerated by trigger shape (body calls `Object.is{Extensible,
Sealed,Frozen}` / `Object.{preventExtensions,seal,freeze}` / `Reflect.*`), so it
is a **population, not a sample** — a file without the shape cannot observe this
change.

- **Population**: 112 goal-scope files (71 non-pass = reachable gain, 41 passing
  that call both a mutator and a predicate = at-risk).
- **Instrument check**: the local standalone runner agreed with the CI baseline
  **112/112** on pass/fail before the change.
- Flip counts: see the PR body.

## Suspended Work

(none)
