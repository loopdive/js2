---
id: 4098
title: "standalone: class instance fields are not own properties of the instance — the unanimous blocker of #3976's residual"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen
es_edition: ES6
language_feature: class-elements
goal: standalone
horizon: l
parent: 2860
related: [3976, 2860, 3571]
origin: "measured as the sole residual bucket of #3976 slice 1 (senior-dev-3976-class-elements, 2026-08-02)"
---

# standalone: class instance fields are not own properties of the instance

#3976 slice 1 made `C.prototype` a real `$Object` and flipped **479 of the 539**
`C.prototype`-receiver files. **All 60 residuals are ONE bucket, unanimous:**

```
Test262Error: foo descriptor value should be foobar; foo descriptor should be enumerable; …
```

i.e. a class *instance field*

```js
class C { foo = "foobar"; m() { return 42; } }
verifyProperty(new C(), "foo", { value: "foobar", enumerable: true, writable: true, configurable: true });
```

is not an own property of the **instance**. Per §15.7.14 / DefineField, a public
instance field is installed on the instance with
`{writable: true, enumerable: TRUE, configurable: true}` — note `enumerable:
true`, the opposite of a method, so this needs `Object.keys` / for-in to *include*
it.

## Population — measured, with denominators

- **60** = the entire residual of #3976's full 539-file `C.prototype` run
  (`479/539` pass after slice 1; 60 fail, 100 % in this bucket).
- **276** = the census's `receiver = c` bucket in #3976 (instance fields on an
  instance), from the 1,136-file `should have an own property` family.

These overlap: a file can verify both a prototype method and an instance field.
**Do not add 60 + 276.** Re-derive the union before sizing — the #3976 census
harness (`plan/probes/3976/census.mjs`) plus `.tmp/classify.mjs`-style static
classification is the instrument, and `census.mjs` refuses to be trusted unless
it reproduces the published standalone baseline.

## Why this is NOT a repeat of #3976's shape

#3976's receiver was a **singleton** (`__proto_<C>`, one per class, lazily
materialized in a module global), which is what made "build it as an `$Object`
once" viable. An **instance** is not a singleton: it is a `$ClassName` WasmGC
struct allocated per `new C()`, with the fields as real typed struct fields. You
cannot replace instances with `$Object` without giving up the typed-field
representation that the whole class lowering depends on.

So the mechanism must be different. Two candidate shapes, neither yet measured:

1. **Closed-struct reflective arms.** `fillClosedStructHasOwnArms`
   (`object-runtime.ts` ~6247), `fillClosedStructFieldArms` (~6558) and
   `fillClosedStructOwnPropertyNamesArms` (~6432) ALREADY answer
   `hasOwnProperty` / dynamic get / `getOwnPropertyNames` for class structs by
   `ref.test $ClassName` + `struct.get`. What is missing is
   `getOwnPropertyDescriptor` (with `enumerable: true` for fields), the
   `Object.keys`/for-in enumerable half, and — the hard part, exactly as in
   #3976 — **write-through and delete**, which `verifyProperty` probes by
   mutating. A struct field can be written; `delete` cannot remove it.
2. **A per-instance overlay bag**, like the closure carrier bag
   (`carrier-bag-hasown.ts`, `__closure_bag_lookup`), recording deletions as
   tombstones and shadowing writes.

**Read #3976's measurement before scoping this**: 100 % of that population
asserted `writable` AND `configurable`, so a presence-and-descriptor-only fix
flipped zero. Verify the same ratio here **before** committing to a slice — it is
the step that decides whether the delete path is optional.

## Acceptance criteria

- `Object.getOwnPropertyDescriptor(new C(), "foo")` returns
  `{value, writable: true, enumerable: true, configurable: true}` for a public
  instance field.
- `Object.keys(new C())` and `for…in` **include** `foo` (fields are enumerable —
  unlike methods).
- Private fields (`#f`) stay absent from the own-property surface, including the
  `__priv_` mangled spelling.
- Report measured fail→pass **and** pass→fail with denominators, plus a
  regression control drawn from the standalone-passing class population, with any
  apparent regression re-run **solo** before it is believed.

## Blocker to check first

`for…in` / `Object.keys` correctness here is entangled with **#4099**:
`__object_keys` and `__object_keys_forin` currently ignore `FLAG_ENUMERABLE`
entirely. Since fields are the enumerable case, this issue may need #4099 landed
first to be verifiable at all.
