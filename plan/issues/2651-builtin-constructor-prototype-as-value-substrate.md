---
id: 2651
title: "standalone: builtin constructor + prototype as a first-class VALUE (TypedArray ctor-iteration substrate)"
status: blocked
updated: 2026-07-17
model: fable
fable_role: spec
blocked_on: 2580
assignee: ttraenkler/sd-2651
slices_done: "D2/M1 (PR #2043, commit 7374c34c6)"
slices_remaining: "M3 (%TypedArray% intrinsic value-dispatch) — predecessor-stack on #2580 M3"
sprint: Backlog
created: 2026-06-24
priority: high
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: codegen, runtime, value-rep
language_feature: built-ins, constructors, prototype chain, TypedArray
goal: standalone-mode
model: fable
fable_role: spec
parent: 1888
related: [1907, 1888, 2580, 2648, 2649, 2650, 2595, 1395, 2026]
test262_bucket: standalone-dynamic-object-property
---

# #2651 — Builtin constructor + prototype as a first-class readable VALUE (standalone)

> Architectural sub-issue of **#1888 case-(c)** ("named built-in
> constructor/namespace as a value") and the residual tail of **#1907 S6-b**
> (the per-builtin whitelist). #1907/#1888 landed the _mechanism_ for builtin
> **namespaces** (`Array`, `Object`) and builtin **prototypes**
> (`String.prototype`, `Date.prototype`, …) as values; this issue extends it to
> the **constructor functions themselves** — `Int8Array`, `Uint8Array`, … —
> read as first-class values, which is the gate for the bulk of standalone
> `built-ins/TypedArray/prototype/*` test262 rows. **SPEC ONLY — no code here.**
> Conservative dual-mode invariant from #1472/#1888 holds throughout: GC/host
> path unchanged and default; standalone is the new native path; any uncertainty
> ⇒ fail loud, never invalid Wasm.

## Verified mechanism (per-process probe, current `main` `c2847896d8`, 2026-06-24)

