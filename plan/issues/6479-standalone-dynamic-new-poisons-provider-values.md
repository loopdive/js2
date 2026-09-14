---
id: 6479
title: "standalone: a provider CLASS OBJECT passes a bare `ref.test $__ta_ctor`, so the `%TypedArray%.of/from` and dynamic-`new` arms build a typed array out of it — ONE `new <runtime value>()` anywhere in a linked consumer, even in a function that is never called, then makes EVERY provider value unreadable; `test262/harness/temporalHelpers.js` contains that spelling, which is why it accounts for 71 of the 169 failing rows in the #5383 three-family sample"
status: done
completed: 2026-09-13
assignee: ttraenkler/dev-5383-s14
sprint: current
priority: high
horizon: l
parent: 5383
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-13
---

# The defect, in two lines of consumer

`--target standalone`, the real `@js-temporal/polyfill` provider linked as a
wasm package, one consumer module:

```js
function mk(K) { return new K(); }          // NEVER CALLED
typeof Temporal.PlainDate.from("2020-12-24").calendarId   // "undefined"
```

Delete the first line and the same read answers `"string"`. The function is
never called; its mere PRESENCE in the module is the whole input.

With it present, the provider's entire value surface collapses:

| probe, real linked provider | without `mk` | with `mk` |
| --- | --- | --- |
| `PlainDate.from("2020-12-24").day` | `24` | **`undefined`** |
| `PlainDate.from(…).calendarId` | `"iso8601"` | **`undefined`** |
| `PlainDate.from(…).toJSON()` | `"2020-12-24"` | **`null`** |
| `String(PlainDate.from(…))` | `"[native code]"` | **`""`** |
| `new Temporal.PlainDate(1976,11,18).day` | `18` | **`undefined`** |
| `new Temporal.PlainDate(1976,11,18).length` | `0` | **`1976`** (arg 0!) |
| `Temporal.PlainDate.prototype` typeof | `"object"` | **`"undefined"`** |
| `Duration.from({years:1}).years` | `1` | **`undefined`** |
| `PlainTime.from("12:30").hour` | `12` | **`undefined`** |
| `ZonedDateTime.from(…).timeZoneId` | `"UTC"` | **`undefined`** |
| `ZonedDateTime.from(…).equals` typeof | `"function"` | **`undefined`** |
| `Instant.from(…).epochNanoseconds` | a value | **`undefined`** |
| `Object.getOwnPropertyNames(PlainDate.from(…))` | `[]` | **`["length"]`** |
| `Object.prototype.toString.call(PlainDate.from(…))` | `[object Function]` | **`[object Array]`** |

`Object.getOwnPropertyNames(new Temporal.PlainDate(1976,11,18))` answers
`"0,1,2,…,127"` with the `mk` line present. The result is not null and not a
provider object — it is a consumer-side typed-array carrier read out of a struct
the consumer had no right to decode.

# Root cause

`$__ta_ctor` is **two immutable i32 fields** (`kind`, `brand`). That is exactly
the shape #2158/#2009 gives a **field-less class ROOT**
(`$__tag` + `$__shape_brand`). WasmGC canonicalizes structurally-identical
struct types, so a bare `ref.test $__ta_ctor` cannot tell a TypedArray
constructor from a provider CLASS OBJECT.

Two arms asked that question with a bare `ref.test`:

- `tryEmitTaStaticOfFrom` (`src/codegen/expressions/call-receiver-method.ts`) —
  `%TypedArray%.of` / `%TypedArray%.from` on an `any` receiver. It claimed
  `Temporal.PlainDate.from("2020-12-24")` and built a typed array from the
  argument list, which is why the result's only own key was `length`.
- the `$__ta_ctor` arm of `tryCompileNativeConstructFromValue`
  (`src/codegen/expressions/new-super.ts`) — the `[[Construct]]` twin, which is
  why `new Temporal.Duration(1).years` broke alongside it.

Both are gated `noJsHost(ctx)`, so the JS-host (`gc`) lane never reached either.

