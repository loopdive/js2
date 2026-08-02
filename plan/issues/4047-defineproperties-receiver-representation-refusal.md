---
id: 4047
title: "standalone Object.defineProperties: the #1906 refusal is a RECEIVER-representation gate, not a descriptor-shape one — resolve what is resolvable"
status: done
sprint: current
created: 2026-08-02
updated: 2026-08-02
completed: 2026-08-02
priority: high
horizon: m
complexity: M
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: property-descriptors, object-defineproperties, object-create
es_edition: es5
goal: standalone-gap
related: [1906, 3246, 3251, 3468, 3537, 3957, 3991, 4010, 4032]
assignee: ttraenkler/H-descriptor
origin: "2026-08-02 harvest — the 61 official / 50 goal-scope `unsupported descriptor shape in standalone mode (#1906)` records."
# (#3102 / #3400 ratchet) Both edits are in-place changes to the single existing
# builder for this operation. The bulk of the added lines are the rationale for
# WHICH shapes may be resolved and which must keep refusing — separating that
# comment from the instruction sequence it guards is precisely the regression
# #3957 measured and rejected.
loc-budget-allow:
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/expressions/call-builtin-static.ts
func-budget-allow:
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
---

# #4047 — the `#1906` refusal is a receiver-representation gate

## The finding that reframes this

`plan/issues/1906-*.md` reads `status: done`, yet its refusal string —
`Object.defineProperties unsupported descriptor shape in standalone mode (#1906)`
— was still the single largest in-scope failure signature.

**It is not a regression.** #1906 shipped the native plural path for a
`$Object`-to-`$Object` apply and deliberately installed a fail-loud refusal for
everything else; the issue's own 2026-07-13 harvest note already recorded the
residual (79 records then, 61 now). The `done` status is accurate for what
#1906 claimed.

**What WAS wrong is the attribution.** That harvest note blamed "a residual
descriptor-shape family (accessor descriptors / mixed data+accessor /
non-object entries)". Measured against the actual failures, that is false:

> **Zero** of the 61 records reach either per-descriptor refusal site.
> **100%** are refusals of the RECEIVER's wasm representation — `Properties`
> (or `O`) is not the open-object `$Object` struct.

