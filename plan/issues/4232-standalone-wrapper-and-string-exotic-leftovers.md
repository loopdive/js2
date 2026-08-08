---
id: 4232
title: "Standalone wrapper + String-exotic leftovers: `new Object(<primitive>)` constructor fold, `Object(null)` constructor, and §10.4.3 index/own-property semantics"
status: in-progress
sprint: current
created: 2026-08-08
updated: 2026-08-08
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: primitive-wrappers, property-model, string-exotic-objects
goal: es5
related: [4223, 4224, 4222, 4220, 3133, 3973, 3304, 4176, 3006, 4200]
loc-budget-allow:
  # +11: the #3133 fold gains one guard call plus the comment explaining why a
  # receiver the classifier calls `Object` may not be one. The analysis itself
  # is a new satellite module (object-ctor-primitive-receiver.ts).
  - src/codegen/property-access-dispatch.ts
  # The `.constructor` element-read arms and the String-exotic index read live
  # here and nowhere else, so the guards have to sit in front of them.
  - src/codegen/property-access.ts
  # `__hasOwnProperty`'s body is assembled here; the String-exotic own-property
  # prologue is a splice into it. The prologue itself is a satellite module.
  - src/codegen/object-runtime.ts
  # +9: the reflective String-member dispatcher gains one `replace` arm plus its
  # comment, mirroring the `split` arm immediately above it. The body is in
  # string-proto-replace-transfer.ts.
  - src/codegen/array-object-proto.ts
  # +2 arms on the runtime `.constructor` carrier: the demand-minted
  # `__plain_ctor_Object` accessor and the `$proto == null` arm.
  - src/codegen/wrapper-constructor-carrier.ts
  # +7: the plain-`Object` carrier's SECOND, narrower demand gate, set at the
  # same two places the #4223 gate is (single-source + multi-module). It cannot
  # ride the existing flag — see section 5.
  - src/codegen/index.ts
  # +9: the `plainCtorCarrierDemanded` field and the note explaining why it is
  # separate from `wrapperCtorCarrierDemanded`.
  - src/codegen/context/types.ts
func-budget-allow:
  - src/codegen/property-access.ts::compileElementAccessBody
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/array-object-proto.ts::emitStringProtoMemberBody
  - src/codegen/wrapper-constructor-carrier.ts::wrapperConstructorArmInstrs
  - src/codegen/wrapper-constructor-carrier.ts::ensureWrapperConstructorCarriers
  # The two module-setup functions that set the #4223 demand gate; the #4232
  # narrower gate has to be set in the same place, next to it.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
origin: "2026-08-08 — ES5-standalone-90 Wave 3; the leftovers #4223 and #4222 measured and deliberately did not take"
# coercion-sites: both are NEW modules from this wave calling the CANONICAL
# helpers (__to_primitive for index ToPrimitive, __str_to_number for canonical
# numeric-index checks) — per-file counting registers new-module reuse as growth.
coercion-sites-allow:
  - src/codegen/string-exotic-index.ts
  - src/codegen/string-exotic-own-props.ts
---

# #4232 — wrapper `.constructor` leftovers and String exotic-object index/own-property semantics

Four independent root causes, one theme: a value that IS a primitive wrapper
(or a String exotic object) is treated as an ordinary object somewhere in the
lowering. Each is a separate commit with its own A/B measurement.

## 1 — `new Object(<primitive>)` folds `.constructor` to `Object`

**Root cause.** #3133's `classifyPlainCtorReceiverNamespace` classifies by
STATIC TS type. `new Object(str)` / `Object(5)` has type `Object`, so the fold
answers the `__builtin_Object` namespace singleton before any runtime read
happens. But §20.1.1.1 routes a primitive argument through ToObject, producing a
String/Number/Boolean wrapper whose `.constructor` is that builtin. #4223's
runtime arm already answers this receiver correctly — the fold never let it run.

The failure looks like an identity bug, not a mis-fold: both sides are real
objects, so the test262 text reads `«[object Object]» vs «[object Object]»`.

**Why the obvious fix measures +0.** #4223's agent implemented and measured the
receiver-EXPRESSION version (match `new Object(<primitive>)` at the read site).
It flipped zero files, because the whole corpus binds first:
`var n_obj = new Object(str); n_obj.constructor` — the receiver at the read site
is a bare identifier. The working version has to trace the identifier's
initializer (`oracle.variableInitializerOf`) AND prove the binding is
single-assignment, which `var`/`let` do not give for free.

