---
id: 1719
title: "Array destructuring ignores overridden Array.prototype[Symbol.iterator] ('items[Symbol.iterator] must be a function', 71 fails)"
status: in-progress
created: 2026-05-29
updated: 2026-05-29
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: array-object-identity, destructuring-iterator-protocol
goal: object-representation
sprint: Backlog
es_edition: 2015
test262_fail: 71
test262_category: language/expressions, language/statements
related: [1016, 1320, 1021, 1130, 1732, 1632, 1665]
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

## S2 attempt + BLOCKER — systemic re-entrancy (dev-b, 2026-05-29)

Implemented the de-risked S2 plan (reflect vec → host Array via new
`__array_dstr_drain` host import, gated at `destructuring.ts:892` behind
`ctx.arrayIteratorMaybeOverridden`, route through the externref GetIterator lane).
Branch `issue-1719-s2-array-dstr-v2` @ `ab38ca9f0` (WIP). tsc clean; the
override-free control is byte-identical (gate clears → import never emitted).

**BLOCKER (escalated to senior-dev/architect):** on the realistic test262 shape
`Array.prototype[Symbol.iterator] = function*…`, invoking the override
infinitely recurses → `RangeError: Maximum call stack size exceeded`. Traced:
the recursion is an **arity-4 `wasmClosureBridge` cascade** (the
`_maybeWrapCallable` closure-wrap path), NOT the arity-0 `_drainWasmClosureIterable`
drain. Once `Array.prototype[@@iterator]` is globally overridden, the override
closure gets re-wrapped and re-invoked on **every internal array iteration** in
the runtime; reflecting the vec to a host Array and driving GetIterator triggers
that cascade, and a re-entrancy guard scoped to `__array_dstr_drain` cannot
contain it (the cycle runs through the generator's own compiled execution +
the global wrap path, not back through the drain). Confirmed `arr.length` with
the override but no destructuring is fine — the recursion is specific to
driving the override through the iteration machinery.

This is the systemic re-entrancy the architect's **S1 `$ArrayObj` brand /
intactness foundation** is designed to scope (so the override does not re-fire
on every internal array touch) — the same wall dev-a's first localized attempt
hit. **S2 cannot land standalone; it needs S1 (`$ArrayObj`) first.** Recommend:
land S1 (senior-dev, per the architect's slice breakdown), then S2's gate+route
(this WIP) drops in on top.
