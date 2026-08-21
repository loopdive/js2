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
  # 2026-08-21 (wave-4 lane E, #3966 slice): +17 / +11 lines of pure DISPATCH
  # wiring — three `if (isSloppyImplicitGlobalBinding(...))` guards in the
  # update path and one predicate disjunction plus one negation in the call
  # path. Every new BODY lives in the new module
  # src/codegen/expressions/implicit-global-binding.ts; these two files gain
  # only the branch that reaches it. (unary-updates.ts already granted above
  # by wave-3 lane A; this extends the same file's grant.)
  - src/codegen/expressions/call-identifier.ts
  # 2026-08-21 wave-4 lane G, Math-as-a-VALUE slice (+5): `Math.sin` passed as a
  # first-class value reified a closure whose body THREW even though the
  # `Math_sin` f64 kernel already existed and the direct-CALL path used it.
  # Both phases that decide this keyed on the CALL form only. The body AND the
  # collector predicate both live in a NEW module
  # (src/codegen/math-static-value-body.ts); the collector retains only the
  # 5-line dispatch, which has to be in the walker to see the node at all.
  - src/codegen/declarations/import-collector.ts
  # 2026-08-21 wave-4 lane G (+13 at integration base): the dispatch arm for
  # the Math value body in `ensureStandaloneBuiltinStaticMethodClosure` — see
  # the func-budget entry; the body lives in math-static-value-body.ts.
  - src/codegen/builtin-value-read.ts
  # 2026-08-21 wave-4 lane J, slice J2 (+5): `Array.prototype.join`'s #3224
  # beyond-the-backing arm rendered EVERY hole as "", but a hole INHERITS
  # `Array.prototype[k]` and the read path already sees it — `x[1]` answered 1
  # while `x.join()` answered "0,". The whole fallback body (gate, native
  # registration, scratch local, the [[Get]] + ToString arm) lives in the NEW
  # module src/codegen/array-join-proto-hole.ts; `compileArrayJoinNative` gains
  # one import line, one arming call and the `else:` swap. The arming call has
  # to be in this function — it must run BEFORE the existing `externToStrIdx`
  # capture or that index shifts underneath it (#2043).
  - src/codegen/array-methods.ts
  # 2026-08-21 wave-4 lane H, synthetic-`arguments`-rest slice (+5): TWO
  # two-line parameter-resolution swaps in `compileTailDispatch`'s
  # CallExpression-callee and generic-callee arms — `sig.parameters` →
  # `runtimeSignatureParameters(sig)`, the helper that ALREADY exists in
  # calls-closures.ts for exactly this (it was private; this slice exports it).
  # There is no new body to move out: the change is which symbol list the two
  # existing loops read. Both arms sit at fixed points in one long ordered
  # dispatch chain and cannot be hoisted without reordering it.
  - src/codegen/expressions/call-tail-dispatch.ts
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
  # 2026-08-21 wave-4 lane G: NOT new coercion vocabulary — the gate counts
  # `__any_to_f64` as +1 only because the call sits in a new file. The pair
  # `__any_from_extern` → `__any_to_f64` is copied verbatim from the variadic
  # `Math.max`/`Math.min` value body in builtin-value-read.ts, deliberately, so
  # an extracted `Math.sin` coerces its argument exactly like an extracted
  # `Math.max` does. No ToNumber/ToString/ToPrimitive matrix is hand-rolled.
  - src/codegen/math-static-value-body.ts
  # 2026-08-21 wave-4 lane J, slice J2: NOT new coercion vocabulary — the gate
  # counts `__extern_toString` as +2 only because the call moved into a new
  # file. It is the SAME runtime ToString the join fold's boxed-any arm already
  # calls (`buildJoinBoxedElementToString`, array-join-element.ts) and the same
  # one `String(a[i])` uses; the inherited-hole arm has to stringify identically
  # to the backed-element arm or `x.join()` and `x[1] + ""` would disagree about
  # one index. Nothing is hand-rolled — the nullish/undefined test reuses
  # `__extern_is_undefined`, exactly as `joinEmptyElementTest` does.
  - src/codegen/array-join-proto-hole.ts
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
  # 2026-08-21 (wave-4 lane E, #3966 slice): +10 each, dispatch-only.
  # `compilePrefixUpdate` gains one 4-line guard per operator (`++`/`--`);
  # `compileIdentifierCall` gains a predicate binding and one extra
  # disjunct/negation. Splitting either function is a real refactor with its
  # own blast radius and is deliberately NOT bundled into a semantics fix.
  - src/codegen/expressions/unary-updates.ts::compilePrefixUpdate
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  # 2026-08-21 wave-4 lane G, Math-as-a-VALUE slice. Both growths are DISPATCH
  # ONLY — every line of the new body lives in math-static-value-body.ts:
  #  * ensureStandaloneBuiltinStaticMethodClosure (+12): one `else if` arm that
  #    must sit BEFORE the `genericThrowBody` arm, because that arm claims every
  #    `default:` case (this one included) and behind it the new arm would never
  #    fire.
  #  * unifiedVisitNode (+4): the collector dispatch — a predicate call and a
  #    `mathNeeded.add`. It has to be in the walker to see the node.
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  # Wave-4 lane F slice F3: +3 each — the finalize ladders ARE these two
  # functions, so a new `__extern_set` prologue pass has nowhere else to be
  # called from.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  # 2026-08-21 wave-4 lane H. Both are DISPATCH/WIRING only:
  #  * compileTailDispatch (+4): the two `runtimeSignatureParameters(sig)`
  #    swaps described in the loc-budget entry above — no new body, just which
  #    symbol list the two existing param loops read.
  #  * compileDeleteExpression (+2): one call to
  #    `prepareDynamicArgumentsDeleteIndex`. It MUST sit here, between the
  #    `keyLocal` store and the `__delete_property` `ensureLateImport` — the
  #    helper can pull a late import, and a late import registered after that
  #    funcIdx is captured shifts the already-planned call. The whole body
  #    lives in the existing subsystem module arguments-object-mop.ts.
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/typeof-delete.ts::compileDeleteExpression
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

## Wave-4 lane E — implicit-global binding (head shared with #3966)

Row set handed to this lane: `S13.2.2_A17_T2/T3`, `S13.2.2_A18_T1/T2`,
`S13.2.2_A19_T7`, `S8.6.2_A5_T1/T2/T4`, `S8.7.2_A3`, `S8.7_A5_T2`. All ten
verified FAILING on the lane's base (`284bd91a1f`) before any edit.

### Step 0 — the head is NARROWER than "creation". Measured first.

The brief assumed the binding is never CREATED. It is. A single probe of the
three creation spellings at script top level passes on base, untouched:

| probe (top level, standalone)                     | base |
| ------------------------------------------------- | ---- |
| `this.a = 1` then bare `a`                        | pass |
| `b = 2` then bare `b`                             | pass |
| `this["c"] = 3` then bare `c`                     | pass |
| `this.a = 1` then `this.a`                        | pass |

So #3956 (read) + #4500 Slice B (plain write) already give these names real
storage on the realm global object, and the synthesised-module-global design the
brief sketched would have DUPLICATED that storage — two carriers for one name,
which is the exact failure mode #4500 Slice A's own note warns about ("fixing
only the read makes `this.p = 2; this.p === 2` regress"). It was not built.

What is actually missing is every OTHER operation on such a name. Matrix
(`.tmp/probe/p5.js`, one program, each case fault-isolated in a `try`):

| shape                                             | base | after |
| ------------------------------------------------- | ---- | ----- |
| `p++` / `++p`, script top level                   | **0** ❌ | 1 ✅ |
| `p++` / `++p`, inside a nested function           | **0** ❌ | 1 ✅ |
| `p += 2`, top level and nested                    | 2 ✅ | 2 ✅ |
| `p = p + 3`, top level and nested                 | 3 ✅ | 3 ✅ |
| `f()` where `this.f = function(){}`               | silently **no-op** ❌ | runs ✅ |
| `f()` where bare `f = function(){}`               | **ReferenceError** ❌ | runs ✅ |
| `this["f"]()`                                     | **no-op** ❌ | no-op ❌ (see residual) |

### Step 1 — root causes (two, both "the arm was simply never written")

1. **UpdateExpression.** `compilePostfixUnary`'s identifier path ends in
   `fctx.body.push({ op: "f64.const", value: 0 })` — "graceful fallback: emit 0
   for unknown postfix increment/decrement". For an implicit global that both
   answers the wrong value AND drops the store. `compilePrefixUpdate` falls
   through to `compileMemberIncDec` on an Identifier operand, equally inert.
   Neither consulted `ctx.sloppyImplicitGlobals`, which the read
   (`emitImplicitGlobalRead`) and the plain write have consulted since #3956/#4500.
2. **CallExpression.** `tryEmitInlineDynamicCall` refuses unless the callee is a
   "known variable" (local / module global / captured global). An implicit
   global is none of those, so the call fell to one of the two arms below it:
   a hard `ReferenceError: <name> is not defined` when the name has no TS
   declaration, or the graceful `ref.null.extern` when it has one — the latter
   is why `beep()` in `S8.6.2_A5_T4` ran to completion having done nothing.

### Step 2 — change

New module `src/codegen/expressions/implicit-global-binding.ts`:
`isSloppyImplicitGlobalBinding` (one predicate, shared) and
`tryEmitImplicitGlobalIncDec` (GetValue → ToNumeric → ±1 → PutValue, reusing
`emitImplicitGlobalRead` for the read half and the same `__extern_set` carrier
`assignment.ts` uses for the write half, so read and write cannot drift apart
again — which is precisely how this defect arose).

Dispatch-only wiring in the two god-files: three guards in `unary-updates.ts`
(postfix, prefix `++`, prefix `--`) and, in `call-identifier.ts`, one extra
disjunct on the `tryEmitInlineDynamicCall` gate plus one negation on the
ReferenceError arm.

### Step 3 — measured result

**Rows flipped fail → pass: 3.** `S13.2.2_A17_T2`, `S8.6.2_A5_T1`,
`S8.6.2_A5_T4`. Zero rows moved the other way.

**Control set: 60 files, deterministic shuffle seed 20260821**
(`.tmp/mkcontrols.mjs`, population 733) over `language/statements/with`,
`global-code`, `expressions/typeof`, `types/reference`, `statements/variable`,
`expressions/assignment`, `types/object`, `statements/function`. Run on base and
on branch by file-copy revert, same runner, same lane:
**41 pass / 18 fail / 1 compile_error on BOTH — the two result files are
byte-identical.**

### Step 4 — the other seven rows, and why each is NOT this head

Recorded so the next lane does not re-derive them. Each was reduced to a probe.

| row | first failing assertion | actual head |
| --- | ----------------------- | ----------- |
| `S8.6.2_A5_T2` | `position === 1` | **builtin-prototype name capture**, see below |
| `S13.2.2_A18_T1/T2` | `callee === 0` | `with (arguments)` must resolve `callee` to the arguments object's own property; we bind the outer `var callee` instead |
| `S13.2.2_A17_T3` | `__obj.p1 === "w1"` | `with`-scoped write precedence, #4231/#4264 |
| `S13.2.2_A19_T7` | `this.hasOwnProperty('__func')` | global-object ↔ `var`-binding aliasing (#3956 residual): `__func` IS declared, so this is not implicit-global creation at all |
| `S8.7.2_A3` | `this.x !== undefined` at line 1 | reading an ABSENT realm-global property must answer `undefined`, not throw; then `this.x++` must CREATE it (NaN). Genuinely the "creation" head the brief described — but via a MEMBER update, not an identifier one |
| `S8.7_A5_T2` | `typeof(__ref)` after `__ref = obj` | `typeof` on an implicit global holding an OBJECT answers `"undefined"` |

### Step 5 — `typeof` on an implicit global: ATTEMPTED, MEASURED, REVERTED

Recorded in full because the reason it was abandoned is more useful than the
attempt. Nothing from this step is in the branch.

`typeof-delete.ts` const-folds `typeof <name>` to the literal `"undefined"`
whenever the checker reports no value declaration — right for a name that never
exists, wrong for one the program creates at runtime. Replacing the fold with a
guarded runtime probe (`__extern_has` ? `__typeof(__extern_get(…))` :
`"undefined"`) makes the OBVIOUS probe pass:

| probe (`.tmp/probe/p20.js`)                        | fold | probe arm |
| --------------------------------------------------- | ---- | --------- |
| `typeof r` before any assignment                    | ✅   | ✅        |
| `r = new Object(); typeof r`                        | **"undefined"** ❌ | "object" ✅ |
| `r = 5; typeof r` / `r = "s"; typeof r`             | **"undefined"** ❌ | ✅        |

**It still flips zero rows, and the reason is a defect the arm does not own.**
A runtime-computed `typeof` result is fine when CONCATENATED and broken when
used directly (`.tmp/probe/p25.js`, `p26.js`, standalone):

| expression, after `w1 = obj`                       | result |
| ---------------------------------------------------- | ------ |
| `"" + (typeof w1)`                                  | `"object"` ✅ |
| `s = "" + (typeof w1); s === "object"`              | true ✅ |
| `typeof w1 !== "object"`                            | **true** ❌ |
| `(typeof w1) === "undefined"`                       | false ✅ |
| `(typeof w1).length`                                | **NaN** ❌ |

The `.length` row is the decisive one: it rules out the string-EQUALITY route
and every carrier hypothesis at once. Three carriers were tried and all three
produce that same NaN — raw `externref`; `any.convert_extern` + `ref.cast` to
`$AnyString` (verified `absentType = {ref, typeIdx: 6}`, `anyStrTypeIdx = 6`,
`nativeStrTypeIdx = 7`, so the cast is to the type the literal itself uses); and
a five-instruction form with no `if` and no extra locals at all, byte-shaped
exactly like the generic `__typeof` path at `typeof-delete.ts:1796`. Ordering was
also ruled out (`p26` puts the direct use FIRST; same NaN). Instrumentation
confirms the arm fires at every site.

So the residual is: **a runtime `__typeof` result is unusable in direct value
position under standalone** — the concat path coerces it, the value path does
not. That is #2107's territory (the note there records the same class of failure
and answers it with `__any_typeof` returning a native `ref $AnyString`, which
needs an `$AnyValue` operand this path does not have). Fixing `typeof` for
implicit globals means giving the global-object read an `$AnyValue`-shaped
answer, or teaching the value path the externref carrier — either is a
different slice with a different blast radius than this head, so the arm was
removed rather than landed unvalidated.

