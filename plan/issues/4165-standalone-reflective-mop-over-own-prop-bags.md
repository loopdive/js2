---
id: 4165
title: "standalone: wire the reflective MOP (hasOwnProperty / gOPD / delete / in / keys) onto the #3468 + #3537 own-property bags, and widen the two #1906 defineProperties gates"
status: done
completed: 2026-08-07
closed-by: "upstream #4010 S2/S3, #4017, #4055, #4161 — verified by re-derivation, see the 2026-08-07 section"
residue: 4210
sprint: 78
created: 2026-08-01
updated: 2026-08-18
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: fix
area: codegen, runtime, standalone
language_feature: objects, property-descriptors
goal: es5
umbrella: 3977
related: [4163, 1906, 2992, 3251, 3468, 3537, 3246, 3957]
# SPENT — these grants were consumed by this issue's own (since superseded)
# implementation. They are NOT headroom for a future change; a new PR needing
# room in these files must justify and grant it in its own issue file.
loc-budget-allow:
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/object-runtime.ts
func-budget-allow:
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
origin: "2026-08-01 es5-standalone property-descriptor cluster census (#4163 lever 1, 857 ES5 standalone failures)."
---

# #4165 — reflective MOP over the own-property side-table bags (standalone)

## The census that produced this (measured 2026-08-01, run `20260801-090441`)

