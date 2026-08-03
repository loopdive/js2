---
id: 4143
title: "Object.defineProperty on a carrier-less instance whose PROTOTYPE has the same key is a silent no-op — 14 files"
status: ready
sprint: current
created: 2026-08-03
updated: 2026-08-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: n/a
goal: standalone-mode
related: [4010, 4098, 4061]
---

# `Object.defineProperty` on a carrier-less instance whose PROTOTYPE has the same key is a silent no-op — 14 files

Split out of #4061 on 2026-08-03 after re-deriving that issue's population by
spec step rather than by error signature. #4061's filed body described these 14
as "§8.12.9 step 1 — redefine over an INHERITED property". They are not a
descriptor-validation defect at all, and the missing TypeError they are
measured by is a **symptom**, not the bug.

## Reduced repro — standalone, upstream/main `14eaf9f87`

```ts
var proto: any = {};
Object.defineProperty(proto, "foo", { value: 12, configurable: true });
var Ctor: any = function () {};
Ctor.prototype = proto;
var obj: any = new Ctor();

Object.defineProperty(obj, "foo", { value: 11, configurable: false });

// MEASURED:
//   obj.foo                    === 12      (the INHERITED value)
//   obj.hasOwnProperty("foo")  === false   (no own property was created)
//   proto.foo                  === 12      (the prototype was NOT corrupted)
```

The define is **simply lost**. It does not land on the instance, and it does
not leak to the prototype. This is a silent wrong answer, not a refusal.

## Control — the same sequence WITHOUT an inherited same-named property

```ts
var proto: any = {};                       // no `foo` anywhere on the chain
Object.defineProperty(proto, "foo", { value: 12, configurable: true });
var obj: any = {};                          // plain object literal receiver
Object.defineProperty(obj, "foo", { value: 11, configurable: false });
var threw = 0;
try { Object.defineProperty(obj, "foo", { configurable: true }); } catch (e) { threw = 1; }
// MEASURED: threw === 1, obj.foo === 11 — correct.
```

So the trigger is specifically **an own define on a receiver that (a) has no
property carrier — a `new Ctor()` instance — and (b) inherits a property of
that name**. With a plain `{}` receiver the identical define and the identical
non-configurable redefine both behave correctly.

## Why the test262 rows look like a missing TypeError

All 14 files follow the shape "define an own non-configurable `P`, then redefine
it and expect a TypeError" (§8.12.9 step 1). Because the FIRST define never
creates the own property, the second define has no own non-configurable
property to reject against — so it does not throw, and the row is counted under
`Expected a TypeError to be thrown but no exception was thrown at all`. Fixing
the throw without fixing the lost define would produce a *correct-looking*
number over a still-broken store.

## Population (fresh standalone baseline, 48,619 entries, 2026-08-03)

14 files, all reproducing at `14eaf9f87`:

- `built-ins/Object/defineProperty/15.2.3.6-4-{24,25,28,29,31,33,39,40,42}.js` (9)
- `built-ins/Object/defineProperties/15.2.3.7-6-a-{3,4,7,8,10}.js` (5)

`-33/-39/-40/-42` use a Function / Date / RegExp / Error receiver rather than a
user constructor, which is the same carrier-less shape.

Denominator context: these 14 are part of the 64 rows carrying that error
signature across `built-ins/Object/{create,defineProperties,defineProperty}`
(2,083 standalone entries, 1,392 pass). The rest of the 64 are 17 genuine
§8.10.5 descriptor-argument rows (#4061, fixed) and 33 §15.4.5.1 Array
`length`/array-index define rows (g-arraylen). **Do not size this bucket off
the shared error string** — that is how #4061 came to carry two unrelated
mechanisms under one count.

## Routing

Not S3 (#4010) — S3's arms are bag-only, and carrier-less receivers are exactly
the population S3 measured 0/110 on. This belongs with **#4098 (G1)**, which
owns carrier-less receivers.

## Acceptance

- [ ] `Object.defineProperty(instance, k, desc)` creates an OWN property on a
      carrier-less receiver even when the prototype chain already has `k` —
      asserted by `hasOwnProperty`, not only by a read (a read can be satisfied
      by the inherited value and hide the defect).
- [ ] The prototype is not mutated by the instance define.
- [ ] The subsequent non-configurable redefine throws TypeError (§8.12.9 step 1)
      — as a CONSEQUENCE of the own property now existing, verified with the
      `hasOwnProperty` assertion above so a throw cannot be credited to a still-lost define.
- [ ] The 14 files above flip to pass in the standalone lane, reported with the
      denominator.
- [ ] Regression check on receivers that legitimately have no own property:
      inherited reads still resolve through the prototype.
