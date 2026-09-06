---
id: 5354
title: "`instanceof` against a linked-provider class is always false — consumer-constructed instances lose prototype identity across the module boundary (32 of 123 Temporal calendar rows)"
status: done
completed: 2026-09-06
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-09-06
# 2026-09-06 (#5354). The identity fix lands where the boundary already is:
# `_wrapForHost`'s trap table (runtime.ts) and the two finalize call sites that
# emit the owning-module resolver. The NEW logic is in its own module
# (src/codegen/class-object-of.ts, 0 → ~190 LOC, unbudgeted); what grows here is
# only the wiring — 2 call lines + 1 import in the barrel, and 4 traps in
# `_wrapForHost` (getPrototypeOf, preventExtensions, get/`constructor`).
loc-budget-allow:
  - src/codegen/index.ts
  # Inherited by stacking on #5251 (PR #5648) — restated so the grant is not
  # stranded if CI's merge preview drops that file from the change-set.
  - src/codegen/destructuring-params.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/type-coercion.ts
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::_wrapForHost
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  # Inherited from #5251, restated for the same reason.
  - src/codegen/destructuring-params.ts::destructureParamObject
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/type-coercion.ts::coerceType
---

# #5354 — class-VALUE prototype identity does not cross the linked-module boundary

## Problem

Measured by dev-5251 (PR for #5251) from the consumer side of the #4628 linked
Temporal provider, with instances the CONSUMER constructs itself:

```js
const d = new Temporal.PlainDate(1997, 12, 1);
d instanceof Temporal.PlainDate                         // false  (node: true)
Object.getPrototypeOf(d) === Temporal.PlainDate.prototype // false
d.constructor                                            // undefined
```

test262's `TemporalHelpers.assertPlainDate` (and every `assert*` sibling)
opens with an `instanceof`, so **32 of the 123 #5249 calendar rows** stop at
exactly this line after #5249/#5352/#5250/#5251 cleared the layers beneath.
It is the largest remaining Temporal blocker that is ours (the other, #5355,
is an Intl capability gap).

Adjacent, none of them this: #5237 (cross-module member resolution), #5239
(`Object.create(C.prototype)`), #5242 (ctor bridge for classes reached as
values). Those made construction and method calls work across the seam; the
OBJECT identity graph — `[[Prototype]]`, `constructor`, and what `instanceof`
consults — still does not.

## Implementation Plan (Fable, 2026-09-06)

1. **Measure which identity is missing.** Three probes, consumer side, both
   lanes (linked provider vs single-module control): (a) `getPrototypeOf(d)`
   — is it the provider's `PlainDate.prototype` object, a mirror, or `null`;
   (b) `Temporal.PlainDate.prototype` — is it the provider's object or a
   fresh host mirror each read (identity stability across two reads);
   (c) `Temporal.PlainDate[Symbol.hasInstance]` — present? The single-module
   control answers `true` for all, so the diff localises the seam.
