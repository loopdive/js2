---
id: 2984
title: "Standalone gOPD-on-builtin descriptor MOP (~178: getOwnPropertyDescriptor on builtin objects / proto receivers)"
status: done
completed: 2026-07-24
updated: 2026-07-30
assignee: ttraenkler/dev-opus5-mop
sprint: 77
priority: high
horizon: xl
feasibility: hard
model: fable
fable_role: spec
area: codegen, runtime
goal: standalone-mode
related: [2965, 2861, 2863, 2896, 2949, 2989]
origin: "#2965 descriptor-cluster triage — follow-up class 1"
loc-budget-allow:
  - src/codegen/expressions/calls.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-descriptors.ts
---

# #2984 — standalone gOPD-on-builtin descriptor MOP

> **RESIDUAL — `status: done` here closes the ISSUE FILE, not the work.** This
> is an `horizon: xl` issue and eight slices have landed against it. The
> 2026-07-24 re-measurement (below) shows the newly-identified RUNTIME axis
> still has, under `test/built-ins/` alone, **199 native-proto + 62 namespace +
> 48 global-`this` + 27 TypedArray-ctor** `hasOwnProperty`-miss rows open, plus
> the `__extern_set` non-writable-store gap that gates the `{writable:true}`
> families. **A successor issue must be filed** for that axis — do not read
> this `done` as "the standalone descriptor MOP is finished". See "The next
> slice on this axis" at the end of the top section.

## Slice "ctor-carrier own props" LANDED (2026-07-24, dev-opus5-mop) — the runtime (any-param receiver) axis

> PR branch: `issue-2984-ctor-carrier-own-props`. Base = `origin/main` @
> `bb5b414a05b6d0`. Standalone baseline JSONL = the 2026-07-24 13:38 promote
> (oracle_version 10, lane `honest`, 48,088 rows).

### Re-measurement — the issue's own narrative was pointing at the wrong axis

The "## Measured current-main state (2026-07-03, sr-gopd)" section below is
marked STALE and it is: **every landed slice so far fixes the SYNTACTIC axis**
(a gOPD call site whose receiver expression the compiler can resolve at
compile time). But the dominant remaining test262 cluster does not go through
that axis at all.

Census over the fresh standalone baseline (measured, denominators given):

- `Test262Error: obj should have an own property <k>` ("a1") — **1,938 rows**
  total; **673** under `test/built-ins/`, **1,246** under `test/language/`
  (the language ones are the ambiguous ceiling — `verifyProperty` is only the
  assert harness there; do NOT bank them on this issue).
- The companion "a2" bucket (`descriptor should (not) be writable/…`) is
  **0 rows** — because a1 throws first, so the attribute asserts are never
  reached.
- 4,735 test262 files call `verifyProperty()`; only **1,190 pass** standalone
  (25 %).

`propertyHelper.js:63` is `assert(__hasOwnProperty(obj, name), "obj should have
an own property " + nameStr)`, i.e. a1 is a **`hasOwnProperty` miss, not a gOPD
miss**, and `obj` is the harness's own **untyped parameter**.

### Root cause (probe-measured on main @ bb5b414a05b6d0, real `runTest262File`)

Routing the receiver through `function ho(a,b){return
Object.prototype.hasOwnProperty.call(a,b);}` — the exact shape `verifyProperty`
has — splits cleanly:

| receiver kind                                                     | `ho(X,k)` | why                                       |
| ----------------------------------------------------------------- | --------- | ----------------------------------------- |
| native METHOD/STATIC closure (`Math.abs`, `Array.prototype.flat`) | **true**  | #2896 `__builtinfn_*` reflective natives  |
| builtin CTOR (`WeakMap`, `Map`, `RangeError`)                     | false     | #3006/#2907 carrier is an EMPTY `$Object` |
| native proto (`Date.prototype`, `String.prototype`)               | false     | `$NativeProto`, not `$Object`             |
| builtin namespace (`Math`, `Reflect`)                             | false     | carrier is an empty `$Object`             |
| plain object literal                                              | false     | lowers to a typed struct                  |

Same split for `Object.getOwnPropertyDescriptor` through an any-param. The
DIRECT (syntactic) forms of the same expressions answer correctly — that is
exactly the Phase-2/3 work, and exactly why it never reached `prop-desc.js`.

Crucially, the `$Object` runtime **already honours per-property attributes** on
every dynamic path. Witness measured on main with
`Object.defineProperty(Math,"zz",{value:1,writable:false,enumerable:false,
configurable:true})`: runtime `hasOwnProperty` true, runtime gOPD returns the
full correct triple, `for-in` skips it, and `verifyProperty` passes end-to-end
for both `configurable:true` and `configurable:false`. So the ctor carriers
were simply **empty** — nothing about the MOP itself was missing.

### Fix

New subsystem module `src/codegen/builtin-ctor-own-props.ts` —
`pushBuiltinCtorOwnPropSeed(ctx, fctx, builtinName, objLocal)` installs, at
carrier materialization time and via the existing native
`__defineProperty_value`:

- `length` §20.2.4.1 `{w:F,e:F,c:T}`, value = `BUILTIN_CTOR_ARITY[name]`
- `name` §20.2.4.2 `{w:F,e:F,c:T}`, value = the ctor name string
- `prototype` `{w:F,e:F,c:F}`, value = the `$NativeProto` from
  `emitLazyNativeProtoGet` — i.e. the SAME object the syntactic
  `<Ctor>.prototype` read yields, so `desc.value === X.prototype` holds

