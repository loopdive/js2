---
id: 4061
title: "Descriptor-ARGUMENT validation in Object.create/defineProperties (§8.10.5) + §8.12.9 step 1 redefine-over-inherited — 31 files"
status: done
completed: 2026-08-03
assignee: ttraenkler/dev-4061-descriptor-args
sprint: 78
created: 2026-08-02
updated: 2026-08-18
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: n/a
goal: standalone-mode
---

## Re-measurement 2026-08-03 (fresh baselines, upstream/main `14eaf9f87`)

Baselines force-fetched immediately before measuring: host 48,368 entries,
standalone 48,619 entries — both post-#4047.

### Population, re-derived by SPEC STEP rather than by error signature

Across `built-ins/Object/{create,defineProperties,defineProperty}` (2,083
standalone entries, 1,392 pass) the signature "Expected a TypeError to be
thrown but no exception was thrown at all" holds **64** rows. Reading every
one of the 64 bodies' `description` field splits them cleanly:

| Spec step | Files | Owner |
| --- | ---: | --- |
| §8.10.5 step 7.b — `get` present, not undefined, not callable | 5 | **#4061** |
| §8.10.5 step 8.b — `set` present, not undefined, not callable | 6 | **#4061** |
| §8.10.5 step 9.a — data + accessor fields both present | 4 | **#4061** |
| §8.10.5 step 1 — descriptor is not an Object | 2 | **#4061** |
| §8.12.9 step 1 — redefine over a non-configurable own property | 14 | **NOT #4061 — see below** |
| §15.4.5.1 — Array `length` / array-index define | 33 | g-arraylen |

31 + 33 = 64. The 31 reproduces the filed count **exactly**, but it is not the
same 31 the issue describes: only **17** of it is descriptor-argument
validation.

### The §8.12.9 arm is a different defect — own-define shadowing a prototype

The 14 §8.12.9-step-1 files are titled "…overrides an inherited …property",
and that phrasing is load-bearing. Reduced against `14eaf9f87`, standalone:

```ts
var proto: any = {};
Object.defineProperty(proto, "foo", { value: 12, configurable: true });
var Ctor: any = function () {};
Ctor.prototype = proto;
var obj: any = new Ctor();
Object.defineProperty(obj, "foo", { value: 11, configurable: false });
// obj.foo === 12   obj.hasOwnProperty("foo") === false   proto.foo === 12
```

The FIRST define is a **silent no-op**: no own property is created, the read
still resolves to the inherited value, and the prototype is not corrupted
either — the define is simply lost. So the second define has no own
non-configurable property to reject against, and the missing TypeError is a
*symptom*. Control: with a plain `{}` receiver (no inherited `foo`) the same
sequence throws correctly and `obj.foo === 11`.

That is an own-property **store/visibility** defect — the unified own-property
store's territory (S1′/S2/**S3 visibility**, #4010) — not descriptor-argument
validation, and it must not be fixed from this issue. Split out; #4061 is
scoped to the 17-file §8.10.5 arm.

### Reconciliation of the stale-cited 43-row refusal — already done by #4047

