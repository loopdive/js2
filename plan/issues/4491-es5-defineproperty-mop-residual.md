---
id: 4491
title: "ES5 standalone: Object.defineProperty/defineProperties/create residual (90 tests) — descriptor MOP semantics on the dynamic object runtime"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-20
assignee: claude/es6-standalone-session
priority: high
horizon: m
feasibility: medium
task_type: conformance
area: codegen
es_edition: es5
goal: standalone-mode
related: [4444, 3031, 4490, 4504]
loc-budget-allow:
  - src/codegen/vec-overlay.ts
  - src/codegen/object-ops.ts
  # 2026-08-19 mirror/vec descriptor slice: a compiled array crosses the
  # externref boundary as a DETACHED __make_iterable mirror while
  # Object.defineProperty gets the RAW vec, so every recorded attribute was
  # invisible to reflective reads. The bulk went to two NEW subsystem modules
  # (src/runtime/vec-descriptor-mirror.ts, src/runtime/builtin-proto-expando.ts)
  # — +284 -> +134; the residual is call-site wiring that must live in the
  # runtime barrel at the host-import boundary.
  - src/runtime.ts
  # 2026-08-20 honest-carrier slice: emitRuntimeDescriptorGet keeps externref
  # in standalone (accessor results are runtime state; narrowing to the
  # checker's f64 turned a get:undefined redefine's canonical undefined into
  # NaN — 15.2.3.6-4-498/516/534/552 measured fail→pass).
  - src/codegen/property-access.ts
  # 2026-08-21 void-undefined slice: typeof unsound-fold guard for runtime
  # accessor keys (typeof-delete.ts), void-typed binding slot widening
  # (declarations.ts moduleGlobalWasmType arm).
  - src/codegen/typeof-delete.ts
  - src/codegen/declarations.ts
  # 2026-08-21 defineProperties/create edge slice (buckets Q + R): the
  # `Object.prototype.isPrototypeOf` reflective body is dispatched from
  # `makeGlue`'s Object arm (array-object-proto.ts, +6) and the `for…in`
  # [[Enumerable]] gate joins the existing #4222 presence gate
  # (statements/loops.ts, +26). Both bodies live in NEW modules
  # (object-proto-is-prototype-of.ts, vec-index-enumerable.ts); only the
  # dispatch/wiring is in the big files.
  - src/codegen/array-object-proto.ts
  - src/codegen/statements/loops.ts
  # 2026-08-21 wave-3 lane C, arguments [[ParameterMap]] slice: a lifted
  # function EXPRESSION built the same arguments vec as a declaration but never
  # installed `mappedArgsInfo`, so §10.2.11 step 22.a's mapped/unmapped split
  # depended on how the function was SPELLED. The install goes in the existing
  # `needsImplicitArgumentsObject` block of `compileLiftedClosureBody`; the
  # `mappedArgsInfo` shape itself gains one optional Set field.
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  # 2026-08-21 wave-3 lane C, §10.1.6.3 step 4.c guard: the accessor→data
  # refusal in `__defineProperty_value`'s ValidateAndApply preflight gains its
  # missing IsGenericDescriptor precondition. One nested `if` around the
  # existing throw; no new natives, no local-vector change.
  - src/codegen/object-runtime-descriptors.ts
  # 2026-08-21 wave-3 lane A (types/object + types/reference rows): the two
  # "the closed struct cannot serve this write" arms of `compileMemberIncDec`
  # now share ONE externref read-modify-write emitter, hoisted to module scope
  # (`emitMemberIncDecExternrefFallback`) rather than inlined twice. The file
  # grows by the hoisted helper; the driver function grows by the second call.
  - src/codegen/expressions/unary-updates.ts
oracle-ratchet-allow:
  # 2026-08-21: one getTypeAtLocation in varBindingNeedsExternrefForUndefined's
  # new call arm — the same raw-checker idiom as the surrounding predicate;
  # the query is a TypeFlags test (void/undefined purity) the oracle does not
  # express.
  - src/codegen/index.ts
  # 2026-08-21 (regression fix): the module-global consult was narrowed to an
  # INLINE void-call check in moduleGlobalWasmType (the full predicate's
  # void-0/#4206 arms regressed the filter harness family) — same TypeFlags
  # purity query, same rationale.
  - src/codegen/declarations.ts
coercion-sites-allow:
  # 2026-08-21 wave-3 lane C: NOT new coercion vocabulary — the missing half of
  # an existing pair. `compileLiftedClosureBody` already ensures `__box_number`
  # two lines above (param → arguments slot); the mapped REVERSE sync
  # (`emitMappedArgReverseSync`, logical-ops.ts) unboxes back into an f64/i32
  # parameter and silently degrades to a wrong value when `__unbox_number` is
  # absent. `compileFunctionBody` has ensured both since #849; the lifted
  # closure path ensured only one because it never installed `mappedArgsInfo`.
  - src/codegen/closures.ts
  # 2026-08-21 wave-3 lane B: ONE `number_toString` in the new
  # `__strexo_push_keys` native. It is not a hand-rolled matrix — it is the
  # SEALED formatter, used for the one thing §10.4.3.6 requires here (the
  # canonical index KEY `ToString(i)`), identically to every other index-key
  # producer in the tree (`__extern_get_idx`'s `$Object` arm, the #3251 overlay
  # companion lookup, `emitArrayForIn`). Hand-rolling a digit loop instead is
  # exactly what this gate exists to prevent, so the reviewed grant is the
  # correct outcome rather than an avoidance.
  - src/codegen/string-exotic-own-props.ts
func-budget-allow:
  # 2026-08-21 defineProperties/create edge slice: the `Properties`-map entry
  # model gains a PASS-THROUGH arm (a map entry that is not an object literal)
  # plus the reified-map construction. Already 724 LOC at base — the growth is
  # in the existing `stableDescriptorMapEntries` IIFE, which cannot be split out
  # without also moving the stability visitor it closes over.
  - src/codegen/object-ops.ts::compileObjectDefineProperties
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/codegen/object-ops.ts::compilePropertyIntrospection
  # 2026-08-21 wave-3 lane C, arguments [[ParameterMap]] slice.
  # `compileLiftedClosureBody` grows by the mapped-arguments install (+32).
  # `compileObjectDefinePropertyCore` is NOT growth: `compileObjectDefineProperty`
  # was split into an 8-line wrapper (which emits §10.4.4.2 step 5.b.i after the
  # define) plus the unchanged body under the new name, so the baseline's entry
  # moved rather than grew. The post-merge baseline refresh absorbs the rename.
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/object-ops.ts::compileObjectDefinePropertyCore
  # 2026-08-21 wave-3 lane B, §10.4.3 String-exotic own KEYS: two one-call
  # prologue splices (`__object_keys` + `__object_keys_forin`), +7 lines total.
  # They MUST live inside this builder — each one references the result-vector
  # LOCAL INDEX of the native it is spliced into, so it cannot be lifted out
  # without also lifting the two native bodies. The prologue's whole
  # implementation is already in a separate module
  # (src/codegen/string-exotic-own-props.ts, +184); this is call-site wiring.
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
  # 2026-08-21 wave-3 lane A: `compileMemberIncDec` gains one call to the
  # hoisted externref RMW emitter (its body SHRANK by the de-duplicated
  # emitter); `compileTypeofComparison` gains the 4-line
  # `readPrecedesVarInitializer` unsound-fold guard — a `var x` read that is
  # textually before its own initializer must not fold the checker's
  # initializer-derived type. Both are guard clauses in long dispatch chains
  # whose arms cannot be reordered without changing precedence.
  - src/codegen/expressions/unary-updates.ts::compileMemberIncDec
  - src/codegen/typeof-delete.ts::compileTypeofComparison
  # 2026-08-21 wave-3 lane A, realm-global member CALL/READ: two guard clauses
  # that must sit at a specific point in a long ordered dispatch chain — the
  # call one BEFORE `compileReceiverMethodCall` (which resolves the member
  # against the `typeof globalThis` struct and throws on the miss), the element
  # one BEFORE the JSON/linear/Math arms. Both bodies live in their own
  # modules (realm-global-member-call.ts, and the existing #4500 Slice A helper
  # in property-access.ts); only the dispatch point is in the big function.
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/property-access.ts::compileElementAccess
---

# #4491 — ES5 defineProperty/defineProperties/create MOP residual

## Problem (measured 2026-08-15, `.tmp/es5-standalone-clusters.ts`, fresh baseline)

ES5 standalone stands at 8,386/9,029 (92.9%), 643 non-passing. The single
largest family is the property-descriptor MOP: `built-ins/Object/
defineProperty` (52) + `defineProperties` (26) + `create` (12) = **90 tests**.

Symptom mix (top): silent no-op defines (`result !== true`, `Expected "a ===
10", actually 0`), accessor descriptors not taking effect (`foo value should
be undefined`), index-keyed defines landing wrong (`Expected obj[0] to equal
0, actually null`), `Object.create(proto, props)` second-arg families, 3
`__module_init` null derefs.

## FALSIFIED HYPOTHESIS (kept visible per lane convention)

The plan below was built by mining error TEXT, not by verifying tests. Its
symptom list and its sub-bucket table did **not** survive contact — see
"Measured triage" after it. Kept so the next reader can see what was tried.

## Implementation Plan (fable, 2026-08-15) — triage-first

1. **Sub-bucket by MOP operation before coding** (mandatory table in this
   file): (a) data-descriptor writes on dyn objects, (b) ACCESSOR descriptors
   (get/set installation + invocation), (c) attribute enforcement
   (writable:false silently ignored? configurable transitions?), (d)
   index-keyed properties on vec-backed arrays, (e) `Object.create` props-arg,
   (f) the 3 null-deref crashes (fix first — crashes before semantics).
2. The dynamic object runtime (`src/stdlib/object-runtime.ts`,
   `__defineProperty_value` — note #2175's S3b-1 just touched materialization
   ordering vs `__defineProperty_value`, coordinate with the reflection lane's
   in-flight worktree) already has descriptor machinery; expect the residual
   to be missing arms (accessor install on specific carriers, attribute
   checks on define-over-existing) rather than a missing subsystem.
3. Fix largest bounded sub-buckets first; each with unit tests; A/B file-copy
   baselines; zero pass→non-pass on the scoped filter.

## Measured triage (generators lane, 2026-08-15)

**Source**: the shared full standalone baseline
`.test262-cache/test262-standalone-current.jsonl` (mtime 2026-08-15 20:21Z, 1.2 h
old at extraction), filtered to the plan's own scope. A dedicated scoped run was
started and **abandoned** — at the observed ~60 s/test under three-lane load,
2083 files is hours, and the shared baseline covers the identical file set. The
baseline is one other lane's run against integrated main, which is the right
reference for triage (main's state, not my worktree's).

**Scope totals: 2083 files, 1983 pass, 100 non-passing** (99 fail + 1 CE) —
`defineProperty` 59, `defineProperties` 29, `create` 12. Close to the plan's 90;
the delta is snapshot drift, not a different population.

### Step 0 — the plan's symptoms do not reproduce

One minimal standalone program per sub-bucket in the plan's list. **All ten
pass, host-free, zero imports** — including the two named as top symptoms:

| probe                                             | result |
| ------------------------------------------------- | ------ |
| data define; returns obj; value reads back        | pass   |
| accessor `get` installs **and invokes**           | pass   |
| accessor `set` installs **and invokes**           | pass   |
| `writable:false` blocks a later write             | pass (throws TypeError — correct, see below) |
| `enumerable:false` hidden from `for-in`           | pass   |
| `configurable:false` redefine throws              | pass   |
| index-keyed define on an array (`a[0] === 42`)    | pass   |
| `Object.create(proto, props)`                     | pass   |
| `Object.defineProperties` two data props          | pass   |
| `getOwnPropertyDescriptor` round-trip (all 4 attrs) | pass |

`writable:false` first looked like a real hit — a wasm exception. That was the
PROBE's fault: it had no `try`/`catch`, and a compiled module is always strict,
where that write MUST throw. With the catch it is a proper catchable TypeError,
matching Node. Recorded so the false positive is not re-derived.

**Consequently the source comment in `src/codegen/object-runtime.ts` calling
`__defineProperty_accessor` / `__getOwnPropertyDescriptor` "RUNTIME-LAYER
GROUNDWORK … not yet reached end-to-end under standalone" is STALE** — both are
reached and both work. Fix that comment in the first slice that touches the file.

### Step 1 — measured sub-buckets (classified from test SOURCE, not error text)

| bucket                                              | n  | status |
| ---------------------------------------------------- | -: | ------ |
| D array index at/above the 2^32 boundary             | 26 | **reproduced** |
| Q `defineProperties` descriptor-map edges            | 18 | unprobed |
| R `Object.create` edges                              | 13 | unprobed |
| B accessor descriptor round-trip (non-trivial)       | 12 | unprobed |
| H still unclassified                                 | 11 | — |
| P1 define ACCESSOR on a **builtin prototype**        |  7 | **reproduced** |
| E symbol-keyed define                                |  5 | unprobed |
| F crash — `__module_init` null deref                 |  3 | fix first |
| P2 define DATA prop on a **builtin prototype**       |  3 | **reproduced** |
| OUT Proxy / TypedArray-RAB / DOM global              |  4 | out of lane |