**Fix.** `src/codegen/object-ctor-primitive-receiver.ts` (new) —
`receiverIsPrimitiveWrapper` traces the receiver through a bounded alias chain
to its producing expression, refuses any name that is assigned/updated/rebound
anywhere in the file (name-based syntactic scan, cached per source file), and
then asks whether the producer is a call/construct of the AMBIENT global
`Object` with a provably primitive first argument. The #3133 fold consults it
and stands down. Every uncertainty answers `false` (keep today's behavior).

Arity is deliberately not pinned to 1 — §20.1.1.1 ignores extra arguments and
`new Object(1, 2, 3)` (`S15.2.2.1_A6_T1`) is in the corpus.

### Measured — +12, 0 regressions

`built-ins/Object/S15.2*.js` (50 files) through
`runTest262File(…, "standalone")`, sequential: **25 → 37 pass**. The twelve are
exactly `S15.2.2.1_A3_T{1,2,3}`, `A4_T{1,2,3}`, `A5_T{1,2,3,4}`, `A6_T{1,3}`.

## 2 — `Object(null)` / `Object(undefined)`: `.constructor` reads `undefined`

**Root cause.** These produce an ordinary `$Object`. The read is `any`-typed, so
no static fold applies, and the runtime `__extern_get` proto-walk follows
`$Object.$proto` — which is null for a bare `$Object`, so the walk falls out as
a miss. #4223's wrapper arm declines (no `[[PrimitiveValue]]` slot).

**Fix.** `src/codegen/plain-object-constructor-arm.ts` (new) — a
`$proto == null`-gated arm appended AFTER the wrapper arm in `__extern_get`,
answering the `__builtin_Object` namespace singleton through a demand-minted
accessor (`__plain_ctor_Object`, same lazy-init reason as #4217/#4223: the
wrapper read is routinely the module's first demand for `Object`).

The `$proto == null` gate is the whole safety argument: an instance of a user
`function F(){}` has a non-null `$proto` pointing at `F.prototype`, so it never
reaches this arm and keeps inheriting `F.prototype.constructor`. The arm also
declines when the object carries an OWN `constructor` (§7.3.2) and when the
receiver is `$__vec_base`/wrapper-shaped (those arms run first).

### Measured — +6, 0 regressions

Same population: **37 → 43 pass**. The six are `S15.2.1.1_A1_T{1..5}` and
`S15.2.1.1_A3_T2`.

## 3 — String exotic objects: `s[i]` out of range, and own index/`length`

**Root cause (index read).** The #1910-R4 / #3304 arm in
`compileElementAccessBody` lowers a statically-string / String-wrapper receiver
to `__str_charAt`, whose §22.1.3.1 semantics answer `""` out of range. §10.4.3.5
StringGetOwnProperty says a String exotic object has an own property for an
index ONLY when it is a canonical integer index within `[0, len)` — everything
else is `undefined`. The arm's result type (`ref $NativeString`) cannot even
represent `undefined`, so this was a representation problem, not a comparison
one. #3973 already got this right for `any`-typed receivers; the static arm was
the last member of the family still on charAt bounds.

**Root cause (own properties).** `__hasOwnProperty` casts the receiver to
`$Object` and consults `__obj_find` on the own-props table. A String wrapper's
`length` and index properties are not table entries — they are derived from the
`[[StringData]]` in the `[[PrimitiveValue]]` slot — so every own-property query
on a wrapper answered `false`.

**Fix.** `src/codegen/string-exotic-index.ts` (new) —
`emitStringExoticIndexGet` re-emits the static arm with #3973's guard
(integral round-trip `f64(i32(idx)) === idx`, then ONE unsigned compare that
rejects negatives and `>= len` together), returning `externref` so `undefined`
is representable. `src/codegen/string-exotic-own-props.ts` (new) — the
`__hasOwnProperty` prologue answering `length` and in-range canonical indices
for a `[[PrimitiveValue]]`-carrying `$Object` whose slot is a `$AnyString`.

### Measured — +12, 0 regressions

`built-ins/String/*.js` (92 files, top level): **59 → 71 pass**. Ten from the
index reads (`15.5.5.5.2-3-{3..8}`, `-7-{1..4}`) and two from own properties
(`S15.5.5.1_A2`, `S15.5.5.1_A4_T1`).

`arr.hasOwnProperty("1")` — the pre-existing miss noted in #4222 — does NOT
share this fix site and was re-measured as already correct on this base
(`[10,20,30].hasOwnProperty("1") === true`), so nothing was done for it.

## 4 — reflective `String.prototype.replace` (#4224's leftover)

**Root cause.** #4224 fixed the DIRECT path. The battery mostly TRANSFERS the
method (`__instance.replace = String.prototype.replace`), which reaches the
`native-proto.ts` closure factory — whose String glue had no `replace` arm, so
the member fell through to `emitProtoMemberBodyRefusal`. The referent this
needed, `string-proto-split.ts` (#4220), now exists in the merged base.

**Fix.** `src/codegen/string-proto-replace-transfer.ts` (new), following
`string-proto-split.ts` step for step. §22.1.3.19 step 11 reuses
`__regex_get_substitution` (#1913) rather than concatenating literally — the
STRING-search path calls the same GetSubstitution the RegExp path does, so
`$$`/`$&`/`` $` ``/`$'` are live. Group 0 is the whole match, so caps is
`[position, position + searchLength]` and `nGroups` is 1.

Still refused (both pre-existing — the member threw outright before): a
CALLABLE `replaceValue` (a leaf native cannot marshal a dynamic call back out)
and a RegExp `searchValue` (the engine compiles patterns at COMPILE time from a
static literal; a reflective closure gets a runtime `externref`). Same shape as
the RegExp-separator gap `split` records.

### Measured — +2, 0 regressions

A/B on `built-ins/String/prototype/replace` (55 files), both arms sequential on
this tree: **40 → 42 pass**. `S15.5.4.11_A1_T1` and `tostring-this-throws-symbol`.
`_T2` did NOT flip and the reason was not chased.

The vitest cases compile as **JS** (`allowJs`), following
`es5-standalone-split.test.ts`: the transferred-method idiom has no TypeScript
spelling, and the TS-typed spellings route to a different (already-native)
lowering. This is not a stylistic choice — the TS-lane probe of the identical
source reads `null`, so a TS-lane test here would pass vacuously.

## Acceptance criteria

- [ ] `new Object(<string|number|boolean>).constructor` is the matching builtin,
      through a bound `var`, with cross checks so the identity cannot be a
      tautology.
- [ ] `({}).constructor === Object` and `[1].constructor === Array` — #3133's
      fold — are unaffected.
- [ ] A reassigned binding (`var o = new Object(5); o = {};`) keeps the fold.
- [ ] `Object(null).constructor === Object`; a `new F()` instance still reads
      `F.prototype.constructor`, and an own `constructor` still shadows.
- [ ] `new String("hello world")[-1]`, `[11]`, `[NaN]`, `[Infinity]` are
      `undefined`; `[0]` is still `"h"`; the same for a primitive receiver.
- [ ] `new String("globglob").hasOwnProperty("length" | "0" | 7)` is true and
      `hasOwnProperty("8")` is false.
- [ ] gc/host lane untouched (standalone-gated at every site).

## 5 — regression caught on the wave-3 integration branch, and its fix

Section 2's `__plain_ctor_Object` carrier answers from
`emitBuiltinNamespaceObject`, which materializes the `Object` namespace
object's **complete function-valued own surface** — every `Object.keys` /
`defineProperty` / … as a closure. Materializing closures arms the JS-host
method-closure bridge, whose five compiler-reserved
`__\0js2_call_fn_method_argc_<n>` exports then appear in the module.

I hung that mint off the EXISTING `wrapperCtorCarrierDemanded` flag, which is
`moduleReadsConstructorProp`. So the whole `Object` static surface went into
**every** standalone module that reads `.constructor` anywhere — including
modules that only ever read a primitive wrapper's, which the three
`__builtin_ctor_<Name>` carriers answer and which never reach the plain arm at
all. That is exactly the unconditional pull-in #4034 stands as the reminder
against.

It surfaced as 5/13 failures in #4223's own suite. Worth naming precisely,
because the failure text points away from the cause: every asserted VALUE was
correct and only the key COUNT differed (`{numOk:1,strOk:1,boolOk:1, (8)}` vs
`(3)`), because that suite's `runStandalone` sweeps `Object.entries(exports)`
and asserts an exact object. It read like a wrapper-carrier semantic
regression; it was a cost regression plus an over-broad test sweep.

Two fixes, because there were two defects:

- **`plainCtorCarrierDemanded`** — a second, narrower gate
  (`moduleMentionsObjectIdentifier`) for the plain-`Object` carrier alone. This
  is a genuine heuristic, unlike the exact gate above it: a module that reads
  `.constructor` on a bare `$Object` while never mentioning `Object` keeps
  today's `undefined`. Every test262 file the arm exists for builds its
  receiver with `Object(null)` / `new Object(null)`, so all six still flip.
- **#4223's `runStandalone` skips `\0`-containing exports.** The NUL in
  `__\0js2_call_fn_method_argc_<n>` is deliberate — `closure-exports.ts` uses
  it so the name cannot collide with a source-level identifier — so an
  exact-shape sweep must exclude it. Otherwise the assertion silently doubles
  as a "did anything arm the host bridge?" check and breaks on cost, not
  semantics. My three suites already filtered.

**Verified**: no host import leaks in any case (`imports: (none)` throughout —
the `env::Object_set_constructor` leak reported alongside this is a different
change's). #4223 13/13, my three suites + #4230's descriptor-bags + #4220's
split 34/34, `built-ins/Object/S15.2*` still 43/50 (the full +18 intact).

## Leftovers (deliberately NOT in scope)

- `S15.5.4.11_A1_T2` — the second reflective-`replace` file. Section 4 flipped
  `_T1` but not this one; not chased.
- A CALLABLE replacer / a RegExp search value through the reflective `replace`
  closure (section 4's two named refusals).
- `(x as any).length` / `(x as any)[0]` on a String WRAPPER through an
  `any`-typed receiver still miss (`__extern_get` has no wrapper arm for
  `length` or indices — only `hasOwnProperty` gained one here). Separate
  surface, separate native.
- `S15.5.5_A2_T{1,2}` (`new (new String(""))` must throw TypeError),
  `S15.5.2.1_A1_T{9,10,11,19}` (`new String(<object>)` ToPrimitive) — different
  mechanisms in the same directory.