Two thin call sites in `builtin-static-globals.ts`:
`emitBuiltinConstructorIdentity` (#3006: Set/Map/WeakMap/WeakSet/WeakRef/RegExp/
FinalizationRegistry/DisposableStack/AsyncDisposableStack/SuppressedError) —
restructured to the proven initBody + local + `ctx.liveBodies` swap pattern so
the `__box_number` late import is shift-safe — and `emitBuiltinNamespaceObject`
(#2907: the Error family, `Array`, `Object`). The seed **no-ops for true
namespaces** (`Math`/`JSON`/`Reflect` are not in `BUILTIN_CTOR_ARITY` and own
none of the three). Pattern mirrors `emitGeneratorPrototypeSingleton`
(#3236 S1). `ctx.standalone`-gated; strictly additive (the carriers had ZERO
own properties before, and all three are non-enumerable so `Object.keys` /
for-in are unchanged).

Ctors with no `$NativeProto` brand (`AggregateError`) keep only
`length`/`name`; `AggregateError`'s arity lives in a LOCAL supplement rather
than widening the shared `BUILTIN_CTOR_ARITY` (that table also drives the
compile-time `.length` / gOPD folds, which are outside this slice's measured
set).

### Measured (real runner, standalone lane, base = origin/main @ bb5b414a05b6d0)

| Sweep                                                                          | before     | after       | Δ                      |
| ------------------------------------------------------------------------------ | ---------- | ----------- | ---------------------- |
| the 50 a1 rows with a seedable-ctor receiver and key ∈ {name,length,prototype} | **0 / 50** | **49 / 50** | **+49, 0 regressions** |

The one hold-out is `AggregateError/prototype/prop-desc.js`, which fails BEFORE
`verifyProperty` on `assert.sameValue(typeof AggregateError.prototype,
'object')` — unrelated, pre-existing.

**Regression sweep — 2,137 files** (the touched ctor dirs + the MOP-sensitive
`Object/{getOwnPropertyNames,getOwnPropertyDescriptor{,s},keys,freeze,seal,
prototype}` dirs), diffed **local-vs-local**, i.e. the SAME runner in the SAME
process shape with the seed force-disabled behind a temporary env switch vs
enabled:

- **0 regressions** (pass → non-pass)
- **0 changed error signatures** on fail→fail rows — so the #3439 hard-0
  unclassified-root-causes gate has nothing new to park on
- **+50 improvements**, of which 46 are in the target set and **all 4 outside it
  are directly attributable to the seeded `prototype`**:
  `Error/prototype/S15.11.3.1_A{1,2,4}_T1.js` (`Error.hasOwnProperty('prototype')`
  / `delete Error.prototype === false`) and `Object/prototype/S15.2.3.1_A3.js`
  (`delete Object.prototype === false`).

> **Do NOT diff a local sweep against the committed standalone baseline JSONL.**
> I tried that first and got a plausible-looking "0 regressions / +118
> improvements" — it is **contaminated**. The baseline comes from the sharded CI
> worker (`scripts/test262-worker.mjs`); a local in-process `runTest262File` run
> differs on things unrelated to any code change (the `L:N ` error-prefix, and a
> large `standalone target emitted host imports: env::X` (#2961) population that
> does not reproduce locally). 611 rows showed a changed signature purely from
> that. Local-vs-local with the change force-disabled is the only sound control.

`prove-emit-identity`: **IDENTICAL** — all 60 (file,target) emits across
gc/standalone/wasi/linear match the pre-change baseline.

`tests/issue-2984-ctor-carrier-own-props.test.ts` 11/11, asserting each
attribute and value **independently** (numeric `length`, object-identity
`prototype`) rather than trusting a test262 verdict — see the honesty note.
Related suites: 2984 ×6 + 3006 + 2896 = 85/85; #1888 guardrails 23/23;
`check:loc-budget` OK; `check:oracle-ratchet` +0/+0.

### HONESTY NOTE — how much of the +49 is earned (read this before citing it)

A deliberately-wrong-expectation control set (`.tmp/ctrl`, A/B'd with the seed
force-disabled) shows **`verifyProperty` is VACUOUS past its a1 gate on the
standalone lane, on main, today**:

| control                                                                      | seed OFF | seed ON  | expected |
| ---------------------------------------------------------------------------- | -------- | -------- | -------- |
| `verifyProperty(WeakMap,"length",{value:0,…})`                               | fail     | pass     | pass ✓   |
| `verifyProperty(WeakMap,"length",{value:12345,…})`                           | fail     | **pass** | fail ✗   |
| `…{value:0,writable:TRUE,…}` (wrong attr)                                    | fail     | **pass** | fail ✗   |
| `verifyProperty(WeakMap,"absentKey",…)`                                      | fail     | fail     | fail ✓   |
| `verifyProperty(Math.abs,"name",{…writable:TRUE})` — an UNTOUCHED #2896 path | **pass** | **pass** | fail ✗   |

The last row is the control that matters: the vacuity reproduces with the seed
disabled, on a path this slice does not touch, so it is **pre-existing and
independent of this change**. Mechanism: `verifyProperty` accumulates into
`failures` via `__push`/`__join` — `Function.prototype.call.bind(Array.prototype.
push|join)` — the **uncurryThis** family; those aliases misbehave standalone, so
`failures.length` stays 0 and the final `assert(false, …)` never fires. Only the
a1 assert (a plain `assert(cond, msg)`) is live.

So the honest split of this slice is:

- **REAL and independently verified** — builtin-ctor carriers now own
  spec-correct, correctly-attributed `length` / `name` / `prototype`, readable
  through the runtime MOP. Verified by direct `===` reads in the vitest suite,
  not by the harness.
- **HARNESS-CREDITED** — the 49 test262 flips are earned only at the a1 gate.
  Their attribute assertions are vacuous for a reason outside this slice. Cite
  this as "+49 rows, a1-gate-earned", not "+49 conforming descriptors".

### Two verdict-oracle holes found while measuring (NOT fixed here — file separately)

Both inflate the standalone floor and both reproduce on main:

1. A test whose ONLY statement is `throw new Test262Error("HELLO")` reports
   **pass** in the standalone lane — a top-level `throw` statement is silently
   dropped. (`assert.sameValue(1,2)` correctly fails, so it is specific to a
   bare top-level `throw`.)
2. `assert.sameValue(<dynamic string>, <literal string>)` false-positives:
   `assert.sameValue("" + true, "SHOWME")` **passes**. Any test whose only
   discrimination is a string `sameValue` can pass vacuously.
3. (Related, this issue's own family) the `verifyProperty` `__push`/`__join`
   vacuity above — the uncurryThis half of the PH wall.

### Known gap left behind (pinned by a test, pre-existing)

A dynamic `o[k] = v` store bypasses the `$PropEntry` non-writable flag
(`__extern_set` does not consult flags), so a runtime write to a seeded
`writable:false` property lands even though the descriptor correctly reports
`writable:false`. Reproduces for ANY `Object.defineProperty`-defined
non-writable property, not just these carriers. Pinned in the test suite as a
KNOWN GAP so a future store-path fix is noticed.

### The next slice on this axis (measured, in priority order)

Remaining a1 rows under `built-ins/`, by receiver kind:
**native-proto 199** (`Array.prototype` 41, `TypedArrayPrototype` 25,
`String.prototype` 16, `Iterator.prototype` 11, `RegExp.prototype` 9 …),
**namespace 62** (`Math` 45, `Reflect` 13, `JSON` 4), **global (`this`) 48**,
TypedArray ctors 27 (no `$Object` carrier at all — `typeof id(Uint16Array) !==
"object"`, so they need a carrier first). Note the namespace/proto rows mostly
carry `{writable:true, …}` descriptors, so flipping them for the RIGHT reason
additionally needs a working write path — i.e. the `__extern_set` flag gap
above is a prerequisite there, unlike for the `{writable:false}` ctor triple.

## Slice "@@species key" LANDED (2026-07-11, fable-sub1) — builtin receiver + non-literal key

> PR: `issue-2984-gopd-builtin-key-dispatch`. Takes the "builtin receiver +
> non-literal key (the `__get_builtin` CE family)" residual of bucket 1. The
> suite-wide `__get_builtin` non-pass cluster is 565; the gOPD-at-flagged-line
> subset is only **38**, decomposing (measured 2026-07-11 off the standalone
> baseline JSONL + flagged-source-line classification): **26 × `gOPD(<Ctor>,
Symbol.species)`** (the dominant non-literal-key shape) + 12 × RegExp annex-B
> legacy accessors (open universe — deliberately refused). The remaining ~527
> are NOT gOPD — they are direct unimplemented static-method calls
> (`Atomics.*` 213, `Iterator.zip/zipKeyed/concat/from` ~99, `String.raw` 22,
> `BigInt.asIntN/asUintN` 20, `Map.groupBy` 12, …), i.e. separate
> builtin-surface work, not descriptor MOP.

### Root cause

Both compile-time synthesis gates (Phase-3 builtin-static + the #2874 struct
key dispatch) require a LITERAL key. `Symbol.species` is a
PropertyAccessExpression, so `gOPD(Array, Symbol.species)` fell through to the
dynamic fallback, which routes a builtin-identifier receiver through
`__get_builtin` → hard CE standalone (#1472 Phase B).

### Fix (PR: `issue-2984-gopd-builtin-key-dispatch`)

- `isSymbolSpeciesKeyExpression` (builtin-static-gopd.ts): syntactic
  recognizer for the unshadowed `Symbol.species` key (unwraps parens/`as`/`!`).
- `tryEmitStandaloneBuiltinSpeciesGopd` (builtin-static-gopd.ts): for the
  @@species-owner ctors (Array/ArrayBuffer/SharedArrayBuffer/Map/Set/Promise/
  RegExp — the complete spec set; concrete TypedArray ctors INHERIT, don't
  own) emits `__create_accessor_descriptor(get, undefined, {e:false,c:true})`.
  Non-owners / other symbol keys keep the loud refusal (strictly additive:
  every intercepted shape CE'd).
- `ensureStandaloneSpeciesGetterClosure` (property-access.ts): per-ctor
  `get [Symbol.species]` closure — body is spec step 1 ("Return the this
  value", param 1), meta subtype `species:<Ctor>` (name
  `"get [Symbol.species]"`, length 0 per §10.2.9) so the reflective
  `__builtinfn_*` natives answer propertyHelper's runtime
  `verifyProperty(desc.get, "name"|"length")` reads; identity-stable via the
  #2175 V2-S2 singleton; registered in
  `nativeProtoReceiverClosureStructTypes` (meta type ONLY — the shared
  signature-wrapper base is untouched) so a statically-resolvable
  `g.call(thisVal)` threads the receiver.
- Thin gate in calls.ts after the Phase-3 arm (`ctx.standalone && propLiteral
=== undefined && isSymbolSpeciesKeyExpression`), receiver via the bucket-1
  alias resolver. Host/gc byte-inert.

### Measured (real runner, standalone lane, base = origin/main @ 026f40f771 merged)

| Sweep                                                 | before        | after              | Δ                           |
| ----------------------------------------------------- | ------------- | ------------------ | --------------------------- |
| `built-ins/*/Symbol.species/*` (29)                   | 0 / 5 / 24 CE | **18 / 11 / 0 CE** | **+18 pass, 0 regressions** |
| `built-ins/Object/getOwnPropertyDescriptor{,s}` (328) | 281 / 47 / 0  | **281 / 47 / 0**   | unchanged (0 regressions)   |

- `prove-emit-identity`: **IDENTICAL** — all 39 (file,target) emits match the
  main-state baseline (host/gc/wasi inert; corpus has no species gOPD).
- `tests/issue-2984-species.test.ts` 9/9 (accessor shape, identity stability,
  per-ctor distinctness, getter name/length meta, reflective gOPD-on-getter,
  alias receiver, non-owner refusal GUARD, shadowed-Symbol GUARD, host-lane
  compile).
- Still failing in the species dirs (NOT this slice): `return-value.js` ×6 —
  `gOPD(...).get.call(thisVal)` invokes a descriptor-extracted closure value
  (the #2949 first-class-closure `.call` substrate gap; the getter itself
  returns `this` correctly when the closure resolves statically);
  `TypedArray/Symbol.species/*` ×4 — receiver is the harness's
  `Object.getPrototypeOf(Int8Array)` var, which the conservative alias
  resolver declines; `Promise/symbol-species.js` — propertyHelper
  verify-chain trips an unrelated null-access.
- loc-budget: +20 in calls.ts (the thin gate) covered by the
  `loc-budget-allow` frontmatter above (#3131); the synthesis lives in the
  subsystem module.

## Slice "primitive-string(s) + ToObject" LANDED (authored 2026-07-10 fable-16th; recovered from stranded local commit + landed 2026-07-16, fable-2984-resume) — non-$Object receiver arm in the gOPD native

> PR: `issue-2984-gopd-toobject-receiver`. Takes the **primitive-string(s) +
> 15.2.3.3-1-{1,2}** residuals. (Originally written on the
> `issue-2984-gopd-key-dispatch` branch but never pushed — the commit was
> stranded local-only when that PR merged; cherry-picked forward 6 days.)

### Root cause + fix

The `__getOwnPropertyDescriptor` native (object-runtime.ts) early-outs
`undefined` for EVERY non-`$Object` receiver. §19.1.2.8 ToObject semantics:
undefined/null must THROW TypeError, and a primitive STRING owns §10.4.3
String-exotic index/length properties. New `primitiveReceiverArm` replaces the
early-out — nullish → catchable TypeError (`__new_TypeError` + exn tag),
`$AnyString` receiver → the SAME exotic descriptor synthesis as the #2987
wrapper arm with [[StringData]] = the receiver (plus a `__to_property_key`
pass so `gOPD('foo', 0)` works), any other primitive → `undefined` (unchanged).
Gated exactly like `strExotic` (`ctx.standalone && ctx.nativeStrings`) — gc /
wasi registrations byte-identical (`prove-emit-identity`: only the 4
standalone-lane corpus entries drift, gc/wasi all match).

**Recovery port (2026-07-16, fable-2):** the original commit targeted the gOPD
builder inline in `object-runtime.ts`; the #3274 WAVE-B refactor extracted that
builder to `object-runtime-descriptors.ts`, so the arm was ported there across
the merge. Two singleton-regime adaptations (#2106/#3316 landed after the
original base): (1) the arm's own miss returns use the `$undefined` singleton
(`undefExternGopd`) — a bare `ref.null.extern` no longer observes as
`undefined`; (2) the ToObject-throw receiver test is `ref.is_null` OR tag-1
`$AnyValue` singleton, since an `undefined` receiver now arrives non-null.
Scoped to THIS arm only — the pre-existing wrapper/ordinary miss arms'
undef-observability is the sibling gOPD-undef-observability slice (fable-1).

### Measured (real runner, standalone lane)

gOPD dirs 281 → **284 pass** (+3: 15.2.3.3-1-1, -1-2, primitive-string), 0 CE,
0 regressions. Reflect/getOwnPropertyDescriptor 10/3 — the 3 fails are the
PRE-existing "called on non-object" struct-receiver rejection (object-ops.ts),
untouched. `tests/issue-2984-primitive-string.test.ts` 8/8; all 2984 suites
51/51.

### Residual notes for the next owner (ground-checked 2026-07-10)

- **`gOPDs` (plural) nullish/string receivers** don't flip: the plural driver
  iterates `__getOwnPropertyNames(obj)` and never consults the singular's
  receiver coercion — `exception-not-object-coercible` / `primitive-strings`
  need the same ToObject arm (throw + string-exotic names) in the PLURAL
  driver + `__getOwnPropertyNames`.
- **`gOPD(<Builtin>.prototype, "constructor")` (~11 tests) is BLOCKED on
  #2963**: `Date.prototype.constructor` reads back `undefined` and `Date` has
  NO runtime value standalone (null externref + compile-time facades for
  `typeof`/`===`), so the required `desc.value === X.prototype.constructor`
  identity cannot hold until builtin ctors are reified as first-class values.
- **Global receivers** (`var global = this; gOPD(global, "eval")`, -4-4..-11)
  need a reified global object whose function props have stable values — same
  #2963 family.
- **`gOPD(<BuiltinIdent>, <dynamic key>)` still CEs** (`__get_builtin`
  refusal) but is only ~26 test files, dominated by `Symbol.species` keys
  (well-known-symbol accessors — the closed-universe policy refuses those
  deliberately). Low yield until the species accessor model exists.
  _(Superseded 2026-07-11: the "@@species key" slice above landed exactly
  that accessor model — the residual is now only the RegExp annex-B legacy
  accessors, deliberately refused.)_
- **`verifyProperty(builtin, name)`-through-a-parameter** answers `undefined`
  silently (receiver is a PARAM, so no syntactic synthesis applies) — runtime
  dispatch needs runtime-identifiable builtin receivers (#2963 again).

## Slice "arg-2 name coercion" LANDED (2026-07-10, fable-16th) — struct-receiver runtime key dispatch

> PR: `issue-2984-gopd-key-dispatch` (stacked on `issue-2984-gopd-runtime-dispatch`
> / PR #2865). Takes the **15.2.3.3-2-\*** bucket ("arg-2 name coercion",
> 17/47 failing) of "Still remaining after Phase 3".

### Root cause (measured, probe-pinned)

A plain object literal lowers to a TYPED STRUCT, not a runtime `$Object`. The
gOPD call site (calls.ts) answers struct receivers only through the
LITERAL-key fast path (`structName && propLiteral !== undefined`); ANY
non-literal key — `gOPD(obj, NaN)`, `gOPD(obj, k)`, `gOPD(obj, {toString})`,
even a plain STRING variable — fell through to the dynamic
`__getOwnPropertyDescriptor` native, which only walks `$Object`s, so a struct
receiver always answered `undefined`. The key coercion itself was NOT the gap:
`__to_property_key` (#2042 S1 / #2985) already canonicalises every non-Symbol
key (boxed number → `number_toString`, object → `__extern_toString`).

### Fix

New `tryEmitStandaloneStructGopdKeyDispatch` (builtin-static-gopd.ts), called
from a thin gate in the calls.ts gOPD handler (`ctx.standalone && structName
&& propLiteral === undefined`): compile receiver+key, run the key through
`__to_property_key`, string-match it against the struct's compile-time field
names (`__str_equals` chain) and synthesize per-field the SAME descriptor the
literal fast path emits (struct.get + box + shapePropFlags/#1629b
definedPropertyFlags → `__create_descriptor`). **Strictly additive**: class
receivers and sidecar-defined keys bail to the dynamic path (gate), and both
runtime misses (non-string post-ToPropertyKey key; runtime value not the
checker-typed struct) fall through to the dynamic native with the ORIGINAL
key — every previously-answered shape keeps its exact answer.

### Measured (real runner, standalone lane, base = PR #2865 tree)

| Sweep                                           | before      | after          | Δ                      |
| ----------------------------------------------- | ----------- | -------------- | ---------------------- |
| `getOwnPropertyDescriptor/15.2.3.3-2-*` (47)    | 30 / 17 / 0 | **41 / 6 / 0** | **+11, 0 regressions** |
| `built-ins/Object/getOwnPropertyDescriptor{,s}` | —           | 281 / 47 / 0   | 0 CE                   |

- `prove-emit-identity`: **IDENTICAL** — all 39 (file,target) emits across
  gc/standalone/wasi match the predecessor baseline.
- `tests/issue-2984-key-dispatch.test.ts` 9/9 (NaN/Infinity/var/object-toString
  keys, full attribute triple, absent key, literal fast-path GUARD, sidecar
  GUARD); prior suites (2984/phase3/alias-receivers) 34/34.
- Still failing in the dir (NOT this slice): `-3`/`-4` (undefined/null keys —
  blocked on the #2106 undefined-singleton regime; `String(undefined)` cannot
  yield `"undefined"` under the legacy no-singleton lowering), `-38/-40/-41`
  (ARRAY keys — the any-lane array ToString residual: `String([1])` ≠ `"1"`
  when the array flows through the boxed-any rep), `-47` (proto-INHERITED
  `toString` on the key object — `__to_primitive`'s method lookup misses
  inherited methods).
- loc-budget: dispatch lives in the subsystem module; the +17 thin gate in
  calls.ts is covered by the `loc-budget-allow` frontmatter above (#3131).

## Bucket-1 slice LANDED (2026-07-10, fable-6th) — alias (obj-VAR) gOPD receivers

> PR: `issue-2984-gopd-runtime-dispatch`. Takes the "obj-VAR receivers"
> entry of "Still remaining after Phase 3" bucket 1 — `var m = Math;
gOPD(m, "atan2")`, the dominant 15.2.3.3-4-\* fixture shape, which fell to
> the dynamic `__getOwnPropertyDescriptor` path and silently answered
> `undefined` standalone (probe-verified on main @ 4ac4b6e01a).

- `resolveBuiltinReceiverName` (builtin-static-gopd.ts): conservative,
  AST-only reaching-def alias resolution — accepts an alias only when
  exactly ONE declaration binds the name in the enclosing scope tree, its
  initializer unwraps to an unshadowed builtin identifier, and nothing
  writes/re-binds the name (params, catch, imports, `=`/compound/`++ --`
  all decline). Declining keeps today's path bit-for-bit.
- Wired at the calls.ts gOPD synthesis gate (replaces the bare-identifier
  test; direct receivers resolve exactly as Phase 3 did).
- `prove-emit-identity`: **IDENTICAL** (all 39 file,target emits vs main).
  Tests: `tests/issue-2984-alias-receivers.test.ts` 7/7 (aliases, value
  identity, absent-key, reassignment/shadow/non-builtin guards); phase-3
  suite 11/11.
- Still open in bucket 1 after this slice: arg-2 NAME COERCION (non-literal
  keys — the `__get_builtin` CE family), global-object receivers
  (`this`/`window`), gOPDs-plural residuals, `primitive-string(s)`.

## Phase 3 LANDED (2026-07-10, fable-2984c) — ctor/namespace-receiver static-property descriptor synthesis

> PR: `issue-2984-gopd-ctor-receivers`. Takes the **72 CE ctor/namespace
> receivers** bucket (bucket 1 of "Still remaining after Phase 2" below) —
> `gOPD(Math, "atan2")`, `gOPD(Date, "prototype")`, `gOPD(Number,
"MAX_VALUE")`, `gOPD(String, "length")`, `gOPD(JSON, "stringify")`.

### Root cause (re-measured on main @ d7a1feaa1cf, 72 CE confirmed intact)

Two refusals compound: (1) a builtin ctor/namespace IDENTIFIER as a gOPD
receiver routes through the `__get_builtin` shortcut in the calls.ts dynamic
fallback, which refuses-loud standalone (#1472 Phase B); (2) even with (1)
fixed, the dominant assertion `desc.value === Math.atan2` needs the plain
static VALUE READ, which hard-refused too (#1907 "built-in static property
value read is not supported") — the closure factory
`ensureStandaloneBuiltinStaticMethodClosure` knew only ~8 hand-written
statics.

### Fix (two pieces, both `ctx.standalone`-gated)

1. **Generic static-closure reification** (property-access.ts): the factory's
   `default:` arm now mints an identity-stable closure for ANY
   `BUILTIN_STATIC_METHOD_ARITY` member with an `emitThrowTypeError` body
   (the #2193/#2651/Phase-2 degrade-to-catchable pattern) + spec meta from
   the arity table (`static:<key>` meta subtype → per-(builtin, method)
   singleton). Hand-written statics keep their exact wired bodies/meta
   (byte-identical). Every shape reaching the arm CE'd before, so nothing
   passing changes. Invoking the extracted value currently traps through the
   direct-call plumbing — pre-existing (`var f = Object.keys; f(o)`
   null-derefs on main); the corpus never invokes.
2. **New subsystem module `src/codegen/builtin-static-gopd.ts`** —
   `tryEmitStandaloneBuiltinStaticGopd`, called from a new synthesis site in
   the calls.ts gOPD handler (after Site-2, before the `__get_builtin`
   fallback; gate = standalone + unshadowed `BUILTIN_CLASS_NAMES` identifier
   - literal key). Classification: static method → `{w:true,e:false,c:true}`
   - singleton `.value` (same value the plain read yields — identity holds);
     Math/Number constants + `<TypedArray>.BYTES_PER_ELEMENT` → all-false
     value descriptors; `prototype` (ctors only; Proxy §28.2 and the
     namespaces own none) → all-false + `$NativeProto` value via
     `emitLazyNativeProtoGet`; `length`/`name` → `{w:false,e:false,c:true}`;
     unknown string keys on CLOSED-universe receivers → `undefined`
     (`gOPD(Math,"caller")`). **Symbol + RegExp unknown members keep the loud
     refusal** (open universes: well-known-symbol own props / annex-B legacy
     statics — refuse-loud > silent-wrong).

### Measured (real runner, standalone lane, base = main @ d7a1feaa1cf)

| Sweep                                                                                       | main                       | branch               | Δ                      |
| ------------------------------------------------------------------------------------------- | -------------------------- | -------------------- | ---------------------- |
| `built-ins/Object/getOwnPropertyDescriptor{,s}` (328)                                       | 199 pass / 57 fail / 72 CE | **270 / 58 / 0**     | **+71, 0 regressions** |
| collateral (defineProperty + gOPN + Boolean + Function + Error + **Math** + **JSON**, 2286) | 1122 / 1063 / 101 CE       | **1165 / 1068 / 53** | **+43, 0 regressions** |

- Every flip is CE→pass or CE→fail (the 1 gOPD-dirs CE→fail is
  `gOPDs/tamper-with-global-object.js`, global-tampering shape, out of scope).
  The +43 collateral flips are dominated by `not-a-constructor.js` (the value
  read now compiles → `isConstructor(Math.abs)` runs) — expect more radiating
  flips suite-wide in CI (other dirs' not-a-constructor / verifyProperty
  clusters).
- `prove-emit-identity`: **IDENTICAL** — all 39 (file,target) emits across
  gc/standalone/wasi match the main baseline.
- `tests/issue-2984-phase3.test.ts` 11/11 (identity, constants, prototype,
  length, absent→undefined, Symbol/RegExp refusal GUARD); related suites
  (2984/2651/2861/2875/2876/2885/2896/2933/2963/2965 +
  array-prototype-methods) 204/204 after updating the #2933 scope-boundary
  guard (it pinned "Math.max value read still refuses" — exactly the refusal
  this phase retires by design).
- loc-budget: synthesis extracted to the new module; residual +23 (calls.ts)
  / +36 (property-access.ts) reseeded via the sanctioned `--update` (a
  `loc-budget-allow` frontmatter mechanism does not exist in the shipped
  gate).
- Known pre-existing quirks measured on MAIN (not regressions, documented in
  tests): desc-vs-desc `.value` identity across two separate gOPD calls fails
  (also fails for Phase-2 proto members on main — $Object store/read
  round-trip); ternary-string→console.log emits invalid Wasm on main
  (validation error, tripped a probe, unrelated).

### Still remaining after Phase 3 (the next slices)

1. **gOPD-dirs residual 58 fails**: `15.2.3.3-2-*` (arg-2 name coercion),
   global-object receivers (`this`/`window`), `obj`-VAR receivers (need
   runtime dispatch — the synthesis is syntactic), gOPDs-plural residuals
   (`normal-object.js`, order/observability, `tamper-with-global-object.js`),
   `primitive-string(s)`.
2. **`.value` INVOCATION** stays blocked on #2949 (pre-existing: direct-call
   of an extracted externref-signature static closure null-derefs on main —
   `var f = Object.keys; f(o)`).
3. Symbol well-known-key + RegExp legacy-static gOPD receivers (deliberately
   left refusing — need a well-known-symbol/legacy-static descriptor model).

## Phase 2 LANDED (2026-07-10, fable-2984b) — proto-receiver reification via refusal-body closures

> PR: `issue-2984-gopd-proto-receivers`. Takes the **~124 un-reified proto
> receivers** bucket (bucket 2 of "Remaining buckets" below).

### Root cause (measured, code-pinned)

The whole #2885 chain for `gOPD(<Builtin>.prototype, "<member>")` was already
in place for Date/Object/Number/Boolean/Function/Error/String — brands wired in
`tryEnsureNativeProtoBrand`, glues registered with complete member CSVs, the
Site-2 synthesis gate passing. The single blocker:
`emitProtoMemberBodyRefusal` (array-object-proto.ts) **returns `null`**, which
aborts `ensureStandaloneNativeMethodClosure` (native-proto.ts) before the
funcMap mint — so no closure exists, Site-2 falls through to the dynamic
fallback, and the descriptor is `undefined`. Array passed because
`emitArrayProtoMemberBody` returns `{kind:"externref"}` with a catchable-throw
body for un-wired members (#2193) — the exact measured split
(`gOPD(Array.prototype,"forEach")` full-shape PASS incl. identity vs `-1`
undefined-descriptor for every other family).

### Fix (three pieces)

1. **`ensureStandaloneNativeMethodClosure` gains an opt-in
   `refusalBodyFallback`** (native-proto.ts): when `emitMemberBody` refuses
   (null) AND the caller opted in AND kind is `"method"`, mint the closure
   anyway with an `emitThrowTypeError` body (the #2193/#2651
   degrade-to-catchable pattern; `emitThrowTypeError` is the proven-catchable
   helper — a first draft used `emitBrandCheckTypeError` and trapped).
   **STRICTLY opt-in**: the refusal probe runs BEFORE the funcMap cache
   lookup, so a fallback-minted closure never leaks to a non-opted-in caller.
   This is load-bearing — `emitReflectiveNativeProtoClosureCall` (the route
   behind `Object.prototype.hasOwnProperty.call(o,k)` /
   `propertyIsEnumerable.call`, which the test262 propertyHelper uses on every
   verifyProperty) RELIES on the null return to fall through to its working
   legacy lowering; opting it in would mass-regress (measured on main: those
   idioms pass TODAY via the fall-through).
2. **New subsystem module `src/codegen/native-proto-value-read.ts`** —
   `resolveStandaloneProtoMemberValueClosure`, the three-tier value-read
   policy used by `tryCompileStandaloneBuiltinProtoMemberRead`
   (property-access.ts): own-CSV member → brand closure w/ fallback;
   **inherited member** (not own, advertised by Object.prototype's glue) →
   OBJECT-brand singleton (spec: `Function.prototype.valueOf ===
Object.prototype.valueOf`, Sputnik S15.3.4_A4 — this arm fixed the one
   collateral regression the first draft caused); unknown member → null →
   dynamic fall-through (no phantom closure; also closes the latent Array
   any-name hole). gOPD Site-2 keeps own-property semantics (inherited →
   `undefined` descriptor).
3. **Site-2 (calls.ts) passes the opt-in** so the synthesized data descriptor
   carries the SAME per-(brand,member) singleton as the plain value read —
   `desc.value === Date.prototype.getTime` holds (`assert.sameValue`
   identity, the dominant ES5 15.2.3.3-4-\* shape).

### Measured (real runner, standalone lane, base = main @ 267a1d29499)

| Sweep                                                                                | main                        | branch             | Δ                      |
| ------------------------------------------------------------------------------------ | --------------------------- | ------------------ | ---------------------- |
| `built-ins/Object/getOwnPropertyDescriptor{,s}` (328)                                | 122 pass / 134 fail / 72 CE | **199 / 57 / 72**  | **+77, 0 regressions** |
| collateral (defineProperty + getOwnPropertyNames + Boolean + Function + Error, 1794) | 781 / 977 / 36              | **787 / 971 / 36** | **+6, 0 regressions**  |

- Per-file diff: every flip is fail→pass (Date.prototype 44-test cluster,
  String non-wired members, Object/Number/Boolean/Function/Error protos, plus
  Function.prototype.call/toString Sputnik tests via the inheritance arm).
- `prove-emit-identity`: **IDENTICAL** — all 39 (file,target) emits across
  gc/standalone/wasi match the main baseline (the corpus exercises no refused
  proto-member reads; non-opted-in callers keep the exact null contract).
- `tests/issue-2984.test.ts` 16/16 (incl. a hasOwnProperty.call fall-through
  GUARD test); related suites (2651/2861/2875/2876/2885/2896/2965 +
  array-prototype-methods) 117/117.
- loc-budget: policy extracted to the new module; residual +5 (calls.ts) / +1
  (property-access.ts) reseeded via the sanctioned `--update` (#3131
  change-scoped gate).

### Still remaining after Phase 2 (the next slices)

1. **~72 CE — ctor/namespace receivers** (`gOPD(String, "fromCharCode")`,
   `gOPD(Math, "max")`): the `__get_builtin` refusal — needs Site-2-style
   synthesis for builtin-CTOR receivers off a static-property descriptor
   table (unchanged, biggest remaining bucket).
2. **gOPD-dirs residual 57 fails**: `15.2.3.3-2-*` (arg-2 name coercion),
   global-object receivers (`this`/`window`), `obj`-VAR receivers (need
   runtime dispatch — Site-2 is syntactic), gOPDs-plural residuals
   (`normal-object.js`, order/observability), `primitive-string(s)`.
3. **`.value` INVOCATION** stays blocked on #2949 (pre-existing: extracted
   `Array.prototype.pop` invocation null-derefs identically on main).

## Slice 1 LANDED (2026-07-10, fable-2984) — the cluster's keystone was a boolean-typed dynamic-read bug, not the descriptor MOP

> Re-measured against `origin/main` @ `cd9f2cfbfd` through the REAL runner
> (`runTest262File`, standalone lane). Cluster state on the two directories
> `built-ins/Object/getOwnPropertyDescriptor{,s}` (328 tests): **78 pass /
> 178 fail / 72 CE**. The dominant failure was NOT a missing descriptor — it
> was that descriptor-attribute ASSERTS fail even when the descriptor is
> perfect.

### Root cause (measured, WAT-verified)

`assert.sameValue(desc.writable, true)` lowers `desc.writable` (lib type
`boolean | undefined`) through `compilePropertyAccess`'s dynamic fallback:
`__extern_get(desc, "writable")` → **`__unbox_number` + `i32.trunc_sat_f64_s`**
(a ToNumber, not a boolean read) → i32 → the any-context arg consumer re-boxes
via **`__box_number`**. The standalone native `__unbox_number` yields NaN for a
boxed boolean → i32 0 → boxed NUMBER 0 → `0 === true` fails for EVERY
attribute assertion, on every receiver (plain objects included). The host lane
only "passed" the harness shape by a double coincidence (host ToNumber(true)=1,
then a numeric compare); the local-bound shape `var w = desc.writable; typeof w`
was `"undefined"` on BOTH lanes. Three probe shapes pinned it:
inline `desc.writable === true` passed (different arm), computed-key
`desc["writable"]` passed (dynamic all the way), only the checker-typed
narrowing path broke.

### Fix (PR: `issue-2984-gopd-builtin-mop`)

`src/codegen/property-access.ts`: in the dynamic-fallback region of
`compilePropertyAccess`, a **boolean-like access type keeps the raw externref**
(no i32 narrowing through the numeric unbox pipeline). New helper
`isBooleanLikeAccessType` walks union members (`boolean | undefined` carries no
`BooleanLike` flag on the union object itself — that was the first-attempt
trap). Preserves both the boolean box (value-correct native `===`) and
`undefined` for absent attributes (the i32 path erased absent → `false`).
Numeric narrowing and the Phase-3 struct-candidate narrowing are untouched, so
modules without boolean-typed dynamic-fallback reads are byte-identical.

### Measured effect (real runner, standalone lane)

| Directory                                       | before   | after        | Δ                      |
| ----------------------------------------------- | -------- | ------------ | ---------------------- |
| `built-ins/Object/getOwnPropertyDescriptor{,s}` | 78 pass  | **119 pass** | **+41, 0 regressions** |
| `built-ins/Object/defineProperty`               | 502 pass | **534 pass** | **+32, 0 regressions** |

Host lane on the gOPD dirs: 301/328 before AND after (unchanged). The fix
radiates suite-wide: every standalone test asserting a boolean property through
a harness `assert.sameValue`/param was affected, so expect flips well beyond
these directories (propertyHelper/verifyProperty clusters).

### Remaining buckets (re-scoped 2026-07-10; the follow-up slices)

After slice 1, the two gOPD dirs still have 137 fail / 72 CE:

1. **~72 CE — ctor/namespace receivers** (`gOPD(String, "fromCharCode")`,
   `gOPD(Array, "isArray")`, `gOPD(Math, "max")`, `gOPD(Object, "keys")`):
   still the `__get_builtin` refusal from the dynamic-fallback routing in
   `calls.ts`. Needs a Site-2-style synthesis for builtin-CTOR receivers
   backed by a static-property descriptor table + first-class static-method
   closures (`ensureStandaloneBuiltinStaticMethodClosure` covers only ~8
   statics today). Biggest single remaining bucket.
2. **~124 fail — undefined descriptor for un-reified receivers**: by receiver:
   `Date.prototype` (44), `String.prototype` members not in the glue CSV (16),
   global-object receivers `this`/`global` (11), `Object.prototype` (7),
   `Number.prototype` (7), `Function.prototype` (5), `Boolean.prototype` (3),
   Error-family protos (~6), plus misc `obj`-var receivers (17). Fix =
   extend the #2885 Site-2 synthesis + `NativeProtoBuiltinGlue` member tables
   to these builtins/members. Mechanical per-family work once the closure
   refusal bodies exist (the #2193/#2651 degrade-to-catchable pattern).
3. **gOPDs (plural) residuals**: `Object.getOwnPropertyDescriptors(Array.prototype)`
   returns an object with no `forEach` entry (needs the same proto reification);
   plain-object gOPDs now passes its attribute asserts after slice 1.
4. Bucket-1 note: `gOPD(Array.prototype, "forEach")` on current main already
   returns identity-correct `.value` (`d.value === Array.prototype.forEach`
   passes — #2175 V2-S2 singletons). Only INVOKING the extracted value still
   fails (blocked on #2949 method-value reification, as documented below).

## Problem

Follow-up from #2965 (descriptor cluster). `getOwnPropertyDescriptor` on a
builtin object or a builtin **prototype/constructor** receiver has no
meta-object protocol on the standalone lane, so the dynamic
`__getOwnPropertyDescriptor` native either returns `undefined` or hard-CEs.
Subsequent `.value`/attribute reads then throw or the compile fails outright.
~178 tests across the descriptor cluster hinge on this. It is the substrate
gap that **co-blocks #2989** (dynamic-descriptor `defineProperty` spec
TypeErrors landed there, but the reachable test262 assertions that would flip
run gOPD-readback first, so #2989 measures net-0 until this lands).

This is design-only — no implementation in this issue. It is a **spec seed**
to size the work and record why the existing machinery does not extend.

## Measured current-main state (2026-07-03, sr-gopd) — the narrative below is STALE

> **Re-measured against `origin/main` @ `bc8a1d4ca` (`target: standalone`,
> instantiate with empty imports `{}`).** Current main has **advanced past**
> the "returns `undefined` / drops the accessor" narrative in the original
> buckets below (which was written against an earlier tree, pre
> #2861/#2863/#2896). The buckets are still the right decomposition, but the
> _actual remaining gap in each_ is narrower and different from what the
> original text says. **Read this section as the authoritative status; the
> three-bucket text underneath is the historical seed.** Probes: `.tmp/probe*.mjs`
> (gitignored) — reproduce with `compile(src, {target:'standalone'})` then
> `WebAssembly.instantiate(r.binary, {})`.

| Bucket                                                   | Original narrative                               | **Measured on current main**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(1) proto-receiver** `gOPD(Array.prototype,"forEach")` | returns `undefined`                              | **No longer `undefined`.** Returns a descriptor with **correct boolean attributes** (`writable:true, enumerable:false, configurable:true`) and a `.value` slot that is present but **broken**: `typeof d.value` is **codegen-path-dependent** (`"function"` when tested inline, `"object"` when bound to a `const` first — representation instability), the value is **non-invocable** (`d.value.call(arr, cb)` is a no-op / traps — `arr` unchanged), and **non-canonical** (`d.value !== Array.prototype.forEach`). Gap narrowed from "no descriptor" to "**`.value` is a non-first-class placeholder**". |
| **(2) ctor-receiver** `gOPD(Array,"isArray")`            | hard-CE `__get_builtin not yet supported`        | **UNCHANGED** — still hard-CEs with `Codegen error: '__get_builtin' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 Phase B)`. The refusal **string** is emitted by the generic refused-late-import path at `src/codegen/expressions/late-imports.ts:99`; the **routing** that reaches it (a builtin constructor used as a _dynamic_ gOPD receiver falling through to the `__get_builtin` shortcut) is in `src/codegen/property-access.ts` (the `__get_builtin` branch, see the refusal-context comments ~L192–208 / L403).                                    |
| **(3) plain-object accessor** `gOPD({get x(){…}}, "x")`  | "returns a data descriptor / drops the accessor" | **Descriptor SHAPE is now correct**: `get`/`set` present, no own `value` (`hasOwnProperty("value")` false), `hasOwnProperty("get")` true, `enumerable`/`configurable` correct. **But INVOKING the accessor from the descriptor is not host-free**: `d.get()` pulls `env::WeakMap_get`, `d.set(v)` pulls `env::WeakMap_set` → **traps at instantiate under standalone** (missing import). A get+set literal (`{get x(){}, set x(v){}}`) also drags a `WeakMap` import even for the existence check on some shapes. Gap moved from "drops accessor" to "**accessor-closure invocation is not host-free**".    |

### Shared root cause, confirmed by direct measurement

`Array.prototype.forEach` is **not a first-class invocable value** in
standalone _even outside gOPD_: binding `const fn = Array.prototype.forEach;`
gives `typeof fn === "function"` but `fn.call([1,2,3], cb)` **traps**
(`WebAssembly.Exception`). So the gOPD `.value` placeholder is not a
descriptor-path bug — it inherits the substrate fact that **builtin methods
are lowered inline-at-callsite and never materialise as callable funcref/closure
values**. This is exactly step (2) of "Rough shape of a real fix" below, and the
**D1 type-erased-value-representation** class (#2949's `dynamic` kind). No
descriptor-layer patch can fix bucket (1)/(2) without it.

### Re-scoping consequence — the ~178 estimate is likely an over-count now

The original ~178 assumed every bucket-(1) test fails on an `undefined`
descriptor. Since the **boolean-attribute assertions now pass** (the common
`verifyProperty`/`propertyHelper.js` shape checks that only assert
`writable`/`enumerable`/`configurable` + `typeof value === "function"`), a
material fraction of bucket (1) may **already pass** on current main. The
**residual** bucket-(1) failures are only the tests that (a) _call_
`descriptor.value`, or (b) assert `descriptor.value === Ctor.prototype.method`
identity, or (c) trip the `typeof` instability. **Next owner must re-measure the
real count** (run `built-ins/*/getOwnPropertyDescriptor` +
`built-ins/Object/getOwnPropertyDescriptor` through the real test262 harness on
standalone) before committing the XL sizing — the sub-3-attr-only tests are
sunk, and the true remaining number is probably well under 178.

### Recommended split (updated)

1. **Bucket (3) is the cleanest independent slice and has moved closest to
   done.** Its only remaining gap is a narrow, well-scoped one: make accessor
   get/set **closures host-free** (retire the `WeakMap_get`/`WeakMap_set` host
   import that accessor-closure storage/invocation drags in under standalone —
   see `src/codegen/accessor-driver.ts` + the `__call_accessor_get/set` drivers
   in `object-runtime.ts` ~L1020/L1558). This does **not** need the
   method-value reification substrate and could be its own S/M issue. Split it
   out and prioritise it — highest test-flip-per-effort of the three.
2. **Buckets (1) + (2) remain jointly blocked on method-value reification**
   (issue step 2), which should sit on **#2949's `dynamic` JsTag-carrying kind**
   rather than a parallel boxing scheme. Do **not** start (1)/(2) before #2949's
   substrate lands — a descriptor-layer-only attempt re-breeds the placeholder
   `.value` (and the `typeof` instability) rather than fixing it.
3. **Secondary bug to file separately:** the `typeof d.value` codegen-path
   dependence (inline `"function"` vs const-bound `"object"`) is a
   representation-stability defect in how an open-object descriptor field is
   read back; worth isolating even before (1) lands because it can cause
   flaky `typeof` assertions elsewhere.

**Verdict for this pass:** no small, self-contained code change flips any
test262 assertion without the method-value reification substrate. Per the
"banked spec beats a broken codegen change" discipline, this pass delivers the
measurement-grounded re-scope + split recommendation rather than a codegen
edit. Bucket (3)'s host-free-accessor slice is the recommended next
_implementable_ unit and is the only one that does not wait on #2949.

### Bucket (3) re-measurement (2026-07-03, dev-2984-bucket3) — the WeakMap narrative is STALE; bucket (3) is effectively DONE for test262

> **Re-measured against `upstream/main` @ `ab130543e`** (`target: standalone`,
> instantiate with empty imports `{}`). This slice was dispatched to "retire the
> `WeakMap_get`/`WeakMap_set` host import that accessor-closure invocation drags
> in". **That import leak no longer reproduces on current main** — the split
> recommendation above (item 1) is superseded by the findings here. Probes:
> `.tmp/probe*.mjs` (gitignored) — `compile(src,{target:'standalone'})` then
> `WebAssembly.instantiate(r.binary,{})` + `WebAssembly.Module.imports(mod)`.

**Finding 1 — no WeakMap import; the module is fully host-free.** `gOPD(obj,'x')`
on a plain object with `get x()`/`set x(v)` compiles with **zero imports**
(`WebAssembly.Module.imports` is empty). There is **no `env::WeakMap_get` /
`env::WeakMap_set`** — those symbols do not exist anywhere in `src/` on current
main (`grep -rn 'WeakMap_get\|WeakMap_set' src/` → 0 hits). The "traps at
instantiate under standalone (missing import)" narrative in the table above is
against a pre-#2861/#2863/#2896 tree and no longer holds.

**Finding 2 — descriptor SHAPE + accessor-closure STORAGE are correct.** All the
shape assertions that real test262 gOPD tests make pass host-free:
`typeof d.get === 'function'` ✓, `typeof d.set === 'function'` ✓,
`d.hasOwnProperty('value') === false` ✓, `d.enumerable === true` ✓,
`d.configurable === true` ✓. Direct accessor use also works: `obj.x` → `5`,
`obj.x = 42; obj._x` → `42` (the `__extern_get`/`__extern_set` arms invoke the
stored `$get`/`$set` closure via the `__call_accessor_get/set` drivers, threading
`this` through `__current_this` — all native, no host).

**Finding 3 — the residual gap is NOT accessor-specific and has ~zero test262
yield.** The only thing that fails is _invoking the getter/setter as a
first-class value pulled from the descriptor_: `d.get.call(obj)` → `0` (should be
`5`), `d.get()` → traps. But this is a **general `Function.prototype.call`/
`.apply`-on-a-first-class-closure-value** gap, not a descriptor/accessor bug — it
reproduces with no descriptor at all:

| probe (`--target standalone`)                        | result | expected |
| ---------------------------------------------------- | ------ | -------- |
| `const m = o.m; m.call(o)` (method value, no `this`) | `0`    | `5`      |
| `const m = o.m; m.call(o)` (method reads `this._x`)  | `0`    | `9`      |
| `const m = o.m; m.apply(o,[])`                       | `0`    | `9`      |
| `const g = h; g.call(null)` (fn-decl value)          | `0`    | `7`      |
| `const m = o.m; m()` (direct, no `.call`)            | `5`    | `5` ✓    |
| `const f = () => 5; f.call(null)` (arrow value)      | `5`    | `5` ✓    |

Root cause: the `identifier.call(thisArg, …)` handler in
`src/codegen/expressions/calls.ts` (~L4831-4838) statically resolves the closure
and **drops `thisArg`**, treating every non-`$NativeProto` closure as
`this`-ignoring; a receiver-extracted method / descriptor getter never gets its
`this`. The `d.get.call(obj)` form is a _property-access_ callee (not an
identifier), so it doesn't even reach that arm — it falls through the generic
closure-value dispatch, which has no path to recover the closure struct from an
arbitrary `externref` and re-invoke it through `__call_fn_method_0/1` with
`thisArg` bound. A correct fix is "route `.call`/`.apply` on a first-class
closure value through the `__call_fn_method_N(thisArg, closure, …args)`
dispatcher" — the **same method-value reification substrate that blocks buckets
(1)+(2)** (D1 / #2949), _not_ an independent accessor slice.

**Finding 4 — no test262 gOPD test invokes the returned accessor.** In
`test262/test/built-ins/Object/getOwnPropertyDescriptor/`, **zero** tests call
`.get()`/`.set()`/`.get.call(…)` on the returned descriptor
(`grep -rlE '\.get\.call|\.set\.call|desc\.get\(|\bget\(\)'` → 0). They assert
descriptor _shape_ only — which already passes (Finding 2). So the residual
"invoke accessor host-free" work flips ≈0 test262 assertions here.

**Corrected verdict for bucket (3):** it is **effectively done** for
test262-conformance purposes on current main (shape correct + host-free). The
"cleanest independent slice / highest test-flip-per-effort" framing in item 1 of
the split above is **wrong on current main** — that slice's only residual gap is
a general `.call`/`.apply`-on-closure-value substrate issue with near-zero
conformance yield, and its real fix converges with the #2949 method-value
reification that buckets (1)+(2) need. **Recommendation: do NOT spin bucket (3)
out as a standalone S/M issue.** Fold any remaining first-class-closure-invoke
work into the #2949 substrate track, and treat the accessor descriptor readback
itself as closed. (No codegen edit is delivered in this pass — a `.call`/`.apply`
drop-`thisArg` change risks regressing the many standalone tests that rely on
"standalone functions ignore `this`", and the correct dispatch belongs on the
#2949 substrate; per "banked measurement beats a risky codegen change" this pass
records the measurement and closes the mis-scoped slice.)

## The three substrate sub-problems

The ~178 failures decompose into three distinct substrate buckets, each with
its own root cause. They are NOT one fix.

### (1) Proto-receiver reification (~124 tests) — the big rock

`Object.getOwnPropertyDescriptor(Array.prototype, "forEach")` compiles
**host-free** (no CE) but returns `undefined` instead of a real data
descriptor. Root cause: **builtin methods are not first-class values in
standalone mode.** `Array.prototype.forEach` is synthesized inline at each
call site (or dispatched through a receiver-typed lowering); there is no
reified `Array.prototype` object carrying a property table, and no reified
function value to place in the descriptor's `.value` slot. The dynamic
`__getOwnPropertyDescriptor` native walks the open-object runtime's own
property table, finds nothing for a synthetic proto receiver, and returns
`undefined`. Spec attributes for a builtin method are `{ writable: true,
enumerable: false, configurable: true, value: <the method fn> }`; we can
answer the three boolean attributes from a static table, but the `.value`
slot requires a **real function value** for the builtin method — which the
standalone lane does not currently materialise.

### (2) Builtin-ctor-as-receiver (~63 tests) — hard CE

`Object.getOwnPropertyDescriptor(Array, "isArray")` **hard-CEs** with
`"__get_builtin not yet supported"`. Root cause: **builtin constructors are
not resolvable dynamic-shape receivers.** In standalone mode `__get_builtin`
refuses-loud (the open-object runtime does not expose it — see
`src/codegen/property-access.ts` ~L3943), so a constructor used as a _dynamic_
gOPD receiver reaches the `__get_builtin` shortcut with no static-constant
folding available and emits the located refusal instead of a descriptor.
Static member reads like `Array.isArray(x)` already resolve (constant
emitter), but the _reflective_ `gOPD(Array, "isArray")` form has no path.

Buckets (1) and (2) overlap: both need a reified builtin object (the
`.prototype` object in (1), the constructor object in (2)) that owns a
queryable property table whose entries can yield real descriptors.

### (3) Plain-object accessor-descriptor readback (~29 tests) — separate deferred substrate

A smaller bucket: `gOPD` on a **plain user object** with an accessor
(get/set) property returns a data descriptor or drops the accessor, because
the descriptor-readback path does not round-trip `get`/`set` function slots.
Root cause is distinct from (1)/(2) — it is an accessor-descriptor
representation gap in the open-object runtime (get/set closures + `call_ref`
to invoke them on read), not a builtin-MOP gap. **Track/deliver separately**;
it is deferred substrate of its own and should not be folded into the builtin
MOP work.

## Why `__builtinfn_gopd` does not extend to this

The existing `__builtinfn_gopd` machinery (introduced by #2861/#2863/#2896,
registered in `src/codegen/object-runtime.ts` ~L499) answers gOPD **only for
`name` / `length` on a builtin FUNCTION closure value** — i.e. when the
_receiver itself_ is already a first-class builtin function value and the key
is one of its own two metadata properties. It returns a fixed data descriptor
(`{ writable:false, enumerable:false, configurable:true }`) or null.

It does not extend to #2984 because:

- Its receiver is a **builtin function value**, not an `X.prototype` object
  or a constructor object. In (1)/(2) the receiver is a _namespace/proto_
  object that is not reified at all — there is nothing for `__builtinfn_gopd`
  to key off.
- It only knows two keys (`name`, `length`). The proto-receiver case needs to
  answer **every builtin method name** owned by that prototype, with a
  `.value` slot that is a real function value — a fundamentally larger table.
- Its `.value`-less fixed descriptor is exactly what falls short: the spec
  descriptor for a builtin method **must carry the method as `.value`**, which
  is the piece the standalone lane cannot currently produce.

So the fix is not a widening of `__builtinfn_gopd`'s key set; it needs a
builtin **object** meta-object protocol sitting a layer up, plus first-class
reification of the method values it points at.

## Rough shape of a real fix

Design sketch only (sizing, not a spec):

1. **Reify builtin prototype/constructor objects** as queryable meta-objects
   on the standalone lane — a per-builtin static descriptor table keyed by
   property name, produced at codegen time (Array.prototype → {forEach, map,
   filter, …}; Array → {isArray, from, of, …}). This is the shared
   prerequisite for buckets (1) and (2).
2. **Materialise builtin method values as first-class function values** so a
   descriptor's `.value` slot can hold the actual method (funcref/closure),
   not just its metadata. This is the heavy part — it touches how builtin
   methods are lowered (inline-at-callsite today) and interacts with the
   value-representation substrate.
3. **Route dynamic `gOPD(receiver, key)`** so a builtin-object receiver is
   recognised (not sent to the refusing `__get_builtin` shortcut) and
   dispatched into the meta-object table, building a full data descriptor
   ({value, writable, enumerable, configurable}) from the static entry.
4. Keep the host/gc lane **byte-inert** (gated on `ctx.standalone`, same
   reserve/fill discipline as the existing natives so late-import funcIdx
   shifts stay invariant).
5. Bucket (3) — accessor readback on plain objects — is a **separate**
   deliverable (get/set closure round-trip + `call_ref`), split out.

## Related representation-family work (same D1-disease class)

This is the **D1 "type-erased value representation"** disease class per the
June audit (`plan/log/analysis-2026-06/00-program-overview.md`): lowering
picks representation from the Wasm ValType rather than the JS type, so builtin
methods never become first-class JS values that a descriptor can point at.
Cross-reference **#2949** (IR dynamic value representation — a JsTag-carrying
`dynamic` kind in `IrType` to make untyped JS claimable): the ability to hold
a builtin method as a first-class tagged value is the same
representation-family capability #2949 is building. #2984's method-value
reification (step 2 above) should be designed to sit on top of #2949's
`dynamic`-kind substrate rather than inventing a parallel boxing scheme —
otherwise it re-breeds the D4 "duplicated representation" drift the audit
warns about.

## Acceptance

- gOPD on builtin proto/ctor receivers returns spec-correct descriptors
  (including a real `.value`) on the standalone lane; host/gc lane unchanged
  (byte-inert).
- Buckets (1) and (2) measured on the `built-ins/*/getOwnPropertyDescriptor`
  and `built-ins/Object/getOwnPropertyDescriptor` standalone subsets with zero
  regressions on a passing-test sweep.
- Bucket (3) split into its own follow-up (accessor-descriptor readback).
- Once landed, re-measure #2989 — its dynamic-descriptor TypeError assertions
  should become reachable and flip.
