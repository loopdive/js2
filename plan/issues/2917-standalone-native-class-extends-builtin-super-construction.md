---
id: 2917
title: "[SUBSTRATE][ARCH] Standalone native `class X extends <Builtin>` super-construction (~10 generic conversions)"
status: ready
sprint: current
updated: 2026-07-17
created: 2026-07-01
priority: medium
horizon: l
feasibility: hard
model: fable
reasoning_effort: high
task_type: feature
area: codegen
language_feature: classes
goal: standalone
related: [1366a, 1455, 1721, 1833, 2029, 2188, 2379, 2395, 2620, 2622, 2709, 2916, 3238, 3239, 3240]
origin: "2026-07-01 — sr-tail2 escalation: leaky-PASS conversion cluster, per-builtin backing-instance substrate (representation-scale, à la #2379)"
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/class-bodies.ts
---

# #2917 — Standalone native `class X extends <Builtin>` super-construction

## Problem (verified on `main` `f350ba855`, 2026-07-01; re-verified `c47a26f9a`, 2026-07-17)

`class X extends <Builtin> {}` — where `<Builtin>` is a host-constructible
builtin (see `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`, `builtin-tags.ts:191`) —
lowers `super(...)` / the implicit derived ctor to a reflective
`__new_<Builtin>` **host import**. Under `--target standalone`/`wasi` there is
no JS host, so the import leaks: the module either fails to instantiate
host-free (a **leaky-PASS** — passes only via the host shim) or, for the
Number/Boolean f64-arg mismatch, would emit invalid Wasm and is **refused at
compile time** (#2029, #2620).

Native super-construction must produce a **native backing instance** the
parent's methods operate on, while `instanceof Sub` / `instanceof <Builtin>`
and the subclass machinery keep working — inside the heavily special-cased
class-bodies construction machinery. Representation-scale, high regression
risk (à la #2379).

## Status refresh (2026-07-17, fable-2917) — what landed since the 2026-07-01 draft

This plan **supersedes** the 2026-07-01 draft (merged via PR #2417). Four
things landed that change the design:

| Landed                                                                                                                                            | What it gives this issue                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#3238** (`emitStandaloneObjectConstructor`, `object-runtime.ts:227`)                                                                            | `extends Object` is DONE — native `__new_Object` returning a fresh `$Object` via `__new_plain_object`. Establishes the helper pattern: idempotent on `ctx.funcMap`, `addFuncType` + `mintDefinedFunc` + `pushDefinedFunc`, externref-in/externref-out, gated at the two class-bodies call sites.                                                                                                         |
| **#3239** (`emitStandaloneVecBuiltinConstructor`, `object-runtime.ts:299`; `STANDALONE_VEC_BUILTIN_PARENTS` = 11 TypedArrays + SharedArrayBuffer) | Identity-only empty-`$Vec` parents DONE. Also proves the identity-only shortcut is **safe ONLY where no behavior test passes** — explicitly not reusable for Array/Date/RegExp/Function (see #3240).                                                                                                                                                                                                     |
| **#2916 Slice A** (PR #2418, `expressions/identifiers.ts`)                                                                                        | `instanceof <Builtin>` under `noJsHost` is now a native `ref.test` membership on the REAL backing types (Array → vec subtypes, Function → closure roots, …). This **decides the representation question** (below). Slices B/C (dynamic `__instanceof_check`, `isPrototypeOf`) are deferred, gated on the #2907 ctor-carrier `.prototype` infra — still owned by #2916/sendev-instanceof, NOT this issue. |
| **#2395 MERGED** (%TypedArray% intrinsic ctor chain, #2893 brand)                                                                                 | The old plan's "if #2395 has not landed, restrict scope" contingency is obsolete.                                                                                                                                                                                                                                                                                                                        |

**#3240** (`plan/issues/3240-standalone-subclass-faithful-ctors.md`) is the
per-builtin **tracking twin** of this issue's remaining scope, with measured
flip counts and the list of currently-passing behavior tests per parent. This
file is the **design authority**; #3240 tracks the slices. Per-slice PRs
should reference both.

## Scope (updated)

**Remaining in scope** (faithful native ctor needed; flips measured in #3240):

| Parent                      | flips | native backing that already exists                                                                           |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `Array`                     | 3     | `$Vec` structs (`getOrRegisterVecType`); native `new Array(n)` lowering in `expressions/new-super.ts` ~L3599 |
| `ArrayBuffer` (+`DataView`) | 2+1   | i8 byte-vec; native `new ArrayBuffer(n)` in new-super.ts ~L3480                                              |
| `Date`                      | 3     | `$Date` struct (`ensureDateStructForCtx`, i64 timestamp); WASI `clock_time_get` (#1483)                      |
| `RegExp`                    | 4     | `$NativeRegExp` struct + compile-time bytecode (#1539, `regexp-standalone.ts:649`)                           |
| `Function`                  | 3     | closure structs (`closures.ts`; a closure IS `instanceof Function`, #1992)                                   |

**Done / excluded:**

- `Object` — DONE (#3238). TypedArrays + `SharedArrayBuffer` — DONE identity-only (#3239).
- **Error family** — host-free since #1536c (`emitWasiErrorConstructor`). `String` — already compiles standalone (`__new_String` externref-in/out).
- **Number / Boolean** — keep the #2029 refusal (invalid-Wasm class; needs the value-rep wrapper box).
- **Set / Map / WeakMap / WeakSet** — keep the #2620 refusal; native collection subclass is #2622 (backlog).
- **Promise** — excluded; `super(executor)` needs the native Promise carrier (#2867/#2637 area).

## Background — the construction machinery this slots into

An `extends <builtin>` subclass is marked **externref-backed**
(`ctx.classExternrefBackedSet` / `ctx.classBuiltinParentMap`,
`class-bodies.ts:672–695`; multi-level chains propagate the builtin
**ancestor**, `:675–695`). Two construction sites call `__new_<Parent>`, and
both already carry a standalone dispatch ladder (Error → Object → vec-builtins
→ host import) that this issue extends:

- **Implicit derived ctor** (no user ctor): `class-bodies.ts:1762–1816`.
  Dispatch ladder at `:1774–1792`, host-import fallback at `:1790`.
- **Explicit `super(...)`**: `compileSuperCall` (`class-bodies.ts:2914`),
  builtin arm `:2942–3043`, dispatch ladder at `:2975–2994`, host-import
  fallback at `:2992`. Note the `onHost` Promise path (`:2961`, #2637 B2.3) —
  do not touch.

After allocation both sites run `emitSetSubclassProto` (`:428` — **no-ops
standalone**: the `__set_subclass_proto` host import is unavailable and the
`-1` string-sentinel guard at `:461` skips) and `emitSetSubclassUserBrand`
(`:501` — writes `$Error_struct.$userClassId` fieldIdx 4 ONLY; the
`ref.test $Error_struct` guard makes it a silent no-op for every non-Error
backing). Forward arity comes from `getBuiltinConstructorForwardArity`
(`:123`, max(1, declared ctor arity)); implicit arity additionally observes
`new Sub(...)` call sites (`getObservedClassNewArity`, `:281`).

## Implementation Plan

### Root cause

Externref-backed subclasses of the remaining host-constructible builtins have
**no native allocator**: `__new_<Builtin>` is a host import with no standalone
body (only Error/Object/TypedArray-family got one). The instance the parent's
native prototype methods, element ops, and #2916 Slice-A `instanceof` need is
never materialized host-free.

### Core design decision — REAL native backing instance, NOT a wrapper struct

The 2026-07-01 draft recommended a uniform `$Subclass_struct { $brand, $proto,
$backing }` wrapper. **That recommendation is REVERSED.** Each native
`__new_<Builtin>` returns the _real_ backing value (`$Vec` for Array, `$Date`
for Date, `$NativeRegExp` for RegExp, closure struct for Function, byte-vec
for ArrayBuffer), boxed to externref via `extern.convert_any` — exactly what
#3238/#3239 shipped. Rationale:

1. **#2916 Slice A composition (decisive)**: `instanceof Array` / `instanceof
Function` under `noJsHost` is now a native `ref.test` against vec-subtype /
   closure-root **type indices** on the real backing. A wrapper struct fails
   every one of those tests — `new Sub() instanceof Array` would turn false.
2. **Method dispatch**: parent prototype methods go through
   receiver-brand-checked native glue (`emitReceiverBrandCheck`,
   `registerNativeProtoBuiltin`) and the `__extern_get/set/length` runtime
   whose standalone arms (`$Object`, finalize-time `$__vec_base` — #2036/#3183)
   operate on real backing structs. A wrapper needs an unwrap shim at every
   site — the #2379-scale churn this must avoid.
3. **Object identity**: the standalone floor watches `ref.eq` identity
   (`reference_standalone_floor_object_identity_and_real_vs_drift`); a wrapper
   adds an identity layer with no owner.
4. **Precedent uniformity**: Error/Object/TypedArray backings are already
   real; forking the representation mid-family doubles every downstream
   special case.

**Accepted cost** (documented degradation, NOT a regression — none of this
works today either):

- No per-instance brand/proto slot on non-`$Object` backings → **dynamic**
  `instanceof Sub` (LHS statically untyped) and sibling discrimination stay
  with #2916 Slice B (the `$Error_struct.$userClassId` precedent does not
  generalize without a slot). Static/typed cases resolve via
  `tryStaticInstanceOf` (`identifiers.ts:1331` — classTagMap branch +
  `classBuiltinParentMap` hierarchy walk) as they do for #3239's parents.
- Own-field writes (`this.own = 1`) on non-`$Object` backings route through
  `__extern_set`, which has no arm for `$Vec`/`$Date`/closure → silently
  dropped, same as today's Error-family behavior. `$Object`-backed subs
  (`extends Object`, #3238) get own fields for free.

**Do NOT build proto/brand substrate in this issue** — `emitSetSubclassProto`
stays a standalone no-op; wiring it natively is #2916 Slice B / #2907
territory. This is the spec boundary with #2916.

### The non-regression rule (replaces the old "refuse, never mis-emit" absolutism)

Per parent × argument-shape there are exactly three lawful lowerings, in
preference order:

1. **Faithful native ctor** — only when the produced instance preserves every
   currently-passing behavior test (#3240 table: e.g. `new Sub(5).length === 5`
   for Array).
2. **Keep the existing host-import lowering** (leaky-pass) — when faithful
   native construction isn't possible for that shape (e.g. dynamic RegExp
   pattern). A leak that passes beats a native ctor that regresses.
3. **Compile refusal** — ONLY where the alternative is invalid Wasm
   (#2029 f64 mismatch, #2620 accessor desync). Do NOT add new refusals:
   converting a leaky-pass into a CE is a standalone-lane regression.

The #3239 identity-only shortcut (drop args, empty instance) is **forbidden**
for every parent in this issue's scope — each has passing behavior tests
(#3240 measured them).

### Changes

**Shared refactor (land in the FIRST slice PR)** — the dispatch ladder is now
duplicated verbatim at `class-bodies.ts:1774–1792` and `:2975–2994` and grows
another 4–5 arms here. Extract:

```ts
// class-bodies.ts (or object-runtime.ts)
function resolveStandaloneBuiltinSuperCtorIdx(
  ctx: CodegenContext,
  parentName: string,
  arity: number,
): number | undefined;
```

returning the DEFINED funcIdx (emitting the native helper idempotently) or
`undefined` → caller falls through to `ensureLateImport` +
`flushLateImportShifts` exactly as today. Both sites call it. (Memory rule:
avoid code bloat / deduplicate — verified the two arms are currently
copy-paste twins.)

**File: `src/codegen/object-runtime.ts`** (next to the #3238/#3239 helpers) —
one `emitStandalone<Builtin>Constructor(ctx, arity)` per slice, all following
the landed pattern exactly:

- idempotent guard on `ctx.funcMap.has("__new_<Builtin>")`;
- pull substrate FIRST (`ensureObjectRuntime` / `getOrRegisterVecType` /
  `ensureDateStructForCtx` / …) so any late-import shift settles before
  baking (`ensureObjectRuntime` flushes at entry, #2039);
- `addFuncType` (externref × arity → externref) + `mintDefinedFunc` +
  `ctx.funcMap.set` + `pushDefinedFunc` — a DEFINED func, no import shift;
- body ends `extern.convert_any`.

**File: `src/codegen/class-bodies.ts`** — the two dispatch sites collapse to
the shared resolver; no other behavior change. Keep the #2620/#2029 refusals
(`:617`, `:647`) untouched.

### Per-builtin slices (each independently shippable — do NOT big-bang)

**Slice 1 — `Array`** (first; highest value; own PR)

- §23.1.1.1 semantics, dispatched on **effective argc**. The forwarder has a
  fixed arity and pads missing args with `undefined` (`:2998–3007`), so
  compute effective argc at runtime by scanning params right-to-left with
  `__extern_is_undefined` (the host runtime already trims trailing
  undefined — see the #1551 comment at `:3009`). Document the known
  `new Sub(undefined)` ≡ `new Sub()` divergence.
- argc 0 → empty `$__vec_externref`.
- argc 1, boxed number → length-`n` vec (`array.new_default` + `struct.new`
  with length field `n` — reuse/extract the native `new Array(n)` emission
  from `expressions/new-super.ts` ~L3599, including the non-uint32 →
  **RangeError** throw via `emitWasiErrorConstructor(ctx, "RangeError", 1)`,
  the native-regex.ts:45 precedent). Discriminate boxed-number with the same
  mechanism `__extern_length`'s ToLength arm uses (`__unbox_number`, #2036).
- argc 1 non-numeric, or argc ≥ 2 → `$__vec_externref` of the args as
  elements.
- `.length` / element ops / `instanceof Array` then work via existing
  machinery (vec `$__vec_base` arms + Slice-A `ref.test`) — assert, don't
  re-implement.
- Regression guard: `regular-subclassing`,
  `contructor-calls-super-single-argument` (sic — test262 filename) must stay
  passing.

**Slice 2 — `ArrayBuffer` + `DataView`**

- `__new_ArrayBuffer`: unbox `byteLength` → i8 byte-vec (reuse new-super.ts
  ~L3480 emission incl. length validation).
- `__new_DataView(buffer, byteOffset?, byteLength?)`: `any.convert_extern` +
  `ref.test` the byte-vec type on the buffer arg (TypeError arm when it
  isn't one), unbox offsets. Coordinate with the #2893 view-brand if DataView
  reads dispatch on it — check before building.

**Slice 3 — `Date`**

- Plain `new Date(...)` is already native standalone (#3240 verified) —
  **reuse that lowering**, don't re-derive: argc 0 → current time (WASI
  `clock_time_get`, #1483); argc 1 numeric → `$Date` from unboxed f64 (mind
  the f64→i64 timestamp conversion the existing lowering does); multi-arg
  (y, m, d, …) → reuse if the native lowering covers it, else rule 2 (keep
  host import for that shape).
- If pure-standalone (non-WASI) has no clock source for argc 0, apply rule 2
  for that shape rather than fabricating time 0.
- Verify parent method dispatch (`getTime` etc.) accepts the boxed `$Date`
  via the Date receiver brand (`getBuiltinBrand(ctx, "Date")`).

**Slice 4 — `RegExp`**

- The #1539 engine compiles patterns to bytecode at **compile time** —
  a generic runtime `__new_RegExp(externref, externref)` is impossible. So:
  - **Explicit `super(pat, flags)` with statically-known args**
    (`class-bodies.ts:2942` arm): construct the `$NativeRegExp` inline into
    `selfLocal` via the literal machinery in `regexp-standalone.ts`
    (`isStaticStandaloneRegExpCreation` and friends), bypassing
    `__new_RegExp` entirely. `super()` no-arg = static empty pattern `(?:)`.
  - **Implicit-ctor / dynamic args**: rule 2 — keep the host-import lowering
    (leaky-pass). No new refusal (`reportStandaloneRegExpUnsupported` is for
    direct construction sites, not this path).
- The `lastIndex` behavior test is in the flip set — verify the
  `$NativeRegExp` field layout (`RE_FIELD_*`, `regexp-standalone.ts:676`)
  gives the subclass instance a working `lastIndex` before claiming the flip.

**Slice 5 — `Function`** (last; heaviest; optional — rule 2 is acceptable)

- Passing tests are `instance-length` / `instance-name` /
  `super-must-be-called` — none require calling the constructed function, so
  `new Function(body)` eval semantics are NOT needed.
- Target: a closure-root struct instance (satisfies Slice-A
  `instanceof Function`, #1992) whose funcref points to a synthetic body that
  throws TypeError when invoked; `.length` 0 / `.name` per spec.
- **Investigate first**: how `.length`/`.name` reads on a closure value
  resolve standalone (`property-access-dispatch.ts` closure arm). If they
  need struct fields the closure type doesn't carry, do NOT widen the closure
  struct (every existing closure allocation site would pay) — fall back to
  rule 2 and record findings in #3240.

### funcIdx / type-index hazards (high regression risk — read carefully)

- **Defined funcs only**: every helper is `mintDefinedFunc` +
  `pushDefinedFunc` — no import, no index shift. If a helper body needs a
  late import (`__extern_is_undefined`, `__unbox_number`), pull it via the
  substrate ensure-functions BEFORE minting, and let the existing
  `flushLateImportShifts` discipline settle indices; repoint by NAME via
  `ctx.funcMap`, never a captured integer (the #2043 desync that made
  `extends Set` invalid Wasm).
- **Type registration**: only via `getOrRegisterVecType` /
  `ensureDateStructForCtx` / existing ensure-helpers — never a raw
  `ctx.mod.types.push` of a new single-shape struct (iso-recursive
  canonicalization hazard #2009/#2158; see the `$Object`-stays-final note at
  `object-runtime.ts` objectFields).
- **ABI**: externref-in / externref-out ONLY (the #2029 f64-mismatch lesson —
  it is the entire reason Number/Boolean are refused).
- **Body-swap discipline**: any inline emission inside the active ctor
  (RegExp slice) uses `pushBody`/`popBody`, never a shared `Instr[]`
  (`reference_shared_instr_object_dce_double_remap`).
- **gc/host byte-identity**: every new arm gated `ctx.wasi || ctx.standalone`.
  Verify with a multi-program binary-SHA compile-diff (the PR #2418
  methodology).

### Edge cases

- Multi-level chain (`class B extends A`, `A extends Array`): ancestor
  propagation (`class-bodies.ts:675–695`) already keys the dispatch on the
  builtin ANCESTOR — native ctors inherit this for free; add a test.
- `super(...args)` non-literal spread: arity-truncated per #1833/#1551 —
  preserve, do not regress.
- Uninitialized-`this` before `super()` (#2709): unchanged — the native ctor
  still runs at the `super()` site.
- `new.target` (#2023): the class-id machinery is orthogonal (the native
  ctor replaces only the parent-allocation call) — verify a
  `new.target`-using subclass compiles unchanged.
- Promise `onHost` path (#2637 B2.3, `:2961`): untouched.
- Own fields / dynamic `instanceof Sub`: documented degradations (see design
  decision), owned by #2916 Slice B — not silently "fixed" here.

### Corpus-verify plan (per slice)

- Leak probe (#2907 methodology) over
  `test/language/statements/class/subclass/builtin-objects/<Parent>/` +
  `test/built-ins/<Parent>/` subclass tests, `--target standalone`:
  `env::__new_<Parent>` leaks → 0 for the faithful shapes; instantiation
  host-free.
- **Before push**: compile+run the #3240-listed passing behavior tests for
  that parent locally (the leaky-pass regression guard — this is the step
  that kills the identity-only temptation).
- Vitest file `tests/issue-<NNNN>-*.test.ts` mirroring
  `tests/issue-3239-standalone-subclass-typedarray-native-ctor.test.ts`:
  no-leak assert + runtime behavior + WASI flip + **gc-mode keeps the host
  import** (byte-inert check).
- `net_per_test > 0`, ratio < 10 %, no bucket > 50; full `merge_group`
  validation (representation-scale — `project_broad_impact_validate_full_ci`).
- Regression control: `extends Error` (#1536c), `extends String`,
  `extends Object` (#3238), TypedArray subs (#3239) stay green;
  Number/Boolean/collections still refuse cleanly.

### Split & ordering

1. **Array** (L) — includes the shared-resolver refactor. 3 flips.
2. **ArrayBuffer + DataView** (M). 3 flips.
3. **Date** (M). 3 flips.
4. **RegExp** (M/L — call-site inline construction, different shape from 1–3). 4 flips.
5. **Function** (L, optional — rule 2 fallback acceptable). 3 flips.

Each slice: own issue id via `claim-issue.mjs --allocate`, referencing #2917
(design) + #3240 (tracking). Senior-dev (Opus) per slice — #3240's
recommendation stands.

## Acceptance

- Faithful native `__new_<Parent>` for `Array`, `ArrayBuffer`(+`DataView`),
  `Date`, static-args `RegExp` (and `Function` if Slice 5 proves out):
  subclass modules compile + instantiate host-free under `--target
standalone` for those shapes (zero `env::__new_<Parent>`), dynamic/unsupported
  shapes keep the host-import lowering (no new refusals).
- Every #3240-listed passing behavior test for the converted parents still
  passes (`new Sub(5).length === 5` class of checks).
- `instanceof <Parent>` true via #2916 Slice A on the real backing; typed
  `instanceof Sub` resolves as today; no proto/brand substrate built here.
- gc/host lanes byte-identical; Number/Boolean/collections refusals intact.
- `net_per_test > 0`; full `merge_group` net-positive; object identity
  preserved.

## Progress — Slice 1 landed (2026-07-18, fable-2917, branch `issue-2917-extends-builtin-native`)

Implements **Slice 1 (Array)** of the plan above, plus two root-cause fixes
found while building it. Real-backing design followed exactly (no wrapper).

1. **`extends Object` own fields were NOT "done" (#3238 leftover)** — the
   #2101a own-field read/write path unconditionally cast the instance to
   `$Error_struct` and used its `$props` side-slot; #3238's `$Object` backing
   made that an **illegal-cast trap** on any ctor own-field write
   (`class X extends Object { own; constructor(){super(); this.own=42} }`).
   Fix: `externrefBackedOwnFieldBacking()` (registry/error-types.ts) selects
   by transitive builtin ancestor — Error family (+`SuppressedError`) keeps
   the `$props` path; `Object` ancestry reads/writes DIRECTLY on the instance
   via `__extern_get`/`__extern_set` (the `$Object` IS the open property
   store); other ancestors return `undefined` → legacy multi-dispatch
   fallthrough (no more unconditional trap; per-slice flips to a
   direct-`__extern_set` silent-drop arm can be measured later).
2. **Per-arity `__new_<Builtin>` registration (latent #3238/#3239 mis-call)**
   — the helpers registered ONE plain funcMap name keyed off the FIRST call
   site's arity; implicit-forwarder arity varies per class
   (`max(builtin, observed-new)`), so `class B extends A`, `A extends Array`
   called the arity-1 registration with 2 args — the extra arg stayed on the
   operand stack and **validly became the forwarder's return value**
   (`new B(4,5)` returned boxed `4`, no validation error). All three helpers
   now register per-arity (`__new_X@N`) and RETURN the funcIdx; the
   class-bodies sites consume the return value. Safe: standalone never
   registers `env::__new_*` imports elsewhere (import-collector skips), and
   host mode never calls the helpers.
3. **`emitStandaloneArrayConstructor`** (object-runtime.ts) — §23.1.1.1 on
   effective argc (right-to-left `__extern_is_undefined` padding strip;
   documented divergence: `new Sub(undefined)` ≡ `new Sub()`); argc-1
   boxed-number → length-`n` vec with the non-integer/negative/≥2^32
   **RangeError** throw (real `$Error_struct` via `__new_RangeError`);
   boxed-number discriminated by `ref.test $__box_number_struct` (NOT
   ToNumber — `new Sub("3")` stays `["3"]`); otherwise args become elements.
   `.length`/element ops/`push`/`Array.isArray`/static `instanceof` verified
   via existing machinery. Shared-resolver refactor
   (`resolveStandaloneBuiltinSuperCtorIdx`, class-bodies.ts) collapses the
   duplicated dispatch ladders per the plan.

Tests: `tests/issue-2917-standalone-extends-builtin.test.ts` (Object own
fields, Array behavior incl. multi-level chain, Error-family + gc-lane
byte-inertness controls).

**Verified pre-existing (NOT regressions, family-wide, out of slice scope):**
field initializers on externref-backed subclasses are never emitted
(`class X extends Error { code = 5 }` → 0 on main too); intermediate user
ctor bodies in a builtin-ancestor chain are skipped; out-of-bounds dynamic
element writes don't grow arrays (plain `any[]` too); Error-family
`emitWasiErrorConstructor` still has the plain-name/first-arity hazard of
(2) — many sites look up plain `__new_Error`, needs its own slice.

**Remaining slices** (per Split & ordering above): ArrayBuffer+DataView,
Date, RegExp, Function — each its own issue id referencing #2917 + #3240.

## Resume State (2026-07-18, fable-2917)

- **Branch**: `issue-2917-extends-builtin-native` (pushed to fork
  `ttraenkler/js2` = `origin` in this checkout). Worktree:
  `/workspace/.claude/worktrees/agent-a39423e9c6da689e8`.
- **Done & committed** (all green locally):
  - `cbee6f3325` — extends-Object own-field illegal-cast fix
    (`externrefBackedOwnFieldBacking` in registry/error-types.ts; arms in
    expressions/assignment.ts `emitExternrefBackedOwnFieldWrite` +
    property-access.ts `emitExternrefBackedOwnFieldRead`; dispatch call site
    passes `typeName`, SuppressedError caller omits it → error-struct arm).
  - `7249f08870` — `emitStandaloneArrayConstructor` (object-runtime.ts) +
    per-arity `__new_X@N` registration for all three standalone ctor helpers
    (returns funcIdx; class-bodies call sites consume it).
  - `3fc1659c30` — merge of upstream/main (issue-file conflict resolved:
    took main's re-grounded plan, appended Progress).
  - `c6d73d054c` — shared `resolveStandaloneBuiltinSuperCtorIdx` ladder
    (class-bodies.ts, near `externrefParams`) + §23.1.1.1 RangeError arm.
- **Validation state**: `tests/issue-2917-standalone-extends-builtin.test.ts`
  16/16; regression files 2101a / 3239 / 1536c / 2188 / 2188-ml / 3234 /
  3231 all pass on the branch; `tests/issue-1455.test.ts` has 2 failures
  (WeakRef, TypeError-subclass) **confirmed pre-existing on clean main
  0f7ac132a0** via /workspace control run — NOT from this branch.
- **Next concrete steps**: (1) push branch; (2) open PR against
  `loopdive/js2` main (`gh pr create -R loopdive/js2 --head
  ttraenkler:issue-2917-extends-builtin-native`); (3) CI-wait per
  developer.md; broad-impact — watch the standalone floor + `merge_group`;
  (4) after merge: release the claim (`claim-issue.mjs 2917 --release` —
  multi-slice issue, remaining slices are re-claimable), keep issue
  `in-progress`→`ready` for the next slice owner.
- **If resuming mid-CI**: check `gh pr checks` for the PR from this branch;
  fix-forward on the branch; never enqueue manually.
