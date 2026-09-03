---
id: 5267
title: "ES2015 standalone: for-of + iterator prototypes + collections — r2 residual pass"
status: in-progress
sprint: current
created: 2026-09-01
updated: 2026-09-03
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [5144, 5147, 5151, 4444]
loc-budget-allow:
  # 2026-09-01 r2 plan: every step below adds NEW emitted-code paths (a
  # constructor-side iterable drive, live collection iterator records, brand
  # closures with behavioral bodies, a %IteratorPrototype% root, a cached
  # `next` field on the iterator record, an interleaved per-element
  # assignment-pattern drive, lazy-helper GetIteratorDirect) — growth, not
  # refactor. Granted for this change-set only.
  - src/codegen/expressions/new-super.ts
  - src/codegen/map-runtime.ts
  - src/codegen/set-runtime.ts
  - src/codegen/weak-collections-runtime.ts
  - src/codegen/iterator-native.ts
  - src/codegen/iter-hof-native.ts
  - src/codegen/iter-lazy-native.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/native-proto.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/statements/loops.ts
  - src/codegen/statements/for-of-destructuring.ts
  - src/codegen/destructuring-params.ts
  - src/codegen/function-instance-meta.ts
  - src/codegen/builtin-static-gopd.ts
  - src/codegen/property-access.ts
  # 2026-09-01 (Opus impl, Step A-2): the well-known-symbol VALUE read
  # (`Symbol.hasInstance`) must carry the i32 `symbol` brand in the
  # native-symbol lanes, or an any-channel coercion boxes it as the NUMBER 2.
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/array-methods.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  # 2026-09-03 r3 plan (files not already granted above): R3-8 adds a
  # boxed-number arm to the standalone strict-eq helper; R3-2 seeds own `next`
  # closures on the Map/Set iterator prototypes (new brands, own-props arms);
  # R3-4(d) touches the finally re-inline; R3-6 exports the deleted-@@iterator
  # guard for the for-of array path. Growth, not refactor — this change-set only.
  - src/codegen/any-eq-helpers.ts
  - src/codegen/native-proto-own-props.ts
  - src/codegen/builtin-brands.ts
  - src/codegen/statements/exceptions.ts
  - src/codegen/statements/destructuring.ts
  - src/codegen/set-runtime.ts
func-budget-allow:
  # 2026-09-01: each is a kind-dispatch / arm-ladder function that gains one
  # more arm in the shape its existing arms already have (see the step that
  # names it). Add further entries here, with a dated line, if the gate names
  # another function — never edit scripts/*-baseline.json.
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/new-super.ts::tryCompileNativeWeakCollectionNew
  - src/codegen/array-object-proto.ts::emitIteratorPrototypeSingleton
  - src/codegen/iterator-native.ts::buildIteratorBody
  - src/codegen/iterator-native.ts::buildIteratorNextBody
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
  - src/codegen/iter-hof-native.ts::fillIterHofSteppers
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/map-runtime.ts::fillMapSetDynDispatchArms
  - src/codegen/statements/loops.ts::compileForOfIterator
  - src/codegen/statements/for-of-destructuring.ts::compileForOfAssignDestructuringExternref
  - src/codegen/statements/for-of-destructuring.ts::compileForOfIteratorAssignDestructuring
  - src/codegen/index.ts::generateModule
  # 2026-09-03 r3 plan: each gains one arm / one guard in the shape its existing
  # arms already have (the R3 step that names it says which). `ensureMapHelpers`
  # owns the `__map_iter_next` body (sticky exhaustion, R3-1c);
  # `emitNativeCollectionCtorIterableDrive` gains the null→undefined normalize +
  # the adder-branch move (R3-3); `compileForOfArray` gains the deleted-flag
  # guard (R3-6); `getOrRegisterIterRecType` gains the `nextMethod` field
  # (R3-4b); `registerAnyStrictEqAndComparisonHelpers` gains the boxed-number
  # arm (R3-8); `makeCollectionGlue` gains the `@@1` alias (R3-7a).
  - src/codegen/map-runtime.ts::ensureMapHelpers
  - src/codegen/map-runtime.ts::tryCompileNativeMapMethodCall
  - src/codegen/expressions/new-super.ts::emitNativeCollectionCtorIterableDrive
  - src/codegen/statements/loops.ts::compileForOfArray
  - src/codegen/iterator-native.ts::getOrRegisterIterRecType
  - src/codegen/any-eq-helpers.ts::registerAnyStrictEqAndComparisonHelpers
  - src/codegen/array-object-proto.ts::makeCollectionGlue
---

# #5267 — ES2015 standalone: for-of + iterator prototypes + collections (r2)

## Problem

The 2026-09-01 standalone baseline (loopdive/js2wasm-baselines, compiler sha
`d39779cb`, an ancestor of HEAD) lists 155 failing ES2015 rows across
`language/statements/for-of/**` (63), `built-ins/Iterator/prototype/**` (32),
`built-ins/ArrayIteratorPrototype/next` (23), `Map`/`Set`/`WeakMap`/`WeakSet`
(~50) and the `Set`/`Map`/`String` iterator prototypes (~21). Waves 1 (#5144
for-of, #5147 iterators, #5151 collections — all on main via PR #5244) landed
the mechanisms; this is the residual pass over what those waves' "Skipped /
follow-ups" sections left open.

**Re-verified on HEAD `0d9bfedee` (2026-09-01)** with
`npx tsx scripts/run-test262-paths.mts .tmp/es2015/forof-head-safe.txt --standalone`
(152 rows in-process) plus `--isolate` for the 3 rows that
`delete Array.prototype[Symbol.iterator]` (`.tmp/es2015/forof-head-poison.txt`):

| | pass | fail | compile_error |
|---|---|---|---|
| 152 in-process | **1** (dropped: `SetIteratorPrototype/next/does-not-have-mapiterator-internal-slots-set.js`) | 147 | 4 |
| 3 isolated | 0 | 0 | 3 |

**Target = 154 rows**, split into the per-cluster lists
`.tmp/es2015/forof-cl-<X>.txt` (below; they partition the 151 in-process
non-pass rows exactly — 0 unclustered, 0 duplicates — plus the 3 isolate
rows in F5). Raw per-row verdicts: `.tmp/es2015/forof-head-nonpass.tsv`.

Two things changed since the baseline and shape the plan:

1. **The `env::*` host-import leaks are RE-CLASSIFIED, not gone** (baseline:
   21 `host_import_leak` CEs — `WeakMap_new` ×8, `Set_entries` ×5,
   `WeakSet_new` ×4, `Set_new` ×3, `Uint8ClampedArray_keys` ×1). On HEAD the
   runner reports the 14 constructor rows as RUNTIME failures carrying V8's own
   message text (`object is not iterable (cannot read property
   Symbol(Symbol.iterator))`, `Iterator value 1 is not an entry object`) —
   but compiling the same shapes through `compile(src, { target: "standalone" })`
   still emits `env::Set_new` / `env::WeakMap_new` function imports (Step A-0,
   measured). The runner instantiated those modules against the host `env`
   instead of flagging the leak, so the failures LOOK like semantics gaps. A
   runner-side finding to file separately; this issue closes the leak
   natively (Step A) and verifies with the module's real import list, never
   with the runner's classification. `registerBuiltinExternClasses`'s
   `!ctx.nativeStrings` gates (`src/codegen/extern-declarations.ts:62`,
   `:134`, `:158`) stay as they are — the leak comes from the ctor arms'
   fall-through, not from those registrations.
2. **7 rows are compile TIMEOUTS on HEAD** (15–30 s): the 3 F5 isolate rows,
   `ArrayIteratorPrototype/next/detach-typedarray-in-progress.js`,
   `WeakMap`/`WeakSet` `proto-from-ctor-realm.js`, and the two Step-A repro
   probes `p6`/`p7`. They were measured at load 12–18 on a 4-core box shared
   with five other agents' runs; the runner's per-test compile budget is 15 s.
   **Re-measure on a quiet box before treating any of them as a hang.**

Probe tooling: `npx tsx .tmp/probe-one.mts /abs/path/probe.js` (runs one file
through `runTest262File` on the standalone lane, 120 s budget). Repros from
this analysis: `.tmp/es2015/probes5267/p1…p7*.js`, results in
`.tmp/es2015/probes5267/probes-run1.txt`:

- `p1` `map.entries().next()` → null (`.done` read throws) — cluster B.
- `p2` `[1,2][Symbol.iterator]().next()` → null in a Map-bearing module —
  cluster D1. (The #5151 "`assert.sameValue(result.done, …)` → called value
  is not a function" blocker did NOT reproduce at this stage; it can only
  surface once a live carrier exists — see B6.)
- `p3` `class T extends Iterator { next(){throw} get return(){…} }` →
  `new T().chunks(1)` evaluates to **undefined** (then `.next` on undefined);
  `return` getter never read — cluster E root is the `chunks` DISPATCH on a
  class instance, not the stepping.
- `p4` `new Map(customIterable)` → `next` called 0 times, no error (silent
  empty map) — cluster A.
- `p5` `set.entries()` → "called value is not a function" — B1.
- `p6`/`p7` (`new WeakMap([1,1])`, `new Set(customIterable)`): with a 120 s
  budget (`probes-run2.txt`) both compile and FAIL with V8's message text
  thrown from `__module_init` — `Iterator value 1 is not an entry object`
  and `object is not iterable (cannot read property Symbol(Symbol.iterator))`.
  In `p6` that TypeError ESCAPES the source-level `try { … } catch (e)`
  around the `new`, i.e. the construction ran host-side at module init, not
  in the compiled try region. Their 16 s compile "timeouts" in the first
  chain were load artifacts.

### Draft PR #5225 (`origin/claude/es2015-forof-second-pass-draft`) — verdict

Its one commit `465d1045c` is the #5144 wave-1 change-set (892 src lines, 8
files) on a base 714 commits behind main. `git apply --check` of its src
patch against HEAD: **0 of 7 files apply** — every hunk is already on main in
superseded form (`emitAssignObjectPatternFromVec`, `emitDynamicElementSet`,
`notAnObjectThrowInstrs`, `ensureNotAnObjectThrowDeps` all exist on HEAD).
The only draft-added lines absent on HEAD are: a `console.error("DBG drain
elem"…)` (noise), three `emitTdzCheck(ctx, fctx, name, noJsHost(ctx))` calls
(HEAD uses `emitTdzCheckAtGlobal(…, noJsHost(ctx))` at
`src/codegen/expressions/identifiers.ts:844/926`), and the 35-line body of the
draft's rest-object-over-vec pattern (HEAD replaced it with
`emitForOfRestObjectCarrier`, `src/codegen/statements/for-of-rest-object-default.ts`).
**Nothing to re-apply; do not merge it.** Its value was the "Skipped /
follow-ups" list, which is folded into clusters F1–F5 below.

## Out of scope (owned elsewhere) — `.tmp/es2015/forof-cl-X-out-of-scope.txt` (9)

| Rows | Owner | Why |
|---|---|---|
| `Map`/`Set`/`WeakMap`/`WeakSet` `proto-from-ctor-realm.js` (4) | #3371 (Reflect.construct distinct NewTarget), `$262.createRealm` realms | need a foreign-realm `%Map.prototype%` fallback; also `quickjs provider is not built` in this container |
| `Iterator/prototype/{chunks,windows}/get-next-method-only-once.js` (2), `…/exhaustion-does-not-call-return.js` (2) | #680 / #2864 native generator carrier (codex lane) | the `get next()` accessor closes over a `function*` object and calls its `.next()` from a closure — HEAD: `Generator.prototype.next requires that 'this' be a Generator` |
| `for-of/dstr/array-elem-init-in.js` (1) | parser | `[ x = 'x' in {} ]` in a for-of head is rejected by the TS parser (`',' expected`) — #5144 left it alone; not a codegen fix |

