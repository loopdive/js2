---
id: 2046
title: "standalone Reflect: receiver arg silently dropped, deleteProperty ignores freeze/configurable, no ToPropertyKey (#1905 follow-up)"
status: in-progress
assignee: ttraenkler/dev-reflect-c
sprint: 64
created: 2026-06-10
updated: 2026-09-01
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: reflect, objects
goal: standalone-mode
related: [1905, 1888, 1629, 2042]
checkpoint: draft-nonmergeable
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/index.ts
  - src/codegen/proto-index-store.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/literals.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/statements/variables.ts
  - src/codegen/vec-overlay.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/index.ts::generateModule
  - src/codegen/closed-struct-extern-set.ts::fillClosedStructExternSetArms
  - src/codegen/closed-struct-extern-set.ts::buildReceiverArms
  - src/codegen/closure-props.ts::fillClosurePropHelpers
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/object-runtime.ts::fillExternSetVecArms
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/codegen/vec-props.ts::fillVecPropHelpers
origin: "2026-06-10 sprint-61 code review of merged PR #1261 (#1905): the standalone Reflect.get/set/has/deleteProperty subset has four spec-semantics gaps, two of them silent-wrong-value."
---

# #2046 — Standalone Reflect spec gaps (#1905 follow-up)

## Problem

The #1905 native Reflect subset is structurally sound (dual-mode gating,
fail-loud for apply/construct/defineProperty, index-shift-safe helper
bodies), but review found four spec deviations. The first two produce
**silently wrong values** — worse than the refusals they replaced.