**The plan had no category for P1/P2 at all**, and they are the cleanest
reproductions:

- **P1** — `Object.defineProperty(Array.prototype, "prop", {get, set})`, then
  `a.prop` reads correctly but `a.prop = v` **does not run the setter**.
- **P2** — `Object.defineProperty(Date.prototype, "prop", {value})`, then
  `d.prop = 1002` reads back 1002 but `d.hasOwnProperty("prop")` is **false**:
  the assignment never created an own property on the instance.
  These overlap #2175's builtin-prototype territory — coordinate before coding.

- **D is NOT "length/index coupling"**, which works: index define extends
  `length` (index 5 → length 6; index 1000 → length 1001), a `length` shrink
  deletes higher indices, and an ACCESSOR at index `"0"` installs and invokes.
  What fails is the **boundary**: at index `4294967294` the property is created
  but `length` does not become `4294967295` and the element does not read back;
  at `4294967295` (not an array index) the ordinary string-keyed property is not
  created. Smells like an i32/u32 truncation in the index path — bounded, and
  the largest single target.

**Recommended order**: F (3 crashes) → D boundary → P1/P2 with #2175 (10).

### Step 2 — F verified: REAL crashes, not failure-path artifacts

Decisive test: strip the asserts. If the crash survives, it is on the success
path. It does.

- `create/15.2.3.5-4-{165,191}.js` — **real, success-path crash**, narrowed to
  `Object.create(proto, { prop: <constructor instance> })`. Controls isolate it
  tightly: the same call with an object-LITERAL descriptor works, and
  `Object.defineProperty(o, "p", <constructor instance>)` works. So it is
  `Object.create`'s props-arg reader, not the descriptor reader, and not the
  instance carrier per se. **2 tests.**
- `defineProperty/15.2.3.6-3-123.js` — does NOT reproduce in a module. The test
  is `{ configurable: this }` in a SLOPPY script, where `this` is the global
  object (truthy); in a module `this` is `undefined` (falsy) and the shape
  passes. Different root cause; needs the sloppy-`this` context to study.
  **1 test.**

### Step 3 — D re-scoped: it is not one 26-test bucket

Extracting the index literals each D test actually uses splits it three ways,
and only one part is a bounded, self-contained fix:

| part | n | what it needs |
| ---- | -: | ------------- |
| **D-a** non-index key ≥ 2^32-1 on an ARRAY via `defineProperty` | 8 | self-contained, no representation change |
| **D-b** index in `[2^31, 2^32-2]` | 7 | widen `__obj_index_of_key` i32 → u32 — see below |
| mis-bucketed by my own heuristic | 11 | re-triage |

**D-b is a DOCUMENTED, deliberate approximation, not an unnoticed truncation.**
`vec-index-domain.ts` §1 (#4434) states it outright: "The ceiling stays 2^31-1
rather than the spec's 2^32-2 … the result doubles as a SIGNED sort key for
OrdinaryOwnPropertyKeys ordering. Keys in `[2^31, 2^32-2]` are therefore treated
as ordinary string keys." So the i32/u32 smell is real and the mechanism is
right, but the fix is a representation change with a named downstream consumer —
not a one-line boundary correction. Do not start it as if it were.

**D-a is the bounded slice.** Isolated with four probes:

| probe | result |
| ----- | ------ |
| `defineProperty(arr, "4294967295", …)` | `length` right; `hasOwnProperty` **false**; value unreadable |
| `arr["4294967295"] = 7` (plain assignment) | `length` right; value **readable**; `hasOwnProperty` **false** |
| `defineProperty(arr, "foo", …)` | fully correct |
| `defineProperty(plainObj, "4294967295", …)` | fully correct |

So: ordinary names on arrays work, the same key on a plain object works — only
**array × numeric-non-index via `defineProperty`** fails. A second, adjacent
defect shows up in the assignment control: `hasOwnProperty` does not see the
#4247 expando-bag entry even when the value reads back, which likely accounts
for part of the 8 on its own.

### Step 4 — D-a is THREE defects, not one (key-domain sweep)

Sweeping `Object.defineProperty(a, K, {value:7,…})` over key spellings, then
checking `a.length`, `a.hasOwnProperty(K)` and `a[K]`, separates them. (Earlier
probes used DOT access `a.foo` / a NUMERIC literal `a[5]`, which is why this
only surfaced on the sweep — the read spelling matters.)

| key | length | hasOwnProperty | `a[K]` reads back |
| --- | ------ | -------------- | ----------------- |
| `"foo"`, `"-1"`, `"1.5"`, `"4294967295x"`, `"2147483648"` | ok | ok | **NO** |
| `"4294967295"`, `4294967295`, `"4294967296"` | ok | **NO** | **NO** |
| `"99"` (ordinary index) | ok | ok | **NO** |
| `"2147483647"` (= 2^31-1, a legal index) | — | — | **TRAPS**: "array element access out of bounds" |

1. **Read-path**: a COMPUTED STRING key on an array (`a["foo"]`) does not find
   the property, while DOT access (`a.foo`) does — and the same holds for
   elements (`a["99"]` misses where `a[99]` hits). This gates almost every case
   in the table, including ones whose store already works, so it is the
   load-bearing half of the "visibility" family.
2. **Store-path**: `defineProperty` with a numeric non-index key `>= 2^32-1`
   creates no named property at all (`hasOwnProperty` false).
3. **Trap**: defining a legal but huge index (`2^31-1`) tries to grow the
   backing array to ~2 billion elements and aborts — an uncatchable trap, the
   #4222/#4247 family, still reachable through `defineProperty`.

(3) is a new component, not in the original D-a scope, and it is a hard abort
rather than a wrong answer — split out as **#4498** (allocation policy, blast
radius over every array grow path).

### Step 7 — the D-a gate, and the PRICED SKIP of the full regression run

**Gate composition (corrected by reading each test's FIRST failing assertion,
not its bucket label).** The "8-test D-a gate" is really three groups:

| tests | first failing assertion | owner |
| ----- | ----------------------- | ----- |
| `defineProperties/15.2.3.7-6-a-{180,181,182}` | `arr[K]` value read (their `hasOwnProperty` already PASSES) | **this slice (element-read fall-through)** |
| `defineProperty/15.2.3.6-4-{184,185,186}` | `hasOwnProperty(K)` | blocked on the `__hasOwnProperty` fall-through, HELD behind #2175 P2 |
| `defineProperty/15.2.3.6-4-155`, `defineProperties/15.2.3.7-6-a-151` | `arr.length === 4294967295` | **re-bucketed to #4497** (needs index 4294967294 to be legal) |

So the element-read slice's honest bar is **3 flips**, not 8. Recorded before
implementing so the slice is not later read as underdelivering.

**Priced skip — why the full (a)/(c) regression run was NOT done.** Measured
throughput of the per-file driver on this box: **3.67 s/file** (timed, 30 files;
the pooled runner measured no faster at 2.9 s/file). Populations:

| gate | population | cost |
| ---- | ---------: | ---: |
| (a) `built-ins/**/{name,length}.js` — the propertyHelper set that burned 684 passes | 1,240 | 75 min |
| (c) `built-ins/Array` + `built-ins/Object/defineProperty` | 4,213 | 257 min |
| | **before-state** | **~5.5 h** |
| | before + after | **~11 h** |

Eleven hours for a read-side arm addition is the wrong trade, so the gate was
**substituted** (approved): emitted-BYTE identity over a bracketing corpus
(`.tmp/byte-corpus.mts`, 23 programs × gc + standalone) + the functional D-a
gate + a **random 200-file** spot-check of gate (a), **seed 20260815**
(`.tmp/sample-gate-a.mjs`; the sample is random precisely because path order
correlates with feature families, so an alphabetical head-200 is not a sample).

Byte identity is the STRONGER proof for the population that must not move: a
program whose emitted binary is unchanged cannot have changed behaviour, which
is exactly the claim needed about the 684-pass propertyHelper set. The corpus
program whose bytes are EXPECTED to change (non-index numeric read) gets its own
functional before/after so the only observable delta is the intended
absent → found.

### Step 9 — D-a element-read fall-through: LANDED, gates measured

**Change.** `vec-overlay.ts` — the existing finalize-time overlay read prologue
is now spliced into **both** `__extern_get` and `__vec_prop_get`, by iterating
the two lane names rather than duplicating the body, so they cannot drift.
Standalone routes a non-index named read on an array to `__vec_prop_get`
(`resolveNamedPropHelper`, deliberately — the `__extern_*` prologue would
swallow the key as an element), and that lane never received the prologue while
the gc/host lane has had it since #3251. That asymmetry was the whole bug.

**Functional delta (the intended one, and only it):**

| probe | before | after |
| ----- | ------ | ----- |
| `a[4294967295]` after `defineProperty` | miss | **7** ✅ |
| `a["4294967295"]` | miss | **7** ✅ |
| `a.hasOwnProperty(K)` | false | false (HELD step-3 edit) |
| `Object.hasOwn(a,K)` / plain-object / `a.hasOwnProperty("foo")` | ok | unchanged ✅ |

