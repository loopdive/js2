---
id: 2963
title: "Reify builtins as first-class values: retire the `__get_builtin` dynamic-shape CE cluster (~400 compile errors)"
status: in-progress
assignee: ttraenkler/fable-identity
sprint: current
model: fable
created: 2026-07-02
updated: 2026-07-09
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

| Form (current main)                                   | Status on main | Owner / phase |
| ----------------------------------------------------- | -------------- | ------------- |
| `const f = Array.isArray` **identity** (`f === f`)    | **wrong (`false`)** — fresh `struct.new` per read | **Phase 1 (this PR)** |
| `const r = Promise.resolve` as value                  | CE `#1907`     | Phase 2 — but Promise itself is host-backed (`Promise_resolve` import even for the DIRECT call), so reification cannot be host-free until Promise is native (#2867/#2905/#2959). |
| `const f = Number.isInteger` (host-free predicate)    | CE `#1907`     | Phase 2 — **blocked** (see value-call-path blocker below). |
| `const f = Array.of` as value                         | CE `#1907`     | Phase 2 — variadic; reified fixed-arity closure needs rest handling. |
| `const k = Symbol.matchAll`                            | CE `#1907`     | Phase 2 — non-well-known Symbol value (well-known ones already fold, #2610). |
| `X extends Object` constructor-object identity        | leaks `__new_Object` | **separate** — #2984 / sr-objsub. |
| array-iterator `%ArrayIteratorPrototype%` identity     | leaks `__iterator`   | **separate** — opus-12b / #2965 cluster. |
| `Object.defineProperty(globalThis, …)`                 | leaks `__get_globalThis` | **separate** — #2988. |

The three "separate" rows are the sibling gaps three other devs found the
same day — they share the *theme* (own-object identity) but each needs its
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
and `closureIdx` is a *defined-function* index that shifts whenever a late
import lands (`addUnionImports` / `shiftLateImportIndices` / the string-import
shifter). All three shifters walk function bodies **and nested
`.then`/`.body`/`.else` arrays** (verified) but **do NOT walk
`ctx.mod.globals[].init`** — so a `ref.func` embedded in a const-init would go
stale and point at the wrong function (a silent funcidx-desync regression, the
family of `project_standalone_hostimport_gate_index_shift`). Emitting the
`ref.func` inside an `if.then` in `fctx.body` keeps it in a shift-covered
array. (The `$__hole` const-init singleton in `array-holes.ts` is safe only
because it has *no* funcref operand.)

The shared mutable `bfnstate` (delete-bits) field being one instance across
all reads is *spec-correct*: `delete fn.name` through any reference mutates the
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
  type is a function), so the call site must *recover* the closure by
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
- **Promise.\*** (15 of the sampled refusals) is a *further* sub-case: even the
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