1. **Receiver argument evaluated then dropped** —
   `src/codegen/expressions/calls.ts:5067` (`Reflect.get(target, key,
   receiver)`) and `:5081` (`Reflect.set(target, key, value, receiver)`)
   call `emitAndDropOptionalArg`. With accessor properties (live since
   #1888 S5b — `__extern_get`/`__extern_set` invoke stored getters/setters),
   the getter/setter runs with `this = target` instead of `receiver`
   ([§28.1.5 / §28.1.12 → §10.1.8/§10.1.9](https://tc39.es/ecma262/#sec-reflect.get)),
   and `Reflect.set` writes to the wrong object. Minimal fix until receiver
   plumbing exists: **refuse loudly** when `arguments.length > 2` (get) /
   `> 3` (set) — a one-line gate restoring the fail-loud invariant.
2. **`Reflect.deleteProperty` ignores integrity levels and configurability**
   — routing at `calls.ts:5102-5111` into `__delete_property`
   (`src/codegen/object-runtime.ts:1187-1266`), which checks neither
   object-level `OBJ_FLAG_SEALED`/`OBJ_FLAG_FROZEN` nor per-entry
   `FLAG_CONFIGURABLE` (creatable via #1629's `__defineProperty_value`).
   `Reflect.deleteProperty(Object.freeze({x:1}), "x")` **deletes and
   returns true** (spec: keep, return false). Inconsistent with the same
   PR's own `__reflect_set`, which does preflight frozen/non-writable.
   The helper's "data props are always configurable" comment is stale.
3. **Non-object targets** — `Reflect.deleteProperty(primitive, k)` returns
   **true** (`object-runtime.ts:1201-1211`; the arm is correct for sloppy
   `delete`, wrong for Reflect — §28.1.4 requires TypeError). get/has/set
   on primitives return undefined/false/false instead of TypeError
   (`object-runtime.ts:509-516, 1468-1478, 1071-1081`) — less harmful but
   still silent deviations.
4. **No ToPropertyKey** — keys pass as raw externref into `$__obj_hash`
   which `ref.cast $AnyString` (`object-runtime.ts:289`), so
   `Reflect.get(o, 1)` **traps** instead of coercing to `"1"`
   (§7.1.19). Numeric keys are common in the test262 bucket.

Also from review (lower priority): inherited-accessor `Reflect.set` does not
walk the proto chain (documented #1888 scope boundary, consistent with plain
assignment); `tests/issue-1905.test.ts` lacks proto-chain, receiver, and
non-string-key cases; the `fallbackReturn(n, "i32-true")` dead branch at
`calls.ts:5088/5099/5110` would be safer as `i32-false`.

## Suggested order

1. The two one-line gates: refuse explicit receiver args (fix 1) and route
   non-`$Object` deleteProperty to TypeError (fix 3a). Converts
   silent-wrong to loud.
2. Integrity/configurability preflight in the delete route (share
   `__reflect_set`'s existing frozen/sealed checks; honor
   `FLAG_CONFIGURABLE`).
3. ToPropertyKey: brand-switch the key before `__obj_hash` (number →
   numeric-string via the #1335/#1759 number-to-string path; symbol keys
   may refuse loudly for now).
4. Real receiver support (plumb receiver through `__extern_get`/`__extern_set`
   accessor invocation) — coordinate with #1888 Slice 5 accessor work.

## Acceptance criteria

- `Reflect.deleteProperty(Object.freeze({x:1}), "x")` returns false and
  keeps the property; configurable:false entries likewise.
- `Reflect.get(o, 1)` returns `o["1"]` — no trap.
- Explicit-receiver forms either honor the receiver or refuse at compile
  time — never silently mis-bind `this`.
- TypeError (catchable) for non-object targets across all four methods.
- tests/issue-1905.test.ts extended with proto-chain, frozen-delete,
  numeric-key, and receiver cases; standalone test262
  `built-ins/Reflect/{get,set,has,deleteProperty}` rows improve.

## Resolution — PR-A + PR-B (2026-06-14)

PR-A (defects 1 + 3a) and PR-B (defect 2) landed; PR-C (real receiver) is
senior/deferred and PR-D (ToPropertyKey) rides #2042 — both remain, so this
issue stays `in-progress`.

**PR-A — restore fail-loud** (`src/codegen/expressions/calls.ts`, all inside
`if (ctx.standalone)`):
- **Defect 1 (receiver mis-bind):** `Reflect.get`/`Reflect.set` now refuse
  loudly (`reportError`) when an explicit receiver is present
  (`arguments.length > 2` / `> 3`) instead of evaluating-then-dropping it (which
  silently bound `this = target` for accessors, §28.1.5/§28.1.12 →
  §10.1.8/§10.1.9). Removed the now-dead `emitAndDropOptionalArg`.
- **Defect 3a (non-object deleteProperty):** added a CALL-SITE `ref.test $Object`
  guard on the target; a non-`$Object` target throws a catchable TypeError
  (`emitThrowTypeError`, §28.1.4). The SHARED `__delete_property` helper is
  untouched (sloppy `delete primitive[k]` stays a no-op success).
- Cleanup: the boolean-Reflect `fallbackReturn` dead branches now return
  `i32-false` (registration-failure default), not a phantom `true`.

**PR-B — delete configurability/integrity preflight**
(`src/codegen/object-runtime.ts`, `__delete_property`):
- After finding a live entry, refuse (return 0, keep the prop) when the object
  is sealed/frozen **OR** the entry is non-configurable
  (`FLAG_CONFIGURABLE` cleared), per §10.1.10 OrdinaryDelete.
- **Verified subtlety:** `__object_freeze`/`__object_seal` set only the
  object-level `$Object.flags` `OBJ_FLAG_SEALED` bit and do NOT clear each
  entry's `FLAG_CONFIGURABLE`, so the preflight checks BOTH the object
  `OBJ_FLAG_SEALED` bit and the per-entry `FLAG_CONFIGURABLE` bit.
  `Object.preventExtensions` (NONEXTENSIBLE only, not SEALED) does NOT block
  delete — confirmed. Correct for both `Reflect.deleteProperty` and sloppy
  `delete` (§13.5.1.2 — both refuse a non-configurable own prop).

**Remaining (out of this PR):**
- **PR-C (real receiver plumbing)** — senior/deferred, coordinates with #1888
  Slice 5 accessor-invocation machinery.
- **PR-D (ToPropertyKey)** — `Reflect.get(o, 1)` still traps ("illegal cast" on
  `ref.cast $AnyString` in `__obj_hash`). This is the SAME numeric-key fix as
  #2042 PR-A; reuse #2042's shared key-coercion helper once it lands rather than
  duplicating. Coordinated with dev-b.

## Test Results (2026-06-14)

- `tests/issue-2046.test.ts` (new) — 10/10: explicit-receiver refusal (get+set),
  no-receiver get/set work, non-object deleteProperty throws TypeError,
  object deleteProperty deletes, frozen/sealed deleteProperty → false + kept,
  preventExtensions delete still succeeds, sloppy delete honors freeze, sloppy
  delete normal succeeds.
- `tests/issue-1905.test.ts` — green (4/4, no regression).
- Pre-existing unrelated failures (byte-identical to origin/main, untouched by
  this change): `tests/object-define-property.test.ts` /
  `tests/delete-operator.test.ts` import the broken `tests/helpers.js`;
  `tests/equivalence/reflect-api.test.ts` "Reflect.construct creates a new
  instance" fails identically on clean origin/main (host-mode, not standalone).

## Implementation Plan (architect, 2026-06-17) — s63 gate slice S5 (+ PR-D dependency)

This issue owns slice **S5** of the #1472 gate (see #1472 coordinating spec).
The `standalone-reflect-refusal` bucket is now almost pure CE (295 CE / 20 fail
of 315), so S5 is a refusal-retirement slice.

### Bucket breakdown (report 2026-06-16)
- `Reflect.construct` refusal — 152 rows (largest)
- `Reflect.defineProperty` refusal — 53 rows
- `Reflect.getOwnPropertyDescriptor` refusal — 15 rows
- explicit-receiver `Reflect.get`/`Reflect.set` refusal — 29 rows
  (these are **correctly** refused per PR-A — leave them, they are honest)

### PR-D dependency (numeric keys) — consume #2042 S1, do NOT duplicate
The deferred PR-D ("`Reflect.get(o, 1)` still traps on `ref.cast $AnyString` in
`__obj_hash`") is now subsumed by **#2042 S1** (`__to_property_key` hardening at
`__obj_find`/`__obj_hash`). Once S1 lands, `Reflect.get(o, 1)` returns `o["1"]`
with zero extra work here — verify and close PR-D. Coordinate with the S1 dev so
only ONE coercion helper exists.

### S5 fix (`src/codegen/expressions/calls.ts`, inside the `if (ctx.standalone)`
Reflect dispatch block)
- **`Reflect.defineProperty(t, k, desc)`** → route to the #2042 **S3**
  `__defineProperty_desc` native; return its boolean success as i32 (Reflect
  returns `false` on failure rather than throwing). **Depends on #2042 S3.**
- **`Reflect.getOwnPropertyDescriptor(t, k)`** → route to the existing native
  `__getOwnPropertyDescriptor` (already in `OBJECT_RUNTIME_HELPER_NAMES`). No new
  runtime work — just replace the refusal with the call. **No dependency** —
  ship this first as the cheapest win.
- **`Reflect.construct(target, argsList)`** (152 rows, the big one) → route the
  2-arg form to the same construct path standalone `new X(...)` uses; **refuse**
  the 3-arg `newTarget` form (proto override needs the class/proto graph). This
  one is gated on the standalone construct machinery — coordinate with the
  #2158 class/construct owner. If construct plumbing isn't ready, keep its
  refusal and ship the two descriptor wins separately so they aren't blocked.

### Edge cases
- `Reflect.defineProperty` must return a **boolean**, never throw, even when the
  underlying define would TypeError (e.g. non-configurable redefine) — wrap the
  S4 validation so a rejected define returns `false` in the Reflect path while
  `Object.defineProperty` throws. (Same native, two call-site return shapes.)
- Non-object target → already TypeError via PR-A's `ref.test $Object` call-site
  guard; keep it for the new methods too.

### Acceptance signatures
- `built-ins/Reflect/getOwnPropertyDescriptor/*` and
  `built-ins/Reflect/defineProperty/*` standalone rows move refusal → pass.
- `Reflect.get(o, 1)` no longer traps (via #2042 S1).
- `Reflect.construct` 2-arg form passes where standalone `new` already works;
  3-arg form refuses loudly (no silent wrong newTarget).
- Extend `tests/issue-2046.test.ts` / `tests/issue-1905.test.ts` with
  numeric-key get, `Reflect.defineProperty` data+accessor desc, and
  `Reflect.getOwnPropertyDescriptor` round-trip.

## S5 slice landed — getOwnPropertyDescriptor + PR-D confirmation (2026-06-21)

PROBE-VERIFIED against current main HEAD (075d90ee5) before any change:

- **PR-D (numeric-key `Reflect.get`) — already fixed, no code change.** `#2042
  S1`'s `__to_property_key` hardening landed, so `Reflect.get(o, 1)` returns
  `o["1"]` (probe: `=> 42`) instead of trapping on the `ref.cast $AnyString` in
  `__obj_hash`. Closed PR-D; pinned with a regression test.
- **`Reflect.getOwnPropertyDescriptor` — was still refused; now routed.** The
  native `__getOwnPropertyDescriptor` (registered in `OBJECT_RUNTIME_HELPER_NAMES`)
  is now reachable end-to-end under standalone — verified independently via
  `Object.getOwnPropertyDescriptor` (value/writable/missing all correct). The
  stale registration comment near it (claiming "not reached end-to-end") predates
  #2042's read-side wiring.

**Change** (`src/codegen/expressions/calls.ts`, inside the `if (ctx.standalone)`
Reflect dispatch block, after the `ownKeys` arm): replaced the
`getOwnPropertyDescriptor` refusal with a route to the native
`__getOwnPropertyDescriptor`, returning the descriptor `$Object` (or `undefined`
for a missing own prop). §26.1.7 step 1 (non-object target → TypeError) is
enforced at the CALL SITE with the same `ref.test $Object`-guard /
`emitThrowTypeError` pattern PR-A introduced for `deleteProperty` — the shared
native (which returns `undefined` for non-`$Object` receivers, correct for the
`Object.*` caller) is untouched. ToPropertyKey on the key is handled inside the
native via `__to_property_key`, so numeric keys work.

New tests in `tests/issue-2046.test.ts` (16/16 green; 1905 4/4 unchanged): gOPD
data value, writable+enumerable+configurable flags, missing-prop→undefined,
numeric-key coercion, non-object→TypeError, and the PR-D numeric-key get pin.

**Still refused (out of this PR, issue stays `in-progress`):**
- **`Reflect.defineProperty`** — blocked on the write-side native
  `__defineProperty_desc` (generic `{value|get|set, writable?, …}` descriptor),
  which is deferred to **#2043** (see the NOTE near `__getOwnPropertyDescriptor`'s
  registration in `object-runtime.ts`). Route it the moment that native lands;
  remember the Reflect path returns `false` on a rejected define rather than
  throwing.
- **`Reflect.construct`** (152 rows, the big one) — gated on the standalone
  construct machinery (coordinate with the #2158 class/construct owner). 2-arg
  form → standalone `new X(...)` path; 3-arg `newTarget` form refuses loudly.
- **PR-C (real receiver plumbing)** — senior/deferred, coordinates with #1888
  Slice 5 accessor invocation; the explicit-receiver get/set refusal stays correct
  meanwhile.

## defineProperty slice landed — route to native applier (2026-06-25)

PROBE-VERIFIED against current main HEAD (064b27657) before any change:
`Reflect.defineProperty(o, "x", {value:42,…})` refused with
"Codegen error: Reflect.defineProperty not supported in standalone mode
(#1472 Phase C)".

**The #2043 blocker recorded above was STALE.** The write-side native
`__obj_define_from_desc` (#1629b) has backed standalone `Object.defineProperty`
since that PR and is registered by `ensureObjectRuntime` / reachable end-to-end —
no new native was needed.

**Change** (`src/codegen/expressions/calls.ts`, inside the `if (ctx.standalone)`
Reflect dispatch block; `src/codegen/object-ops.ts`): replaced the
`Reflect.defineProperty` refusal with a route through the SAME standalone
runtime-descriptor applier `Object.defineProperty` uses —
`emitDefinePropertyDescRuntime` (now exported). Reusing it (rather than calling
`__obj_define_from_desc` directly) is essential: it performs the **#2372
descriptor-struct reify**, so an INLINE object-literal descriptor
(`{ value: 42, … }`, which the TS checker types as a closed WasmGC struct) is
reified into a `$Object` before the native's internal `ref.test $Object` runs —
otherwise the native raises a spurious §10.1.6 TypeError. §28.1.3:
- step 1 (non-object target → TypeError) — enforced with the shared
  `emitNonObjectArgGuard` (now exported), which fires for a statically primitive /
  null / undefined target (the test262 non-object subtests use bare primitive
  literals). A runtime-`any` primitive still slips through — an accepted
  imprecision shared with standalone `Object.defineProperty`.
- step 2 (ToPropertyKey) — handled inside the native via `__to_property_key`
  (#2042 S1); numeric keys coerce.
- step 3 (ToPropertyDescriptor errors) — the native already throws a catchable
  TypeError for malformed descriptors.
- step 4 (boolean result) — the applier returns the obj (always truthy); we drop
  it and return i32 `true`.

**Known limitation** (shared with standalone `Object.defineProperty`): a rejected
redefine of an existing non-configurable property silently no-ops in the native
rather than surfacing failure, so the Reflect path returns `true` where spec
wants `false`. Faithful handling needs a failure channel in
`__defineProperty_value`; out of this slice.

New tests in `tests/issue-2046.test.ts` (28/28 green): data descriptor apply,
boolean-true return, numeric-key coercion, accessor descriptor, pre-built
(dynamic) descriptor, enumerable:false hidden from for-in, primitive-target and
null-target TypeError. `tests/issue-1905.test.ts` updated — `defineProperty`
removed from the "still refuses" list (now supported), all green.

Pre-existing unrelated failures (byte-identical to origin/main, untouched here):
`tests/object-define-property.test.ts` fails to load (missing `./helpers.js`
import); `tests/equivalence/reflect-api.test.ts` "Reflect.construct creates a new
instance" fails identically on clean main (host-mode construct gap).

**Still refused (out of this PR, issue stays `in-progress`):**
- **`Reflect.construct`** (152 rows, the big one) — gated on standalone construct
  machinery (coordinate with #2158).
- **PR-C (real receiver plumbing)** — senior/deferred (#1888 Slice 5).
- `getPrototypeOf` / `setPrototypeOf` / `apply` standalone arms.

## PR-C slice — getPrototypeOf + setPrototypeOf routed (2026-06-25)

REGROUND against current main HEAD (669600612) before any change confirmed all
three §26.1 prototype/apply methods still refused in standalone (`Codegen error:
Reflect.{getPrototypeOf,setPrototypeOf,apply} not supported … #1472 Phase C`).

**Change** (`src/codegen/expressions/calls.ts`, inside the `if (ctx.standalone)`
Reflect dispatch block, after the `defineProperty` arm):

- **`Reflect.getPrototypeOf(target)` → native `__getPrototypeOf`** — the SAME
  helper backing standalone `Object.getPrototypeOf` (calls.ts ~5943). Returns
  `extern.convert_any($Object.$proto)` (may be null). §26.1.8 step 1 (non-object
  target → TypeError) enforced at the CALL SITE with the shared
  `emitNonObjectArgGuard` (the same static-type / bare-literal guard the
  `defineProperty` arm uses); the shared native is untouched.
- **`Reflect.setPrototypeOf(target, proto)` → native `__object_setPrototypeOf`**
  — the SAME helper backing standalone `Object.setPrototypeOf` (calls.ts ~5829),
  which performs the §10.1.2.1 OrdinarySetPrototypeOf extensibility + cycle
  checks and writes `$Object.$proto`. §26.1.14 step 1 (non-object target →
  TypeError) and step 2 (non-null primitive proto → TypeError) enforced at the
  CALL SITE; `null`/`undefined` proto is legal (passes through to the native,
  which maps a non-`$Object` proto to a null `$proto`). The proto arg goes
  through `compileProtoArg` (the #2580 M3 Stage A inline-literal reify) just like
  `Object.setPrototypeOf`. Returns i32 `true` on success.
  - **KNOWN LIMITATION** (identical to the `Reflect.defineProperty` arm above):
    `__object_setPrototypeOf` has no boolean failure channel — a *refused* set
    (non-extensible target or a proto cycle) silently no-ops and still returns
    `obj`, so the Reflect path returns the spec's `true` instead of `false` for
    those cases. Faithful handling needs a failure channel in the native; out of
    this slice (converting the common refusal→working path is the win).

**Verified** (probe + tests, both against the test262 compile path
`skipSemanticDiagnostics: true`): setProto→getProto round-trips by identity for
dynamic (`any`-typed / `Object.create`) objects; getProto of a plain object is
null; getProto identity is stable; non-object target throws (getProto and
setProto); non-null primitive proto throws; null proto is legal.

**Verified subtlety** — the setProto→getProto round-trip is only OBSERVABLE for
dynamic `$Object`s (`any`-typed / `Object.create`). Closed-struct object literals
(`var o = {}` with no `any` annotation) do NOT round-trip — but this is the
**pre-existing #2580 M3 closed-struct-vs-`$Object` substrate gap shared with
`Object.setPrototypeOf`** (the `Object.*` control shows the identical var-typed
0), NOT introduced by this routing. The test262 Reflect prototype rows use the
dynamic shape, which works.

**`Reflect.apply` stays refused** — needs CreateListFromArrayLike + a call/spread
analog with no native helper in this slice; kept its loud refusal (pinned by a
test). Out of PR-C scope.

New tests in `tests/issue-2046.test.ts` (35/35 green): getProto/setProto
round-trip identity, setProto-returns-true, getProto-via-Object.create,
plain-object-null-proto, stable-identity, null-proto-legal, four non-object /
primitive-proto TypeError guards, and the apply-still-refused pin.
`tests/issue-1905.test.ts` updated (4/4 green) — `getPrototypeOf` removed from the
"still refuses" list.

**Still refused after PR-C (issue stays `in-progress`):**
- **`Reflect.construct`** — gated on standalone construct machinery (#2158).
- **`Reflect.apply`** — needs a call/spread native analog.
- **Real receiver plumbing** (explicit-receiver get/set) — senior/deferred,
  #1888 Slice 5.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — multi-PR. PR-A/PR-B/PR-C landed (getPrototypeOf/setPrototypeOf routed to natives, receiver arg, ToPropertyKey, deleteProperty freeze/configurable). Remaining per the file "## Remaining (out of this PR)": accessor-invocation receiver handling, coordinated with #1888 Slice 5 accessor work. Stays in-progress.

## ES2015 standalone `Reflect.set` explicit-receiver slice (2026-09-01)

### Immutable baseline and provenance

- **Compiler source:** immutable commit
  `f841cddc0f0ea665b63700d9944a4372a34a8b57`.
- **Fresh standalone census:**
  `/private/tmp/js2-baseline-census-f841cddc-r1/.test262-cache/test262-standalone-current.jsonl`,
  produced from baselines commit
  `8a39bd1d4ddf200f8db3751c878ece02aa8688fe`.
- **Artifact SHA-256:**
  `4426cbf6f305ab4a092468b201cc5854d4470b5fe87edf2fe47ba0195a6e8cbf`.

The baseline has 15 ES2015 `compile_error` rows at the same source gate. Its
exact shared diagnostic text is:

> `Codegen error: Reflect.set with an explicit receiver argument is not yet
> supported in --target standalone (#2046); the receiver would be silently
> dropped and accessor setters would write to the target instead of the
> receiver.`

The line locations below are the exact `error` field locations in that census
(multiple locations mean the test contains multiple calls at the same gate).

| Row | Status | Error location(s) / diagnostic |
| --- | --- | --- |
| `test/built-ins/Reflect/set/creates-a-data-descriptor.js` | `compile_error` | `L63:10`; shared #2046 diagnostic above |
| `test/built-ins/Reflect/set/different-property-descriptors.js` | `compile_error` | `L45:14`, `L59:10`; shared #2046 diagnostic above |
| `test/built-ins/Reflect/set/receiver-is-not-object.js` | `compile_error` | `L37:14`; shared #2046 diagnostic above |
| `test/built-ins/Reflect/set/return-false-if-target-is-not-writable.js` | `compile_error` | `L36:14`; shared #2046 diagnostic above |
| `test/built-ins/Reflect/set/set-value-on-accessor-descriptor-with-receiver.js` | `compile_error` | `L41:14`; shared #2046 diagnostic above |
| `test/built-ins/Reflect/set/set-value-on-data-descriptor.js` | `compile_error` | `L50:14`; shared #2046 diagnostic above |
| `test/built-ins/Reflect/set/symbol-property.js` | `compile_error` | `L33:14`; shared #2046 diagnostic above |
| `test/built-ins/TypedArrayConstructors/internals/Set/key-is-in-bounds-receiver-is-not-typed-array.js` | `compile_error` | `L32:8`; shared #2046 diagnostic above |
| `test/built-ins/TypedArrayConstructors/internals/Set/key-is-out-of-bounds-receiver-is-not-object.js` | `compile_error` | `L32:8`; shared #2046 diagnostic above |
| `test/built-ins/TypedArrayConstructors/internals/Set/key-is-valid-index-reflect-set.js` | `compile_error` | `L43:10`, `L50:10`, `L57:11`, `L64:11`, `L74:11`, `L81:11`; shared #2046 diagnostic above |
| `test/built-ins/TypedArrayConstructors/internals/Set/key-is-canonical-invalid-index-reflect-set.js` | `compile_error` | `L43:12`, `L50:12`, `L61:12`, `L68:12`, `L75:12`, `L86:10`; shared #2046 diagnostic above |
| `test/built-ins/TypedArrayConstructors/internals/Set/key-is-out-of-bounds-receiver-is-proto.js` | `compile_error` | `L38:8`; shared #2046 diagnostic above |
| `test/built-ins/TypedArrayConstructors/internals/Set/key-is-out-of-bounds-receiver-is-not-typed-array.js` | `compile_error` | `L32:8`; shared #2046 diagnostic above |
| `test/language/statements/with/set-mutable-binding-idref-compound-assign-with-proxy-env.js` | `compile_error` | `L69:12`; shared #2046 diagnostic above |
| `test/language/statements/with/set-mutable-binding-idref-with-proxy-env.js` | `compile_error` | `L61:12`; shared #2046 diagnostic above |

### Ownership audit and boundary

This slice owns only the first seven direct `built-ins/Reflect/set/*` rows in
the table. The six TypedArray rows belong to active **#4449**, and the two
`with`/Proxy-environment rows belong to active **#5196**. The compile source's
single gate is therefore a 15-row impact surface, not a seven-row source
switch. This slice must not silently convert any unowned row from
`compile_error` to `fail`: it either keeps those calls on the explicit refusal
path or proves a faithful implementation for their target brand. No production
ownership is claimed for TypedArray indexed-exotic `[[Set]]`, Proxy traps, host
imports, or any other Reflect method.

Existing machinery was audited before implementation: `__extern_set_decide`
already implements the native ordinary-object descriptor decision (nearest own
or prototype descriptor, accessor setter with its supplied receiver, data
writability, own-receiver creation/update/refusal), and `__extern_set_own`
owns the checked ordinary-object write. `Reflect.get` already threads an
explicit receiver through a private native wrapper without changing ordinary
read callers. The receiver-aware `Reflect.set` native must reuse the analogous
decision/write primitives rather than duplicate a partial descriptor walk.

### Concrete implementation and validation plan

1. Add a private/native `__reflect_set_receiver(target, key, value, receiver)`
   path that evaluates all four arguments exactly once, resolves the
   **target** descriptor chain, invokes an accessor setter with
   `this = receiver`, and applies a writable data descriptor to the
   **receiver** (including receiver-not-object, receiver-accessor,
   receiver-nonwritable/nonextensible, target/prototype, symbol-key, and boolean
   result cases).
2. Make the standalone `Reflect.set` call-site select that native only for the
   supported ordinary-object path. Preserve the existing loud gate for native
   TypedArray and Proxy/exotic paths until their owners land a complete model.
   Boundary-admitted host values retain their existing boundary adapter; no
   host import is introduced for native standalone modules.
3. Add a focused regression test covering all seven target semantics and
   observable argument ordering. Then run the exact seven host and standalone
   Test262 rows plus the existing #2046/#1905 controls, checking each claimed
   row is **pass** (never only CE→fail), no standalone host imports, TS5/TS7,
   lint/format, and the available budget/ratchet/numeric/issue-integrity lanes.

### Why the nine-file literal-promotion wiring is necessary

The native helper accepts the existing ordinary `$Object` carrier, while a
plain source object literal is normally allocated as a closed Wasm struct.
That choice is made before the call-expression emitter reaches `Reflect.set`.
Consequently, a call-site-only switch would either see an incompatible target
or silently produce a false result instead of the descriptor semantics this
slice claims. The narrow source proof is recorded before declaration collection
and consumed by every existing allocation/receiver path that can materialize
the same literal:

1. `reflect-set-receiver.ts` scans only direct `Reflect.set` calls and records
   source-proven ordinary literal targets (and admitted literal receivers).
2. `context/types.ts` and `context/create-context.ts` carry and initialize the
   dedicated per-compilation marker.
3. `literals.ts` emits the marked literal as `$Object` rather than a closed
   struct.
4. `declarations.ts`, `index.ts`, and `statements/variables.ts` keep module,
   top-level-hoisted, and local variable storage aligned with that carrier.
5. `statements/nested-declarations.ts` preserves it across captured closure or
   resumable slots, and `object-literal-method-receiver.ts` preserves the
   matching call-time receiver representation for literal methods.

These are nine promotion files including the scanner and its two context
plumbing files; they are the existing lockstep readers for a literal's storage
and method receiver, not a new general object-carrier path. Admission remains
limited to a direct object literal or a variable initializer that is an object
literal, resolved through the oracle's `variableInitializerOf` binding seam
only after a conservative oracle-resolved binding proof at that call. Any
syntactic write/reinitialization to that binding declines admission; this
checkpoint deliberately has no source-order relaxation, because deferred and
repeating evaluation can make a textually later write execute first. Arrays,
classes, builtins, TypedArrays, Proxies, aliases, and dynamically produced
values are not admitted.

The scanner also marks a source-proven ordinary target for the already-supported
three-argument `Reflect.set(target, key, value)` form. Several owned Test262
files execute that form before their explicit-receiver assertion. Since the
whole compilation unit selects literal representation up front, omitting that
mark would retain its old closed struct and turn the initial ordinary set into a
runtime `false`; it does not expand explicit-receiver admission or exotic
coverage.

**Explicit exclusions:** TypedArray integer-indexed-exotic `[[Set]]`; Proxy
trap/`with` environment behavior; closed-struct and carrier expansion beyond
the ordinary-object path; `Reflect.get` changes; any unrelated Reflect method;
and host-runtime imports. If the native decision helper cannot be isolated
without opening one of those paths, this slice stops at an uncommitted,
documented checkpoint rather than demoting an unowned row.

## Draft checkpoint handoff — nonmergeable (2026-09-01)

This checkpoint is deliberately **unfinished and nonmergeable**. It may be
published only as a draft handoff; do not mark it ready, merge it, or replay it
as a completed fix. The receiver helper was successfully
refactored to call the shared descriptor authority with separate lookup and
accessor-`this` receivers, and all existing decision-helper callers were
updated to pass their ordinary receiver twice. That removed the former private
target/prototype walk, reaches the implicit `Object.prototype` companion tail,
normalizes `ToPropertyKey` once after target validation, preserves all supplied
argument evaluation, and keeps accessor abrupt completion/boolean decisions in
the shared path. The review also added conservative source-boundary guards for
binding writes, destructuring defaults/redeclarations, eval, `with`, shadowed
`Reflect`, cross-source bindings, dynamic-prototype-marked targets, and
colon-form object-literal `__proto__` targets.

Those guards are not a complete ordinary-target/prototype proof. In particular,
a source-proven literal can still acquire an exotic/Proxy prototype through
alias and flow paths the scan does not model: `Object.setPrototypeOf`,
`Object.assign`-mediated `__proto__`, computed `__proto__` writes, and a prior
`Reflect.set(target, key, value, target)` (including a dynamically coerced
key). The native `$Object` descriptor walk would bypass a Proxy `[[Set]]` trap
in such a chain, converting the established loud refusal into wrong runtime
behavior. That is a structural #5196/Proxy boundary, not a test-only gap.

The required next design is either (a) a sound whole-program proof that every
admitted target and its reachable prototype chain stays ordinary, including
alias/property-flow and all prototype-mutating operations, or (b) coordinated
#5196 runtime support that preserves Proxy/exotic `[[Set]]` semantics. A
collection of local syntax exclusions is insufficient. The partial
dynamic-prototype/colon-`__proto__` guard currently present in this worktree is
therefore only diagnostic scaffolding, not a merge-ready solution.

### Last valid evidence (not a final validation of this draft)

- Focused runtime suite, before the final unvalidated prototype guard:
  `pnpm exec vitest run tests/issue-2046.test.ts --pool=forks
  --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot -t
  'Reflect.set with an explicit receiver'` — **12 passed, 34 skipped**.
- Exact standalone 15-row audit at the last valid checkpoint, recorded in
  `.tmp/issue-2046-reflect-set-gate-impact-standalone-r2.log` — **7 pass,
  8 compile_error**. All seven owned direct `built-ins/Reflect/set/*` rows
  passed; the six #4449 TypedArray rows and two #5196 `with`/Proxy rows retained
  the original #2046 compile-error diagnostic. No unowned row was observed as
  CE→fail in that audit.
- The audit predates the subsequent source-admission and prototype-safety
  review changes. No final 15-row audit, host audit, TS5/TS7, lint/format,
  oracle/LOC/function ratchets, or broader lane may be claimed for this draft.

### Checkpoint hygiene after freeze (2026-09-01)

- `pnpm run typecheck:ts7` — **passed** after two type-only repairs: explicit
  `Instr[]` context for the conditional receiver-helper instruction fragments
  and an explicit AST-parent type annotation.
- `pnpm exec prettier --check src/codegen/object-runtime.ts
  src/codegen/reflect-set-receiver.ts` — **passed**; `git diff --check` also
  **passed**.
- The first normal-hook commit attempt stopped at `check:loc-budget`: ten
  existing god-files grew, led by `src/codegen/object-runtime.ts` at +129
  lines. The exact paths are listed in the frontmatter allowance so the
  checkpoint can be preserved without bypassing hooks. These draft-only
  allowances are not evidence that the production shape is merge-ready.
- The standalone `check:func-budget` probe likewise found eleven grown
  functions, led by `ensureObjectRuntime` at +128 lines. Its exact keys are
  recorded in the matching draft-only frontmatter allowance; the checkpoint
  still needs decomposition before it can be considered merge-ready.

These checks make the frozen draft typecheck/format clean only. They do not
validate or resolve the nonmergeable Proxy/prototype semantic blocker above.