**Gate (b) — exactly the predicted 3 flips, 0 regressions:**
`defineProperties/15.2.3.7-6-a-{180,181,182}` fail → **pass**;
`defineProperty/15.2.3.6-4-{184,185,186}` still fail (blocked on the held
`__hasOwnProperty` fall-through); `4-155` / `-151` still fail (#4497).

**Gate (a), seeded 200 (seed 20260815) — 129 pass / 40 fail / 31 skip →
129 / 40 / 31. Zero pass→non-pass.** This is the population that burned 684
passes last time; it does not move.

**Gate: byte matrix — DEVIATED from its stated expectation, and the deviation is
the GATE's flaw, not the change's.** Expected exactly one program to change;
**11 standalone programs changed**, including `syn:obj-prop` and `syn:hasown`,
which contain no array at all. Cause, verified rather than assumed: a standalone
module links the WHOLE runtime, so editing any native shifts every standalone
module's bytes. Probed directly — a program with no array still contains
`__vec_prop_get`, `__extern_get` and `__vec_overlay_lookup`.

So byte-identity is only a blast-radius proof when linkage is per-program. For
standalone whole-runtime linking it proves **lane-level** isolation and nothing
finer. What it does prove here is worth keeping: **the gc lane is 100 %
unchanged (23/23 programs)** — the host lane is provably untouched. Within
standalone, the functional gates above are the binding evidence, not the bytes.

**Gate: FUNCTIONAL corpus, standalone, base vs branch — IDENTICAL on all 23.**
Same 23 programs, same lane, comparing observed OUTPUT instead of bytes
(`.tmp/func-corpus.mts`, A/B with both sides derived from git at use time). This
converts "the 11 byte deltas are benign code-shift" from inference into
measurement: every one of those programs computes exactly what it did before.

Note the corpus program I predicted WOULD change functionally
(`syn:array-nonindex-numeric`) did not — correctly. It reads
`a[4294967295]` on an array that never had `defineProperty` called on it, so
there is no companion entry and `undefined` is the right answer on both sides.
The behavioural delta is confined to programs that actually install a
descriptor, which is what gate (b) and the R4/R5 probes measure directly. That
is the third time in this slice that a stated expectation was wrong in the
SAFE direction; each was caught by measuring rather than asserting.

### Step 11 — step-3 root cause: a COMPILE-TIME FOLD, not a runtime arm

Diagnostic done by disassembling the emitted module — **no src instrumentation
needed**, so nothing had to be reverted. Both candidates in Step 10 are WRONG,
and so is the plan's assumed site.

**The two natives are byte-identical.** `wasm-dis` of a module containing both
calls shows `$__hasOwnProperty` and `$__object_hasOwn` with the SAME locals and
the SAME `fillVecHasOwnHelpers` prologue (`ref.test $vecBase` → `call
$__vec_gopd` → …). The splice worked on both. So it was never a splice-time
resolution failure (candidate a) nor a competing earlier prologue (candidate b).

**`a.hasOwnProperty(K)` never calls either native.** In `$test` the only
predicate call emitted is `call $__object_hasOwn`; the `hasOwnProperty` site
compiled to a literal **`(if (i32.const 0) …)`**. The answer was CONSTANT-FOLDED
at compile time.

**Where.** `compilePropertyIntrospection` (`object-ops.ts`) — its own docstring
says "Static resolution (string literal arg): constant fold to i32.const 0/1".
Its vec-receiver branch has exactly two arms: a dense-literal own index (fold to
1) and, for reference-element vecs, a canonical-index bounds test OR-ed with
`__hasOwnProperty`. A static key that is **not a canonical array index** —
`"4294967295"` — matches neither, falls through to the generic FIELD-NAME logic,
and a vec struct has no field of that name ⇒ folded `0`. `Object.hasOwn` has no
such fold, which is the entire reason the two spellings disagree.

**Fix (small, and NOT in a contended file).** In that vec branch, a static key
that is not a canonical array index must NOT reach the field-name fold: delegate
to `emitRuntimePropertyIntrospection` (same file, already present, already calls
`__hasOwnProperty`). The runtime prologue is proven correct by `__object_hasOwn`
answering `true` on the identical body — so this is a routing fix, not new
semantics. `object-ops.ts` is untouched by the reflection lane (verified:
they hold `object-runtime.ts` + `proto-index-store.ts`).

### Step 12 — step-3 REVERTED after the #4604 park. Do not retry here.

The step-3 arm is **removed from this worktree** (`object-ops.ts` back to base).
Two reasons, the second of which matters more than the first.

**1. The narrowing fix does not behave as designed, and I cannot explain it.**
`vecInfo !== null` was added to confine the arm to genuine vec receivers. Three
states, one script, one probe (`.tmp/three-state.sh`, reproducible):

| probe | base | over-broad arm | narrowed arm |
| ----- | ---- | -------------- | ------------ |
| K1 `C.hasOwnProperty('prototype')` | 0 | 0 | **1** |
| K3 `C.prototype.hasOwnProperty('constructor')` | 1 | 1 | **0** |
| K7 static own on constructor | 0 | 0 | **1** |

Base and the over-broad arm agree; the NARROWED one differs from both. Adding a
restriction cannot make an arm fire more often, so something other than the arm
is moving — an emission-order or late-import side effect of
`emitRuntimePropertyIntrospection` reaching the generic fold differently, most
likely. Unexplained is disqualifying for a change that already parked the queue.

**2. This worktree structurally CANNOT validate the fix.** The regression is a
composition with reflection's **P2**, which I was correctly told not to sync. On
integrated main P2 makes `C.hasOwnProperty('prototype')` answer `true`; here,
without P2, K1/K7 are **already wrong at base** (0). So every local class-receiver
measurement is of a different composition than the one that parked #4604 — a
local "green" would prove nothing and a local "red" mis-attributes. That is why
the over-broad arm looked harmless in this worktree (base == broad above) while
regressing 12 tests in the integrated branch.

**Consequence for whoever retries:** the fold-vs-runtime decision for
`hasOwnProperty` on a non-vec receiver must be validated **where P2 exists**.
The receiver-narrowing idea is still the right shape — the #3251 overlay and
#3537 bag are vec-only, so a non-vec receiver was never in scope — but it needs
to be measured against the P2 composition, with the 12 regressed
class-elements paths in the control set, not against this worktree's base.

**D-a (Step 9) is unaffected** — it is a separate commit (3829480e6) in
`vec-overlay.ts`, and its 3 flips do not depend on step 3.

### Step 11 result — LANDED (superseded by Step 12: reverted)

**Gate (b): 6 upward flips, 0 regressions** — the full D-a gate now stands at
6/8, and the 2 that remain are the ones correctly re-bucketed to #4497:

| test | before | after |
| ---- | ------ | ----- |
| `defineProperties/15.2.3.7-6-a-{180,181,182}` | fail | **pass** (D-a, unchanged by this step — no interaction) |
| `defineProperty/15.2.3.6-4-{184,185,186}` | fail | **pass** (this step) |
| `defineProperty/15.2.3.6-4-155`, `defineProperties/15.2.3.7-6-a-151` | fail | fail (#4497, expected) |

**Probe quartet + fold positive controls: 12/12.** The quartet is green
(`hasOwnProperty`, the `.call` spelling, `Object.hasOwn` still true, non-numeric
key still true) and — the part that matters for a fold change — **the world is
not un-folded**: plain-object own/absent, array canonical index in/out of
bounds, array absent non-index key, array named expando, `length` own, and
inherited `push` NOT own all keep their previous answers.

**Blast radius, base = HEAD (already contains D-a):**

| corpus check | result |
| ------------ | ------ |
| gc lane bytes | **identical** |
| standalone bytes | **identical** |
| functional outputs | **identical on all 23** |

Standalone bytes being identical here — where D-a moved 11 programs — is the
signature of the difference between the two fixes: D-a edited a runtime native
(which every standalone module links), this one changes a CALL-SITE routing
decision, so a program that never calls `hasOwnProperty` with such a key emits
byte-for-byte what it did before.

**Gate (a), seeded 200 (seed 20260815): 129/40/31 → 129/40/31, zero
pass→non-pass.** The population that burned 684 passes does not move.

`pnpm run typecheck`: clean. Files: `src/codegen/object-ops.ts` only.

### Step 10 — step-3 (`hasOwnProperty`) recon: the two predicates DIVERGE

Not implemented. Recon only, recorded so the next attempt starts from measured
facts rather than the plan's assumption.

The step-3 target was expected to be `fillVecHasOwnHelpers` — which lives in
**`vec-bag-seed.ts`** (moved out of `vec-overlay.ts`; NOT `object-runtime.ts`,
so no collision with reflection's `emitHasOwn`/`__extern_set` work). That
function unshifts ONE shared prologue into BOTH `__hasOwnProperty` and
`__object_hasOwn`, via a `for` loop over the two names.

**But the two answers diverge on the same receiver and key**, which the shared
prologue cannot explain:

| spelling | answer |
| -------- | ------ |
| `Object.hasOwn(a, "4294967295")` | **true** ✅ |
| `a.hasOwnProperty("4294967295")` | **false** ❌ |
| `Object.prototype.hasOwnProperty.call(a, "4294967295")` | **false** ❌ |
| `a.hasOwnProperty("foo")` (non-numeric, same overlay store) | **true** ✅ |

The generic `.call` spelling failing too rules out an Array.prototype
borrowed-method quirk. And `__vec_gopd` is NOT the problem: the prologue's
affirmative arm calls it, and `Object.getOwnPropertyDescriptor(a, K)` — which
reaches the same companion — returns `{value: 7}`.

So the open question for step 3 is narrow and specific: **why does the prologue
produce a different answer in `__hasOwnProperty` than in `__object_hasOwn` when
`fillVecHasOwnHelpers` unshifts the same instructions into both?** Candidates
worth instrumenting first: (a) `ctx.mod.functions.find(name)` not resolving
`__hasOwnProperty` at splice time (so it silently never gets the prologue —
the same class of failure as Step 8's dead code), or (b) an earlier prologue
already unshifted into `__hasOwnProperty` by another lane returning before
this one runs. Both are cheap to distinguish with a single emitted-body dump.

### Step 8 — implementation attempt: right native, WRONG WIRING POINT

Tried, measured, **reverted** (byte-identity confirmed zero residue).

The element read for a non-index key on a vec goes to `__vec_prop_get`
(`resolveNamedPropHelper` returns `VEC_PROP_GET` in standalone, deliberately NOT
`__extern_get` — see the `array-nonindex-key.ts` header on why the `__extern_*`
prologue would eat the key as an element). So `__vec_prop_get` IS the right
native to teach about the overlay.

**But its body is built too early.** Instrumented:
`[vpget] overlayLookup=undefined externHas=2097294` — `__vec_overlay_lookup`
does not exist yet when `fillVecPropHelpers` sets the body, exactly as
`vec-overlay.ts`'s own header warns ("the descriptor natives are built EARLY …
the per-carrier vec types and index helpers are only complete at FINALIZE").
The arm I added was therefore **dead code**: guarded on a `funcMap` miss, it
emitted nothing. Reverted rather than kept — an unvalidated change that fixes
nothing is the same call #4492 attempts 2 and 3 made, for the same reason.

**Correct wiring point:** a FINALIZE-time splice in `vec-overlay.ts`, beside the
existing overlay read prologues — `__extern_get_idx` (~L2093) and `__extern_get`
(~L2266). `__vec_prop_get` simply never got the third one. The `__extern_get`
prologue is a working template for the exact shape needed (probe companion →
answer if present → otherwise fall through untouched).

**Why the standalone lane misses while gc does not:** the gc/host lane reads
through `__extern_get`, which HAS the overlay prologue. Standalone routes to
`__vec_prop_get`, which does not. That asymmetry is the whole bug.

### Step 6 — CORRECTION: the store is NOT lost. Step 5 below was wrong.

Step 5 (kept underneath, struck through in effect) concluded the numeric
non-index define never lands. **Measured, that is false** — the store works and
only READS are blind. On `var a = []; Object.defineProperty(a, "4294967295",
{value:7,w/e/c:true})`:

| query | answer | |
| ----- | ------ | - |
| `Object.getOwnPropertyDescriptor(a, K)` | `{value: 7, …}` | ✅ stored |
| `Object.getOwnPropertyNames(a)` | includes `"4294967295"` | ✅ |
| `"4294967295" in a` | `true` | ✅ |
| `Object.hasOwn(a, K)` | `true` | ✅ |
| `a.hasOwnProperty(K)` | **`false`** | ❌ |
| `Object.prototype.hasOwnProperty.call(a, K)` | **`false`** | ❌ |
| `a[4294967295]` / `a["4294967295"]` | **miss** | ❌ |
| same key on a PLAIN OBJECT | both correct | ✅ control |
| `a.hasOwnProperty("foo")` (ordinary name, array) | `true` | ✅ control |

So the defect is **entirely read-side, and specific to a NUMERIC-LIKE key on a
vec receiver**: ordinary names on the same receiver are fine, the same key on a
plain object is fine, and `Object.hasOwn` — a different native — already answers
correctly on the very receiver `__hasOwnProperty` gets wrong.

**Single target.** A numeric-like key on a vec routes into the INDEXED lane
(that is what `markNumericLikeNamedKey`, #4434, arms it for). For a key that is
canonical-numeric but NOT an array index the parsed index is `-1`, the indexed
lane has nothing, and `__hasOwnProperty` + the element read answer "absent"
instead of falling through to the companion/bag. `Object.hasOwn`, `gOPD` and
`getOwnPropertyNames` already have that fall-through; `__hasOwnProperty` and the
element read do not. Fix = give those two the same fall-through, which is a
strictly narrower change than the store-side one Step 5 proposed.

Corollary for the slice's original framing: component **(2) "the ≥2^32-1 store
path" does not exist as a defect**. The whole D-a slice is component (1).

### Step 5 — where the D-a store is lost (SUPERSEDED by Step 6 above)

The substrate is NOT missing: #3251 built a full standalone array-descriptor
OVERLAY (`vec-overlay.ts`) — each vec receiver targeted by a descriptor op gets
a companion `$Object` that the hard parts delegate to. `defineProperty(arr,
"foo", …)` works through it today.

The define arm (`vec-overlay.ts` ~L1440) does `parseIndex(1, 7)` →
`i = __obj_index_of_key(key)`, then branches on `i >= 0`. A non-index key gets
`-1` and should fall through to the companion's named define — which is exactly
what `"foo"` does. `"4294967295"` also parses to `-1`, yet does **not** land.
The divergence to inspect first is the #4434 note at ~L1682, "canonical-numeric
named key → arm the indexed-lane flag": a numeric-SPELLED key that is not an
array index is steered into the indexed lane, where a key `>= 2^32-1` has no
slot and is dropped. That is the site to fix, not `__obj_index_of_key` (whose
`-1` answer is already correct here — contrast #4497, which is about the
range it answers `-1` for *wrongly*).

**Deliberately OUT of scope for this slice** (recorded, not fixed): a computed
STRING-NAME read on an array, `a["foo"]`, misses the bag while `a.foo` finds it,
because `nonArrayIndexNumericKey` admits only numeric/boolean SPELLINGS. Widening
it to arbitrary names means owning a reserved-name exclusion list — `arr["length"]`,
`arr["push"]`, `arr["constructor"]` must NOT route to the bag, and an incomplete
list silently breaks every borrowed prototype method. The 8 D-a tests do not need
it: they read back with a NUMERIC key (`arrObj[4294967295]`), which the existing
numeric arm already routes. Fixing it blind, unprompted by a test, is how that
hazard would land.

### F residual — module-goal-unreachable

`defineProperty/15.2.3.6-3-123.js` (`{ configurable: this }`) cannot be
reproduced or fixed under the module goal: it depends on SLOPPY-script `this`
being the global object (truthy). Compiled modules are always strict, where
`this` is `undefined` (falsy) and the shape already passes. Not a defect in the
MOP; parked here so it is not re-triaged as one.

## Validation

`TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/Object/defineProperty|built-ins/Object/defineProperties|built-ins/Object/create" pnpm run test:262`
— baseline 90 non-pass. gc-lane control on the same filter. Equivalence guard.

## 2026-08-19 re-census + dispatch

Fresh standalone baseline (`test262-standalone-current.jsonl`, 48,735 entries,
fetched 2026-08-19 04:52): standalone ES5 is **8,506 / 9,029 (94.2 %)** with
**523 non-passes** (495 fail, 24 compile_error, 4 compile_timeout). Earlier
figures in this file predate that and should be read as history.

This issue's lane in the 2026-08-19 6-way fan-out: **100 rows — defineProperty 47 + defineProperties 15 + rest-of-Object 38**.
Umbrella + full partition: #4163.

The residue is a **long tail** — the largest single error signature across all
523 rows is 13. Expect many small root causes, not one lever.

Local gate for this lane: 551 locally-verified-passing standalone ES5 tests must
stay at 551/551. Reproduce with the `--standalone` flag (without it you measure
the JS-host lane, a different and much worse corpus at 84.8 %).

**eval-rooted rows cannot be validated on the dev Mac** — CI's QuickJS eval tier
needs clang-18 (see #4163 for the full toolchain finding); record them as
blocked rather than chasing them.

## 2026-08-20 routing correction — Date writable-data own visibility

Fresh ES5 standalone triage for #4504 isolated
`built-ins/Object/defineProperty/15.2.3.6-4-408.js` from the inherited-`[[Set]]`
cohort. The write decision itself is already correct: a writable data descriptor
on `Date.prototype` permits `dateObj.prop = 1002`, and the value reads back as
`1002`. The failure is that direct/borrowed `hasOwnProperty` and `in` do not see
the Date instance's created expando (the statically typed Date introspection path
folds false), while the dynamic receiver path can observe it. This is a Date
carrier own-storage/visibility and `compilePropertyIntrospection` convergence
row, not a prototype-descriptor refusal row. #4504 explicitly excludes it from
its nine-test denominator; retain it here for the next MOP/introspection slice.

## 2026-08-21 void-in-argument-position slice (closes the void-undefined family)

**Root cause.** `inferParamTypeFromCallSites` narrowed an implicit-`any`
parameter from the TS type of the argument at each call site. For a purely-void
argument — `verifyEqualTo(arrObj, "0", getFunc())` where `getFunc` returns
nothing — `mapTsTypeToWasm` answers `i32` ("void → no result, handled in
codegen"). That answer is a lowering convention for a *result slot*, not a claim
that the argument is the number `0`, but the inference took it literally: the
harness parameter got an `i32` slot, the void call padded it with `i32.const 0`,
and the deprecated `verifyEqualTo` reported `Expected obj[0] to equal 0,
actually undefined` — with the **expected** side wrong, not the actual one.

**Fix** (`src/codegen/declarations/param-return-inference.ts`, +21 LOC, exactly
the shape of the #4555 under-application rule right above it): record a call
site whose argument type is exclusively `Void | Undefined`, and withdraw the
narrowing when the agreed type is a native scalar (`f64`/`i32`/`i64`) — those
have no encoding of `undefined`. The parameter stays on its resolved
`externref`, whose default value already IS the canonical undefined
(`pushDefaultValue` → `emitUndefinedValue` → the #2106 `$undefined` singleton in
standalone). The withdrawal is per parameter POSITION, so a numeric kernel with
a void argument in some other slot is untouched, and annotated parameters never
reach this inference at all.

**Measured** (serial single-test standalone probes, before/after on the same
worktree):

| test                                          | before | after |
| --------------------------------------------- | ------ | ----- |
| `Object/defineProperty/15.2.3.6-4-207.js`     | fail   | pass  |
| `Object/defineProperty/15.2.3.6-4-208.js`     | fail   | pass  |
| `Object/defineProperty/15.2.3.6-4-312.js`     | fail   | pass  |
| `Object/defineProperty/15.2.3.6-4-570.js`     | pass   | pass  |
| `Object/defineProperty/15.2.3.6-4-498.js`     | pass   | pass  |

Two 12- and 17-test control batches (arguments-object, function statements,
call/void expressions, Math/Array/Object/String/parseInt built-ins, and 12
`verifyEqualTo(..., getFunc())` defineProperty rows that already passed) are
**byte-identical before and after** — no regressions in the sample.

**Residuals deliberately NOT taken in this slice:**

- `15.2.3.6-4-195.js` still fails, but no longer on the void value — its
  `verifyEqualTo` now passes and it stops at `Expected obj[0] to be writable,
  but was not`. That is inherited-accessor `[[Set]]` dispatch, a different row.
- `[1, getFunc()]` — a void element mixed with numbers types the array
  `number[]` after the type mapper's union rule ("`T | undefined` for primitives
  → just use `T`"), so the element lands as `f64 0`. Pure `undefined[]`/`void[]`
  is already correct (#2806). Changing the union rule would move every
  `number | undefined` slot in the compiler and is out of scope here.

## 2026-08-21 bucket D re-triage + the uint32 `length` VALUE slice

**Bucket D was 26 rows in the 2026-08-15 triage; on this head it is 10.** Every
row in the file set that mentions a 2^32-boundary literal
(`built-ins/Object/define{Property,Properties}`, `built-ins/Array{,/length}`,
35 files) was re-run serially against my own HEAD before touching anything —
several had already been carried by the session's earlier slices (`15.2.3.6-4-
{184,185,186}`, `15.2.3.7-6-a-{180,181,182}`, `-{149,152,153}`,
`15.2.3.6-4-{153,156,157}` all pass now).

The 10 reproducing rows split into **three unrelated defects**, not one:

| part | rows | defect |
| ---- | ---- | ------ |
| **D-L** `length` **VALUE** in `[2^31, 2^32-1]` | `defineProperty/15.2.3.6-4-{154,155}`, `defineProperties/15.2.3.7-6-a-{150,151}`, `Array/length/15.4.5.1-3.d-3`, `Array/S15.4.5.2_A3_T3` | this slice (4 of 6 landed; 2 blocked, below) |
| **D-I** array **INDEX** at 2^32-2 must bump `length` to 2^32-1 | `defineProperty/15.2.3.6-4-183`, `defineProperties/15.2.3.7-6-a-179` | #4497 — needs the `vec-index-domain.ts` ceiling raised from 2^31-1 |
| **D-A** allocation | `Array/S15.4.5.2_A1_T1`, `Array/length/S15.4.5.2_A3_T4`, `Array/length/S15.4.2.2_A2.1_T1` | #4498 — `new Array(2^32-1)` / `x[2^31]=1` trap ("requested new array is too large" / "array element access out of bounds") |

(`Array/length/define-own-prop-length-overflow-realm.js` is eval-rooted and
cannot be validated here — no QuickJS provider on this box, per #4163.)

### Root cause of D-L: an explicit bail, not a truncation

`vec-overlay.ts`'s native `__vec_dp_value` `"length"` arm (the standalone
ArraySetLength) carried

```
// u ≥ 2^31 → legacy no-op (i32 vec length cannot represent it)
```

and **returned the receiver untouched**. So
`Object.defineProperty(arr, "length", {value: 2**32-2})` answered `0` — a wrong
answer with no error, invisible to every gate.

The premise is false in the direction that matters. STORING elements at such an
index does need sparse arrays; carrying the uint32 length VALUE does not — the
`$__vec_base` length field round-trips the whole u32 domain as a bit pattern,
and the readers that can observe a length ≥ 2^31 already widen it with
`f64.convert_i32_u` (the `__extern_get` `"length"` arm in `object-runtime.ts`,
added by the `vec-length-set.ts` slice, which had already made the *dynamic*
`arr.length = n` store unsigned). The define arm was the odd one out.

**Fix** (`src/codegen/vec-overlay.ts`, +38 −2): replace the bail with a
sparse-length arm — the same §10.1.6.3 `__vec_dp_value` legality delegate as the
in-range path (so a non-writable / non-configurable `length` still refuses),
then `vec.length = i32.trunc_sat_f64_u(u)`. The element machinery is skipped
deliberately: a length ≥ 2^31 is unbackable, so it is always a grow into sparse
territory with no real elements to create — exactly what the static
`maybeEmitVecLengthDefine` does above its own 16M ceiling. It also *cannot* use
the shrink loop below it, whose `i32.lt_s` against a newLen with a negative bit
pattern never terminates.

### Measured (serial single-test standalone probes, file-copy A/B on one head)

| set | files | base | branch | up | down |
| --- | ----: | ---: | -----: | -: | ---: |
| boundary candidates (every 2^32-literal file in the 4 dirs) | 35 | 23 pass | 27 pass | **4** | **0** |
| control: `Array/length/**` + `defineProperty/15.2.3.6-4-1*` + `defineProperties/15.2.3.7-6-a-1[4-9]*` | 204 | 186 pass | 191 pass | **5** | **0** |
| blast radius: seeded-120 sample of `built-ins/**/{name,length}.js` (the propertyHelper population) + 60 `push`/`pop`/`splice` | 180 | 103 pass | 103 pass | 0 | **0** |

Flips: `defineProperty/15.2.3.6-4-{154,155}`,
`defineProperties/15.2.3.7-6-a-{150,151}`, and — not predicted —
`defineProperty/15.2.3.6-4-116` ("length descriptor should be writable"), which
reads the descriptor back through the same companion the arm now populates.

Gates: `check:loc-budget`, `check:func-budget`, `check:coercion-sites`,
`check:oracle-ratchet` all OK (the `vec-overlay.ts` / `fillVecOverlayHelpers`
grants in this file's frontmatter cover it). `tsc` shows no error in any touched
file (510 pre-existing errors, 482 of them TS2591).

### ~~BLOCKED sub-item~~ — CLOSED 2026-08-21 (see the uint32-pair slice below)

The two assignment-form rows below landed together in the
"uint32 `length` ASSIGNMENT pair" slice at the end of this file. The analysis
that follows is retained because it is the reason the pair must move together.

### The two assignment-form rows

`Array/length/15.4.5.1-3.d-3` and `Array/S15.4.5.2_A3_T3` are the same defect on
the plain `arr.length = n` ASSIGNMENT form, and they need **two** one-word
changes, only one of which is in reach:

1. `emitArraySetLengthValidation` (`array-length-define.ts`) ends
   `i32.trunc_sat_f64_s` — signed, so a validated `2**32-1` SATURATES to
   2147483647. Its comment reads this as needing sparse arrays; per the argument
   above that is the wrong diagnosis, and `_u` is the fix. (Same for the
   assignment-expression result widening in `expressions/assignment.ts`.)
2. The STATIC `.length` READ of a vec receiver widens with
   `f64.convert_i32_s` — **`src/codegen/property-access-dispatch.ts` ~L2985**
   (verified by disassembling the emitted module: `$run` is
   `f64.convert_i32_s (struct.get $15 0 …)`). That file is held by another lane
   right now, so this slice does not touch it.

Both edits were **implemented and measured, then REVERTED**, because half of the
pair is worse than neither: with the unsigned store and the signed read,
`[].length = 2**32-1` answers **-1** where it used to answer 2147483647 — still
failing, no test won, and a behaviour change on every `arr.length = <≥2^31>`
with no way to validate it to green from here. Measured state of the pair, so
the next attempt does not re-derive it:

| probe | base | store `_u` only | store + read `_u` |
| ----- | ---- | --------------- | ----------------- |
| `var a=[]; a.length=2**32-1; a.length` | 2147483647 | −1 | (expected 4294967295 — unverified, read not touched) |

**Whoever holds `property-access-dispatch.ts` next: make the vec `length` read
`f64.convert_i32_u`, then flip the two truncations above.** Lengths below 2^31 —
every ordinary array — encode identically under either signedness, so the change
is inert outside the boundary band.

## 2026-08-21 defineProperties descriptor-map + Object.create edges (buckets Q, R)

**Method.** Every file in `built-ins/Object/defineProperties` (632) and
`built-ins/Object/create` (320) — 952 rows — run serially through
`runTest262File(..., "standalone")`, A/B against the identical 952 rows with the
change reverted by file copy (`.tmp/probe/ab.sh`, base copies captured at the
first edit). Plus 279 paired CONTROL rows: all of `language/statements/for-in`,
`built-ins/Object/{keys,getOwnPropertyNames}`, and 89 of
`built-ins/Object/getOwnPropertyDescriptor`.

**Result: 1,231 paired rows, 5 fail→pass, 0 pass→fail.**

| test | before | after |
| ---- | ------ | ----- |
| `create/15.2.3.5-3-1.js` | fail | **pass** |
| `create/15.2.3.5-4-1.js` | fail | **pass** |
| `defineProperties/15.2.3.7-6-a-198.js` | fail | **pass** |
| `defineProperties/15.2.3.7-6-a-203.js` | fail | **pass** |
| `defineProperties/15.2.3.7-6-a-209.js` | fail | **pass** |

### The buckets were much smaller than the triage estimated

Bucket Q was estimated at ~18 rows and R at ~13. Measured on this head, the two
directories together hold **19 non-passing rows**, of which **3 are
`JS2WASM_EVAL_ENGINE=quickjs` infrastructure blocks** — the provider does not
build in this container (`scripts/quickjs-artifact/build.sh` needs clang-18 +
network; the compiler-rt fetch returns non-gzip), the #4163 finding — so **16
are real**. Several rows in the 2026-08-20 gap list already pass on this head
(e.g. `create/15.2.3.5-4-263`, the get-only accessor descriptor). Bucket sizes
derived from error TEXT overstate; re-verify before scoping.

### Root causes fixed

1. **`Object.prototype.isPrototypeOf` had no reflective body**
   (`object-proto-is-prototype-of.ts`, new). `makeGlue`'s `Object` arm sent
   every member but `toString` to `emitObjectProtoOrRefusal`, so a *called*
   `isPrototypeOf` threw "not yet implemented in --target standalone". The
   compile-time folds in `native-is-prototype-of.ts` only fire for a receiver
   written literally as `<Ctor>.prototype`; the ordinary `b.isPrototypeOf(d)` on
   a constructed instance resolves the member off `Object.prototype` and lands
   on the reflective CLOSURE. The body routes to the existing `__isPrototypeOf`
   chain walk and boxes with `__box_boolean` (so `r === true` holds, not
   `1 !== true`). Both late imports are ensured BEFORE any instruction is
   emitted — a mid-body late import would shift this body's already-emitted
   `call`, and the shift fixer only repairs `ctx.currentFunc`.
   Probe controls, all correct: `Object.prototype.isPrototypeOf({})` true,
   `Array.prototype.isPrototypeOf([1,2])` true / `({})` false, own chain true,
   reverse false, self false, primitive/`undefined`/`null` arg false, 2-deep
   chain true, `typeof` `boolean`.

2. **A `Properties` map in a VARIABLE with non-literal entries refused**
   (`object-ops.ts`). `stableDescriptorMapEntries` (#3782) required every entry
   initializer to BE an object literal; `var properties = { "0": descObj }`
   declined, the closed WasmGC struct reached the native plural applier, and it
   threw `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`. Such an entry is now modelled as
   a PASS-THROUGH, and a map containing one is reified into a real `$Object`
   through the existing `compileDescriptorMapAsDynamicObject` builder rather
   than expanded per key — the native applier is the only path with
   ToPropertyDescriptor's conflict/callable checks and it preserves
   §20.1.2.3.1's gather-all-then-define-all order. An all-literal map with no
   merged field write keeps the pre-existing per-key expansion untouched, so
   the paths that already worked emit exactly what they did.
   Note the pre-existing limitation this did NOT change: the stability visitor
   treats a SECOND read of the map variable as instability, so
   `Object.defineProperties(a, props); Object.defineProperties(b, props)`
   declines both.

3. **`for…in` enumerated array indices whose descriptor says
   `enumerable: false`** (`vec-index-enumerable.ts`, new). The descriptor was
   already recorded correctly — `getOwnPropertyDescriptor(a,"0")` reads
   `1001/true/false/true` — only the enumeration disagreed, because
   `emitArrayForIn`'s native lane walks `"0" … "length-1"` unconditionally. The
   new native answers from the #3251 overlay companion and joins the existing
   #4222 presence gate inside the loop's `$continue` block (same `br_if 0`
   shape, so the user body's break/continue depths are untouched). Reserve-then-
   fill like `__vec_overlay_push_keys`, because `__vec_overlay_lookup` is only
   minted at finalize; a skipped fill degrades to the placeholder `1`, i.e. the
   previous answer. Demand gated on `vecOwnKeysDirty`, so a module that never
   mentions a descriptor/own-key builtin gets no native, no call, no local.

### Diagnosed but NOT taken — with the measurement, so it is not re-derived

- **`defineProperty/15.2.3.6-3-138` is NOT an inherited-accessor
  ToPropertyDescriptor bug.** The dispatch brief named it as a §8.10.5 step-5.a
  prototype-walk failure. Measured, `__desc_has_own` already does the full
  §7.3.12 chain walk (#4163) and `"value" in child` answers `true`. The real
  condition is on the RECEIVER: `Object.defineProperty(o, K, desc)` where `o`
  is a compiler-CLOSED struct that already has a declared field `K` and `desc`
  is anything other than an INLINE object literal writes the descriptor into
  the dynamic store while the static `o.K` read still returns the struct field.
  Sweep (`.tmp/probe/pa.js`, `pb.js`), one program, standalone:
  | receiver | descriptor | `o.p` after |
  | -------- | ---------- | ----------- |
  | `{}` | constructed instance w/ own `value` | 42 ✅ |
  | `{q:1}` | constructed instance w/ own `value` | 42 ✅ |
  | `{p:120}` | INLINE `{value:42}` | 42 ✅ |
  | `{p:120}` | `var dsc = {value:42,w/e/c:true}` | **120** ❌ |
  | `{p:120}` | constructed instance | **120** ❌ |
  The descriptor CARRIER (constructed instance, inherited field, set-only
  accessor) is irrelevant — only receiver-shape × descriptor-spelling matters.
  One row in the current red set; the fix belongs with the sidecar/struct-field
  convergence work, not here.
- **`defineProperties/15.2.3.7-6-a-{204,231}` are the typed-lane/aliasing gap,
  not descriptor gaps.** `p5`/`r2` show the accessor at index `"0"` installs,
  invokes, and reports the right descriptor when read directly. What fails is
  reading it back through anything but the original identifier
  (`.tmp/probe/s3.js`, one program):
  `arr[0]` → 101 ✅ · `var idx=0; arr[idx]` → 101 ✅ ·
  `var alias = arr; alias[0]` → **0** ❌ · `f(arr,0)` (param monomorphized to
  the vec) → **0** ❌ · `f(arr,0)` (polymorphic param) → **undefined** ❌ ·
  `f.call(null,arr,0)` → **undefined** ❌ · `f(arr,"verifySetter")` →
  **undefined** ❌ while `arr["verifySetter"]` → 100 ✅.
  That is #4159's own subject (a `propertyHelper.js` parameter on the typed
  lane) plus an ALIAS leak the #4159 note does not mention: the route is keyed
  on the identifier, so `var alias = arr` escapes it. Needs its own slice.
- **`defineProperties/15.2.3.7-6-a-183` is a value-representation row.**
  `arr=[1,2,3]` is a `__vec_f64`; `defineProperties(arr,{"1":{value:"abc"}})`
  cannot store a string in it. Control: the same define with `length` still
  writable also leaves `arr[1] === 2`, and `arr[1] = "zzz"` gives `NaN` — so
  the non-writable `length` in the test is a red herring.
- **`defineProperties/15.2.3.7-2-16` and `create/15.2.3.5-4-15` need the
  ARGUMENTS object, not the descriptor map.** Both assert
  `'[object Arguments]' === Object.prototype.toString.call(this)` inside a
  getter on the `Properties` object. Measured (`.tmp/probe/q3.js`): an
  arguments object here tags `[object Object]`, reports `length: 0` for
  `new Fun(1,2)`, and `Object.defineProperty(args,"bar",{...})` lands nowhere
  (`hasOwnProperty` false, `gOPD` null) while a plain `args.foo = 7` expando
  works. Three separate gaps upstream of anything `defineProperties` can fix.
- **`Object.keys` / `getOwnPropertyNames` still enumerate a non-enumerable
  array index** (`Object.keys(a)` → `["0"]` for the fix-3 array). They reach the
  key list through `__vec_overlay_push_keys` and the `__object_keys` vec arm —
  different wiring, no row in this bucket asserting it, and widening both at
  once would make one regression indistinguishable from the other.
- `15.2.3.7-6-a-{150,151,179}` remain #4497 (the 2^32 `length` boundary);
  `15.2.3.7-6-a-113` is an `Array.prototype.length` value read inside a closure
  (`illegal cast`), a builtin-prototype-value row.

## 2026-08-21 uint32 `length` ASSIGNMENT pair (closes the D-L residual)

Closes the "BLOCKED sub-item" above. `property-access-dispatch.ts` was held by
another lane when that note was written; this slice holds it, so the pair moved
together as the note prescribed.

**The three edits (one semantic change, three sites):**

| file | site | was | now |
| ---- | ---- | --- | --- |
| `src/codegen/array-length-define.ts` | `emitArraySetLengthValidation` tail | `i32.trunc_sat_f64_s` | `i32.trunc_sat_f64_u` |
| `src/codegen/expressions/assignment.ts` | `arr.length = v` expression result | `f64.convert_i32_s` | `f64.convert_i32_u` |
| `src/codegen/property-access-dispatch.ts` | the 9 static vec-`.length` READ widenings (L799, 2819, 2843, 2881, 2932, 2964, 2979, 2986, 3007) | `f64.convert_i32_s` | `f64.convert_i32_u` |

All nine dispatch sites are `struct.get <vec> fieldIdx 0` — the length/element
count of a length-prefixed vec, an ArrayBuffer byteLength, or a `$__ta_view`
effective length. Every one of those is a non-negative uint32 by construction,
so `_u` is the correct widening at each; lengths below 2^31 encode identically
under either signedness, which is why this is inert outside the boundary band.
Only flipping the ONE site the disassembly named would have left the other eight
answering `−1` for the same array reached through a different static shape.

**Measured** (serial single-test standalone probes, file-copy A/B on one head —
base copies in `.tmp/base/`, captured at the first edit):

| test | before | after |
| ---- | ------ | ----- |
| `Array/length/15.4.5.1-3.d-3.js` | fail (`2147483647`) | **pass** |
| `Array/S15.4.5.2_A3_T3.js` | fail (`2147483647`) | **pass** |

Paired control A/B, 473 rows — all of `built-ins/Array/length`,
`Array/prototype/{join,push,splice,slice,pop}`, 40 `indexOf`, 25
`String/prototype/slice`, the `defineProperty/15.2.3.6-4-1**` band and the
`defineProperties/15.2.3.7-6-a-1[4-9]*` band:
**base 328 pass → after 329 pass, 1 up, 0 down.**

The landed boundary flips named as must-stay-green controls
(`15.2.3.6-4-{154,155,116}`, `15.2.3.7-6-a-{150,151}`) are all still `pass`,
as are `Array/length/S15.4.5.1_A1.{1,2,3}_T1`.

Direct value probe (`.tmp/probe/len1.js`), one program, standalone:
`a.length = 4294967295` → `4294967295` · `(b.length = 4294967294)` →
`4294967294` (assignment RESULT, the second half of the pair) ·
`[1,2,3].length` → `3`, shrink to `2` → `"1,2"` · `d.length = 4294967296` →
`RangeError` thrown, as §10.4.2.4 step 3 requires.

Gates: `check:loc-budget`, `check:func-budget`, `check:coercion-sites`,
`check:oracle-ratchet` all exit 0. `tsc` reports no error in any of the three
touched files.

## Wave-3 dispatch plan (2026-08-21, toward 100% ES5 standalone)

328 rows remain (`.tmp/es5-remaining.txt`, derived from the 20260821-122045
scoped run minus the 14 post-measurement flips). Four parallel lanes, each an
Opus worktree agent with reproduce-first discipline and per-lane file
ownership; briefs carry the banked per-cluster diagnoses from this file,
#4206 (25-row statements/function clustering), #2875 (String residuals), and
#2071. Lanes: (A) statements/function + types/object|reference — seeds: the
kind-changing member-update growable trigger (`m.foo++` on a string field
answers null, probe n1), the banked f.prototype/constructor and
typeof-before-var heads; (B) Array/prototype + keys/gOPN — seeds: the
declined keys/gOPN enumerability widening, the alias leak; (C)
defineProperty/defineProperties + Object/prototype — seeds: the 138
static-read/dynamic-store divergence, arguments-object define rows; (D)
Function/prototype + instanceof — seeds: the C2 provider-dependence
re-measure, apply/call receiver family, aliased-ctor instanceof. String +
RegExp + assignment queue for the next free slot.

## 2026-08-21 wave-3 lane B — §10.4.3 String-exotic own KEYS (the enumeration half of #4232)

`hasOwnProperty` has answered String-exotic own properties correctly since
#4232. Nothing else did: the key list for `Object.keys` / `getOwnPropertyNames`
/ `for…in` is built by walking the `$Object` own-props TABLE, and a String
exotic's `length` and indices are DERIVED from the `[[PrimitiveValue]]`
[[StringData]], not stored as table entries. Measured on this branch,
`--target standalone`, before the fix (`.tmp/probe/s11.js`, `s13.js`, one
program each):

| expression | before | after | spec |
| ---------- | ------ | ----- | ---- |
| `Object.keys("abc")` | `[]` | `["0","1","2"]` | ✅ |
| `Object.keys(new String("abc"))` | `[]` | `["0","1","2"]` | ✅ |
| `Object.getOwnPropertyNames(new String("abc"))` | `["[[PrimitiveValue]]"]` | `["0","1","2","length"]` | ✅ |
| …then `str[5] = "de"` | `["5","[[PrimitiveValue]]"]` | `["0","1","2","5","length"]` | ✅ |
| `Object.getOwnPropertyNames("ab")` | `[]` | `["0","1","length"]` | ✅ |
| `"0" in new String("abc")` | **false** | `true` | ✅ |
| `for (p in new String("abc"))` | `[]` | `["0","1","2"]` | ✅ |

**Three defects, one slice** — they are not separable, and the middle one is
why the naive fix is a net ZERO:

1. **No index keys in the enumerators.** New native `__strexo_push_keys(obj,
   vec) -> i32` (`src/codegen/string-exotic-own-props.ts`) resolves the
   [[StringData]] from either receiver shape — a `new String` wrapper
   (`$Object` + the reserved slot) or a PRIMITIVE string reaching
   `Object.keys("abc")` (the `$AnyString` itself; standalone does not
   materialize the call-site ToObject) — and pushes `"0" … "len-1"`. Spliced as
   a one-call prologue into `__object_keys`, `__object_keys_forin` and
   `__getOwnPropertyNames`. Those indices are the LOWEST by construction (an
   index below the [[StringData]] length is non-configurable, §10.4.3.5, so a
   `defineProperty` can never create a competing table entry), which is why
   pushing them ahead of the table walk IS OrdinaryOwnPropertyKeys order rather
   than an approximation of it. `length` is a non-index key, so gOPN appends it
   AFTER the table walk — `str[5]="de"` must read `[…,"5","length"]`, not
   `[…,"length","5"]` — and `Object.keys` never gets it (non-enumerable).
2. **`[[PrimitiveValue]]` leaked out of gOPN.** The all-keys walk pushed every
   live entry; the reserved FLAG_INTERNAL slot is not an own property.
   `Object.keys` was never affected — its walk is `__obj_ordered`, which
   filters by [[Enumerable]].
3. **`__extern_has` did not know about String-exotic indices**, so `"0" in str`
   was `false`. Fixing only (1) is a NET ZERO, not a +1: `Object/keys/
   15.2.3.14-6-3` asserts `for…in` and `Object.keys` AGREE on a String object,
   and it had been passing **vacuously** because both were empty. Teaching the
   enumerator alone turned that vacuous pass into a real `pass → fail` while
   flipping two others — measured, not predicted. The for-in loop re-checks
   each key's liveness with `__extern_has` (#2066), so every index key the
   enumerator produced was discarded one instruction later; #4232 had taught
   only the OWN predicate. The same consult-only prologue on `__extern_has` is
   sound (an own property IS a HasProperty hit) and closes it.

**Measured**, serial single-test standalone probes, file-copy A/B on one head
(base copies captured at the first edit in `.tmp/base/`):

| control set | rows | base | after |
| ----------- | ---- | ---- | ----- |
| all of `Object/{keys,getOwnPropertyNames}` + `getOwnPropertyDescriptor` + the `defineProperties/15.2.3.7-6-a-19*/20*` for-in-enumerability band + `String/prototype/{toString,valueOf}` + `language/statements/for-in` | 225 | 187 pass | **190 pass** |
| `language/expressions/in` + `Object/{hasOwn,prototype/hasOwnProperty,prototype/propertyIsEnumerable}` + `Array/prototype/{indexOf,every}` + `String/prototype/indexOf` + `built-ins/String` + more `for-in` | 327 | 272 pass | **272 pass** |
| **total** | **552** | **459** | **462** — 3 up, **0 down** |

Flips: `Object/keys/15.2.3.14-1-3`, `Object/getOwnPropertyNames/15.2.3.4-4-44`
(both assigned rows) and `Object/getOwnPropertyNames/non-object-argument-valid`
(unassigned bonus). The `vec-index-enumerable.ts` for-in gate stays green —
`defineProperties/15.2.3.7-6-a-{198,203}` both still `pass`. The one non-flip
message change in the second set is a func-INDEX shift inside a pre-existing
`CompileError` (`#452` → `#453`), expected from adding a native.

Gates: `check:loc-budget`, `check:func-budget`, `check:coercion-sites`,
`check:oracle-ratchet` all exit 0. `tsc` reports no error in any touched file.

### Follow-ups this slice deliberately did NOT take

- **`const FLAG_INTERNAL_SLOT = 0x10` in `object-runtime-descriptors.ts` is an
  invariant living only in prose.** It duplicates `FLAG_INTERNAL` in
  `object-runtime.ts` rather than importing it, purely so this wave's diff in
  the C-lane-fenced file stays one contiguous region (one import + five hunks,
  all inside the `__getOwnPropertyNames` block). A follow-up should export the
  flag from the owning module and import it here — see the #4082 result-boxing
  header for why this repo treats prose invariants as a defect.
- **`for…in` over a PRIMITIVE string enumerates `String.prototype`'s methods**
  (`toString|charAt|charCodeAt|…`, measured) instead of `["0","1","2"]`. A
  separate receiver-classification bug in the static-unroll path, untouched.
- **`Object.keys({"": "empty"})` is `[]`** — an empty-string property key is
  dropped before the runtime sees it (`gOPN` also `[]`), so
  `getOwnPropertyNames/15.2.3.4-4-b-3` still fails for a reason upstream of
  key enumeration.

## 2026-08-21 wave-3 lane C — the `arguments` [[ParameterMap]] cluster (6 rows)

All 36 of lane C's rows were re-run serially on this head before any edit; all
36 reproduced, so nothing below is inherited from the dispatch list.

The dispatch brief expected these six to need "a new arguments carrier". They
did not. The cluster is **two independent defects in the existing mapped-args
machinery**, and both are visible from one three-line probe.

### Defect 1 — the mapped/unmapped split depended on how the function was SPELLED

`compileFunctionBody` has installed `mappedArgsInfo` for function DECLARATIONS
since #849. `compileLiftedClosureBody` builds the identical arguments vec for a
function EXPRESSION and never installed it, so every mapped emitter
(`emitMappedArgParamSync`, `emitMappedArgReverseSync`, the
`Object.defineProperty(arguments, …)` arms) was simply off for the expression
form. Measured, one program (`.tmp/probe/p3.js`), standalone:

| form | `arguments[0] = 9` → `a` | `defineProperty(arguments,"0",{value:9})` → `a` |
| ---- | ------------------------ | ---------------------------------------------- |
| `function g(a,b,c)` (declaration) | 9 ✅ | 9 ✅ |
| `var m = function (a,b,c)` (expression) | 0 ❌ | 0 ❌ |

Every one of the six failing tests is an IIFE — `(function (a,b,c) { … }(0,1,2))`
— which is why the whole cluster reads as an "arguments object" gap.

Fix: install `mappedArgsInfo` in the existing `needsImplicitArgumentsObject`
block of `compileLiftedClosureBody`, gated exactly as the declaration path is
(§10.2.11 step 22.a: `isSimpleParameterList` ∧ ¬`isStrictFunction`), with
`paramOffset: 1` because a lifted closure carries `__self` at local 0 — the
same shape `new-super.ts` already uses for lifted methods. `__unbox_number` is
ensured beside the `__box_number` the block already ensured: the forward sync
boxes a param INTO the slot, the reverse sync unboxes back OUT into it, and only
the first half was present (the reverse sync degrades silently when the import
is missing).

### Defect 2 — §10.4.4.2 sequenced Map.[[Delete]] before Map.[[Set]]

With defect 1 fixed the six tests still failed, because their first define is
`{value: 10, writable: false, …}`. Step 5.b of ArgumentsExotic.[[DefineOwnProperty]]
is ordered: **5.b.i `Map.[[Set]](P, Desc.[[Value]])` — which writes the linked
formal parameter — and only then 5.b.ii `Map.[[Delete]](P)` when `writable` is
present and false.** The compiler severed the link while PARSING the descriptor
(`unmappedIndices.add`), then routed the define to the runtime, which writes only
the arguments slot. So `a` kept its old value:

| probe (`.tmp/probe/p4.js`, declaration form, so defect 1 is not in play) | before | after |
| --- | --- | --- |
| `defineProperty(arguments,"0",{value:20,writable:false,e:false,c:false})` → `a` | 0 ❌ | 20 ✅ |
| …then a second `{value:20}` → TypeError, `a` | threw ✅, `a` = 0 ❌ | threw ✅, `a` = 10 ✅ |
| its `getOwnPropertyDescriptor` | `20/false/false/false` ✅ | unchanged ✅ |

Fix: `compileObjectDefineProperty` is now an 8-line wrapper around the unchanged
body (`compileObjectDefinePropertyCore`). When the core hands a mapped-index data
define with an explicit `[[Value]]` to the generic path, it records the debt; the
wrapper emits step 5.b.i **after** the define, reading the value back out of the
arguments slot the define just wrote. That evaluates the descriptor exactly once
and makes the two steps land in spec order (the emitter's severed-index check is
re-opened for the duration of that one emission). The core records the debt
rather than the wrapper re-deriving the fast-path predicate, so the two cannot
disagree about which defines the inline path took.

### The interlock this exposed, and the regression it caused

Marking a mapped index as "now runtime-defined" was necessary — otherwise a
later `{value: 20}` takes the inline fast path, writes the opaque vec slot, and
leaves the sidecar descriptor reporting the OLD value (`15.2.3.6-4-293-3`
failed exactly there: `0 descriptor value should be 20`). But the first cut
stopped at that, and the inline path is also the only one that wrote the
parameter — so `Object.defineProperty(arguments,"0",{configurable:false})`
followed by `{value:2}` stopped updating `a`. **The 812-row control caught it:
+6 / −4.** Four `language/arguments-object/mapped/*` rows regressed. Generalising
the debt to *every* generic-path value define on a still-mapped index (not just
the `writable:false` one) fixes both directions; the re-run is below.

### Measured — paired A/B, 812 rows, serial single-test standalone probes

Set: all of `language/arguments-object` (263) + all of
`language/expressions/function` (264) + `built-ins/Object/defineProperty/15.2.3.6-4-{2,3}*`
(285). Base copies captured at the first edit (`.tmp/base/`), A/B by file copy on
one head.

| | base | after |
| --- | --- | --- |
| pass | 699 | **706** |
| fail | 107 | 100 |
| compile_error | 6 | 6 |

**7 up, 0 down.** The six targets — `defineProperty/15.2.3.6-4-{292-1, 293-2,
293-3, 294-1, 295-1, 296-1}` — plus one not predicted:
`language/arguments-object/mapped/nonconfigurable-descriptors-set-value-with-define-property.js`,
which is defect 2 in its own words.

Gates: `check:loc-budget`, `check:func-budget`, `check:coercion-sites`,
`check:oracle-ratchet` all OK (grants added to this file's frontmatter — note
`compileObjectDefinePropertyCore` is a RENAME, not growth). `tsc` reports no
error in `closures.ts`, `object-ops.ts` or `context/types.ts`.

### Diagnosed but NOT taken (measured, so it is not re-derived)

- **An ACCESSOR define on a mapped index does not install the accessor.**
  `(function (a) { Object.defineProperty(arguments, "0", { get: function () {
  return 10; } }); return arguments[0]; })(0)` answers **0**, not 10 — §10.4.4.2
  step 5.a severs the map and the property becomes a real accessor, but the
  compiled `arguments[i]` read still goes to the vec slot. No row in lane C
  needs it (all six are data descriptors), and it needs the element READ to
  consult the sidecar, which is the same convergence the 3-138 row wants.
- **`defineProperties/15.2.3.7-2-16` and `create/15.2.3.5-4-15` are unchanged**
  by this slice, and the earlier note about them needs one correction: an
  arguments object tags `[object Arguments]` correctly and reports the right
  `length` **inside** its function — measured on this head (`.tmp/probe/p1.js`):
  `len=3`, `cls=[object Arguments]`, `defineProperty(arguments,"bar",…)` lands
  and `hasOwnProperty("bar")` is true, `gOPD(arguments,"0")` round-trips. What
  those two tests need is the arguments object as the `Properties` MAP after it
  has ESCAPED its function (`var props = new Fun()` / `return arguments`): the
  escaped value no longer answers the vec-carrier test, so
  `__defineProperties` refuses with `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`
  (`object-runtime-descriptors.ts` `nonVecFallback`). That is a carrier-identity
  row, not an arguments-MOP row.

## 2026-08-21 wave-3 lane C — §10.1.6.3 step 4.c lost its IsGenericDescriptor precondition

`built-ins/Object/defineProperty/15.2.3.6-4-59` defines an accessor and then
redefines it with an EMPTY descriptor, `Object.defineProperty(obj, "foo", {})`,
which §10.1.6.3 makes a no-op. Standalone threw
`Cannot redefine property: cannot convert a non-configurable accessor to a data
property`.

**Root cause.** The `__defineProperty_value` ValidateAndApply preflight
(`object-runtime-descriptors.ts`, `s4Preflight`) implements step 4.c as "current
entry is an accessor ⇒ throw". The spec's step 4.c is guarded: *"If
IsGenericDescriptor(Desc) is **false** and IsAccessorDescriptor(Desc) is not
IsAccessorDescriptor(current)"*. A descriptor mentioning neither `[[Value]]` nor
`[[Writable]]` converts nothing, so it must not reach 4.c at all. The apply path
20 lines below already had this right — its `keepAccessor` arm is literally
"existing accessor AND a GENERIC desc … the accessor halves stay live" — so the
preflight was throwing before its own correct implementation could run.

**Fix.** Wrap the existing throw in an `hf & (HOST_HAS_VALUE |
HOST_WRITABLE_SPECIFIED)` test. Steps 4.a/4.b, which run BEFORE 4.c, still reject
a generic descriptor asking for `configurable: true` or a different `enumerable`,
so nothing that must throw stops throwing.

**Control matrix** (`.tmp/probe/p6.js`, one program, standalone — the
must-still-throw rows are the point):

| probe | before | after | expected |
| ----- | ------ | ----- | -------- |
| E `{}` over a NON-configurable accessor | **throws** | `function/function/false/false` | no-op ✅ |
| F `{value:1}` over a NON-configurable accessor | throws | **throws** | TypeError ✅ |
| G `{writable:true}` over a NON-configurable accessor | throws | **throws** | TypeError ✅ |
| K `{enumerable:true}` over a NON-configurable, non-enumerable accessor | throws (4.b) | **throws (4.b)** | TypeError ✅ |
| L `{configurable:true}` over a NON-configurable accessor | throws (4.a) | **throws (4.a)** | TypeError ✅ |
| I `{enumerable:true}` where current already IS enumerable | **throws** | `function/true/false` | no-op ✅ |
| J `{configurable:false}` over a NON-configurable accessor | **throws** | `function/false` | no-op ✅ |
| H `{value:7}` over a CONFIGURABLE accessor | `7/undefined` | `7/undefined` | conversion ✅ |
| M `{}` over a plain data prop | `5/true` | `5/true` | no-op ✅ |
| N `{}` over a non-writable non-configurable data prop | `5/false/false` | unchanged | no-op ✅ |
| O `{}` on an ABSENT key | `undefined/false/false/false` | unchanged | creates ✅ |
| P `{enumerable:true}` over a CONFIGURABLE accessor | `function/true/true` | unchanged | attrs only ✅ |

**Measured — paired A/B, serial single-test standalone probes, base = the
commit above (file-copy revert):**

| set | rows | base | after | up | down |
| --- | ---: | ---: | ----: | -: | ---: |
| `Object/{freeze,seal}` (147) + `defineProperty/15.2.3.6-4-<1-2 digit>*` (122) + every 3rd `getOwnPropertyDescriptor` (104) + `defineProperties/15.2.3.7-{5-b-2xx,6-a-<1-2 digit>}` (156) | 529 | 509 pass | 510 pass | **1** | **0** |
| all of `built-ins/Object/create` — the plural applier calls this same native | 320 | 319 pass | 319 pass | 0 | **0** |

The single flip is `15.2.3.6-4-59`. Gates: `check:loc-budget`,
`check:func-budget`, `check:coercion-sites`, `check:oracle-ratchet` all OK;
`tsc` reports no error in the touched file.

### Adjacent defect found while probing, NOT fixed here

`Object.defineProperty(o, k, { get: g })` where `g` is a VARIABLE holding
`null` does **not** throw (`.tmp/probe/p5.js` row D) — §6.2.5.6 requires a
TypeError for a `get` that is present, not undefined and not callable. The
LITERAL spelling `{ get: null }` is caught at compile time (#3116), which is why
`create/15.2.3.5-4-258` and `defineProperties/15.2.3.7-5-b-218` still pass. The
runtime reader's singleton arm normalises the undefined singleton to a null slot
and then cannot tell the two apart. Fixing it means giving the reader a
representation that distinguishes "present undefined" from "present null" — the
#2106 value-representation lane, not this one.

### 15.2.3.6-4-21 is NOT the `get: undefined` bug it looks like

Its shape — install `{set: setter}`, then redefine with `{get: getter}` where
`getter` is `undefined` — is **already correct on this head** when it runs inside
a function (`.tmp/probe/p5.js` row A: `d2.get === getter` ✅, `d2.set === setter`
✅, `configurable`/`enumerable` both `false` ✅). The test declares its bindings
at TOP LEVEL, so whatever it hits is a module-scope binding/shape difference, not
the descriptor reader. Recorded so the next attempt starts from the probe rather
than from the error text.

## 2026-08-21 wave-3 lane C — the remaining 29 rows, triaged from SOURCE

Lane C's slice was 36 rows (`defineProperty` 20, `defineProperties` 6,
`getOwnPropertyDescriptor` 3, `create` 1, `Object/prototype` 6). All 36 were
re-run serially on this head before any edit and all 36 reproduced; **7 now
pass** (the six `[[ParameterMap]]` rows plus `15.2.3.6-4-59`). The other 29 are
grouped below by the defect that actually causes them — each line is what was
measured, not what the error text says.

| n | rows | root cause | owner |
| -: | ---- | ---------- | ----- |
| 3 | `Object/prototype/valueOf/S15.2.4.4_A1_T{1,2,3}` | `new Object(<primitive>)` does not build a primitive WRAPPER, so `__dyn_valueOf` (`wrapper-valueof.ts`) finds no `WRAPPER_PRIMITIVE_KEY` slot and falls to its identity arm. The error text renders as `SameValue(«1.1», «1.1»)` because the wrapper stringifies as its primitive — a TYPE bug that reads as a VALUE bug, exactly as that module's header warns. Fix belongs at the `new Object(x)` lowering, not the valueOf helper. | value-representation |
| 3 | `defineProperty/15.2.3.6-4-{195,243-1,243-2}`, `defineProperties/15.2.3.7-6-a-{204,231}` (5 rows, 3 distinct shapes) | accessor installed at an ARRAY INDEX: it installs and reports the right descriptor, but the element READ/WRITE does not dispatch through it. This is #4159's typed-lane subject plus the alias leak already recorded above. | array lane (#4159) |
| 3 | `defineProperty/15.2.3.6-4-183`, `defineProperties/15.2.3.7-6-a-179`, and the `length` half of `-113` | array INDEX at 2^32-2 must bump `length` to 2^32-1 | #4497 (`vec-index-domain.ts` ceiling) |
| 2 | `defineProperty/15.2.3.6-4-117`, `defineProperties/15.2.3.7-6-a-113` | `Array.prototype.length` read inside a closure → `illegal cast` | builtin-prototype-value |
| 2 | `getOwnPropertyDescriptor/15.2.3.3-4-{34,116}` | `gOPD(Function.prototype, "constructor")` / `gOPD(Date.prototype, "constructor")` answer nothing. Verified against `Object`/`Array`, which answer `true/true/false/true` correctly — so this is not a gOPD gap but the DECLINE that `builtin-proto-constructor.ts` (#4200) documents in its own header: Date, String, Number, Boolean and Function have no identity-stable carrier, and minting one changes what the BARE identifier reads. Explicitly deferred there, not here. | #4200 follow-up |
| 2 | `defineProperties/15.2.3.7-2-16`, `create/15.2.3.5-4-15` | the arguments object as the `Properties` MAP after it has ESCAPED its function — see the correction above; a carrier-identity row, not an arguments-MOP row | carrier identity |
| 2 | `defineProperty/15.2.3.6-{3-123,625gs}`, `S15.2.3.6_A1` (3 rows) | module-goal-unreachable or host-shaped: `3-123` needs sloppy-script `this` (already parked above); `625gs` needs a global `var` to win over `Object.prototype`; `S15.2.3.6_A1` reaches `Document.createElement` | out of lane |
| 1 | `defineProperty/15.2.3.6-3-138` | the banked static-read/dynamic-store divergence (closed struct already declaring the key + non-inline descriptor). Confirmed still reproducing; needs the property-access convergence, which is another lane's file. | struct/dyn convergence |
| 1 | `defineProperty/15.2.3.6-4-21` | NOT the `get: undefined` bug it looks like — see the probe above; the same shape is already correct inside a function, so it is a top-level-binding difference | unclassified |
| 1 | `defineProperty/15.2.3.6-4-408` | Date-instance own-storage visibility (already routed here 2026-08-20) | Date carrier |
| 1 | `defineProperty/15.2.3.6-4-589` | a Date object stored through a prototype-chain accessor reads back `NaN` | value-representation |
| 1 | `defineProperty/15.2.3.6-4-622` | `verifyProperty(Date, "now", …)` — `Date.now`'s own descriptor is correct (`function/true/false/true`, probed), so the failure is elsewhere in `verifyProperty`'s walk | unclassified |
| 1 | `getOwnPropertyDescriptor/15.2.3.3-4-4` | `gOPD(globalThis, "eval")` | global object |
| 1 | `Object/prototype/S15.2.4_A1_T2` | `delete Object.prototype.toString` then calling it must throw | builtin-proto delete |
| 1 | `Object/prototype/constructor/S15.2.4.1_A1_T2` | `new (Object.prototype.constructor)` — "is not a constructor" | #4200 follow-up |
| 1 | `Object/prototype/valueOf/S15.2.4.4_A14` | `(1, Object.prototype.valueOf)()` must throw on an undefined `this` | ToObject on undefined |

Nothing in this table is blocked on the descriptor MOP itself any more: the two
slices above closed the last rows whose cause lived in `object-ops.ts` /
`object-runtime-descriptors.ts`.

## Wave-3 lane A, slice 1 (2026-08-21) — 5 of 41 rows closed

Measured on `claude/pull-from-upstream-zgdo0m` @ `1d57d9229a`, `--target
standalone`, single-test in-process runner, QuickJS eval provider built
locally (artifact `13c33e175f16`, adapter key `1429ec7ecf2163fd`). Row set:
the 41 `language/statements/function` + `language/types/object` +
`language/types/reference` non-passes in `.tmp/es5-remaining.txt`. **All 41
re-verified failing on that head before any edit** — none had flipped.

### Cluster A — an ALWAYS-numeric update on a field the closed struct cannot hold (4 rows)

`S8.6_A2_T1`, `S8.6_A2_T2`, `S8.6_A3_T1`, `S8.6_A3_T2` — all four `fail` →
`pass`. Two shapes of one defect; the literal pins each slot's storage type:

| source | closed struct | observed | spec |
| --- | --- | --- | --- |
| `var m = {foo:"bar"}; m.foo++` | `foo` is a string slot | `m.foo` is **null** (a later `+` null-derefs in `__str_concat`) | `NaN` |
| `var m = {}; m.foo++` | no `foo` slot at all | update RESULT is `NaN` (correct) but the write is **dropped**, so `"foo" in m` is false | `NaN`, property created |

The two halves needed separate fixes and are separable — the first is a
representation choice made before codegen, the second is an emission arm.

**Half 1 — `markStandaloneNumericUpdateKindChangeTargets`**
(src/codegen/declarations/object-shape-widening.ts) joins the existing
`markStandalone*Targets` markers in `collectGrowableObjectLiterals`, so a
non-empty literal whose field is hit by an always-numeric update is routed to
the open `$Object` builder and inherits that block's concrete-struct consumer
guard unchanged. Isolation that fixed the direction before writing it: adding
`if (false) { delete m.zzz; }` — which routes the literal to `$Object` through
the pre-existing `markStandaloneDeleteTargets` poison — makes `{foo:"bar"}` +
`foo++` answer NaN with no other change.

The trigger is deliberately narrow. `+=` is **excluded**: `"a" += x` stays a
String, so it does not change a string field's kind — only `++`/`--`/`-=`/
`*=`/`/=`/`%=`/`**=` are always-numeric. And the disagreement must be provable
from the literal's own syntax (a string/template/boolean/null/object/array/
function initializer, or the field being absent); a call or an identifier
initializer answers "unknown" and stays on the closed-struct path.

**Half 2 — the unknown-field arm of `compileMemberIncDec`**
(src/codegen/expressions/unary-updates.ts) emitted `f64.const NaN` and dropped
the write when the receiver's struct resolved but carried no slot for the
property. It now reuses the SAME externref read-modify-write the #2656
unresolvable-receiver arm one screen above already uses — the read still
answers undefined → NaN, so the result value is unchanged; only the vanished
write-back changes. The two arms were de-duplicated into one module-scope
`emitMemberIncDecExternrefFallback` rather than inlined twice.

Half 2 is what closes the EMPTY-literal rows, and it is worth recording that
the delete-poison isolation did **not** help them: `var m = {}` with the
poison still lost the write, because the empty-widening path had already
resolved a zero-field struct and the drop is downstream of the
representation choice.

### Cluster B — `typeof x` read textually BEFORE `var x = <init>` (1 row + 1 advanced)

`S8.7_A5_T1` `fail` → `pass`; `S13.2.2_A19_T8` advances from CHECK#0 to
CHECK#2.

A `var` binding hoists; its VALUE does not. The checker types the symbol from
its initializer, so `staticTypeofForType` folds the EVENTUAL type forever:

```js
typeof __func;                     // observed "function", spec "undefined"
var __func = function () {};

typeof __ref;                      // observed "object",   spec "undefined"
var obj = new Object(); var __ref = obj;
```

This re-diagnoses #4206's Cluster C ("`var f = function(){}` hoists carrying
its VALUE"). The binding does **not** hoist its value: `__module_init` seeds
each backing global with the `$undefined` singleton and overwrites it in
declaration order, exactly as the spec requires. Only the CONST-FOLD was
wrong. `readPrecedesVarInitializer` (src/codegen/typeof-delete.ts) kills the
fold for that window; the existing runtime `__typeof*` path then reads the
global and answers correctly on both sides of it.

Two findings that cost real time and are cheap to hand on:

- **A first cut tested `ref.is_null` on the backing global and silently never
  fired.** The seed is the `$undefined` SINGLETON, not a null extern — so the
  guard compiled, allocated its locals, and changed nothing. The fix is to
  kill the fold and let the runtime path read the value, never to test
  live-ness by pointer.
- **The two fold sites must be guarded together.** `typeof(__ref) !==
  "undefined"` folds in `compileTypeofComparison`, while the `'Actual: ' +
  typeof(__ref)` in the SAME throw statement folds in
  `compileTypeofExpression`. Guarding only the latter produced a test that
  threw while reporting `Actual: undefined` — the two arms disagreeing inside
  one source line. The comparison arm also has to unwrap parentheses, which
  the plain arm already did.

Narrow by construction: standalone/WASI-gated; `let`/`const` excluded (their
pre-declaration read is a TDZ ReferenceError, owned by the boxed-TDZ path);
the read and the declaration must share one enclosing code unit (otherwise
`function f(){ return typeof x }; var x = 1; f()` would be mis-guarded — it
runs AFTER the declaration despite reading earlier); and no loop may enclose
the read inside that unit (a backward edge can revisit it).

### Blast radius, measured

73 currently-passing standalone rows re-run, 73/73 still pass — 42 sampled
across `expressions/{postfix,prefix}-{in,de}crement`, `compound-assignment`,
`expressions/object`, `types/object`, `Object/{defineProperty,keys,
getOwnPropertyNames}`, `statements/{for-in,with}`, plus 31 across
`expressions/typeof`, `statements/variable`, `global-code`,
`statements/function`, `types/reference` and `expressions/delete`. Gates
`check:loc-budget`, `check:func-budget`, `check:coercion-sites`,
`check:oracle-ratchet` all exit 0; `tsc` clean on the three touched files.

### Wave-3 lane A, slice 2 — `var F = function(){}` had no `constructor` back-ref (1 row)

`S13.2_A4_T2` `fail` → `pass`; `13.2-17-1` advances past its first assertion.

§13.2 step 10 does not care how the function object was produced, but this
compiler does. Measured on this head, the ONLY varying axis being the
declaration form:

| source | `F.prototype.constructor` |
| --- | --- |
| `function __func(){}` | `__func` — correct |
| `var __gunc = function(){}` | `[object Object]` — the bare prototype object; the property was simply ABSENT and the read walked on |

`fnctorConstructorInstallInstrs` (src/codegen/expressions/fnctor-prototype.ts)
declined the second form on purpose, and its #4480 note says why: the value it
installs must be the very object an ordinary `F` identifier read yields, and
`var F = function(){}` has no `__fn_closure_<F>` singleton. Publishing the
singleton anyway would make the IDENTITY assertion false — a wrong answer
where there was merely a missing property.

The note also names the value that IS identity-stable for this shape and did
not need inventing: **the module global the identifier read itself returns.**
`moduleGlobalConstructorInstallInstrs` installs `global.get <F's slot>`, so
`F.prototype.constructor === F` holds because both sides are the same
`global.get`, not because two constructions happen to agree.

Gate order matters here: the arm fires only when the caller resolved NO
declaration (`ctx.funcMapOwnerDecl` / `topLevelFunctionDeclarations` both
miss — the `function F(){}` case is the sibling arm's) and the name is not a
top-level function name, so a declaration whose decl node we merely failed to
find cannot fall through into it. The backing global must also be `externref`;
a primitive slot cannot carry a function value.

Blast radius: 38 further passing rows across `statements/function`,
`expressions/function`, `Function/prototype`, `Object/getPrototypeOf`,
`expressions/new` and `expressions/instanceof` — 38/38 still pass, plus the
42-row control set re-run at 42/42.

**Still failing in this cluster, and why they are NOT this head:**
`S13.2.2_A1_T1/T2` and `S8.6.2_A1` need `F.prototype.isPrototypeOf(new F())`,
which `fnctor-instance-prototype.ts` already records as blocked by the #2660
escape gate (writing the call demotes `F` out of the approved set) and whose
file this lane does not own. `S8.6.2_A2` needs an inherited-property WRITE to
shadow on the instance. `13.2-17-1` now fails one assertion later, on an
`Object.prototype.constructor` ACCESSOR being consulted by `verifyProperty`.

### Wave-3 lane A, slice 3 — `for…in` over a literal that writes GREW (1 row)

`S8.6_A4_T1` `fail` → `pass`.

```js
var o = { bar: true };
o.some = 1; o.foo = "a";
for (var k in o) count++;      // observed 1, spec 3
```

The #2837 growable pre-pass already recognises the growth (two depth-1
out-of-shape writes). Its consumer-safety poison for `for…in` then CANCELS the
marking — and that poison is a HOST-lane statement: "`for (k in V)` lowers
against V's STATIC struct type, so an externref `$Object` would fail the
cast."

In standalone the relation inverts, the same way #2992 S6 established for
`delete`: the closed struct is precisely what cannot serve the consumer,
because the added keys have no slots to enumerate. So the enumeration is a
REASON to open the object, not a reason to leave it shut.
`markStandaloneEnumeratedGrowthTargets` fires only on the conjunction
(enumerated ∧ grown), inside the standalone-only `mopSet` arm that already
carries the concrete-struct-consumer guard.

The one #2837 poison that keeps its force in standalone is re-stated by hand:
an ARITHMETIC read of a field off `V` wants the `struct.get` f64 contract
(#1897), so such a var declines and keeps its closed struct — with the
enumeration gap intact. That is a deliberate documented trade, not an
oversight.

Scan shape worth noting for the next editor: the three signals (the literal,
the writes, the loop) routinely sit in DIFFERENT statements, so this marker
scans the whole statement list at once. The sibling `markStandalone*Targets`
helpers are called per-statement and would never see them together.

Blast radius: 42 further passing rows across `statements/for-in`,
`Object/{keys,getOwnPropertyNames,assign}`, `JSON/stringify`,
`expressions/object` and `Array/prototype/{map,filter,forEach}` — 40 pass, and
the two that do not (`expressions/object/{getter,setter}-body-strict-inside`)
were **re-run on the pristine branch head `1d57d9229a` with all four touched
files reverted and fail there identically**, so they are pre-existing on this
branch and not attributable to any slice here. The 42-row control set re-runs
at 42/42.

### Wave-3 lane A, slice 4 — the realm-global member CALL and BRACKET read (1 row)

`S8.6.2_A5_T3` `fail` → `pass`.

#4500 Slice A taught the member READ that `this.p` / `globalThis.p` on a
`var`-declared script global must answer from the wasm module global that
actually stores it. Two siblings never got the same treatment, and the split is
visible inside one program:

```js
var count = 0, knock = function () { count++; };
var g = this.knock;   typeof g   // "function"   — Slice A, correct
this.knock();                    // TypeError: called value is not a function
this["knock"]();                 // TypeError
var c = this["count"];           // undefined  (the dot form answers 0)
```

The read being right while the call throws is the tell: one lowering learned
about module globals and the other did not.

- **The bracket READ** — `tryEmitRealmGlobalModuleGlobalElementRead`
  (src/codegen/property-access.ts) is the literal twin of the Slice A dot arm.
  §13.3.3 makes the two spellings the same [[Get]]; only a key the compiler can
  resolve to a fixed string qualifies, so a genuinely dynamic `this[k]` keeps
  the existing dynamic read.
- **The CALL** — `tryEmitRealmGlobalMemberCall`
  (src/codegen/expressions/realm-global-member-call.ts, new) reads the callee
  out of the module global and invokes it through `__apply_closure`, passing the
  compiled receiver so a STRICT callee still sees the global object (a bare
  `f()` would bind `undefined`).

**Dispatch POSITION is the load-bearing part, and it cost two attempts.** The
arm first went into `compileCallDispatchTail` — the last-resort arm, one line
above the graceful `ref.null.extern` fallback — and never fired, because
`compileReceiverMethodCall` claims the call much earlier: it resolves the member
against the checker's `typeof globalThis` struct, misses (a `var` global has no
field there), and its resolved-method-is-null guard raises the TypeError. So the
arm has to sit BEFORE the property-access dispatch block in
`compileCallExpression`, not after everything else. A "last-resort" position is
only last-resort for calls nothing else claimed; this one was claimed and
answered wrongly.

Blast radius: 50 passing rows across `expressions/call`, `expressions/this`,
`global-code`, `built-ins/global*`, `Function.prototype.{call,apply}`,
`types/{object,reference}` and `built-ins/Math` — 50/50 pass; control set 3
(38 rows over `statements/function`, `expressions/function`,
`Function/prototype`, `Object/getPrototypeOf`, `expressions/new`,
`expressions/instanceof`) re-runs 38/38.

**Not fixed, and it is one head, not four:** `S8.6.2_A5_T{1,2,4}`,
`S8.7.2_A3` and `S13.2.2_A19_T7` all need `this.x = v` / `this["x"] = v` on a
name with NO `var` declaration to CREATE a script-global binding that a bare
`x` reference then resolves. That is the implicit-global-binding work #4206
already scoped out (its `S13.2.2_A17_T2/T3` + `A18_T1/T2` entry is the same
head); the read/call arms here deliberately do not touch it, because creating a
binding is a declaration-time act and these arms are expression lowerings.

### Wave-3 lane A — final tally and the residual heads

**8 of 41 rows closed** (`fail` → `pass`), verified by a final serial re-run of
the whole 41-row set on `worktree-agent-a0565c82af575a1ff`:

| row | slice |
| --- | --- |
| `language/types/object/S8.6_A2_T1` | 1 — kind-changing numeric update |
| `language/types/object/S8.6_A2_T2` | 1 |
| `language/types/object/S8.6_A3_T1` | 1 |
| `language/types/object/S8.6_A3_T2` | 1 |
| `language/types/reference/S8.7_A5_T1` | 1 — typeof before `var` initializer |
| `language/statements/function/S13.2_A4_T2` | 2 — `var F = function(){}` constructor back-ref |
| `language/types/object/S8.6_A4_T1` | 3 — `for…in` over a grown literal |
| `language/types/object/S8.6.2_A5_T3` | 4 — realm-global member call / bracket read |

The other 33 all still report `fail` — none regressed to `compile_error`, and
one moved the other way: `S8.6.2_A5_T2` was `compile_error` (standalone emitted
the `env::DisposableStack_move` host import, #2961) in the wave-3 row list and
now compiles and runs, failing on the implicit-global head below.

Two rows ADVANCED without passing, which is worth recording because both are
now failing on a different defect than the one they were filed under:

- `S13.2.2_A19_T8` — CHECK#0 and #1 now pass; it fails at CHECK#2, on a
  `var __func` re-declared inside a SECOND `with` block keeping the first
  block's scope (the residual #4206 already named).
- `13.2-17-1` — `typeof fun.prototype.constructor` is now `"function"`; it
  fails one assertion later, inside `verifyProperty`, on an
  `Object.prototype.constructor` ACCESSOR being consulted.

**The residual heads, grouped by what actually blocks them** (so the next lane
does not re-derive this):

| head | rows | why not taken here |
| --- | ---: | --- |
| implicit-global binding — `this.x = v` / `x = v` on an UNDECLARED name must CREATE a script-global that a bare `x` resolves | 8 | `S8.6.2_A5_T{1,2,4}`, `S8.7.2_A3`, `S13.2.2_A19_T7`, `S8.7_A5_T2`, `S13.2.2_A17_T2/T3` (+`A18_T1/T2` add `with (arguments)`). Creating a binding is a declaration-time act; every arm this lane touched is an expression lowering. This is ONE head, not eight, and it is the single largest remaining item in the set. |
| `F.prototype.isPrototypeOf(new F())` | 3 | `S13.2.2_A1_T1/T2`, `S8.6.2_A1`. `fnctor-instance-prototype.ts` already records the blocker: writing the call is a dynamic method use on `F`'s prototype, which demotes `F` out of the #2660 escape gate's approved set. Its file is owned by another lane. |
| `new F()` whose ctor RETURNS a function | 3 | `S13.2.2_A8_T1/T2/T3` — #2071's area, unchanged. |
| `arguments` extras beyond the formals | 4 | `S13.2_A2_T1/T2` (null-deref in `__module_init`), `S13.2.2_A5_T1`, `S13_A11_T4`. `S13_A2_T2` is the adjacent operator half (`arg + arguments[1]` picks numeric). |
| `var F; F = function(){}` — the SPLIT declaration/assignment fnctor | 2 | `S13.2.2_A4_T2`, and it also blocks `S13.2.2_A2`. **Newly isolated here**, and it is a one-line-apart A/B: `var F = function(){}; F.prototype = {…}; new F().m()` WORKS, while `var F; F = function(){}; …` answers `undefined` for the inherited member. `resolveFnctorSymbol` (fnctor-escape-gate.ts) walks the symbol's declarations and finds a `VariableDeclaration` with NO initializer, so the whole #2660 fnctor machinery declines. Admitting the shape means proving the assignment is the ONLY one targeting that binding, and `resolveFnctorSymbol` is consulted by the `new F()` lowering and the escape gate alike — a wide blast radius for a narrow win, so it is left measured rather than attempted. |
| `Math.<unary>` as a first-class VALUE | 1 | `S13.2.1_A5_T2` passes `Math.sin` to a higher-order function. `builtin-value-read.ts`'s `default` arm reifies an identity-stable closure whose BODY throws (#2984 Phase 3). The self-hosted `Math_sin` f64→f64 func already exists (math-helpers.ts) and a body could be `__unbox_number` → `Math_sin` → `__box_number`; what is missing is plumbing the name into the `needed` set that decides whether `Math_sin` is emitted at all, which happens in a different phase from the value read. |
| duplicate function declarations | 1 | `S13_A6_T1` — the later `function __func(){return 'A'}` must win for BOTH earlier and later calls. The call site is typed f64 from the FIRST declaration, so the string result coerces to NaN. A checker-merged-symbol representation question. |
| non-extensible `__proto__` write | 1 | `S8.6.2_A8` — `x.__proto__ = y` on a `preventExtensions` object mutates the prototype. Also measured: `Object.getPrototypeOf(x)` answers `null` rather than `Object.prototype` for that object, so there are TWO defects here and the read one is the more basic. |
