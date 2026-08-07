---
id: 4210
title: "standalone: Error receivers lose ALL own-property writes — the last receiver kind whose bag was never wired"
status: in-progress
assignee: ttraenkler/W31
sprint: current
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime, standalone
language_feature: objects, property-descriptors, errors
goal: standalone-gap
umbrella: 3977
related: [4165, 3468, 3537, 4010, 4161, 4055, 2992]
created: 2026-08-07
found-by: ttraenkler/W29
origin: "2026-08-07 re-derivation of #4165 on current main — the only surviving receiver kind of #4165's 'state 3'."
loc-budget-allow:
  # (#4210) One composition arm per god-file, +41 lines total. Each has to live
  # where the helper body is BUILT — the arm bakes a `call <funcIdx>` into
  # `__extern_set` / `__integrity_bag` / the define appliers, so it cannot be
  # moved out. All the prose and every reusable builder went to the non-god
  # modules `src/codegen/error-props.ts` (new) and `carrier-bag-define.ts`;
  # two pre-existing call sites were also collapsed into shared
  # `carrierBagSubstitutionArm` / `carrierPropertiesBagArm` helpers, which is
  # why the descriptors delta is +14 and not +54.
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/object-runtime.ts
  - src/codegen/index.ts
  - src/codegen/context/types.ts
func-budget-allow:
  # (#4210) The same +41, seen per-function: each composition arm lives inside
  # the one already-large builder that emits the helper whose body it joins.
  # Splitting those builders is #3399's job and is orthogonal to this fix.
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
---

# #4210 — Error receivers lose all own-property writes (standalone)

## The defect

In `--target standalone`, an own-property write to an **Error instance** is
**silently discarded**. Both spellings:

```js
err.x = 7;                                              // lost
Object.defineProperty(err, "y", { value: 9, … });       // lost
```

There is **no throw, no refusal, and no diagnostic**. The value simply does not
read back, and `hasOwnProperty` answers `false`. A silent wrong answer is worth
its own issue independent of the file count — every other receiver kind either
works or fails loudly.

## Measured (2026-08-07, `origin/main@78683628d2`)

Real standalone lane — `runTest262File(…, target: "standalone")`, provider at the
**INTERPRETER** tier (`TEST262_FULL_RUNTIME_EVAL=1`, key `854c120ce015d507`), so
the results are CI-comparable and not the refusal/link-error substitute.

Write an expando, then read it back; uppercase = correct
(`R`ead · `H`asOwnProperty · gOP`D` · for-in `E` · `I`n · `K`eys · deleted-then-absent `X`):

```
plainObj=RHDEIKX  fnObj=RHDEIKX   arrObj=RHDEIKX  dateObj=RHDEIKX
regexpObj=RHDEIKX boolObj=RHDEIKX strObj=RHDEIKX  numObj=RHDEIKX  objObj=RHDEIKX
errObj=rhdeik  ← every read channel wrong
```

Second probe, separating plain assignment from `defineProperty`
(`R`/`H`/`D` as above, then `V` = defineProperty value reads back, `H` = it is own):

| receiver | result |
| --- | --- |
| `new Error("e")` | `rhd\|vh` |
| `new TypeError("e")` | `rhd\|vh` |
| `new Error()` (no message) | `rhd\|vh` |
| `Error("e")` (called, not constructed) | `rhd\|vh` |
| `{}` (control) | `RHD\|VH` |

All four Error spellings behave identically, so this is the Error **carrier**,
not a message/subclass/construct-vs-call artifact.

### This is the last survivor of #4165's "state 3"

#4165 (2026-08-01) recorded Date, Error and RegExp as losing writes outright,
and functions/arrays as storing-but-invisible-to-reflection. Re-measured today:
functions, arrays, **Date and RegExp are all fully correct** — closed by #4010
S2/S3, #4017, #4055 and #4161. Error is the only one left.

## Root cause — CORRECTED 2026-08-07 (W31, before implementing)

**The paragraph this section used to hold was wrong in the way that matters,
and the fix direction it implied was a known-rejected variant.** It is
preserved verbatim at the bottom of this file under *Superseded root cause*, so
the correction is auditable rather than a silent rewrite.