The `testWithTypedArrayConstructors(f, …)` harness
(`test262/harness/testTypedArray.js`) builds a runtime **array of constructor
values** (`typedArrayConstructors = [Float64Array, Float32Array, Int32Array, …]`)
and, for each, binds an arg-factory, then inside `f` reads the constructor **as a
value**: `new TA(arg)`, `TA.name`, `TA.prototype`, `TA.BYTES_PER_ELEMENT`, and
`Object.getPrototypeOf(TA)` (the `%TypedArray%` intrinsic). Every
`built-ins/TypedArray/prototype/{indexOf,lastIndexOf,includes,at,…}` row routes
through this harness, so the per-row gate is the **constructor-as-value read**,
not the method body (the method bodies were fixed in #2648/#2644).

**Probe 1 — which read fails, and how it is lowered.** Compiling each value-read
shape `--target standalone` and decoding the WAT (per-process, NOT the in-process
`runTest262File` loop — see the #2580 runner-artifact warning):

| shape (receiver is the bare builtin ctor as a VALUE)         | default `--target standalone`                                      | strict host-free (`strictNoHostImports`)                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `const c = [Int8Array, Uint8Array]` (into array)             | emits `env.global_Int8Array`, `env.global_Uint8Array` host imports | **`ref.null.extern`** → value is null                               |
| `const TA: any = Int8Array; TA.name`                         | `env.global_Int8Array`                                             | `ref.null.extern` → `.name` throws "Cannot access property of null" |
| `TA.prototype` (via `any` alias)                             | `env.global_Int8Array`                                             | `ref.null.extern` → `undefined`                                     |
| `TA.BYTES_PER_ELEMENT` (via `any` alias)                     | `env.global_Int8Array`                                             | `ref.null.extern` → `undefined`                                     |
| `Object.getPrototypeOf(Int8Array)`                           | `env.global_Int8Array`                                             | `ref.null.extern` → `undefined`                                     |
| **baseline** `new Int8Array([1,2,3])` (ctor in NEW position) | **0 env imports** (native fast path)                               | **0 env imports**, correct                                          |

The WAT for `const TA = Int8Array; TA.name` decodes to:
`(local $TA externref) … ref.null extern; local.tee $TA; ref.is_null; (if (then <throw "Cannot access property of null">))`.
So the bare TypedArray constructor read **as a value** resolves to
`ref.null.extern` (the graceful-default fallback), and every downstream member
read (`.name`/`.prototype`/`.BYTES_PER_ELEMENT`/`new TA(...)`/identity)
degrades to `undefined`/null/throw — the whole `test` export returns
`undefined`.

**Probe 2 — it is NOT a compile-error refusal anymore.** Under #1907/#1888 the
old `__get_builtin` refusal is gone; the value read _compiles_ and either (a) in
default standalone leaks a host import `env.global_<Name>` (so the test runner's
`buildImports` satisfies it with the _real host_ constructor and the row PASSES
in the non-strict lane — masking the gap), or (b) under the strict host-free
contract resolves to `ref.null.extern` (so a genuinely standalone binary is
wrong). **The default-standalone test262 lane currently PASSES these rows
because the harness provides `env.global_<Name>`** — confirmed by running
`indexOf/fromIndex-infinity`, `indexOf/fromIndex-minus-zero`,
`lastIndexOf/fromIndex-infinity`, `includes/tointeger-fromindex` per-process via
the real `runTest262File`: all four `pass` in BOTH host and standalone targets.

> **IMPORTANT scoping correction (sizing the lever honestly).** Because the
> non-strict standalone lane satisfies `env.global_<Name>` from the harness, the
> _test262-current standalone baseline_ (the #2097 floor's input report) already
> counts many of these rows as PASS. The true conformance lever this substrate
> unlocks is therefore **(i)** the rows that read the constructor value in a way
> the host import canNOT paper over — e.g. `Object.getPrototypeOf(TA) ===
Object.getPrototypeOf(OtherTA)` (the `%TypedArray%` intrinsic-identity rows),
> `TA.prototype` identity/`isPrototypeOf` rows, and constructor-identity
> (`sample.constructor === TA`) rows where the host externref and the native vec
> brand disagree — PLUS **(ii)** the **true host-free standalone floor**
> (`strictNoHostImports`), where EVERY ctor-iteration harness row is currently
> `undefined` (null ctor) rather than pass. The substrate's headline value is
> making the standalone lane _genuinely host-free_ for the whole TypedArray
> harness family (removing the `env.global_<Name>` leak, which is also the
> #2094 leaked-host-import class), and flipping the identity/intrinsic rows that
> the host import cannot satisfy. **Measure both buckets at Slice 0 before
> committing to M2+** (see Acceptance / "sizing gate").

### Loci (file:line, current `main`)

1. **Leak / null source — `collectDeclaredGlobals`**, `src/codegen/index.ts:12676-12734`.
   `AMBIENT_BUILTIN_CTORS` (includes every TypedArray ctor) registers
   `env.global_<Name>` as a declared global for any **bare value use**
   (`valueRefNames`, `isBareValueUse` at :12634). This path is **NOT gated on
   standalone** — under `--target standalone` it leaks a host import; under
   `strictNoHostImports` the import is suppressed by the strict gate and the
   identifier falls through to `ref.null.extern`.
2. **Bare-identifier resolution — `compileIdentifier`**,
   `src/codegen/expressions/identifiers.ts:687-690`. The standalone native-value
   path `emitBuiltinNamespaceObject` fires ONLY for
   `isSupportedBuiltinNamespace(name)` = `{Array, Object}`
   (`src/codegen/builtin-static-globals.ts:20-27`). TypedArray ctors are not in
   that set → fall through to `declaredGlobals` (:693, host import) or the
   `ref.null.extern` default (end of `compileIdentifier`).
3. **`<Name>.BYTES_PER_ELEMENT` static fast path** —
   `src/codegen/property-access.ts:333-403` (#2595). Works for a **direct**
   `Int8Array.BYTES_PER_ELEMENT` access (static receiver), but the harness reads
   it off an `any`-typed alias (`const TA = ctors[i]; TA.BYTES_PER_ELEMENT`),
   which is a runtime externref → the static fast path can't fire.
4. **`<Name>.prototype.<member>` value reads** —
   `src/codegen/property-access.ts:759-787` (`tryCompileStandaloneBuiltinProtoMemberRead`)
   - the brand table `src/codegen/native-proto.ts:71-127` (TypedArray brands
     `BUILTIN_BRAND_BASE+4..+14` are **reserved but NOT wired** — no
     `ensure<View>NativeProtoGlue` exists). This handles the **direct** two-level
     `Int8Array.prototype.<member>` shape only; an `any`-aliased `TA.prototype` is
     again a runtime externref.
5. **Dynamic `new TA(...)`** — `src/codegen/expressions/new-super.ts`
   (`emitDynamicNewFallback`, the `__construct`/`__construct_closure`
   brand-dispatch, ~:3678-3810). A `new (anyCtorValue)(args)` already has a
   dynamic path, but it dispatches on a runtime brand/closure; a builtin-ctor
   _value_ currently carries no brand it recognizes (it's a null externref or a
   host import), so `new TA(...)` over an iterated ctor value does not reach the
   native TypedArray construct path.

## Why this is substrate, not a point-fix

The harness **captures the constructor into a value first** (`ctors[i]` → `TA`),
which structurally defeats every _static-receiver_ fast path the compiler has
(the #2595 `BYTES_PER_ELEMENT` fold, the #2375 direct-`new` view path, the
`tryCompileStandaloneBuiltinProtoMemberRead` two-level shape). To serve the
iterated form, the builtin constructor must exist as a **real first-class value**
that simultaneously:

- **carries identity** so `TA === Int8Array`, `sample.constructor === TA`, and
  `Object.getPrototypeOf(Int8Array) === Object.getPrototypeOf(Uint8Array)` (the
  `%TypedArray%` intrinsic) hold;
- **answers value reads** `.name` → `"Int8Array"`, `.BYTES_PER_ELEMENT` → 1,
  `.prototype` → the (native) view prototype object, host-free;
- **remains constructible** so `new TA(arg)` reaches the existing native
  TypedArray construct path (`new-super.ts` view construction), keyed off the
  value's brand rather than a static identifier.

This is the **#1888 case-(c)** "built-ins as static globals" representation,
already proven for `Array`/`Object` namespaces and the wrapper prototypes —
extended to the constructor-functions tier with a **construct brand** and an
**intrinsic-parent link**. It couples to the **#2580 value-rep substrate**
(`project_standalone_any_string_value_read_substrate`): the iterated `TA` is an
`any`-typed receiver, so its member reads and its `new`-dispatch are exactly the
"dynamic read on an `any` receiver" the M2/M3 dynamic-read protocol governs —
this issue is the _builtin-constructor_ specialization of that substrate and
MUST share the boxed-family `ref.test`/brand dispatch, not invent a parallel one.

## Architectural decisions

### D1 — Representation: a demand-driven lazy singleton `$NativeCtor` value per referenced builtin constructor (mirror `__class_<Name>`), NOT a `globalThis` ctor table.

Per `feedback_compile_away` + the #1888 D4 design, materialize ONLY the
constructors the program references as values (the harness references all
non-bigint TypedArray ctors; a typical program references few). For each
referenced builtin ctor `<Name>`, emit a **lazily-initialised nullable Wasm
global** `$__builtin_ctor_<Name> : (ref null externref)` holding a singleton
value object, exactly as `classObjectGlobals` / `emitLazyClassObjectGet`
(`identifiers.ts:727`, `extern.ts`) does for user classes (`__class_<Name>`).
The singleton is the constructor's first-class identity; bare `<Name>` value
reads and `ctors[i]` element reads both resolve to the same global ⇒ identity
holds.

**The singleton's shape — reuse the `$NativeProto`/boxed-family struct, add a
construct-brand and a parent link.** Fields the value object must answer:

- `name` (string) — `"Int8Array"`; a compile-time constant per ctor.
- `BYTES_PER_ELEMENT` (i32, boxed-number on read) — the static element width
  (the #2595 `TYPED_ARRAY_BYTES_PER_ELEMENT` table is the source of truth).
- `prototype` (externref) — the native view prototype object (the
  `$NativeProto` materialized via a new `ensure<View>NativeProtoGlue`, D2).
- a **construct brand** (i32) — the view's runtime brand (the existing
  TypedArray vec-element kind / view tag) so `new <ctorValue>(args)` dispatches
  to the native construct path (D3).
- a **`[[Prototype]]` link** to the shared `%TypedArray%` intrinsic singleton
  (D4) so `Object.getPrototypeOf(Int8Array) === Object.getPrototypeOf(Uint8Array)`.

> **Do NOT box every method.** The ctor value carries `name`/`BYTES_PER_ELEMENT`/
> `prototype`/brand/parent only. Static methods (`TA.from`, `TA.of`) are already
> intercepted at the static-receiver property-access site for the _direct_ form;
> the _iterated_ `TA.from` form is out of scope for slice 1 (refuse-loud, a later
> slice) — the harness rows do not read iterated `TA.from`.

### D2 — Wire the reserved TypedArray `$NativeProto` glue (`ensure<View>NativeProtoGlue`).

The brand table (`native-proto.ts:71-127`) already reserves
`Int8Array … Float64Array` + `%TypedArray%`. Add the `ensure<View>NativeProtoGlue`
registrations (mirroring `ensureDateNativeProtoGlue`,
`array-object-proto.ts:536`) so `<Name>.prototype` materializes a `$NativeProto`
object host-free, with the `%TypedArray%.prototype` method CSV
(`indexOf,lastIndexOf,includes,at,subarray,…`). The concrete view protos share
the abstract `%TypedArray%.prototype` member set (their own-prototype is mostly
empty; the methods live on the intrinsic). So register **one** `%TypedArray%`
glue with the full method CSV, and the concrete-view protos link to it as parent
(D4) — keeping binary size proportional. Per the #2375 caution
(`property-access.ts:660`), TypedArray views carry vec/runtime-state
entanglement, so the proto-object materialization MUST be a pure value object
(member CSV + name; `emitLazyNativeProtoGet` never calls `emitMemberBody`) — the
method _bodies_ already exist as the native vec method helpers and are reached
via the existing instance-method dispatch, NOT re-emitted on the proto value.

### D3 — `new <ctorValue>(args)` dispatches on the construct brand to the existing native view-construct path.

The ctor value carries the view brand (D1). Extend the dynamic-`new` fallback
(`new-super.ts` `emitDynamicNewFallback`): when the callee value `ref.test`s as a
`$NativeCtor` (the builtin-ctor singleton struct), read its brand field and
branch to the **already-existing** native TypedArray construct emitter (the same
code `new Int8Array([...])` reaches in the static-callee case). This is a
brand-switch over the concrete views — keyed at runtime by the brand the value
carries, NOT a `call_indirect` (the construct impls are compile-time-known native
helpers). Refuse-loud for any brand whose native construct impl is not yet
reachable (none expected — all non-bigint views have a native construct path
today via the static form).

### D4 — The `%TypedArray%` intrinsic singleton + `[[Prototype]]` links.

`Object.getPrototypeOf(Int8Array)` returns the abstract `%TypedArray%`
constructor intrinsic; ALL concrete views share it. Materialize **one** lazy
`$__builtin_ctor_%TypedArray%` singleton (using the reserved
`%TypedArray%` brand) and link every concrete-view ctor singleton's
`[[Prototype]]` field to it. `Object.getPrototypeOf(<ctorValue>)` reads that link
(reuse the dynamic-`[[Prototype]]` walk the #2580 M3 substrate is building — see
the M3 architect spec in `plan/issues/2580-…md`; this is the same
`[[Prototype]]`-on-a-dynamic-object read, specialized to the builtin-ctor
singleton). Likewise `<ctorValue>.prototype`'s `[[Prototype]]` links to
`%TypedArray%.prototype` so view-proto inheritance holds. **Coordinate with the
#2580 M3 lane** — do NOT duplicate the `[[Prototype]]`-link field/walk; consume
it. If #2580 M3 has not landed the link field when this issue starts, this
issue's slice M3 (intrinsic identity) stacks on the #2580 M3 branch as an
explicit predecessor (CLAUDE.md predecessor-stacking).

### D5 — Suppress the `env.global_<Name>` host import under standalone; the singleton replaces it.

`collectDeclaredGlobals` (`index.ts:12721`) must NOT register
`env.global_<Name>` for a TypedArray ctor when `ctx.standalone` AND the native
ctor-singleton path covers it (slice-gated: only for the views the slice wires).
This removes the leaked host import (the #2094 class) so the default-standalone
binary is genuinely host-free and the strict floor stops null-resolving. **Gate
narrowly** — only suppress for ctors the singleton actually materializes; an
un-wired ctor keeps the existing behaviour (host import in non-strict, refuse in
strict) so no row regresses before its slice lands.

## Host-vs-standalone split

- **GC/host mode: byte-for-byte unchanged.** `global_<Name>` host imports and the
  V8-backed constructor objects stay; the native-singleton path is
  `ctx.standalone`-gated. Verify with a host-mode WAT byte-identity guard on
  `new Int8Array([...])` and `Int8Array.BYTES_PER_ELEMENT`.
- **Standalone (default + strict): the native singleton is the value.** The
  singleton path is gated on `ctx.standalone`; under `strictNoHostImports` the
  `global_<Name>` suppression (D5) means the singleton is the ONLY source, so the
  value is correct host-free. The default-standalone lane ALSO uses the singleton
  (not the host import) once D5 fires — which is what removes the leak.

## INDEPENDENT SLICES (each a full-gate-validated PR; standalone floor #2097 authoritative)

> **Validation discipline (load-bearing — this is the #1888-class eject zone).**
> Every slice touches value-rep / builtin resolution → **broad-impact**. Per
> `project_broad_impact_validate_full_ci` and
> `project_standalone_floor_only_on_merge_group`, each slice MUST validate via
> the **merge_group** (the standalone floor #2097 runs only there, NOT on PR) /
> local-ci, NEVER a scoped sweep — the three s64 ejects (#1837/#1838/#1844) all
> passed scoped sweeps then failed the full gate. Gate the whole feature behind a
> `BUILTIN_CTOR_VALUE_WIRED` boolean (mirror `S2_OPENANY_DISPATCH_WIRED`) so it
> can land dark and flip on after the floor is green. Add a host-mode
> byte-identity guard + a standalone determinism guard per slice; STOP-THE-LINE
> on any host-`new Int8Array` / `BYTES_PER_ELEMENT` byte-diff or floor eject.

### Slice 0 — SIZING GATE (no runtime; measure, do first)

Before any code, settle the honest row count (the scoping-correction above):

1. Run the FULL `built-ins/TypedArray/prototype/{indexOf,lastIndexOf,includes,at,
find,findIndex,every,some,…}` dir per-process (isolated, NOT the in-process
   loop — see the #2580 runner-artifact warning) under BOTH the default and the
   `strictNoHostImports` standalone target; bucket each row by `{host-pass /
standalone-pass-nonstrict / standalone-pass-strict}`.
2. The lever = (strict-fail − default-fail) [the host-free floor rows] PLUS the
   identity/intrinsic rows the host import cannot satisfy in EITHER lane
   (`Object.getPrototypeOf(TA)===…`, `sample.constructor===TA`,
   `TA.prototype`-identity). Record the per-bucket counts in this issue file.
3. **Decision:** if the host-free-floor + identity bucket is < ~40 rows, land
   only M1 (the host-free correctness + leak removal) and PARK M2/M3; if it is
   the expected ~hundreds (whole harness family × strict), proceed M1→M3.

- **Deliverable:** the bucket table here + a go/no-go on M2/M3.

## Slice 0 — EXECUTED (sizing gate, 2026-06-24, sd-builtin-ctor-value, `main` d942ad074c)

Per-process fork scan (one fresh process per test — NOT the in-process
`runTest262File` loop, per the #2580 runner artifact), three buckets per file
via the runner's own `wrapTest` + `buildImports` (so the harness `testTypedArray.js`
inlining — `const constructors = [Int8Array, …]; const TypedArray =
Object.getPrototypeOf(Int8Array.prototype).constructor` — is faithfully present):

- **host** = default gc/JS-host target,
- **def** = `--target standalone` (the lane that tolerates `env.global_<Name>`),
- **strict** = `--target standalone` + `strictNoHostImports` (the true host-free
  floor / #2097-class contract).

Scanned **176** `built-ins/TypedArray/prototype/*` files across 12 method dirs
(`indexOf, lastIndexOf, includes, at` = 98; `find, every, join, reduce, map,
fill, copyWithin, keys` = 78). Skipped negative/async; the denominator is
**host-passing** rows (the only ones where a standalone result is meaningful).

### Bucket table (TypedArray prototype, n=176 files, 144 host-passing)

| bucket                                                                                                  |   count | % of host-pass |
| ------------------------------------------------------------------------------------------------------- | ------: | -------------: |
| host-pass (denominator)                                                                                 | **144** |           100% |
| pass standalone (def AND strict — already work)                                                         |  **88** |            61% |
| **def-fail = THE #2651 LEVER**                                                                          |  **56** |        **39%** |
| — of which `Codegen error: <View>.prototype built-in static property value read … (#1907 / #1888 S6-b)` |  **52** |        **36%** |
| — of which Symbol-coercion trap (`return-abrupt-tointeger-fromindex-symbol.js`, NOT #2651)              |       3 |             2% |
| — of which other CE                                                                                     |       1 |            <1% |
| **host-free FLOOR rows** (def-pass-via-leak BUT strict-fail)                                            |   **0** |             0% |

### The three load-bearing findings (these CORRECT the spec's hypotheses)

1. **The leak masks NOTHING — `floor = 0`.** Every one of the 88 def-pass rows
   ALSO passes strict (host-free); every def-pass row that carried a
   `global_<Name>` import passed strict too. So the spec's central hypothesis —
   "the default lane passes via the `env.global_<Name>` leak, masking the gap" —
   is **FALSE for this cluster**. The `global_<Name>` import is present but **not
   load-bearing**: the rows that pass, pass host-free; the rows that need the
   substrate **fail the DEFAULT lane too**, with a hard CE.

2. **The lever is a CE, not a null/leak — and it is the `<View>.prototype`
   value read, NOT the bare constructor.** 52 of the 56 def-fails (**92.9%**) are
   the **`#1907 / #1888 S6-b` `<View>.prototype built-in static property value
read` CE**. The exact trigger (verified by compiling the wrapped form +
   reading the failing line): the runner's `needsTypedArrayBinding` shim
   `const TypedArray = Object.getPrototypeOf(Int8Array.prototype).constructor;`
   combined with `propertyHelper.js`'s `verifyProperty(TypedArray.prototype.<m>,
…)` — i.e. reading **`<View>.prototype` (and its members) as a VALUE**. The
   bare _constructor_ value (`[Int8Array, …]`, `new TA(...)`) is NOT the blocker
   for these rows.

3. **`D5` (suppress `env.global_<Name>` under standalone) moves ZERO rows — do
   NOT land it as a row-mover.** Confirmed directly: the def-fail CE is the
   `<View>.prototype` `$NativeProto`-glue gap (`Int8Array.prototype built-in
static property value read`), which is independent of the `global_` import
   (the message contains no `global_`). Removing the leak is pure host-free
   hygiene (drops a non-load-bearing import) but flips 0 conformance rows and
   risks perturbing the 88 passing rows. **D5 is demoted to optional cleanup, NOT
   a Slice-0 deliverable, and was deliberately NOT landed.**

### Cross-cluster check — the lever is TypedArray-SPECIFIC (does NOT generalize to Number/Math)

Scanned **60** `built-ins/Number/prototype/{toString,toFixed,toPrecision,
toExponential}` files (47 host-passing): **19 def-fail, but ZERO are the S6-b
builtin-value-read CE** — they are 15 `fail` (value/precision bugs, e.g.
`toExponential` return-values) + 4 `trap` (illegal-cast / Symbol). So the
Number/Math standalone residual is a **method-correctness lane, not the #2651
substrate.** The coordinator's "every remaining standalone lane is dominated by
#2651" framing holds for the **TypedArray** family specifically (where the
ctor-iteration harness + `%TypedArray%` intrinsic + `verifyProperty(TA.prototype,
…)` force the `.prototype`-value read); Number/Math def-fails are a separate
(method-body) lever. `floor = 0` in Number too.

### Extrapolated row count #2651 unlocks

The 12-dir TypedArray sample is representative of the **540-file ctor-iteration
harness cluster** (the files that `include testTypedArray.js`); the lever rate is
density-variable by dir (descriptor-heavy dirs `at`/`includes`/`name`/`length`/
`prop-desc` ≈ 50%; behavioral dirs `find`/`every` ≈ 18%), blended **≈ 36%
substrate-pure (S6-b CE)** of host-passing rows:

- **Measured-sample rate applied to the 540 harness files:** ~0.36 ×
  (host-passing fraction ≈ 0.82 × 540 ≈ 443) ≈ **~160 TypedArray prototype rows**
  flip when the `<View>.prototype` `$NativeProto` value-read CE is resolved
  (D2/M1). This aligns with the #1907 harvest's `Int8Array.prototype` 460+52
  -record signature being the single largest unmapped builtin-value-read pair.
- **All in the DEFAULT lane** (not the strict floor) — so they bank against the
  committed `test262-current` standalone baseline immediately, no
  strict-mode-only caveat.
- **host-free-floor bonus: 0** (the leak masks nothing).
- **identity/intrinsic rows** (`Object.getPrototypeOf(TA)===…`,
  `sample.constructor===TA`): folded INTO the 36% — they surface as the same
  `.prototype`/`%TypedArray%` value-read CE, not a separate passing-but-wrong
  bucket (the CE refuses _before_ any identity check runs, so no distinct
  identity bucket exists).

### VERDICT (Slice 0 go/no-go) — re-prioritize M1 onto D2, drop the bare-ctor framing, skip D5

- **GO on M1, but RE-SCOPE it: the core M1 work is D2 (wire the reserved
  TypedArray `$NativeProto` glue so `<View>.prototype.<member>` value reads
  resolve host-free), NOT the D1 bare-constructor singleton.** The harness rows
  are gated on `<View>.prototype`-as-value — the **#1907/#1888 S6-b
  per-builtin-whitelist residual**, exactly the `Int8Array.prototype` 460+
  signature the #1907 harvest flagged as the #1 standalone codegen-refusal pair.
  M1 = add `ensure<View>NativeProtoGlue` + the `%TypedArray%` intrinsic glue (one
  shared member CSV), mirroring the landed `ensureDateNativeProtoGlue`. Estimated
  **~160 default-lane rows**.
- **D1 (bare-constructor `$NativeCtor` singleton) + M2 (`new <ctorValue>`) +
  M3 (intrinsic identity) are NOT the primary lever** for this cluster — the
  measured def-fails do not bottleneck on them. Keep them as **follow-on slices
  for the residual** (rows that, after D2, still read the bare ctor as a value or
  do `new TA()` over an iterated value), but **prioritize D2/M1 first**;
  re-measure the residual after M1 lands before committing M2/M3.
- **D5 (`global_<Name>` suppression): DROP as a row-mover** (0 rows); optional
  host-free-hygiene cleanup only, behind its own gate, never bundled with M1.

This sizing was the deliverable. No code landed (D5 proved not worth landing as a
row-mover). The measurement instrument (`.tmp/size-one.mjs` per-process, 3-bucket
via `wrapTest`+`buildImports`) is the faithful path for any re-measure.

### Slice M1 — ctor-value singleton + name/BYTES_PER_ELEMENT/prototype reads (the core; depends on D1/D2/D5)

> **Slice-0 re-scope (2026-06-24):** the MEASURED M1 lever is **D2** (wire the
> reserved TypedArray `$NativeProto` glue so `<View>.prototype.<member>` value
> reads resolve host-free) — ~160 default-lane rows, the #1907 S6-b
> `Int8Array.prototype` residual. The D1 bare-`$NativeCtor`-singleton +
> BYTES_PER_ELEMENT/name reads below are NOT the bottleneck for the harness
> rows; demote them to a follow-on residual slice and build D2 first.

- New `src/codegen/builtin-ctor-globals.ts` (mirror `builtin-static-globals.ts`):
  `emitBuiltinCtorValue(ctx, fctx, name)` → lazy `$__builtin_ctor_<Name>`
  singleton populated with `name`/`BYTES_PER_ELEMENT`/`prototype`/brand. Register
  the reserved TypedArray `$NativeProto` glue (D2). Wire bare-identifier
  resolution (`identifiers.ts:687`) + the `any`-aliased member reads
  (`.name`/`.BYTES_PER_ELEMENT`/`.prototype` off a runtime ctor value, via the
  boxed-family read site). Suppress `env.global_<Name>` under standalone (D5).
- **Acceptance rows:** the strict-host-free harness rows (every
  `indexOf`/`includes`/`at`/… row, currently `undefined`-ctor under
  `strictNoHostImports`) compile + run host-free with the singleton; `TA.name ===
"Int8Array"`, `TA.BYTES_PER_ELEMENT === 1`, `TA.prototype` non-null. Zero
  `env.global_<Name>` in the standalone binary for the wired views.
- Full-gate (merge_group / standalone floor). **Canary for the leak-removal +
  the value-read correctness.**

## Slice M1 — EXECUTED (D2 core, 2026-06-25, dev-builtin-ctor, off `main` d28fdb2c5)

Landed the **measured Slice-0 lever**: wired the reserved TypedArray
`$NativeProto` glue so `<View>.prototype` (and its member-value reads) resolve
host-free in `--target standalone`, retiring the `#1907 / #1888 S6-b`
`<View>.prototype built-in static property value read` CE for the 9 non-bigint
views. **No D1 bare-`$NativeCtor` singleton, no M2 `new`, no M3 intrinsic
identity, no D5 leak-suppression** (Slice-0 verdict: D2 is the bottleneck; D1/M2/M3
are follow-on residual, D5 moves 0 rows).

### Implementation (mirrors the landed `ensureDateNativeProtoGlue` precedent)

- `src/codegen/array-object-proto.ts`:
  - `TYPED_ARRAY_PROTO_METHODS` — the shared `%TypedArray%.prototype` member set
    (ES2024 §23.2.3); the 4 accessors (`buffer`/`byteLength`/`byteOffset`/`length`)
    flagged as getters.
  - `TYPED_ARRAY_PROTO_METHOD_LENGTH` — per-family arity override (kept SEPARATE
    from the global `PROTO_METHOD_LENGTH` because `%TypedArray%.prototype.set` is
    arity 1 while `Map.prototype.set` is 2 — sharing the table would cross-poison).
  - `makeTypedArrayGlue(brand, name)` — getter-aware glue; `emitMemberBody` is
    pure-refusal (`emitProtoMemberBodyRefusal`), never touching vec/runtime state
    (R4 / #2375). The proto OBJECT materializes from the member CSV only
    (`emitLazyNativeProtoGet` never calls `emitMemberBody`).
  - `ensureTypedArrayIntrinsicNativeProtoGlue` (the shared `%TypedArray%` brand)
    - `ensureTypedArrayViewNativeProtoGlue(ctx, viewName)` for the 9 wired views
      (`WIRED_TYPED_ARRAY_VIEWS`; bigint views deliberately excluded → still refuse).
- `src/codegen/property-access.ts`: `tryEnsureNativeProtoBrand` gains a
  TypedArray-view arm before the generic fallback. All three call sites are
  `ctx.standalone`-gated, so **host/gc mode is byte-for-byte unchanged** (verified:
  the new path is unreachable in host mode).
- `tests/issue-2651.test.ts` — 34 tests: per-view `.prototype` compiles + non-null
  - `.indexOf` value read; the harness alias chain compiles; **0 `env.global_<Name>`
    imports** in the standalone binary; spec-arity meta-folds (TA `set`=1 not Map=2,
    `subarray`=2); bigint views still refuse-loud; host-mode `new Int8Array` /
    `BYTES_PER_ELEMENT` still compile.

### Reground + validation (per-process, NOT the in-process loop — #2580 artifact)

- Confirmed the CE on `main` d28fdb2c5: `Int8Array.prototype` (direct + harness
  alias) → `#1907 / #1888 S6-b` CE. Post-fix: all 9 views compile, run host-free
  (0 imports), proto non-null.
- Per-process `runTest262File` (fresh process each — the in-process loop's
  `compile_error` count is the documented #2580 runner artifact; CI's isolated
  shard workers reflect the true per-process result):
  `indexOf/fromIndex-infinity`, `indexOf/fromIndex-minus-zero`,
  `includes/tointeger-fromindex` all flip to `pass` standalone.
- **Estimated ~160 default-lane TypedArray-prototype rows** flip (the Slice-0
  blended-36% extrapolation to the ~443 host-passing harness files).
- Broad-impact change → **validated in merge_group / standalone floor #2097**, NOT
  a scoped sweep (per `project_broad_impact_validate_full_ci`).

### Residual (follow-on slices, re-measure after M1 lands)

D1 bare-`$NativeCtor` singleton (`[Int8Array, …]`/`TA.name`/`TA.BYTES_PER_ELEMENT`
off an iterated value), M2 `new <iteratedCtorValue>(arg)`, M3 `%TypedArray%`
intrinsic identity (`Object.getPrototypeOf(Int8Array) === …`). D5 leak-suppression
remains optional hygiene only (0 rows). The reserved per-view brands + the
`%TypedArray%` intrinsic glue are now registered, so M2/M3 stack cleanly on this.

### Slice M2 — `new <ctorValue>(args)` dynamic construct (depends on M1, D3)

- Extend `emitDynamicNewFallback` (`new-super.ts`) with the `$NativeCtor`
  brand-switch → native view construct. The harness's `new TA(makeCtorArg(...))`
  over the iterated ctor value now constructs the correct concrete view host-free.
- **Acceptance:** `iterate-ctors-construct` (build `[Int8Array,Uint8Array,
Int16Array]`, `new ctors[i]([1,2,3])`, sum `.length`) → 9 host-free; each view
  is the correct concrete type (`sample instanceof TA`, element-width-correct
  round-trip). The full ctor-iteration harness rows flip in the strict lane.
- Full-gate.

### Slice M3 — `%TypedArray%` intrinsic identity + ctor/proto `[[Prototype]]` (depends on M2, D4; coordinates #2580 M3)

- Materialize the `%TypedArray%` intrinsic singleton; link concrete-view ctor +
  proto `[[Prototype]]`. `Object.getPrototypeOf(Int8Array) ===
Object.getPrototypeOf(Uint8Array)` true; `sample.constructor === TA` true;
  view-proto `isPrototypeOf` chain correct. **Consume the #2580 M3
  `[[Prototype]]`-link field/walk** — predecessor-stack on its branch if not yet
  landed; do NOT fork a parallel `[[Prototype]]` mechanism.
- **Acceptance:** the intrinsic-identity + constructor-identity TypedArray rows
  (the ones the host import canNOT satisfy) flip in BOTH lanes.
- Full-gate. Hardest, last.

## Acceptance criteria

- [ ] **Sizing gate (Slice 0)**: the per-bucket TypedArray-prototype row table is
      recorded here, with a go/no-go on M2/M3.
- [ ] **M1**: bare `Int8Array` (and every wired view) read as a VALUE resolves to
      a native singleton host-free; `TA.name`/`TA.BYTES_PER_ELEMENT`/`TA.prototype`
      correct standalone (default + strict); ZERO `env.global_<Name>` import for
      the wired views; host-mode `new Int8Array`/`BYTES_PER_ELEMENT` byte-identical.
- [ ] **M2**: `new <iterated-ctor-value>(arg)` constructs the correct concrete
      view host-free; the ctor-iteration harness rows run.
- [ ] **M3**: `Object.getPrototypeOf(TA)` intrinsic identity + `sample.constructor
    === TA` hold; the identity/intrinsic rows flip.
- [ ] No regression on the default-`gc`/host suite (Int8Array/TypedArray guards);
      no standalone floor #2097 regression (validated in merge_group, not a sweep).
- [ ] Any un-wired builtin ctor / un-reachable view brand refuses-loud with a
      `#2651 / #1888 S6-c` cite; never invalid Wasm, never a silent null ctor.

## Risks / coordination

- **R1 — the leaked-host-import mask hides the win (sizing trap).** The default
  standalone lane already passes many rows via `env.global_<Name>`. If M1 is
  measured only against the default lane it looks 0-row. The REAL win is the
  host-free floor (strict) + the identity rows. **Slice 0 must bucket strict vs
  non-strict** or the lever is mis-sized (this is exactly the #2573 "0-row"
  trap, inverted).
- **R2 — value-rep / `.length` hot-path coupling (#2580).** The iterated `TA` is
  an `any` receiver; its `.prototype`/`.name`/`new` reads flow through the same
  boxed-family / dynamic-read site #2580 M2/M3 governs. A naive new `.prototype`
  arm could perturb the hot `any`-`.length` path (the #1868 eject precedent).
  Gate strictly on the `$NativeCtor` `ref.test` (a NEW struct brand, disjoint
  from vec/closure/$Object) so typed and existing-`any` reads are byte-identical;
  validate the `any[].length` arithmetic guard every slice.
- **R3 — `%TypedArray%` `[[Prototype]]` link duplication.** Don't fork a parallel
  `[[Prototype]]` mechanism; consume #2580 M3's link field/walk. Predecessor-stack
  if needed.
- **R4 — #2375 TypedArray-init-trap class.** The view proto materialization must
  be a pure value object (member CSV + name; no `emitMemberBody`), else the
  runtime vec-state entanglement that tripped the #2375 init-trap and the Promise
  proto exclusion (`property-access.ts:667`) recurs. Keep the proto value
  body-free; method bodies stay on the existing instance-method vec dispatch.
- **R5 — late-import / type-index shift discipline.** The singleton init runs a
  body-swap (the `emitBuiltinNamespaceObject` `savedBody`/`liveBodies` pattern,
  `builtin-static-globals.ts:177-200`) and may trigger late imports / register
  `$NativeProto` types mid-stream. Follow the
  `project_type_index_shift_and_deadelim` + `project_brand_check_swap_savedbodies`
  discipline: register shared types late+once; use `pushBody`/`popBody`
  (savedBodies) for any throw/else branch capture; `ref.test typeIdx` (append-only
  type indices) over `call __is_<brand>` (funcidx-shift hazard) — the same lesson
  the #2580 M1a vec-dispatch arm relied on.

## Cross-links

- **#1907** (S6-b mechanism — builtin static-method/prototype values; LANDED PR
  #1292) — this extends its case-(c) to the constructor tier.
- **#1888** (the open-any dispatch + built-ins-as-static-globals spec; D4 case-(c)
  is the parent design) — `Array`/`Object` namespace + wrapper-proto singletons
  are the proven precedent.
- **#2580** (the value-rep dynamic-read substrate; M2/M3 `[[Prototype]]`-link +
  boxed-family dispatch) — this is the _builtin-constructor_ specialization;
  share the substrate, coordinate the `[[Prototype]]` link.
- **#2648** (standalone TypedArray `{indexOf,lastIndexOf,includes}` packed
  i8/i16 — LANDED) — the method BODIES this substrate gates the per-row harness
  access TO.
- **#2649** (TypedArray.prototype.subarray empty view), **#2650** (member-read on
  String.prototype.at result) — adjacent standalone TypedArray/String value-read
  residuals; same value-rep family, separate rows.
- **#2595** (`BYTES_PER_ELEMENT` static fast path) — the source of truth for the
  per-view byte width the singleton reads; the static form stays, the iterated
  form is what this adds.
- **#1395** (`__class_<Name>` lazy class-object singleton), **#2026** (dynamic
  `new K()` brand-dispatch) — the precedents for D1 (singleton-as-value) and D3
  (dynamic-new brand-switch).

## Routing

s66 architect/senior-dev (value-rep lane). Coordinate with the #2580 M3 owner
(`sd-value-rep-m3-…`) on the shared `[[Prototype]]` link (D4/R3) before starting
slice M3. M1 + M2 are independent of #2580 and can start immediately after the
Slice-0 sizing gate confirms the lever.

## RE-MEASURE after M1/D2 landed (2026-06-25, sd-2651, `main` 6a36af19c)

M1/D2 (`7374c34c6`, PR #2043) is **landed on main**. Per the Slice-0 verdict
("re-measure the residual after M1 lands before committing M2/M3"), I re-ran the
faithful per-process 3-bucket scan (`.tmp/measure-one.mjs`, one fresh process per
file, host vs `--target standalone`) over **indexOf + at + every** (102 files,
the descriptor-heavy + behavioral mix). The result **corrects the task-dispatch
spec's "DEMOTE M3" guidance — M3 is now the dominant lever.**

### Bucket table (indexOf+at+every, 102 files, 87 host-passing)

| bucket                                                              | count | % host-pass |
| ------------------------------------------------------------------ | ----: | ----------: |
| host-pass (denominator)                                            |    87 |        100% |
| pass standalone (already work — incl. M1/D2 direct-shape rows)     |    53 |         61% |
| **def-fail = remaining lever**                                     |    34 |     **39%** |
| — `ERR:Cannot convert object to primitive value` (**M3 keystone**) |    25 |     **29%** |
| — `compile_error` (BigInt views + abrupt-completion — NOT #2651)   |     9 |         10% |

### The keystone finding (verified per-process + per-shape probe)

**`Object.getPrototypeOf(Int8Array)` returns `null` (ref.null.extern) in
standalone.** The ctor-iteration harness opens with
`var TypedArray = Object.getPrototypeOf(Int8Array);` (= the `%TypedArray%`
intrinsic), then every row reads `verifyProperty(TypedArray.prototype.<m>, …)`.
Because `Object.getPrototypeOf(Int8Array)` resolves to null, `null.prototype`
throws "Cannot convert object to primitive value" → **25 of the 34 def-fails
(74%) are this single gap.** M1/D2 only fixed the **direct** `Int8Array.prototype.<m>`
static shape; the harness's dominant shape is `Object.getPrototypeOf(Int8Array)
.prototype.<m>` (the **M3 %TypedArray% intrinsic**), which M1 did NOT touch.

Verified shapes on current `main` (strict standalone, runtime values):
- `Object.getPrototypeOf(Int8Array)` → `0`/null (should be the `%TypedArray%` intrinsic).
- `Object.getPrototypeOf(Int8Array).prototype.indexOf.length` → TRAP.
- `new (ctors[i])([1,2,3]).length` → `0` (M2: null view, no construct).
- `(sample).constructor === Int8Array` → `false` (M3 identity).
- bare `const TA: any = Int8Array; TA.name` → TRAP (D1 ctor-value).

The 9 CE are out-of-scope: BigInt views (deliberately not wired by M1) +
`return-abrupt-from-this-out-of-bounds.js` / `…tointeger-fromindex-symbol.js`
(separate abrupt-completion / Symbol-coercion bugs, no `prototype`/`%TypedArray%`).

### Corrected scope verdict

- **The remaining #2651 lever is M3 (the `%TypedArray%` intrinsic singleton +
  `Object.getPrototypeOf(<view>)` interception), NOT M2 alone.** The task-dispatch
  note's "DEMOTE M3, enter at D2" reflected the pre-M1 state; **D2 shipped, so the
  next bottleneck moved to M3.** ~25 rows in this 102-file sample (≈29% of host-pass)
  flip when `Object.getPrototypeOf(<TypedArray view>)` returns a real `%TypedArray%`
  intrinsic value whose `.prototype` resolves to `emitLazyNativeProtoGet(%TypedArray%)`
  and whose `.prototype.<m>` member reads route through the M1 native-method-closure
  path. Extrapolated to the ~443 host-passing ctor-iteration harness files: **~130
  default-lane rows** (29% × 443).
- **M3 is a substrate build, not a glue add.** `Object.getPrototypeOf(Int8Array)`
  must yield a first-class intrinsic-constructor VALUE (D1/D4 shape) carrying a
  `.prototype` link to the reserved `%TypedArray%` native proto (brand
  `BUILTIN_BRAND_BASE+3`, glue already registered by `ensureTypedArrayIntrinsic-
  NativeProtoGlue`). The reads on the harness's `TypedArray` alias are runtime-value
  member reads (the #2580 dynamic-`any`-read family), so M3 MUST consume the #2580
  M3 `[[Prototype]]`-walk substrate rather than invent a parallel one. This is the
  go/no-go decision the Slice-0 verdict deferred to this re-measure.

Building infra in place from M1: per-view + `%TypedArray%` brands reserved
(`native-proto.ts:79-89`), intrinsic glue registered, `emitLazyNativeProtoGet`
materializes the proto object. The missing pieces are (a) intercept
`Object.getPrototypeOf(<view-identifier>)` (`calls.ts:5859`) to return the
intrinsic VALUE, (b) make that value's `.prototype` + `.prototype.<m>` resolve,
(c) the ctor-value identity for `sample.constructor === TA`.

### PARKING DECISION (lead, 2026-06-25): M3 BLOCKED on #2580 M3

The remaining M3 slice is **parked behind #2580 M3** (predecessor-stack), not built
now. Rationale: #2580 M3 (in-progress, `sd-2580`) is landing the shared
`[[Prototype]]` / `$Object.$proto` link representation. #2651 M3's `%TypedArray%`
intrinsic value-dispatch (`Object.getPrototypeOf(<view>)` → a branded intrinsic
VALUE whose `.prototype.<m>` reads route through dynamic branded-externref member
dispatch) rides the SAME substrate. Building both concurrently is the exact
#1888-class merge_group-eject + source-conflict risk the issue's validation
discipline warns against. **The M3 picker:** predecessor-stack on `sd-2580`'s M3
branch after it lands, consume its `[[Prototype]]`-link field/walk (do NOT invent
a parallel one), and use the file:line map above. Re-measure the residual on
then-current `main` first (the lever count above is the 2026-06-25 measurement).

## Implementation Plan addendum (Fable, 2026-07-18) — M3 stays parked; the intrinsic-VALUE half now has a named substrate (#2916 B0)

Re-grounded 2026-07-18: **#2580 is still `in-progress` (sd-2580), so the
parking decision stands — do not unpark M3 yet.** Two additions for the
eventual picker so the three-week-old plan doesn't get re-derived or forked:

1. **The intrinsic-constructor VALUE (`Object.getPrototypeOf(Int8Array)` →
   `%TypedArray%`) is the SAME substrate as #2916's B0 `$BuiltinCtor` branded
   carrier** (`$Object` subtype with a `ctorBrand` i32 field; see the
   2026-07-18 plan in
   `plan/issues/2916-standalone-native-instanceof-and-isprototypeof.md`).
   M3's missing pieces map onto it directly: (a) the `calls.ts`
   `Object.getPrototypeOf(<view-identifier>)` interception returns the
   B0 carrier branded `BUILTIN_BRAND_BASE+3`; (b) the carrier's dynamic
   `.prototype` read is B0's finalize-spliced `__extern_get` arm →
   `emitLazyNativeProtoGet(%TypedArray%)` (glue already registered by M1's
   `ensureTypedArrayIntrinsicNativeProtoGlue`); (c) `.prototype.<m>` member
   reads then ride the M1 native-method-closure path. **Whichever of
   sd-2651/M3 or #2916-B0 executes first BUILDS the carrier; the other
   consumes it.** Do not mint two branded-carrier structs — that is the
   #1888-class convergence hazard this file already warns about.
2. **Unpark checklist** (in order, before any M3 code): (a) `#2580` frontmatter
   shows M3 landed (the `$Object.$proto` walk on main); (b) re-run the
   per-process 3-bucket scan (`.tmp/measure-one.mjs` shape) on then-current
   main — the 25/34 keystone count is a 2026-06-25 number and the #2175
   V2 / #2984 / #3006 waves have landed since; (c) check whether #2916 B0
   exists on main (consume) or not (build it per that spec, cross-linked);
   (d) `(sample).constructor === Int8Array` (the D1/D4 identity leg) should
   route through the #3006 `__builtin_ctor_<Name>` singleton machinery
   extended to the TypedArray view names — verify those names aren't already
   in `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` by then.
