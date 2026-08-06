---
id: 4008
title: "Descriptor-ARGUMENT validation missing in Object.create/defineProperties (ES 8.10.5) plus 8.12.9-step-1 redefine-over-inherited"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-06
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-gap
related: []
---

# Descriptor-ARGUMENT validation missing in Object.create/defineProperties (ES 8.10.5) plus 8.12.9-step-1 redefine-over-inherited

## Problem

**31 files**, ES5+untagged goal scope. Two related arms:

**(a) ES §8.10.5 `ToPropertyDescriptor` argument validation** — steps 1 / 7.b /
8.b / 9.a. Malformed descriptor arguments must throw `TypeError` and do not:

- `{prop: null}` — descriptor is not an Object
- `get:` bound to a primitive — non-callable accessor
- `get` and `value` present together — mutually exclusive fields

**(b) ES §8.12.9 step 1** — redefine over an **inherited** property.

Entry points: `Object.create` and `Object.defineProperties`.

## Why this is SEPARATE from the adjacent fixed work

- The strict-`[[Set]]` fix was the assignment / compound-assignment **write** path
  (37 files); root cause was the strict helper aliased onto the sloppy one.
  Nothing to do with argument validation.
- The array-`length` fix was the **Array-receiver define** path (35 files); a
  routing gap where `compileObjectDefineProperties` never reached the
  ArraySetLength helper.

This bucket is the **non-Array define path**, and it is about **rejecting
malformed descriptor arguments before any define happens** — a validation gap,
not a routing or enforcement gap.

## ⚠ Sizing discipline

These 31 were split out of a "117-file family" that turned out to be a
**signature** census, not a mechanism census: it decomposed into 37 / 35 / 31 /
11 (`Function.prototype.caller` poisoning) / 2 (`Object.getOwnPropertyNames` arg
validation) / 1 (`arguments.callee`). **Quoting 117 for any single fix overstates
it ~3x.** Read bodies, do not cluster error strings.

Scoped and deliberately not folded in by `g-enforce` 2026-08-01.

## 2026-08-06 — measured decomposition of the surrounding 232-file family

Investigated while working the "L1 — ToPropertyDescriptor (ES5 §8.10.5)" lever
(232 ES5-label `--target standalone` failures across
`15.2.3.5-4-*` / `15.2.3.6-3-*` / `15.2.3.7-5-b-*`). **The lever's framing —
"ToPropertyDescriptor does not read the descriptor's fields correctly" — is
mostly WRONG, and the sizing discipline note above applies again.** Measured
baseline on that list: **1 / 232 passing**.

### How the split below was derived (this is why it is trustworthy)

Not by clustering error strings. Error-string clustering is what produced the
"117-file family" the ⚠ note above warns about, and it fails here for the same
reason: `accessed !== true` is emitted by RegExp, Date, Math, JSON and
inherited-property tests alike, so the signature census and the mechanism
census disagree by ~3x. The method that worked, in order:

1. **Reproduce one canonical failure first.** `15.2.3.6-3-40.js` and
   `15.2.3.6-3-258-1.js`, both `--target standalone`, before writing any code.
2. **Read the `description:` frontmatter of all 232 files**, normalise it
   (strip the `Object.defineProperty - ` prefix and the `(8.10.5 step N)`
   suffix, collapse the six field names to one token) and tally the *shapes*.
   The descriptions state the mechanism outright — "'Attributes' is a Date
   object …", "… of prototype object", "… is an inherited accessor property" —
   so this partitions by mechanism, not by symptom.
3. **Write one probe per candidate mechanism** and run it through the real
   standalone pipeline (`runTest262File(abs, cat, ms, "standalone")` over a
   file in `.tmp/`; leak values by `throw new Error("PROBE " + out)` since the
   runner does not surface `print`). Each row below has a probe behind it.
4. **Confirm the instrument responds** before believing a zero: the emitted
   `wasm_sha` changes with the edit, and the A/B swap moved the score back.

Root causes:

| files | root cause | is it ToPropertyDescriptor? |
| ---: | --- | --- |
| 76 | `new F()` where `F.prototype` was REASSIGNED does not link `[[Prototype]]` | no — prototype plumbing (#2660 S3 territory) |
| 51 | expando own-properties are silently DROPPED on `new RegExp()` / `new Date()` / `new Error()` | no — carrier storage |
| 34 | `Math` / `JSON` used as the descriptor object read back no fields at all | no — builtin-namespace storage |
| 12 | `Object.prototype.x = …` is invisible to every instance | no — prototype plumbing |
| ~59 | remainder (own-field on Array/plain, misc) | partly |

Probe evidence (each reproduced standalone, 2026-08-06):

- `regObj = new RegExp(); regObj.enumerable = true` → `regObj.enumerable` reads
  `undefined`, `hasOwnProperty` `false`, `in` `false`. Same for `Date` and
  `Error`. Every other receiver — plain object, array, function, Arguments,
  String/Number/Boolean wrapper — stores and reads back fine. So for a third of
  this family the descriptor never had the field to begin with; the reader was
  never the problem.
- `var proto = {}; var F = function(){}; F.prototype = proto; var c = new F();`
  → `"foo" in c === false` and `Object.getPrototypeOf(c) === proto` is
  **false**, even though `c.foo` reads through. That ConstructFun idiom is how
  test262 spells "inherited property", so it accounts for all 76.
- `Object.prototype.zzz = 1; ({}).zzz` → `undefined`, while
  `Object.getPrototypeOf({}) === Object.prototype` is `true`. The identity
  comparison passes without the chain being live.

### What landed (this PR)

Only the second row: `__is_closure_prop_carrier` (`src/codegen/closure-props.ts`)
now also accepts the `__StandaloneRegExp` and `__Date` structs, so the #3468
identity-keyed property bag covers them. **Measured 1 → 29 on the 232-file list,
0 regressions on the list.** Blast-radius check: an 800-file deterministic
sample of `built-ins/Date` + `built-ins/RegExp` (every test that can reach the
widened `ref.test` chain) scored 590 pass with the change, and every one of the
209 non-passes was re-run against `origin/main`'s `closure-props.ts` and scored
**0 / 209** — i.e. nothing that passes on main fails with the change.
`$Error_struct` is deliberately excluded — it
already owns a `$props` side-slot (fieldIdx 5, #2101a R5) that the
externref-backed-subclass own-field path writes directly, and bagging it would
give one receiver two disagreeing stores. Wiring Error to `$props` from
`__extern_get`/`__extern_set` is the next slice, worth ~17 files.

### Measured NEGATIVE result worth keeping

A spec-correct widening of `__desc_has_own` from HasOwnProperty to the full
§7.3.12 HasProperty (delegating to `__extern_has`, which already walks the
chain) was written, verified to change the emitted module, and measured at
**+0** — twice, once alone and once A/B'd against the carrier fix. It is a real
prerequisite for the 88 prototype-chain files but yields nothing until the chain
is actually live, so it was **dropped from the PR** rather than shipped as
unmeasured generality (the #4017 lesson: generality at a shared point IS blast
radius). Re-land it together with the prototype work, where it can be shown to
be load-bearing.

### Pickup notes for the prototype-chain slice (88 files — the big one)

Whoever takes this next: the two prototype rows (76 + 12) are **one substrate
gap**, and it is the largest single lever left in this family.

- **Reproduce it in four lines**, no descriptors involved:

  ```js
  var proto = {}; proto.foo = 1;
  var F = function () {};
  F.prototype = proto;
  var child = new F();
  // standalone: "foo" in child === false
  //             Object.getPrototypeOf(child) === proto  === false
  ```

  and:

  ```js
  Object.prototype.zzz = 1;
  ({}).zzz            // standalone: undefined
  Object.getPrototypeOf({}) === Object.prototype   // standalone: TRUE
  ```

  That second pair is the trap to keep in mind: the identity comparison
  **passes** while the chain is not live, so `getPrototypeOf` agreeing with
  the spec is not evidence the chain works. Test presence (`in`) or a read,
  never the identity.

- **Where to start reading**: `src/codegen/expressions/fnctor-prototype.ts`
  (#2660 S2 — the per-fnctor prototype `$Object`) and its `reconstruct`
  classification via `resolveFnctorSymbol` /
  `analyzeFnctorEscapeGate`. S2's own header says S3 will seed
  `instance.$proto` from that object; the `new F()` half is what is missing.
  Note the header also records that an **unscoped** interception there
  previously cost −40 on the standalone floor, so the gate is deliberate —
  do not widen it without measuring.

- **Do NOT re-derive `__desc_has_own`.** A spec-correct widening of it from
  HasOwnProperty to the full §7.3.12 HasProperty (delegate to `__extern_has`,
  which already walks the chain and handles the carrier bag) is written,
  correct, and measures **+0** on all 232 — because there is no chain for it
  to walk. It becomes load-bearing the moment the chain is live, and should
  land *with* the prototype work so it can be shown to be. The mechanics: move
  the `registerDescriptorHasOwn(…)` call in `object-runtime.ts` to AFTER the
  `__extern_has` `registerNative` (funcIdx ordering), pass `externHasIdx`, and
  make it the final arm of the native in `carrier-bag-hasown.ts`. Prototype
  pollution was checked and is a non-issue: none of
  `value`/`writable`/`enumerable`/`configurable`/`get`/`set` is reachable via
  `in` on a plain object, array, function, RegExp, Date, Error, Arguments
  object or any primitive wrapper in standalone mode.

### Status of THIS issue's own two arms

Arms (a) and (b) as written above are **not** addressed by that PR and remain
open. Note that (b) — redefine over an inherited property — is blocked behind
the same prototype-chain gap: with `Object.prototype.x = …` invisible to
instances there is no inherited property to redefine over, so a §8.12.9 step-1
fix cannot be validated until the chain is live.