The refusal `Object.defineProperties unsupported descriptor shape in
standalone mode (#1906)` was reconciled upstream on 2026-08-02 by
`288742a1d` (#4047), before this issue was picked up. Its measurement over all
952 `built-ins/Object/{defineProperties,create}` files found **zero** rows
reaching either per-descriptor site; 100 % were refusals of the *receiver's*
wasm representation, and the message named a descriptor problem only because
of a mis-attributed 2026-07-13 harvest note.

Fresh count today: **52** rows, every one carrying one of #4047's new
site tags — 42 `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`, 10 `[SITE-O-NO-CARRIER]`.
The bucket did not vanish and it did not shrink to 43→0; it is *larger* than at
filing, which is the correct direction: #4047 kept the refusal loud for
carrier-less receivers precisely because the applier's terminal arm is a
lenient no-op, so letting them through would trade a loud refusal for a silent
wrong answer. Neither residual tag is a descriptor-ARGUMENT problem;
`SITE-PROPS-BAG-NOT-AUTHORITATIVE` is a store-visibility question and belongs
with the same S3 work as the §8.12.9 arm above.

**Verdict: nothing to remove and nothing to extend at the refusal site from
this issue.** The stale citation is resolved; the residual is not ours.

### Mechanism of the 17-file §8.10.5 arm

`Object.create(proto, Properties)` has its **own** static descriptor expansion
in `src/codegen/expressions/call-builtin-static.ts` (the `Object.create` block),
entirely separate from `compileObjectDefineProperties`. Its fast-path gate
admits any descriptor that is an object literal with statically ToBoolean-
resolvable flags — and consults neither `isStaticDescWellFormed`
(descriptor-shape.ts, #3991) nor the non-object-descriptor check that
`Object.defineProperty` has had since #1460. So:

- `{prop: {get: null}}` — admitted, `flags |= ACCESSOR`, then
  `__defineProperty_value` called with a null value. No throw.
- `{prop: {get: f, value: 1}}` — admitted with HAS_VALUE **and** ACCESSOR set.
- `{prop: null}` — rejected by the fast-path gate, falls to the dynamic
  applier `__obj_define_from_desc`, which deliberately treats a null/undefined
  descriptor as a lenient empty-descriptor no-op. Its header states the
  assumption behind that leniency: *"the call site already throws for a
  statically-non-object literal"* — true of `Object.defineProperty`, false of
  `Object.create`. Defines nothing, throws nothing.

Fix, narrowest site:

1. `descriptor-shape.ts` — export `isStaticallyNonObjectDescExpr` (moved from
   `object-ops.ts`, where being module-private is why `Object.create` could not
   use it) and `literalNullAccessorField`.
2. `call-builtin-static.ts` — add `isStaticDescWellFormed` to the
   `Object.create` fast-path gate, so ToPropertyDescriptor violations route to
   the dynamic applier, which is the only path implementing the conflict and
   callable checks at all.
3. `call-builtin-static.ts` — in the dynamic-apply loop, emit the two throws
   that applier structurally cannot: the non-object descriptor (it no-ops), and
   a literal `get`/`set: null` (indistinguishable from the *legal*
   `{get: undefined}` at the wasm boundary, #2106 — the same reason
   `Object.defineProperty`/`defineProperties` already throw eagerly, #3116).
   Emitted per key inside the loop, so earlier keys still apply first.

### It was also a SILENT WRONG ANSWER, not only a missing throw

Found while writing this issue's own negative test. The expansion reads
`get`/`set` **only** to set the ACCESSOR flag bit and then calls
`__defineProperty_value` with a NULL value — it never compiles the accessor
function. So it could model no accessor descriptor at all, well-formed or not.
Measured on `14eaf9f87`, standalone:

```
Object.create({}, {p: {get: function () { return 9; }}}).p    ->  0     ← wrong, silent
Object.create({}, {p: {get: g}}).p                            ->  0     ← identifier getter, same
Object.defineProperty(o, "p", {get: function () { return 9; }}); o.p   ->  9   ← control
```

A conformance gain bought with a silent wrong answer is negative value, so the
fix rejects **every** accessor-bearing descriptor from the static expansion
(`descriptorHasAccessorField`), not merely the malformed ones — which is what
descriptor-shape.ts' own invariant already required: a `true` answer is a
PROMISE the expansion can fully model the descriptor. Nothing is lost by
rerouting; the dynamic applier was verified directly against a runtime
descriptor variable — non-callable `get`/`set` (3 shapes) and data+accessor
conflicts (2 shapes) all throw there, a legal accessor does not.

The old test shape ("`assert.throws` did not fire") could not have caught this;
the tests here assert the getter **runs** (returns 9 / 5).

## Measured result

Kill-switch receipt — base arm `14eaf9f87` (upstream/main), fix arm
`750ca9e46` (this branch, both commits). Standalone lane, `runTest262File`,
run in batches with each non-pass re-checked.

| Set | Base | Fix |
| --- | ---: | ---: |
| §8.10.5 arm (this issue's scope) | 0 / 17 | **16 / 17** |
| §8.12.9 arm (split out to #4143) | 0 / 14 | 0 / 14 — untouched by design |
| `accessed !== true`, 3 families | 0 / 42 | 0 / 42 — see below |

### The one file NOT fixed, on the record

`built-ins/Object/defineProperties/property-description-must-be-an-object-not-symbol.js`
— `Object.defineProperties({}, {a: Symbol()})`. A different entry point (the
plural native, not `Object.create`) and a **symbol** descriptor, which
`isStaticallyNonObjectDescExpr` does not classify: `Symbol()` is a
CallExpression, so it routes to the dynamic `__defineProperties`, which does not
apply §6.2.5.6 step 1 (`Type(Obj) is not Object → TypeError`) to a symbol. The
fix belongs inside that native's ToPropertyDescriptor entry — the same native
#4047 had just reworked — so it is deliberately not reached from here.
Claimable as a one-file follow-up; it is a named residual, not an unknown.

### Non-flip finding: the 42-row `accessed !== true` bucket is a different defect

Measured 0/42 both arms. These are §8.10.5 **step 3.a** — reading the
`enumerable` field off a descriptor that is not a plain object literal
(`descObj = new ConstructFun()` with `enumerable` INHERITED from its prototype;
an Array with `arrObj.enumerable = true`), then asserting the defined property
shows up in `for…in`. Those descriptors already routed to the dynamic applier
before this fix, so the fix cannot move them: the defect is in the applier's
descriptor-FIELD READ, not in which path is chosen. `hasField` there goes
through `__desc_has_own` (#4055), an OWN-property check, so an *inherited*
`enumerable` is invisible to it — while ToPropertyDescriptor specifies
[[Get]], which is proto-inclusive. Same store-visibility family as #4143 /
#4098, not descriptor-argument validation.

# Descriptor-ARGUMENT validation in Object.create/defineProperties (§8.10.5) + §8.12.9 step 1 redefine-over-inherited — 31 files

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Split out of the "117-file family" by g-enforce (2026-08-01) after classifying all 117 by what each test body actually does. Deliberately NOT folded into #3983 — genuinely different defect.

POPULATION: 31 files, standalone lane, ≤ES5 goal scope.

MECHANISM (two related arms):
  (a) §8.10.5 ToPropertyDescriptor argument validation — steps 1 / 7.b / 8.b / 9.a.
      Shapes: `{prop: null}` (descriptor not an Object), `get:` bound to a primitive
      (non-callable accessor), and `get` + `value` present together (mutually
      exclusive fields). Each must throw TypeError; standalone does not.
  (b) §8.12.9 step 1 — redefine over an INHERITED property.
  Entry points: Object.create and Object.defineProperties.

WHY IT IS SEPARATE from the fixed/claimed work:
  - #3983 (g-enforce, fixed) = the assignment / compound-assignment WRITE path,
    37 files. Root cause was `ctx.funcMap.set("__extern_set_strict", externSetIdx)`
    aliasing strict [[Set]] onto the sloppy helper. Nothing to do with argument
    validation.
  - g-arraylen = Array-receiver DEFINE path, 35 files (maybeEmitVecLengthDefine
    routing gap; compileObjectDefineProperties never reaches it).
  This bucket is the NON-Array define path and is about rejecting malformed
  DESCRIPTOR ARGUMENTS before any define happens — a validation gap, not a
  routing or enforcement gap.

⚠ SIZING DISCIPLINE — read before quoting any number:
  The "117-file family" was a SIGNATURE census (all files sharing the error string
  "Expected a TypeError to be thrown but no exception was thrown"), NOT one
  mechanism. It decomposes 37 / 35 / 31 / 11 (Function.prototype.caller poisoning)
  / 2 (Object.getOwnPropertyNames arg validation) / 1 (arguments.callee).
  Quoting 117 for any single fix overstates it by ~3x. Do not size off the
  signature; read the bodies.

⚠ ALSO RETRACTED: the earlier claim that a sloppy write to a writable:false property
  traps with an uncatchable raw WebAssembly.Exception is FALSE. It is a catchable
  TypeError in-module; the observation came from a probe with no try/catch, where any
  standalone throw surfaces as an opaque WebAssembly.Exception by construction.

⚠ MEASUREMENT: scoped standalone arms on this box see compile_timeout contention
  flakes. g-enforce's 220-file control showed 5 apparent flips that were all flakes
  (re-run solo: 5/5 pass). Counting them would have inflated +24 to +29. Re-run any
  apparent flip solo before crediting it.

Context: /workspace/plan/log/analysis-2026-08-01-descriptor-dedup-map.md
Allocate a fresh issue id via `node scripts/claim-issue.mjs --allocate --by ttraenkler/&lt;agent&gt;`.

## Follow-ups left open

- **`src/codegen/expressions/call-builtin-static.ts` now sits EXACTLY at its LOC
  ceiling (3683/3683) — there is zero headroom.** The next line added to that
  driver fails the #3102/#3131 ratchet. The sanctioned move is **extraction** —
  lift `Object.create`'s descriptor expansion (both the static-literal arm and
  the dynamic-apply arm) into its own module, the way `array-length-define.ts`
  (#3984) and `descriptor-shape.ts` (#3991) were lifted — **not** a
  `loc-budget-allow:` grant. This PR declined the grant for that reason: the
  +66 it needed was almost entirely rationale, and burying rationale in a
  3.7k-line driver is the exact failure `descriptor-shape.ts`' own header
  describes ("how its central claim went unexamined for so long"). It went into
  that module instead, behind `mayStaticallyExpandCreateDescriptor` and
  `staticDescriptorTypeError`. Note that `mayStaticallyExpandCreateDescriptor`
  takes `staticToBoolean` as a PARAMETER on purpose — importing it would create
  a `descriptor-shape → calls → object-ops → descriptor-shape` cycle.
- **The §6.2.5.6-step-1-for-a-symbol case**, one file — see above.
- **#4143**, the 14-file define-over-inherited silent no-op, split out.
- **#4146**, the JS-host lane's `Object.create` → `__defineProperty_desc` route,
  split out. The fix here is complete in **standalone** (26/26 local assertions,
  16/17 test262). In the host lane the eight cases that reach their TypeError
  *through the applier* rather than through a compile-time throw do not hold,
  and `Object.defineProperty` is the control that proves this is specific to
  what `Object.create` routes into rather than a general host gap:
  `defineProperty + get: fn` gives **9 in both lanes**, while
  `create + get: fn` gives **NaN on host / 9 on standalone**. #4146 also records
  the mirror-image gap the same control exposed — standalone
  `Object.defineProperty` does *not* throw for a non-callable `get` while host
  does. Neither is a regression from this PR: before it, those descriptors took
  the static path and were dropped just as silently. `tests/issue-4061.test.ts`
  therefore asserts them standalone-only, with the measurement inline, instead
  of encoding the bug in a host assertion.