Second finding from the same probes, unresolved and worth a look: in
`S8.7_A5_T2` the probe arm reports the property ABSENT after `__ref = obj`
(CHECK#1 passes, CHECK#2 fails), while `.tmp/probe/p21.js` — the same shape with
a different name — reports it present. So the bare-assignment write may not
always reach the realm global object; that would be a defect in the #4500
Slice B write arm, not in `typeof`.

**`S8.6.2_A5_T2` is a builtin-prototype name capture, not an implicit-global
defect — and it is a live miscompile well outside this row.** Reduced to:

```js
var a1 = {};
a1['dispose'] = function () { /* … */ };
a1.dispose();     // TypeError: DisposableStack.prototype.dispose requires a DisposableStack receiver
```

An OWN data property whose name matches a builtin-prototype method (`dispose`,
`move`, `defer`, `adopt`, …) is captured by that builtin's native dispatch
instead of taking precedence, on a receiver that does not have the brand.
`a1['moveq']` is fine; `a1['move']` is not. The test uses `seat['move']`, so it
never reaches the increment the row is nominally about. Left unfixed here: it
lives in the builtin-proto dispatch, not in this head, and it deserves its own
row-set and control population.

## Validation

`TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/Object/defineProperty|built-ins/Object/defineProperties|built-ins/Object/create" pnpm run test:262`
— baseline 90 non-pass. gc-lane control on the same filter. Equivalence guard.

## Wave-4 lane G — `Math.<fn>` as a first-class VALUE (2026-08-21)

Slice landed by the wave-4 lane G row set (built-ins/Function family + the
wave-3 lane A `arguments`-extras head). Only ONE of that whole row set was in
reach; the rest is triaged below with reasons, so it is not re-derived.

### What was broken

`Math.sin` **read as a value** — `derivative(Math.sin, 0.0001)` — reified a
closure whose body was the degrade-to-catchable refusal, so the call threw:

```
TypeError: Math.sin is not yet implemented in --target standalone
```

Meanwhile `Math.sin(x)` **called directly** worked, and had for a long time, via
the `Math_sin` self-hosted f64 kernel (`math-helpers.ts`) that
`expressions/builtins.ts` calls from its `hostUnary` arm. The kernel was never
the gap.

The gap was that BOTH phases which decide the value form keyed on the CALL form:

1. `collectImports` (`declarations/import-collector.ts`) added to
   `state.mathNeeded` only from a `ts.isCallExpression`, so a value read never
   put `sin` in the set, `emitInlineMathFunctions` never emitted `Math_sin`, and
   there was no kernel to call even in principle.
2. `ensureStandaloneBuiltinStaticMethodClosure` (`builtin-value-read.ts`) let
   `Math.sin` fall to its `default:` arm, whose body is `emitThrowTypeError`.

Either fix alone leaves the row failing — measured both ways.

### The fix

New module `src/codegen/math-static-value-body.ts` holds both halves:

- `mathValueReadMethod(node)` — the collector predicate (non-call-position
  `Math.<m>` whose kernel exists). The collector keeps only a 5-line dispatch.
- `emitMathStaticValueBody(...)` — the body:
  `__any_from_extern` → `__any_to_f64` per arg → `call Math_<m>` → `__box_number`.
  That coercion pair is copied verbatim from the variadic `Math.max`/`Math.min`
  value body two arms above, deliberately, so an extracted `Math.sin` coerces
  exactly like an extracted `Math.max` rather than growing a second matrix.

**Dispatch position is load-bearing.** The new arm sits BEFORE the
`genericThrowBody` arm, because that arm claims every `default:` case — this one
included — so behind it the new arm would never fire. Verified it fires by the
row flipping, not by inspection.

**Declining is the default and is always safe**: the emitter returns `false`
without pushing anything unless the kernel and all three helpers are already in
`ctx.funcMap`, and the `&&` then falls through to the pre-existing throw body.
Covers 21 methods (19 unary + `pow`/`atan2`); the inline-opcode Math functions
(`abs`/`floor`/`sqrt`/…) and `random` are deliberately excluded — they have no
`Math_<m>` function to call, so they keep today's behaviour.

### Measured

Real `runTest262File`, `--target standalone`, this branch's base vs. after.

| row                                                | base | after |
| -------------------------------------------------- | ---- | ----- |
| `language/statements/function/S13.2.1_A5_T2.js`    | fail | **pass** |

Blast radius: the 35-row built-ins/Function set is **byte-identical** before and
after (33 fail / 1 pass both runs — none of them reads a Math value); the other
5 extras-head rows are unchanged. Control set of 519 currently-passing neighbours
(`Function/prototype/{call,apply}` families, `language/statements/function`,
`language/expressions/call`, and the `Math/{sin,cos,tan,log,pow,atan2}`
directories — the last added specifically because this slice changes Math
emission) diffed base vs. after with no regressions.

### Triage of the rest of the row set — NOT attempted, with reasons

Measured on base with the probes noted; each is a real wall, not a skip.

| bucket | n | finding |
| ------ | -: | ------- |
| `Function(...)` constructor result semantics | 22 of 35 | The bare `Function` value and `Function(src)` both resolve through the **runtime-eval provider realm** (`function-intrinsic-carrier.ts`: reading bare `Function` is an `intrinsic-value` boundary site). Probed: for `f = Function("a1,a2,a3","…")`, `typeof f`/`f.length`/`f.hasOwnProperty("prototype")`/`typeof f.call` are all **correct**, but `Object.prototype.toString.call(f)` is `[object Object]` (should be `[object Function]`) and `Object.getPrototypeOf(f) === Function.prototype` is **false**. Fixing means branding the interpreter-materialized callable across the provider boundary (`src/interp/`, `src/runtime.ts`), not a codegen table entry. |
| `Function.hasOwnProperty("prototype"/"length")`, `delete Function.prototype` | 3 | Same root cause, and cheap-looking but isn't. `Object`/`Array`/`String.hasOwnProperty("prototype")` all answer **true** — `pushBuiltinCtorOwnPropSeed` seeds those carriers, and `Function: 1` **is** in `BUILTIN_CTOR_ARITY`. The seed never reaches this value because the bare `Function` identifier read does not route to `emitBuiltinConstructorIdentity` at all; it routes to the provider realm. (This is exactly failure mode 1 recorded in the `function-intrinsic-carrier.ts` header.) `delete Function.prototype` returns `true` and is a no-op, for the same reason. |
| `Object.getPrototypeOf(fn) === Function.prototype` | — | **Also false for an ORDINARY declared function**, so this is not a Function-ctor defect but a general carrier-identity gap. It is what makes `typeof obj.call === "function"` answer `undefined` when `obj`'s prototype is a function (`S15.3.4.{3,4}_A1_T1/T2`). Out of reach of this row set. |
| `Function.prototype.bind` | 2 | Refuses loud in standalone (`… is not yet implemented`). Genuinely unimplemented, not a plumbing gap. |
| strict `caller`/`arguments` poison pills (`15.3.5.4_2-*gs`) | 5 | Substrate exists (`function-poison-pill.ts` threads the caller-strictness bit) but 4 of the 5 build the strict function via `Function("\"use strict\"; …")`, i.e. the provider realm again. |

Base status of the 35-row set is **33 fail / 1 pass / 1 compile-error**, not
34 — `built-ins/Function/S15.3.3_A2_T2.js` reports status `compile_error`, which
a status filter written as `pass|fail|skip` silently drops. Recorded because a
row that vanishes from a triage listing reads exactly like a row that was never
in the set. Its error is the same bucket as the two rows above it:

```
Codegen error: Function.indicator built-in static property value read is not
supported in --target standalone (#1907 / #1888 S6-b).
```

i.e. an arbitrary static property read on the `Function` carrier, which the
provider-realm value cannot serve.

### `arguments`-extras head — measured, and narrower than assumed

The brief framed the remaining gap as "over-supplied arguments in ORDINARY calls
of function declarations". Probed on base, that framing is **too broad** — the
ordinary direct-call path already works:

| probe | result |
| ----- | ------ |
| top-level `function one(a){…}` called `one("a","b")` | `2:a,b` — **extras work** |
| top-level zero-formal, called through a closure var | `arguments.length` **1** (right), `arguments[0]` **null** |
| nested `function inner(){…}` returned and called | whole `arguments` object **null** |
| nested `function inner(a){…}` called with 2 args | whole `arguments` object **null** |

So there are two distinct defects, and neither is "the ordinary-call path drops
extras": (a) a **lifted nested function DECLARATION** gets no `arguments` object
at all when called through a closure ref — note `compileLiftedClosureBody`
(where wave-3 lane C installed `mappedArgsInfo`) is typed
`ts.ArrowFunction | ts.FunctionExpression` and does **not** accept a
`FunctionDeclaration`; (b) in the zero-formal closure-call case argc and the
extras array disagree, leaving slot 0 filled from neither formals nor extras.
`S13.2.2_A5_T1` is a third variant: `new F(a,b,c,d)` on a 2-formal declaration
reading `arguments[2]`, which null-derefs despite wave-3 lane D's in-`new` work.

Not attempted here — each needs its own measured slice, and guessing at the
call/callee `paramCount` contract is how a silent wrong `arguments.length` would
land. `S13_A2_T2` additionally needs `arg + arguments[1]` to pick the *dynamic*
`+` (it currently folds to the numeric operator and yields `2` instead of
`"11"`), which is a typing question, not an extras question.

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

## Wave-4 dispatch plan (2026-08-21, base `7e2d724311`)

Wave-3 landed: lane D (+5: arguments inside `new F(…)`, instanceof boolean
branding), lane B (+3: String-exotic own keys), lane C (+8: [[ParameterMap]]
for function expressions + §10.4.4.2 step-5.b order + step-4.c guard), lane A
(+8: kind-changing member updates, typeof-before-var fold guard, `var F =
function(){}` constructor back-ref, for-in over grown literal, realm-global
member call/bracket read). Acceptance measurement in flight.

Three Opus lanes dispatched in parallel, each in its own worktree, no pushes
(tech-lead integrates serially with gates as commit blockers):

| lane | head / row set | rows | seed analysis |
| --- | --- | ---: | --- |
| E | implicit-global binding — `this.x = v` / `x = v` on an UNDECLARED name must CREATE a script global that a bare read resolves | 10 | wave-3 lane A residual table: the single largest one-head item. Declaration-time synthesis of an externref module global seeded `$undefined`, so the existing #4500 Slice A read arm + lane A's slice-4 call arm resolve it. `S13.2.2_A17/A18` add `with (arguments)` and may be blocked past the head. |
| F | String / RegExp / regexp-literals / types-string | 55 | never had a dedicated lane; `.tmp/wave4-laneF.txt`. Triage-first; #2875 records the known walls (primitive-string for-in, empty-string key, value-rep). |
| G | built-ins/Function + `arguments` extras beyond formals + `Math.sin` as value | 41 | `.tmp/wave4-laneG.txt` + lane A's extras rows. The __extras_argv/__argc protocol exists (fnctor-ctor-arguments.ts documents it); the ordinary-call sibling drops extras. |

Not dispatched, measured verdicts on record: split-decl fnctor (`var F; F =
function(){}` — wide blast radius via resolveFnctorSymbol, narrow win),
`new F()` returning a function (#2071), isPrototypeOf behind the #2660 escape
gate, duplicate function declarations (checker-merged-symbol representation),
non-extensible `__proto__` (read defect is the more basic half).

---

## Wave-4 lane F — slice F3: runtime-keyed write to a getter-only RegExp member (2026-08-21)

**Measured before/after** (`--target standalone`, base `284bd91a1f`, probe
`test262/test/probe/f-re-proto3.js`, `var s = /^|^/; var k = "global";`):

| expression | base | after | spec |
| --- | --- | --- | --- |
| `s.global` (static) | `false` | `false` | `false` |
| `s.global = "x"; s.global` | `false` | `false` | `false` |
| `s[k]` | `undefined` | `undefined` | `false` (still wrong — see below) |
| `s[k] = "x"; s[k]` | **`"x"`** | `undefined` | `false` |
| `hasOwnProperty(s, k)` after the write | **`true`** | `false` | `false` |

§22.2.6 makes `source`/`flags`/`global`/`ignoreCase`/`multiline`/`dotAll`/
`unicode`/`unicodeSets`/`sticky`/`hasIndices` getter-only accessors on
`RegExp.prototype`, so §10.1.9 step 3 makes an instance assignment a sloppy
no-op. A `$NativeRegExp` is not a `$Object`, so `__extern_set` routed the write
to the instance expando bag; #4504's inherited-accessor walk could not see it,
because that walk follows `$Object.$proto` links through `$PropEntry` tables and
`RegExp.prototype` is a `$NativeProto` whose getters live in a member CSV.

**Why it is not just a spelling curiosity**: `propertyHelper.js`'s
`isWritable(obj, name, verifyProp)` does `obj[name] = v` with `name` a VARIABLE,
i.e. exactly the runtime-keyed form — which is why `verifyNotWritable` reported
these as writable on a build whose static read was already correct.

**Fix**: new module `src/codegen/regexp-accessor-set-guard.ts` mints
`__regexp_getter_only_set(obj, key) -> i32` (a `ref.test $NativeRegExp` plus ten
`__str_equals` comparisons) and unshifts an early `return` onto `__extern_set` at
finalize — last among the `__extern_set` prologue passes, so it is the body's
first instruction. Demand-gated on the RegExp struct existing in the module.

**Rows flipped (3)**: `built-ins/RegExp/prototype/global/S15.10.7.2_A10`,
`ignoreCase/S15.10.7.3_A10`, `multiline/S15.10.7.4_A10`.

**Deliberately NOT done in this slice**

- **Strict `[[Set]]`.** §10.1.9.2 says a strict write to a getter-only accessor
  throws a TypeError. `__extern_set_strict` is a separate function and is
  untouched: no row in this lane's set exercises it, and a wrong throw is
  catchable and therefore observable.
- **The READ side.** `s[k]` still answers `undefined` instead of `false` — the
  `$NativeProto` getter is not consulted by `__extern_get` either. That is the
  #2885 reflective-getter core, not a `[[Set]]` question, and the no-op above is
  correct standing alone.
- **`delete` on a `$NativeProto` member** (`S15.10.7.{2,3,4}_A9`, 3 rows).
  Measured: `delete RegExp.prototype.global` returns `true` but
  `RegExp.prototype.hasOwnProperty('global')` stays `true` — there is no delete
  path for native-proto members at all (`native-proto.ts` has no tombstone
  concept). Flipping those needs a per-(proto object, member) tombstone side
  table consulted by `__nproto_hasown` and by member dispatch, which is a
  different and larger change than this guard.

**Controls**: 95/95 passing neighbours, before and after (63 String/RegExp/
addition/literals rows plus 32 Object.defineProperty / gOPD / Object.keys /
Array.prototype.push / assignment / delete / RegExp.prototype.{source,toString}
rows). Three rows in the supplementary batch fail identically on base and after
(`Array/prototype/push/S15.4.4.7_A2_T{1,2}` — push-as-a-value unwired;
`RegExp/prototype/source/cross-realm` — `__module_init` null deref) and are
excluded from the control set for that reason.

## Wave-4 lane F — slice F4: String-exotic own props are immutable and undeletable (2026-08-21)

Same defect shape as F3, second receiver family. §10.4.3 gives a String WRAPPER
an own `length` and own canonical INDEX properties, all `{w:false,e:false,c:false}`.
#4232 already taught `hasOwnProperty` about them (`__strexo_hasown`) and gOPD
already reported the right triple — but they are DERIVED from the [[StringData]]
slot rather than being `$PropEntry` rows, so `__obj_find` missed them and a
runtime-keyed write created an own bag entry that shadowed both.

**Measured** (probe `test262/test/probe/f-misc2.js`, `var si = new String("globglob")`):

| query | base | after | spec |
| --- | --- | --- | --- |
| `gOPD(si,"length")` | `{w:f,e:f,c:f,v:8}` | unchanged | unchanged |
| `si.length = "x"; si.length` (static) | `8` | `8` | `8` |
| `isWritable(si,"length")` (propertyHelper) | **`true`** | `false` | `false` |
| `delete si.length` | **`true`** | `false` | `false` |

**Fix**: reuse `__strexo_hasown` as the predicate in the same finalize splice —
`__extern_set` returns early, `__delete_property` returns `0` (§10.1.10 step 4).
Reusing #4232's native is the point: presence, descriptor and mutability then
cannot disagree, because all three read the same predicate.

**Rows flipped (2)**: `built-ins/String/S15.5.5.1_A3`, `built-ins/String/S15.5.5.1_A4_T2`.

**Controls**: 120/120. The set was widened for this slice's blast radius with
`String/prototype/{charCodeAt,toUpperCase}`, `Object/{getOwnPropertyNames,seal,
freeze}`, `Array/prototype/indexOf`, `Array/length`, `for-in`,
`property-accessors` — 25 further passing neighbours. Nine rows in that batch
fail identically before and after (`charCodeAt/S15.5.4.5_A1.1`, three
`Object/seal`, three `Array/prototype/indexOf`, `Array/length/15.4.5.1-3.d-3`,
`property-accessors/S11.2.1_A3_T1`) and are excluded for that reason.

## Wave-4 lane F — slice F6: `delete <Builtin>.prototype.<member>` actually deletes (2026-08-21)

Every own property of a builtin prototype is `{[[Configurable]]: true}`, so the
delete must succeed AND must make `hasOwnProperty` answer `false`.

**Measured** (probe `test262/test/probe/f-re-proto.js`):

| step | base | after | spec |
| --- | --- | --- | --- |
| `RegExp.prototype.hasOwnProperty('global')` | `true` | `true` | `true` |
| `delete RegExp.prototype.global` | `true` | `true` | `true` |
| `…hasOwnProperty('global')` again | **`true`** | `false` | `false` |

The delete reported success and changed nothing: a builtin prototype is a
`$NativeProto` glue singleton whose own-member set is the `$memberCsv` native
string `__nproto_hasown` (#4248) scans, and `__delete_property` only knows how to
tombstone a `$PropEntry` row in a `$Object` hash table.

**Fix**: new module `src/codegen/native-proto-delete.ts` mints
`__nproto_delete(obj, key)`, which rewrites `$memberCsv` (a MUTABLE `externref`
field) with the comma-padded token removed, and unshifts it onto
`__delete_property`. At RUNTIME exactly one consumer reads that field —
`__nproto_hasown`, behind `hasOwnProperty`/`Object.hasOwn`/`propertyIsEnumerable`
— so removing the token is exactly, and only, the observable delete. Every other
`memberCsv` mention in codegen is the COMPILE-TIME `glue.memberCsv` used while
emitting static member reads, which is why dispatch is unaffected (see the
non-attempt below).

**Rows flipped (3)**: `built-ins/RegExp/prototype/{global/S15.10.7.2_A9,
ignoreCase/S15.10.7.3_A9, multiline/S15.10.7.4_A9}`.

**Two toolchain traps found while building it — worth knowing before the next
native is spliced into `__delete_property`:**

1. **Do not read a parameter more than once through a cast chain.** The first cut
   repeated `local.get 0; any.convert_extern; ref.cast $NativeProto` at each use.
   After the caller-side inliner copied the body into `__delete_property`, the
   later `local.get 0` sites had been forwarded the FIRST occurrence's
   already-cast value, so the body's own `any.convert_extern` was handed a
   `(ref null $NativeProto)` and the module failed validation with
   *"any.convert_extern[0] expected type externref"*. Recovering the receiver
   ONCE into a local fixes it.
2. **`__str_replace` is declared to return `$AnyString`, and the replaced result
   is a rope.** Holding it in a `$NativeString` local made the emitter insert a
   narrowing cast that trapped at runtime (*"illegal cast in
   __delete_property"*). Keep the local wide and call `__str_flatten` explicitly.

**Deliberately NOT done**: making the delete affect DISPATCH.
`built-ins/String/prototype/S15.5.4_A1` and `built-ins/RegExp/S15.10.4.1_A6_T1`
both delete a prototype's `toString` and then expect the call to fall back up the
chain to `Object.prototype.toString` (`"[object String]"` / `"[object RegExp]"`).
Measured after this slice they still answer `null` and `"/(?:)/"` respectively:
static member reads consult the compile-time `glue.memberCsv`, not the runtime
field, so a runtime delete cannot redirect them. That is a dispatch-model change,
not a member-set one.

**Controls**: 168/168. Widened again for this slice with
`Object/prototype/{hasOwnProperty,propertyIsEnumerable}`, `Number/prototype/toString`,
`Boolean/prototype/valueOf`, `Date/prototype/getTime`, `Array/prototype/slice`,
`String/prototype/lastIndexOf`, `RegExp/prototype/exec` — 31 further passing
neighbours. Four rows in that batch fail identically before and after
(`Number/prototype/toString/S15.7.4.2_A1_T01`, two `Boolean/prototype/valueOf`,
`Array/prototype/slice/15.4.4.10-10-c-ii-1`) and are excluded.

---

## Wave-4 lane I — HEAD 1: builtin-prototype NAME CAPTURE (2026-08-21)

Lane E isolated this and handed it on: an OWN data property whose name collides
with a builtin-prototype method is hijacked by that builtin's dispatch on a
receiver WITHOUT the brand. Base `da724268b0`, `--target standalone`, real
`runTest262File`.

### The capture set is 1,040 names, not four

Lane E named `dispose` / `move` / `defer` / `adopt`. **Enumerated from the
dispatch code itself** (`ctx.externClasses`, dumped with a throwaway probe at
the top of `tryExternClassMethodOnAny`, on a trivial standalone program): the
first-match loop's candidate pool carries **1,040 distinct method names** — the
whole ambient `lib.dom.d.ts` + builtin surface, from `addEventListener` to
`deref`. Every one of them is a capture candidate; the four lane E saw are the
ones its row happened to touch.

Measured hijack rate on base, deterministic sample of 100 of those 1,040
(`.tmp/genbatch.mjs`, mulberry32 seed 20260821, each name in a zero-arg
`o[<name>] = function(){return "R"}; o.<name>()` shape, 10 names per file):

| lane | names answering `"R"` | names answering wrongly |
| --- | ---: | ---: |
| base `da724268b0` | 95 / 100 | **5** — `cloneContents`, `getRemoteCertificates`, `getType`, `importNode`, `text`, each silently `null` |
| after this slice | **100 / 100** | 0 |

Plus the six lane E / adjacent-brand names, hand-probed one file each
(`.tmp/probe/h1c.js`, `h1f.js`): base `dispose`/`defer`/`adopt`/`use` throw
`TypeError: DisposableStack.prototype.<m> requires a DisposableStack receiver`,
`move` answers `null`, `deref`/`register`/`unregister`/`disposeAsync` **trap**
(`RuntimeError: dereferencing a null pointer`); after, all ten answer `"R"`.
The silent-`null` answers are the worse half — nothing in the program mentions
DisposableStack, and nothing reports an error.

### Root cause — the refusal never learned the bracket spelling

The #3033 guard in `tryExternClassMethodOnAny` (calls-closures.ts) already
declines extern dispatch when the program defines its own function-valued member
of that name. It sits ABOVE every claiming arm, so it is the one place that
covers all 1,040 names at once. `sourceDefinesFunctionMember`
(source-function-members.ts) scanned only the DOTTED write:

```js
o.dispose = function () {};     // seen  → refusal fires  → generic call ✅
o['dispose'] = function () {};  // MISSED → the loop claims the name    ❌
```

The bracket form is the dominant spelling in the ES5 sputnik corpus
(`seat['move']=function(){position++}`) and in any code building a method table
from string keys. The miss is **file-scoped**, which is why the defect hides:
add one dotted write of the same name anywhere in the file and every bracket
site starts working (`.tmp/probe/h1d.js` — four spellings, all pass, because the
file also contains `o.dispose = …`).

### Fix — at the refusal, not in the brand arm's else

New module `src/codegen/element-access-member-names.ts`:
`elementAccessAssignedMemberName(node)` returns the literal property name a
`<recv>[<key>] = <fn>` assignment writes. Two-line dispatch in
`source-function-members.ts`'s existing visitor. Literal keys only — a computed
key (`o[k] = fn`) names nothing at compile time, and widening to "some member
was written" would decline extern dispatch for every program touching a dynamic
property, far past the evidence.

**Why not the else arm of the DisposableStack brand test** (per wave-3 lane A's
"fix the claiming arm at its position"): the brand arm's MISS currently throws
`RequireInternalSlot`, and turning that into a generic-path fall-through would
have to be repeated once per builtin. The refusal runs before ALL of them, so
one recognizer retires the whole class. The brand arm keeps its throw, which is
still correct for the receiver it is actually meant to judge.

### Measured

**Rows flipped fail → pass: 1** — `language/types/object/S8.6.2_A5_T2.js`
(`seat['move']=function(){position++}`; it also needed lane E's implicit-global
`position++`, which is already on this base).

**Controls: 80 rows**, base-vs-after by file-copy revert, same runner, same
lane, quickjs runtime-eval provider built for each lane's own adapter key:
50 from `language/expressions/object` + `language/types/object` +
`built-ins/Object/{defineProperty,defineProperties}` (population 2,952) and 25
from `built-ins/{DisposableStack,WeakRef,FinalizationRegistry,Map,Set}`
(population 756) — the branded-builtin families added specifically because this
slice changes when their dispatch is claimed — plus the 5 target rows.
Deterministic shuffle seed 20260821.
**79 of 80 byte-identical; the one move is `S8.6.2_A5_T2` fail → pass.**
Base 59 pass / 21 fail; after 60 pass / 20 fail.

### Residual, deliberately not taken

`o[k] = fn` with a COMPUTED key stays captured. Closing it needs the runtime
dispatch to consult the receiver's own property table before the extern loop,
which is the dispatch-model change #2151 owns — not a scan widening.

---

## Wave-4 lane I — HEAD 2: a builtin prototype can never BE a `[[Prototype]]`

**WALL. Measured, bounded, not attempted.** Row set
`built-ins/Function/prototype/{apply/S15.3.4.3,call/S15.3.4.4}_A1_T{1,2}` — all
four verified failing on base `da724268b0` (`--target standalone`), all four on
the SAME assertion, `typeof obj.apply` / `typeof obj.call` answering
`"undefined"` where the spec says `"function"`. Each row's SECOND half — the
`obj.apply()` TypeError — already passes on base, so the typeof read is the
whole blocker.

### It is NOT the provider realm, and it is not a Function defect

Lane G filed this under "provider-realm carrier identity" (the 22-row
`Function(…)` wall). It is neither. `F.prototype = X; var o = new F;`, one
program, `.tmp/probe/h2c.js`, no `eval`, no `Function(…)`:

| `X` | `Object.getPrototypeOf(o)` | inherited member read |
| --- | --- | --- |
| `Function.prototype` | **null** | `undefined` |
| `Array.prototype` | **null** | `undefined` |
| `String.prototype` | **null** | `undefined` |
| an ordinary declared `function g` | **null** | `undefined` |
| `Object.prototype` | **null** | `function` (every object gets it anyway) |
| an object LITERAL | `=== X` ✅ | `function` ✅ |
| `new Object()` + expandos | `=== X` ✅ | `function` ✅ |

`Object.create(Array.prototype).slice` and `Object.setPrototypeOf(o, Function.prototype)`
fail the same way (`.tmp/probe/h2d.js`), and so does
`Object.create(Object.prototype)`. So the head is not "Function" and not "eval":
**no builtin prototype can serve as any object's `[[Prototype]]` in standalone.**

### Mechanical cause — one type, one `ref.test`

Builtin prototypes ARE identity-stable (`Function.prototype === Function.prototype`
→ true, two separate reads compare equal — `.tmp/probe/h2e.js`), and they answer
member queries: `Function.prototype.apply` is `"function"`,
`FP.hasOwnProperty("apply")` is `true`. But they are `$NativeProto` VALUE objects
(brand + member CSV, `array-object-proto.ts` / `builtin-brands.ts`), not native
`$Object`s — `Object.getOwnPropertyNames(Function.prototype)` returns **`[]`**,
which is the tell.

`$Object.$proto` is typed `ref null $Object`. Every seeding helper therefore
ends in the same two instructions — `__object_create`
(`object-runtime-prototype.ts` ~L104) does
`ref.test $Object` on its argument and stores `null` on a miss; the identical
coercion is written into `__object_setPrototypeOf` right below it. `new F()`
routes through `compileFnctorNewAsObject` (`expressions/new-super.ts` ~L1355) →
`__object_create(F.prototype)`, so a `$NativeProto` prototype silently becomes
`$proto = null` and every inherited read misses.

The per-fnctor prototype global itself is fine: `F.prototype === Function.prototype`
is **true** and `F.prototype.apply` is `"function"` after the assignment
(`.tmp/probe/h2b.js`). Nothing is lost at the WRITE; it is lost at the seed.

### Cost of closing it, and why this lane stopped

Closing it means giving `$Object.$proto` a representation that can hold a
`$NativeProto` — a second field, or a per-brand shim `$Object` materialized with
the brand's members as own closure properties — and then teaching the
`__extern_get` / `__extern_has` / `__getPrototypeOf` / `__isPrototypeOf` proto
walks to traverse it. That is the `$Object` dispatch model, touched in four
runtime helpers plus every walk.

Priced against the payoff: **a scan of all 328 remaining ES5 standalone rows
finds only these 4** using a builtin prototype as an object's `[[Prototype]]`
(`.tmp/scanproto.mjs`; the regex catches `X.prototype = <Builtin>.prototype`,
`Object.create(<Builtin>.prototype)`, `setPrototypeOf(_, <Builtin>.prototype)`
and `X.prototype = Function(…)`).

Two cheaper shapes were considered and rejected **as measured, not as guesses**:

- **Seed the fnctor prototype global with a materialized `$Object` when the RHS
  is syntactically `<Builtin>.prototype`.** It would flip these 4 — and it would
  make `F.prototype === Function.prototype` go **false**, trading a passing
  identity for a passing typeof. It also has to seed a `bind` property whose
  value cannot be built (`Function.prototype.bind` still refuses loud in
  standalone).
- **Answer `obj.apply` by a compile-time fold** keyed on the recorded prototype
  assignment. That is the same fold-instead-of-carrier move that produced the
  divergence documented above — `hasOwnProperty("apply")` true while
  `getOwnPropertyNames()` is empty. Adding another fold deepens the hole the 4
  rows are a symptom of.

So the boundary is: **the 4 rows are reachable only behind a `[[Prototype]]`
representation change, and the whole ES5 standalone gap behind that change is
those same 4 rows.** Worth doing when the `$Object` proto model is opened for
another reason; not worth opening it for.

## Wave-4 lane J — slice J1: the UNBACKABLE end of the array-index domain (2026-08-21)

Base `da724268b0`, `--target standalone`, in-process `runTest262File` probe.

### The defect

`vec-index-domain.ts` (#4434) established the model the whole vec family now
uses: `vec.length` is LOGICAL, the backing `$data` array may be shorter, and
every index in `[capacity, length)` is a HOLE. The READ side
(`vec-oob-read.ts`) and the `a.length = N` SETTER honour it. The element-STORE
side and `new Array(n)` did not — both unconditionally sized the backing to the
requested index/length, so three ordinary ES5 boundary idioms aborted the whole
module with an **uncatchable Wasm trap**, not a wrong answer:

| source                  | measured on base                                  |
| ----------------------- | ------------------------------------------------- |
| `x[2147483648] = 1`     | trap `array element access out of bounds`         |
| `x[4294967294] = 1`     | trap `array element access out of bounds`         |
| `new Array(4294967295)` | trap `requested new array is too large`           |
| `x[k-2] = k`, k = 2**32 | trap `requested new array is too large`           |

Two independent causes, both fixed:

1. **The index comparisons were SIGNED.** The index local holds a u32 bit
   pattern (index `2**32-2` arrives as `-2`), so `idx >= capacity` answered "no"
   and `array.set` ran out of bounds; `idx + 1 > vec.length` answered "yes" for
   an array whose length is already a huge u32, clobbering it downward.
2. **A numeric-literal index above `i32.MAX` SATURATED.**
   `tryEmitStaticI32Expression` refuses anything over `0x7fffffff` and the
   generic `compileExpression(key, {kind:"i32"})` fallback lowers it through
   `i32.trunc_sat_f64_s` → `2147483647`. That silently renamed the index:
   `x[2147483648] = 1` set `length` to `2147483648` where §10.4.2.2 requires
   `2147483649`, and `x[4294967294]` collapsed onto `x[2147483647]`'s slot.

### The change

New module `src/codegen/vec-sparse-index.ts` holds every body:
the unbackable-index flag, the three guard-condition builders, the guarded
element store, and the `new Array(n)` length/capacity split. The two call sites
(`expressions/assignment.ts` vec arm, `expressions/new-indexed.ts` Array arm)
gain dispatch only, and `array-nonindex-key.ts::compileElementIndexI32` gains
one arm for the high numeric literal. **No LOC / func / coercion / oracle
allowance was needed** — all four gates pass clean.

The ceiling is `16777216`, numerically identical to `SAFE_GROW_CEILING` in
`array-length-define.ts`, deliberately: an index write and a `length` write must
not disagree about which lengths are backed.

### Measured

Rows flipped `fail → pass` (2 of the 4 in the bucket):

| row                                        | before                             | after |
| ------------------------------------------ | ---------------------------------- | ----- |
| `built-ins/Array/S15.4.5.2_A1_T1`          | trap: element access out of bounds | PASS  |
| `built-ins/Array/length/S15.4.2.2_A2.1_T1` | trap: new array too large          | PASS  |

Control: **112 / 112 pass, zero regressions** — the passing neighbours of
`Array/prototype/{join,push,pop,slice,indexOf,map,forEach,sort,splice}`,
`Array/length`, `built-ins/Array`, `language/statements/for-in`, `Object/keys`
and `JSON/stringify` (the 112 rows of a 196-candidate sweep that pass on base).
Sparse-tail reads were separately verified: after `a[20000000] = 9` on a
3-element array, `a.length` is `20000001` and `a[0]`, `a[5]`, `a[19999999]`,
`a[20000000]` and the dynamic `a[i]` forms all answer correctly (no trap).

### Deliberate trade

A store at an index in `(16.7M, 2**32-2]` now LOSES its value (the slot becomes
a hole) where before it allocated a backing that large and kept it. That
exchanges a working-but-memory-hostile case for a whole class of terminal traps,
and it matches the rule `array-length-define.ts` already applies to the same
decision. No control row exercised it.

### Declined in this bucket, with reasons

- **`built-ins/Array/S15.4_A1.1_T10`** — needs genuine SPARSE element STORAGE:
  it writes and then reads back `x[k-2]` for `k = 2, 4, …, 2**32`, so indices
  `2147483646` and `4294967294` must round-trip a value. A hole cannot. This is
  the value-representation wall, not a guard bug. It no longer traps at the
  STORE; it now fails at the read of the unbacked index.
- **`built-ins/Array/length/S15.4.5.2_A3_T4`** — blocked by a **pre-existing,
  unrelated** module-scope defect that this slice did not introduce (verified by
  file-copy A/B against `da724268b0`): at MODULE-GLOBAL scope, an out-of-range
  index store combined with a `length` assignment corrupts ordinary element
  reads.

  ```js
  var x = [0, 1, 2];
  x[1];            // 1
  x[100] = 7;
  x.length = 2;
  // …but with BOTH statements present in the module, the FIRST read above
  // already answers `undefined` on base and after.
  ```

  The same code inside a function expression is correct, and either statement
  alone is correct. Not diagnosed further — it is a separate carrier/lowering
  choice for module-global arrays, outside this slice.

## Wave-4 lane J — slice J2: a join HOLE may inherit `Array.prototype[k]` (2026-08-21)

Base `1dfa99b78a` (slice J1), `--target standalone`.

### The defect

§23.1.3.18 step 4.b renders an ABSENT index as the empty string — but "absent"
is `Get(O, ToString(k))`, a full [[Get]] **with the prototype walk**, not "this
array's backing has no slot there". The #3224 bounds guard in
`compileArrayJoinNative` conflated the two: every index past the physical
backing joined as `""`, unconditionally. So the read path and `join` disagreed
about the same index:

```js
Array.prototype[1] = 1;
var x = [0]; x.length = 2;   // index 1 is a hole in x's backing
x[1];                        // 1     — the #4159 routed read already walks the chain
x.hasOwnProperty("1");       // false — correct, it is inherited
x.join();                    // "0,"  — expected "0,1"
x.toString();                // "0,"  — toString IS join
```

### The change

New module `src/codegen/array-join-proto-hole.ts`: the gate, the native
registration + scratch local (`ensureJoinProtoHoleLocal`), and the replacement
`else` arm, which re-asks `__extern_get_idx` — the SAME prototype-aware indexed
[[Get]] the routed element read uses, so the two cannot answer differently — and
still renders `""` when the walk finds nothing.

`compileArrayJoinNative` gains one import line, one arming call and the `else:`
swap (+5 LOC, allowance recorded above). The arming call must be in that
function: it has to run BEFORE the existing `externToStrIdx` capture or that
index shifts underneath it (#2043).

Gate: `ctx.standalone && ctx.protoIndexDirty` — the #4160 pre-scan flag, set
only by a module that writes an INDEX onto `Array.prototype` /
`Object.prototype`. With the flag clear, a hole cannot inherit anything, `""` is
exactly right, and the fold is byte-identical. The arm also only replaces the
`else` of a guard that already existed, so a DENSE array never reaches it.

### Measured

| row                                          | before | after |
| -------------------------------------------- | ------ | ----- |
| `built-ins/Array/prototype/toString/S15.4.4.2_A3_T1` | `"0,"` | PASS  |

Controls, both file-copy A/B against `1dfa99b78a`:

- The 112-row passing-neighbour set: **112 / 112, unchanged.**
- **The exact blast radius** — all 150 files under `built-ins/Array/**` that
  write `Array.prototype[…]` or `Object.prototype[…]`, i.e. every file that
  turns this gate on: 65 pass after, 85 fail after. Running the 85 on base:
  **85 / 85 also fail there** (no regression). Running the 65 on base: **64
  pass, 1 fails** — and that one is `toString/S15.4.4.2_A3_T1`, the intended
  flip. One row moved, in one direction.

### Declined in the same family, with reasons

- **`concat/S15.4.4.4_A3_T{1,2,3}`** — the same inheritance question for
  `concat`, and a gate routing a typed vec receiver to the existing §23.1.3.1
  loop (`array-concat-spec.ts`, prototype-aware via `__extern_get_idx`) was
  built and measured. It advances all three (`arr[1]` goes `0 → 1`, which is
  correct) but flips **none**, because each then needs one of two things this
  slice does not deliver, so it was NOT kept:
  - `A3_T1` asserts `arr.hasOwnProperty("1") === true` on the result. The loop
    returns an `$ObjVec`, and `__hasOwnProperty` (object-runtime.ts) has arms
    for `$Object` and the carrier bag but none for `$ObjVec` — measured
    `c.hasOwnProperty("0") === false` while `0 in c === true` on a freshly
    concatenated result.
  - `A3_T2`/`A3_T3` assert `b[1] === undefined`. `b` is statically `number[]`,
    so the read lowers to f64 and `undefined` arrives as `NaN`. That is the
    value-representation wall, not a concat bug.
- **`toLocaleString/S15.4.4.3_A{1_T1,3_T1}`** — `toLocaleString` is not aliased
  "by accident": `array-methods.ts` routes `case "toLocaleString"` into
  `compileArrayJoin` deliberately (#2863 Phase 2, "the locale-independent
  default is the same comma-join"). §23.1.3.32 requires
  `Invoke(element, "toLocaleString")` per element, which is a new fold, not a
  gate — J2's hole arm does not help, since the elements here are present.
- **`filter/15.4.4.20-9-b-{7,11,14,15}`**, **`toString/S15.4.4.2_A1_T2`**,
  **`concat/S15.4.4.4_A1_T{2,4}`** — the f64-hole value-representation wall.
  Direct measurement on `[0, , 2]` with `Array.prototype[1] = 1` set: the
  callback receives `NaN` at index 1 and the index is COUNTED, because the array
  is an f64 vec whose hole is a real `NaN`/`0` in the backing and
  `__extern_has_idx` therefore answers 1. `$Hole` exists only for externref
  vecs. Nothing above the value representation fixes these.

## Wave-5 standing-team dispatch plan (2026-08-21, base `c3522cad12`)

Model change by project-lead order: a STANDING team of four Opus lanes fed from
the TaskList, instead of per-wave fire-and-forget dispatch. The tech-lead
session files/updates the implementation plans here and in the sibling issue
files, keeps the TaskList stocked, integrates each lane's worktree serially
(gates as commit blockers), and re-measures.

| lane | task | rows | plan seed |
| --- | --- | ---: | --- |
| T1 | transferred builtin calls — `Array.prototype.X.call(plainObj)`, `String.prototype.{split,slice,substring,trim}` on non-String receivers, transferred `String.fromCharCode` closure | 16 (`.tmp/wave5-T1.txt`) | lane J re-fenced 4 Array rows here (its filter/9-b-2 isolation proves the non-transferred core passes); #2875 sizes the String half as its own L-slice (split/concat reflective glue bodies); lane F measured the fromCharCode pair (value survives, `typeof` right, no wired closure body — needs a static-method-body slice + [[Construct]] refusal). transferred-native-proto-call.ts (wave-3 salvage) is the existing machinery to extend. |
| T2 | Object descriptor/introspection residual — defineProperty (19), defineProperties (6), keys/gOPN/gOPD/freeze/isFrozen/valueOf/prototype | 60 (`.tmp/wave5-T2.txt`) | the wave-2/3 MOP slices closed everything whose cause lived in object-ops.ts/object-runtime-descriptors.ts; what remains is per-row: verify each against current head FIRST (list predates ~50 landed fixes), bucket by error, expect accessor-on-builtin-proto, global-object rows, arguments-object defines. |
| T3 | harness-blocked rows (10) + instanceof (6) + assignment (5) | 21 (`.tmp/wave5-T3.txt`) | harness rows fail inside propertyHelper/compareArray machinery — fix the underlying primitive each one exercises, never the harness. instanceof: lane A landed boolean branding; residual is builtin-namespace-carrier edges. |
| T4 | function-code (12) + annexB function-code (4) + statements/variable (3) + expressions in/addition/call/object (12) | 31 (`.tmp/wave5-T4.txt`) | function-code rows overlap the strict poison pills (provider-realm wall — measure and fence, don't fight) and arguments aliasing; annexB is sloppy-mode function semantics. |

Known walls the team must NOT re-attempt without a design change (measured
verdicts already on record above): f64-hole value representation ($Hole is
externref-only), provider-realm carrier identity, [[Prototype]] slot typing
($Object.$proto vs $NativeProto — priced at exactly 4 rows), toLocaleString
per-element Invoke fold, `arguments` isArray branding, #2151 computed-key
dispatch-model change.

Owed follow-up issues surfaced by wave 4 (file when a lane touches the area):
module-global array-carrier corruption (x[100]=7 + x.length=2 at module scope,
lane J), $ObjVec arm for __hasOwnProperty (lane J's concat gate blocker),
ToString-of-object user-toString dispatch (#1472, 6 rows + lane F's
String()-vs-call divergence).

### Wave-5 T1 result (2026-08-21, lane team-dev-1, base `0e71b59ed3`)

**Rows: 2/16 at start, 2/16 at end — no row flipped.** Both passing rows
(`fromCharCode/S15.5.3.2_A1`, `substring/S15.5.4.15_A1_T5`) already passed on
the branch base; the 14 failures were each re-verified on this HEAD before any
edit. Two mechanisms landed, each with a control run; every remaining row is
priced below.

| commit | change | control |
| --- | --- | --- |
| `b865397216` | transferred-proto ASSIGNMENT resolution + `Object.prototype.toString` transfer emitter | 60/60 |
| (this commit) | §20.1.3.6 `Math` / `JSON` namespace tag | 45/45 Math+JSON, 60/60 T1 neighbours, 42/45 toString-family (the 2 FAILs are pre-existing — verified by file-copy A/B against the base file) |

#### What the assignment arm fixed, and why it flipped nothing

Wave-3's `transferred-native-proto-call.ts` resolves a transfer written through
an object LITERAL. Every Sputnik-era genericity test writes it as an
ASSIGNMENT, which that module declines on purpose. Measured on the base:

| probe | base | now |
| --- | --- | --- |
| `var o={}; o.split=String.prototype.split; o.split()` | THREW `TypeError: Cannot access property on null or undefined` | `["[object Object]"]` ✓ |
| `var x={}; x.getClass=Object.prototype.toString; x.getClass()` | THREW same | `"[object Object]"` ✓ |
| `var a=[1,2]; a.g=Object.prototype.toString; a.g()` | THREW same | `"[object Array]"` ✓ |

The idiom now works. No T1 row flips on it alone because each row has a
SECOND, independent blocker behind the transfer — which the arm made visible:
the concat pair's error moved from the null-funcref TypeError to
`Array.prototype.concat is not yet callable as a value in --target standalone`,
naming the real gate (the owed `$ObjVec`-arm follow-up).

#### Per-row verdict for the 14 failures

| rows | blocker | verdict |
| --- | --- | --- |
| `concat/S15.4.4.4_A2_T{1,2}` | `Array.prototype.concat` has no value-callable body | the owed `$ObjVec` follow-up; the transfer half is now done |
| `split/instance-is-math` | the split receiver's ToString runs through `$__any_to_string` at RUNTIME, which has no static tag. The compile-time classifier now answers `Math` (`Object.prototype.toString.call(Math)` and `String(Math)` both correct), but the borrowed-receiver path does not consult it | needs `emitBorrowedStringReceiverToString` to fold a statically-known namespace receiver; NOT safe as a blanket object rule (an object with a user `toString` must dispatch to it) |
| `slice/S15.5.4.13_A3_T4`, `slice/S15.5.4.13_A1_T5` | ToString-of-object must call the receiver's USER `toString` | the owed #1472 follow-up |
| `trim/15.5.4.20-2-51` | `ToString(arguments)` answers `"1,2,true"` (array join) instead of `"[object Arguments]"` | the `arguments` isArray-branding WALL — do not re-attempt |
| `split/argument-is-regexp-and-instance-is-number` | transfer target is `Number.prototype`, not a variable | out of the assignment arm's shape by design |
| `split/arguments-are-boolean-…-instance-is-boolean` | `new Boolean` receiver + THREE args drops the `limit`; the same call with two args, or with a `{}` receiver and three, is correct | narrow wrapper-receiver arity edge, isolated but not fixed |
| `split/instance-is-number-1e21` | `new Number(-1e21)` receiver — "called value is not a function" | wrapper-receiver transfer, unpriced |
| `split/separator-regexp-limit-string-via-eval` | eval-dependent | unpriced |
| `filter/15.4.4.20-9-b-2` | `Cannot redefine property: configurable attribute of a non-configurable property` | unrelated to transfers; belongs with the T2 descriptor lane |
| `forEach/15.4.4.18-3-23` | `testResult !== true` | unrelated to transfers |

#### `String.fromCharCode` as a value — ATTEMPTED, NOT LANDED (full diagnosis)

The two `fromCharCode` rows need the extracted value to be CALLABLE. The
attempt was reverted, but the root cause is fully measured and the next lane
should not re-derive it:

1. The `default:` arm of `ensureStandaloneBuiltinStaticMethodClosure` reifies
   the value at its DECLARED arity (one). A four-argument call matches no
   funcref candidate, so the guarded `ref.cast` yields null and the failure
   (`TypeError: Cannot access property on null or undefined`) arrives from the
   DISPATCH — the body never runs. A variadic body on the `Math.max`
   `(ref null $vec_externref) -> externref` convention is the right shape.
2. **`resolveBuiltinStaticBindingAlias` only recognises the DESTRUCTURING
   spelling** (`const { ownKeys } = Reflect`). The plain
   `var f = String.fromCharCode` resolves to `undefined`, so the call site
   falls back to the TypeScript lib signature.
3. That fallback is what destroys the arguments. For a rest-parameter static
   the lib signature's single slot is a `number[]` vec, and the generic
   slot-by-slot loop compiles argument 0 against it. The emitted WAT for
   `String.fromCharCode(97)` is literally `f64.const 97` / `drop` /
   `ref.null 4` — evaluated, discarded, replaced by a null vec. Measured
   `f(97, 98)` answered NUL + `"b"`: argument 0 destroyed, argument 1 intact
   only because it overflowed into the separately-boxed extras path.
4. A fourth defect sits behind those: the #2933 variadic call-site arm coerces
   its externref result for `f64`/`i32` and passes `externref` through, but
   DROPS every other expected type and pushes a default. That never showed
   because `Math.max`/`Math.min` return numbers; a reified `fromCharCode`
   returns `string`, which lowers to `(ref $AnyString)`, so `f(97)` answered
   `undefined` with the correct `"a"` computed and thrown away.

So the slice is four coupled fixes (variadic body, plain-alias resolution,
argv-slot construction at the call site, ref-typed return recovery), not one.
`S15.5.3.2_A4` additionally needs a `[[Construct]]` refusal on the reified
value. Sized L, not S — the "static-method-body slice" estimate in the wave-5
seed was low.

**`Math.max` as a value works today only because its arguments survive the same
mis-compiled slot by accident of being numbers.** Anyone touching the variadic
convention should treat that as unowned behaviour, not as a working reference.

---

## Wave-4 lane H — the `arguments`-extras residual (2026-08-21, base `da724268b0`)

Four target rows were handed over as one head ("extras beyond the formals").
They were three unrelated defects plus one already-fixed row. Measured on the
integration base BEFORE any edit, `--target standalone`, serial single-test
probes:

| row | base | cause |
| --- | --- | --- |
| `language/statements/function/S13.2_A2_T1` | fail — null deref in `__module_init` | synthetic-rest signature (slice H1) |
| `language/statements/function/S13.2_A2_T2` | fail — same | synthetic-rest signature (slice H1) |
| `language/statements/function/S13.2.2_A5_T1` | **pass** | already closed by wave-3 lane D; no work needed |
| `language/statements/function/S13_A11_T4` | fail — `delete arguments[i]` did nothing | runtime-index delete (slice H2) |
| `language/statements/function/S13_A2_T2` | fail — `x === 2`, want `"11"` | dynamic `+`; NOT taken, see below |

### Slice H1 — the checker's synthetic `arguments` rest parameter

**The call/callee arity contract, measured rather than assumed.** A shape
matrix (`function` declaration vs expression × 0/1/2 formals × called
direct / through a `var` alias / through a returned closure), read as
`arguments.length` plus `typeof arguments[i]` for i in 0..3:

| shape | base | after |
| --- | --- | --- |
| 0/1/2-formal declaration, called DIRECT with 4 args | correct | correct |
| 0-formal function EXPRESSION, called direct | correct | correct |
| 0-formal, through a returned closure, 1 arg | `len=1`, `[0]` **null** | `len=1`, `[0]` string |
| 0-formal, through a returned closure, 2 args | `len=2`, `[0]` **null**, `[1]` ok | both correct |
| 0-formal, through a returned closure, 0 args | `len=0` | `len=0` |

The direct-call path was never broken, and `arguments.length` was never wrong —
which is why the head read as "extras". The actual defect is upstream of the
extras protocol: TypeScript, compiling a `.js` file, gives a function that reads
`arguments` the signature `(...args: any[]): any` even though the declaration
lists no parameters. Traced at the call site, `g("jedi")` resolved
`matchedClosureInfo.paramTypes = [ref_null $vec_externref]` against
`sigStr = (...args: any[]): any`.

Four dispatch sites read `sig.parameters` directly. Believing the synthetic
symbol is a formal, they (1) coerced actual argument 0 to the rest ARRAY type —
a string is not a vec, so the guarded cast NULLED it, and the null is what got
packed into `__extras_argv` — and (2) set `__argc = 1`. `totalLen = argc +
extrasLen` therefore stayed right while slot 0 was filled from neither formals
nor extras. That is exactly the "argc and extras disagree" symptom, one level
down.

`runtimeSignatureParameters` (calls-closures.ts) already existed for this, with
this diagnosis already in its doc comment; it was private and used at one site.
Exported and applied at the four arity-resolution sites: `compileIdentifierCall`,
`compileExpressionCallee`, and both `compileTailDispatch` arms (the
CallExpression-callee arm is the one `__FUNC()(__JEDI)` takes — the identifier
arm alone left both S13.2_A2_T* still failing).

**Blast radius, measured.** 903-row control set — `built-ins/Function/prototype/
{call,apply}` (the wave-3 flip canaries), `language/arguments-object`,
`language/statements/function`, `language/expressions/call` — run serially per
row, file-copy A/B on one head:

| | pass | fail | compile_error |
| --- | ---: | ---: | ---: |
| base `da724268b0` | 642 | 249 | 12 |
| after H1 | **664** | 227 | 14 |

**+22 `fail` → `pass`, 0 `pass` → anything.** Two of the 22 are the target rows;
the other 20 are collateral —
`language/arguments-object/*async-gen-meth-args-trailing-comma-*` (async-generator
methods, plain and on class decl/expr, static and instance), which read
`arguments` and hit the identical defect.

The two `fail → compile_error` rows in the raw diff
(`built-ins/Function/prototype/apply/S15.3.4.3_A3_T9`,
`language/statements/function/param-eval-non-strict-is-correct-value`) are NOT a
regression: both are eval-dependent and both report the missing QuickJS provider
artifact. With the artifact linked they pass identically before and after. The
whole control run was executed without that artifact, so its absolute pass
counts understate eval-dependent rows — identically on both sides, so the delta
stands.

### Slice H2 — `delete arguments[i]` with a RUNTIME index

`S13_A11_T4` loops `for (var i = 0; i < arguments.length; i++) { delete
arguments[i]; … typeof arguments[i] === "undefined" }` on a **zero-formal**
declaration. Two things blocked it:

1. `emitPropertyDeleteWithUnmappedArgumentsWriteback` handled only a LITERAL
   index (`ts.isNumericLiteral` / `isStringLiteral`), so a runtime `i` never
   cleared the backing vec — `__delete_property` reported `true` and the read
   still returned the original argument.
2. It also bailed on `fctx.mappedArgsInfo` being present at all. A zero-formal
   function DOES get a `mappedArgsInfo` record (its [[ParameterMap]] is simply
   empty), so the writeback was skipped for exactly the functions where every
   index is unmapped. The bail is now `paramCount > 0`.

The externref key becomes an index through `coerceType` (the single coercion
engine), then a `f64(trunc(v)) === v && v >= 0` guard: NaN (a non-numeric key)
and any fraction are rejected, so `delete arguments["nope"]` leaves the vec
alone. The conversion is emitted BEFORE `__delete_property`'s funcIdx is
captured — a late import registered after that point shifts the already-planned
call.

Measured (probe, 4 args, `typeof arguments[i]` after each delete):

| shape | base | after |
| --- | --- | --- |
| 0-formal, `delete arguments[i]` in a loop | all four keep their values | all four `undefined` |
| 0-formal, `delete arguments[0]` literal | `undefined` (already worked) | unchanged |
| 0-formal, `delete arguments[k]`, `k = "nope"` | slot 0 kept | slot 0 kept |
| 1-formal, `delete arguments[i]` in a loop | values kept | **values kept — deliberately unchanged** |

### Deliberately NOT taken, with the measurement

- **The MAPPED runtime-index delete** (the 1-formal row above). §10.4.4.5 says a
  successful delete on a mapped index both removes the slot and severs the
  param↔arguments map. The existing mapped arm does that for literal indices
  only; extending it to runtime indices would clear the slot without severing
  the map (a later `a = 5` would re-mirror into the cleared slot), which is a
  different wrong rather than right. No row in the set demands it.

- **`S13_A2_T2` — `arg + arguments[1]` must pick the DYNAMIC `+`.** Still fails
  identically after both slices (`x === 2`, wants `"11"`), so the extras fixes
  left it as the sole blocker, as lane G predicted. It is not narrow: the gate
  is `leftIsAny && rightIsAny` in `binary-ops.ts` (~L1004), computed from the
  CHECKER type of each operand, and the fix has to change which operand types
  reach a value-representation decision — `#2106` territory, not this lane's.

- **`arguments.length` was never the defect anywhere in this head.** Every shape
  in the matrix reported it correctly before and after. A fix that "corrected"
  it would have been the silent-wrong-answer outcome lane G warned about.

### Lane H combined tally

End to end, integration base `da724268b0` → `66be196878`, same 903-row control
set: **+23 `fail` → `pass`, 0 `pass` → anything** (22 from H1, 1 from H2). Six
rows move across `compile_error` in the raw diff (4 to `pass`, 2 to `fail`), all
in `built-ins/Function/prototype/apply/` — the QuickJS eval-adapter cache raced
between the four measurement shards. Re-run serially in one process, every one
of them reports the same status with and without the change.

The wave-3 `Function/prototype/{call,apply}` `S15.3.4.{3,4}_A{6,7}` canary
family (24 rows) is byte-identical before and after: 1 pass / 23 fail on both
sides. It was already failing at the integration base; this lane neither helps
nor harms it.

Three of the four target rows now pass (`S13.2_A2_T1`, `S13.2_A2_T2`,
`S13_A11_T4`); `S13.2.2_A5_T1` was already passing at the base. `S13_A2_T2`
remains the one open row, on the dynamic-`+` head recorded above.

## Wave-5 lane T4 — slice T4-A: §13.15.3 `+` never reduced an OBJECT operand (2026-08-21)

Base for every number below: `0e71b59ed3`, measured in this worktree with
`runTest262File(..., "standalone")` on the 31-row `.tmp/wave5-T4.txt` set.
**T4 baseline on that head: 2/31 pass** — `10.4.3-1-64-s.js` and
`10.4.3-1-65-s.js` were already green and are NOT counted as flips.

### What was wrong

`emitAnyAdd` (binary-ops.ts) is a fully spec-shaped §13.15.3: it reduces both
operands with `__to_primitive` (default hint) and only then chooses
concat-vs-numeric. Its gate admitted an operand **only when the static type is
`any`/`unknown`**. Every operand with a real object type — a `Date`, a function,
an object literal — missed it and fell through to the f64 numeric lowering,
where an object unboxes to NaN. This is half (b) of the relational defect
already written down in `relational-to-primitive.ts`, in the operator that file
explicitly says was fine ("`f + ""` produced the correct string all along").
That sentence is true and misleading: it holds only because a statically-STRING
operand is caught by an earlier `isStringType` gate, so the spelling one reaches
for when checking is the one spelling that never reaches the broken path.

Three independent defects stacked behind that gate, each invisible until the one
above it was fixed:

| # | defect | evidence |
| - | --- | --- |
| 1 | object-typed operand never reached `emitAnyAdd` | `f1 + 1` → NaN; `{} + f1` → NaN |
| 2 | `tryStaticToNumber` folded `{} + {}` to `NaN` **before** any operand analysis | `{} + {}` → NaN while `var a={},b={}; a+b` → `"[object Object][object Object]"` — one expression, two answers |
| 3 | `__to_primitive`'s non-`$Object` tail returns a closure / `Date` struct UNCHANGED | `f1 + f1` → NaN after #1 was fixed |

Defect 2 is the one worth naming: the folder is a **ToNumber** folder, and
`NaN` is its right answer for `+{}` / `Number({})`. Reusing it for binary `+`
silently answered a different question, and only the literal-vs-variable
spelling difference exposed it.

### Change

New module `src/codegen/add-to-primitive.ts` (all new bodies; `binary-ops.ts`
gets dispatch wiring only):

- `admitsObjectAdd(ctx, left, right)` — the operand gate, deliberately the same
  predicate as `admitsObjectRelational` (`isObjectOperandType` is now exported
  from `relational-to-primitive.ts` rather than forked) and the same target gate:
  `semanticProviders === "native-first"` + native strings. The js-host/gc lane is
  byte-identical and remains the regression guard, exactly as #1374's 14
  runtime_error regressions require.
- `emitAddOrdinaryToPrimitiveResidue(...)` — §7.1.1.1 steps 2-5 run against a
  ToPrimitive result that is STILL an object: `valueOf` then `toString` via
  `__extern_get` + the accessor-get driver, accepting only a primitive, falling
  back to the runtime ToString. Scoped to the `+` dispatch, **not** to
  `__to_primitive` itself: that tail's "return unchanged" answer is load-bearing
  for shapes which early-out above it, and the file records two
  action-at-a-distance regressions (boxed-boolean, native error) caused by
  exactly that kind of widening.
- `addOperandCallableSourceText(...)` — §20.2.3.5 step 1. `f1 + 1` must equal
  `f1.toString() + 1`, and `f1.toString()` is already served from
  `ctx.funcSourceText` (#1463). The `+` operand asks the SAME map by the SAME
  key so the two spellings cannot disagree. Four guards: not a local (#3364
  shadowing), never assigned (`identifierIsWrittenTo`), no `f.valueOf=` /
  `f.toString=` / computed-member assignment anywhere in the file, and a call
  signature per `ctx.oracle.signatureOf`.
- the constant fold is skipped when `admitsObjectAdd` owns the `+` (defect 2).

### Measured

| row | base | after |
| --- | --- | --- |
| `language/expressions/addition/S11.6.1_A2.2_T3.js` | FAIL (`f1 + 1` → NaN) | **PASS** |
| `language/expressions/addition/S11.6.1_A3.2_T1.2.js` | FAIL (`({} + fn)` → NaN) | **PASS** |
| `language/expressions/addition/S11.6.1_A2.2_T2.js` | FAIL (NaN) | FAIL — now `"[object Object][object Object]"`, see below |

Control: 70 passing neighbours (`language/expressions/{addition,subtraction,
multiplication,relational,equality,typeof,template,comparison}`,
`built-ins/Date/prototype/{toString,toDateString,valueOf,getTime}`,
`built-ins/String/prototype/concat`), **66/70 base, 66/70 after — identical
set**. The 4 non-passing rows were verified failing on base by file-copy A/B
(3× `prop-desc` "descriptor should be configurable", 1× a template-literal
legacy-octal negative test); none is addition-related.

### Left open, with the reason

`S11.6.1_A2.2_T2` (`new Date(0) + new Date(0)`) is now correctly reduced to a
STRING and correctly concatenated — it fails only because that string is
`"[object Object]"`. A standalone `Date` is the nominal `__Date` struct, so it
reaches `__any_to_string`'s generic terminal, which has no Date arm. The
statically-resolved `d.toString()` is right (`builtins.ts` folds it to
`__date_format_string(ts, 2)`); every DYNAMIC spelling — `String(d)`, `"" + d`,
`d + d`, a template substitution — answers `"[object Object]"`. That is one
value with two renderings and it is not an addition defect; the fix belongs in
`__any_to_string`'s terminal, alongside the `__error_to_string` arm. Closed as
slice T4-B, below.

## Wave-5 lane T4 — slice T4-B: a DYNAMIC Date rendered as `[object Object]` (2026-08-21)

Same base `0e71b59ed3`, on top of slice T4-A.

### What was wrong

A standalone `Date` is the nominal `__Date` struct (one i64 `[[DateValue]]`
field). It is not a `$Object`, not a `$__vec_base`, and it contributes no
`__call_toString` dispatcher arm, so it fell through every arm of
`__any_to_string` to the canonical `"[object Object]"` terminal. Measured on
`new Date(0)`, standalone:

| spelling | base | after |
| --- | --- | --- |
| `d.toString()` | `Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)` | unchanged |
| `String(d)` | `[object Object]` | `Thu Jan 01 1970 …` |
| `"" + d` | `[object Object]` | `Thu Jan 01 1970 …` |
| `d + d` | `[object Object][object Object]` | two date strings |

The static call was right all along — `builtins.ts` folds `d.toString()` to
`__date_format_string(ts, 2)`. Every DYNAMIC spelling reached a different
terminal that had never heard of Dates. The failure is easy to miss precisely
because the spelling one reaches for when checking (`d.toString()`) is the
correct one.

### Change

New module `src/codegen/date-any-to-string.ts` mints
`__date_any_to_string(anyref) -> ref $AnyString`: cast to `__Date`, read
`[[DateValue]]`, render the Invalid-Date sentinel (i64 MIN) as the literal
`"Invalid Date"` (§21.4.4.41.4 step 3), else call **the same**
`__date_format_string(ts, mode 2)` the static path uses — so the two spellings
cannot drift. `native-strings.ts` gets wiring only: a `ref.test __Date` arm
wrapped around the existing `objectOrErrorTag`, on the identical
factory-`loadRef` discipline the error arm uses (#1448 — an aliased `Instr`
array double-shifts funcIdx when post-codegen passes walk the tree).

`ensureDateFormatStringHelper` is now exported from `expressions/builtins.ts`.
It is called BEFORE `__any_to_string`'s own index is baked, the same ordering
rule the neighbouring `ensureErrorToStringHelper` call documents: it only
APPENDS defined functions, so nothing already emitted shifts.

**Demand gate:** `ctx.structMap.get("__Date") === undefined` ⇒ the module never
constructed a Date ⇒ nothing is minted and the terminal is byte-identical. That
gate is exact rather than heuristic — the struct type is registered by
`ensureDateStruct`, which only a real Date construction or Date method call
reaches.

### Measured

`language/expressions/addition/S11.6.1_A2.2_T2.js` FAIL → **PASS** (T4 rows now
3/3 on the addition bucket).

Control: 79 passing neighbours weighted toward the shared terminal this touches
— 25 `built-ins/Date/**`, 12 `built-ins/{Error,TypeError,RangeError}/**`,
10 `built-ins/Array/prototype/{join,toString}/**`, 12 `built-ins/String/**`,
10 `built-ins/JSON/stringify/**`, 10 `language/expressions/template-literal/**`.
**75/79 base, 75/79 after — identical set.** The 4 non-passing rows were
verified failing on base by file-copy A/B (3× `prop-desc` "descriptor should be
configurable", 1× the template-literal legacy-octal negative test); none is
ToString-related.

## Wave-5 lane T4 — slice T4-C: a `var`-declared script global had no BINDING (2026-08-21)

Same base `0e71b59ed3`, on top of T4-A/T4-B.

### What was wrong — one binding, three spellings, three answers

§9.1.1.4.17 CreateGlobalVarBinding was never implemented. Its FUNCTION sibling
(§9.1.1.4.18) landed in #4394, so GlobalDeclarationInstantiation was half done,
and the `this.x` / `this["x"]` pair had been fixed in the read direction only.
Measured on this head for `var __variable`:

| probe | base | spec |
| --- | --- | --- |
| `__variable` (bare read) | works | works |
| `this["__variable"]` (read) | works (#4491 bracket read arm) | works |
| `this["__variable"] = v` (write) | lands on the realm OBJECT, invisible to every read | writes the binding |
| `delete __variable` | `false` | `false` |
| `delete this["__variable"]` | **`true`** | `false` |
| `for (var p in this)` | lists top-level FUNCTIONS only | lists vars too |

Each row is the same binding asked a different way. The write one is the worst
shape: `this['x'] = "baloon"` succeeded, and then **nothing could read it back**
— not `this['x']`, not the bare identifier — because the read had already been
moved to the module global while the write had not. That is the exact hazard
#4500 Slice A documents in the opposite direction, and it says why: a half-fixed
read/write pair is worse than neither half.

### Change

Three small pieces, two of them new modules:

1. `global-environment.ts` — `isNonConfigurableGlobalObjectDelete` accepts the
   ELEMENT-access spelling (string-literal key) as well as the dot form, and
   unwraps parens on the operand. `S12.2_A2` spells its checks
   `delete(this["__variable"])`, so the operand is a `ParenthesizedExpression`
   and an unwrapped test misses the very files the guard exists for.
2. `src/codegen/realm-global-element-write.ts` (new) —
   `tryEmitRealmGlobalElementWrite`, the bracket twin of #4500 Slice A's dot
   write. Only a compile-time-resolvable key, only a proven realm-global
   receiver, only a name that already has a wasm module global; anything else
   declines byte-identically. `compileElementAssignment` gets 4 lines of
   dispatch wiring.
3. `src/codegen/global-var-bindings.ts` (new) — `emitScriptGlobalVarBindings`,
   §9.1.1.4.17, modelled directly on `global-function-bindings.ts` and emitted
   right after it at the top of `__module_init`. Attributes
   `{writable:true, enumerable:true, configurable:false}`; value `undefined`,
   which is what GDI initialises a var binding to.

   The "already present" test is a **runtime** `__hasOwnProperty` consult, not a
   skip-list: the realm object is pre-seeded with builtins (`NaN`, `Infinity`,
   `undefined`, `globalThis`, the §19.2 functions, the namespace objects) whose
   attributes differ, and `var NaN;` must not redefine them. A hardcoded list
   would have to track every future seed; the spec's own test cannot go stale.
   Names that are also top-level function declarations are skipped at compile
   time — the function binding is the one GDI initialises.

### Measured

| row | base | after |
| --- | --- | --- |
| `language/statements/variable/S12.2_A2.js` | FAIL (`delete this["v"]` → true) | **PASS** |
| `language/statements/variable/S12.2_A11.js` | FAIL (write invisible to reads) | **PASS** |
| `language/statements/variable/S12.2_A9.js` | FAIL (for-in skipped the var) | **PASS** |

Control: 101 passing neighbours chosen for what this touches — 15
`language/statements/for-in`, 14 `built-ins/Object/{keys,getOwnPropertyNames,
getOwnPropertyDescriptor}`, 12 `language/global-code` (+annexB), 12
`language/statements/variable`, 12 `language/expressions/assignment`, 12
`language/statements/function`, 12 `language/eval-code`, 12
`language/{identifiers,block-scope}`. **99/101 base, 99/101 after — identical
set**; the 2 non-passing rows (`language/global-code/export.js`,
`language/statements/function/invalid-function-body-2.js`, both negative
"should not be evaluated" tests) were verified failing on base by file-copy A/B.

### Known residual, stated rather than hidden

`Object.getOwnPropertyDescriptor(this, "v").value` reports the initial
`undefined`, not the live value: the realm property is a BINDING record while
the wasm module global is the VALUE. Every read spelling resolves to the module
global, so nothing observes the stale slot except a descriptor read. Closing it
means making the two one cell — a representation change, not a seeding change,
and out of scope here.

## Implementation Plan (T7) — provider-realm carrier identity (2026-08-21)

Base `437da6e582` (lane worktree `worktree-agent-a2b0a2cc453cd1af2`). Every
number below was measured on that HEAD with the real `runTest262File`
(`--target standalone`, quickjs eval provider ACTIVE — the tier line
`QUICKJS (artifact 073742801ba7, adapter key 1429ec7ecf2163fd)` appears on every
run), not inherited from the wave-4 lane G table.

### The marshalling contract as it stands today

A value crossing the provider→caller seam takes one of three shapes, and the
shape decides which caller-side surfaces answer:

| provider value | crosses as | caller sees |
| --- | --- | --- |
| interpreted callable (`Function(src)`, an eval-defined function) | `$RuntimeEvalAotCallable` carrier (`runtime-eval-callable.ts`), wrapping the raw provider marker | `typeof` ✓, call ✓, `.name`/`.length` ✓ (carrier property-get trampoline), `hasOwnProperty("name"/"length")` ✓ |
| the realm's `%Function%` / `%eval%` intrinsic (bare `Function` read) | raw `$RuntimeEvalInterpretedCallback` marker, kind `INTRINSIC_FUNCTION` — deliberately NOT wrapped, so repeated reads stay reference-identical | `typeof` ✓, call ✓, `.name`/`.length`/`.constructor` ✓ (marker arm in the universal property getter), **`hasOwnProperty` ✗, `delete` ✗, `getOwnPropertyNames` ✗** |
| any other object (plain object, array, RegExp) | #4245 slice-2 **mirrored box** — a compiled `$Object` carrying the QuickJS object's own string keys, resynced at each seam crossing | own data properties ✓; **no [[Prototype]], no exotic brand** |

Measured surface for `var f = Function("a","b","return a+b;")`:

| probe | HEAD | spec |
| --- | --- | --- |
| `typeof f` | `function` | `function` |
| `f(1,2)` | `3` | `3` |
| `f.length` / `f.name` | `2` / `anonymous` | `2` / `anonymous` |
| `f.hasOwnProperty("name")` / `("length")` | `true` / `true` | `true` |
| `typeof f.call` / `typeof f.apply` | `function` | `function` |
| `f.constructor === Function` | `true` | `true` |
| `Object.prototype.toString.call(f)` | **`[object Object]`** | `[object Function]` |
| `Object.getPrototypeOf(f) === Function.prototype` | **`false`** | `true` |
| `f.hasOwnProperty("prototype")` / `typeof f.prototype` | **`false` / `undefined`** | `true` / `object` |
| `Function.hasOwnProperty("prototype")` / `("length")` | **`false` / `false`** | `true` |
| `delete Function.prototype` | **`true`** | `false` |
| `Object.getOwnPropertyNames(Function)` | **`""`** | `length,name,prototype` |

### Correction to the wave-4 lane G triage: two of its rows are NOT provider bugs

Lane G recorded `Object.getPrototypeOf(fn) === Function.prototype` as a
carrier-identity gap and attributed the four
`Function/prototype/{call,apply}/S15.3.4.{3,4}_A1_T{1,2}` rows to it. Measured
here, that attribution is wrong and would have sent this lane at the wrong
subsystem:

```
var proto = Function(); function FACTORY(){} FACTORY.prototype = proto;
var obj = new FACTORY;
  Object.getPrototypeOf(obj) === proto   →  false     ← the real blocker
  typeof proto.call                       →  "function"  (the carrier is fine)
```

and with an ORDINARY function as the prototype the same probe fails identically
(`FACTORY2.prototype = function(){}; Object.getPrototypeOf(obj2) === FACTORY2.prototype`
→ `false`). So those four rows are the **[[Prototype]]-slot typing wall**
(`$Object.$proto` vs `$NativeProto`) that the wave-5 dispatch table already
prices at exactly 4 rows — not the provider seam. **Non-goal for T7.**

### Ordered slices, with per-slice row counts verified on HEAD

| # | slice | rows | verdict |
| --- | --- | ---: | --- |
| A | §20.1.3.6 tag for a `Function`-typed receiver | 3 | LANDED |
| B | `%Function%` own-property surface (`hasOwnProperty` / `delete`) | 3 | LANDED |
| C | provider-box re-hydration (RegExp + Array [[Prototype]] / brand) | 10 | NOT ATTEMPTED — priced below, blast radius exceeds the row count |
| D | strict `caller` poison pills (`15.3.5.4_2-*gs`) | 5 | NOT ATTEMPTED — composes C-class work with strict-mode `caller` |

**Slice A — the tag.** `Object.prototype.toString.call(<Function-typed value>)`
answered `[object Object]`. The cause is not the runtime classifier (which
delegates to `__typeof_function` and is correct) but the #2501 COMPILE-TIME fold
`resolveObjectToStringTag` (`object-proto-tostring.ts`): it reaches its
`callSigs.length > 0` arm only for values whose type HAS call signatures, and
lib.d.ts's ambient `Function` interface declares `apply`/`call`/`bind` and no
call signature. Every `Function(…)` / `new Function` result types as exactly
that interface, so it fell through to the standalone `Object` default. The same
spec fact is already encoded one file away, in
`function-intrinsic-carrier.ts`'s `isFunctionValuedReceiverType`.

Rows: `built-ins/Function/S15.3.5_A1_T1`, `S15.3.5_A1_T2`,
`built-ins/Object/prototype/toString/Object.prototype.toString.call-function.js`.

**Slice B — the own-property surface.** `Object`/`Array`/`String`/`RegExp` all
answer `hasOwnProperty("prototype")` correctly because their bare read yields
the #3006 `__builtin_ctor_*` carrier, whose own props `pushBuiltinCtorOwnPropSeed`
seeds. `Function` alone routes to the provider marker (that is failure mode 1 in
`function-intrinsic-carrier.ts`'s header), and the marker is invisible to
`__hasOwnProperty` / `__object_hasOwn` / `__delete_property`. Swapping the bare
read to the carrier is the fix #4440 already tried and rejected — the carrier has
no [[Call]], and `var F = Function; F("a","return a")` must keep working. So the
marker keeps its identity and GROWS the surface instead.

`delete` is load-bearing here and not a separate nicety: test262's
`isConfigurable` is `delete obj[name]; return !__hasOwnProperty(obj, name)`, so
`S15.3.3.1_A3` needs BOTH halves. Rows: `built-ins/Function/S15.3.3_A1`,
`S15.3.3_A3`, `built-ins/Function/prototype/S15.3.3.1_A3`.

**Slice C — box re-hydration, priced and declined.** An eval-returned RegExp or
non-empty Array crosses as the mirrored box, so it has no [[Prototype]] and no
exotic brand:

```
Object.getPrototypeOf(eval("/1/g"))              →  null   (want RegExp.prototype)
Object.getPrototypeOf(eval("[1,2]"))             →  null   (want Array.prototype)
Object.prototype.toString.call(eval("[1,2]"))    →  "[object Object]"
typeof eval("/ab+c/g").exec                      →  undefined
```

Rows (all verified FAIL on HEAD): the six
`language/statementList/eval-{block,class,fn}-regexp-literal{,-flags}.js` and
four `language/statementList/eval-{block,class,fn}-array-literal{,-with-item}.js`.

The only shape that fixes them is minting the value in the CALLER's realm, the
way #4308 slice A already does for the seven error constructors — i.e. the
adapter calls back through `realm.RegExp(source, flags)`. That is blocked one
step earlier, and the block is measured, not assumed:

```
var G = Function("return this;")();
  typeof G.Array   →  "function"
  typeof G.RegExp  →  "undefined"      ← the realm object does not expose RegExp
  G.RegExp === RegExp  →  false
```

So slice C is: (1) add `RegExp` (and the rest of the exotic-constructor set) to
the caller's realm-object seed, (2) teach `qjsPublish` to detect the exotic class
and mint through the realm constructor, (3) rebuild + republish the quickjs
adapter artifact. Step 1 changes what EVERY eval-linking module publishes on its
global object, and step 3 invalidates the adapter cache key for every lane. Ten
rows do not buy that blast radius in this lane's budget — it wants its own slice
with its own control corpus. Recorded here so the next lane starts from the
measurement rather than re-deriving it.

**Slice D — poison pills, not attempted.** Four of the five build the strict
function through `Function("\"use strict\"; …")`, so they need slice C's class of
work (a provider-materialized function whose strictness is observable to the
caller's `caller` accessor) plus §9.2.7 `caller`-poisoning across the seam. The
substrate (`function-poison-pill.ts`) exists; the seam half does not.

### Adjacent findings, filed rather than fixed

- `Date.hasOwnProperty("prototype")` and `("length")` are **false** (rows
  `built-ins/Date/S15.9.4_A1`, `S15.9.4_A5`). Same shape as slice B but a
  different cause: `Date` is in `BUILTIN_CTOR_ARITY` and NOT in
  `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES`, so its bare read mints no carrier at all.
  Cheap-looking, but adding `Date` to the identity set changes every bare `Date`
  read and needs its own control run.
- `Object.getPrototypeOf(Map) === Function.prototype` is **false** while the same
  probe on `Array`/`Object` is **true** — the #3006 identity carriers do not seed
  `$proto`. Feeds `built-ins/{Map,Set,WeakMap,WeakSet,WeakRef,FinalizationRegistry,
  DisposableStack,AsyncDisposableStack}/…proto…` (~8 non-ES5 rows).

### Wave-5 lane T2 result (standing dev `team-dev-2`, 2026-08-21)

Base `0e71b59ed3`. **60 rows → 9 passing before any edit, 19 after.** The row
list predates ~50 landed fixes, so the first action was re-verifying every row
on head: 9 were already green (`15.2.3.6-4-{292-1,293-2,293-3,294-1,295-1,296-1,59}`,
`getOwnPropertyNames/15.2.3.4-4-44`, `keys/15.2.3.14-1-3`) and are **not**
counted below.

| slice | sha | rows flipped | control |
| --- | --- | --- | --- |
| Native `{Number,String,Boolean}.prototype.valueOf` bodies | `fd244dbf3b` | `S9.9_A{3,4,5}` | 55/55 |
| Derive §7.3.15 `TestIntegrityLevel` for `isFrozen`/`isSealed` | `b9867ff1c1` | `isFrozen/15.2.3.12-{2-1,2-2,3-28}` | 127/127, 0 regressions |
| Per-binding single-assignment proof + `new Object(prim).valueOf()` | `7d3b693be0` | `prototype/valueOf/S15.2.4.4_A1_T{1,2,3}` | 240/242 (2 pre-existing) |
| `arr.hasOwnProperty(<index>)` sees a deleted element | `8a6bdbcffb` | `getOwnPropertyNames/15.2.3.4-4-b-6` | 119/120 (1 pre-existing) |

Three findings worth more than their row count:

- **One regression was self-inflicted and caught only by the wide control.**
  The first `valueOf` body returned non-null, which short-circuits `makeGlue`'s
  `??` refusal, so a non-wrapper receiver fell off the end of the function
  instead of throwing — `Boolean/prototype/valueOf/S15.6.4.3_A2_T5` went pass →
  fail. A body that replaces a refusal must carry the refusal's throw itself.
  Fixed in `7d3b693be0`.
- **#4232's name-level single-assignment scan can never fire in test262.** The
  harness is concatenated into the same source file, so `assert.js` /
  `propertyHelper.js` parameters poison every short spelling (`a`, `obj`, `x`).
  Measured: `var a = new Object(1.1); a.constructor` traced to "a POISONED".
  `single-assignment-binding.ts` now answers per BINDING. Any future guard that
  proves "this name is written once" must do the same.
- **`Object.preventExtensions` on a merely non-extensible object is FROZEN**
  (§7.3.15 step 2 is vacuous with no own properties). The predicates read a flag
  only `Object.freeze` writes, so they answered `false`. The derivation is
  additive — consulted only where the flag is clear — and runs on the direct
  `$Object` arm only, because the #4032 integrity bag holds a carrier's expandos
  and never its elements (deriving over an array's bag would call
  `Object.preventExtensions([1,2])` frozen).

#### Diagnosed but NOT attempted — with the measurement, so the next lane starts here

- **`for…in` over a builtin INSTANCE enumerates its prototype's methods.**
  `var d = new Date(0); d.prop1 = 100; for (var k in d)` yields **44 `Date.prototype`
  method names** (`toString`, `getTime`, …, plus the symbol sentinel
  `__@toPrimitive@64`) and does **not** yield `prop1`. `Object.keys(d)` and
  `getOwnPropertyNames(d)` both correctly answer `["prop1"]`, so the key SOURCE
  is right and the for-in path is not. Suspect `__protoidx_forin_push`
  (`proto-index-store.ts` `fillForInPushBody`), which walks the builtin-proto
  companion with `__obj_ordered` — enumerable-only — so either the #2175 seeder's
  `PROTO_METHOD_DEFINE_FLAGS` (`0xbd`) is not landing `enumerable:false` on the
  companion entries, or the names arrive from `buildBagPushKeys`/the boundary
  helper instead. This is wider than one row and deserves its own issue; it costs
  `keys/15.2.3.14-6-5` here.
- **Expandos on a `$Date` receiver are invisible to `hasOwnProperty` and `in`.**
  `d.prop1 = 100` reads back fine and shows up in `Object.keys`/gOPN, but
  `d.hasOwnProperty("prop1")` and `"prop1" in d` are both **false**; likewise
  after `Object.defineProperty(dateObj, "prop", …)`. There is no DATE carrier in
  `carrier-bag-visibility.ts` (only closure / vec / error / instance-expando), so
  the store the reads use is not the one the predicates consult. Costs
  `15.2.3.6-4-408`.
- **Array-index ACCESSOR properties** (`Object.defineProperty(arr, "1", {get})`,
  then `arr[1]` invoking the getter, and the §15.4.5.1 step-4.c
  accessor→data refusal) — 8 rows: `defineProperties/15.2.3.7-6-a-{179,183,204,231}`,
  `defineProperty/15.2.3.6-4-{183,195,243-1,243-2}`. Arrays are vec carriers; index
  accessors need an overlay tier that does not exist. Not started.
- **`Array.prototype.length` as an own data property** — `15.2.3.6-4-117` and
  `15.2.3.7-6-a-113` both crash with `RuntimeError: illegal cast in
  __closure_62()`, i.e. a compiler bug rather than a missing answer, reached
  through `Array.prototype.length = 0`.
- **`Object(<function>)` / `Object(<Date>)` identity is preserved but the
  static type is not.** `new Object(func) === func` is already **true**; what
  fails is `typeof n_obj` (folds to `"object"`) and `n_obj()` (not lowered as a
  call), because `new Object(x)` has TS type `Object`. Same class as the
  `.constructor`/`valueOf` folds fixed above, but the fix is in the `typeof`
  and call-site lowerings, not the read path. 5 rows: `S15.2.1.1_A2_T11`,
  `S15.2.2.1_A2_T{2,5,6,7}`.
- **`var o2 = undefined; o2 = Object.preventExtensions(o)`** — `preventExtensions`
  itself returns its argument correctly (measured), but the binding is typed
  `undefined` from its initializer and the object assignment lands as `0`. A
  declared-type-widening defect, not a MOP one. Costs `preventExtensions/15.2.3.10-2`.
- **`Object.getOwnPropertyDescriptor(<B>.prototype, "constructor")`** answers
  `undefined` for `Date`/`Function` — `constructor` is deliberately not in
  `memberCsv` (`native-proto.ts`: "constructors have their own carrier"), so the
  #2175 companion seeder never installs it. Seeding it would also flip
  `Date/prototype/constructor/prop-desc`, `Error/…/prop-desc`,
  `Set/…`, `WeakSet/…`, `Iterator/…` — ~7 rows suite-wide for one seeder entry.
  Sized, not attempted. Costs `15.2.3.3-4-{34,116}` here.

Untouched walls confirmed on this lane: the global-object rows
(`15.2.3.3-4-4` reads `Object.getOwnPropertyDescriptor(this, "eval")`),
the `arguments`-object freeze family (`freeze/15.2.3.9-2-a-{11,12,14}`),
and `S15.2.3.6_A1` (needs `document.createElement`).