2. **Locate the host-mirror minting** for a provider class reached as a value
   (`src/runtime.ts`: `_makeClassCtorMirrorForHost` and the #5242 ctor bridge;
   the #5239 `Object.create` path; the #5237 member-resolution cache). The
   likely root: the ctor mirror is a fresh host `Function` whose `.prototype`
   is a mirror OBJECT unrelated to the struct-side prototype registry, so an
   instance minted by the compiled `_new` never links to it, and
   `instanceof` (OrdinaryHasInstance walks `[[Prototype]]`) finds nothing.
3. **Fix at identity, not at `instanceof`**: the mirror's `.prototype` must be
   the SAME host object that `getPrototypeOf(instance)` answers, cached per
   class object (module-keyed — #5225's minting-module rule applies: the
   prototype belongs to the module that owns the struct). Then `instanceof`,
   `getPrototypeOf`, and `constructor` all follow from one fix. Do not
   special-case `Symbol.hasInstance` unless step 1 shows identity is already
   right and only `hasInstance` is missing.
4. **Reduction + test** in both lanes; base-failing on the linked lane, green
   on the single-module control (which pins that this is seam-only).
5. **Measure** `family-123.txt` (provider linked, fresh cache per compiler
   revision): expect the 32 `assertPlainDate` rows to move; state the next
   layer. Suites: #5237/#5239/#5242 families + the 9 provider suites +
   equivalence at 24/1718.

## Acceptance criteria

1. Step 1 evidence in the PR (which identity was missing, both lanes).
2. `instanceof`, `getPrototypeOf`, `constructor` correct for consumer-
   constructed instances of a linked class; base-failing test.
3. 123-row re-measurement with counts and next-layer reasons.

## Notes

- Filed from dev-5251's residual census (PR for #5251, 2026-09-06).
- Id reserved via `claim-issue --allocate` with a degraded open-PR scan.

## Implementation notes (dev-5354, 2026-09-06)

### Step 1 — which identity was missing (measured, both lanes)

`.tmp/probe-5354.mts`, provider `class Point { … }` in a linked npm package vs
the identical two-file program compiled as ONE module. Base = this branch's
merge base (#5251 + #5352 docs merged in).

| probe (consumer side)                    | LINKED base | LINKED fixed | CONTROL (base = fixed) |
| ---------------------------------------- | ----------- | ------------ | ---------------------- |
| `d instanceof Point`                     | false       | true         | true                   |
| `getPrototypeOf(d) === Point.prototype`  | false       | true         | true                   |
| `typeof getPrototypeOf(d)`               | "object"    | "object"     | "object"               |
| `Point.prototype === Point.prototype`    | **true**    | true         | true                   |
| `typeof d.constructor`                   | "undefined" | "function"   | "function"             |
| `d.constructor === Point`                | false       | true         | true                   |
| `typeof Point.prototype.constructor`     | "undefined" | "function"   | "function"             |
| `typeof getPrototypeOf(Point.prototype)` | **"null"**  | "object"     | "object"               |
| `typeof Point[Symbol.hasInstance]`       | "undefined" | "undefined"  | "function"             |
| `Point.make(1,2) instanceof Point`       | false       | true         | true                   |
| `new Sub() instanceof Sub`               | false       | true         | true                   |
| `new Sub() instanceof Base`              | false       | true         | true                   |

The two bolded rows localise it. `Point.prototype` **is** identity-stable, so
nothing is minting a fresh mirror per read; and its own prototype is `null`,
which says it is the `Object.create(null)`-backed FACADE built in
`_makeClassCtorMirrorForHost`. Meanwhile `getPrototypeOf(d)` is a different
object — `Object.prototype`, hardcoded in the `_wrapForHost` proxy's trap. Two
unrelated objects, so OrdinaryHasInstance (§7.3.20) reads one and walks from the
other and can never meet. `constructor` fails for a second reason on top: a
Proxy `get` trap serves INHERITED reads itself, so a missing prototype edge is
not the only thing between the instance and `C.prototype.constructor`.

Root cause, exactly: `src/runtime.ts` `_wrapForHost` → `getPrototypeOf() { return
Object.prototype; }` (was ~L8555), against `_makeClassCtorMirrorForHost`'s
`fnTarget.prototype = facade` (~L8760). `Symbol.hasInstance` is NOT the defect —
identity was, so per the plan it is left alone (it is also not consulted:
`_instanceofResult` explicitly skips `Function.prototype[Symbol.hasInstance]`).

### Fix

Which class a foreign struct belongs to is a `__tag` read, and only the module
that owns the struct has the type for it (#5225's minting-module rule). So the
owner publishes it:

* **`src/codegen/class-object-of.ts` (new)** — `__class_object_of(inst)` and
  `__class_parent_object_of(classObj)`, tag-dispatched over
  `ctx.classCtorHostRegistered` (exactly the classes that can escape as values),
  answering the lazily-initialised class-object singletons. Discrimination is by
  `__tag`, never `ref.test` alone — WasmGC canonicalizes structurally-identical
  classes into ONE type (#2009/#5195 F1). A module that lets no class escape
  emits identical bytes.
* **`src/runtime.ts`** — `_owningClassObject` / `_hostConstructorForInstance` /
  `_hostPrototypeForInstance` (WeakMap-cached, one question per struct), wired
  into four places: the instance proxy's `getPrototypeOf` trap (the fix),
  its `preventExtensions` (pin the answer onto the target first, or §10.5.1
  makes every post-freeze `instanceof` throw), its `get` trap for `constructor`,
  and the facade's `constructor` + `getPrototypeOf`.

The class object and the class prototype carry the same tag as an instance, so
both answer the export; they are screened HOST-side, where their identities are
already held (`_classProtoStructs`, `_prototypeMethodNames`) and cost no wasm.

The facade needed its own `getPrototypeOf` (→ parent's facade, else
`%Object.prototype%`) or the newly-linked chain would have DEAD-ENDED at it:
`d instanceof Object` was true before the fix and would have become false.

### Reported, not fixed (all pre-existing, measured on base)

* `getPrototypeOf(getPrototypeOf(new Sub()))` is not `Base.prototype` in the
  SINGLE-MODULE lane. That is the raw-struct arm of the `__getPrototypeOf`
  import, deliberately untouched: in that lane `C.prototype` is the RAW
  prototype struct, so answering the host facade there would introduce the very
  identity split this issue removes. Bound: single-module, two-hop chain walks.
* `typeof C[Symbol.hasInstance]` — "undefined" through the seam, "function" in
  the control lane (the mirror's `get` trap delegates everything to the property
  proxy and never falls through to `Function.prototype`). Does not affect
  `instanceof`. Bound: programs that READ the well-known symbol off a linked
  class.
* `({x:1}) instanceof Point` fails to COMPILE in the single-module lane —
  `struct.get[0] expected type (ref null 16), found struct.new of type (ref 27)`
  — identically on base. Unrelated static-`instanceof` lowering bug; kept out of
  the probes so it could not mask this measurement.
* Inline `Object.getPrototypeOf(C.prototype)` answers "null" in the
  single-module lane where the two-statement spelling answers "object"; a
  static-fold shape difference, on base as well.

### Step 5 — the 123 #5249 calendar rows, re-measured

Same list, same driver, `JS2WASM_TEST262_TEMPORAL=1` with a FRESH
`JS2WASM_TEMPORAL_CACHE` per compiler revision (the provider cache keys on
polyfill source + options, not on the compiler, so a shared dir would serve the
other side's binary). Both sides ran all 123 rows.

| failure bucket (first line of the reason)  | base | after |
| ------------------------------------------ | ---- | ----- |
| `assert*: instanceof`                      | 32   | 13    |
| `Unsupported era name: …`                  | 0    | 10    |
| `eraName must be string or undefined …`    | 0    | 8     |
| `RangeError: Invalid ISO date …`           | 67   | 68    |
| other (`infinity is out of range`, …)      | 20   | 20    |
| **pass**                                   | 4    | 4     |

**19 of the 32 `instanceof` rows moved**, 0 rows gained one, and **no row
changed STATUS in either direction** — the freed rows land on the next layer
rather than passing, because these files carry many assertions each.

The 13 that still report `instanceof` are NOT the same 13 shapes: 12 of them
progressed to a LATER assertion in the same file (e.g. `since/leap-year-japanese`
went from `"2 months in same year across Feb 28: instanceof"` to
`"negative 61 years, 28 days in common year: instanceof"`). Every direct
`instanceof` door now answers `true` through the linked provider
(`.tmp/probe-temporal-5354.mts`, cache `tcache-fix5354`):

    new PlainDate / PlainDate.from / .add / .with          true
    new Duration / Duration.from / .until / .since         true
    new PlainDateTime / PlainYearMonth.from / pym.until    true
    (until(...)).constructor.name                          "Duration"

so a remaining `instanceof` message is the assert helper REPORTING a value that
a deeper failure produced, not a live identity gap.

**Next layer, named:** the era/calendar arithmetic inside the polyfill —
`Unsupported era name: gregory|roc|japanese|…-inverse` (10) and
`eraName must be string or undefined … SameValue("number", "string")` (8), both
of which only became visible once `instanceof` stopped short-circuiting; plus
the pre-existing 68-row `RangeError: Invalid ISO date` bucket, which is the
`Intl.DateTimeFormat` shell (#5355/#5206) and is not ours to fix here.

### Validation

* `tests/issue-5354-linked-class-instanceof.test.ts` — base-failing on the
  linked lane, green on the single-module control.
* `tests/issue-5239-*` — its pinned `dynProtoIdentity: "false"` (an explicitly
  reported #5237-family identity gap) is now `"true"` in the linked lane; the
  pin is removed and both lanes assert the same map.
* Suites green: #5237 · #5239 · #5241 · #5242 · #5221 · #5225 · #5226 · #5244 ·
  #5248 · #5250 · #5251 · #5352 · #4628-temporal-global · #4628-class-value-prototype.
* Collateral for the object-identity paths (`built-ins/Reflect/*` +
  `built-ins/JSON/stringify/*`, 219 rows, per-row base vs fix): 141 pass / 78
  fail on BOTH sides, **zero status flips and zero reason changes**.
* `node scripts/equivalence-gate.mjs` — 24 failing / 1718 passing, no new
  regressions.