The message names a descriptor problem and the defect is a representation
problem, which is why the family survived four consecutive fixes aimed at
descriptor handling (#3983, #3984, #3991, #4032).

## Measurement

Corpus `b363f29d`. Standalone baseline force-refetched, row timestamp
2026-08-02 03:32 — official **43,505 run / 25,995 pass (59.75%)**, goal scope
(`es5id:` present, or none of `es5id`/`es6id`/`esid`) **8,545 run / 6,298 pass
(73.70%)**, **0** corpus files unopenable.

Method: tag all five `throwUnsupported()` sites in `__defineProperties` with a
distinct suffix, then run the **CI path** (`assembleOriginalHarness` →
`CompilerPool(n,"unified")` → `scripts/test262-worker.mjs`) over **all 952**
files under `built-ins/Object/{defineProperties,create}`.

Instrument validated twice, because a signature is not a mechanism:

- **951 / 952** file-level agreement with the committed standalone baseline.
  The one disagreement is `BASE-FAIL / LOCAL-PASS` on `15.2.3.7-5-b-236.js`,
  i.e. a landed fix not yet promoted — not an instrument error.
- **0 flips** on a file-level diff of the tagged run against the untagged run,
  so the tagging itself is inert. (The raw vitest *test* counts differ, 348 vs
  359, because of strict-rerun duplicates; the file-level diff is the one that
  answers the question.)

| refusal site | files | goal scope | what `Properties` / `O` actually is |
| --- | --- | --- | --- |
| `PROPS-NOT-OBJ/OBJ` | 27 | 26 | object, no bag carrier — Date / RegExp / Error / ctor-instance / closed struct |
| `PROPS-NOT-OBJ/VEC` | 9 | 9 | Array or `arguments` |
| `O-NOT-OBJ` | 8 | 8 | Array receiver |
| `PROPS-NOT-OBJ/FUNC` | 5 | 5 | Function |
| `PROPS-NOT-OBJ/PRIM` | 4 | 2 | primitive / `undefined` |
| **total** | **53** | **50** | matches the harvest's 50 exactly |
| `DESC-NULL`, `DESC-NOT-OBJ` | **0** | **0** | the family the old note blamed |

The remaining 8 official records outside this scope are the
`TypedArrayConstructors/internals/Delete` family.

## Why the old gate could not simply be widened — and what changed

#3957's comment on that gate was **correct and still is**: the own-enumerable-key
walk needs a real key source, and `__object_keys` returns an *empty* `$ObjVec`
for every non-`$Object` receiver, so a blanket widening trades a loud refusal
for a silent no-op. Re-measured 2026-08-02 in standalone, both halves still hold:

```
Object.keys([10,20,30]).length          === 0
Object.keys(fnWithOwnProp).length       === 0
```

…while the corresponding **writes round-trip** (`r.p = 7; r.p === 7`) for both
Arrays and functions. Enumeration is the dead half. (That is a strictly larger
lever than this issue and is filed separately; it belongs with #4010.)

What this issue changes is that the widening is no longer blanket. Each receiver
shape is resolved to a key source that is **complete**, or it keeps refusing.
No arm answers "define nothing" unless "nothing" is what the spec says.

## The change

### 1. `O` — the gate had no downstream dependency at all

`__defineProperties` cast `O` to `$Object` into `L_OBJ` and then **never read
it** (`void L_OBJ;` at the end of the block). Pass 2 hands the raw
`local.get 0` externref to `__defineProperty_value` /
`__defineProperty_accessor`, which carry their own receiver dispatch
(`vecOverlayArm` → the #3251 per-index/expando companion). The `ref.test
$Object` on `O` decided nothing except whether to refuse.

Replaced with the spec question plus an honesty check:

- `Type(O)` is not Object → **TypeError** (§20.1.2.3.1 step 1);
- `$Object` or a vec carrier → proceed, the appliers store;
- object with no carrier (Date / RegExp / Error) → **keep the loud refusal**.

The third arm is load-bearing. `__defineProperty_value`'s terminal arm for a
carrier-less receiver is a *lenient no-op* that returns `O` unchanged (matching
the host import). Letting such a receiver through would convert a loud refusal
into a silent wrong answer — the exact vacuity the refusal exists to prevent.

### 2. `Properties` — resolve per shape, using the bags that already exist

- **native string**: `ToObject("")` is a String exotic with no own enumerable
  keys, so the empty string is a complete, spec-correct **no-op**. A non-empty
  string has own enumerable index keys whose values are single-character
  strings, and `ToPropertyDescriptor` on a primitive is a TypeError — that case
  **keeps refusing** (`[SITE-PROPS-STRING-INDICES]`).
- **`undefined`**: `ToObject(undefined)` is a TypeError (§7.1.18). Under the
  #2106 singleton regime `undefined` is a *struct*, so the `ref.is_null` guard
  never caught it and it would otherwise fall into the primitive no-op below.
  Explicit tag test, same one the accessor reader uses.
- **any other primitive** (boolean / number / symbol / bigint): `ToObject`
  yields a **fresh** wrapper with zero own enumerable properties, so the key
  walk is empty and the operation is a no-op returning `O`. This is a complete
  answer, not a degraded one.
- **object without the open representation**: resolve its own-property **bag** —
  `__vec_bag_*` (#3537) or `__closure_bag_*` (#3468) — through the **same
  `__integrity_bag` resolver #4032 introduced**. Both bags *are* `$Object`s, so
  the rest of the helper works unchanged. No third side table: adding one is
  what #4010 exists to undo.
- **vec with `length != 0`**: its own enumerable **index** keys carry
  descriptors that live in the elements, not the bag. Enumerating only the bag
  would define a strict subset and return normally. **Keeps refusing**
  (`[SITE-PROPS-VEC-INDEXED]`).
- **object with no bag at all** (Date / RegExp / Error): **keeps refusing**
  (`[SITE-PROPS-NO-CARRIER]`). Re-measured: `d.p = 7; d.p` does not even
  round-trip on those, so any enumeration over them would be vacuous by
  construction.

The `__integrity_bag` registration moves ahead of `__defineProperties`. That
changes only the *emission order* of one defined function; every reference is
resolved through `ctx.funcMap`, and the reserve-then-fill helpers it calls are
reserved in `object-runtime.ts` long before this module runs, so no baked
`call <idx>` operand moves.

### 3. `Object.create(O, undefined)` — §20.1.2.2 step 3 is conditional

"If properties is **not undefined**, return ? ObjectDefineProperties(obj,
properties)". The generic arm handed `undefined` straight to
`__defineProperties`, whose own step-1 `ToObject(undefined)` correctly throws.
Two different spec steps, one of which does not apply. The static spelling
(`undefined` / `void 0`) is now folded away, with the argument still compiled
for its side effects.

**Residual, stated plainly:** a *runtime-valued* `properties` that happens to be
`undefined` still reaches the helper and throws. Folding that needs an
is-undefined test at the externref boundary and is left to #4010.

## Refusals that deliberately survive

`[SITE-O-NO-CARRIER]`, `[SITE-PROPS-NO-CARRIER]`, `[SITE-PROPS-VEC-INDEXED]`,
`[SITE-PROPS-STRING-INDICES]`. Each is tagged so the next harvest reads the
*mechanism* rather than the family — the failure mode that let the previous
attribution stand unchallenged for three weeks. The 26-file `NO-CARRIER` bucket
is blocked on the exotic-receiver own-property substrate (#4010) and is not
fixable here.

## Validation

`tests/issue-4047.test.ts` — 23 cases, all zero-import, each pinned to an exact
expected outcome rather than "does not throw":

- 2 controls (a `$Object` map must define; a primitive descriptor entry must
  still throw) — these fail if the harness itself stops discriminating;
- 9 cases for the shapes that now resolve;
- 6 **negative** cases pinning the refusals that must SURVIVE — non-empty
  string, non-empty array, Date as `Properties`, Date as `O`, primitive `O`,
  `undefined` / `null` `Properties`. Without these, a later "simplification"
  that drops a refusal reads as a pure win while manufacturing vacuous passes;
- 4 regression guards for the gains this touches: #3957 RC1 (accessor-defined
  descriptor entry), #3957 RC2 (closed-struct map via identifier), the static
  object-literal expansion, and #4032 `Object.freeze`/`isFrozen` on an Array
  (which shares the resolver whose registration moved).
