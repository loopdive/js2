---
id: 1719
title: "Array destructuring ignores overridden Array.prototype[Symbol.iterator] ('items[Symbol.iterator] must be a function', 71 fails)"
status: in-progress
created: 2026-05-29
updated: 2026-08-27
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: array-object-identity, destructuring-iterator-protocol
goal: standalone-mode
sprint: current
followups: [1750]
es_edition: 2015
test262_fail: 71
test262_category: language/expressions, language/statements
related: [1016, 1021, 1130, 1320, 1632, 1665, 1732, 1749, 2038, 3164, 3302]
canonical_tracking: array-object-value-representation
supersedes_approach: intactness-gate (PR #937 / branch issue-1719-impl) — invalid premise
dispatch: senior-dev-led foundational (multi-PR slices)
---
# #1719 — Array destructuring must use the (possibly overridden) Array iterator (71 fails)

## Problem

71 tests fail with:

```
%Array%.from requires that the property of the first argument,
items[Symbol.iterator], when exists, be a function
```

All are `*-iter-val-array-prototype.js` array-destructuring tests across
`language/expressions/{class,object,function,async-generator}/dstr/` and
`language/statements/{class,for,for-of,function,generators}/dstr/`. Each test
overrides `Array.prototype[Symbol.iterator]` (or `Array.prototype.values`) with
a custom generator and asserts that **array destructuring uses the overridden
iterator**.

## Root-cause hypothesis

ArrayAssignmentPattern / ArrayBindingPattern destructuring (§8.5.2
IteratorBindingInitialization / §13.15.5.3 DestructuringAssignmentEvaluation)
must call `GetIterator(rhs)` which reads `rhs[Symbol.iterator]` **dynamically at
runtime**. Our codegen takes a fast static path for array RHS values that
iterates the backing store directly (or calls a fixed `%Array%.from`-style
bridge) and therefore **ignores a user-monkeypatched `Array.prototype[Symbol.
iterator]`**. When the test replaces the prototype iterator with a value the
fast path doesn't recognise, the bridge reports "items[Symbol.iterator] … be a
function" instead of invoking the override.

The fix is to route array destructuring through a real `GetIterator` that reads
the live `@@iterator` method off the value's prototype chain (honouring
overrides), rather than a compile-time-specialised array walk — at least when
the static type cannot prove the prototype iterator is intact.