Also not touched here by rule: `Reflect.set` receiver (#2046), RegExp
(#5198). No row in the 154 belongs to those.

## Cluster table (HEAD-verified, 154 rows incl. X)

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---|---|---|---|
| A | Collection ctor: general iterable never driven | 25 | `src/codegen/expressions/new-super.ts` Map arm (`:5133`, admits only no-arg / nullish / literal-of-pairs → otherwise falls through and builds an EMPTY map, p4), Set arm (`:5237`, + array-typed var), `tryCompileNativeWeakCollectionNew` (`:4224`, `return undefined` when `!wcHandled`). #5151 Step A2's `emitNativeCollectionCtorIterableDrive` was never written. | `Map/iterator-next-failure.js`, `Map/iterable-calls-set.js`, `WeakMap/iterator-items-are-not-object-close-iterator.js`, `Set/set-iterator-close-after-add-failure.js` |
| A2 | Symbol keys/values reach the adder as their numeric id | 2 | `src/codegen/map-runtime.ts:1424 coerceMapKeyToAnyref` has number/boolean/i64 arms, no `$Symbol` (`ctx.symbolTypeIdx`) arm (#5151 G) | `WeakMap/iterable-with-symbol-keys.js`, `WeakSet/iterable-with-symbol-values.js` |
| B | `keys()/values()/entries()` return an eager `$Vec` snapshot; `.next()` on it is null; Set `entries` unrouted | 17 | `src/codegen/map-runtime.ts:2073 compileNativeCollectionIterator` → `:2094 emitCollectionIteratorVec`; `src/codegen/set-runtime.ts:158` routes only `keys`/`values` (p5). The live stepper already exists: `fillMapSetDynDispatchArms` (`map-runtime.ts:2605-2760`) builds `$__IterRec{ITER_KIND_MAPSET}` over `__map_iter_new` and steps it via `__map_iter_next` — but only for `__iterator($Map)`, never for the method-call sites. | `Map/prototype/entries/returns-iterator.js`, `Set/prototype/values/values-iteration-mutable.js`, `Map/prototype/delete/does-not-break-iterators.js`, `MapIteratorPrototype/next/iteration.js` |
| C1 | `%{Array,Map,Set}IteratorPrototype%.next` not an own property / no brand check | 17 | `src/codegen/array-object-proto.ts:3384 emitIteratorPrototypeSingleton`: only `kind === "String"` (`:3441`) seeds an own `next` closure, and that one is a REFUSAL body (`refusalBodyFallback`). | `ArrayIteratorPrototype/next/property-descriptor.js`, `MapIteratorPrototype/next/name.js`, `SetIteratorPrototype/next/this-not-object-throw-values.js`, `MapIteratorPrototype/next/does-not-have-mapiterator-internal-slots.js` |
| C2 | No `%IteratorPrototype%` root: singletons' `$Object.proto` is null; no `[Symbol.iterator]`, `chunks`/`windows`/`join` seeds on it | 10 | same function: `NativeIteratorPrototypeKind` (`:3374`) has no root kind; `$Object` field `proto` (`src/codegen/object-runtime.ts:1118`) never set; the runner's `Iterator` shim (`tests/test262-runner.ts:2294-2300`) resolves `Iterator.prototype` from that chain. | `Iterator/prototype/Symbol.iterator/return-val.js`, `…/prop-desc.js`, `chunks/result-is-iterator.js`, `chunks/non-constructible.js`, `join/not-a-constructor.js` |
| D1 | `x[Symbol.iterator]()` on arrays/TypedArrays/strings yields a snapshot vec or nothing | 13 | `src/codegen/expressions/call-tail-dispatch.ts:763-772` routes array receivers to `compileArrayMethodCall(…, "values")` (a cursor-less `$Vec`, the #5147 note at `:764`); TA/string receivers are not admitted at all. | `ArrayIteratorPrototype/next/iteration.js`, `…/Float32Array.js` (9 TA rows), `StringIteratorPrototype/next/next-iteration.js` |
| D2 | `arguments[Symbol.iterator]()` → "called value is not a function" | 8 | same arm: `resolveArrayInfo` is false for `IArguments`; the arguments object is the vec `getOrRegisterVecType(ctx, "arguments")` (`src/codegen/closures.ts:2942`) | `ArrayIteratorPrototype/next/args-mapped-iteration.js`, `…/args-unmapped-expansion-before-exhaustion.js` |
| D3 | `typedArray.keys()` + `$DETACHBUFFER` mid-loop | 1 | baseline leaked `env::Uint8ClampedArray_keys` (TA `.keys()` not routed to `compileArrayIteratorMethod`, `src/codegen/array-methods.ts:2941`); HEAD: compile timeout (load) | `ArrayIteratorPrototype/next/detach-typedarray-in-progress.js` |
| E | `chunks`/`windows` protocol tail on `class X extends Iterator` sources | 18 | (p3) `.chunks(n)` on a user-class instance is NOT dispatched to the lazy helper — the class-typed receiver path (`src/codegen/expressions/call-receiver-method.ts:3972`, `src/codegen/closed-method-dispatch.ts:399`) yields undefined; then `__iter_hof_open` (`src/codegen/iter-hof-native.ts:640-660`) only admits ladder carriers, no GetIteratorDirect (`next` read once, `return` never read at open / on next-abrupt). | `chunks/next-method-throws.js`, `windows/get-next-method-throws.js`, `chunks/return-is-forwarded-to-underlying-iterator.js`, `chunks/next-method-returns-throwing-value-done.js` |
| F1 | for-of statement drive: next()-throw closes; `next` re-read per step; non-object result not rejected; +2 singles | 6 | `src/codegen/statements/loops.ts:2925 compileForOfIterator` — the #1347 `try/catch_all` wraps the `call __iterator_next` too; `src/codegen/iterator-native.ts:3028` OBJ step re-reads `next` every step; `:2946+` degrades a non-Object result to done | `for-of/iterator-next-error.js`, `for-of/iterator-next-reference.js`, `for-of/iterator-next-result-type.js`, `for-of/throw-from-finally.js`, `for-of/array-key-get-error.js` |
| F2 | Assignment-pattern head drive is eager (`__array_from_iter_n(-1)` up front): no per-element lref/close order, holes, symbol elision, computed keys | 12 | `src/codegen/statements/for-of-destructuring.ts:2239 compileForOfAssignDestructuringExternref` (materialization at `:2254`); `:2567 compileForOfIteratorAssignDestructuring` (object patterns) | `dstr/array-elem-iter-thrw-close.js`, `dstr/array-rest-lref-err.js`, `dstr/array-elem-init-assignment.js`, `dstr/array-elision-val-symbol.js`, `dstr/obj-prop-name-evaluation-error.js` |
| F3 | NamedEvaluation of anonymous `class` in a destructuring default | 3 | `src/codegen/function-instance-meta.ts:318-380` handles fn/arrow only; `.name` on a class value folds statically (#5144 F residue) | `dstr/array-elem-init-fn-name-class.js`, `dstr/obj-id-init-fn-name-class.js` |
| F4 | `x[0] === first[0]` false for equal numbers in `for (x of map)` | 3 | pair element (from the `$ObjVec` `[k,v]` packing) vs heterogeneous-literal element compared as two externrefs under different boxings (#5144 "Map residue"); re-measure after B4 | `for-of/map.js`, `for-of/map-expand.js` |
| F5 | `delete Array.prototype[Symbol.iterator]` then head destructuring must throw | 3 | HEAD: compile timeout (15–21 s under load; baseline "no exception"). `arrayProtoIteratorDeleteKey` exists (`src/codegen/array-proto-iterator-override-ast.ts:47`) — find its consumer; #5144 A residue | `dstr/{let,const,var}-ary-init-iter-get-err-array-prototype.js` (isolate!) |
| G | Collection reflection residue | 7 | #5151 C4/D/F/G exactly as planned there: `@@iterator` own property on Map/Set proto pages, `@@species` read/write, `size` gOPD via a variable receiver, mixed-union `map.get` lane | `Map/prototype/Symbol.iterator.js`, `Map/Symbol.species/symbol-species.js`, `Set/prototype/size/size.js`, `Map/prototype/set/append-new-values.js` |
| X | out of scope (table above) | 9 | | |

## Implementation Plan

Ordered by yield and dependency; each step independently shippable. After each
step re-run its list(s) with
`npx tsx scripts/run-test262-paths.mts .tmp/es2015/forof-cl-<X>.txt --standalone`
and the controls list. Type queries go through `ctx.oracle` (oracle-ratchet
gate); every instruction template minted FRESH per arm (#2169b — a shared
`Instr[]` aliased into two branches is remapped twice by DCE, and the #1058
stack-balance repair fails the whole compile); reserve-then-fill funcIdx
discipline (#1719/#2043) for anything filled at finalize.

### Step A — constructor iterable drive (A 25 + A2 2) — `forof-cl-A-ctor-iterable-drive.txt`, `forof-cl-A2-symbol-keys.txt`

**A-0 (measured 2026-09-01 — the leaks are NOT gone).**
`npx tsx .tmp/es2015/probes5267/imports-of.mts .tmp/es2015/probes5267/p7-min.js`
(compiles through `compile(src, { target: "standalone" })` exactly like the
runner and prints `WebAssembly.Module.imports`) on
`new Set(customIterable); new WeakMap([1, 1])` gives
`["function:env::Set_new", "function:env::WeakMap_new"]`, and
`result.imports` lists both with `intent.type === "extern_class"`. So HEAD
still emits the host constructors for every non-literal argument shape; the
runner merely stopped CLASSIFYING them as `host_import_leak` (it instantiated
the module against the host `env`, whose real `Set`/`WeakMap` threw V8's
TypeErrors at `__module_init`). That runner discrepancy
(`standaloneHostImportError`, `tests/test262-runner.ts:3700`, called at
`:4944`) is a separate finding to file — do not fix it here, and do not rely
on the runner to catch a leak in this cluster: **re-run `imports-of.mts` on
the three rows named in the acceptance criteria after Step A and require `[]`.**
(The CLI `npx tsx src/cli.ts <file> --standalone` crashes inside the TS
checker on these probe files in this container — use `imports-of.mts`.)

**A-1. One shared drive, three call sites.** Add
`emitNativeCollectionCtorIterableDrive(ctx, fctx, collTmp, iterableExpr, kind: "Map"|"Set"|"WeakMap"|"WeakSet")`
in `src/codegen/map-runtime.ts` (next to `emitCollectionIteratorVec`). Call it
from the Map arm (`new-super.ts:5133`) when `args.length >= 1 && !nullishArg && !seedablePairs`,
from the Set arm (`:5237`) when neither `arrArg`, `nonLiteralArrArg` nor
`nullishArg` matched, and from `tryCompileNativeWeakCollectionNew` (`:4224`)
in place of `if (!wcHandled) return undefined;` for the 1-arg case. Keep every
existing literal / array-typed fast path exactly as is (they are the unpatched
branch); extra arguments beyond the first: evaluate + drop (spec ignores them).

Spec order (§24.1.1.1 / §24.2.1.1 / §24.3.1.1 / §24.4.1.1 steps 5–9), emitted
in this order:

1. `i32.const COLLECTION_KIND.<kind>; call __map_new` → `collTmp` (the
   existing prologue; `ensureMapHelpers` / `ensureSetHelpers` /
   `ensureWeakCollectionHelpers` as the arms already do).
2. Compile the argument to externref. **Runtime** nullish test (the static
   `nullishArg` only covers literals — `var it; new Map(it)` must also be
   empty): `ref.is_null` OR equals the undefined singleton
   (`undefinedExternInstrs`, `src/codegen/any-helpers.ts:138`) → skip to 8.
3. `emitCollectionAdderGuard(ctx, fctx, collTmp, "set"|"add")`
   (`new-super.ts:4140`) — Get(adder) + IsCallable BEFORE the iterable is
   touched; then `prepareNativeSetAdderDispatch(ctx, fctx, collTmp, adderName)`
   (`:4058`) so a user-patched `Map.prototype.set` observes every entry with
   the collection as `this` (`iterable-calls-set.js`: `results.push([k,v])`,
   `_this.push(this)`).
4. GetIterator: `ensureNativeIteratorRuntime(ctx)`
   (`src/codegen/iterator-native.ts:460`) then `call __iterator` (funcMap) on
   the externref → iterator record. A non-iterable (`{[Symbol.iterator]: undefined}`,
   a number) must throw the #3388 TypeError here (`Map/iterator-is-undefined-throws.js`);
   verify the OBJ arm (`buildIteratorBody`, `iterator-native.ts:2288`, the
   #3146 falsy-`@@iterator`-with-truthy-`next` admission at `:2508`) throws
   rather than returning an empty record for that shape.
5. Loop: `call __iterator_next(rec)` → `(i32 done, externref value)`
   (multi-value; pop value then done — see `loops.ts:3194-3200`). `done` →
   break. An abrupt `next()` / `value` getter propagates WITHOUT
   IteratorClose (`iterator-next-failure`, `iterator-value-failure` expect no
   `return()` call) — so the `try/catch_all` region of step 6–7 must NOT
   enclose this call (same split as Step F1-a).
6. Pairs (Map/WeakMap): `value` must be an Object — `any.convert_extern` +
   `ref.test $Object` or a vec-family carrier (`[k,v]` array literal items
   lower to vecs; the #3100 normalize arms in `iterator-native.ts:1278-1370`
   show the vec-family test list). Primitive → IteratorClose then TypeError
   (`iterator-items-are-not-object-close-iterator.js` counts `return()` once
   per throw) via `buildThrowJsErrorInstrs(ctx, "TypeError", …)`
   (`src/codegen/js-errors.ts:71`) — mirror `notAnObjectThrowInstrs`
   (`iterator-native.ts:2167`). Then `k = __extern_get_idx(value, 0)`,
   `v = __extern_get_idx(value, 1)` (the carrier-aware standalone reader used
   at `for-of-destructuring.ts:2270`; for a plain `$Object` with `"0"`/`"1"`
   keys use `__extern_get` + `nativeStringLiteralInstrs` keys — branch on
   `ref.test $Object`). A throwing `get 0()` / `get 1()`
   (`iterator-item-{first,second}-entry-returns-abrupt.js`) → IteratorClose +
   rethrow.
7. Call(adder, coll, «k, v» | «v»): `adderDispatch.modeLocal ? emitNativeSetAdderCall(dispatch, collTmp, kLocal, vLocal) : call __map_set | __set_add | __weakset_add`
   (`new-super.ts:4190`; helper names in `map-runtime.ts` / `set-runtime.ts` /
   `weak-collections-runtime.ts:53-71`); key/value through
   `coerceMapKeyToAnyref` (`map-runtime.ts:1424`). Adder abrupt →
   IteratorClose (its own abrupt SUPPRESSED — `iterator-close-failure-after-set-failure.js`:
   the adder's Test262Error wins) then rethrow. Weak kinds: a key that cannot
   be held weakly (number/string/boolean/null/undefined/registered symbol —
   `WeakMap/iterator-items-keys-cannot-be-held-weakly.js`) must be a TypeError
   from the adder path (`weak-collections-runtime.ts:178-200` routes keys
   through `compileCollectionElementArg`; check the runtime `__weakset_add` /
   `__map_set`-with-weak-brand for the CanBeHeldWeakly test — #4785 — and add
   it in the drive if absent: `ref.test $Object`/struct/`$Symbol`, else
   TypeError + IteratorClose).
8. Leave `collTmp` on the stack; return `{ kind: "ref", typeIdx: ctx.mapTypeIdx }`.

Wasm shape: `block $done  loop $step  <next> (br_if $done done) try <6-7> catch_all <IteratorClose ignoring its own throw> rethrow end  br $step end end`.
The close-then-rethrow pattern exists at `loops.ts:3133-3160` (the iterator-close
finallyStack entry) and the #1347 wrapper further down — copy the shape, not the
array (fresh Instr objects).

**A-2 symbol keys (2).** Add a `$Symbol` arm to `coerceMapKeyToAnyref`
(`map-runtime.ts:1424`): `ref.test ctx.symbolTypeIdx` → pass the ref through
as anyref (no boxing); confirm `__map_set`'s hash arm gives struct refs an
identity hash so two distinct `Symbol('a description')` values stay distinct
(`iterable-with-symbol-values.js` adds two same-description symbols).

Edge cases: `new Map(iterable)` where `iterable` is an ARRAY variable of
pairs (`iterable-calls-set.js`) reaches the drive with a typed vec — the
ladder's vec-family arms normalize it, so no special case; `new Set(x)` with
an array-typed `x` keeps the `seedNativeSetFromArrayArg` fast path
(`new-super.ts:3938`) but must still call `emitCollectionAdderGuard` first
(it does). A Set/WeakSet drive skips step 6's object test (flat values).

### Step B — live `keys()/values()/entries()` records (B 17; unblocks half of C1) — `forof-cl-B-live-collection-iterators.txt`

**B-1.** `src/codegen/set-runtime.ts:158`: route `entries` too (the comment
defers it) — `compileNativeCollectionIterator(…, "entries", true)`.

**B-2.** In `compileNativeCollectionIterator` (`map-runtime.ts:2073`) — the
CALL-expression entry used by `tryCompileNativeMapMethodCall` (`:1615`) and
`set-runtime.ts:158` — emit a LIVE record instead of the vec:
`i32.const ITER_KIND_MAPSET; ref.null $vecExtern; i32.const 0; <recv as ref $Map>; i32.const <0 keys | 1 values | 2 entries>; call __map_iter_new; extern.convert_any; struct.new $__IterRec; extern.convert_any`
— exactly the template `fillMapSetDynDispatchArms` emits for `__iterator($Map)`
(`map-runtime.ts:2666-2700`); extract it into a factory
`mapSetIterRecInstrs(ctx, kindOperand: Instr[])` shared by both sites (fresh
objects per call). `ensureNativeIteratorRuntime(ctx)` first so
`ctx.structMap.get("__IterRec")` resolves. Return `{ kind: "externref" }`.
Keep `emitCollectionIteratorVec` for the bare for-of head
(`compileForOfNativeCollection`, `loops.ts:1071`) — it consumes the vec.

**B-3.** Entries pairs: `__map_iter_next` (`map-runtime.ts:1113-1240`) returns
only the value for kind 2 ("packing deferred", `:1115`). Add the pair packing
in the MAPSET twin of `__iterator_next` (`:2703-2760`, which has the
`$MapIterResult` local): when `it.kind == 2`, build a fresh `$ObjVec [key, value]`
via `ensureObjVecBuilders` (`src/codegen/object-runtime.ts:6967`) exactly as
`emitCollectionIteratorVec` does at `:2205-2225`; Set entries → `[v, v]`.
`__map_iter_next` must expose the key for that (add a key-carrying result or a
second stepper `__map_iter_next_kv`) — `$MapIterResult` is a CLOSED struct
that is never source-visible, so widening it is safe. Mutation rows
(`delete/does-not-break-iterators`, `clear/map-data-list-is-preserved`,
`*-iteration-mutable`) fall out of the tombstone-skipping index walk already in
`__map_iter_next`.

**B-4.** `for (x of map.entries())`: after B-2 the tentative-array probe in
`compileForOfStatement` (`loops.ts:1036-1049`, via `arrayIteratorReceiverForForOf`)
no longer sees a vec and the statement falls to `compileForOfIterator`, whose
`__iterator` has the #5147 identity arm for an `$__IterRec` subject → MAPSET
step. That is correct and LIVE. If the controls show a for-of regression,
detect a collection receiver in `arrayIteratorReceiverForForOf` and call
`emitCollectionIteratorVec` directly for the loop head instead.

**B-5.** `.next()` routing needs no new arm: a `MapIterator`-typed receiver goes
through `call-receiver-method.ts:987` → `reserveAnyIterNext`
(`iterator-native.ts:782`) → `fillAnyIterNext` (filled in `index.ts:5929-5933`)
which `ref.test`s `$__IterRec` → `__iter_next_result` (`:697`) → the MAPSET
twin → `__iter_result_obj` (`:645`, a real `$Object {value, done}`). Untyped
receivers hit the `closed-method-dispatch.ts:1022-1050` arm. Verify with `p1`.

**B-6.** Only if the #5151 blocker reappears (`assert.sameValue(result.done, …)`
→ "called value is not a function" with a property read as the ARGUMENT):
the suspect is the IteratorResult fast path at
`src/codegen/property-access-dispatch.ts:3645` routing `.value`/`.done` to
`__gen_result_value/done` when those exist in funcMap — add a
`ref.test $Object → __extern_get` arm to those bodies or decline the fast path
for non-generator results (#5147 Step 0 wording). Repro: `p1` with the read
inlined vs hoisted into a variable.

### Step C — iterator-prototype singletons: own `next` + `%IteratorPrototype%` root (C1 17 + C2 10) — `forof-cl-C1-proto-own-next.txt`, `forof-cl-C2-iterator-prototype-root.txt`

All in `emitIteratorPrototypeSingleton` (`src/codegen/array-object-proto.ts:3384`)
plus glue registrations.

**C-a root.** Extend `NativeIteratorPrototypeKind` (`:3374`) with `"Iterator"`
(global `__native_iterator_iterator_prototype`, same lazy-init `if
(ref.is_null global) { … }` shape). Seed its own `[Symbol.iterator]` with the
`__box_symbol(1)` + `__defineProperty_value` recipe the function already uses
for `@@toStringTag` (`:3420-3432`; id 1 = `@@iterator` per
`iterator-native.ts:2508`, id 4 = `@@toStringTag`), descriptor bits
`0x01|0x04` (writable, non-enumerable, configurable — `prop-desc.js`). Value:
a native closure whose body is `local.get this; return` — register it on the
Iterator brand glue (`ensureIteratorNativeProtoGlue`, `:2390`, members list
`ITERATOR_PROTO_METHODS` `:361`) as member `"@@1"` so
`nativeProtoMemberDisplayName` (`src/codegen/native-proto.ts:800`) names it
`[Symbol.iterator]` (`name.js`) with length 0 (`length.js`), minted through
`ensureStandaloneNativeMethodClosure(ctx, brand, "@@1", "method")` (`:826`).
`return-val.js` calls it with primitives / `undefined` / `null` as `this` —
the body must not brand-check.

**C-b chain.** In each kind's init, after `__new_plain_object`, set the
`$Object.proto` field (`object-runtime.ts:1118`, mutable) to the root object
(`any.convert_extern; ref.cast $Object; struct.set`). Verify the dynamic
`Object.getPrototypeOf(<$Object>)` path (`__getPrototypeOf`,
`object-runtime.ts:11963`) reads that field — the outer call in
`getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))` is dynamic; the inner
one is the static `ArrayIterator` route (`call-builtin-static.ts:2252`).
Seed `chunks`/`windows`/`join` on the root as own function properties
(#5147 A-4): `chunks`/`windows` bodies delegate to `__iter_lazy_chunks` /
`__iter_lazy_windows` (`src/codegen/iter-lazy-native.ts:1161`, ABI
`(externref recv, externref arg, externref arg2, i32 arg2Supplied) -> externref`);
`join` may keep `refusalBodyFallback` (only `isConstructor` + `new` TypeError
are asserted). `non-constructible.js` / `not-a-constructor.js`: `new iter.chunks(1)`
and `Reflect.construct`-probing must see the closure as a non-constructor —
check the construct arm in `tryEmitInlineDynamicCall`
(`src/codegen/expressions/calls.ts`, the #5188 "Constructor cannot be invoked
without 'new'" site) for `__fn_wrap` closures. `result-is-iterator.js`:
`x.chunks(1) instanceof Iterator` walks the LHS prototype chain — the
`$LazyIterHelper` / `$__IterRec` carriers have no proto link; give the native
instanceof (`src/codegen/native-dynamic-instanceof.ts`, `__instanceof_check`)
an arm mapping those carriers to (kind singleton → root).

**C-c own `next` on Array/Map/Set (17).** Replicate the `kind === "String"`
branch (`:3441-3456`) for the three kinds, but with a BEHAVIORAL body: register
per-kind glues `makeGlue(ctx, brand, "ArrayIterator"|"MapIterator"|"SetIterator", ["next"])`
(`:2088`; brands via `getBuiltinBrand`) whose `emitMemberBody`
(`native-proto.ts:219-224` — `this` is closure param 1 as externref) emits:
`local.get 1; any.convert_extern; ref.test $__IterRec` and a kind test
(`struct.get kind == ITER_KIND_VEC (3)` for Array; `== ITER_KIND_MAPSET (9)`
AND the `$MapIter`'s `$Map.M_KIND` (0 map / 1 set) for Map vs Set — the
cross-kind rows `does-not-have-mapiterator-internal-slots*.js` throw in both
directions) → `local.get 1; call __iter_next_result` ; else the catchable
TypeError (`emitBrandCheckTypeError` as in `emitCollectionSizeGetterBody`,
`:1788`). Descriptor bits `0x01|0x04` as the String branch. That gives
`name`/`length`/`property-descriptor` (7 rows — the #5099 metadata machinery
already emits `name: "next"`, `length: 0`), the 8 `this-not-object-throw-*`
rows (primitive `this` → TypeError; final `iterator.next.call(map[Symbol.iterator]())`
must SUCCEED — hence behavioral), and the 2 internal-slot rows. Map/Set rows
need Step B's live records (a `$Vec` receiver is not an `$__IterRec`).

### Step D — real records from `[Symbol.iterator]()` (D1 13 + D2 8; D3 1 stretch) — `forof-cl-D1-symbol-iterator-carrier.txt`, `forof-cl-D2-arguments-iterator.txt`, `forof-cl-D3-ta-keys-detach.txt`

**D-1 carrier.** `call-tail-dispatch.ts:763-772`: replace the
`compileArrayMethodCall(…, "values")` snapshot with GetIterator: compile the
receiver → externref → `call __iterator` (native ladder; the VEC arm wraps the
canonical externref vec the #3100 normalize arms build) → `$__IterRec{VEC}`.
Admit, in the same arm: array receivers (`resolveArrayInfo`), TypedArray
receivers (the 9 TA rows — check the ladder's vec-family arms admit TA storage
vecs; `NON_ARRAY_BYTE_VEC_ELEM_KINDS` in `object-runtime.ts` deliberately
filters byte carriers from `__extern_slice`, so add a `$__ta_view`/TA-vec arm
that boxes per element), `$AnyString` receivers (`ensureStrToCharVecHelper`,
`src/codegen/native-strings.ts:1459`, exactly as `__extern_slice`'s
`$AnyString` arm at `iterator-native.ts:1314-1370` — per-code-point, so
`next-iteration-surrogate-pairs.js` pairs stay paired), and the `arguments` vec
(D-2). The static result type stays the checker's `ArrayIterator` /
`StringIterator`, so the `Object.getPrototypeOf` routing
(`call-builtin-static.ts:2252/2264/2281`) and C1's metadata rows are unaffected.
This is the migration #5147 measured and reverted ("broke
`array[Symbol.iterator]().next()` for a variable receiver") — that `.next()`
now resolves through `__any_iter_next` (B-5), so re-measure rather than
re-revert; the controls list carries the rows it once broke.

**D-1b live stepping (`iteration-mutable.js`, and D-2's expansion/truncation
rows).** Add `ITER_KIND_LIVEVEC = 8` — the spare kind `map-runtime.ts:2601-2604`
reserves for `iterator-native.ts` — holding the SOURCE `$Vec` struct in
`userIter` (externref of the typed vec) and re-reading its `length` each step,
boxing each element with `boxVecElementToExternref` (`object-runtime.ts`, the
#2190 recipe). Emit it from the D-1 arm only when the receiver's compiled
ValType is a known vec type (typed arrays of number/string/externref); the
step arm goes in `buildIteratorNextBody` beside the VEC step
(`iterator-native.ts:2900-2915`). Exhausted stays exhausted (`push` after
`done:true` must not revive — keep a `done` bit in `idx` = -1).

**D-2 arguments (8).** The receiver's compiled type is the vec
`getOrRegisterVecType(ctx, "arguments")` (`closures.ts:2942`; declarations via
the #849 path) with TS type `IArguments`. Admit it in D-1's arm by comparing
the compiled `typeIdx` (not the checker type) and route through the same
GetIterator. `iteration` ×2 + `expansion-after-exhaustion` ×2 pass with a
snapshot record; `expansion/truncation-before-exhaustion` ×4 need D-1b's live
arm over the arguments vec (mapped aliasing: the test writes through the
PARAMETER after grabbing the iterator — the mapped-arguments reverse sync
(`src/codegen/mapped-arguments-formal-widening.ts`) must have written the vec
before the next `next()`; measure).

**D-3 (1, stretch).** Route TA `keys()/values()/entries()` to
`compileNativeArrayIterator` (`array-methods.ts:2941-2957`) over the view; the
mid-loop `$DETACHBUFFER` TypeError needs D-1b's live arm plus the
`__detached__` sidecar check the DataView path uses (#1515). Re-measure the
compile timeout on a quiet box first.

### Step F — for-of protocol (F1 6 + F2 12 + F5 3; F3 3, F4 3) — `forof-cl-F1…F5-*.txt`

**F1-a next()-abrupt must not close (2).** `compileForOfIterator`
(`loops.ts:2925`; the loop body from `:3181`): the #1347 `try … catch_all`
encloses `call __iterator_next` (`:3194`). Add an i32 local
`__forof_closeable` = 0 before the `next` call, = 1 after the done-check /
element bind, and gate the catch_all's `call __iterator_return`
(`:3133-3160` finallyStack entry + the wrapper) on it. §14.7.5.7: `IteratorStep`
/ `IteratorValue` abrupt → return WITHOUT close; body / binding abrupt →
IteratorClose. Apply the same gate in `compileForOfDirectIterator` (`:2514`)
if it carries its own wrapper, and in F2's drive.

**F1-b `next` read once (1).** Add a 5th field `nextMethod (mut externref)` to
`$__IterRec` (`iterator-native.ts:401-418`). The OBJ arm of `buildIteratorBody`
already reads `next` for the #3146 admission (`:2508`) — store it; the OBJ step
in `buildIteratorNextBody` (`:3020-3040`) then uses `rec.nextMethod` instead of
`__extern_get(rec.userIter, "next")`. USER (closed-struct) records keep
`ref.null.extern` and their `__call_next` dispatcher. Every `struct.new $__IterRec`
site — 11 in `iterator-native.ts` + `map-runtime.ts`
(`grep -rn 'struct.new", typeIdx: iterRecTypeIdx'`, plus the `types.iterRecTypeIdx`
spellings) — pushes one more `ref.null.extern` operand; field arity is
load-bearing (`:83-84`). Step E reuses this field for GetIteratorDirect.

**F1-c §7.4.2 non-Object result (1).** In the OBJ step, after
`__apply_closure(next, …)`: a result that is neither `$Object` nor a closed
struct with `__sget_done` currently degrades to `done := 1` (`:2946+`, the
#4447 note). Under `ctx.standalone`, throw TypeError instead via
`notAnObjectThrowInstrs(ctx, scratch)` (`:2167`; deps
`ensureNotAnObjectThrowDeps` `:2212`). #5144 flagged a collision with the
"`next` missing/uncallable ⇒ done" degrade — keep THAT degrade only for a
null `next` (the ladder-internal carriers), throw for a non-Object result of
a real call. Run the equivalence gate after; it is the consumer of the
degrade.

**F1-d `throw-from-finally.js` (1).** `i` is incremented twice: the `finally`
body (`i++; throw error`) is inlined again at its own inner `throw`
(finallyStack push/pop in `src/codegen/statements/exceptions.ts:440-470`,
`cloneFinallyAtDepth`) on top of the for-of iterator-close entry
(`loops.ts:3133-3160`). A `throw` INSIDE a finally block must not re-inline
that finally. Repro without a generator source first (`[1]` as the iterable);
if it only reproduces with the `function*` source it belongs to X (#680/#2864).

**F1-e `array-key-get-error.js` (1, stretch).** An accessor installed on index
`0` of a vec-backed array (`Object.defineProperty(array, '0', {get})`) is
invisible to the array fast path (`compileForOfArray`, `loops.ts:1834` reads
`vec.data[i]`). Check whether the vec overlay (`src/codegen/vec-overlay.ts`,
#4491) records accessors; if so, send arrays with an active overlay through
`compileForOfIterator`. Otherwise leave it un-root-caused in the PR body.

**F2 interleaved assignment-pattern drive (12).**
`compileForOfAssignDestructuringExternref` (`for-of-destructuring.ts:2239`)
materializes the whole source with `__array_from_iter_n(src, -1)` (`:2254`)
before any target is evaluated, so `nextCount`/`returnCount` are wrong and no
IteratorClose fires on a target/initializer abrupt. Rewrite as §13.15.5.5
IteratorDestructuringAssignmentEvaluation, per element:
1. target not a pattern → evaluate **lref first** (member target: object +
   key expressions; `[ {}[thrower()] ]` throws HERE, before any `next()`);
2. if `!done`: `call __iterator_next` → abrupt ⇒ `done = true`, rethrow
   WITHOUT close (F1-a's flag);
3. `value = done ? undefined : value`;
4. initializer when `value === undefined` (NamedEvaluation — F3);
5. PutValue / recurse for a nested pattern.
Abrupt at 1, 4, 5 with `!done` → `call __iterator_return` (its own abrupt
suppressed — the `*-close-err.js` rows: §7.4.9 the throw completion wins),
then rethrow. Elision → step 2 only. Rest `[...t]` → lref first
(`array-rest-lref-err.js`: nextCount 0, returnCount 1), then drain with
repeated `next()` into a fresh `$Vec`. After the pattern, `!done` →
IteratorClose (normal completion; the #5144 C "close result must be an Object"
check stays). **Reuse, don't triplicate:** the binding form's per-element
drive in `destructureParamArray` (`src/codegen/destructuring-params.ts:1677`,
its `__iterator_next` stepping at `:1966` — correct since #4447 slice 2) is the
model; factor its step / close emitters into helpers that take an
"emit target write" callback and use them from both forms.
- `array-elem-init-assignment.js`: the hole in `[2, null, , undefined]` is the
  #2001 S1 hole sentinel (`emitHoleSentinel`, `src/codegen/array-holes.ts`;
  `f64HoleTestInstrs` in `vec-f64-hole-presence.ts` for f64 vecs) — map hole
  → undefined BEFORE the default test (only OOB/exhausted was fixed by #5144 U).
- `array-elision-val-symbol.js`: elision-only patterns must still run
  GetIterator on the element — `for ([,] of [Symbol()])` → the ladder's #3388
  TypeError; today they skip it (only the empty pattern does, via
  `emitEmptyForOfArrayPatternRequirement`, `:257`).
- `obj-prop-name-evaluation-error.js`: `compileForOfIteratorAssignDestructuring`
  (`:2567`) must evaluate a computed key `[a.b]` (ToPropertyKey) unconditionally
  before the Get, even when it cannot resolve the key statically.

**F5 `delete Array.prototype[Symbol.iterator]` (3, `--isolate` only).** HEAD
compile-timeouts (15–21 s at load 15): profile first (`node --cpu-prof`
around `runTest262File`) — `arrayProtoIteratorDeleteKey`
(`array-proto-iterator-override-ast.ts:47`) exists; find its consumer and why
the head-destructuring override scan goes superlinear. Semantics: after the
delete, `for (let [x] of [[]])` must throw TypeError at GetIterator on the
inner `[]` (the head ELEMENT) — model "array `@@iterator` deleted" in the
read-drive that `sourceOverridesArrayIterator`-style detection feeds
(`statements/destructuring.ts`, #5144 A).

**F3 NamedEvaluation for `class` (3).** Extend the fn/arrow NamedEvaluation at
`function-instance-meta.ts:318-380` (and the binding-default path,
`statements/destructuring.ts:987`) to `ts.isClassExpression(init) && !init.name`:
the class gets the binding name as its OWN `name` data property
`{writable:false, enumerable:false, configurable:true}` (`CLASS_CONSTRUCTOR_OWN_KEYS`,
`src/codegen/class-static-metadata.ts:14`, already lists `name`); `class x {}`
keeps `"x"`; a `static name(){}` keeps the method. Also stop the static fold
of `xCls.name` to the binding text when the DECLARATION has no initializer
(#5144 F) — the `.name` read on a class value must read the runtime property.

**F4 pair equality (3).** Re-measure AFTER B-4 (the `for (x of map)` pair now
comes from the MAPSET stepper's packing). If still failing: `x[0]` (externref
out of the `$ObjVec` pair) `===` `first[0]` (element of the heterogeneous
literal `[0,'a']`) — strict equality of two externrefs must unbox boxed
numbers on both sides (`__extern_strict_eq`, used from
`closed-method-dispatch.ts` / `array-methods.ts`; the `===` externref arm in
`src/codegen/binary-ops.ts` / `binary-ops-typed-dispatch.ts`, which #4447
touched). Probe: `var a=[0,'a']; a[0] === [0,'a'][0]` inside vs outside the loop.

### Step E — `chunks`/`windows` on `class X extends Iterator` (18) — `forof-cl-E-lazy-protocol-tail.txt`

`Iterator` is the runner's shim `function Iterator(){}` with
`Iterator.prototype = getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))`
(`tests/test262-runner.ts:2294-2300`) — i.e. the Step C root. Two defects, in
order:

**E-1 dispatch (p3).** `new T().chunks(1)` on a user-class instance evaluates
to undefined: the class-typed receiver path never consults the lazy-helper
dispatch (`call-receiver-method.ts:3972` / `closed-method-dispatch.ts:399`,
`isLazyIterForm` in `iter-lazy-native.ts:103`). Make a receiver whose class
has no own/inherited `chunks`/`windows` method and whose ancestor chain ends
in a plain function value fall through to the lazy dispatch (the same
`isLazyIterForm(name, arity)` gate) — statically when the class body is
visible (`ctx.classBuiltinParentMap`, `class-bodies.ts:1015-1035`, records
builtin parents only; a non-builtin parent function needs a "no such method
on the closed struct" static check), dynamically via the Step C-b root seeds
(`__protoidx_get_r` consult on the root `$Object`). `windows(1)` argument
validation (already implemented) must run BEFORE GetIteratorDirect
(`get-next-method-throws.js` expects the `next` getter's Test262Error, so
validation must not throw first for a valid size).

**E-2 GetIteratorDirect in `__iter_hof_open`** (`iter-hof-native.ts:640-660`):
for the lazy ctors (`iter-lazy-native.ts:1161` "GetIteratorDirect, AFTER
validation") a closed-struct receiver must be admitted as ITS OWN iterator:
read `next` ONCE — method via the `__call_next` dispatcher reference, accessor
via the `__sget_next` getter dispatcher (`get next()` must RUN here:
`get-next-method-throws.js`) — and store it in the record's `nextMethod`
(F1-b), kind OBJ/USER; never read `return` at open. `__iter_hof_next` then
calls the cached `next`. Abrupt `next()` / `done` getter → propagate, NO
IteratorClose (`next-method-throws.js`, `next-method-returns-throwing-done.js`
— the TypeError we currently see would be the `get return(){throw TypeError}`
accessor firing, so any `return` read on that path is a bug); `done: true`
→ do NOT read `value` (`next-method-returns-throwing-value-done.js`).

**E-3 `.return()` on the wrapper.** Source-level `iterator.return()` on a
`$LazyIterHelper` reaches `call-receiver-method.ts:3700` (`methodName === "return"`
→ `__gen_return`) — add a `ref.test $LazyIterHelper` arm → `__lazy_iter_close`
(`iter-lazy-native.ts:956-985`) + `__iter_result_obj(1, undefined)`.
`__lazy_iter_close`: forward IteratorClose to `src` exactly once — null `src`
after closing (`return-is-forwarded-to-underlying-iterator.js`: second call is
a no-op) and skip the forward once the source is exhausted (flags bit 0;
`return-is-not-forwarded-after-exhaustion.js`). The underlying `return` Get
abrupt (`get return(){throw}` — `get-return-method-throws.js`) and a throwing
`return()` (`iterator-return-method-throws.js`) must propagate:
`__iterator_return`'s OBJ arm (`iterator-native.ts:2012-2030`) reads via
`__extern_get`; the closed-struct arm via `__sget_return` — make sure an
ACCESSOR `return` is invoked, not read as a data field.

The 4 generator-inside-accessor rows stay in X.

### Step G — collection reflection residue (7) — `forof-cl-G-collection-reflection.txt`

#5151 Steps C4 / D / F / G, unchanged in substance; HEAD sites:
- `Map.prototype[Symbol.iterator]` / `Set.prototype[Symbol.iterator]` own
  property (2): seed on the Map/Set proto pages (`ensureMapNativeProtoGlue`
  `array-object-proto.ts:2400`, `ensureSetNativeProtoGlue` `:2412`) with the
  SAME closure singleton the `entries` (Map) / `values` (Set) member read
  yields (identity by `ref.eq`), descriptor `{w:T,e:F,c:T}`, following the
  #4786/#5116 `@@toStringTag` seeding (`:1837`); the value-side alias
  `tryCompileStandaloneBuiltinProtoIteratorRead` is already wired at
  `property-access.ts:5005-5009` (import at `:223`). `verifyProperty` needs
  hasOwnProperty/gOPD to see it (`native-proto-own-props.ts`).
- `@@species` (2): the gOPD arm exists (`tryEmitStandaloneBuiltinSpeciesGopd`,
  `builtin-static-gopd.ts:37`, called from `call-builtin-static.ts:3158`);
  add the direct READ `Map[Symbol.species]` (computed-symbol read in
  `property-access.ts`, gated by `isSymbolSpeciesKeyExpression`,
  `builtin-static-gopd.ts:1`) returning the ctor identity, and make the
  assignment `Map[Symbol.species] = v` a silent no-op (evaluate RHS, drop) in
  `expressions/assignment.ts`'s computed member-set on an unshadowed builtin
  ctor identifier.
- `size` (2): gOPD through propertyHelper's `var obj = Map.prototype`
  (`vec-overlay.ts` / `builtin-static-gopd.ts` list `"size"` for the syntactic
  receiver only) — resolve a VARIABLE receiver via `ctx.oracle`'s declared
  initializer or the runtime `$NativeProto` brand; `propertyIsEnumerable`
  → false (`native-proto-own-props.ts`). Getter body already exists:
  `emitCollectionSizeGetterBody` (`array-object-proto.ts:1788`).
- `append-new-values.js` (1): `map.get(1)` returns NaN when the value union is
  mixed — `tryCompileNativeMapMethodCall` (`map-runtime.ts:1597`) must unbox
  the `get` result per dynamic tag, not per the first-seen element type.

### What NOT to do

- **No new host imports, ever.** The 21 baseline leaks must stay closed by
  NATIVE paths: the Wasm `$Map` runtime (#1103/#2162), `__iterator` /
  `__iterator_next` / `__iterator_return` (`iterator-native.ts`), the weak
  runtime (`weak-collections-runtime.ts`). Do not re-register `Set`/`Map`/
  `WeakMap`/`WeakSet` as extern classes under `nativeStrings`
  (`extern-declarations.ts:62/134/158`), and do not route the general
  iterable to the eval tier (wrong error identity is the current bug).
- Never edit `tests/test262-runner.ts`, skip lists, or `scripts/*baseline*.json`;
  the runner's `Iterator` shim stays — make the compiled code satisfy it.
- No `--no-verify`; gates chained before every commit (below), also with
  `LOC_GATE_BASE=$(git rev-parse origin/main)`.
- New type queries via `ctx.oracle` only; `oracle-ratchet-allow:` only for a
  genuine `ValType`-level question.
- Never hand a closed struct (`$MapIterResult`, `$LazyIterHelper`,
  `$__IterRec`) to source code as an iterator RESULT — wrap through
  `__iter_result_obj`.
- Don't touch owned areas (X table): no generator-carrier work, no
  `Reflect.construct` NewTarget, no realms, no RegExp.
- Don't re-apply draft #5225 hunks (all superseded on main).
- Don't treat the 7 compile-timeout rows as hangs until re-measured on a
  quiet box.

## Acceptance criteria

- Per-step lists green via
  `npx tsx scripts/run-test262-paths.mts .tmp/es2015/forof-cl-<X>.txt --standalone`
  (F5 with `--isolate`). Expected flips: A 25 (+A2 2), B 17, C 27, D 21
  (+D3 1 stretch), F 24 (F1 6 incl. two stretch singles, F2 12, F3 3, F4 3)
  + F5 3, E 18, G 7 — **145 max, ≥ 110 is the bar** (E and the stretch
  singles are the uncertain part; report each unflipped row with its
  residual error in the PR body).
- Step A-0's import listing is `[]` for `Set/set-iterator-next-failure.js`,
  `WeakMap/iterator-next-failure.js`, `WeakMap/iterator-items-keys-cannot-be-held-weakly.js`.
- Controls: every row of `.tmp/es2015/forof-controls.txt` (28 currently-passing
  siblings from the same directories — Map/Set/Weak* ctor + prototype rows,
  the `ArrayIteratorPrototype`/`StringIteratorPrototype` metadata rows,
  `chunks`/`windows` yield-shape rows, for-of array/break/generic-iterable/
  `Array.prototype[@@iterator]`/arguments rows, and four `dstr` binding-form
  rows; all 28 verified passing on HEAD 2026-09-01 via
  `run-test262-paths.mts … --standalone`) still passes, on both lanes
  (`--standalone` and the default js-host lane: the for-of/dstr lowering is
  shared).
- Gates, chained: `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`
  (also with `LOC_GATE_BASE` set to the upstream-main tip).
- `pnpm run test:equivalence:gate` green (F1-c changes a degrade the
  equivalence corpus may exercise).

## References

- #5144 / #5147 / #5151 — wave-1 plans and their Results/follow-ups (the
  source of clusters A, B, C, D, F, G); landed via PR #5244.
- #4447 — for-of destructuring residual; slice 2's binding-form stepping is
  F2's model (`destructureParamArray`).
- #5188 — IterRec delegation (`iterRecAdoptArm`) and the #1058 aliased
  `Instr[]` hazard; its follow-up 3 (symbol-keyed method calls on plain
  objects) is adjacent to Step A-4.
- #3013 / #4747 / #4777 / #5099 — the iterator-prototype singletons Step C
  extends; #2903 R3 — lazy helpers (`iter-lazy-native.ts`) Step E finishes.
- #1320 / #2038 / #3119 / #3146 / #3388 — the native GetIterator ladder;
  #2162 / #1103 / #3171 — the native `$Map` runtime and brands.
- #3371, #2046, #5198, #680 / #2864 — owners of the X rows.
- Handover: `plan/agent-context/es2015-standalone-session-handover.md`
  (draft PR #5225 verdict, method notes).

## Suspended Work (2026-09-01T21:56Z — user-requested 2-hour pause)

- **Branch**: local lane branch `worktree-agent-a2fe6fd871d2d1eef` at `b67a7dd3f`
  (WIP snapshot commit on top of base `881ee7095`; NOT pushed — the lane's full
  diff is the durable patch `plan/agent-context/es2015-suspend-2026-09-01/patches/lane-5267.mbox`,
  apply with `git am --3way` onto current main).
- **Worktree at suspension**: `/home/user/js2/.claude/worktrees/agent-a2fe6fd871d2d1eef`
  (treat as gone; the patch is the truth).
- **State**: mid-implementation — Steps A, A-2 and B landed and gate-validated;
  Steps C–G not started; the snapshot itself is unverified as a commit (taken
  by the lead with hooks bypassed).
- **Verified so far** (implementer's own runs, standalone, in-process, 148
  comparable rows of `forof-head-safe`): before 1 pass / 145 fail / 2 CE →
  after **20 pass / 123 fail / 5 CE = +19, 0 pass regressions**. Cluster A
  17/25 flipped, A-2 2/2, cluster B 0/17 (the live `$__IterRec` mechanism works —
  17/17 focused tests in `tests/issue-5267-es2015-forof-iterators-r2.test.ts` —
  but the test262 harness shape still fails at `assert.sameValue(result.value, …)`).
  Controls 28/28. Gates green: LOC, func, coercion, oracle-ratchet, dead-exports,
  TS7 typecheck.
- **NOT yet verified / next steps in order**: (1) `pnpm run test:equivalence:gate`;
  (2) the related-suite run (31 collection/iterator vitest files) that was in
  flight; (3) root-cause the cluster-B harness-shape failure (`result.value`
  read on the live record) — 17 rows; (4) commit + results section; (5) Steps
  C → D → F → E → G per the plan.
- **Traps for the resumer**: `Map`/`WeakMap` `iterator-item-{first,second}-entry-returns-abrupt.js`
  (4 rows) now **hang** (infinite drive loop): an accessor installed via
  `Object.defineProperty(arr, 0, {get})` is a silent no-op in the standalone
  lane, so the test's deliberately infinite iterator never throws — exclude
  them from head runs and resolve (or accept the risk) before CI. Per-row
  `--isolate` runs pay ~15–25 s JIT warm-up per process and report bogus
  compile-timeout CEs; measure in-process with a throwaway warm-up row. A/B on
  the same file showed no slowdown (12.1 s new vs 14.6 s base). The lane base
  (`881ee7095`) predates PRs #5434/#5437 (docs only) — merge, never rebase.

## 2026-09-01 resumed implementation (Opus)

Lane resumed from the suspension patch (`lane-5267.mbox`, base `881ee7095`)
onto current main `813b828b6` — 676 commits later. `git am --3way` auto-merged
both source files; only the issue file conflicted (add/add).

### Head measurement (mine, both ends)

`npx tsx scripts/run-test262-paths.mts .tmp/es2015/forof-head-safe.txt --standalone`,
152 rows (`forof-head.txt` minus the 3 realm-poisoning F5 rows), one quiet
in-process run per end, on the SAME list:

| | pass | fail | compile_error |
|---|---|---|---|
| base = current main `813b828b6` (reverted via file copies) | **9** | 141 | 2 |
| this lane | **46** | 104 | 2 |

**+37 rows, 0 pass→non-pass regressions** (pass sets diffed; the base's 9 —
8 `Iterator/prototype/{chunks,windows}` rows main gained since the plan was
written, plus `SetIteratorPrototype/next/does-not-have-mapiterator-internal-slots-set.js`
— all still pass). Controls `.tmp/es2015/forof-controls.txt`: **28/28 standalone**.
On the **js-host** lane the controls are 23/28 — the same 5 rows fail on the
reverted base, so they are pre-existing on main, not this lane
(`Map/map.js`, `chunks/chunks-evenly-divisible.js`, `windows/windows-basic.js`,
`for-of/Array.prototype.Symbol.iterator.js`,
`for-of/dstr/array-elem-trlg-iter-list-nrml-close.js`).

The suspension's own figure (20 pass of 148) is not comparable: it predates
main's chunks/windows gain and the two defects below.

### What the resume had to fix before the suspended work was correct

**1. Step B-3 collided with #5131/#5272, which landed the same packing.** Main's
`__map_iter_next` now returns a canonical two-slot `$Vec` for kind 2
(`entries`), so the lane's `$ObjVec` packing in the `__iterator_next` MAPSET
twin ran on top of it and produced `[key, [key, value]]` —
`map.entries().next().value[1]` was an object, not the value. Main's version
supersedes: the twin now passes the stepper's value through untouched, and the
lane's `key` field on `$MapIterResult` (plus its `ensureMapHelpers`
func-budget grant) is reverted. The done→canonical-`undefined` conversion the
lane added to that arm is kept — it is what makes the exhausted step report
`value === undefined` rather than JS `null`.

**2. `[...m.keys()]` threw** once `keys()` yields a live record: the #5131
strict-spread provider's GetIterator ladder has no OBJ arm, so a subject that
already IS an `$__IterRec` fell through to the §7.4.1 non-iterable TypeError.
`buildIteratorBody` now adopts a record SUBJECT by identity (the first half of
#5188's `iterRecAdoptArm`, extracted as `iterRecIdentityArm` and applied at
local 0), which fixes both dispatchers at once.

### Cluster B root cause (17 rows) — `.value`/`.done` as a CALL ARGUMENT

`property-access-dispatch.ts`'s IteratorResult arm compiled the RECEIVER and
only then looked up `__gen_result_value` / `__gen_result_value_f64` /
`__gen_result_done`. Those readers are host imports, so in a standalone module
with no generator they are absent — the arm fell through to `PA_FALLTHROUGH`
with the receiver still on the stack, and the caller re-compiled the whole
read through the dynamic path. One operand too many. In statement position the
#1058 stack repair absorbed it (which is why `var v = result.value` worked and
hid the bug for two waves); in ARGUMENT position it shifted the callee, so
`assert.sameValue(result.value, 'foo')` died with
`TypeError: called value is not a function` — the exact #5151 blocker.

Fix: resolve the reader first, compile the receiver only when one exists. When
a reader IS registered the emitted bytes are unchanged. Measured on the cluster
list: **0/17 → 12/17**.

Remaining 5: `Map`/`SetIteratorPrototype/next/iteration{,-mutable}.js` (the
default `@@iterator` route, `result` reads back null) and
`Set/prototype/values/values-iteration-mutable.js` (an exhausted record is
revived by a later `add` — it must stay done).

Repro of the whole chain, minimised: `.tmp/es2015/probes5267/` plus
`.tmp/pb/b11.js` (four `assert.sameValue` shapes, hoisted vs inline).
**Note for anyone probing this area:** the authoritative
`runTest262File` compiles the ORIGINAL harness assembly
(`assembleOriginalHarness`) as **JS** with `allowJs`, `deferTopLevelInit`,
`hostBridge: "always"`; compiling the same text as `.ts` passes and hides the
bug. `wrapTest` is the legacy synthetic lane (`runSyntheticTest262File`), not
what the runner judges by.

### Hang trap — resolved, and its real root cause

The suspension flagged 4 rows as hanging. Measured per-row in bounded children:
only the **2 `Map`** rows hang; the 2 `WeakMap` twins fail fast (their key is a
string, so CanBeHeldWeakly throws first). Compile is 9–11 s for both, so it is
a RUN hang, and `runTest262File` has **no wall-clock guard around execution** —
one such row wedges a whole CI shard.

Root cause is NOT the descriptor define, which works: measured
`Object.defineProperty(a, 0, {get})` on a module-scope array stores the
accessor (`getOwnPropertyDescriptor` reports it) and a direct dynamic read of
`a[0]` throws. What fails is object IDENTITY — at module scope
`({v: a}).v === a` and `[a][0] === a` are both **false** in the standalone lane
(true for a function-local array). The #3251 overlay is keyed by vec identity,
so the copy the test's iterator hands back reads its plain element, the getter
never throws, and the test's deliberately infinite iterator never ends. That
identity gap is pre-existing, independent of this drive, and out of scope here.

Mitigation shipped: the ctor drive carries a divergence ceiling of 4M entries
(a catchable TypeError) **only in modules that install a non-data descriptor**
(`ctx.vecAccessorDescriptorDirty`, the #4159 pre-scan flag). Ordinary modules
keep an unbounded, byte-identical loop. All 4 rows now fail fast instead of
hanging; the ceiling should be removed when module-scope array identity is
fixed.

### Status

- Steps A, A-2, B: landed and measured (A+A2 19/27 flipped, B 12/17).
- Steps C, D, E, F, G: not started.
- Gates green (LOC, func, coercion, oracle-ratchet, dead-exports, all with
  `LOC_GATE_BASE=813b828b6`), TS7 typecheck green,
  `tests/issue-5267-es2015-forof-iterators-r2.test.ts` 17/17.
- `pnpm run test:equivalence:gate` **green** — "24 failing, 1718 passing, 24
  known-failures in baseline · No new equivalence regressions". This is the
  check the suspension listed as not run; F1-c (which changes the degrade the
  corpus exercises) is still unimplemented, so it must be re-run when that
  lands.
- `pnpm run typecheck:ts5` reports 2 pre-existing `WebAssembly.Tag` errors in
  `src/linked-provider-runtime.ts`, untouched by this lane.

### Leftovers for the next lane (measured pointers, not guesses)

**Cluster B residual (5 rows) — `map[Symbol.iterator]()` is the odd one out.**
`map.keys()` and `map.entries()` both produce a live record whose `.next()`
works; `map[Symbol.iterator]()` produces a record (non-null) whose `.next()`
returns **null**. Measured with `.tmp/pb/c2.js` (all three in one module:
`keys` OK, `entries` OK, `@@iterator` null) and `.tmp/pb/c3.js` (the same
failure with the receiver's static type ERASED through an identity function, so
widening `isGeneratorType` — which does not list `MapIterator`/`SetIterator` —
is NOT on its own the answer).

Not yet root-caused; two candidate sites, and one cheap experiment settles it.
The producer is `__iterator(map)` on both routes that can reach it (the
`@@iterator` arm at `src/codegen/expressions/call-tail-dispatch.ts:751-812`,
and the `__mapset_symbol_iterator` closure singleton at
`src/codegen/map-runtime.ts:3070`, whose whole body is `__iterator(this)`), and
`__iterator`'s spliced `$Map` arm builds the SAME `$__IterRec{MAPSET}` that
`map.entries()` builds — so a producer difference is not obvious. The consumer
is `.next()` at `src/codegen/expressions/call-receiver-method.ts:1074` /
`:3759`. Since the iterator itself is non-null but its step is null, the likely
shape is a `.next()` site that declined and pushed `ref.null.extern`: **dump
the WAT for `.tmp/pb/c2.js` and compare the two call sites** before changing
anything. Rows: `Map`/`SetIteratorPrototype/next/iteration{,-mutable}.js`.
The 5th, `Set/prototype/values/values-iteration-mutable.js`, is different: an
EXHAUSTED record is revived by a later `add` (`«4»` where `undefined` is
required). Exhausted must stay exhausted — see the `idx = -1` note in the plan's
D-1b.

**Divergence ceiling is a placeholder, not a design.** Remove the 4M-entry cap
in `emitNativeCollectionCtorIterableDrive` once module-scope array identity is
fixed (`({v: a}).v === a` must be true). Until then it is the only thing
keeping `Map/iterator-item-*-entry-returns-abrupt.js` from wedging a shard.

**Steps C, D, E, F, G are untouched** — the plan above is unchanged and still
accurate for them; only cluster B's residual count moved (17 → 5).

## Implementation Plan — r3 (2026-09-03)

Planner: Fable lane, read-only pass over main `bee5ddd535` (= origin/main at
09:00 UTC). Implementer: an Opus agent in its own worktree, from this text.

### Census and root-cause groups (101 residual rows)

Source: `.tmp/census0903/for-of+collections.tsv` (standalone baseline rows
stamped 2026-09-03 09:07 UTC × `test262-file-editions.json` ES2015). Grouped by
the ERROR column, not by path:

| # | Root cause | Rows | Error signature | Verdict |
|---|---|---|---|---|
| G1 | generator carrier: `env::__create_generator …` host imports | 23 | `standalone target emitted host imports: env::__create_generator, …` | OUT (#680 / #2864) |
| G2 | generator carrier: native lowering refuses non-numeric yields | 12 | `native generator lowering currently supports only sequential numeric yields` | OUT (#680) |
| G3 | `%Map/SetIteratorPrototype%.next` not materialised: `iterator.next` reads `undefined` | 10 | `Cannot read properties of undefined (reading 'call')` | **R3-2** |
| G4 | same defect, metadata form (`MapIteratorProto.next` is `undefined` → gOPD of undefined) | 4 | `Cannot convert undefined or null to object` (`*IteratorPrototype/next/{name,length}.js`) | **R3-2** |
| G5 | `map[Symbol.iterator]()` yields a record whose `.next()` is **null** (`map.keys()/entries()` work) | 4 | `Cannot access property on null or undefined at 33x:18` (`*IteratorPrototype/next/iteration{,-mutable}.js`) | **R3-1** |
| G6 | exhausted `$MapIter` revived by a later `add` | 1 | `Exhausted result value (repeated request) … «4» … «undefined»` | **R3-1c** |
| G7 | ctor drive: `Get(entry,"0")` on an entry without index `0` yields a NULL key → trap in the adder | 2 | `dereferencing a null pointer [in __closure_75() …]` | **R3-3a** |
| G8 | ctor drive: CanBeHeldWeakly TypeError fires BEFORE a user-patched `set`/`add` | 2 | `Expected a Test262Error but got a TypeError` (`*-close-after-{set,add}-failure.js`) | **R3-3b** |
| G9 | module-scope array loses identity when stored into a property → the accessor overlay is not seen → 4M-step ceiling TypeError (Map) / string-key TypeError (WeakMap) | 4 | `Expected a Test262Error but got a TypeError` (`iterator-item-{first,second}-entry-returns-abrupt.js` ×2 kinds) | DEFERRED (pre-existing identity gap, see r2 "Hang trap") |
| G10 | for-of statement protocol (close on next/value abrupt; `next` re-read; non-Object result; finally re-inline; overlay accessor) | 6 | mixed (`Iterator is not closed`, `Should not access the next method after the iteration prologue`, `Expected a TypeError…no exception`, `«2» «1»`) | **R3-4** |
| G11 | assignment-pattern head drive is eager (`__array_from_iter_n` up front) | 12 | `Expected SameValue(«1», «0»)` / `(«11», «0/1»)` (nextCount/returnCount), `«[object Object]», «12»`, elision/computed-key no-throw | **R3-5** |
| G12 | `delete Array.prototype[Symbol.iterator]` not honoured by the for-of ARRAY fast path | 3 | `Expected a TypeError to be thrown but no exception was thrown at all` (`*-ary-init-iter-get-err-array-prototype.js`) | **R3-6** |
| G13 | collection reflection: `@@iterator` own-ness on Map/Set proto (2), `size` gOPD (2), mixed-union `map.get` (1) | 5 | `Symbol() should be an own property` / `Cannot convert undefined or null to object` / `«NaN», «"valid"»` | **R3-7** |
| G14 | `Ctor[Symbol.species]` write/delete/gOPD on a builtin ctor | 2 | `Expected obj[5] NOT to be writable, but was.` | DEFERRED (family: `Array/Symbol.species/symbol-species.js` fails identically — one owner for the species family) |
| G15 | two boxed numbers from different producers are `!==` under `assert.sameValue` | 3 | `Expected SameValue(«0», «0») to be true` (`for-of/map{,-expand,-contract-expand}.js`) | **R3-8** |
| G16 | anonymous `class` default in an OBJECT assignment pattern has no own `name` | 1 | `name should be an own property` (`dstr/obj-id-init-fn-name-class.js`) | **R3-9** |
| G17 | realms (`$262.createRealm`) | 5 | `Cannot access property on null or undefined at 345:44` / `330:35` (4× `proto-from-ctor-realm.js`, `Symbol/iterator/cross-realm.js`) | OUT (#3371) |
| G18 | parser: `[ x = 'x' in {} ]` in a for-of head | 1 | `',' expected.` | OUT (parser) |
| G19 | well-known symbols are not own properties of the `Symbol` ctor | 1 | `iterator should be an own property` (`Symbol/iterator/prop-desc.js`) | OUT — the same defect fails all 12 `Symbol/*/prop-desc.js` rows in `.tmp/census0903/other-builtins.tsv`; one owner there |

Totals: **53 claimed** (R3-1 5, R3-2 14, R3-3 4, R3-4 6 [4 firm + 2 stretch],
R3-5 12, R3-6 3, R3-7 5, R3-8 3, R3-9 1) · **48 deferred / out of scope**
(35 generator, 5 realm, 1 parser, 1 Symbol family, 2 species, 4 identity).

### Verified on main (2026-09-03, load 1.2–3.1, in-process)

```
npx tsx scripts/run-test262-paths.mts .tmp/r3-5267/sample.txt --standalone
=== counts ===  { fail: 14 }
```

14 rows, one per group (G3 `MapIteratorPrototype/next/this-not-object-throw-keys.js`,
G4 `SetIteratorPrototype/next/length.js`, G5 `MapIteratorPrototype/next/iteration.js`,
G7 `Map/iterator-items-are-not-object.js`, G8 `WeakMap/iterator-close-after-set-failure.js`,
G10 `for-of/iterator-next-error.js` + `iterator-next-reference.js`, G11
`dstr/array-elem-iter-thrw-close.js` + `array-rest-lref-err.js`, G13
`Map/prototype/Symbol.iterator.js` + `Map/prototype/size/size.js`, G15
`for-of/map.js`, G16 `dstr/obj-id-init-fn-name-class.js`, G19
`Symbol/iterator/prop-desc.js`) — every one still fails with the baseline's
error text (full output: `.tmp/r3-5267/sample.out`). Nothing in this cluster
was fixed by what merged since the baseline; no group is dropped.

Minimised repros, one compile each via `npx tsx .tmp/probe-one.mts <file>`
(`.tmp/r3-5267/probes/`, results in `run1.out`):

| probe | finding |
|---|---|
| `b1.js` | `map.keys().next()` → object; `map[Symbol.iterator]()` → non-null record; **its `.next()` → `null`** |
| `b2.js` | `var f = map[Symbol.iterator]; f.call(map)` → **`null` record** (the `__mapset_symbol_iterator` closure route is broken too) |
| `b3.js` | inline `map[Symbol.iterator]().next()` → `null` — so the STATIC `@@iterator` arm's product (`__iterator(map)`) is the bad producer, not the variable |
| `a1.js` | `var z = [['a',1], 2]; z.length` OK; **`new Map([{}, 2])` traps** (`dereferencing a null pointer`) before the TypeError for `2` — an entry object WITHOUT index 0 yields a null key |
| `f4.js` | **`[0,'a'][0] === a[0]` is FALSE at module scope** with `var a = [0,'a']` — G15 is not for-of specific; it is `===` on two `$BoxedNumber`s from different producers |
| `f3.js` | array-pattern default `[ c2 = class {} ]` → `c2.name === 'c2'` OK; object-pattern default `{ cls = class {} }` → **`cls.name === undefined`** |
| `g1.js` | `Object.getOwnPropertyDescriptor(Map.prototype,'size')` → object, `typeof d.get === 'function'` OK; **`typeof d.set` throws `Cannot convert undefined or null to object`** |

### Method rules for every step

- Type queries through `ctx.oracle` (`src/checker/oracle.ts`) — never
  `ctx.checker.getTypeAtLocation` in NEW code (the oracle-ratchet gate). Where
  a step needs the receiver's TS symbol name (Map/Set), use the oracle's
  symbol/name query; where it needs the compiled `ValType` (a `$Map` struct
  check), read the compiled result, not the checker.
- Fresh `Instr` objects per arm (#2169b); reserve-then-fill for anything filled
  at finalize (#1719/#2043); `ensureLateImport` + `flushLateImportShifts`
  BEFORE resolving any funcIdx that will be baked.
- Every step below is a separate commit, gates chained before each
  (`node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`,
  also with `LOC_GATE_BASE=$(git rev-parse origin/main)`).
- **Base-tree copies before the first edit** (`git show HEAD:<file> > .tmp/r3-5267/base/<file>`)
  so every "byte-identical" acceptance below is a `cp` + recompile, not a claim.
- Measurement: `npx tsx scripts/run-test262-paths.mts <list> --standalone`
  (paths exactly as in the TSV, no `test/` prefix); `--isolate` for R3-6.
  Row lists per step: write them to `.tmp/r3-5267/rows-R3-N.txt` from the
  path globs given in each step. Controls (all currently passing, verify
  before starting): `.tmp/es2015/forof-controls.txt` (28 rows; on the js-host
  lane 5 of them fail on main already — `Map/map.js`,
  `chunks/chunks-evenly-divisible.js`, `windows/windows-basic.js`,
  `for-of/Array.prototype.Symbol.iterator.js`,
  `for-of/dstr/array-elem-trlg-iter-list-nrml-close.js` — compare against
  that baseline, not against 28) plus the per-step controls named below.
- Box rules: one compile process at a time; probe batches ≤ 15 paths; never
  a full sweep; a compile timeout under load is an artifact.

### R3-1 — `map[Symbol.iterator]()` must yield the SAME live record `map.entries()` yields (5 rows)

**Root cause.** `map.keys()/entries()` go through
`compileNativeCollectionIterator` → `emitLiveCollectionIterRec`
(`src/codegen/map-runtime.ts:2151-2166`), which builds the
`$__IterRec{ITER_KIND_MAPSET}` inline. `map[Symbol.iterator]()` goes through
the `@@iterator` arm of `compileTailDispatch`
(`src/codegen/expressions/call-tail-dispatch.ts:754-815`): `resolveArrayInfo`
is false for a Map, so it calls the dynamic ladder `__iterator(recv)`
(`:807-810`). That ladder's `$Map` arm is SPLICED at finalize by
`fillMapSetDynDispatchArms` (2) (`map-runtime.ts:2804-2856`) — and the probes
show the product of `__iterator(map)` is a record whose `.next()` answers
`null` (b3), and the closure route (`__mapset_symbol_iterator`,
`map-runtime.ts:3070-3101`, body = `__iterator(this)`) answers a null RECORD
(b2). Both point at `__iterator`'s `$Map` arm being absent or shadowed in the
final body. Prime suspect: `fillNativeIteratorLateArms`
(`src/codegen/iterator-native.ts:2389`) REBUILDS `__iterator`'s body
(`index.ts:6030` / `:11110`), and `fillMapSetDynDispatchArms` (`index.ts:6480`
/ `:11195`) refuses a second splice via the `__mapset_dyn_arms_filled` flag
(`map-runtime.ts:2763`) — so any re-arm of the ladder after the first splice
loses the `$Map` arm for good. Second suspect: the spliced arm sits AFTER
`prependIterRecIdentityArm`'s rewrite (`iterator-native.ts:1692-1711`,
`fn.body = [...]`) only by call order, which the two finalize paths do not
guarantee identically.

**Edits, in order.**

1. **(a) static reroute — deterministic, independent of the root cause.** In
   `compileTailDispatch`, inside the `methodName === "@@iterator"` arm and
   BEFORE the `resolveArrayInfo` array arm (`call-tail-dispatch.ts:765`):
   when `ctx.nativeStrings` and the receiver's TS symbol name (via
   `ctx.oracle`) is `Map` or `Set`, snapshot-compile the receiver
   (`snapshotSpeculative`/`rollbackSpeculative`, the `compileForOfNativeCollection`
   pattern at `src/codegen/statements/loops.ts:1188-1192`) to confirm it lowers
   to `ctx.mapTypeIdx`, then `return emitLiveCollectionIterRec(ctx, fctx, elemAccess.expression, isSet ? "values" : "entries", isSet)`
   (export it from `map-runtime.ts` if it is module-private; it is the function
   `compileNativeCollectionIterator` calls first). Extra call arguments:
   evaluate + drop (spec ignores them). §24.1.3.12 / §24.2.3.11:
   `Map.prototype[@@iterator]` IS `entries`, `Set.prototype[@@iterator]` IS
   `values`, so the product is by definition the same record.
2. **(b) dynamic ladder root cause.** Compile `.tmp/r3-5267/probes/b2.js` and
   dump `__iterator`'s body (a WAT dump of the module — `scripts/` has no
   flag for that on the runner path, so add a temporary `console.error` of
   `definedFuncAt(ctx, ctx.funcMap.get("__iterator")).body.slice(0, 12)` at
   the END of the second finalize path, or use `.tmp/es2015/probes5267/imports-of.mts`'
   `compile()` call and `WebAssembly.Module` inspection). If the first arm is
   NOT `ref.test $Map` (`mapTypeIdx`): make the `$Map` arm part of the
   ladder's own build instead of a post-splice — in `buildIteratorBody`
   (`iterator-native.ts:3473`) add the arm where `iterRecIdentityArm` is
   applied (`:3431`), reading `ctx.mapTypeIdx` / `ctx.mapHelpers.get("__map_iter_new")`
   at build time (they exist whenever a Map/Set was compiled before finalize;
   when they do not, emit nothing — byte-identical for Map-free modules). Keep
   the `fillMapSetDynDispatchArms` splice but make its idempotence key the
   TARGET body (`iterFn.body` identity or a marker instr), not a global flag,
   so a rebuilt ladder is re-armed. Then `b2.js` `closure-route-*` must pass.
3. **(c) sticky exhaustion (`Set/prototype/values/values-iteration-mutable.js`).**
   In `ensureMapHelpers`' `__map_iter_next` body (`map-runtime.ts:1115-1290`):
   the done branch (`:1274-1277`, reached when `idx >= entryCount`) must first
   `struct.set $MapIter.IT_INDEX := 0x7fffffff` (locals: `0` = it) so the
   `i32.ge_s` test at `:1162` stays true after a later `add` grows
   `M_ENTRYCOUNT`. `__map_iter_new` (`:1112`) starts at 0 — untouched.

**Rows claimed (5).** `built-ins/MapIteratorPrototype/next/iteration.js`,
`built-ins/MapIteratorPrototype/next/iteration-mutable.js`,
`built-ins/SetIteratorPrototype/next/iteration.js`,
`built-ins/SetIteratorPrototype/next/iteration-mutable.js`,
`built-ins/Set/prototype/values/values-iteration-mutable.js`. Also unblocks
the trailing `iterator.next.call(map[Symbol.iterator]())` line of 10 R3-2 rows.

**Growth.** `call-tail-dispatch.ts` +30 (`compileTailDispatch`, one arm);
`map-runtime.ts` +25 (`ensureMapHelpers` +6, `fillMapSetDynDispatchArms` re-key);
`iterator-native.ts` +40 if (b) moves the arm into `buildIteratorBody`.

**Order constraints.** (a) must evaluate the receiver exactly once and before
the extra arguments; the record must be LIVE (no `emitCollectionIteratorVec`
snapshot). (c) must not touch the non-done path (mutation rows depend on the
tombstone-skipping walk exactly as it is).

**Passing shapes at risk + how to check.**
- `for (x of map)` / `for ([k, v] of map)` / `for (x of set)` /
  `[...map]` / `Array.from(set)` / `new Set(map.keys())` — all consume the
  MAPSET record or the vec projection: run the 6 Map/Set rows of
  `forof-controls.txt` plus `built-ins/Map/prototype/entries/returns-iterator.js`,
  `built-ins/Set/prototype/values/returns-iterator.js`,
  `built-ins/Map/prototype/delete/does-not-break-iterators.js`,
  `built-ins/SetIteratorPrototype/next/does-not-have-mapiterator-internal-slots-set.js`
  (pass today).
- Array receivers of `[Symbol.iterator]()` must be byte-identical: compile
  `.tmp/es2015/probes5267/p2-array-symiter-next.js` on base and new tree and
  `cmp` the `.wasm` (the reroute is gated on Map/Set symbol names).
- js-host lane: the reroute is under `ctx.nativeStrings`; confirm with the
  host-lane run of `forof-controls.txt` (23/28 baseline).
- Any module with a Set-typed `values()` loop that exhausts and then `add`s
  again expects `done` to stay true — the equivalence gate corpus is the
  detector: `pnpm run test:equivalence:gate` must stay at its baseline.

### R3-2 — own `next` on `%MapIteratorPrototype%` / `%SetIteratorPrototype%`, and `iterator.next` as a VALUE (14 rows)

**Root cause.** `emitIteratorPrototypeSingleton`
(`src/codegen/array-object-proto.ts:3799-3880`) seeds an own `next` only for
`kind === "String"` (`:3856-3873`, a refusal body). For Map/Set the singleton
has `@@toStringTag` only, so `MapIteratorProto.next` is `undefined` (G4), and a
property READ `iterator.next` on an `$__IterRec` externref has no `__extern_get`
arm at all — `fillMapSetDynDispatchArms` (4) only handles the CALL form via
`__extern_method_call` (`map-runtime.ts:2992-3061`) — so `iterator.next` is
`undefined` and `.call` on it throws (G3).

**Edits, in order.**

1. **Brands.** `src/codegen/builtin-brands.ts` `BUILTIN_BRAND_TABLE` has `Map`
   (+25), `Iterator` (+32) but no iterator-kind brands: APPEND `MapIterator`,
   `SetIterator`, `ArrayIterator` after the current last entry (append-only
   contract stated in the file; never renumber).
2. **Glues.** In `array-object-proto.ts` next to `ensureIteratorNativeProtoGlue`
   (`:2676`): `ensureMapIteratorNativeProtoGlue` / `ensureSetIteratorNativeProtoGlue`
   (and `ensureArrayIteratorNativeProtoGlue`, optional — see below) =
   `registerNativeProtoBuiltin(ctx, { ...makeGlue(ctx, brand, "MapIterator", ["next"]), memberLength: () => 0, emitMemberBody: (c, f, m) => emitIterRecNextBody(c, f, "Map") })`.
   `makeGlue` is at `:2348`; `emitMemberBody`'s closure ABI is local 0 = self,
   local 1 = externref `this` (see `emitCollectionSizeGetterBody`, `:1893-1930`,
   which is the model for a brand-checked body).
3. **Body `emitIterRecNextBody(ctx, fctx, kind: "Map"|"Set"|"Array")`** (new,
   `array-object-proto.ts`): `ensureNativeIteratorRuntime(ctx)`;
   `ensureNativeIterResultObject(ctx)` (registers `__iter_next_result`,
   `iterator-native.ts:1553-1590`); flush; then
   `local.get 1; any.convert_extern; ref.test $__IterRec` → else
   `emitBrandCheckTypeError(ctx, fctx.body, "…next called on incompatible receiver")`
   (`native-proto.ts:1154`); then the kind test — Map/Set:
   `struct.get $__IterRec.kind == ITER_KIND_MAPSET (9)` AND
   `struct.get $__IterRec.userIter → any.convert_extern → ref.cast $MapIter → struct.get IT_MAP → struct.get $Map.M_KIND == 0 (Map) | 1 (Set)`
   (`MAP_LAYOUT.M_KIND`, `map-runtime.ts:76`); Array: `kind == ITER_KIND_VEC (3)`
   (or the LIVEVEC kind if D-1b ever lands) — mismatch → the same TypeError
   (`does-not-have-mapiterator-internal-slots.js` throws in BOTH directions).
   Then `local.get 1; call __iter_next_result; return externref`.
4. **Seed on the singleton.** In `emitIteratorPrototypeSingleton`, generalise
   the `kind === "String"` block (`:3856-3873`) to a per-kind table:
   `{ String: [ensureStringNativeProtoGlue, refusalBodyFallback:true], Map: [ensureMapIteratorNativeProtoGlue], Set: […], Array: […] }`
   — same `__defineProperty_value` recipe, bits `0x01|0x04`
   (writable, non-enumerable, configurable). Mint the closure via
   `ensureStandaloneNativeMethodClosure(ctx, brand, "next", "method")`
   (`native-proto.ts:948`) WITHOUT `refusalBodyFallback` for the three
   behavioural kinds. `name: "next"` / `length: 0` come from `nativeClosureMeta`
   (the #5099 machinery the String branch already relies on).
5. **`iterator.next` as a value.** Splice into `__extern_get` a `$__IterRec`
   arm — the model is `fillMapSetDynDispatchArms` (1) (`map-runtime.ts:2930-2990`,
   the `$Map` "size" / `@@iterator` arms; `keyEqualsStr("next", 1)` already
   exists at `:2998`): `local.get 0; any.convert_extern; ref.test $__IterRec` →
   key == "next" → select the closure by kind (MAPSET + M_KIND 0 → Map's
   `next` singleton, M_KIND 1 → Set's, VEC → Array's if seeded) →
   `pushBuiltinFnSingletonValueInstrs(ctx, closure); extern.convert_any; return`.
   The closures must exist before this splice: mint them in the same fill
   (`ensureStandaloneNativeMethodClosure` appends DEFINED funcs — allowed at
   finalize, as `ensureMapSetIteratorClosureSingleton` does at `:3075`), but
   only when `ctx.mapTypeIdx >= 0` (Map/Set) — for Array-only modules the
   arm is emitted from the same place `emitArrayIteratorPrototypeSingleton`
   is reached, or not at all (then the 3 `ArrayIteratorPrototype/next/*`
   metadata rows in other-builtins stay as they are; they are NOT claimed
   here).
6. **`fn.call(recv)` on the closure.** `iterator.next.call(false)` reaches the
   native method closure through the generic `__call_fn_method_*` path with
   `this = false` (boxed). The body's `ref.test $__IterRec` on a boxed
   primitive fails → TypeError — that is the whole `this-not-object-throw-*`
   family. Verify once with the first row; if `.call` on a `__fn_wrap`-shaped
   native closure declines (returns null instead of invoking), the fix is in
   the `.call` arm of `closed-method-dispatch.ts` / `call-receiver-method.ts`
   (grep `methodName === "call"`), not in the body.

**Rows claimed (14).** `built-ins/MapIteratorPrototype/next/{length,name,this-not-object-throw-entries,this-not-object-throw-keys,this-not-object-throw-values,this-not-object-throw-prototype-iterator,does-not-have-mapiterator-internal-slots}.js`
and the same 7 under `built-ins/SetIteratorPrototype/next/`. 10 of them end
with `iterator.next.call(map[Symbol.iterator]())` ("does not throw") — R3-1(a)
must land first.

**Growth.** `array-object-proto.ts` +90 (`emitIteratorPrototypeSingleton` +25,
new `emitIterRecNextBody` ~45, two glue registrars ~20); `map-runtime.ts` +45
(`fillMapSetDynDispatchArms`, one more `__extern_get` arm);
`builtin-brands.ts` +3; `native-proto-own-props.ts` +15 only if the new brands
need an own-props arm for `hasOwnProperty(proto, "next")` (the
`property-descriptor.js` rows are other-builtins; `name.js`/`length.js` read
the value only).

**Order constraints.** The prototype singleton's init order is observable only
through `Object.getOwnPropertyNames` (`@@toStringTag` is a symbol, `next`
must be the only string key). The `__extern_get` arm must come AFTER the
`$Map` arm (a `$Map` is not an `$__IterRec`, so order is not semantic — keep
`$Map` first for byte stability of Map-only modules).

**Passing shapes at risk + how to check.**
- `SetIteratorPrototype/next/does-not-have-mapiterator-internal-slots-set.js`
  (passes today: `iterator.next.call(new Set()[...])`-style cross-kind throw)
  and `Iterator/prototype/chunks/*` / `windows/*` rows (8 passing in
  `forof-controls.txt`) — they read `.next` on `$LazyIterHelper` and
  `$__IterRec` values; the new `__extern_get` arm must NOT intercept a
  `$LazyIterHelper` (`ref.test` is exact).
- `Object.getPrototypeOf([][Symbol.iterator]())` reflective rows
  (`ArrayIteratorPrototype/Symbol.toStringTag.js`, `StringIteratorPrototype/next/{name,length}.js`
  — the String branch stays byte-identical: `cmp` the `.wasm` of
  `built-ins/StringIteratorPrototype/next/name.js` on base vs new).
- Any program that reads `it.next` as a value on a generator (host `__gen_*`
  records are not `$__IterRec`) — `tests/issue-5267-es2015-forof-iterators-r2.test.ts`
  17/17 plus the 31-file collection/iterator vitest set the r2 record names.

### R3-3 — constructor drive: null key normalisation + adder-branch CanBeHeldWeakly (4 rows)

**Root cause.** `emitNativeCollectionCtorIterableDrive`
(`src/codegen/expressions/new-super.ts:4338-4552`): (a) `Get(entry,"0")` /
`Get(entry,"1")` via `__extern_get_idx` (`:4422-4434`) answer `ref.null.extern`
for an absent index, and `any.convert_extern` turns that into a NULL anyref
key that the native adder (`__map_set` → `__hash_anyref`,
`map-runtime.ts:404-560`) dereferences (probe a1: `new Map([{}, 2])` traps
before reaching `2`; the real rows trap on `[['a', 1], 2]` the same way once
the nested literal's carrier is not indexable by `__extern_get_idx` — verify
which of the two it is with a1 + `new Map([['a',1]])` alone). (b) the
CanBeHeldWeakly test (`:4445-4462`) runs BEFORE the adder dispatch, so a
user-patched `WeakMap.prototype.set` / `WeakSet.prototype.add` never gets the
call it must observe (spec: the test lives INSIDE the intrinsic adder,
§24.3.3.5 / §24.4.3.1).

**Edits.**
1. After each `call __extern_get_idx` in `entryBody` (`:4425`, `:4431`):
   `local.tee kExt; ref.is_null; if → <canonicalUndefinedExternInstrs(ctx)> ; local.set kExt` (
   `src/codegen/any-helpers.ts:167`), then the existing `any.convert_extern`.
   Do the same for the value. Fresh instrs per site.
2. Move the `isWeak` holdable block (`:4445-4462`) INTO `directAdd`
   (`:4463-4469`) — i.e. the `else` branch of the `dispatch.modeLocal` `if`
   (`:4470-4478`) and the no-dispatch fallback — so it runs only when the
   INTRINSIC adder is about to be called. `modeLocal` = 1 means the proto
   companion holds a user override (`prepareNativeSetAdderDispatch` doc).
3. If a1's trap survives edit 1: the next suspect is `__hash_anyref` on a
   null anyref — add a `ref.is_null → hash 0` arm there and note it in the PR.

**Rows claimed (4).** `built-ins/Map/iterator-items-are-not-object.js`,
`built-ins/WeakMap/iterator-items-keys-cannot-be-held-weakly.js`,
`built-ins/WeakMap/iterator-close-after-set-failure.js`,
`built-ins/WeakSet/iterator-close-after-add-failure.js`.

**Deferred (4).** `Map/iterator-item-{first,second}-entry-returns-abrupt.js`,
`WeakMap/iterator-item-{first,second}-entry-returns-abrupt.js` — module-scope
array identity (`({v: a}).v === a` is false; r2 "Hang trap"). Do NOT lift the
4M-step ceiling (`:4484-4520`) until that is fixed — it is what keeps the two
Map rows from wedging a shard.

**Growth.** `new-super.ts` +20 in `emitNativeCollectionCtorIterableDrive`.

**Order constraints.** Spec order in the drive (adder Get → iterable →
GetIterator → per step: next → Object test → Get 0 → Get 1 → Call adder) is
unchanged; the holdable test now sits between "Get 1" and the intrinsic
`__map_set`, exactly where §24.3.3.5 step 4 puts it. A throwing `get 0()` must
still close the iterator (inside `wrapWithIteratorClose`).

**Passing shapes at risk + how to check.** `new Map([[k, v], …])` literal
pairs (the `seedablePairs` path, `:5504-5560`, untouched — `cmp` the `.wasm` of
`built-ins/Map/iterable-calls-set.js` compiled on base vs new must be
IDENTICAL only if that row uses the literal path; otherwise run it), plus the
r2 lists `.tmp/es2015/forof-cl-A-ctor-iterable-drive.txt` and
`forof-cl-A2-symbol-keys.txt` (19 rows flipped in r2 — every one must still
pass), `built-ins/WeakMap/iterable-with-symbol-keys.js`,
`built-ins/WeakSet/iterable-with-symbol-values.js`,
`built-ins/Map/iterator-is-undefined-throws.js`.

### R3-6 — `delete Array.prototype[Symbol.iterator]` honoured by the for-of ARRAY fast path (3 rows, `--isolate`)

**Root cause.** The flag global exists (`__array_proto_iterator_deleted`,
`src/codegen/expressions/proto-override.ts:132-159`, raised by
`tryEmitArrayProtoIteratorDelete`, `:225-233`) and is read by ONE consumer —
`emitArrayIteratorDeletedGuard` in `src/codegen/destructuring-params.ts:1664-1670`
(binding patterns). `compileForOfArray` (`src/codegen/statements/loops.ts:1897`)
never reads it, so `for (let [x, y, z] of [[1, 2, 3]])` after the delete
iterates the OUTER array natively instead of throwing at GetIterator.

**Edits.** Export `emitArrayIteratorDeletedGuard` (or move it to
`proto-override.ts` next to `arrayIteratorDeletedGlobalIdx`) and call it in
`compileForOfArray` right after the vec type is confirmed (`loops.ts:1953`,
before the head-binding/loop emission) — it emits ZERO bytes when the source
has no such delete (the global is only rooted by the pre-scan). Also
`compileForOfArrayFromLocal` (`:1835`) if the `preVec` callers can be reached
from a user array (they come from Map/Set projections — not arrays — so no).
Check `maybeCaptureArrayProtoOverride` resets the flag to 0 when the source
later ASSIGNS `Array.prototype[Symbol.iterator] = …` (no reader exists today,
so this was never needed); add `i32.const 0; global.set` there if absent.

**Rows claimed (3).** `language/statements/for-of/dstr/{let,const,var}-ary-init-iter-get-err-array-prototype.js`
— measure with `--isolate` only (they poison the runner's realm).

**Growth.** `loops.ts` +8 in `compileForOfArray`; `destructuring-params.ts` +2
(export).

**Passing shapes at risk + how to check.** Every for-of over an array in a
module WITHOUT the delete is byte-identical (guard emits nothing): `cmp` the
`.wasm` of `language/statements/for-of/array-key-get-error.js` (any array
for-of row) on base vs new. Modules WITH the delete that later reinstall:
`language/statements/for-of/dstr/*-ary-ptrn-elem-id-iter-val-array-prototype.js`
are generator rows (out of scope) — but run the 3 `class/dstr/*-array-prototype.js`
rows that pass today under `--isolate` (find them: `grep array-prototype .test262-cache/test262-standalone-current.jsonl | grep '"pass"'`).

### R3-7 — collection reflection residue (5 rows; species DEFERRED)

**(a) `Map.prototype[Symbol.iterator]` / `Set.prototype[Symbol.iterator]` own property (2).**
Root cause: the value read already aliases the right closure (the test's
`assert.sameValue(Map.prototype[Symbol.iterator], Map.prototype.entries)`
passes; failure is `verifyProperty`'s `hasOwnProperty`). The own-props ladder
only knows members listed in the glue CSV; `seededSymbolMembers`
(`src/codegen/native-proto-own-props.ts:335-360`) already handles `@@<id>`
CSV sentinels by symbol identity. Edit: add `"@@1"` to `MAP_PROTO_METHODS`
and `SET_PROTO_METHODS` (`array-object-proto.ts:406-437`) and extend
`makeCollectionGlue`'s `memberAliasOf` (`:1950`) with
`member === "@@1" ? (name === "Map" ? "entries" : "values")` — exactly the
Array pattern (`:138` + `:2400-2402`). The `@@` filter for string enumeration
exists (`native-proto.ts:560`, `:604`). Descriptor: `{w:T, e:F, c:T}` as the
Array `@@1` seeding. Rows: `built-ins/Map/prototype/Symbol.iterator.js`,
`built-ins/Set/prototype/Symbol.iterator.js`. Risk check:
`Object.getOwnPropertyNames(Map.prototype)` must not gain a `"@@1"` string;
`Map.prototype[Symbol.iterator] === Map.prototype.entries` must stay true
(identity through `memberAliasOf`, `native-proto.ts:989`); run
`built-ins/Map/prototype/entries/{name,length}.js`,
`built-ins/Set/prototype/keys/keys.js` (Set `keys`→`values` alias, same
mechanism), `built-ins/Map/prototype/Symbol.toStringTag.js`.

**(b) `size` gOPD (2).** Probe g1: the descriptor comes back with a working
`get`; reading `d.set` throws `Cannot convert undefined or null to object`.
`PropertyDescriptor.set` is a METHOD signature in lib.d.ts (`set?(v: any): void`),
so `d.set` is compiled as a method-valued read on an externref receiver — find
the site by bisecting `typeof d.set` / `d["set"]` / `var s = d.set` in
`g1.js`; candidates are the method-reference read path in
`src/codegen/property-access-dispatch.ts` (grep the `PropertyDescriptor` /
method-signature branch) and the getter-descriptor synthesis for glue members
of `memberKind: "getter"` (`native-proto-own-props.ts`, reached from
`call-builtin-static.ts:3158`-area gOPD). Fix whichever it is so a synthesised
accessor descriptor carries an explicit `set: undefined` data key AND a
method-signature read on a plain `$Object` degrades to `__extern_get`. Rows:
`built-ins/Map/prototype/size/size.js`, `built-ins/Set/prototype/size/size.js`.
Risk check: `built-ins/Object/getOwnPropertyDescriptor/*` rows that pass today
touching accessor descriptors (`15.2.3.3-4-{2,3}.js`-style; pick 5 from the
baseline), `built-ins/Map/prototype/size/returns-count-of-present-values-*.js`.

**(c) `append-new-values.js` (1).** `map.get(1)` answers `NaN` because
`tryCompileNativeMapMethodCall`'s `get` arm (`map-runtime.ts:1699-1740`)
returns `anyref` and the caller unboxes to the STATICALLY resolved value type
(f64) although the map's value union is `number | string | symbol`. Edit: when
the oracle's value type is not exactly number/boolean, return
`extern.convert_any` → `{ kind: "externref" }` and let the dynamic reader
unbox per tag. Row: `built-ins/Map/prototype/set/append-new-values.js`.
Risk check: numeric maps stay unboxed (`built-ins/Map/prototype/get/returns-value.js`,
the playground `map` examples via `pnpm run check:ir-fallbacks` unchanged,
and the equivalence gate).

**DEFERRED — species (2).** `Map/Set/Symbol.species/symbol-species.js` need
the builtin-ctor `Ctor[Symbol.species] = v` write to be a silent no-op, the
`delete` to flip a per-ctor flag that the static gOPD arm
(`tryEmitStandaloneBuiltinSpeciesGopd`, `builtin-static-gopd.ts:444`) and
`hasOwnProperty` consult; `Array/Symbol.species/symbol-species.js` fails
identically on main, so this is the species FAMILY, not a collection row —
one owner, not this pass.

**Growth.** `array-object-proto.ts` +6; `map-runtime.ts` +15
(`tryCompileNativeMapMethodCall`); the (b) site +25 wherever it lands
(`property-access-dispatch.ts` or `native-proto-own-props.ts`).

### R3-9 — anonymous `class` default in an OBJECT assignment pattern (1 row)

Probe f3: the array-pattern default (`compileForOfAssignDestructuringExternref`,
`for-of-destructuring.ts:2421-2440` → `emitDefaultValueCheck(ctx, fctx, externref, local, init, externref)`)
yields a class value with an own `name`; the object-pattern identifier arm
(`compileForOfIteratorAssignDestructuring`, `:2716-2735`) calls
`emitDefaultValueCheck(…, targetTypeI ?? undefined, /* objectPropertySemantics */ true)`
and the class value's `.name` reads `undefined`. The display name itself is
right (`classObjectDisplayName` → `fnInstanceNameOf`,
`function-instance-meta.ts:363` handles the shorthand's
`objectAssignmentInitializer`), so the loss is in how the default VALUE is
produced/coerced on that arm. Bisect by (i) passing `{ kind: "externref" }`
as `targetType` for a class-expression initializer, (ii) the
`objectPropertySemantics` flag. Whichever restores `cls.name === 'cls'` in
`f3.js` is the fix; keep the `undefined`-only default trigger (§13.15.5.4
step 4 — a `null` read must NOT take the default).
Row: `language/statements/for-of/dstr/obj-id-init-fn-name-class.js`.
Growth: `for-of-destructuring.ts` +10. Risk check: the 4 `dstr` binding rows
in `forof-controls.txt`, `language/statements/for-of/dstr/obj-id-init-fn-name-{fn,arrow,cover,gen}.js`
(pass today), and `f3.js` in full.

### R3-4 — for-of statement protocol (6 rows: 4 firm, 2 stretch)

All in `compileForOfIterator` (`src/codegen/statements/loops.ts:2988-3412`)
and the OBJ step of `buildIteratorNextBody` (`src/codegen/iterator-native.ts:4372+`).

**(a) IteratorStep/IteratorValue abrupt must NOT close (2 rows).** The #1347
`try_table`/`try` wrapper (`loops.ts:3322-3392`) encloses
`call __iterator_next` (`:3255-3258`), so a throwing `next()` or `value`
getter runs `closeOnThrowBody` (`:3352-3361`). Edit: allocate an i32 local
`__forof_in_next`; `i32.const 1; local.set` immediately before `:3255`,
`i32.const 0; local.set` immediately after the done-check `if` (`:3272`);
gate `closeOnThrowBody`'s condition to
`doneFlag == 0 && in_next == 0` (fresh instrs; both lanes — the `try` and the
`try_table` branch). The finallyStack entry (`:3212-3235`) handles
return/break, never a throw — leave it. Apply the same gate to
`compileForOfDirectIterator` (`:2514`-area) if it carries its own wrapper.
Rows: `language/statements/for-of/iterator-next-error.js`,
`language/statements/for-of/iterator-next-result-value-attr-error.js`.

**(b) `next` read ONCE at GetIterator (1 row).** The OBJ step re-reads
`Get(rec.userIter, "next")` every poll (`iterator-native.ts:4572-4598` and the
strict twin `:4650-4674`). Edit: add a 5th field
`nextMethod (mut externref)` to `$__IterRec` in `getOrRegisterIterRecType`
(`:416-438`; field order is load-bearing, append at index 4); every
`struct.new $__IterRec` site pushes one more `ref.null.extern` — **16 sites**
(`grep -rn 'struct.new", typeIdx: iterRecTypeIdx\|struct.new", typeIdx: types.iterRecTypeIdx' src/codegen`),
including `fillMapSetDynDispatchArms` (2) and `emitLiveCollectionIterRec`.
In `buildIteratorBody`'s OBJ arm (the #3146 admission that already reads
`next`, `:3699`), `struct.set` the read value; in both OBJ steps use
`struct.get fieldIdx 4` when non-null, else the existing read (USER/closed
records keep null and their `__sget_next` route). Row:
`language/statements/for-of/iterator-next-reference.js`. This is the riskiest
sub-step (every record producer changes); land it as its own commit and
re-run the full R3 row set + controls after it.

**(c) §7.4.2 non-Object `next()` result → TypeError (1 row).** In the OBJ
step, a result that is neither an `$Object` (`objCarrierTest`, `:4620`) nor a
closed struct with `__sget_done` is degraded to `done` (`readStructArm` /
the falsy check at `:4605-4618`). Under `ctx.standalone || ctx.wasi` throw
`notAnObjectThrowInstrs(ctx, scratch)` (`:2167`-area; deps
`ensureNotAnObjectThrowDeps`, `:3391`) for a NON-NULL, non-object result of a
REAL call; keep the degrade for a null/falsy `next` (ladder-internal
carriers — the #5144 collision). Row:
`language/statements/for-of/iterator-next-result-type.js`. Run
`pnpm run test:equivalence:gate` — it is the consumer of the degrade.

**(d) STRETCH `throw-from-finally.js` (1 row).** `i` increments twice: the
`finally` body is inlined at its own inner `throw` on top of the for-of
iterator-close finallyStack entry (`src/codegen/statements/exceptions.ts:440-470`,
`cloneFinallyAtDepth`). Reproduce with `[1]` as the iterable first; a `throw`
INSIDE a finally block must not re-inline that same finally. If it only
reproduces with the `function*` source → it is G1/G2 territory, report and drop.

**(e) STRETCH `array-key-get-error.js` (1 row).** An accessor installed by
`Object.defineProperty(array, '0', {get})` is invisible to `compileForOfArray`
(`loops.ts:1897`, reads `vec.data[i]`). `ctx.vecAccessorDescriptorDirty`
(the #4159 pre-scan) is exactly the module-level signal: when it is true and
the subject is a plain array, route through `compileForOfIterator` and check
that `__iterator`'s VEC arm reads through the overlay. If the overlay is
also invisible there, leave it un-root-caused in the PR body.

**Growth.** `loops.ts` +30 (`compileForOfIterator`); `iterator-native.ts` +70
(`getOrRegisterIterRecType` +3, `buildIteratorBody` +15, `buildIteratorNextBody` +25,
plus 16 one-line operand additions); `exceptions.ts` +20 (stretch).

**Order constraints.** §14.7.5.7 ForIn/OfBodyEvaluation: `next()` abrupt →
return WITHOUT close; binding/body abrupt → IteratorClose (its own abrupt
suppressed, the throw completion wins); `break` → IteratorClose (post-loop
check, `:3399-3411`, untouched). The `next` read happens ONCE in GetIterator
(step (b)) and must happen AFTER the `@@iterator` call and BEFORE the first
`next()`.

**Passing shapes at risk + how to check.**
- Every for-of over a custom `{ next() }` iterable, a generator, a Map/Set
  record, a lazy helper: `forof-controls.txt` (both lanes),
  `language/statements/for-of/{break,break-from-catch,break-from-finally,break-label,continue,continue-from-catch,continue-label,return,return-from-catch,return-from-finally,throw,throw-from-catch}.js`
  (all pass today — the close-on-abrupt matrix), `iterator-close-*` and
  `iterator-next-result-*` rows that already pass, the 8 `chunks`/`windows`
  rows, and `tests/issue-5267-es2015-forof-iterators-r2.test.ts` 17/17.
- Host lane bytes: (a) changes the `try/catchAll` branch too — the host-lane
  run of `forof-controls.txt` must equal its 23/28 baseline and the
  equivalence gate its baseline.
- (b) changes every producer: `cmp` is impossible; instead run the r2 lists
  `forof-cl-B-live-collection-iterators.txt` and `forof-cl-A-ctor-iterable-drive.txt`
  (their pass sets must not shrink) and the D/E rows in
  `.tmp/census0903/other-builtins.tsv` that pass today (`ArrayIteratorPrototype/next/iteration.js`
  is a fail; pick `built-ins/Array/from/iter-*.js` ×5 passing rows as the
  spread/`Array.from` control).

### R3-5 — interleaved assignment-pattern drive for `for ([…] of iter)` (12 rows)

**Root cause.** `compileForOfAssignDestructuringExternref`
(`src/codegen/statements/for-of-destructuring.ts:2239-2460`) materialises the
whole source with `__array_from_iter_n(src, n | -1)` (`:2250-2267`) before any
target is evaluated, so `nextCount`/`returnCount` are wrong, lref evaluation
order is wrong, and no IteratorClose fires on a target/initializer abrupt.
NOTE for the implementer: r2's suggestion to copy `destructureParamArray`'s
stepping is WRONG — that path ALSO materialises through `__array_from_iter_n`
(`src/codegen/destructuring-params.ts:1955-1992`); there is no interleaved
drive on main to reuse. Write it here, gated on `ctx.standalone || ctx.wasi`
so the js-host lane stays byte-identical (it keeps the import-based
materialisation).

**Emit, per §13.15.5.5 IteratorDestructuringAssignmentEvaluation** (locals:
`iter` externref, `done` i32, `val` externref, `inNext` i32; the R3-4(a) gate
applies here too):
0. `GetIterator(elem)`: `local.get elemLocal; call __iterator` (native ladder,
   `ensureNativeIteratorRuntime` first, flush) → `iter`; `done := 0`.
1. For each element, in source order:
   - **Elision** → step 2 only (no target). An elision-only pattern
     `for ([,] of [Symbol()])` MUST still run step 0 (today the empty-pattern
     shortcut `emitEmptyForOfArrayPatternRequirement`, `:257`, is the only
     one that does): `array-elision-val-symbol.js`.
   - **Non-pattern target**: evaluate the **lref FIRST** — for a member target
     compile receiver + key into temps BEFORE step 2 (`[ {}[thrower()] ]`
     throws here with `nextCount 0`); for an identifier target nothing to
     evaluate.
   - 2. if `!done`: `inNext := 1; call __iterator_next(iter)` → pop value then
     done (`loops.ts:3252-3258` shape); `inNext := 0`; on `done` set
     `val := undefined` (`canonicalUndefinedExternInstrs`).
   - 3. initializer when `val === undefined` (NamedEvaluation for anonymous
     fn/class — R3-9's arm) — `emitDefaultValueCheck` with the hole→undefined
     mapping FIRST: an in-bounds hole in `[2, null, , undefined]` is the
     #2001 S1 sentinel (`emitHoleSentinel` / `f64HoleTestInstrs`,
     `src/codegen/array-holes.ts`, `vec-f64-hole-presence.ts`) —
     `array-elem-init-assignment.js` expects the default for the hole and
     for `undefined`, NOT for `null`.
   - 4. PutValue to the temps (member) / local / global / boxed capture
     (reuse the existing arms `:2369-2460` with the value in a temp instead of
     `pushElemRead(i)`), or recurse into a nested pattern with
     `destructureNestedExternrefPattern` (`:2359`).
   - **Rest `[...t]`**: lref first (member target), then drain: loop
     `__iterator_next` into a fresh `$Vec` (`__vec_externref` via the
     `ensureNativeArrayFromIterN` geometry, `iterator-native.ts:1778`) until
     `done`; then PutValue via `emitForOfRestAssignment` (`:2334`) over the
     drained vec. `array-rest-lref-err.js`: `nextCount 0, returnCount 1`.
2. Wrap steps 1.lref/3/4 (NOT step 2) in the close-on-throw shape of
   `wrapWithIteratorClose` (`new-super.ts:4529`, reuse it) so a target /
   initializer / nested-pattern abrupt calls `__iterator_return` once with its
   own abrupt SUPPRESSED (`*-close-err.js` rows: the original throw wins),
   then rethrows. `next()` abrupt propagates WITHOUT close (`done := 1` first).
3. After the last element: `if (!done) call __iterator_return` (normal
   completion; keep the #5144 C "close result must be an Object" check).
4. **Object patterns** (`compileForOfIteratorAssignDestructuring`, `:2567+`):
   a computed key (`{ [a.b]: x }`) is skipped today (`propName` undefined →
   `continue`, `:2591-2598`). Evaluate the key expression (ToPropertyKey)
   unconditionally BEFORE the Get, even when the key cannot be resolved
   statically — then read via `__extern_get` with the runtime key.
   `obj-prop-name-evaluation-error.js` expects the key's throw.

**Rows claimed (12).** `language/statements/for-of/dstr/array-elem-iter-thrw-close.js`,
`array-elem-iter-thrw-close-err.js`, `array-elem-trlg-iter-list-thrw-close.js`,
`array-elem-trlg-iter-list-thrw-close-err.js`, `array-elem-trlg-iter-rest-thrw-close.js`,
`array-elem-trlg-iter-rest-thrw-close-err.js`, `array-rest-iter-thrw-close.js`,
`array-rest-iter-thrw-close-err.js`, `array-rest-lref-err.js`,
`array-elem-init-assignment.js`, `array-elision-val-symbol.js`,
`obj-prop-name-evaluation-error.js`.

**Growth.** `for-of-destructuring.ts` +220 (a new
`emitInterleavedArrayAssignmentDrive` ≤ 120 lines + per-target write helpers
factored out of the existing arms; `compileForOfAssignDestructuringExternref`
becomes a dispatcher); `statements/destructuring.ts` +15 if
`emitDefaultValueCheck`'s hole mapping lands there.

**Order constraints.** lref → next → default → PutValue per element; rest lref
before its drain; no close on `next()` abrupt; exactly one `return()` on any
other abrupt or on normal completion with `!done`; elision runs `next()`;
the SOURCE's `@@iterator` is called exactly once per element of the OUTER loop.

**Passing shapes at risk + how to check.**
- Host lane: gated — `cmp` the `.wasm` of
  `language/statements/for-of/dstr/array-elem-trlg-iter-list-nrml-close.js`
  compiled WITHOUT `--standalone` on base vs new: must be identical.
- Standalone: every `for ([a, b] of …)`, `for ([x, ...r] of …)`,
  `for ([[x]] of …)`, `for ([x.y] of …)`, `for ([x = d] of …)` that passes
  today — the 4 `dstr` rows in `forof-controls.txt` plus ALL currently-passing
  `language/statements/for-of/dstr/array-*.js` rows (list them from the
  baseline: `grep 'for-of/dstr/array-' .test262-cache/test262-standalone-current.jsonl | grep '"pass"'`
  — ~120 rows; run in batches of 15, one process at a time) and the
  `language/expressions/assignment/dstr/array-*.js` rows are NOT touched
  (different lowering) — run 10 of them as a negative control.
- `tests/issue-4447-*.test.ts` (for-of destructuring residual) and the
  equivalence gate.

### R3-8 — `===` between two `$BoxedNumber`s from different producers (3 rows) — LAST, own commit

**Root cause.** Probe f4: `[0,'a'][0] === a[0]` is FALSE at module scope. The
harness's `assert._isSameValue(a, b)` compiles to `__any_strict_eq` over two
`$AnyValue`s; the operands reach it under different tags (one side tag-6
`refval`, the other tag-5 `externval`, or tag-3 f64 vs a boxed ref — confirm
with a WAT read of the `__any_box_*` calls at the `a === b` site in `f4.js`).
The different-tag arm (`src/codegen/any-eq-helpers.ts:396-455`, #2175 V2-S3)
recovers both payloads to `eqref` and answers `ref.eq` — two distinct
`$BoxedNumber` structs holding `0` are unequal. The same-tag-5 arm already
classifies Number×Number numerically (`tag5ValueEqThen`,
`src/codegen/any-helpers.ts:1290+`, default-ON since 2026-07-16).

**Edit.** In `registerAnyStrictEqAndComparisonHelpers`' different-tag arm,
after `recoverRefPayload(0, 4)` / `(1, 5)` (`:434-435`) and BEFORE the
`ref.eq` identity test: if both locals 4/5 `ref.test $BoxedNumber` (the type
`addUnionImports` registers — find its typeIdx the way `__any_to_f64`'s #1888
recovery arm does, `any-helpers.ts` grep `BoxedNumber`) → unbox both
(`struct.get` the f64 field) → `f64.eq` (NaN self-unequal preserved). Also
cover "tag ∈ {2,3} on one side, `$BoxedNumber` payload on the other": route
through `__any_to_f64` on both and `f64.eq`. Keep the `ctx.standalone || ctx.wasi`
gate — host bytes unchanged. Mirror in `__any_eq`'s different-tag arm ONLY if
a probe shows `==` is affected too (do not touch otherwise).

**Rows claimed (3).** `language/statements/for-of/map.js`,
`language/statements/for-of/map-expand.js`,
`language/statements/for-of/map-contract-expand.js`. Likely cross-cluster
upside (every `«N» «N»` SameValue failure in the census) — report the delta,
do not claim it.

**Growth.** `any-eq-helpers.ts` +40 in `registerAnyStrictEqAndComparisonHelpers`.

**Why last and why its own commit.** This helper is under every `===` on
`any`-typed operands in standalone. #1888's first attempt at exactly this
classifier ejected at −162 rows (`any-helpers.ts:1225-1250` history) —
that mask has since been removed, but the blast radius has not. Ship it as
the final commit so it can be reverted alone.

**Passing shapes at risk + how to check.** `pnpm run test:equivalence:gate`
at baseline; `forof-controls.txt` both lanes; a 15-row sample from the
`class` and `dstr` families that pass today (the −162 victims were there:
`language/statements/class/dstr/*-ary-ptrn-elem-id-init-undef.js` ×5,
`*-ary-ptrn-elem-id-iter-val.js` ×5, `language/expressions/assignment/dstr/array-elem-init-undef.js`
and 4 siblings); `built-ins/Object/is/*` ×3 and
`language/expressions/strict-equals/*.js` ×5 (all pass today per the baseline).
`undefined === undefined`, `NaN === NaN` (false), `0 === -0` (true) must be
checked with a 6-line probe through `probe-one.mts` before and after.

### Out of scope in r3 (48 rows) — do not touch

- **Generator carrier (35):** every row whose error is
  `standalone target emitted host imports: env::__create_generator …` (23,
  incl. the 3 `*-ary-ptrn-elem-id-iter-val-array-prototype.js` rows that
  override `Array.prototype[@@iterator]` with a `function*`) or `native
  generator lowering currently supports only sequential numeric yields`
  (12, the `*-rtrn-close*.js` family). Owner: #680 / #2864.
- **Realms (5):** 4× `proto-from-ctor-realm.js`, `Symbol/iterator/cross-realm.js`
  — #3371.
- **Parser (1):** `dstr/array-elem-init-in.js`.
- **`Symbol/iterator/prop-desc.js` (1):** the 12-row `Symbol/*/prop-desc.js`
  family in `other-builtins.tsv` (well-known symbols are not own properties of
  the `Symbol` ctor) — one fix, one owner, not here.
- **Species (2), accessor identity (4):** see R3-7 / R3-3.

### Acceptance (whole pass)

- Row lists green per step (R3-6 with `--isolate`); expected flips
  **53 max, ≥ 40 is the bar** (R3-4's 2 stretch singles, R3-7(b)'s
  hypothesis-level 2, R3-8's 3 and R3-1(b)'s dynamic-route rows are the
  uncertain part). Report every unflipped row with its residual error.
- Every "passing shapes at risk" check above executed and quoted in the PR
  body — the byte-identity ones as `cmp` results on the named files, the
  control ones as pass counts against the stated baselines. A step whose
  checks were not run is not shippable.
- `imports-of.mts` on `Map/iterator-items-are-not-object.js`,
  `WeakMap/iterator-close-after-set-failure.js`,
  `MapIteratorPrototype/next/iteration.js` → `[]` (no `env::*` leak).
- Gates chained before every commit (also with `LOC_GATE_BASE` = upstream
  main tip); `pnpm run test:equivalence:gate` at baseline after R3-4(c),
  R3-5 and R3-8; `tests/issue-5267-es2015-forof-iterators-r2.test.ts` 17/17.
- No edits to `tests/test262-runner.ts`, skip lists, `scripts/*baseline*.json`;
  no new host imports; no `--no-verify`.