What it said: an Error is neither a closure carrier nor a vec carrier, so
`__carrier_bag_of` answers null; "unlike the function/array case, the write
side has nowhere to land either — hence loss rather than invisibility."

What source actually says:

1. **An `$Error_struct` ALREADY HAS a bag.** `$props`, fieldIdx 5 (#2101a R5,
   `src/codegen/registry/types.ts`), is a mutable `externref` holding a plain
   `$Object`, lazily allocated by `__new_plain_object`. The write side does
   have somewhere to land; nothing was pointing at it.
2. **The READ side has consulted it since #3130.** `fillExternGetErrorProps`
   (`src/codegen/registry/error-types.ts`) splices a `$props`-FIRST arm into
   `__extern_get`, ahead of message/name/stack/constructor.
3. **The hole is the WRITE side and the reflective side.** `__extern_set`'s
   non-`$Object` arm is `buildVecOrClosurePropSetMissArm` — vec + closure only
   — so the write falls off the end and the helper returns void; and
   `__carrier_bag_of` has no Error arm, so hasOwnProperty / gOPD / delete /
   push_keys all report "absent".

So this is **not** the "no carrier bag" state the title suggested. It is
"a bag nobody writes to and nobody reflects over".

### ⚠ The obvious fix is a KNOWN-REJECTED variant — do not re-attempt it blind

This issue asked "find out how Date and RegExp were fixed first". Answer:
**not with a new arm.** They were added to the named list in
`builtinInstanceCarrierTypeIdxs()` (`src/codegen/closure-props.ts` ~L313,
`["__StandaloneRegExp", "__Date"]`), which folds them into
`__is_closure_prop_carrier`'s `ref.test` chain so they ride the #3468 closure
bag.

Adding `$Error_struct` to that list is the first thing anyone tries. It is
**explicitly excluded, with a reason, at `closure-props.ts` ~L305**:

> Deliberately a NAMED, CLOSED list rather than "every non-`$Object` struct".
> Two exclusions are load-bearing: … `$Error_struct` has its own `$props`
> side-slot (fieldIdx 5, #2101a R5) that the externref-backed-subclass
> own-field path writes directly, so bagging it would give one receiver two
> disagreeing stores.

That objection is real: `expressions/assignment.ts` (~L3117) already writes
`class A extends Error { code = 0 }` own fields straight into `$props`. A
closure-bag arm would create a second store for the same receiver.

**It does not apply to the fix that landed**, because that fix points at field
5 — the same slot — so there is exactly one store. `tests/issue-4210-*.test.ts`
asserts the two paths agree rather than arguing it.

## Fix as implemented (W31, PR on `issue-4210-error-carrier-bag`)

`src/codegen/error-props.ts` (new, non-god module) reserves three helpers over
the EXISTING field — no side table, no new state:

| helper | body |
| --- | --- |
| `__is_error_prop_carrier(v) -> i32` | `ref.test $Error_struct` |
| `__error_bag_lookup(v) -> externref` | `struct.get $Error_struct 5` (LOOKUP, never ensure — a query must not allocate) |
| `__error_bag_ensure(v) -> externref` | as lookup, allocating `__new_plain_object()` on first write |

Five one-arm compositions consume them:

| site | file | effect |
| --- | --- | --- |
| `__extern_set` | `object-runtime.ts` | substitute `$props` for the receiver, fall through into the unchanged `$Object` path |
| `__carrier_bag_of` | `carrier-bag-visibility.ts` | hasOwnProperty / `in` / gOPD / `Object.keys` / for-in / gOPN |
| `__carrier_bag_delete` | `carrier-bag-delete.ts` | `delete err.p` |
| `__integrity_bag` | `object-integrity-carrier.ts` | isExtensible / preventExtensions / seal / freeze |
| the define appliers + the `Properties`-map gate | `carrier-bag-define.ts` → `object-runtime-descriptors.ts` | `Object.defineProperty(err, …)`, `defineProperties(err, …)`, and an Error used AS the descriptor map |

**SUBSTITUTION, not re-implementation** (the #4161 mechanism): the arms
re-point the helper's cached `any` local at the bag and fall through, so the
accessor gate, the non-writable gate, the FROZEN gate, `__obj_insert`'s
NON_EXTENSIBLE new-key refusal and the #2042-S4
ValidateAndApplyPropertyDescriptor preflight all apply to an Error unchanged.
An own accessor is still invoked with the original Error as `this`.

### The integrity arm is load-bearing, not a bonus

`built-ins/Object/preventExtensions/15.2.3.10-3-20.js` and `-3-10.js` pass
today **because the write is dropped** — `verifyNotWritable(obj, "exName")`
followed by `assert(!obj.hasOwnProperty("exName"))`. A working write side alone
would convert both into failures. Routing `[[Extensible]]` onto the SAME bag
`__extern_set` writes through makes them pass for the right reason. It also
corrects a pristine-direction reading they depended on: measured on
`origin/main@5534c3e8e8`, `Object.isExtensible(err)` answered **false** for an
any-typed Error; with a bag it answers true (fresh flags == 0).

## Sizing (measured, and what it does NOT claim)

AST reachability scan over the **whole corpus** — 53,575 files, each file's body
plus its `includes:` harness files — for the trigger shape *an identifier bound
to a freshly-constructed Error that later receives an own property* (member
assignment or `Object.defineProperty`/`defineProperties` with that identifier as
`O`):

**58 files.** Distribution:

| directory | files |
| --- | ---: |
| `staging/sm/Math` | 15 |
| `built-ins/Object/defineProperties` | 9 |
| `built-ins/Object/create` | 8 |
| `built-ins/Object/defineProperty` | 7 |
| `built-ins/Error/prototype/toString` | 4 |
| 14 other directories | 1 each |

Scan script: `.tmp/probe/scan-err.mts` in the #4187 worktree (reproducible).

**What this number is:** an upper bound on the files this mechanism can reach
directly. **What it is NOT:** a predicted fix yield. It is not filtered by
current pass/fail status, and some of those files fail for unrelated reasons
upstream of the Error write. Do not quote 58 as "+58".

**Explicitly unmeasured:** the indirect population — an Error used as the
*descriptor* argument (`Object.defineProperty(o, k, errObj)`, where
ToPropertyDescriptor probes fields the carrier cannot see) is only partially
captured by the scan above, and #4165's 2026-08-01 census put "Error" at 20 in
its 270-file exotic-descriptor family. Those two counts overlap by an unknown
amount. Re-derive before sizing a fix.

**Do NOT reuse #4165's 857.** That figure is from the 2026-08-01 census and is
comprehensively stale: the mechanism it described no longer reproduces for any
receiver kind except this one.

## Measured (W31, 2026-08-07) — base `origin/main@8f119536ae`, head `issue-4210-error-carrier-bag`

Real standalone lane, provider rebuilt per arm at the **INTERPRETER** tier
(`TEST262_FULL_RUNTIME_EVAL=1`). The provider `.wasm` was deleted before each
build because the cache key is worthless — both arms report key
`854c120ce015d507` while emitting **4,141,686** (base) and **4,142,021** (head)
bytes. The base arm is a SEPARATE worktree at `origin/main`, so no tree was
ever left holding the base of an A/B.

### Channel probe

| receiver | base | head |
| --- | --- | --- |
| `new Error("x")`, RHDEIKX | `rhdeikX` (the X vacuous — nothing to delete) | `RHDEIKX` |
| `new Error` / `new TypeError` / `new Error()` / `Error()`, `RHD\|VH` | `rhd\|vh` ×4 | `RHD\|VH` ×4, identical to `{}` |
| subclass own-field writer + plain expando on one instance | `code=1 other=2 hasCode=0 hasOther=0` | values and reflection agree |
| integrity (`Eewh`) | `plain/fn/date/regexp = Eewh`, **`err = eewh`** | `err = Eewh` — same answers as every other carrier |
| static/dynamic/computed write | `staticLit=0 dynParam=0 staticComputed=0` | `1 1 1` |

That last base row answers the question this issue could not: `err.p = 7` on a
statically-Error-typed receiver **does** reach `__extern_set`. The arm is not
dead code.

### LEVER — 71 files, re-derived

**Not the 58 this issue filed, and the reason matters more than the number.**
The original scan took each file's body plus its `includes:` harness files. The
runner (`assembleOriginalHarness`) **always** prepends `assert.js` and `sta.js`
regardless of `includes:`, so any population derived that way is
systematically under-counted. Scanning the true effective source gives 71
(`W` write 47 · `M` message/name/stack write 11 · `R` reflection 33, union 71).

| | base | head |
| --- | ---: | ---: |
| pass | 6 | **27** |

**fail→pass 21 · pass→fail 0 · status-changed 0 · signature-changed 1.**

- **Byte-hash exposure: 71/71 modules changed, 0 byte-identical.**
  Byte-identity is **not available** as a safety argument for this change:
  `__extern_set`'s body moves for every standalone module with an object
  runtime. Safety comes from execution over the full control below, not from
  hashes.
- **Instrument validation:** the base arm reproduces the published standalone
  baseline **56/71**. All 15 disagreements are ONE cause and are identical in
  both arms — the baseline records them as
  `compile_error: standalone target emitted host imports: env::__new_SuppressedError (#2961)`,
  a leak since fixed on `main`, so the baseline is simply older than the base.
  **0 unexplained.**
- The one signature change is fail→fail:
  `built-ins/Object/defineProperties/15.2.3.7-2-15.js` moves from the loud
  `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]` refusal to a real `Test262Error`. Cause,
  named rather than hidden: the `Properties`-map arm SUBSTITUTES the bag, so a
  getter on the map is invoked with the bag as `this` and `this instanceof
  Error` is false. **Pre-existing in kind** — `closurePropertiesBagArm` (#4161)
  has the identical `this` binding for a function used as a Properties map. See
  the residue below.

### Refusal-vacuous-pass at-risk set (the #4209 question, for Error)

**The #4207 mechanism does not apply to this change.** That mechanism is "a
not-yet-implemented refusal throws the `TypeError` the test wanted, so
implementing the feature converts a pass into a failure". Dropped Error writes
were **silent** — never a refusal, never a throw — so this change removes no
throw and can convert no `assert.throws(TypeError, …)` pass.

The analogous risk here is "passes **because** the write was dropped". That set
is exactly the 6 baseline-`pass` files inside the 71-file lever:

| file | at risk? |
| --- | --- |
| `Object/preventExtensions/15.2.3.10-3-20.js` | **YES** — `verifyNotWritable` + `assert(!hasOwnProperty)` on an Error |
| `Object/preventExtensions/15.2.3.10-3-10.js` | **YES** — same shape |
| `Object/defineProperty/15.2.3.6-4-583.js` | no — reflection only |
| `Object/defineProperty/15.2.3.6-4-407.js` | no — reflection only |
| `Array/prototype/reduce/15.4.4.21-1-14.js` | no — write, never re-read |
| `Object/defineProperties/15.2.3.7-5-b-160.js` | no — write, never re-read |

Both YES entries are handled by the `__integrity_bag` arm, and both still pass
— now for the right reason. Nothing here needs routing to #4209.

## Residue — what this issue does NOT fix

1. **`err.message` / `err.name` / `err.stack` READS do not honour the write →
   split out as #4213.** After this change `e.message = "x"` stores and
   `e.hasOwnProperty("message")` is `true`, but `e.message` still answers the
   struct field. **This is a known, deliberate, temporary inconsistency.**
   Cause: `tryNativeErrorMemberRead`
   (`property-access-dispatch.ts`) and `__error_to_string`
   (`native-strings.ts`) are fast paths that predate #3130's `$props`-first
   rule and never learned it; only `__extern_get` knows it. Bound: `message` /
   `name` / `stack` reads only, 11 reachable files, **none of them currently
   passing**, so 0 regression risk and ≤4 files of upside. Full analysis and
   fix direction in `plan/issues/4213-…md`.
2. **A getter on an Error used as a `Properties` MAP runs with the bag as
   `this`** (the signature change above). Second instance of the same defect —
   `closurePropertiesBagArm` (#4161) does it too — which makes it a property of
   the SUBSTITUTION pattern, not of either site. Worth its own issue if a third
   carrier ever joins. **Explicit trigger, so this is a rule and not a
   one-off: if a THIRD carrier adopts the same substitution, it stops being a
   coincidence of two sites and gets its own issue.** Until then it is
   documented at both sites rather than tracked.
3. **Update-after-`preventExtensions` is refused for EVERY receiver kind →
   filed as #4214.** §10.1.9 says an existing *writable* own property stays
   writable on a non-extensible object; standalone refuses the write (sloppy
   no-op, strict `TypeError`) for plain objects, functions and Errors alike.
   The uniformity is what proves it is not this issue's — Error only reached
   the same code path the others were already on. Found because #4210's
   fixture asserts PARITY with a plain-object oracle rather than an absolute,
   which forced the plain answer to be computed instead of assumed.
4. **`delete err.message` still resurrects the field value.** The bag entry is
   removed, the read falls back to field 1. Unchanged by this issue (there was
   never a bag entry to delete) and out of #4213's scope too — it needs a
   tombstone on the field surface.
5. **`new Error("x")` reports `hasOwnProperty("message") === false` until some
   write creates the bag.** Per spec `message` IS an own non-enumerable
   property of such an instance. Pre-existing; unchanged. Seeding the bag with
   the spec attributes at construction was **considered and rejected**: it
   allocates an `$Object` per Error on the throw path, and the measured
   population that would benefit is 0 currently-passing files.

## Acceptance

- `err.x = 7` then `err.x` reads `7`; `err.hasOwnProperty("x")` is `true`;
  gOPD reports the property; for-in and `Object.keys` include it; `delete`
  removes it — i.e. the RHDE probe reports `errObj=RHDEIKX`.
- `Object.defineProperty(err, k, {value})` likewise.
- All four Error spellings above (`new Error`, `new TypeError`, `new Error()`,
  `Error()`) behave identically.
- No regression on the other nine receiver kinds, byte-hashed.

---

## Superseded root cause + fix direction (verbatim, 2026-08-07 filing)

Kept so the correction above is auditable. **Do not implement from this
section** — its "third carrier arm … identity-keyed side-table" is more
machinery than the problem needs, and its "an Error is neither a closure
carrier nor a vec carrier … the write side has nowhere to land either" is
factually wrong: `$Error_struct.$props` (fieldIdx 5) is exactly somewhere for
it to land, and the read path already used it.

> `__carrier_bag_of` (`src/codegen/carrier-bag-visibility.ts`, ~L314) is built
> from exactly **two** arms:
>
> ```
> closureArm = arm(IS_CLOSURE_PROP_CARRIER, CLOSURE_BAG_LOOKUP)   // #3468
> vecArm     = arm(IS_VEC_PROP_CARRIER,     VEC_BAG_LOOKUP)       // #3537
> … then ref.null.extern
> ```
>
> An Error instance is neither a closure carrier nor a vec carrier, so
> `__carrier_bag_of` answers null and every consumer
> (`__carrier_bag_has` / `__carrier_bag_gopd` / `__carrier_bag_delete` /
> `__carrier_bag_push_keys`) reports "absent". Unlike the function/array case,
> the write side has nowhere to land either — hence loss rather than
> invisibility.

>
> Add a **third carrier arm** for Error instances, mirroring the shape #3537
> established for `$Vec` — an identity-keyed side-table plus an
> `IS_ERROR_PROP_CARRIER` predicate and an `ERROR_BAG_LOOKUP`, registered into
> `__carrier_bag_of` so all four reflective consumers inherit it for free. That is
> the composition boundary both #3468 and #3537 used and the reason Date/RegExp
> came along cheaply.
>
> Two things to check before assuming symmetry:
>
> - **Find out how Date and RegExp were fixed first.** They were in the same
>   "state 3" bucket as Error in #4165 and are now correct, but they do **not**
>   appear as arms in `__carrier_bag_of`. Whatever path closed them may close
>   Error more cheaply than a third bag — and if so, the asymmetry is itself the
>   question to answer.
> - The **write** side is the part that is actually missing (functions/arrays
>   stored the value and only reflection was blind). A read-side-only carrier arm
>   would not fix this.
