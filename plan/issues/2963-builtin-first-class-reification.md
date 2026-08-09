---
id: 2963
title: "Reify builtins as first-class values: retire the `__get_builtin` dynamic-shape CE cluster (~400 compile errors)"
status: ready
sprint: current
model: fable
fable_role: spec
created: 2026-07-02
updated: 2026-07-18
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: builtins
goal: standalone-mode
related: [1472, 2036, 2860, 2964]
origin: "2026-07-02 July Fable audit §3 cluster 5 (biggest standalone CE family; #1472 Phase-C refusal successor)"
# (#2963 Tier 2a) The reified Number.is* closure body REUSES the settled
# `__unbox_number` native — the SAME unbox the direct `Number.is*(n)` call path
# uses via `compileNumberIsPredicate` — to recover the f64 from the boxed arg
# after the `__typeof_number` type guard. It is NOT a fresh hand-rolled
# ToNumber/ToString/ToPrimitive matrix (the coercion engine is deliberately
# bypassed here because §21.1.2.x requires NO coercion — a non-Number arg is
# `false`), so the +2 __unbox_number growth in builtin-value-read.ts is a
# reviewed, intentional reuse of an existing coercion primitive.
coercion-sites-allow:
  - src/codegen/builtin-value-read.ts
---

# #2963 — reading a builtin as a value is a compile error standalone

## Problem

The standalone compile-error population (915) is dominated by builtins
used as **values** rather than called directly: `__get_builtin`
dynamic-shape refusals account for **295 CEs**, plus ~100 more for
builtin-method extraction (`Promise.resolve` passed as a function,
`Array.of` stored in a variable, `Symbol.matchAll` as a key,
`Atomics.waitAsync` feature-detection reads). Direct calls are lowered
natively; the _reference_ form has no standalone representation — the
sites refuse ("#1472 Phase C") or lean on the `__get_builtin` host import.

## Approach

1. **Inventory first**: harvest the exact builtin×usage-form matrix from
   the per-test CE data (the runner's error strings name the builtin) —
   the top ~15 builtins likely cover >80% of the cluster.
2. **Reify on demand**: for each referenced builtin, synthesize (once per
   module, lazily) a `$Object`-backed callable — a closure wrapping the
   existing native lowering, registered with correct `name`/`length` own
   properties — and return that as the value. Method extraction
   (`const r = Promise.resolve; r(1)`) then works through the normal
   closure call path.
3. **Identity**: the same builtin reference must yield the same object
   (`Promise.resolve === Promise.resolve`) — module-level singleton slot
   per reified builtin (instance-carried identity, June audit D4 rule).
4. Feature-detection reads (`typeof Atomics.waitAsync`) must not CE — an
   absent builtin reads as `undefined`.

## Acceptance criteria

- `const r = Promise.resolve; r(5).then(...)` and `[1,2].map(Number)`
  compile and run host-free.
- `__get_builtin` CE count (295) driven to ~0 on the standalone lane;
  before/after recorded.
- Reified identity stable within a module; no new host imports.

---

## Implementation plan (measured on current `main`, 2026-07-02, sr-dev)

### Measure-first: what actually still CEs on current main

The June-12 harvest (295 `#1907` refusals) predates #2175 (native
`<Builtin>.prototype`), #2610 (well-known `Symbol.*` value fold), #2861
(`<Ctor>.length`/`.name` const fold) and #2896 (reflective fn metadata),
which already retired much of the raw cluster. Re-probing current `main`
(`compile(..., { target: "standalone", nativeStrings: true })`), the
**live** cluster splits into distinct sub-problems that must NOT be
conflated:

| Form (current main)                                | Status on main                                    | Owner / phase                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `const f = Array.isArray` **identity** (`f === f`) | **wrong (`false`)** — fresh `struct.new` per read | **Phase 1 (this PR)**                                                                                                                                                            |
| `const r = Promise.resolve` as value               | CE `#1907`                                        | Phase 2 — but Promise itself is host-backed (`Promise_resolve` import even for the DIRECT call), so reification cannot be host-free until Promise is native (#2867/#2905/#2959). |
| `const f = Number.isInteger` (host-free predicate) | CE `#1907`                                        | Phase 2 — **blocked** (see value-call-path blocker below).                                                                                                                       |
| `const f = Array.of` as value                      | CE `#1907`                                        | Phase 2 — variadic; reified fixed-arity closure needs rest handling.                                                                                                             |
| `const k = Symbol.matchAll`                        | CE `#1907`                                        | Phase 2 — non-well-known Symbol value (well-known ones already fold, #2610).                                                                                                     |
| `X extends Object` constructor-object identity     | leaks `__new_Object`                              | **separate** — #2984 / sr-objsub.                                                                                                                                                |
| array-iterator `%ArrayIteratorPrototype%` identity | leaks `__iterator`                                | **separate** — opus-12b / #2965 cluster.                                                                                                                                         |
| `Object.defineProperty(globalThis, …)`             | leaks `__get_globalThis`                          | **separate** — #2988.                                                                                                                                                            |

The three "separate" rows are the sibling gaps three other devs found the
same day — they share the _theme_ (own-object identity) but each needs its
own receiver-class MOP (see `project_2984_2988_2992_convergent_reification_substrate`);
they are **not** in #2963's lane.

### Phase 1 (this PR) — the identity substrate + the 3 already-wired methods

**Root cause of the identity bug**: `pushBuiltinFnClosureValueInstrs`
(`builtin-fn-meta.ts`) emits a fresh `ref.func` + `struct.new` on every
value read, so two reads of `Array.isArray` are two distinct GC structs →
`ref.eq` false. ES: a builtin method is ONE function object.

**Fix**: `pushBuiltinFnSingletonValueInstrs` — one `(ref null <metaType>)`
**mutable global per (builtin, member)** (keyed by the unique meta/wrapper
struct-type index, which is rec-group/DCE stable), lazily materialized once
behind an `if (ref.is_null) { struct.new; global.set }` guard emitted in the
**function body** (`fctx.body`), then `global.get` + `ref.as_non_null`.

**Why body-lazy-init, NOT a const-init global** (the load-bearing design
decision): the singleton's `struct.new` operand is `ref.func <closureIdx>`,
and `closureIdx` is a _defined-function_ index that shifts whenever a late
import lands (`addUnionImports` / `shiftLateImportIndices` / the string-import
shifter). All three shifters walk function bodies **and nested
`.then`/`.body`/`.else` arrays** (verified) but **do NOT walk
`ctx.mod.globals[].init`** — so a `ref.func` embedded in a const-init would go
stale and point at the wrong function (a silent funcidx-desync regression, the
family of `project_standalone_hostimport_gate_index_shift`). Emitting the
`ref.func` inside an `if.then` in `fctx.body` keeps it in a shift-covered
array. (The `$__hole` const-init singleton in `array-holes.ts` is safe only
because it has _no_ funcref operand.)

The shared mutable `bfnstate` (delete-bits) field being one instance across
all reads is _spec-correct_: `delete fn.name` through any reference mutates the
same object.

**Scope**: only the standalone static-method **value-read** site
(`property-access.ts`, the `ensureStandaloneBuiltinStaticMethodClosure`
branch) switches to the singleton. Byte-inert (sha256-verified) for host mode,
standalone programs with no builtin value reads, and `[1,2].map(Number)`
(bare-identifier-callback path, unchanged).

**Verified** (`--target standalone`, run, not just compiled):
`Array.isArray === Array.isArray` / `Object.keys` / `Object.getOwnPropertyDescriptor`
→ `1` (were `0`); **swap-wrong-builtin guard** `Array.isArray === Object.keys`
→ `0` (proves genuine per-builtin identity, not a coincidental null≡null pass —
`project_hostfree_pass_can_be_coincidentally_wrong_not_just_vacuous`); reified
`Array.isArray([1,2])`→`1`, `(5)`→`0` (call path intact); no `__get_builtin`
import added. `.name`/`.length` on the externref-widened local read `0` — a
**pre-existing** limitation confirmed identical on the upstream baseline (the
#2896 reflective meta answers `gOPD`-style reads, not `f.name` on a widened
local), untouched by this PR.

### Phase 2 (follow-up PR) — retire the CEs, BLOCKED on a value-call-path fix

Wiring the ~15 host-free static methods from `BUILTIN_STATIC_METHOD_ARITY`
(the worklist) is where the 295 → 0 CE reduction lands. It is **blocked on a
value-call dispatch integration bug** found while prototyping `Number.isInteger`:

- The 3 existing wired methods all take **`externref` params**; the reflective
  any-callable dispatch (`expressions/calls.ts` ~13230–13640,
  `__callable_param_*`) works for them.
- A reified value stored in a `const f = …` widens to **`externref`** (its TS
  type is a function), so the call site must _recover_ the closure by
  `ref.test`/`ref.cast` against a candidate struct type. Candidate selection is
  keyed by **arity**, not exact param types — so a new **`f64`-param** closure
  (e.g. `Number.isInteger`) mis-selects among same-arity candidates and the
  emitted `call` mis-threads the arg (WAT: `f64.const 4; call <lifted>` with the
  `self` operand dropped) → runtime `dereferencing a null pointer`. Compiles,
  but TRAPS — a regression, so `Number.isInteger` was intentionally **not**
  shipped in Phase 1.
- **Phase-2 prerequisite**: make the any-callable dispatch key on the value's
  exact static closure type (or thread `self` uniformly for scalar-param lifted
  funcs). Once that lands, the singleton substrate here wires every host-free
  method (`Number.is*`, `Math.*` unary/binary, `Object.is` scalar, …) trivially
  via the same `ensureStandaloneBuiltinStaticMethodClosure` switch.
- **Promise.\*** (15 of the sampled refusals) is a _further_ sub-case: even the
  DIRECT `Promise.resolve(5)` call leaks a `Promise_resolve` host import today,
  so reifying it host-free is gated on native Promise (#2867/#2905/#2959), not
  on this mechanism. Until then a reified `Promise.resolve` would reuse the same
  (non-new) host import the direct call uses.

### Files

- `src/codegen/builtin-fn-meta.ts` — `pushBuiltinFnSingletonValueInstrs` + the design rationale.
- `src/codegen/context/types.ts` — `builtinFnSingletonGlobalByTypeIdx` map.
- `src/codegen/property-access.ts` — static-method value-read site uses the singleton.
- `tests/issue-2963-builtin-reification.test.ts` — identity + swap-guard + call-path + no-host-import.

---

## Class-METHOD value identity — LANDED (fable-identity, 2026-07-09, with #3037/#3080)

The worklist ranked #2963 for the **~87-file class-method-identity cluster**
(`assert.sameValue(c.m, C.prototype.m)` across `language/*/class/elements/*`).
Verify-first re-measurement on main `928c85179d105` found the live root is NOT
a re-materialised wrapper — it is a **missing read path entirely**:

> A dynamic member read of a class PROTOTYPE METHOD (`c.m` where `c: any`)
> returned `undefined` in BOTH lanes. Fields resolve via `__sget_<f>` (host) /
> the `__get_member_<name>` dispatcher (standalone); methods had NO arm, and
> the `__extern_get` terminal knows nothing about class prototypes. So
> `c.m === c.m` passed only coincidentally (`undefined === undefined`),
> `c.m === C.prototype.m` was false, `typeof c.m` was "undefined".

**Fix (both lanes, one mechanism):** the #2674 `__get_member_<name>`
deferred-fill dispatcher gains **METHOD arms** —

1. `reserveMemberGetDispatch` enumerates every class owning a method
   `<name>` (`classMethodCandidatesForProp`) and pre-creates the canonical
   singleton machinery via `ensureMethodClosureSingleton` (extracted from
   `emitCachedMethodClosureAccess`, #1394) — the SAME
   `__method_closure_<Owner>_<m>` cache global + `__obj_meth_tramp_*_cached`
   trampoline the typed `C.prototype.m` read mints, so both read paths are
   `===`-identical by construction. Creation happens at RESERVE (compile)
   time; the FILL only re-resolves by name (shift-safe).
2. `fillMemberGetDispatch` appends a **miss-gated** method-arm terminal: the
   `__extern_get` host/native read runs FIRST (own sidecar props, accessors
   and delete-tombstones keep shadowing — the host `c.m = 5; c.m` read-back
   is regression-locked), and only a miss (`ref.is_null` ∨
   `__extern_is_undefined`) falls through to `ref.test`-per-class arms,
   children-first so an override's arm wins under WasmGC subtyping
   (`$D <: $C`). Identity follows the OWNING class
   (`resolveMethodOwnerClass`, extracted to class-member-keys.ts), so
   `(new D()).m === C.prototype.m` for inherited methods.
3. Class EXPRESSIONS canonicalise through `classExprNameMap` before keying —
   the #1394 dual registration (`C` + `__anonClass_N`) otherwise minted a
   second singleton under the binding name (found: expression-form files
   stayed red until this).
4. The read site (`compilePropertyAccess` "no struct candidates" branch)
   routes through the dispatcher when method candidates exist; the
   struct-candidates branch already used the dispatcher as its terminal.
5. **Trap found + fixed:** `collectDeclaredFuncRefs` rebuilds the
   declared-elem set by scanning bodies BEFORE the fill runs, so a trampoline
   whose only `ref.func` lives in the fill body validated as "undeclared
   reference to function". The fill re-declares its arm trampolines.

**Measured:** the exact-cluster list (63 files failing
`assert.sameValue(c.m, C.prototype.m)` in the baseline) — identity assert
passes in ALL 63; **15/63 flip to full pass**, the remaining 48 proceed to
LATER asserts from other families (`hasOwnProperty` reflection on class
objects, static `$`-identifier calls — pre-existing, separate roots).
Bonus semantics: `typeof c.m === "function"`, extracted `const f = c.m; f()`
calls work. `prove-emit-identity` 39/39 IDENTICAL vs main (byte-inert for
every module without class-method dynamic reads). Equivalence suite delta
vs main: no new failures. #3080 (private-method value identity) fixed in the
same PR — see that issue.

**Files:** `src/codegen/member-get-dispatch.ts` (candidates + reserve-ensure +
miss-gated fill arms), `src/codegen/closures.ts`
(`ensureMethodClosureSingleton` extraction), `src/codegen/class-member-keys.ts`
(`resolveMethodOwnerClass`), `src/codegen/property-access.ts` (read-site
routing; owner-chain now shared), `src/codegen/context/types.ts`
(`memberGetMethodArms`), `tests/issue-2963-method-value-identity.test.ts`.

**Still open (Phase 2, unchanged):** the builtin `__get_builtin` CE-cluster
reduction remains blocked on the value-call-path dispatch fix documented
above — this PR does not touch it.

## Implementation Plan (Fable, 2026-07-18) — Phase 2 re-grounded: the dispatch "blocker" is OBSOLETE; wire real bodies under the all-externref convention

### Verify-first state (current main)

The Phase-1 note above (2026-07-02) is stale in three load-bearing ways:

1. **The substrate moved and grew.** The value-read machinery now lives in
   `src/codegen/builtin-value-read.ts` (`ensureStandaloneBuiltinStaticMethodClosure`,
   `:820`), with reflective-descriptor support in `builtin-static-gopd.ts` and
   identity singletons via `pushBuiltinFnSingletonValueInstrs`
   (`builtin-fn-meta.ts:303`). The wired set is no longer "3 methods" — it is
   `Array.isArray`, `Object.keys`, `Object.getOwnPropertyDescriptor`,
   `Reflect.get/has/set/ownKeys`, `JSON.stringify`, and variadic
   `Math.max`/`Math.min` (#2933).
2. **The hard-CE cluster is already structurally retired (#2984 Phase 3).**
   The `default` arm (`builtin-value-read.ts:921–942`) reifies EVERY method in
   `BUILTIN_STATIC_METHOD_ARITY` as an identity-stable, spec-shaped
   (`.name`/`.length` meta subtype) closure whose body throws a **catchable
   TypeError**. So feature-detection reads, identity compares, and descriptor
   reflection all pass today; only _invoking_ an unwired extracted value
   throws. The remaining conformance lever is therefore "give real bodies to
   the throw-body methods", not "stop CE-ing".
3. **The value-call dispatch fix is NOT a prerequisite anymore.** The Phase-1
   blocker ("f64-param closure mis-selects among same-arity candidates") is
   solved by _convention_, not by a dispatcher change: every reified closure
   already takes **all-externref params** (or the single
   `(ref null $vec_externref)` variadic param) — exactly the shape the inline
   dynamic dispatcher's #2939 pre-registration restricts itself to, and the
   #820/#1543 funcref-signature discrimination handles soundly. **Design rule
   (normative for Phase 2): a reified builtin closure NEVER carries a scalar
   (f64/i32) param type in its wrapper signature. Coercion happens INSIDE the
   body.** `Math.max` is the worked precedent (vec-of-externref →
   `__any_to_f64` per element → `f64.max` → `__any_box_f64`). Do not touch
   `tryEmitInlineDynamicCall`.

### Phase 2 worklist (each entry: params all-externref; body = unbox → existing native → box)

Ordered by cluster size and body availability. All are `switch (key)` arms in
`ensureStandaloneBuiltinStaticMethodClosure` replacing the generic throw body;
each reuses the SAME native the direct-call path uses (observational identity
with the direct call is the acceptance bar, per the `Reflect.get` precedent).

| Tier | Methods                                                                                                | Body sketch                                                                                                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2a   | `Number.isInteger/isFinite/isNaN/isSafeInteger`                                                        | `ref.test $BoxedNumber` on the arg (via `any.convert_extern` + the settled tag-3 peel — NOT ToNumber; a non-number arg answers `0` per §21.1.2); on hit, unbox f64 and run the existing direct-call predicate lowering                                                                                                |
| 2b   | `Object.is`                                                                                            | two externref args → the standalone SameValue helper the direct call uses (`calls.ts` Object.is arm; includes the −0/NaN discrimination). NB SameValue ≠ `===`; reuse, don't re-derive                                                                                                                                |
| 2c   | `Math.<unary/binary fixed-arity>` (`abs`, `floor`, `ceil`, `trunc`, `sign`, `sqrt`, `atan2`, `pow`, …) | arg(s) → `__any_to_f64` (spec ToNumber on the boxed value; non-number → NaN, which is §21.3 behavior) → the existing self-hosted `src/stdlib/math.ts` native → `__any_box_f64`. One table-driven arm, not N hand-written cases: key on `BUILTIN_STATIC_METHOD_ARITY.Math` + the direct-call lowering's dispatch table |
| 2d   | `Number.parseFloat/parseInt`                                                                           | route to the existing native parse entries (the standalone direct-call path); parseInt keeps the NaN radix sentinel                                                                                                                                                                                                   |
| 2e   | `Date.now`                                                                                             | 0-arg; the direct-call lowering's time source (verify which import/native serves it standalone — if it is host-only, leave the throw body and record why)                                                                                                                                                             |
| 2f   | `Array.of` (variadic)                                                                                  | the `$vec_externref` variadic convention (Math.max precedent): build a `$__vec_externref` from the args vec — elements are already externref, no per-element coercion                                                                                                                                                 |
| 2g   | `Array.from` (1-arg iterable subset)                                                                   | ONLY the array-like/vec fast shape the direct call supports standalone; other inputs keep the catchable throw (document per-shape)                                                                                                                                                                                    |

**Explicitly OUT (keep throw bodies, with the recorded reason):**
`Promise.*` (host-backed even for direct calls — gated on native Promise,
#3178 family); `Symbol.*` non-well-known (needs Symbol identity substrate);
`JSON.parse` (needs the anyref-boundary return work noted in the #2933
comment); anything whose direct-call path is itself still a host import
standalone (reification must never mint a NEW host dependency — dual-mode
rule).

### Mechanics every arm must follow (the settled discipline)

- **Pre-register before minting** (the #2704 lesson, already in the Math.max
  arm): `addUnionImports` / `ensureAnyHelpers` / any `ensure*` the body needs
  run BEFORE `getOrCreateFuncRefWrapperTypes`/`mintDefinedFunc`.
- **Identity**: nothing to do — the singleton substrate
  (`pushBuiltinFnSingletonValueInstrs`) and the meta subtype
  (`.name`/`.length`) apply automatically once the arm exists; keep
  `STANDALONE_STATIC_METHOD_META` in sync for newly-wired entries (the file
  header requires it).
- **Fallback**: if a required native is unavailable in the current mode,
  degrade to `genericThrowBody` (the Math.max arm's pattern at `:906–913`),
  never `return null` (null re-opens the #1907 CE).
- **Byte-inertness**: host/gc lanes untouched (all sites are
  `ctx.standalone`-gated); `prove-emit-identity` corpus must stay IDENTICAL.

### Acceptance / measurement

- Probe file per tier under `.tmp/`: extract → store in `any` local → call →
  compare against the direct call's result, `--target standalone`, run not
  just compile.
- The issue's headline metric is re-based: count **catchable-TypeError
  invocations** flipping to correct results on the standalone lane (the CE
  count is already ~retired by Phase 3); before/after via the standalone
  shard's `net_per_test`.
- `[1,2].map(Number)` and `const f = Number.isInteger; [1.5, 2].filter(f)`
  as e2e rows (the dispatcher path end-to-end with a wired body).
- Full `merge_group` (broad-impact: touches the reflective/value substrate).

### Sizing / routing

Tier 2a+2b+2d: one M PR (opus). Tier 2c: one M PR (table-driven; the risk is
per-method ToNumber edge cases — cite §21.3 per method in tests). Tier
2f/2g: S–M. 2e: S after the standalone time-source check. Independent of
#2916/#2651 (different substrate); no coordination needed beyond ordinary
merge hygiene.

### Phase 2 progress log

- **Tier 2a — `Number.is{Integer,Finite,NaN,SafeInteger}` — DONE** (opus-dev-b,
  2026-07-18). Wired real bodies in `ensureStandaloneBuiltinStaticMethodClosure`
  (`builtin-value-read.ts`): fixed 1-arg `[externref] -> i32` closure, body =
  `__typeof_number` guard (no ToNumber; the settled guard already excludes the
  #2979 UNDEF_F64-sentinel `$BoxedNumber`, so `Number.isNaN(undefined)` is
  correctly `false`) -> `__unbox_number` -> the **shared** `numberIsPredicateOps`
  (new leaf `src/codegen/number-is-predicate-ops.ts`, also adopted by the direct
  `call-builtin-static.ts` path -> observational identity guaranteed, byte-inert
  over the 56-entry emit-identity corpus). Both natives are standalone-DEFINED
  (host-free). Meta rows added to `STANDALONE_STATIC_METHOD_META`. Test:
  `tests/issue-2963-number-is-value.test.ts` (8 cases: per-method invocation,
  no-coercion, undefined/null/bool -> false, identity, `.name`, direct-form
  non-regression).
  - **Pre-existing gap surfaced (NOT introduced here, orthogonal follow-up):**
    `.name`/`.length` reflective reads on a reified builtin value have a
    multi-value dispatch collision — co-extracting two statics that share a
    wrapper signature (verified on `main` with `Object.keys` + `Reflect.ownKeys`,
    both `externref -> externref`; also `Array.isArray` + any `Number.is*`, both
    `externref -> i32`) makes the SECOND value's `.name` mis-resolve, and
    `.length` reads 0 for EVERY wired static (Math.max included). Invocation and
    per-single-value `.name` are correct. Worth a dedicated issue on the reified
    builtin-fn meta reflective-read dispatch.
- **Tier 2b — `Object.is` (SameValue, §20.1.2.13) — DONE** (opus-dev-b,
  2026-07-18; stacked on the Tier 2a PR). Fixed 2-arg `[externref, externref] ->
i32` closure. The direct standalone `Object.is` only backs compile-time
  same-typed scalar args (the general boxed `__object_is` is a host import), so
  the reified body composes host-free: BOTH boxes Number (`__typeof_number`) ->
  the shared `sameValueNumberOps` (new leaf `src/codegen/same-value-number-ops.ts`,
  also adopted by the direct `Object.is` both-Number fast path — the IEEE-754
  bit-compare + both-NaN clause, the ONLY arm where SameValue diverges from `===`:
  `+0`/`-0` unequal, `NaN`/`NaN` equal); else -> `__extern_strict_eq` (SameValue
  coincides with `===` for every non-Number case — object identity via `ref.eq`,
  strings by content, null/undefined/boolean by value). Byte-inert (56-entry
  corpus IDENTICAL). Meta row `Object.is` added. Test:
  `tests/issue-2963-object-is-value.test.ts` (6 cases). The pre-existing
  reflective-read gap is filed as #3424 (rides this PR).
- Remaining Phase 2 tiers: 2c (table-driven `Math.*`), 2d
  (`Number.parseFloat/parseInt`), 2e (`Date.now`), 2f (`Array.of`), 2g
  (`Array.from` subset). `Promise.*` stays throwing (out of scope).

### Resumer guide — Tiers 2c–2g (start here after 2a #3359 + 2b #3361 land)

**Sequencing.** 2a (#3359) and 2b (#3361) were stacked and PAUSED. Do the
remaining tiers **off clean `main`** once BOTH have landed — do NOT stack
further (the stack was capped at 2a+2b for queue hygiene). Each tier is an
independent S–M PR off `origin/main`. Do them in order, one PR each (or
regroup per the "Sizing / routing" note above), re-merging `origin/main`
between them since they touch the same hot files.

**Shared-file conflict surface (why tiers can't run in parallel off main).**
Every tier edits the SAME three spots, so two open tier-PRs conflict:

1. `src/codegen/builtin-value-read.ts` — add a `case "<Builtin>.<method>":`
   (type setup + `addUnionImports` / `ensure*` pre-registration) **before
   `default:`**, and an `else if (key === "<Builtin>.<method>" &&
!genericThrowBody)` **body block before the `genericThrowBody` arm**. The
   `&& !genericThrowBody` guard is REQUIRED (else the degrade path double-fires).
2. `src/codegen/builtin-fn-meta.ts` — add a `STANDALONE_STATIC_METHOD_META`
   row (byte-equal to the `BUILTIN_STATIC_METHOD_ARITY` fallback; keep in sync
   per the file header).
3. `src/codegen/expressions/call-builtin-static.ts` — if the tier factors a
   shared ops leaf (like `number-is-predicate-ops.ts` / `same-value-number-ops.ts`),
   refactor the DIRECT call arm to consume it too (byte-inert — same Instr seq).

**The invariant pattern (copy Tier 2a/2b):** params ALL-externref (or the one
`$vec_externref` variadic param for Tier 2f — see the Math.max arm), coercion
INSIDE the body, reuse the EXACT native the direct standalone call uses, and on
any missing native degrade to `genericThrowBody` — NEVER `return null` (null
re-opens the #1907 CE). Pre-register imports BEFORE `mintDefinedFunc` (#2704).
Reused coercion primitives (`__unbox_number` etc.) ride this issue's
`coercion-sites-allow:` frontmatter (file-level for `builtin-value-read.ts`);
keep that key so the `quality` coercion-sites gate stays green.

**Per-tier native to reuse (verify host-free standalone first):**

- 2c `Math.<unary/binary>`: args → `__any_to_f64` (ToNumber; non-number→NaN,
  §21.3) → the self-hosted `src/stdlib/math.ts` native the direct-call dispatch
  table uses → `__box_number`. One table-driven arm keyed on the Math dispatch
  table, not N cases.
- 2d `Number.parseFloat/parseInt`: the global `parseFloat`/`parseInt` funcMap
  entries (parseInt keeps the NaN radix sentinel) — but CONFIRM they're defined
  funcs standalone, not host imports (the direct arm at call-builtin-static.ts
  `~L411` reads `ctx.funcMap.get("parseFloat"|"parseInt")`).
- 2e `Date.now`: 0-arg; VERIFY the standalone time source — if host-only, leave
  the throw body and record why.
- 2f `Array.of`: variadic `$vec_externref` convention (Math.max precedent,
  `ctx.variadicBuiltinClosure`); elements already externref, no per-elem coerce.
- 2g `Array.from`: ONLY the array-like/vec fast shape the direct call supports
  standalone; other inputs keep the throw (document per-shape).

**Validation harness (every tier):**

- Standalone probe: `WebAssembly.instantiate(binary, {})` (no imports). Return
  type `: number` — NOT `: i32` (a bare `i32` export hands JS a BOXED ref, not a
  number, which looks like a bug). Avoid array methods (`filter`/`map`) in probes
  — they pull an `env` import the empty-imports harness lacks; use scalar loops.
- Byte-inertness (host/gc lanes MUST NOT change): from CLEAN `main` run
  `npx tsx scripts/prove-emit-identity.mjs write --baseline /tmp/golden.json`,
  then on the branch `npx tsx scripts/prove-emit-identity.mjs check --baseline
/tmp/golden.json` → must print `IDENTICAL — all 56 (file,target) emits match`.
- `.name`/`.length` reflective reads: do NOT assert `.name` in a MULTI-value
  module (two same-signature statics co-extracted mis-dispatch — that's the
  PRE-EXISTING #3424 bug, reproduced on main). Assert `.name` per single-value
  module only; `.length` returns 0 for every reified static today (also #3424).
- Test file per tier: `tests/issue-2963-<method>-value.test.ts`, mirroring
  `issue-2963-number-is-value.test.ts` / `issue-2963-object-is-value.test.ts`
  (a `runStandalone` helper + per-case + observational-identity-vs-direct rows).
- Full `merge_group` (broad-impact: touches the reflective/value substrate).