**The discriminator already existed.** `taCtorIdentityTestInstrs`
(`src/codegen/registry/types.ts`, #5383 S2f R11) is `ref.test` **plus** the
`brand` FIELD-VALUE check, and its own comment records this collision measured
on this very provider ("dumping the matched struct's two fields gave `{35, 0}`
and `{33, 0}` — the class TAG and the `__shape_brand`"). Three call sites use
it; these two did not.

# Why one `new <value>()` is the trigger

The spelling is what arms `ctx.moduleUsesDynTaView` / the dyn-view machinery in
the module pre-scan, which is what makes the consumer register `$__ta_ctor` and
the surrounding typed-array runtime at all. Without it the module has no
`$__ta_ctor` type, the arms are not emitted, and the provider's values are read
correctly.

`test262/harness/temporalHelpers.js` contains the spelling, at member 23 of its
one big object literal (`checkSubclassConstructorNotObject`):

```js
const instance = new construct(...constructArgs);
```

`construct` is a parameter, so this is `new <runtime value>()`. **Every Temporal
test with `includes: [temporalHelpers.js]` inherited the failure, whether or not
it called that helper.**

# What was fixed

Both arms now call `taCtorIdentityTestInstrs`. It is answer-preserving for a
genuine `$__ta_ctor` (both mint sites write `TA_CTOR_BRAND`), so the change can
only ever REMOVE a false positive — the
`testWithTypedArrayConstructors(function (TA) { TA.of(…) })` shape the arms
exist for is untouched.

Twelve other bare `ref.test $__ta_ctor` sites remain
(`dataview-native.ts` ×5, `ta-ctor-meta.ts` ×2, `expressions/calls.ts`,
`property-access-dispatch.ts`). They carry the same hazard by construction; none
of them was on a path this slice could measure moving, so they are written down
here rather than changed blind.

# Attribution table

| bucket, LINKED, S13 | rows | root cause | terminal |
| --- | --- | --- | --- |
| PlainDate `calendar must be string in canonicalizeCalendarEra` | 20 | this issue | `tryEmitTaStaticOfFrom` bare `ref.test $__ta_ctor` |
| Duration `years result: Expected SameValue(«undefined», «N»)` (+ `explicit:`) | 10 | this issue | same, + the `new-super.ts` twin |
| ZDT `required property 'timeZone' missing` | 7 | this issue | same |
| ZDT `Cannot read properties of undefined (reading 'equals')` | 5 | this issue | same |
| PlainDate `year is required` | 2 | this issue | same |
| the rest of the 71 harness-including failures | ~27 | this issue | same |
| `dereferencing a null pointer in sn()` (Duration 5, ZDT 4) | 9 | NOT this issue — reproduces with NO harness (`Duration.from("P1Y")` TRAPs on the bare provider) | separate |
| compilation timeout | 12 | sample-budget artifact (13–19 s against a 15 s budget), see S13 | none |
| PlainDate `prototype Expected SameValue(«null», «[object Function]»)` / `instanceof` | 2+ | NOT this issue — `instanceof` across the link is a known residual | separate |

## How the 71 was measured

For every row of the S13 three-family TSVs, whether the test file contains
`temporalHelpers.js`:

| family | rows that `include` temporalHelpers.js | of those, FAIL | of those, PASS |
| --- | --- | --- | --- |
| `built-ins/Temporal/PlainDate/**` | 35 | **34** | 1 |
| `built-ins/Temporal/Duration/**` | 26 | **24** | 2 |
| `built-ins/Temporal/ZonedDateTime/prototype/**` | 13 | **13** | 0 |
| **total** | **74** | **71** | **3** |

71 of the sample's 169 failures (42 %) include the harness; 3 of its 177 passes
do.

# The brief's attribution was wrong — the SIXTH slice running

S14 was handed: "`typeof PlainDate.from(…).calendarId` answers `"string"` when
read INLINE in the consumer, but the harness reads it through its own function
PARAMETER and still sees `undefined` — a second, independent defect on the
parameter path."

The parameter path is **not** defective. Against the real linked provider, every
spelling of the harness's own shape answers `"string"`:

| shape, real provider, no harness in the module | answer |
| --- | --- |
| `typeof PD.from(…).calendarId` (inline) | `"string"` |
| value through a plain function parameter | `"string"` |
| value through an object-literal METHOD parameter | `"string"` |
| object through a parameter, property read inside | `"string"` |
| the full `assertPlainDate`→`canonicalizeCalendarEra` two-hop | `"string"` |
| an 8-parameter object-literal method (3 defaulted) called with 5 / 6 / 8 args | `"string"` |
| `for (const [input, ...rest] of tests)` + `m(recv, ...rest, trailing)` | `"string"` |

The lesson S13 wrote down ("the brief names where the symptom was OBSERVED, the
census finds where the decision was MADE") holds again, with an addition:
**when the failing program includes a harness, the harness is part of the
input.** Five slices of probes that omitted it were measuring a different
program. The census only moved once a probe was run with the real
`temporalHelpers.js` in the module.

# Reduction ladder (each step measured, `--target standalone`)

1. **one module, no provider, no link** — class with a `calendarId` getter read
   through a parameter: correct. **Does not reproduce.**
2. **reduced provider, LINKED** — same shapes across the package edge: correct.
   **Does not reproduce.**
3. **real provider, no harness** — every shape correct.
4. **real provider + real harness** — reproduces.
5. **bisect the harness by file**: `assert.js` / `sta.js` / `compareArray.js`
   innocent; `temporalHelpers.js` alone reproduces.
6. **bisect `temporalHelpers.js` by member** (46 top-level members): `0..35`
   innocent; `0..35 + m36` reproduces; m36 ALONE innocent → an interaction,
   binary-searched to the pair `[m23, m36]`.
7. **reduce the pair**: the ingredient from m23 is `new construct(...)` on a
   PARAMETER. Then alone: **`function mk(K) { return new K(); }` reproduces.**
8. **isolate the type test**: gating out `buildInt8ArrayCarrierMatch` changes
   nothing, so it is the bare `ref.test $__ta_ctor` itself. A stack trace of the
   first emit for the call names `tryEmitTaStaticOfFrom` as the claiming arm.

Controls that do NOT reproduce, so the trigger is specifically an
unresolved-callee `new`: `Object.create(null)` · `Object.keys` · dynamic
property get · dynamic property set · `Object.defineProperty` · a dynamic CALL
`f()` · `new Object()` · `new Array(n)` · `Array.from` · `new DataView(b)` ·
spread into a call · array-spread literal · `for-of` over a parameter · rest
parameter · rest destructuring · a dynamic call WITH spread · and `new K()`
where `K` provably resolves to a LOCAL class.

# Ruled out by measurement (so the next slice need not re-run these)

- **Not an index shift.** With `mk` the consumer gains one boundary import
  (`__js2wasm_link_construct`); the debug trace shows `ensureObjectRuntime`
  baking `peerMemberGet=1 peerKeys=2 peerMethodCall=6` in BOTH builds.
- **Not a canonical rec-group divergence** (the #5383 S2k hazard). Both consumer
  builds fingerprint `52b5cdd267ae4a5a` via `verifyRuntimeRecGroupBinary`.
- **Not the provider.** Byte-identical cached artifact, namespace
  `js2wasm:npm:@js-temporal/polyfill:61b30b6f2d1d6da9`, exporting all seven
  boundary terminals in both runs.
- **Not the #5383 S2g gate**, and **not the construct DRIVER** — disabling
  `markClassValueConstructSite`, and separately making
  `tryCompileNativeConstructFromValue` decline outright, each changed nothing.
- **Not the string-constant pool.**
- **Not `__extern_get`** (peer consult at the chain-exhausted terminal AND at the
  front of the body: no change), **not `__extern_method_call`** (peer-first
  consult at the front, and disabling both arms unshifted onto it at finalize:
  no change), **not the closed-method brand ladder**, **not the call-site inline
  caches**.
- **Not statically gateable.** `ctx.oracle.declaredNameOf` /
  `builtinReceiverOf` / `typeKeyOf` all answer `undefined` for
  `Temporal.PlainDate` — the injected global is `any` — so the receiver of the
  TA arm is indistinguishable at compile time from the harness's `TA` parameter.
  The guard had to be the runtime brand VALUE.

# Acceptance criteria

1. The two-line reduction answers `"string"` / `24` with the `mk` line present,
   against the real linked provider, fresh `JS2WASM_TEMPORAL_CACHE`. **MET**
2. The real `temporalHelpers.js` in the module no longer changes any of the
   eight symptom reads. **MET** — the harness column is now identical to the
   no-harness column, including the one pre-existing TRAP
   (`Duration.from("P1Y")`), which reproduces without the harness and belongs to
   the separate `sn()` bucket.
3. The three-family sample improves with **0 pass→fail**. — see #5383 S14.
4. `gc` lane byte-identical; TypedArray statics must not move; no new host
   imports. — see #5383 S14.