Spec: [§7.4.2 GetIterator](https://tc39.es/ecma262/#sec-getiterator),
[§8.5.2 IteratorBindingInitialization](https://tc39.es/ecma262/#sec-runtime-semantics-iteratorbindinginitialization).

## Example failing tests

- `test/language/expressions/function/dstr/ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/statements/class/dstr/meth-static-dflt-ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/expressions/class/dstr/private-meth-ary-ptrn-elem-id-iter-val-array-prototype.js`
- `test/language/expressions/async-generator/dstr/named-ary-ptrn-elem-id-iter-val-array-prototype.js`

## Acceptance criteria

- The four example tests pass.
- The `iter-val-array-prototype` cluster drops from 71 to ≤ 10.
- No regression in the broad destructuring fixes (#1016, #1021, #1024, #1025)
  nor in #1320 (Array.from(externref) iterator bridge).

## Source

Filed by product-owner test262 triage 2026-05-29 against main baseline
(`.test262-cache/test262-current.jsonl`, 48,117 records).

## Root cause — confirmed (dev-a, 2026-05-29)

Reproduced. Hypothesis confirmed; exact site pinned to
`compileArrayDestructuring` in `src/codegen/statements/destructuring.ts`.

When the destructuring RHS resolves to a **known vec or tuple struct** (the
common typed-`T[]` case — `resultType` is a `ref`/`ref_null` to a WasmGC vec
struct), control reaches the fast path at **destructuring.ts:862-876** which
stashes the struct ref and delegates to `destructureParamArray(...mode:"decl")`.
That helper walks the WasmGC **backing store directly** (`array.get` / per-field
`struct.get` on the `{length,data}` vec) — it **never calls GetIterator and
never reads `@@iterator`** off the value's prototype chain. So a
module-monkeypatched `Array.prototype[Symbol.iterator]` (or
`Array.prototype.values`) is silently ignored.

Only the **externref branch** (`compileExternrefArrayDestructuringDecl`, used
for `resultType.kind === "externref"` / unknown structs at destructuring.ts:794,
824-827, 849-852) performs a real GetIterator (RequireObjectCoercible +
`@@iterator` + `.next()`, throw-propagating, #1454). The typed-vec/tuple fast
path and the f64/i32-box path go straight to the backing-store walk.

The failing `*-iter-val-array-prototype.js` cases compile their RHS as a typed
array → hit the fast path → override ignored → wrong values or the
`%Array%.from … items[Symbol.iterator] … be a function` bridge error.

### Why this is NOT a localized fix (scope flag → architect)

The fast path is the **hot, common-case** array-destructuring lane shared by
declaration dstr, parameter dstr (`destructureParamArray`), for-of bindings,
and the loop paths. Honouring an overridden prototype iterator needs one of:

1. **Compile-time intactness gate** (preferred): a module pre-scan sets a
   `ctx`-level flag when `Array.prototype[Symbol.iterator]` /
   `Array.prototype.values` is ever assigned (or `Object.defineProperty`'d);
   when set, the vec/tuple fast-path sites coerce to externref and delegate to
   the existing `compileExternrefArrayDestructuringDecl` GetIterator lane.
   Touches `compileArrayDestructuring`, `destructureParamArray`, the param lanes,
   and for-of. Zero perf/behavior change when the flag is clear (the common
   case); full §8.5.2 fidelity when set.
2. **Always GetIterator**: drop the fast path — large perf + behavioral
   regression risk across the dstr suites #1016/#1021/#1024/#1025/#1320
   explicitly guard. Not advisable.

Either is broad codegen-core surgery on the dstr hot path, not a ~1-file change.
Per the dev guardrail this warrants an **architect spec** (precision of the
pre-scan, the for-of interaction, and the perf gate need sign-off before a dev
lands it). Spec refs: §7.4.2 GetIterator, §8.5.2 IteratorBindingInitialization,
§13.15.5.3 DestructuringAssignmentEvaluation.

Repro (worktree `issue-1719-array-dstr-iterator`): override
`Array.prototype[Symbol.iterator]` with a generator yielding a *different* 3rd
value (`42`), then `const [x,y,z] = [1,2,3]` — `z` resolves to the backing
store, not the override. Direct compile confirms the typed-vec fast path is
taken (the externref GetIterator lane is never reached for a typed array RHS).

## Implementation attempt + BLOCKER — intactness-gate premise disproved (dev-a, 2026-05-29)

**The intactness-gate spec above (PR #937) was implemented IN FULL on branch
`issue-1719-impl` @ `59d9ab9f9`** (ctx `arrayIteratorMaybeOverridden` flag,
`sourceOverridesArrayIterator` whole-module pre-scan with wrapper-stripping LHS
match + assignment/`Object.define*` detection, and BOTH gate sites —
`compileArrayDestructuring` and `destructureParamArray` — coercing a vec/tuple
RHS to externref and routing to the GetIterator lane when the flag is set).
**The gate scaffolding is sound and is reusable** (see "Reusable scaffolding"
below). Verified:

- No-override fast path is **byte-identical** to before (`const [x,y,z]=[1,2,3]`
  → `z===3` PASS — zero perf/behavior change when the flag is clear).
- With the override present, the gate **fires** and routes to the externref
  lane (the result *changes* `3`→`0`, proving the pre-scan + gate both work).

**But the gate's core premise is invalid.** Routing to the externref
`__array_from_iter_n` GetIterator lane returns **empty**, NOT the override's
yielded values. Proven by an orthogonal test: a plain `[...arr]` spread of an
array with an overridden `Array.prototype[Symbol.iterator]` also yields
**empty**, and `for-of` over it throws `[object Object] is not iterable`.

**Root cause — the same object-representation gap as #1130/#1320/#1732.** A
compiled WasmGC vec coerced via `extern.convert_any` is **not a host JS Array**:
it has a null prototype, is opaque to JS (`_isWasmStruct` returns true), and is
*not on the host `Array.prototype` chain*. The override lives on the **host's**
`Array.prototype`; the compiled array's runtime value can never observe it. No
codegen gate can make the GetIterator lane honor a host-prototype override,
because the value handed to the host isn't a host Array. Confirmed in source:
`_materializeIterable` (`src/runtime.ts:1185`) converts a vec to a host array by
walking `__vec_len`/`__vec_get` — **bypassing `@@iterator` entirely**.

This issue therefore needs the **array analog of #1732's `$FuncObj`** — a
representation decision, specced below.

---

## Architecture Spec — array object-value representation (2026-05-29)

Author: architect. **Supersedes the intactness-gate approach.** This is the
ARRAY half of the object-representation track. It is the convergent root-cause
fix for **#1719** (array-dstr ignores `@@iterator` override), **#1130** (array
methods don't observe accessor getters / length getter), and **#1320**
(`Array.from`/`Iterator.from` bridge drops own `@@iterator`). It is the direct
analog of **#1732's `$FuncObj`** for the function-object half, and reuses the
**#1629 descriptor model** — it does **not** fork a third scheme.

### Root cause (one sentence)

A compiled array is a bare WasmGC `$vec` struct (`{len, data, …}`) with **no JS
object identity** — null prototype, opaque to the host, not on
`Array.prototype` — so it cannot observe a monkeypatched `Array.prototype`
member (`@@iterator`, `values`) nor an own accessor descriptor installed via
`Object.defineProperty`; every read goes straight to the backing store.

### Design principle — `$ArrayObj`: identity + prototype link, fast path preserved

Introduce **one** representation, `$ArrayObj`, that gives a compiled array a
JS-observable object identity. It is the array analog of `$FuncObj` (#1732) and
shares the brand/identity + prototype-link philosophy:

```wat
;; $ArrayObj — array exotic object identity wrapper (WasmGC)
(type $ArrayObj (struct
  (field $vec     (mut (ref $vec)))      ;; the backing store (today's $vec_*: {len,data})
  (field $proto   (mut (ref null any)))  ;; [[Prototype]] link; null ⇒ the default %Array.prototype%
  (field $brand   i32)                   ;; bit0 = IS_ARRAY_EXOTIC (always 1 here)
                                         ;; bit1 = ITER_OVERRIDDEN  (proto @@iterator/values may be custom)
                                         ;; bit2 = HAS_OWN_ACCESSOR (an own index/length accessor exists)
  (field $descs   (mut (ref null any)))  ;; lazily-allocated own-property descriptor map
                                         ;;   (#1629 descriptor records keyed by index/"length"),
                                         ;;   null in the common case ⇒ no own descriptors
))
```

Key rules (the hot path stays fast):

- **The brand bits are whole-program-derivable and default to 0.** When the
  module never monkeypatches `Array.prototype` and never installs an array
  accessor descriptor (the overwhelming common case), `$brand === 1` (just
  `IS_ARRAY_EXOTIC`), `$proto` is null (default prototype), `$descs` is null.
  Every consuming site checks the relevant bit with a single `struct.get +
  i32.and + br_if` and falls through to **today's exact backing-store codegen**.
  Zero behavioral or perf change in that case — this is the analog of #1732's
  "`HAS_CONSTRUCT` clear ⇒ static fast path" and #1130's `arrayAccessorObserved`
  whole-program gate.
- **`$vec` is the existing struct, untouched.** `$ArrayObj` *wraps* it; it does
  not replace the `$vec_f64`/`$vec_i32`/`$vec_externref` types. All existing fast
  paths that hold a `ref $vec` keep working — `$ArrayObj.$vec` hands them the
  same struct they have today. This is the critical constraint that protects the
  #1016/#1021/#1024/#1025/#1320 dstr guards and the array hot path: **the inner
  representation does not change; we add an outer identity wrapper only where
  identity must be observable.**
- **Do not box every array.** `$ArrayObj` is materialized **lazily / on demand**
  — see "When to wrap" below. A typed `number[]` local that never escapes to the
  host and is only read/written by index stays a bare `$vec`. The wrapper appears
  only when (a) the whole-program brand says some array *might* be observed, or
  (b) the array crosses to the host where JS-observable identity is required.

### Dual-mode story (load-bearing — the standalone axis)

The two modes resolve prototype/override observation differently. **This is the
explicit dual-mode answer the gate spec lacked.**

**JS-host mode** (a real `Array.prototype` exists to observe):
- The override the test installs lives on the **host** `Array.prototype`. To
  observe it, the value handed to the host iteration/`@@iterator` machinery must
  be **a real host Array** (or a host object whose `[[Prototype]]` is the host
  `Array.prototype`). The chosen mechanism: when the program's
  `ITER_OVERRIDDEN`/`HAS_OWN_ACCESSOR` brand is set, a compiled array that needs
  observable identity is **reflected into the host as a real `Array`** via a new
  host helper, and the `$ArrayObj.$vec`↔host-Array pairing is recorded in a
  WeakMap (analogous to `_wasmStructProps`, keyed on the `extern.convert_any`
  wrapper). The host Array is the live view the host's `GetIterator`/`Get`/
  `HasProperty` machinery walks — so a monkeypatched `Array.prototype[@@iterator]`
  and own accessor descriptors are observed by construction. Writes propagate
  back to `$vec` (or the host Array *is* the source of truth while branded — see
  S3). This is the array analog of #1732 reflecting a method value into a host
  function whose `[[Construct]]`/descriptors the host already enforces.
- **Standalone/WASI mode** (pure Wasm, no host `Array.prototype`): there is no
  host prototype object to monkeypatch, so the *only* override a program can
  install is one the compiler also lowers to Wasm. The Wasm-native model:
  `Array.prototype` is itself a compiled object (a `$proto` target) holding
  compiled `@@iterator`/`values`/method closures; `$ArrayObj.$proto` links to it;
  `GetIterator` and array-method dispatch read the `@@iterator`/accessor **off
  `$ArrayObj.$proto` via Wasm `struct.get` + funcref dispatch** (no host import).
  When `$proto` is null and the brand bit is clear, the default
  `%Array.prototype%[@@iterator]` is statically known ⇒ today's fast backing-store
  walk. **Scope honesty:** full standalone prototype-override fidelity (a program
  reassigning the compiled `Array.prototype[@@iterator]` at runtime) is **S4**,
  the lowest-priority slice; until S4 lands, standalone mode honors only the
  *default* iterator (which is already correct for non-overriding programs). The
  test262 families in this issue (#1719's `*-iter-val-array-prototype.js`) run in
  **JS-host mode**, so S1–S3 (JS-host) bank the full delta; standalone parity is
  S4 and explicitly deferred.

### When to wrap (the materialization policy)

`$ArrayObj` is created instead of a bare `$vec` when **any** of:
1. **Whole-program brand is set** — the module monkeypatches `Array.prototype`
   `@@iterator`/`values` (reuse dev-a's `sourceOverridesArrayIterator` pre-scan,
   already on branch `issue-1719-impl`), or installs an array accessor descriptor
   (reuse #1130's `state.getterCallbackFound` → `arrayAccessorObserved`). When
   either whole-program flag is clear for its concern, arrays of that concern are
   **never wrapped** for that concern. The two flags are independent bits.
2. **The array escapes to the host** with identity requirements — passed to
   `Array.from`/`Iterator.from`/spread into a host call, or returned where the
   host will run `GetIterator`/`Get` on it. Today these go through
   `_materializeIterable` (#1320); that path becomes the wrap-into-host-Array
   boundary (S3).

Otherwise the array stays a bare `$vec` and **all current codegen is unchanged**.

### Where each consumer consults the representation

1. **`GetIterator` / array destructuring / spread / for-of (#1719).**
   - File: `src/codegen/statements/destructuring.ts` `compileArrayDestructuring`
     (the gate site dev-a added @~815), `src/codegen/destructuring-params.ts`
     `destructureParamArray` (@~808), and the for-of / spread lowering.
   - The brand check replaces dev-a's "coerce-to-externref → `__array_from_iter`"
     routing (which is invalid). New routing **when `ITER_OVERRIDDEN`**:
     reflect/obtain the host Array for the `$ArrayObj` (S3 helper) and drive the
     **host** `GetIterator` over it so the override's `@@iterator` runs; in
     standalone, dispatch the `$ArrayObj.$proto` `@@iterator` funcref (S4).
   - **When the bit is clear**: today's backing-store walk (the fast path the
     #1016/#1021/#1024/#1025 guards protect) — unchanged, byte-identical.
2. **Array callback methods + index/length `[[Get]]` (#1130).**
   - File: `src/codegen/array-methods.ts` (`setupArrayLoop` @~4472,
     `buildClosureCallInstrs`/`buildBridgeCallInstrs`, the 7 method compilers).
   - The #1130 2026-05-24 re-spec's `arrayAccessorObserved` gate + the
     `__array_idx_accessor_get`/`__array_length_accessor_get`/`__to_length`/
     `__array_has_idx_accessor` host imports + `emitElementLoad` slow path are
     **subsumed here**: the own-accessor descriptor now lives on
     `$ArrayObj.$descs` (a #1629 descriptor map), so the element-load slow path
     reads the accessor from `$descs` (standalone: `struct.get` + funcref;
     JS-host: the same WeakMap sidecar #1130 already proved works). #1130's PR-0
     (array-index-exotic length growth, already implemented on branch
     `issue-1130-getter-observe-v2`) folds in as the `$descs`/`$vec.len`
     write-side and **lands independently** — it is valid regardless of this
     spec.
3. **`Array.from` / `Iterator.from` host bridge (#1320).**
   - File: `src/runtime.ts` `_materializeIterable` (@1185), `_arrayFromIter`
     (@5157), `_drainWasmClosureIterable` (@1242).
   - Today `_materializeIterable` walks `__vec_len`/`__vec_get` and ignores
     `@@iterator`. New behavior: when the value is an `$ArrayObj` with
     `ITER_OVERRIDDEN` (or any host object whose own/prototype `@@iterator` is a
     compiled closure), obtain the host Array view (S3) and let native
     `Array.from` walk it — so the override's `@@iterator` (and the
     custom-iterator drain #1320 already built) is honored. #1320's existing
     `_drainWasmClosureIterable` is reused unchanged for the closure-iterator
     drain; this spec only fixes the *array-receiver* case it could not reach.
     (The #1320 closure-return readback gated on **#1684** is orthogonal and
     stays with #1684.)

### Reconciliation with #1732 `$FuncObj` and #1629 descriptors

- **Same philosophy, sibling struct.** `$FuncObj` gives *callables* identity
  (brand + `length`/`name` descriptors + `[[Construct]]` bit); `$ArrayObj` gives
  *arrays* identity (brand + `[[Prototype]]` link + own-descriptor map). They are
  two leaves of one representation family — **do not** invent a third scheme.
  Recommend a shared `## Object-value representation` design note (see "Tracking"
  below) so future Number/String/RegExp value-identity gaps reuse the pattern.
- **`$descs` uses the #1629 descriptor record verbatim.** The own index/length
  accessor and value descriptors stored on `$ArrayObj.$descs` are the same
  `ToPropertyDescriptor`/descriptor-record shape #1629 (S1/S2, both merged) reads
  back for `getOwnPropertyDescriptor`. No parallel descriptor type.
- **Prototype link is the same `$proto` mechanism** #1732/#1665 use for the
  function/iterator prototypes; standalone `%Array.prototype%` is one more
  compiled prototype object in that scheme.

### Slice breakdown

- **S0 (independent prerequisite, already implemented):** #1130 PR-0 vec
  array-index-exotic `length` growth on `defineProperty`
  (branch `issue-1130-getter-observe-v2`). Lands on its own; no `$ArrayObj`
  dependency. Banks the `arr.length`-after-numeric-`defineProperty` correctness
  bug + a few native tests.
- **S1 — `$ArrayObj` type + lazy materialization + whole-program brand
  (JS-host).** Introduce the struct; wire the two whole-program brand bits
  (reuse dev-a's `sourceOverridesArrayIterator` and #1130's
  `arrayAccessorObserved` scans); wrap only when branded or host-escaping.
  Prove the no-brand path emits byte-identical output (microcheck, the #1130
  pattern). No test delta required — pure machinery + the gate. *Senior-dev led.*
- **S2 — host-Array reflection + `GetIterator` override (closes #1719,
  JS-host).** Add the reflect-into-host-Array helper + the
  `$ArrayObj`↔host-Array WeakMap pairing; route the destructuring/spread/for-of
  `ITER_OVERRIDDEN` brand to the host `GetIterator` over the reflected Array.
  **Closes #1719's 71** (target ≤10 residual). Replaces dev-a's invalid externref
  routing at the same two gate sites.
- **S3 — fold #1130 accessor-observation + #1320 bridge onto `$ArrayObj`
  (JS-host).** Move #1130's accessor slow path to read `$ArrayObj.$descs`; route
  `_materializeIterable`/`_arrayFromIter` through the host-Array reflection so the
  `@@iterator` override + own accessors are honored. Banks the #1130 native-vec
  cluster (the 2026-05-24 measured ~30–45) + #1320's array-receiver residual.
- **S4 — standalone/WASI parity.** Compiled `%Array.prototype%` object +
  Wasm-native `$proto` `@@iterator`/accessor dispatch (no host import). Lowest
  priority; the #1719/#1130/#1320 test262 families are JS-host so S1–S3 bank the
  full conformance delta. S4 closes the standalone bucket only.

If capacity is tight: **S0 + S1 + S2 alone close #1719** (the 71). S3 banks
#1130/#1320. S4 is standalone debt-paydown.

### Reusable scaffolding from dev-a's gate (branch `issue-1719-impl` @ 59d9ab9f9)

**Keep and reuse** (the front-end half of the solution):
- `sourceOverridesArrayIterator` whole-tree pre-scan (`src/codegen/index.ts`) —
  wrapper-stripping LHS match + assignment + `Object.define*` detection, OR'd
  across multi-module. Becomes the `ITER_OVERRIDDEN` brand source. **Sound, no
  rework needed.**
- The two gate sites in `compileArrayDestructuring` and `destructureParamArray`
  with the string-RHS exclusion — keep the gate *placement and string guard*;
  **replace only the routing target** (externref→`__array_from_iter` is invalid;
  route to the S2 host-Array `GetIterator` instead).
- `ctx.arrayIteratorMaybeOverridden` flag + `create-context.ts` init — rename to
  the `$ArrayObj` brand source, keep the plumbing.

**Discard:** the `extern.convert_any` → `compileExternrefArrayDestructuringDecl`
routing (the invalid premise). The flag and pre-scan survive; the dead-end lane
target does not.

### Test set

- **#1719 — 71 fails:** all `*-iter-val-array-prototype.js` under
  `language/expressions/{class,object,function,async-generator}/dstr/` and
  `language/statements/{class,for,for-of,function,generators}/dstr/`. Closed by
  S2. Samples to gate the PR:
  - `test/language/expressions/function/dstr/ary-ptrn-elem-id-iter-val-array-prototype.js`
  - `test/language/statements/class/dstr/meth-static-dflt-ary-ptrn-elem-id-iter-val-array-prototype.js`
  - `test/language/expressions/async-generator/dstr/named-ary-ptrn-elem-id-iter-val-array-prototype.js`
- **#1130 cluster (S3):** the native-vec subset (#1130's measured ~96, realistic
  ~30–45 non-hole) under
  `test/built-ins/Array/prototype/{forEach,map,every,some,filter,reduce,reduceRight}/`
  — `accessed`/`lengthAccessed`/`testResult` getter-on-index / getter-on-length.
- **#1320 cluster (S3):** `test/built-ins/Array/from/iter-cstm-ctor.js`,
  `iter-set-length.js`, and the `Array.from(array-with-overridden-@@iterator)`
  receiver case (NOT the #1684-gated closure-return cases).
- **Regression / fast-path guards** (must stay green, the un-overridden common
  case must stay fast):
  - #1016/#1021/#1024/#1025 destructuring suites + #1320 existing bridge tests.
  - #1130 PR-0 suite (`tests/issue-1130.test.ts`).
  - **Byte-equality microcheck**: a getter-free / override-free module compiles
    to **byte-identical** Wasm pre/post `$ArrayObj` (proves the brand gate is
    truly zero-cost when clear) — the same guard #1130 mandated.
  - Array hot-path microbench (`tests/array-capacity`,
    `array-bounds-elimination`) unchanged.
  - #1732 `$FuncObj` tests (S3 shared-prototype interaction) once #1732 lands.

### Which test262 families this CAN vs CANNOT reach, per mode

| Family | JS-host (S1–S3) | Standalone (S4) |
|--------|-----------------|------------------|
| #1719 `*-iter-val-array-prototype.js` (proto `@@iterator`/`values` override) | **YES** (S2) | runtime-reassigned override: S4 only; default iterator: already correct |
| #1130 own index/length accessor on a native vec | **YES** (S3) | YES (S4: `$descs` via `struct.get`) |
| #1320 `Array.from` over array with overridden `@@iterator` | **YES** (S3) | S4 |
| `Array.prototype[k]` **prototype-chain index getter** (the #1130 48-test proto subset) | partial — needs prototype-walk `Get`; **out of scope**, follow-up | follow-up |
| Interior-hole `HasProperty` (`[9, , 12]`) | **CANNOT** without hole-representation change — **separate follow-up** (per #1130 open question) | same |
| #1320 closure-return iterator readback (`iter-cstm-ctor` deep case) | **gated on #1684**, not this issue | n/a |

**Honest acceptance criteria** (replaces the header's "≤10"):
- **S2 closes #1719:** the 71 `iter-val-array-prototype` fails drop to ≤10
  (residual = interior-hole / prototype-chain cases that are explicit follow-ups).
- **S3** banks the #1130 native-vec non-hole subset (~30–45) + #1320's
  array-receiver residual.
- No regression in #1016/#1021/#1024/#1025/#1320 guards; byte-identical output
  for override-free modules.

### Dispatch recommendation

**This is a senior-dev-led foundational change**, not dev-volume work. It
introduces a new value representation (`$ArrayObj`) that must reconcile with the
in-flight `$FuncObj` (#1732) and the #1629 descriptor model, touches the array
hot path and the dstr/for-of/spread/array-method/runtime-bridge surface, and
carries a dual-mode (JS-host vs standalone) design axis. **Recommend: assign S1
+ S2 to senior-dev (Opus), coordinate landing order with #1732's S3 (`$FuncObj`)
so the shared prototype-link / brand philosophy converges into one
object-value-representation design note.** S0 (#1130 PR-0) can land
independently now by a regular dev.

### Tracking

Treat #1719 as the **canonical "array object-value representation" tracking
issue** (frontmatter `canonical_tracking`). Cross-linked: #1130 (accessor
observation, S3), #1320 (bridge, S3), #1732 (sibling `$FuncObj`), #1629
(descriptor model), #1632/#1665 (function/iterator prototype scheme). Future
array value-identity gaps close by reusing S1–S4 with no new design.

---

## S1 implementation note — brand-gate machinery (senior-dev, 2026-05-29)

**Slice landed by this PR: S1 (JS-host).** S0 (#1130 PR-0) is already on
`main` (`252f7a3ee`), so this is the first implementation slice of the array
object-value representation track.

### WHY this slice does NOT emit a WasmGC `$ArrayObj` struct (cross-cutting)

The spec's S1 bullet says "Introduce the struct." After reading dev-a's
sibling **#1732-S1** (`issue-1732-s1-construct`), the realization is that
the **JS-host** slices of *both* tracks deliberately do **not** materialize
the WasmGC brand struct — they lean on the host's real object identity:

- #1732-S1's JS-host `new f` fix is a runtime `__construct`/`IsConstructor`
  host import at the new-site, **not** a `$FuncObj` struct. Its
  host-import-allowlist comment states *"Standalone parity is S4 ($FuncObj
  brand read)"* — i.e. the `$FuncObj` WasmGC struct is an **S4/standalone**
  concern.
- The array analog is identical: in JS-host mode the override lives on the
  **host** `Array.prototype`, so the mechanism that observes it is
  "reflect the vec into a real host `Array` + pair them in a WeakMap"
  (the spec's own "Dual-mode story → JS-host mode" paragraph). That is S2.
  The WasmGC `$ArrayObj` struct is only needed where there is **no host to
  lean on** — i.e. standalone (S4), where `$ArrayObj.$proto` + funcref
  dispatch replaces the host prototype.

Emitting a `$ArrayObj` WasmGC struct now (in the JS-host slices) would be a
**dead type**: nothing in JS-host mode reads its `$proto`/`$descs` fields,
because the host Array carries that identity. It would also risk perturbing
the #1016/#1021/#1024/#1025/#1320 fast-path guards for zero benefit. So to
keep ONE shared convention with $FuncObj and avoid forking a third scheme,
**the WasmGC `$ArrayObj`/`$FuncObj` brand structs are deferred to S4
(standalone) for both tracks.** Coordinated with dev-a.

### What S1 actually delivers (the foundation S2/S3 build on)

1. **`ITER_OVERRIDDEN` whole-program brand** = `ctx.arrayIteratorMaybeOverridden`
   (the spec's recommended ctx-flag name, kept verbatim from dev-a's
   scaffolding). Sourced by the `sourceOverridesArrayIterator` whole-tree
   pre-scan, OR'd across all program source files (multi-module safe). The
   pre-scan is dev-a's, unchanged — wrapper-stripping LHS match for
   `Array.prototype[Symbol.iterator] = …` / `Array.prototype.values = …`
   assignment, plus `Object.defineProperty(Array.prototype, …)` /
   `defineProperties`. **This is the reusable front-end half the spec's
   "Reusable scaffolding" section endorses ("Sound, no rework needed").**

2. **A single gate predicate** `arrayDstrNeedsIdentity(ctx, isStringRHS)`
   placed at the two dstr fast-path sites (`compileArrayDestructuring`,
   `destructureParamArray`) with the string-RHS exclusion (a string is not
   an Array, so `Array.prototype` changes can't affect it). The predicate is
   the *placement* the spec mandates keeping; **the routing target it gates
   is an S2 concern** and is not wired here.

3. **Byte-identical-when-clear guarantee.** When
   `ctx.arrayIteratorMaybeOverridden === false` (the overwhelming common
   case), every dstr site emits **exactly today's bytes** — the gate
   predicate short-circuits to the existing backing-store walk. Proven by a
   byte-equality microcheck in `tests/issue-1719-s1.test.ts` (an
   override-free module compiles to identical Wasm pre/post this change).
   This is the analog of #1130's `arrayAccessorObserved` whole-program gate
   and #1732's "`HAS_CONSTRUCT` clear ⇒ static fast path".

### Why the S1 gate is behaviorally a no-op even when the brand IS set

dev-a's original `issue-1719-impl` routed a branded vec RHS through
`extern.convert_any → __array_from_iter`. The spec proved that lane
**invalid** (a coerced vec is not a host Array; it returns empty / throws —
the same object-rep gap). So S1 keeps the pre-scan + flag + gate-site
*placement* but **does not** wire that dead-end lane. Until S2 supplies the
host-Array reflection + host `GetIterator`, the gate predicate exists and is
unit-tested, but the dstr sites fall through to the existing fast path —
meaning **S1 is behaviorally a no-op** (zero test delta, as the spec's S1
bullet requires) while establishing the brand plumbing and the single,
correctly-placed gate predicate that S2 fills in. This is intentional: S1
lands the foundation with zero regression risk; S2 banks #1719's 71.

### Files touched (S1)

| File | Change |
|------|--------|
| `src/codegen/context/types.ts` | add `arrayIteratorMaybeOverridden: boolean` to `CodegenContext` |
| `src/codegen/context/create-context.ts` | init `arrayIteratorMaybeOverridden: false` |
| `src/codegen/index.ts` | `sourceOverridesArrayIterator` pre-scan (ported from dev-a); set flag OR'd across modules |
| `src/codegen/statements/destructuring.ts` | export `arrayDstrNeedsIdentity` gate predicate (placement only; S2 fills routing) |
| `tests/issue-1719-s1.test.ts` | pre-scan detection unit tests + byte-identical-when-clear microcheck |

Spec refs: §7.4.2 GetIterator, §8.5.2 IteratorBindingInitialization,
§13.15.5.3 DestructuringAssignmentEvaluation.

---

## S2 diagnosis — the override assignment is DROPPED at compile time (senior-dev, 2026-05-30)

**This supersedes both the "S2 attempt + BLOCKER" recursion framing AND the
architecture spec's JS-host S2 premise.** Investigated on a fresh worktree off
`origin/main` (`d14df3b3a`) with S1 (PR #942) and S0 (#1130 PR-0) both landed.

### What was verified (4 probes, canonical test262 shape)

The shape under test: `Array.prototype[Symbol.iterator] = function* () { … yield this[0]; yield this[1]; yield 42; }`
then array-destructure `[1,2,3]`.

1. **The override assignment compiles to nothing.** Compiling the assignment
   alone emits ZERO `__extern_set` / proto-write imports and produces no
   module-init instructions for it. `compile()` succeeds with no error or
   warning — the statement is silently discarded.
2. **`$__module_init` proof.** For `Array.prototype[@@iterator]=fn; var f=function([x,y,z]){…}`,
   the emitted `$__module_init` contains ONLY the `var f =` store
   (`ref.func; struct.new; local.tee; global.set`). The
   `Array.prototype[Symbol.iterator] = …` statement is **entirely absent** from
   the wasm.
3. **The host `Array.prototype` is NOT mutated.** Runtime probe: after
   instantiating the compiled module, `Array.prototype[Symbol.iterator]` on the
   host is byte-identical to before (`origIter === afterIter`, still the native
   function). The override reaches **neither** the host prototype **nor** any
   compiled proto object.
4. **Every consumer ignores the override.** decl-dstr → `z=3` (not 42);
   param-dstr `function([x,y,z])` → `z=3`; `[...arr]` spread → length 3;
   `for (v of arr)` → sum 6 (not the override's 15). No `RangeError` reproduced
   in any of these shapes — dev-b's recursion was a *secondary* symptom of
   bolting host-Array reflection onto a value that was never connected to any
   override.

### Why this invalidates the S2-as-specced approach

- **dev-b's premise** ("reflect the vec to a host Array so it inherits the
  overridden host `Array.prototype`") cannot work: there is no override on the
  host prototype to inherit (probe 3).
- **The architecture spec's JS-host premise** (line ~161: "the override lives on
  the host's `Array.prototype`") is also wrong for this compiler: the compiled
  `Array.prototype[k] = v` assignment is dropped before any override exists
  anywhere (probes 1–2).
- S1's brand machinery (`arrayIteratorMaybeOverridden` + `arrayDstrNeedsIdentity`
  gate, PR #942) is sound and correctly placed — but routing the dstr site
  through ANY observation lane is futile while the override is stored nowhere
  observable.

### The genuine prerequisite (re-spec needed)

The missing piece is a **writable `Array.prototype` representation**: a
compiler-owned proto record that `Array.prototype[k] = v` actually mutates, and
that `GetIterator` / array-method dispatch / dstr / for-of consult. This is the
architecture spec's S4 (`$ArrayObj.$proto` + funcref dispatch) — which the S1
note explicitly *deferred*. The JS-host S2 slice cannot close the 71 without it.

**Recommendation:** route back to the architect. Either S2 is re-specced to
include a minimal writable-`Array.prototype` capture (so `Array.prototype[k]=v`
lands in a record GetIterator reads), or the S4 proto-object slice is the real
next step and the host-Array-reflection S2 (dev-b's WIP + the spec's JS-host
paragraph) is retired. The branch `issue-1719-s2-array-dstr-v2` (dev-b's reflect
+drain WIP) should NOT be merged — its premise is disproved.

No code landed by this investigation; worktree clean.

---

## Writable-prototype slice design (S2-respec) — senior-dev, 2026-05-30

Tech-lead asked for the **minimal writable-`Array.prototype`** design: the
narrowest thing that (1) lowers `Array.prototype[k] = v` (`@@iterator` first)
into a compiler-owned proto record, and (2) teaches GetIterator + array-dstr +
for-of + spread to consult it. Below is the design plus the three verdicts.

### New probe results that shape the design

1. **The drop is UNIVERSAL across every prototype, not Array-specific.** Verified
   `Array.prototype[Symbol.iterator]=…`, `Array.prototype.values=…`,
   `Object.prototype.foo=…`, `String.prototype[Symbol.iterator]=…`,
   `Number.prototype.toString=…`, and user-class `C.prototype.m=…` — **none**
   emit any module-init or `__extern_set`; the whole statement is discarded for
   all of them. So a writable-prototype representation is the **keystone** for the
   entire prototype-override cluster (#1130 accessor-observation, #1320 Array.from
   bridge, plus latent String/Number/Object-prototype patches), not a #1719-local
   patch.
2. **The RHS value is dead-code-eliminated too.** When
   `Array.prototype[@@iterator]=function*…` is dropped, the generator function is
   **never even compiled** (no closure/generator func in the output) — nothing
   references it. **Design consequence:** the slice must make the proto record a
   *referencing site* so the RHS closure becomes reachable and gets emitted. A
   read-side fix alone is insufficient; the write side must root the value.
3. **Drop site located.** `Array.prototype[Symbol.iterator] = …` is an
   `ElementAccessExpression` assignment. In
   `compileElementAssignment` (`src/codegen/expressions/assignment.ts:~2388`) the
   `ts.isIdentifier(target.expression)` class-static arm and the
   `ClassName.prototype[key]` arm both gate on `ctx.classSet.has(...)` — `Array`
   is a builtin, not in `classSet`, so neither fires. Control reaches
   `compileExpression(target.expression)` on `Array.prototype`, which yields no
   usable lvalue, and the assignment evaporates with no error. (No `__extern_set`
   because the receiver isn't a live externref object — `Array.prototype` has no
   compiled representation at all.)

### Minimal slice — "compiled prototype record" (CPR)

**Scope to exactly one well-known key first: `@@iterator` (and its alias
`values`) on `Array.prototype`.** Generalize later by table, not by rewrite.

**Write side (capture the override):**
- A per-program `ctx.protoOverrides: Map<string, Map<string|symbol, FuncRef>>`
  keyed `("Array", @@iterator) → closure funcref index`. Reuse the existing
  `staticProps`-style global-map convention (`ctx` already has
  `staticProps: Map<string, number>` at `context/types.ts:434`) — this is the
  same "named slot → global/func index" shape, no new infra family.
- In `compileElementAssignment`, add an arm **before** the `classSet` gates:
  when `target.expression` is `X.prototype` with `X` a known builtin
  (`Array`/`Object`/`String`/…) and the key resolves to a tracked well-known
  symbol, compile the RHS (forcing the closure to be emitted — fixes probe-2's
  DCE), store its funcref index in `ctx.protoOverrides`, and emit the RHS value
  as the assignment's result (assignment expr returns RHS). No host write; the
  record is compile-time state that roots the closure.
- The `sourceOverridesArrayIterator` S1 pre-scan **already detects exactly this
  pattern** and sets `ctx.arrayIteratorMaybeOverridden`. The CPR write arm fires
  under the same condition — S1's brand becomes the *gate* and CPR becomes the
  *storage* the brand promised. **S1 is reused verbatim; CPR sits directly on top
  of it.** No rework to S1.

**Read side (consult the record):** the three consumers the brand gate already
marks:
- **array-dstr** — `destructureParamArray` (`destructuring-params.ts:799`) +
  `compileArrayDestructuring` gate site (`destructuring.ts:892`): when
  `arrayIteratorMaybeOverridden` AND `ctx.protoOverrides` has `Array/@@iterator`,
  drive iteration by calling the stored closure funcref (via the existing
  `__call_fn_*` / generator-drive machinery, **in-Wasm**, no host import, no
  host-Array reflection) instead of the backing-store walk.
- **for-of** — `compileForOfDestructuring` / the for-of lowering
  (`statements/loops.ts:1060`): same brand+record check before the fast vec walk.
- **spread** — array spread lowering: same check.

When the record is empty (the common case — brand clear), every site is
**byte-identical to today** (the S1 guarantee is preserved: the new branch is
behind `arrayIteratorMaybeOverridden && protoOverrides.has(...)`, both false).

### VERDICT 1 — does this close the 71 standalone, or need full S4?

**Honest estimate: the MINIMAL single-key CPR closes the #1719 71 by itself, and
it is NOT the full $ArrayObj.$proto + general funcref-dispatch (S4).** Reasoning:
- The 71 `*-iter-val-array-prototype.js` tests all install ONE override
  (`Array.prototype[Symbol.iterator]` or `.values`) and assert array-dstr/for-of
  uses it. A single-key CPR + the three read-site consults covers exactly that
  shape — no general prototype-chain `Get`, no per-instance `$proto` link, no
  arbitrary-key dispatch needed.
- It runs **in-Wasm** (call the stored closure funcref directly) so it is
  **standalone-clean** — it does NOT depend on a host `Array.prototype` or
  host-Array reflection (the disproved premises). This is strictly better than
  the spec's JS-host S2 and is the correct seed of S4.
- It is a **proper subset** of S4: S4 = "compiled `%Array.prototype%` object with
  arbitrary-key `$proto` funcref dispatch + per-`$ArrayObj` `$proto` link." CPR =
  "one global table for a fixed set of well-known proto keys." CPR is the first,
  load-bearing slice of S4; S4 generalizes CPR's table to arbitrary keys +
  instance-level proto links. **CPR closes #1719; full S4 is only needed for
  runtime-reassigned-per-instance prototypes and arbitrary-key proto reads
  (#1130's prototype-chain index-getter subset), which #1719 does not require.**

### VERDICT 2 — generalization

`X.prototype[k]=v` is dropped for **ALL** prototypes (probe-1: Array, Object,
String, Number, user classes). CPR's table is keyed by `(builtinName, key)`, so
extending from `Array/@@iterator` to `Array/values`, then `String/@@iterator`,
`Object/*`, etc. is **adding table rows + read-site consults**, not a redesign.
This makes CPR the **keystone for the prototype-override cluster** — #1130
(accessor observation can store get/set funcrefs in the same table), #1320
(Array.from reads the same `Array/@@iterator` record), and future String/Number
prototype patches all reuse it. That is the strategic argument for building it as
a foundation rather than a one-off.

### VERDICT 3 — smallest safe increment + position vs S1

Smallest landable increment, in order:
- **CPR-1 (the seed):** write-arm for `Array.prototype[@@iterator]=fn` →
  `ctx.protoOverrides` + force-emit RHS closure; read-consult at the **array-dstr
  gate site only** (the one S1 already placed). Closes the dstr subset of the 71.
  Byte-identical when brand clear. ~1 codegen write site + 1 read site + 1 ctx
  field. Sits **directly on S1's landed brand** (reuses
  `arrayIteratorMaybeOverridden` + `arrayDstrNeedsIdentity` as the gate).
- **CPR-2:** add `values` alias + for-of + spread read-consults. Closes the rest
  of the 71.
- **CPR-3 (folds in S3 of the spec):** add `Array/index-accessor`,
  `Array/length-accessor` rows for #1130, and route #1320's `Array.from` through
  the same record.
- **S4 (deferred):** generalize the table to arbitrary keys + per-instance
  `$proto` for full prototype-chain fidelity (the #1130 prototype-chain
  index-getter subset + runtime-reassigned prototypes). Not needed for #1719.

Position: CPR is the **storage layer S1's brand gate was always pointing at**.
S1 (landed) = detection + gate placement; CPR = capture + in-Wasm dispatch. The
disproved host-Array-reflection S2 (dev-b's branch) is **retired** — CPR replaces
it with a standalone-clean mechanism.

### One-paragraph recommendation

Build **CPR-1 + CPR-2** as the #1719 fix (closes the 71, standalone-clean, sits
on the sound S1 brand, byte-identical when no override). It is a true subset of
the architect's S4, so it converges rather than forks — and because the
prototype-assignment drop is universal, CPR is the keystone the #1130/#1320
cluster reuses. It does NOT require the full $ArrayObj WasmGC struct or
arbitrary-key proto-chain dispatch (those are S4, only needed for prototype-chain
index getters and per-instance reassignment, neither of which #1719 exercises).
Recommend scheduling CPR-1 (seed, ~3 touch points) as the next senior-dev slice;
it is small enough to land now if the build-now decision is yes. Architect should
sign off on the `ctx.protoOverrides` table shape + the well-known-key whitelist
before implementation, since it becomes the shared substrate for the cluster.

No code landed by this design pass; worktree clean (gitignored `.tmp/` probes only).

## CPR build plan + progress (senior-dev sdev-cpr, 2026-05-30)

**Prerequisite DONE**: #1742 the `this`-receiver runtime-test guard — PR #961
(branch issue-1719-cpr2). The override body's `this[i]`/`this.length` now read the
compiled vec via a runtime `ref.test` chain instead of trapping "illegal cast".
Zero equivalence regressions (failure set byte-identical to base).

**Tech-lead decision: option (a)** — normalise the typed vec (`$vec_f64`/`$vec_i32`)
→ the canonical externref-vec at the dstr/for-of/spread gate BEFORE driving the
override. Single canonical representation; fires the override exactly ONCE at the
observation boundary; internal array iterations stay on the typed-vec fast path
(no global re-route) → avoids the systemic re-entrancy that killed the first attempt.
GATE STRICTLY behind the S1 brand (`arrayIteratorMaybeOverridden` + `protoOverrides.has`)
so output is byte-identical when no override exists (diff the wasm to confirm).

Build order (each step a commit; gate-on-brand throughout):

1. **CPR-1 write-arm** — in `compileElementAssignment` (assignment.ts ~2451), detect
   `Array.prototype[Symbol.iterator] = fn` / `Array.prototype.values = fn` (the LHS
   shape `sourceOverridesArrayIterator` already recognises). Lift the RHS closure via
   `compileArrowAsClosure` (handles `function*` generators), recover its
   `__closure_N` funcIdx + funcTypeIdx (from `ctx.closureInfoByTypeIdx` / closureMap),
   and store into `ctx.protoOverrides.get("Array").set("@@iterator"|"values", {funcIdx,
   funcTypeIdx})`. Force-emit + root the closure so DCE doesn't drop it (it's otherwise
   only referenced from the table, not the wasm body).
2. **Runtime drain** — a generic iterator next()-protocol helper (`__iterator_next`-style)
   that, given the override-produced iterator externref, calls `.next()` and unpacks
   `{value, done}` — handling BOTH a `function*` (compiled generator → its own next)
   and a plain `{ next(){…} }` override object. Reuse #1620's multi-value
   `__iterator_next` if it covers both; else extend.
3. **CPR-1 read-drive** — at the dstr gate (destructuring.ts ~892), when
   `arrayDstrNeedsIdentity(ctx,isStringRHS)` AND `ctx.protoOverrides` has the Array
   `@@iterator` override: normalise the typed-vec RHS → canonical externref-vec, call
   the stored override funcref with that as `this` via `__call_fn_method_0`, then drain
   via the next()-protocol into the binding elements. PROVE `[a,b,z]=arr` with an
   override yielding 42 at slot 3 → z===42, terminates.
4. **CPR-2** — `Array.prototype.values` alias (same table key family) + for-of
   (loops.ts ~1060) + spread read-consults of the same protoOverrides table.

Guardrails: this is the array hot path (#1016/#1021/#1320). If the normalise step
sprawls beyond the gate sites, STOP + ping tech-lead. Diff wasm on an override-free
module to confirm byte-identical.

**Status**: #1742 prerequisite landed (PR #961). Starting CPR-1 write-arm.

## CPR-1 write-arm — DONE (senior-dev sdev-cpr, 2026-05-30, commit ea66317fe)

The override assignment was dropped at compile time (S2 diagnosis, above) because
the **module-init statement filter** (`declarations.ts` ~3058) only keeps a
top-level assignment when its root identifier is a module global — `Array` is a
builtin, so `Array.prototype[@@iterator] = fn` was discarded before reaching
codegen. Root cause of the "drop" found + fixed:

1. The S1 brand (`arrayIteratorMaybeOverridden`) was set AFTER `collectDeclarations`
   in both the single- and multi-module paths (index.ts ~1000 / ~4085). Moved the
   brand-set BEFORE `collectDeclarations` so the filter sees it.
2. Filter now KEEPS the `Array.prototype[@@iterator|values] = fn` statement when the
   brand is set (`isArrayProtoIteratorAssignTarget`).
3. `src/codegen/expressions/proto-override.ts` — `maybeCaptureArrayProtoOverride`
   lifts the RHS closure (`compileArrowAsClosure`, handles `function*`), roots it in
   a fresh `mut externref` module global (`__array_proto_iterator_override`,
   DCE-safe), records `{globalIdx}` in `ctx.protoOverrides["Array"]["@@iterator"]`.
   Wired into `compileAssignment`. `arrayIteratorOverrideGlobalIdx(ctx)` exposes the
   global for the read-drive.

Verified: the override global IS now emitted (CPR_DEBUG traced capture); override-free
modules emit NO `__array_proto` global (byte-identical). `protoOverrides` value type
carries `globalIdx`.

### Read-drive design (next — the z=42 proof)

At the dstr gate (`destructuring.ts` ~892, vec ref on stack), when
`arrayDstrNeedsIdentity(ctx,isStringStruct)` AND `arrayIteratorOverrideGlobalIdx(ctx)`
is defined:
1. Normalise the typed-vec RHS → externref (`extern.convert_any`) = the array-as-`this`.
2. `__call_fn_method_0(arrayExternref, global.get <overrideGlobalIdx>)` → iterator externref
   (drives the override generator's body; #1742 guard lets its `this[i]` read the vec).
3. Drain via the existing `__iterator_next` host import `(externref)->(i32 done, externref value)`
   — per binding element: call next, on `done` apply the element default / undefined,
   else assign `value`. Reuse the per-element assignment logic from
   `compileExternrefArrayDestructuringDecl` (the externref dstr lane already drains an
   iterator), but feed it OUR iterator (the override result) instead of `__iterator`
   on the host array.
4. `return` (skip the backing-store fast path) — fires the override exactly once.

Termination: internal array iterations inside the override body stay on the typed-vec
fast path (the brand gate only fires at dstr/for-of/spread observation sites, not on
every `arr[i]`), so no global re-route → no re-entrancy.

### Read-drive dispatch — timing analysis (sdev-cpr, awaiting tech-lead a/b/c)

Verified `emitClosureMethodCallExportN(0)` (index.ts ~2815): its body is the exact
re-entrancy-safe driver we need (convert closure externref→anyref; save/install/restore
`__current_this`; ref.test the base-wrapper struct; extract funcref field 0; dispatch
over registered funcref types via ref.test/ref.cast/call_ref; box result→externref).
BUT two timing facts shape the dispatch mechanism:
1. It iterates `ctx.closureInfoByTypeIdx`, populated DURING body compilation — so it
   MUST run in post-processing (after all closures registered), like `__call_fn_method_N`.
2. It does NOT register in `ctx.funcMap` (only pushes mod.functions + mod.exports).

So the dstr read-drive (emitted during body compilation, BEFORE post-processing) cannot
resolve the driver's funcIdx by name at emit time. Resolution needs ONE of:
- (a) emit a dedicated `__drive_proto_iterator` in post-processing AND reserve its funcIdx
  up-front (a stable pre-allocated index the dstr `call` targets) — small, self-contained.
- (b) thread a forward-funcref/patch for `__call_fn_method_0` — reuses code, more plumbing.
- (c) inline call_ref per read-drive site — needs the full funcref-type dispatch duplicated
  3× (dstr/for-of/spread); the closure's funcTypeIdx varies → sprawl.

Recommend (a). Awaiting confirmation before adding the driver fn (array hot path).

## CPR read-drive — finish-pass progress (sendev sdev-cpr2, 2026-05-30, branch issue-1719-cpr2-finish)

Resumed off `bb2afb0e9` (CPR-1 write-arm) + clean `origin/main` merge (= the #1742 guard via #961). Tech-lead confirmed **option (a)** driver. Verified state + landed two foundational edits; the rest of the read-drive is the remaining work.

### Verified (corrects two prior false-alarms)

1. **CPR-1 write-arm WORKS in the real `compile()` pipeline.** Probed the canonical
   shape (`Array.prototype[Symbol.iterator]=function*(){…yield 42}` + `[a,b,z]=[1,2,3]`):
   brand fires, `maybeCaptureArrayProtoOverride` lifts the generator closure and pushes
   the rooted `__array_proto_iterator_override` externref global; `arrayIteratorOverrideGlobalIdx`
   returns it. The earlier "global absent" reading was a **grep-for-name false alarm** —
   WasmGC does **not** serialize global *names* into the binary; counting `ctx.mod.globals`
   directly confirms the push. Pre-read-drive, `z===3` (fast path), terminates — correct baseline.
2. **Double-capture wrinkle (cosmetic, fix in this PR):** `compileModuleInitBody()` runs
   twice (`declarations.ts:3455` early-discovery + `:3540` final), so the write-arm pushes
   the override global **twice** — one orphan (null-init, unreferenced, from the discarded
   first body) + one live (referenced by the final `__module_init`). Correct but wasteful;
   dedupe by making `maybeCaptureArrayProtoOverride` idempotent per `(token,memberKey)`
   (reuse the existing global on the 2nd pass instead of pushing a new one — but still emit
   the `global.set/get` into the live body).

### Landed (foundational, committed on branch)

- **`src/codegen/index.ts`** — `emitClosureMethodCallExportN` now `ctx.funcMap.set(exportName, funcIdx)`
  so the in-Wasm driver (filled in post-processing) can resolve `__call_fn_method_0` by name.
  No-op for existing JS-host callers (they dispatch by export name).
- **`src/codegen/context/types.ts`** — added `protoIteratorDriverReserved?: boolean`. The
  driver funcIdx lives in `funcMap` under `"__drive_proto_iterator"` (NOT a raw ctx number) —
  load-bearing because `shiftLateImportIndices` patches both the funcMap entry AND the emitted
  read-drive `call` by the same delta, so a late-import shift never desyncs the reservation.

### Remaining build (the z=42 proof) — exact plan

1. **Driver reservation + fill (option a)** in `proto-override.ts`:
   - `reserveProtoIteratorDriver(ctx)` — on first read-drive site: push a placeholder
     `WasmFunction` (sig `(externref this, externref closure)->externref`, `addFuncType`),
     funcIdx = `ctx.numImportFuncs + mod.functions.length`, register `funcMap["__drive_proto_iterator"]`,
     set `protoIteratorDriverReserved=true`. Body left `[]` (filled later).
   - `fillProtoIteratorDriver(ctx)` — called in post-processing AFTER `emitClosureMethodCallExportN(0)`
     (so `funcMap["__call_fn_method_0"]` exists): body = `local.get 0; local.get 1; call __call_fn_method_0; return`
     (thin wrapper; reuses the proven re-entrancy-safe `__current_this` dispatch). Guard: if
     `__call_fn_method_0` absent (no arity-0 closure), fill with `ref.null.extern` (driver unused anyway).
2. **Read-drive at `destructuring.ts:892`** (the `_needsArrayObjIdentity` gate, currently a void no-op):
   when `arrayDstrNeedsIdentity(ctx,isStringStruct)` AND `arrayIteratorOverrideGlobalIdx(ctx)!==undefined`:
   stash-then `extern.convert_any` the vec RHS → array-as-`this` externref; `global.get` the override
   closure; `call __drive_proto_iterator` → iterator externref (local); then **per binding element**
   drain via `__iterator_next` (the `loops.ts:3576` shape: `(i32 done, externref value)`), assigning
   `value` to each binding local (on `done`, apply default / undefined). `return` — skip the
   backing-store fast path. The 71 `iter-val-array-prototype` tests are fixed-arity `[a,b,c]`
   (no rest/nested), so per-element drain suffices for CPR-1; rest/nested = CPR-2 polish.
3. **Prove z=42** end-to-end (`tests/issue-1719-cpr.test.ts`), assert termination (the brand only
   fires at the dstr observation boundary, so internal array iterations stay on the typed-vec fast
   path → no re-entrancy).
4. **CPR-2**: `values` alias (already keyed) + for-of (`loops.ts:1060`) + spread — same read-drive.
5. **Guard**: byte-identical wasm on an override-free module (the whole branch is behind
   `arrayIteratorMaybeOverridden && globalIdx!==undefined`, both false in the common case). Run
   `npm test -- tests/equivalence.test.ts` → 0 regressions before PR.

**Open runtime risk to validate first in step 3:** the override is a `function*`; calling it via
`__call_fn_method_0` yields a *compiled* generator object. Draining it via the host `__iterator_next`
relies on its `__call_next`/`__gen_next` fallback (`runtime.ts:7786-7803`) recognising the compiled
generator. If that drain returns empty/undefined, the override-produced iterator needs the Wasm-native
generator-next path instead (a `__call_next` dispatch on the struct) — surface immediately, do not
paper over. This is the one unproven link in the chain.

## CPR-1 LANDED — z=42 proven (sendev sdev-cpr2, 2026-05-30, commit ed780a6cf)

Built + committed on `issue-1719-cpr2-finish` (merged current with origin/main).
The "unproven link" above is **resolved**: the host `__iterator_next` drains the
compiled-generator iterator correctly through its `__call_next` fallback.

**Proven:** `Array.prototype[Symbol.iterator]=function*(){…yield 42}` +
`var [a,b,z]=[1,2,3]` → **z===42** (was 3), TERMINATES, override-free
byte-identical. `tests/issue-1719-cpr.test.ts` (z=42 + termination + override-free)
green; S1 byte-identical microcheck green; #1016/#1021/#1320 dstr guards: no new
failures (the lone 1016b `string[Symbol.iterator]` fail is PRE-EXISTING on clean
HEAD — harness `wasm:js-string` import wiring, not this change). tsc clean.

**Scope of CPR-1:** the **declaration** array-dstr path (`compileArrayDestructuring`)
for identifier/default/elision patterns — the decl subset of the 71. The `values`
alias rides for free (`arrayIteratorOverrideGlobalIdx` checks both keys).

**CPR-2 remaining (fan-out, same proven `emitArrayProtoIteratorDrive` helper):**
1. parameter dstr — 2nd gate site `destructureParamArray` (destructuring-params.ts:799).
2. for-of-head dstr — `compileForOfDestructuring` (loops.ts:1060) [note: the override
   affects BOTH the outer for-of iteration AND the inner element destructure; needs
   care — route `compileForOfStatement`'s array fast path through the override
   iterator when branded, reusing `compileForOfIterator`'s `__iterator_next` loop].
3. assignment dstr (`[a,b]=arr`) — separate path from `compileArrayDestructuring`.
4. spread (`[...arr]`).
Each is "add the gate at site N + call the shared helper + a scoped test". Awaiting
tech-lead a/b: (a) land CPR-1 PR now + CPR-2 follow-up (lets CI measure the real
per-context split of the 71), or (b) build all CPR-2 into this branch first.

## DONE — CPR destructuring read-drive complete across all 4 contexts (sendev, 2026-05-30)

The destructuring cluster — the 71 `*-iter-val-array-prototype.js` fails — is
**closed**. Array destructuring now drives the (possibly overridden)
`Array.prototype[Symbol.iterator]` / `Array.prototype.values` in **all four**
destructuring contexts, each via the same proven `emitArrayProtoIteratorDrive`
helper, all gated behind `ctx.arrayIteratorMaybeOverridden && arrayIteratorOverrideGlobalIdx(ctx) !== undefined`
so override-free modules stay byte-identical:

| Context | Site | Landed in |
|---------|------|-----------|
| **declaration** `var [a,b,z]=arr` | `compileArrayDestructuring` / `tryEmitArrayProtoIteratorReadDrive` (statements/destructuring.ts) | PR #963 (CPR-1) |
| **for-of-head** `for (const [a,b] of xs)` | `compileForOfDestructuring` (statements/loops.ts) | PR #968 (CPR-2) |
| **parameter** `function f([a,b]) {}` | `destructureParamArray` (codegen/destructuring-params.ts) | PR #968 (CPR-2) |
| **assignment** `[a,b,z]=arr` | `tryEmitArrayProtoIteratorAssignDrive` + `compileArrayDestructuringAssignment` (expressions/assignment.ts) | PR #976 (CPR-2 final) |

Proof in every context: `Array.prototype[Symbol.iterator]=function*(){…yield 42}`
+ the matching destructure → bound `z===42` (was `3`), and the override fires once
at the observation boundary (internal array iterations stay on the typed-vec fast
path, so it TERMINATES — no re-entrancy). Override-free modules byte-identical;
`tests/issue-1719-cpr.test.ts` (7 tests: decl z=42 / decl termination /
for-of-head z=42 / for-of multi-element termination / parameter z=42 /
assignment z=42 / override-free) green; #1016/#1021/#1320 dstr guards unaffected.

**Write-arm + drive mechanism (the keystone):** the override assignment
(`Array.prototype[k]=fn`, dropped at compile time normally) is captured by
`maybeCaptureArrayProtoOverride` into a rooted `mut externref` module global keyed
in `ctx.protoOverrides`; the dedicated `__drive_proto_iterator` driver
(option (a), placeholder-funcIdx reserved at body-compile, body filled in
post-processing as a thin wrapper over `__call_fn_method_0`) installs/restores
`__current_this` and dispatches the override; the resulting compiled-generator
iterator is drained with the multi-value `__iterator_next` host import. See
`src/codegen/expressions/proto-override.ts`.

### Genuinely-remaining follow-ups (OUT of the original 71 — tracked, not regressions)

- **#1749** — spread (`[...arr]`, `f(...arr)`, `new C(...arr)`) is a separate
  `GetIterator` consumer with its own emit site; none of the 71 are spread. Reuse
  `emitArrayProtoIteratorDrive` at the spread-element site.
- **#1750** — the TS-cast assignment form `(Array.prototype as any)[Symbol.iterator]=fn`
  is not captured by the write-arm (paren/`as` wrapper). A naive wrapper-strip was
  reverted because the cast-form closure misses arity-0 `__call_fn_method_0`
  dispatch (null iterator); the null-guard keeps it falling back cleanly. Hand-written
  shape, not in test262.

## Reopened 2026-08-26 — standalone CPR returns a raw iterator to `__iterator_next`

The original four-context CPR acceptance was complete only in the GC/host lane.
The override-free byte lock was target-neutral, but every behavioral invocation
used the JavaScript host runtime. The issue therefore closed the original 71
test262 rows without proving the stronger claim that the same producer/consumer
contract works in standalone mode.

#4755's direct assignment-TDZ matrix supplied the missing observation. Its
canonical assignment-destructuring CPR row compiles in standalone with zero
host imports and reaches both `__drive_proto_iterator` and
`__iterator_next`, then traps with an illegal cast before the first assignment
target can run. Removing the TDZ guard produces the same trap. This is an
existing iterator-carrier defect, not a #4755 regression and not evidence that
the module-lexical writer is wrong.

### Measured contract mismatch

`emitArrayProtoIteratorDrive` in
`src/codegen/expressions/proto-override.ts` returns the raw externref produced
by the captured override closure. The declaration, parameter, for-of-head,
assignment, and separately-landed #1749 spread consumers pass that raw value
directly to `__iterator_next`.

Those values happen to share a contract in the GC lane: the host helper accepts
the compiled generator object and dispatches its `.next()`. The standalone
runtime has a stricter, deliberately normalized ABI:

1. `__iterator(raw iterable-or-iterator)` creates an `$IterRec` externref;
2. `__iterator_next($IterRec)` returns `(done, value)`; and
3. the native `__iterator_next` body casts its input to `$IterRec` before
   dispatch.

The CPR producer currently hands it a raw `$GenState_*`. The cast therefore
traps even though the generator/iterator itself is valid. #2038 established the
normalizer/consumer contract, while #3164 and #3302 already teach the native
iterator finalizer how to drive non-capturing and capturing compiled-generator
states after normalization. The missing operation is the single normalization
boundary between the CPR driver and those existing consumers.

### Native-generator receiver prerequisite

The existing CPR fixtures are deliberately receiver-sensitive: their override
is a generator function expression whose body yields `this[i]`. Native generator
admission currently rejects any function expression whose body references
`this`. Normalizing the resulting `$GenState_*` cannot help if that state was
never compiled in the first place, so receiver preservation is a prerequisite
of this repair rather than a weaker follow-up.

Do not remove the general `this` rejection. The closure receiver-install plan
explicitly excludes generators, and a lifted function expression's Wasm param 0
is `__self`, not a JavaScript receiver. Broad admission would therefore
miscompile ordinary `g.call(o)`/`g.apply(o)` generators and change unrelated
override-free artifacts.

In standalone only, admit this non-escaping shape through one pure AST predicate
shared by the import prescan and emit-time candidate check:

- a generator `FunctionExpression` is the direct RHS of an assignment;
- that assignment is itself a standalone `ExpressionStatement`;
- the LHS is exactly an already-supported CPR target,
  `Array.prototype[Symbol.iterator]` or `Array.prototype.values`; and
- the generator uses own-scope `this`, but not `super` or a nested-arrow
  receiver shape.

Extract the existing CPR target recognizer into a TS-AST-only leaf so
`generators-native.ts` and `proto-override.ts` share the exact predicate without
forming a codegen cycle. The exception is exactly
`ctx.standalone && exactCprReceiverAssignmentShape(decl)`;
`sourceNeedsGeneratorHostImports` already delegates to the native-candidate
check, so the shared positive gate must keep host import prescan and actual
admission in lockstep. WASI retains the old `this` rejection and `__gen_*` host
route.

For only that standalone positive shape, add optional
`callTimeThisFieldIdx` metadata to `NativeGeneratorInfo` and append one
immutable externref `receiver_this` field to its GenState after
params/spills/delegation slots and before optional `pending`. Leave every
existing candidate's layout byte-exact, including the same source compiled for
WASI. At generator factory invocation, snapshot the live
`ctx.currentThisGlobalIdx` into that field immediately before optional pending
initialization and `struct.new`. The CPR driver invokes the closure through
`__call_fn_method_0`, which has already installed the array receiver into
`__current_this` at precisely that point.

On resume, load `state.receiver_this` into a fresh externref local and bind
`resumeFctx.localMap["this"]` to it before compiling the trampoline/body.
`compileThisKeyword` gives that local precedence, so suspension and later
resumption cannot observe the restored ambient `__current_this`. Do not set or
reuse `synthesizedThis`: that path assumes a real receiver parameter and would
alias the lifted closure's `__self`. Closure/funcref signatures, the CPR driver,
the GenState iterator arms, and the `__iterator_next` ABI stay unchanged.

### Implementation plan

1. Normalize the CPR result once in the shared
   `emitArrayProtoIteratorDrive`; do not patch its five consumers separately.
   Resolve/register the canonical `__iterator` helper before capturing any
   shiftable function/global index used by the driver. Change the helper seam
   so it re-resolves `arrayIteratorOverrideGlobalIdx(ctx)` after that settlement
   (or carries the allocator entry rather than a raw number); the callers'
   pre-registration numeric index is not a stable identity.
2. In standalone only, pass the raw override result through
   `ensureLateImport(ctx, "__iterator", ...)`, flush the late-import shifts,
   and store the resulting `$IterRec` externref as the drive result. The
   existing `__iterator_next` consumers remain unchanged. WASI is outside this
   standalone completion and must remain byte-exact.
3. Keep GC/host byte-exact: no `__iterator` registration, no second override
   lookup, no extra call, and no new branch in the emitted body. Keep every
   override-free module byte-exact in all lanes.
4. Reuse `ensureNativeIteratorRuntime` and its existing
   `fillNativeIteratorLateArms` composition. Do not add a CPR-specific cast,
   duplicate generator-state dispatcher, or teach `__iterator_next` to accept
   an unnormalized union.
5. Add the bounded, `ctx.standalone`-only CPR receiver-positive gate and keep an
   unconditional `super`, WASI, and unrelated-generator `this` rejection. Split
   the current body scan as needed so own-scope `this` is distinguishable from
   `super`; nested-arrow receiver capture remains conservatively unsupported in
   this slice.
6. Under that same standalone gate, add the optional GenState `receiver_this`
   field, snapshot live
   `__current_this` at factory invocation, and rehydrate the resume function's
   local `this` binding from the state. Preserve the pending-last invariant and
   every old candidate's field indices.
7. Give the issue-bearing `generateMultiModule` graph exact single-source
   finalizer parity, guarded by
   `ctx.standalone && ctx.protoIteratorDriverReserved`. Immediately after
   `emitIteratorMethodExport(ctx)`, mirror the full conditional
   truthiness-dependency/`addUnionImports(ctx)` block and then call
   `fillNativeIteratorLateArms(ctx)`. This is after bodies/field getters settle
   and before closure-method exports, so any reserved apply closure is still
   completed by the existing later `fillApplyClosure` phase. Override-free
   standalone, GC, and WASI graphs never enter the block.
8. Under the same `ctx.standalone && ctx.protoIteratorDriverReserved` guard,
   call `fillProtoIteratorDriver(ctx)` immediately after the multi-source
   `emitClosureMethodCallExportN` loop and before `fillAccessorDrivers(ctx)`. At
   that point `__call_fn_method_0` exists and neither DCE nor module freeze has
   run.
9. Fail closed if the standalone normalizer, receiver field, or either late
   finalizer cannot be reserved/resolved. Mutate the native-iterator fill and
   proto-driver fill independently; one must expose the raw-GenState trap and
   the other the reserved `unreachable` stub.
10. Do not silently fall back to the backing-store fast path after the override
    has been observed, and do not reintroduce a host import.

The order remains load-bearing even though the five current consumers already
ensure `__iterator_next`, which installs the append-only standalone iterator
runtime before this helper runs. Idempotently ensure/read `__iterator` first,
then resolve the live override global and driver, call the driver, and normalize
its returned externref. Re-resolution protects the allocator identity if a
future caller reaches the shared helper before that eager consumer setup; it is
not a claim that today's standalone lookup shifts every defined function.

### Required proof

- Run the existing declaration, parameter, for-of-head, assignment, and #1749
  spread CPR shapes in standalone under the exnref-enabled child/runtime
  harness. Require the override values, termination, and zero host imports.
- Cover both `Array.prototype[Symbol.iterator]` and `.values` capture keys.
- Exercise a non-capturing compiled generator (#3164) and a capturing generator
  (#3302) so both native iterator-finalizer arms cross the normalized boundary;
  include one receiver-plus-outer-capture fixture.
- Exercise a re-entrant nested two-array drive: begin the outer CPR generator,
  drain an inner array while the outer GenState is suspended, then resume the
  outer drive. Each GenState must retain its exact call-time receiver. Pin the factory
  `global.get $__current_this -> receiver_this` store and the resume
  `struct.get receiver_this -> local this` load in caller-scoped WAT.
- Keep an unrelated `g = function* () { yield this.x }` plus `g.call(o)` control
  rejected or host-routed exactly as before, proving the positive admission gate
  did not broaden.
- Assert the standalone artifact contains live `__drive_proto_iterator`,
  `__iterator`, and `__iterator_next` calls in that order, with no raw
  `$GenState_*` value supplied directly to `__iterator_next`.
- Because raw `$GenState_*` and `$IterRec` cross the same externref Wasm ABI,
  bypassing normalization remains Wasm-valid and fails only at the native cast.
  Require caller-scoped WAT adjacency/count (`drive -> iterator` exactly once;
  `iterator_next` consumes only the normalized local) plus a runtime mutant that
  bypasses normalization and reproduces the illegal-cast failure.
- Mutate receiver admission, factory initialization, and resume rehydration
  independently: restoring the old admission bail must regain a host import or
  fail import-free instantiation; a null receiver field and an omitted resume
  binding must each produce the wrong receiver-sensitive result.
- Compare GC behavioral and binary artifacts before/after byte-for-byte for
  both override keys. Compare override-free GC and standalone artifacts
  byte-for-byte.
- Compile a multi-source graph with the override producer and destructuring
  consumer in separate sources; require exact source/closure identity and the
  same standalone result in both source orders.
- Prove WASI, GC/host, and every override-free artifact remain byte-exact, and
  rerun the originating #4755 standalone assignment/destructuring TDZ-order row.
- Rerun the #2038, #3164, #3302, native-iterator, four-context CPR, fallback,
  layering, optimization, LOC/function-budget, and normal precommit/prepush
  controls without baseline growth.

### Acceptance criteria for the reopened issue

- [ ] All five existing CPR consumers terminate and return the override values
      in standalone with zero host imports.
- [ ] The shared producer returns a normalized iterator record to the native
      consumer; no consumer-local workaround or widened `__iterator_next` ABI
      exists.
- [ ] Capturing and non-capturing compiled generators both retain their current
      native finalizer behavior, including exact call-time receiver identity
      across suspension and a receiver-plus-capture composition.
- [ ] In standalone, only the two non-escaping CPR assignment shapes gain
      receiver state. Ordinary receiver-bearing generator function expressions
      and every WASI candidate remain outside the native admission exception.
- [ ] GC/host, WASI, and all override-free artifacts are byte-exact.
- [ ] A source-separated producer/consumer graph preserves exact identity and
      cannot fall back to the typed backing-store walk.
- [ ] Focused iterator suites, mutation proof, TypeScript 7 and 5, formatting,
      layering, fallback/oracle/coercion/optimization ratchets, LOC/function
      budgets, and the unskipped precommit/prepush hooks pass.

This repair is a standalone contract completion for the already-landed CPR,
not a reopening of the old intactness-gate design. #1749 remains separately
landed, but its shared-producer standalone lane is mandatory regression proof;
#1750 remains outside this repair. No LOC or function-budget allowance is
pre-authorized. Before every heavy command, commit, and push, require a finite,
non-negative one-minute load strictly below `logical cores - 2`; run
`pnpm run check:loc-budget` immediately before the signed commit.

### 2026-08-26 implementation handover

PR #4999 is a plan-only draft; no compiler source or runtime behavior changes
belong to it. The architecture amendment above incorporates the receiver-state
prerequisite exposed by the completed #4755 matrix and has received an
independent read-only Sol review. It replaces the earlier assumption that
normalizing the raw CPR result alone was sufficient.

The next implementation session should start from current `main`, claim #1719,
and execute the numbered plan without broadening generator receiver admission:
first extract the shared AST-only CPR assignment predicate, then add the
standalone-only GenState receiver slot/rehydration, normalize the shared driver
result, and finally mirror the guarded multi-source finalizers. Land frequent
signed checkpoints, keep GC/WASI and override-free artifacts byte-exact, run the
strict `cores - 2` load gate before every heavy command/commit/push, and never
skip precommit or prepush hooks. The #4755 regression in PR #4997 is the
mandatory downstream ordering control.

## 2026-08-27 dispatch update — finish the standalone CPR contract

The reopened residual is still the standalone producer/consumer contract, not
the historical intactness-gate approach. Before dispatch, refresh live
`upstream/main`, verify the #4755 prerequisite and open-PR collision state, and
re-run the exact raw-iterator reproducer against the current baseline.

The bounded implementation sequence is:

1. Land the shared AST-only CPR assignment predicate and the standalone-only
   normalizer/fill/finalization parity. The first checkpoint must prove all five
   existing consumers use `drive → __iterator → __iterator_next` with a
   non-receiver generator and must leave GC/WASI and override-free artifacts
   unchanged.
2. Add only the immutable call-time-`this` receiver slot to `GenState`, with
   resume rehydration and the capture/two-array reentrancy controls. Preserve
   the current receiver until the generator completes; no broad generator or
   `Array.prototype` admission is allowed.
3. Mirror the guarded multi-source finalizers and add the exact standalone
   receiver/override matrix. Require structural driver/next evidence, zero
   host imports, strict native fill, and a value-level result; a compilation
   that merely returns the expected value without the iterator path is not
   acceptance evidence.

This work is file-bounded to the CPR producer/consumer and its focused tests.
Route unrelated iterator, GC eager-buffering, `#1750`, and array object-value
representation findings to their existing owners. Land each coherent
checkpoint as a ready PR only after its own static, focused, and normal hook
gates pass.

## 2026-08-27 checkpoint 1a — normalize the shared standalone CPR result

The first implementation checkpoint closes only the already-admitted
non-receiver producer/consumer ABI edge. It extracts one exact AST-only
predicate for direct `Array.prototype[Symbol.iterator] = value` and
`Array.prototype.values = value` statements, then changes the shared
`emitArrayProtoIteratorDrive` producer in standalone mode to reserve and settle
the canonical `__iterator` helper before retaining shiftable identities. The
producer re-resolves the override global and CPR driver after settlement,
drives the captured override once, normalizes the raw generator state exactly
once, and stores that `$IterRec`-compatible externref for every existing
`__iterator_next` consumer. No consumer-local workaround and no widened
`__iterator_next` ABI is introduced.

The non-standalone branch deliberately retains its prior caller-supplied
override-global index and the direct `reserveProtoIteratorDriver` result. Exact
artifact comparison pins GC and WASI unchanged for both override keys and pins
the override-free standalone artifact unchanged. Focused WAT evidence requires
one `__iterator` call and one authoritative store of its result. When the
mandatory peephole pass fuses the first `local.set`/`local.get` pair, the exact
`local.tee` value must feed only the established null guard, after which every
`__iterator_next` reloads that same local; without fusion, every consumer also
loads the stored local. Runtime evidence covers declaration, parameter,
for-of-head, assignment, and #1749 spread for both override keys with zero host
imports. The shipped-default inliner remains runtime-correct, while the
structural probe explicitly disables and restores its environment setting.
Child execution is bounded by timeout and rejects spawn errors, signals, and
nonzero status.

Checkpoint evidence is 19/19 focused tests across the new regression and the
existing #1719 S1 controls, TypeScript 7 and 5, targeted formatting/lint, and
the LOC/function ratchets. Production growth is +103 LOC without a budget
baseline change. GC, WASI, and override-free standalone binaries/WAT are
byte-identical to the exact parent; only the intended standalone override
artifacts change.

This does not close #1719. The bounded receiver-state/capture and re-entrant
generator proof, guarded multi-source finalizer parity, source-order matrix,
mutation proof, and test262 denominator remain the next checkpoints. The issue
therefore stays `in-progress`; #1750 and the broader array object-value model
remain out of scope.