857 ES5 **standalone** failures sit in the property-descriptor cluster
(`Object/defineProperty` 331, `defineProperties` 264, `create` 142,
`getOwnPropertyDescriptor` 35, `Object/prototype` 22, `Array/length` 18,
`isExtensible` 16, `preventExtensions` 15, `language/types/object` 14) — 37 % of
the whole reachable ES5 standalone gap (#4163).

**The cluster is NOT mostly standalone-specific.** Cross-lane check against the
same-day host baseline: **347 of the 857 pass on the host lane, 510 fail on both.**
On `built-ins/Object/defineProperty` the two lanes are within one test of each
other (standalone 793/1131 vs host 794/1131). So most of this cluster is a
*lane-independent* descriptor-semantics gap, and only a minority is the exotic
receiver MOP that #2992/#3251 own.

### Root-cause sub-buckets (by test SHAPE, all 857)

| Sub-bucket | Tests | Class |
| --- | --- | --- |
| **exotic DESCRIPTOR / `Properties` object** (`Object.defineProperty(o, k, funObj)` §8.10.5 step 8.a) | **270** | mixed — see split below |
| array-receiver index/`length` descriptor MOP | 152 | (a) blocked — #3251 S2/S3 |
| inherited / proto-chain descriptor fields | 105 | (b) fixable — see "HasProperty" below |
| exotic RECEIVER (String/Number/Boolean/Error/… wrapper) | 54 | (a) blocked |
| gOPD over built-in INTRINSICS (`global`, `Date.prototype`, …) | 49 | (a) blocked — intrinsics are not property tables |
| `arguments`-object receiver | 43 | (a) blocked |
| attribute-semantics residue (value/writable/enumerable/configurable) | 102 | mixed |
| other | 82 | mixed |

Split of the 270 exotic-descriptor family by *what the exotic object is*:
Date 22, Array 21, Error 20, Function 20, RegExp 18, Arguments 17, plain
`Object` 9, Boolean 6, String 6, Number 6, inherited-accessor/data 25, rest
"O is an Array/Arguments" receiver variants.

### The measurement that made the split actionable

A single probe over every receiver kind, real runner, standalone — write an
expando, then read it back four ways (`R`ead / `H`asOwnProperty / gOP`D` /
for-in `E`; lowercase = fails):

```
plainObj=RHDE  fnObj=Rhde  dateObj=rhde  errObj=rhde  regexpObj=rhde
arrObj=Rhde    boolObj=RHDE strObj=RHDE  numObj=RHDE  objObj=RHDE
```

Three distinct states, not one:

1. **`{}` / boxed wrappers** — fully correct.
2. **functions (#3468) and arrays (#3537) — the value IS stored and readable,
   but the whole REFLECTIVE half of the MOP cannot see it.** Both issues wired
   their identity-keyed side-table `$Object` "bag" into exactly three helpers
   (`__extern_get`, `__extern_set`, `__extern_method_call`) and stopped there.
   `__hasOwnProperty`, `__object_hasOwn`, `__propertyIsEnumerable`,
   `__getOwnPropertyDescriptor`, `__delete_property`, `__extern_has`,
   `__object_keys`, `__object_keys_forin` all still open with
   `ref.test $Object` → early-return "absent".
3. **Date / Error / RegExp — the write is LOST outright.** No bag, no storage.

State 2 is this issue. State 3 is the follow-up (see "Remaining / blocked").

## Why state 2 is the load-bearing one for `Object.defineProperty`

`ToPropertyDescriptor` (§6.2.5.6) probes each descriptor field with
`__hasOwnProperty(desc, "value"|"get"|"set"|"writable"|…)`. So a descriptor
object that is a **function or an array** read as the EMPTY descriptor even
though `__extern_get` could see its fields — the define silently produced a
`{value: undefined, w/e/c: false}` property. That is the entire
`15.2.3.6-3-2xx` / `15.2.3.5-4-2xx` Function/Array-descriptor family.

## What this PR does

### 1. New shared substrate module `src/codegen/own-prop-bag.ts`

Four builders over the EXISTING #3468/#3537 side tables (neither module is
edited — same composition boundary #3537 established):

- `ownPropBagLookupInstrs` — receiver → bag `$Object` externref, or null.
- `bagSubstitutionArm` — the standard non-`$Object` prologue: look the bag up,
  run the helper's original arm when there is none, otherwise **re-point the
  helper's cached `any` local at the bag and fall through into its unchanged
  `$Object` path**. One lookup, zero duplicated own-property logic.
- `closureBagEnsureInstrs` / `closureBagSubstitutionArm` — write-side twin
  (creates the bag) for the DEFINE appliers.
- `closureBagLookupSubstitutionArm` — closure-ONLY read-side variant for the key
  ENUMERATION helpers, where substituting a `$Vec` would hide its indices.

Every builder returns `undefined` when neither side table is reserved (i.e. in
gc/host mode), and every call site then emits its byte-identical original body
*and* original local vector. Bag locals are always APPENDED, so no existing
local index shifts.

### 2. Reflective helpers wired to the bag

`__hasOwnProperty`, `__object_hasOwn`, `__propertyIsEnumerable`,
`__delete_property`, `__extern_has` (object-runtime.ts);
`__getOwnPropertyDescriptor` (object-runtime-descriptors.ts, AFTER the #3251 vec
overlay arm so index keys stay with the overlay, and wrapping the primitive arm
as its bag-absent fallback so a nullish receiver still ToObject-throws);
`__object_keys`, `__object_keys_forin` (object-runtime-enumeration.ts,
closure-only).

### 3. DEFINE appliers accept a closure receiver

`__defineProperty_value` / `__defineProperty_accessor` previously hit a lenient
`$Object`-gate no-op for a function receiver — `Object.defineProperty(fn, k,
{get(){…}})` stored nothing at all. They now define into the closure's bag,
which is exactly the table `__extern_get`/gOPD read from, and get the #2042-S4
ValidateAndApplyPropertyDescriptor preflight they were skipping.

### 4. The two #1906 `__defineProperties` fail-loud gates, widened *narrowly*

The gate comment is explicit that a blanket widening trades a loud refusal for a
**silent no-op** (because `__object_keys`/`__obj_ordered` answer an EMPTY key
vector for a receiver they cannot enumerate). That property is preserved. Only
three cases are admitted, each of which routes to machinery that is already
correct, or is an exact spec no-op:

- **`Properties` carries a bag** (function/array) → enumerate the bag.
- **`Properties` is a PRIMITIVE or `undefined`** → §7.1.18 ToObject yields a
  wrapper with no own enumerable properties, so the correct answer is "define
  nothing, return `O`", not a throw. A non-empty STRING is the one exception —
  its index properties are single characters, i.e. §6.2.5.6 non-object
  descriptors — and correctly throws `Property description must be an object`.
- **`O` is a `$Vec`** → pass through: both appliers already carry the #3251
  overlay arm. **`O` is a closure** → define into its bag.
- Additionally, when `O` is *some other* object we cannot define on natively
  (a closed-struct literal shape inference never widened) **and** `Properties`
  has nothing to define, the call is a spec no-op and answering `O` is strictly
  more correct than throwing. A genuinely primitive `O` now throws the real
  §20.1.2.3.1 step-1 TypeError instead of the `#1906` message.

Everything else — Date/RegExp/Error/Arguments `Properties`, closed-struct
`Properties` — keeps the loud `#1906` throw.

## Investigated and deliberately NOT changed (a real bug, blocked on a mystery)

§6.2.5.6 ToPropertyDescriptor probes fields with **HasProperty** (proto-walking),
not HasOwnProperty — an inherited `value`/`get`/`enumerable` is legal. That is
the 105-test "inherited / proto chain" sub-bucket. Switching both `hasField`
probes to `__extern_has` **regresses the plain data-descriptor path**:

```js
var o = {}; var p = {}; p.prop = { value: 12, enumerable: true };
Object.defineProperties(o, p);
o.prop; // undefined with __extern_has, 12 with __hasOwnProperty
```

`__extern_has` answers 0 for an own key that `__hasOwnProperty` answers 1 for, on
the same `$Object` descriptor. Bisected to exactly that one-call change; root
cause not isolated. Both probes therefore stay own-only and the inherited-field
family stays red. **Do not flip the helper without re-running the repro above.**

## Remaining / blocked, and behind what

| Sub-bucket | Blocked behind |
| --- | --- |
| Date / Error / RegExp / Arguments expando storage (state 3 above — writes are lost, so `Properties`/descriptor objects of those types cannot work) | a THIRD carrier for the same side-table pattern; a natural direct follow-on to this issue |
| array-index / `length` descriptor attribute MOP, `verifyProperty` write/enumerate coherence | #3251 S2 (write enforcement) + S3 (ArraySetLength) — validated but unmerged on `issue-3251-s2-write-enforcement` |
| closed-struct-literal receivers / `Properties` never widened | #2992 S6-class shape widening |
| inherited descriptor fields | the `__extern_has` mystery above |
| gOPD over built-in intrinsics (`global`, `Date.prototype.constructor`, …) | intrinsics are not modelled as property tables at all — out of scope of every current issue |
| statically-typed receiver `arr.hasOwnProperty("expando")` / `fn.hasOwnProperty(k)` | the compile-time struct-field name-set path in `object-ops.ts` answers from the TS type, never consulting the runtime bag — separate from this runtime-side fix |

## Validation

See "Measured" below (filled in by the A/B run).


## MEASURED on the real standalone lane (2026-08-04) — net +21, and the −2 was actually −8

The authoring agent reported +28 / −2. Re-run as a clean A/B on the **standalone**
lane (an earlier attempt was void — the harness silently ran the host lane, see
the correction on PR #11), over the six descriptor directories
(`Object/{defineProperty,defineProperties,create,getOwnPropertyDescriptor,isExtensible,preventExtensions}`,
2,471 files, `runTest262File`, host-free pass rule):

| | standalone |
| --- | --- |
| BEFORE (propdesc reverted to c40c9286) | 1,625 / 2,471 |
| AFTER | **1,646 / 2,471** |
| fixed | **+29** |
| regressed | **−8** |
| **net** | **+21** |

### The 8 regressions are ONE family

```
built-ins/Object/create/name.js
built-ins/Object/defineProperties/name.js
built-ins/Object/defineProperty/name.js
built-ins/Object/defineProperty/15.2.3.6-4-594.js
built-ins/Object/getOwnPropertyDescriptor/length.js
built-ins/Object/getOwnPropertyDescriptor/name.js
built-ins/Object/isExtensible/name.js
built-ins/Object/preventExtensions/name.js
```

Seven are `name.js` / `length.js`: `verifyProperty(Object.<fn>, "name", {value,
writable:false, enumerable:false, configurable:true})` — i.e. **gOPD over a
BUILT-IN FUNCTION receiver**, asking for its own `name`/`length`. The eighth
(`15.2.3.6-4-594`) is the same shape via `Function.prototype` + `bind`.

### Lead for the fix

`buildGetOwnPropertyDescriptor` already has the **#2896 builtin-fn metadata
arm** that synthesizes exactly those descriptors and returns early; it stores
the synthesized descriptor with `local.tee index 6`. #4165 appends its bag local
at `gopdBagLocalIdx = 7 + (strExotic ? 6 : 0)` and installs `bagSubstitutionArm`
with `fallback: primitiveReceiverArm`.

So the two candidates, in order of suspicion:

1. **Local-index collision / clobber** around index 6-7 corrupting the #2896
   arm's stored descriptor before it returns.
2. **Arm ordering** — the bag arm intercepting a built-in function receiver that
   must fall through to #2896.

Either way the invariant to restore is: *a built-in function receiver asking for
its own `name`/`length` must reach the #2896 arm untouched.* Add a regression
test for `verifyProperty(Object.defineProperty, "name", …)` in standalone once
fixed — this family is currently uncovered by unit tests, which is why the
authoring agent's own count missed 6 of the 8.

**Net +21 is still a real gain** and this is the 37 % lever, so the fix is worth
having rather than reverting the slice.


### Root-cause narrowed (2026-08-04), fix NOT applied

Reproduced the single failing test on both sides in **standalone**:

- BEFORE (#4165 reverted): `built-ins/Object/defineProperty/name.js` **passes**
- AFTER: fails with `Test262Error: obj['name'] descriptor should be configurable`

`verifyProperty` proves `configurable` by **delete → re-check**, so the failure
is in the delete/hasOwn cycle, not in the descriptor read.

**gOPD is exonerated by elimination.** Before #4165 the non-`$Object` branch was
`primitiveReceiverArm`, which returns `undefined`; had gOPD gone down that path
the test would have failed as "descriptor should exist", not "should be
configurable". It passed, so the #2896 builtin-fn arm handles this receiver and
returns early — and #4165 does not touch that arm.

**Therefore the regression is in `__delete` / `__hasOwnProperty`.** All three
helpers run their #2896 arm first, but that arm returns null for *two different
reasons*: "receiver is not a builtin function" and "property was deleted". After
a successful `delete fn.name`, `bfnGetMeta` returns null for the second reason,
execution falls into the #4165 bag arm, and if a bag exists for that function
receiver the bag answers instead of reporting absent — so `hasOwnProperty`
still reports `true` and `verifyProperty` concludes non-configurable.

**Why I did not land a fix:** the correct gate needs an *is-builtin-function*
predicate distinct from *metadata-absent*. `bfnGetMetaIdx` conflates the two, so
there is no way to express "builtin-fn receiver, property genuinely deleted →
return absent, do NOT consult the bag" without adding that predicate. Guessing
at it inside a shared MOP substrate risks trading 8 visible regressions for a
silent wrong answer elsewhere.

**Suggested shape for whoever picks this up:** add a cheap
`__bfn_is_builtin(obj) -> i32` (or have `bfnGetMeta` return a tri-state), then in
`__delete` / `__hasOwnProperty` / gOPD short-circuit to "absent" when the
receiver is a builtin function and the metadata arm declined — never falling
through to `bagSubstitutionArm` for that receiver class. Cover it with a
standalone test over `verifyProperty(Object.defineProperty, "name", …)`; the
family has no unit coverage today, which is why the original count reported −2
instead of −8.

### Unrelated crash found while probing

A hand-written probe combining `Object.getOwnPropertyDescriptor` on a builtin
function with `delete fn.name` fails to compile in standalone with an internal
`TypeError: Cannot read properties of undefined (reading 'kind')`. Not minimised
and not filed — flagging it here so it is not lost; it reproduces from
`.tmp/probe/p.js` in the session that recorded this.


### FIXED (2026-08-04, follow-up commit): 7 of the 8 — root cause was the WRITE path, not the readers

The delete/hasOwn framing above was close but not final. The actual defect sat
one step earlier, in **`__closure_prop_set`** (`src/codegen/closure-props.ts`):
it stored into the #3468 side-table bag **unconditionally**. `verifyProperty`
probes `writable:false` by WRITING to the property; that probe write created a
stale bag shadow for `name`. It stayed masked while the #2896 metadata was live
(reads answer from metadata first) and surfaced when `delete fn.name` cleared
the metadata — hasOwnProperty/gOPD then answered from the bag, so the harness's
own probe write broke its later configurable check.

**Fix:** gate the bag store on `__builtinfn_get_meta(obj, key)` — non-null means
the key is a LIVE builtin `name`/`length` own property, which is
`writable:false` per §17, so the write is a sloppy no-op. Post-delete the
metadata is gone, get_meta returns null, and assignment correctly creates an
ordinary own property in the bag. Ordinary expandos are unaffected (get_meta is
null for every other key/receiver).

Re-run of the 8 regressed tests: **7 pass**, `15.2.3.6-4-594` still fails.
Unit coverage added: `tests/issue-4165-bfn-name-writable-gate.test.ts` (4
tests: the regressed cycle, gOPD §17 attributes, post-delete assignment,
user-function expandos). Neighbouring suites green (issue-4166, issue-4164,
this-receiver-apply, issue-3201-expando-method — 44 tests).

### The remaining regression: 15.2.3.6-4-594 — needs proto-chain [[Set]], do not hack

`obj = foo.bind({}); obj.prop = "overrideData"` with an accessor defined on
`Function.prototype` must invoke the inherited SETTER and create no own
property. Pre-#4165 this passed by **two wrongs cancelling**: the write landed
in the bag (hasOwn couldn't see bags, so `hasOwnProperty("prop")` was false
vacuously) and the read found the bag value. #4165 made hasOwn honest, which
exposed that the write path never consulted prototype-chain accessors.

The correct fix is OrdinarySet fidelity for closure receivers — walk to the
%Function.prototype% brand object and dispatch inherited accessors before
falling back to an own bag store. That is #2992/#3251 MOP substrate territory.
A shortcut (e.g. hiding bags from hasOwn for bound functions) would re-break
real expandos, so this one regression is accepted as known until the substrate
lands. Net effect of #4165 with the gate: **+29 / −1** on the six descriptor
directories.


### Aggregate confirmed (2026-08-05)

Full re-measure of the six descriptor directories with the writable-gate fix,
same harness, same corpus: **1,625 -> 1,653 / 2,471 (+29 fixed, -1 regressed,
net +28)**. The sole regression is `15.2.3.6-4-594` (the documented
OrdinarySet proto-setter case). Matches the per-test verification exactly.


## SUPERSEDED upstream (2026-08-05 merge) — surviving pieces only

While this branch was in flight, upstream independently landed a fuller
implementation of this issue's territory: #4010 S2/S3 (carrier-bag delete +
visibility), #4017, #4055 (descriptor-scoped HasProperty), and #4161 — whose
`carrier-bag-define.ts` header explicitly reviews this PR's wiring and extracts
its surviving piece (the defineProperties/create substitution arms). The
`__closure_prop_set` writable-gate is superseded by their
`buildBuiltinFnSetRefusalArm`.

Resolution taken in the merge: upstream's modules win wholesale;
`own-prop-bag.ts` deleted. **The behavior tests from this issue were kept and
pass against upstream's implementation (4/4)** — including the regressed
verifyProperty write→delete→hasOwn cycle — so the supersession is verified
equivalent-or-better, not assumed. The measured history above (+29/−1 on this
branch's own implementation) remains valid for what it measured.


## CLOSED 2026-08-07 (W29) — re-derived on current main; the mechanism no longer reproduces

Dispatched to implement this issue, the lane re-ran **this issue's own RHDE
census probe** on `origin/main@78683628d2` before writing any code. Real
standalone lane (`runTest262File(…, target:"standalone")`), runtime-eval provider
at the **INTERPRETER** tier (`TEST262_FULL_RUNTIME_EVAL=1`, key
`854c120ce015d507`) so the results are CI-comparable rather than the
link-error/refusal substitute.

Uppercase = correct (`R`ead · `H`asOwnProperty · gOP`D` · for-in `E` · `I`n ·
`K`eys · deleted-then-absent `X`; the last three are new columns this probe
added):

| receiver | filed 2026-08-01 | measured 2026-08-07 |
| --- | --- | --- |
| `plainObj` | `RHDE` | `RHDEIKX` |
| `fnObj` | `Rhde` | **`RHDEIKX`** |
| `arrObj` | `Rhde` | **`RHDEIKX`** |
| `dateObj` | `rhde` | **`RHDEIKX`** |
| `regexpObj` | `rhde` | **`RHDEIKX`** |
| `boolObj` / `strObj` / `numObj` / `objObj` | `RHDE` | `RHDEIKX` |
| **`errObj`** | `rhde` | **`rhdeik`** ← only survivor |

**"State 2" — the entire premise of this issue — is gone.** The function (#3468)
and array (#3537) bags are fully visible to the reflective half of the MOP:
`hasOwnProperty`, gOPD, for-in, `in`, `Object.keys` and `delete` all answer
correctly. **"State 3" is 3/4 closed too** — Date and RegExp now store and
reflect expandos.

This matches the "SUPERSEDED upstream" section immediately above: #4010 S2/S3
(carrier-bag delete + visibility), #4017, #4055 (descriptor-scoped HasProperty)
and #4161 landed this territory, `src/codegen/carrier-bag-{define,delete,hasown,visibility}.ts`
are on main, and `__hasOwnProperty` consults `__carrier_bag_has` at
`object-runtime.ts:3155` and `:7575`. This issue's own behaviour test,
`tests/issue-4165-bfn-name-writable-gate.test.ts`, is already on main.

The status was left at `in-progress`, which is the only reason the work was
re-dispatched — a stale status costs the next lane the entire re-derivation.

### The 857 headline is stale — do not carry it forward

The `origin:` figure (857 ES5 standalone failures, #4163 lever 1) predates all
of the above and describes a mechanism that no longer exists. It sits alongside
four other 2026-08-01/08-06 census entries that were overturned when their lanes
measured (#4205 filed 133 → actual 7; #4206 118 → the headline bucket was not a
`with` defect; #4207 70 → 19, with the filed mechanism wrong; #2668's headline
3× stale). Re-derive before quoting any of them.

### Residue: #4210

Error receivers lose **all** own-property writes — `err.x = 7` and
`Object.defineProperty(err, k, {value})` alike — silently, with no throw and no
refusal. `__carrier_bag_of` has exactly two arms (closure, vec) and no Error
arm. Sized by AST reachability over all 53,575 corpus files: **58** have an
Error instance receiving an own property (upper bound, not a predicted yield).
Filed as **#4210** with the full probe output and fix direction.

### Also still open, unchanged from the table above

`15.2.3.6-4-594` (OrdinarySet proto-setter fidelity for closure receivers),
array-index/`length` descriptor attribute MOP (#3251 S2/S3), closed-struct
receivers (#2992 S6), gOPD over built-in intrinsics.
