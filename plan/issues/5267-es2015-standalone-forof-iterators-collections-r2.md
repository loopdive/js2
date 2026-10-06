---
id: 5267
title: "ES2015 standalone: for-of + iterator prototypes + collections — r2 residual pass"
status: done
completed: 2026-09-04
sprint: current
created: 2026-09-01
updated: 2026-09-28
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

## 2026-09-04 r3 implementation (Opus)

Worktree `/home/user/js2/.claude/worktrees/wf_9d1e6808-4e2-1`, branch
`worktree-wf_9d1e6808-4e2-1`, merge-base `a754fc7c96`. Base tree for every
measurement below is a `git archive` of that merge-base under
`.tmp/basetree/` (own node_modules / test262 / .test262-cache symlinks).

Measurement corpus (built once, from
`.test262-cache/test262-standalone-current.jsonl` stamped 2026-09-04 01:18):
the 1,586 rows of `language/statements/for-of/**`,
`built-ins/{Map,Set,WeakMap,WeakSet}/**`,
`built-ins/{Map,Set}IteratorPrototype/**` split into
`.tmp/r3/base-pass.txt` (1,396) and `.tmp/r3/base-nonpass.txt` (190).
A full 1,586-row sweep costs ~2.5 h on this box (measured 5.8 s/row at load
9-10, three agents sharing 4 cores), so it is NOT re-run per step; per step
the corpus is (a) the step's claimed rows, (b) the 94 non-pass `built-ins/**`
rows — the flip detector, and (c) 197 currently-passing
`{Map,Set}IteratorPrototype/**` + `Map|Set/prototype/{entries,keys,values,forEach,delete,clear,size}/**`
rows — the regression detector. Deviation from the plan's "whole enclosing
directories every step" stated here because it is a real reduction in
coverage: it is a load-and-time decision, not a claim that the rest cannot
regress.

### Step R3-1 — `map[Symbol.iterator]()` yields the live entries/values record (commit 1)

**What changed.**

- `src/codegen/expressions/call-tail-dispatch.ts`, `compileTailDispatch`'s
  `@@iterator` arm: a Map/Set receiver (TS symbol name off the ALREADY-computed
  `receiverType`, no new checker call) whose speculative compile lowers to
  `ctx.mapTypeIdx` now emits `emitLiveCollectionIterRec(… "entries"|"values")`
  directly — §24.1.3.12 / §24.2.3.11 make `Map.prototype[@@iterator]` BE
  `entries` and `Set.prototype[@@iterator]` BE `values`, so the product is by
  construction the same record `map.entries()` yields. Gated
  `(ctx.standalone || ctx.wasi) && ctx.nativeStrings`; the probe is a
  `snapshotSpeculative`/`rollbackSpeculative` transaction so a declining
  receiver leaves no bytes; extra call arguments are still evaluated and
  dropped. Plan step R3-1(a).
- `src/codegen/map-runtime.ts`, `ensureMapHelpers`' `__map_iter_next`: the done
  branch parks `IT_INDEX` at `0x7fffffff` before returning `{value:null,
  done:1}`, so a later `set`/`add` that grows `M_ENTRYCOUNT` cannot revive an
  exhausted cursor (§24.1.5.1). Plan step R3-1(c).
- `emitLiveCollectionIterRec` exported (was module-private).

**Not done from R3-1: (b), the dynamic `__iterator` ladder root cause.** (a)
is a static reroute that makes the five claimed rows correct without touching
the ladder, and it is the deterministic half of the plan's own edit list. The
ladder is still wrong for a Map reached through a variable holding
`Map.prototype[Symbol.iterator]` (probe `b2.js` in the r2 census) — that
closure route is unmeasured here and remains open.

**Measured.**

| corpus | base | lane |
|---|---|---|
| 5 claimed rows + 4 named controls (`.tmp/r3/rows-R3-1.txt`) | 4 pass / 5 fail | **9 pass / 0 fail** |
| 94 non-pass `built-ins/**` rows | 94 non-pass (baseline) | 89 non-pass, **exactly the 5 claimed flipped**, no other movement |
| 197 passing iterator/collection rows | pass (baseline) | **197 / 197 pass** |

Behaviour probes (`.tmp/p/*.js`, run through the runner's own
`runTest262File`, so the harness and verdict rules are the real ones):

| probe | node | base standalone | lane standalone |
|---|---|---|---|
| `t1` ordinary for-of (array/string/Map/Set/`map.keys()`) | pass | pass | pass |
| `t2` `map[Symbol.iterator]()` / `set[Symbol.iterator]()` stepping | pass | **fail** (`Cannot access property on null or undefined`) | **pass** |
| `t3` sticky exhaustion after `add` | pass | **fail** (`«false» «true»`) | **pass** |
| `t4` labelled break/continue + closures over the loop variable | pass | **HANGS** (>250 s, killed) | HANGS — identical to base, pre-existing, NOT caused here |
| `t5` `[k,v]` heads + mutation during iteration | pass | pass | pass |
| `t6` `for (e of m)` with a pre-declared assignment-target head | pass | **fail** (`«""» «"ab"»`) | fail, byte-for-byte the same error — pre-existing |

`t4`'s hang and `t6`'s wrong answer are pre-existing defects the probe set
found; both reproduce identically on the base tree. They are reported, not
fixed, and are not in this cluster's claimed set.

Byte identity (`.tmp/p/compile.mts`, sha256 of the emitted binary):

| program | target | base | lane |
|---|---|---|---|
| `n1.js` (no Map/Set) | standalone | `cbf5728b3c5a39c0` | **identical** |
| `n1.js` | wasi | `3f360921a91ac5a2` | **identical** |
| `n1.js` | js-host | `720c220ab7a44a75` | **identical** |
| `t2.js` (Map+Set) | js-host | `0734f221a6d8084a` | **identical** — the js-host lane is untouched |
| `t2.js` | standalone / wasi | differs (19 bytes smaller) | intended |

The wasi lane cannot be EXECUTED by this harness (it instantiates without a
`wasi_snapshot_preview1` object, so every wasi probe dies at instantiate on
base and lane alike); wasi is therefore covered here by compile success +
byte identity of the Map-free control, not by execution.

**Pin.** `tests/issue-5267-r3-1-map-symbol-iterator.test.ts` (3 cases, wasi
lane, `hostImports` asserted empty). On the base tree **1 of 3 fails** (the
sticky-exhaustion case); the two `@@iterator` cases PASS on base in the wasi
lane — i.e. the null-record defect reproduces on the `standalone` target and
in the test262 wrapping, not in this hand-written wasi shape. Stated plainly
because it makes those two cases forward regression pins rather than proof of
the fix; the proof for them is the row table above.

### Step R3-6 — for-of over an ARRAY honours `delete Array.prototype[Symbol.iterator]` (commit 2)

**What changed.** `emitArrayIteratorDeletedGuard` (the #5139 guard, previously
private to `destructuring-params.ts` and wired into binding patterns only) is
exported and called from `compileForOfArray` right after the vec type is
confirmed. It emits ZERO bytes for a module without such a delete — the flag
global is rooted only by the pre-scan that sees one. `preVec` receivers
(Map/Set projections, not arrays) are not guarded.

**Gated on `ctx.standalone`, NOT on wasi — deliberately, and this is a real
narrowing of the plan.** Measured 2026-09-04: the TypeError this guard raises
is caught by a COMPILED `try { … } catch (e) { … }` on the `standalone` target
(probe `t7.js`: base `"ran"` → lane `"TypeError"`), and on the `wasi` target
the same source lets a raw Wasm exception escape to the embedder instead
(the vitest pin failed there with a `Function<Exception>` object, not a
TypeError). Enabling the guard on wasi would therefore turn a silently-wrong
loop into an UNCATCHABLE module-level throw — worse than base by the ship
gate's own rule. The wasi exception-tag gap is pre-existing and out of scope;
wasi keeps base behaviour and stays byte-identical.

**Measured.**

| corpus | base | lane |
|---|---|---|
| 3 claimed rows, `--isolate` | 3 fail (`Expected a TypeError … no exception`) | **3 pass** |
| all 53 currently-passing `*array-prototype*` rows in the standalone baseline, `--isolate` | pass | **53 / 53 pass** |
| 30 passing `language/statements/for-of/*.js` rows | pass | **30 / 30 pass** |
| `n1.js` (array for-of, no delete) sha256, standalone / wasi / js-host | `cbf5728b…` / `3f360921…` / `720c220a…` | **identical on all three** |

**Pin.** `tests/issue-5267-r3-6-forof-array-iterator-deleted.test.ts` — 2
cases on the `standalone` target (positive: catchable TypeError; negative: a
module without the delete still iterates). Verified **FAILING on the base
tree** (`expected 6 to be 42`) and passing on the lane.

**Note for a later lane.** The delete must be written verbatim as
`delete Array.prototype[Symbol.iterator]` — `arrayProtoIteratorOverrideKeyFromTarget`
matches the exact AST, so `delete (Array.prototype as any)[Symbol.iterator]`
(the TS-typechecking form) roots no flag and the guard never fires. That is
why the pin compiles with `allowJs` + `skipSemanticDiagnostics`.

### Step R3-7(a) — `Map/Set.prototype[Symbol.iterator]` is an OWN property (commit 3)

**What changed.** `"@@1"` added to `MAP_PROTO_METHODS` and `SET_PROTO_METHODS`
(`array-object-proto.ts`), and `makeCollectionGlue`'s `memberAliasOf` extended
so `@@1` aliases `entries` (Map) / `values` (Set) — the Array `@@1` pattern
verbatim. `memberLength` returns 0 for `@@1` alongside `size`. The value read
already aliased the right closure; only `hasOwnProperty` was false.

**Measured.**

| corpus | base | lane |
|---|---|---|
| 2 claimed rows + 6 named identity/metadata controls | 6 pass / 2 fail (`Symbol() should be an own property`) | **8 pass / 0 fail** |
| 94 non-pass `built-ins/**` rows (cumulative after R3-1, R3-6, R3-7a) | 94 non-pass | 87 non-pass — **7 flipped, all claimed; nothing else moved** |
| 197 passing iterator/collection rows | pass | **197 / 197 pass** |
| probe `t8.js` (no `"@@1"` string key in `getOwnPropertyNames(Map.prototype)` / `Set.prototype`; `@@iterator === entries`/`values`; `Set.keys === Set.values`; `hasOwnProperty` both; a Map still iterates) | — | node **pass**, lane standalone **pass** |

**Pin.** `tests/issue-5267-r3-7a-collection-symbol-iterator-own.test.ts`,
verified FAILING on the base tree (`expected 28 to be 31` — the two
`hasOwnProperty` bits are the missing 1+2).

**Not done from R3-7:** (b) the `size` gOPD `d.set` read (2 rows) and (c)
`Map/prototype/set/append-new-values.js` (1 row) — untouched, and the species
pair stays deferred per the plan.

### Step R3-3(b) — CanBeHeldWeakly moves inside the intrinsic adder (commit 4)

**What changed.** In `emitNativeCollectionCtorIterableDrive`
(`new-super.ts`) the `isWeak` holdable test is no longer emitted in the
per-entry body; it is prepended to `directAdd`, the branch that actually calls
`__map_set` / `__set_add`. §24.3.3.5 step 4 / §24.4.3.1 step 4 put the test
INSIDE the intrinsic adder, so a user-patched `WeakMap.prototype.set` /
`WeakSet.prototype.add` must be CALLED first and its own abrupt completion
wins.

**R3-3(a) was implemented, measured, and REVERTED — it bought nothing.** The
plan's diagnosis (absent index → `ref.null.extern` → null anyref key → trap in
`__hash_anyref`) is not what the two remaining rows hit. I added the
null→`undefined` normalise on both `__extern_get_idx` reads AND a null-guarded
`Type(nextItem) is Object` test (`__typeof_object`/`__is_truthy` on a null
externref were the other trap candidate); with both in place
`Map/iterator-items-are-not-object.js` and
`WeakMap/iterator-items-keys-cannot-be-held-weakly.js` STILL trapped with the
identical message (`dereferencing a null pointer in __closure_75() at source
L46`), and reverting them changed nothing (7 pass / 2 fail either way). Probe
`t9.js` locates it: `new Map([undefined])` and `new Map([["a",1],2])` both trap
at module scope, i.e. in the **literal-array seeding path**, not in the
iterable drive this step edits. Those 2 rows stay open with that pointer; ~40
lines of unexercised code were not worth shipping for them.

**Measured.**

| corpus | base | lane |
|---|---|---|
| 4 claimed rows + 5 named controls | 5 pass / 4 fail | **7 pass / 2 fail** (the 2 above, unchanged error text) |
| 62 passing `WeakMap`/`WeakSet`/`Map`/`Set` constructor+iterable rows | pass | **62 / 62 pass** |

**Pin.** `tests/issue-5267-r3-3b-weak-ctor-adder-order.test.ts` — 2 cases
using the rows' own custom-iterable shape (an entry `[]` / a primitive value
plus a patched adder). Verified FAILING on the base tree (`expected +0 to be
11` — the patched adder was never called) and passing on the lane. My first
attempt used `new WeakMap([[1, 1]])` and passed on base too: that literal form
takes the seeding path, not the drive. Recorded because it is the same trap
the plan's row list can hide.

### Step R3-4(a) — a throwing `next()` / `value` getter must NOT close the iterator (commit 5)

**What changed.** `compileForOfIterator` allocates an i32 `__forof_in_next`
local, sets it to 1 immediately before `call __iterator_next` and back to 0
right after the done-check, and `closeOnThrowBody`'s condition becomes
`doneFlag == 0 && in_next == 0`. §14.7.5.7 step 6: only a binding/body abrupt
completion (and `break`/`return`) runs IteratorClose; an abrupt IteratorStep /
IteratorValue returns without it.

**NOT standalone-gated** — the close matrix is shared codegen and the fix is
spec-correct on both lanes. Measured on both (below); the js-host lane flips
the same two rows and loses none.

**Measured.**

| corpus | base | lane |
|---|---|---|
| 2 claimed rows + 16 close-matrix controls, standalone | 16 pass / 2 fail (`Iterator is not closed. «1» «0»`) | **18 pass / 0 fail** |
| the same 18 rows, **js-host** | 16 pass / 2 fail | **18 pass / 0 fail** |
| 131 passing `language/statements/for-of/**` rows (every 5th of the 655 base-pass rows) | pass | **131 / 131 pass** |
| probe `t10.js` (body throw closes once · `next()` throw does not close · `break` closes · normal completion does not) | node pass, **base fail** (`next throw does not close «2» «1»`) | **pass** |

**Pin.** `tests/issue-5267-r3-4a-forof-next-abrupt-no-close.test.ts`, standalone,
verified on base as `expected 12 to be 1` (base closes after BOTH throws).

**Host-lane finding, reported not fixed.** On the pin's hand-written source the
js-host lane answers 0 on base AND on this tree — it does not close on a BODY
throw in that shape either. The real rows do flip on the host lane, so this is
a separate pre-existing host gap; the pin deliberately does not assert it (a
characterization test there would pin wrong behaviour).

**Not done from R3-4:** (b) the `next`-read-once `$__IterRec` field (the
16-producer change), (c) the §7.4.2 non-Object `next()` result TypeError, and
the two stretch rows (d)/(e). Untouched.

### Step R3-2 (metadata slice only) — own `next` on the collection iterator prototypes (commit 6)

**What changed.**

- `src/codegen/builtin-brands.ts`: two APPENDED brands, `MapIterator` (+46)
  and `SetIterator` (+47); `BUILTIN_BRAND_COUNT` 46 → 48. Append-only contract
  honoured, nothing renumbered.
- `src/codegen/array-object-proto.ts`:
  `ensureCollectionIteratorNativeProtoGlue(ctx, "Map"|"Set")` — `makeGlue` with
  the single member `next` and `memberLength: () => 0`; and
  `emitIteratorPrototypeSingleton` seeds an own `next` data property
  (`{w:T, e:F, c:T}`) on the Map/Set singletons via
  `ensureStandaloneNativeMethodClosure(…, refusalBodyFallback: true)` — the
  §5099 String-iterator recipe, generalised.

**Scope taken, and what it costs.** The plan's R3-2 is 14 rows and needs a real
`emitIterRecNextBody` (brand + kind test + `__iter_next_result`) plus an
`$__IterRec` arm in `__extern_get` so `iterator.next` reads as a VALUE. I
shipped only the **metadata half**: the descriptor-carrying closure with a
REFUSAL body. That flips the 4 `{name,length}` rows (G4). The 10
`this-not-object-throw-*` / `does-not-have-*-internal-slots` rows (G3) are NOT
flipped — they end with `iterator.next.call(map[Symbol.iterator]())` and
require the stepping body — and are left open with that pointer. A refusal
body cannot satisfy them: it throws for every receiver, including the valid one.

**Measured.**

| corpus | base | lane |
|---|---|---|
| 4 claimed metadata rows + 7 named controls (String-iterator `next/{name,length}`, both `@@toStringTag` rows, the two `iteration` rows, `Map/prototype/keys/returns-iterator`) | 5 pass / 6 fail | **11 pass / 0 fail** |
| 94 non-pass `built-ins/**` rows (cumulative over commits 1-6) | 94 non-pass | 81 non-pass — **13 flipped, every one claimed; nothing else moved** |
| 197 passing iterator/collection rows | pass | **197 / 197 pass** |
| 40 passing `String`/`Array` iterator-prototype + `Iterator`/`GeneratorPrototype` rows (the brand-table blast radius) | pass | **40 / 40 pass** |

**Pin.** `tests/issue-5267-r3-2-collection-iterator-proto-next.test.ts` — 2
cases reading the descriptor off `getPrototypeOf(new Map().keys())` /
`new Set().values()`. Verified FAILING on the base tree (both).

### Whole-pass result (r3, Opus lane, 2026-09-04)

Six commits on `worktree-wf_9d1e6808-4e2-1`, merge-base `a754fc7c96`:
R3-1 · R3-6 · R3-7(a) · R3-3(b) · R3-4(a) · R3-2 (metadata slice).

**Flips: 18** (plan's bar was ≥ 40 of a claimed 53 — see "what was not done").

| step | rows flipped |
|---|---|
| R3-1 (`@@iterator` live record + sticky exhaustion) | 5 |
| R3-6 (`delete Array.prototype[@@iterator]` in the array for-of) | 3 |
| R3-7(a) (collection `@@iterator` own-ness) | 2 |
| R3-3(b) (patched weak adder before CanBeHeldWeakly) | 2 |
| R3-4(a) (throwing `next()` does not close) | 2 |
| R3-2 (own `next` metadata on the two iterator prototypes) | 4 |

**Whole-corpus verification (the ship gate).** Every one of the **1,396
currently-passing rows** of `language/statements/for-of/**`,
`built-ins/{Map,Set,WeakMap,WeakSet}/**` and
`built-ins/{Map,Set}IteratorPrototype/**` was re-run on the lane at the final
tree: **1,396 / 1,396 pass — zero new non-pass.** Of the 190 non-pass rows,
all 190 were re-run: 18 flipped to pass, 172 stayed non-pass with their
baseline error text. 40 `String`/`Array`/`Iterator`/`GeneratorPrototype` rows
covered the brand-table blast radius (40/40). The js-host lane was measured on
the 18-row close matrix (16 → 18 pass) and pinned byte-identical
(sha256) for a Map+Set program across R3-1; the R3-4(a) change is
deliberately not host-gated and improves the host lane by the same 2 rows.

**Caveat, stated because it bounds the claim:** for the 172 rows that were
already non-pass, I verified the ERROR TEXT is unchanged only for the groups
each step touched, not row-by-row against a base run of all 172.

**What was NOT done (36 of the 53 claimed rows), with pointers:**

- **R3-5 (12 rows)** — the interleaved assignment-pattern drive. Not started;
  it is ~220 lines of new emission and did not fit the window.
- **R3-2's behavioural half (10 rows)** — needs `emitIterRecNextBody` plus an
  `$__IterRec` arm in `__extern_get`. The brands, the glue and the singleton
  seeding it builds on are now on the branch, so the remaining work is the
  body and the value-read arm.
- **R3-3's 2 trap rows** — root-caused to the LITERAL array seeding path, not
  the iterable drive (probe `t9.js`: `new Map([undefined])` traps at module
  scope). The plan's (a) edits do not reach them; see the R3-3 section.
- **R3-4 (b)/(c) and the two stretch rows (4)** — untouched.
- **R3-8 (3 rows)** — not started. It is the `$BoxedNumber` `===` classifier;
  the plan itself flags it as the highest-blast-radius change and it needs the
  equivalence gate, which does not fit what is left.
- **R3-9 (1 row)** — not started (needs the bisect the plan describes).
- **R3-7 (b)/(c) (3 rows)** — not started.

**Two pre-existing defects the probe set found (neither is in this cluster's
claimed set, both reproduce identically on the base tree):**

1. `.tmp/p/t4.js` — a labelled `continue`/`break` over nested for-of loops with
   closures **HANGS the compiler** (>250 s, killed) on `standalone`, on base
   and lane alike.
2. `.tmp/p/t6.js` — `for (e of m)` with a PRE-DECLARED assignment-target head
   over a Map yields nothing (`«""»` instead of `«"ab"»`), base and lane alike.

## Handover (2026-09-04, session claude/es6-test262-standalone-g10c7u)

**State.** r3 pass implemented by an Opus-medium lane in
`.claude/worktrees/wf_9d1e6808-4e2-1` (branch `worktree-wf_9d1e6808-4e2-1`,
base `a754fc7c96`): steps R3-1, R3-7(a), R3-3(b), R3-4(a) and the metadata
half of R3-2 are kept (15 rows); **R3-6 is reverted** (commit `fc29ea3c68`,
3 rows given up) after the adversarial review confirmed, with three
independent skeptics, that the deleted-`@@iterator` latch it extended to the
array for-of fast path (a) stays set after `Array.prototype[Symbol.iterator]`
is restored by assignment, so a plain array for-of throws where node and base
iterate, (b) fires for for-of over `arguments`, (c) fires for typed arrays
(own `@@iterator`), and (d) is raised by `delete Array.prototype.values` too.
The pre-existing #5139 destructuring guard shares all four defects; the
`tryEmitArrayProtoIteratorDelete` latch in `proto-override.ts` is set and
never cleared.

**Verified clean by the review** (node / base / lane, host + standalone +
wasi executed): the 35-case for-of close matrix (R3-4a, per-loop flag),
sticky Map/Set iterator exhaustion incl. spread/Array.from/destructuring
consumers, the "@@1" own-property alias (no string leak, descriptor and
identity match node), the MapIterator/SetIterator brands (27 builtins'
`toString` tags unchanged), the WeakMap/WeakSet adder order. Standalone
modules grow by 20 bytes each (the prelude's Map/Set CSV literal now starts
with "@@1,"); host bytes change for every for-of over a non-array iterable
(R3-4a is ungated).

**Not done / next pass.** R3-5 (12 rows), the behavioural half of R3-2 (10
rows), R3-3(a) (root cause is the literal array seeding path, not the
iterable drive), R3-1(b), R3-4(b)/(c), R3-7(b)/(c), R3-8, R3-9 — all named
with reasons in the r3 implementation section. Re-doing R3-6 needs: gate on
a genuine Array receiver (exclude IArguments / typed arrays), clear or re-key
the flag on an `Array.prototype[Symbol.iterator] = …` assignment, and stop
mapping the `values` delete onto the `@@iterator` flag — then fix #5139's
destructuring guard the same way. Pre-existing defects found by the review
and worth their own issues: `new Map(map)` / `new Set(set)` copies and
several WeakMap/WeakSet programs emit modules that fail Wasm validation
(`return_call expected (ref null 6), found anyref`) on standalone and wasi;
`for await` over a custom async iterable TypeErrors on standalone; a
labelled continue/break over nested for-of with closures hangs the compiler.

**Rows gated on #2864** (native generator carrier) are not this issue's.

## 2026-09-28 narrow handoff — Array `@@iterator` deletion in direct array for-of (documentation only)

**Status boundary.** This is a diagnostic handoff, not an implementation
reopening or a source/test/runner change. The issue remains historically
`done`; the slice-lock status check for `#5267:array-iterator-deletion-triage`
was unassigned, but no claim was taken because the parent issue is closed. A
lead must explicitly reopen/allocate a source slice before anyone changes this
   area.

**Measured original identity, not a population claim.** The frozen ES2015
manifest run on source `f924650c6c26237f62b08a362d7003d4d2b1e12d` recorded
`test/language/statements/for-of/dstr/const-ary-init-iter-get-err-array-prototype.js`
in shard 3/128 (`es2015-fullscope-128-f924650-chunk003-a01`): 92 registered,
92 recorded, 92 canonical verdicts, 92 callbacks settled, and this row failed
with `Test262Error: Expected a TypeError to be thrown but no exception was
thrown at all` (compile 1160 ms, exec 19 ms). The original first executes
`delete Array.prototype[Symbol.iterator]`, then expects the binding-pattern
head `for (const [x, y, z] of [[1, 2, 3]])` to throw `TypeError`.

That is one measured frozen identity only. The `let` and `var` siblings are the
next required original controls, not inferred failures; this result also does
not by itself prove a cause across the distinct documentation-base and frozen
measurement snapshots.

**Current direct-path source evidence (source-supported inference only).**

- `src/codegen/array-proto-iterator-override-ast.ts:43-50` intentionally
  recognizes both `delete Array.prototype[Symbol.iterator]` and `delete
  Array.prototype.values` through the same delete-key helper.
- `src/codegen/expressions/proto-override.ts:191-194` roots one
  `@@iterator:deleted` slot for either recognized delete; `:225-232` writes it
  to `1`. In that module, the ordinary function/arrow assignment capture writes
  a separate override-closure slot (`:90-123`), not this deletion slot.
- The deletion slot's only current read is the private guard in
  `src/codegen/destructuring-params.ts:1802-1807`, called by its parameter
  destructurer at `:1860-1865`. `compileForOfArray` reaches the confirmed vec
  path in `src/codegen/statements/loops.ts:1899-1964` without a deletion-slot
  read. Together with the frozen row, this supports the narrow hypothesis that
  the direct array fast path can bypass the deleted-iterator state; it is not a
  runtime attribution for every array-destructuring path.

**Non-negotiable historical constraint.** Commit `fc29ea3c68` reverted
`e939c8b838` after the earlier direct-path guard was shown to be sticky after a
later `Array.prototype[Symbol.iterator] = ...` restoration, to fire for
`arguments` and typed arrays, and to fire after deleting
`Array.prototype.values`. Do not re-export/call the old broad deletion guard,
globally tighten GetIterator, or treat `values` deletion as `@@iterator`
deletion. The pre-existing parameter-destructuring guard has the same known
limitations and is not proof that a direct-loop transplant is safe.

**Required pre-dispatch and control plan (no execution authorized by this
note).**

1. Reconfirm the exact `const` original on a fresh, source-keyed standalone
   provider with the maintained runner and isolation; then run the exact
   `let`/`const`/`var` three-path cohort with an expected-path receipt. Require
   nonempty registration, one verdict per expected path, settled callbacks and
   zero exclusions before interpreting a result.
2. Before proposing a fix, add focused controls for: delete → direct array
   binding-head TypeError; delete → restore `Array.prototype[Symbol.iterator]`
   → normal array iteration; delete → `arguments` iteration; delete → typed
   array iteration; and `delete Array.prototype.values` → normal
   `@@iterator`-driven array iteration. Preserve an ordinary no-delete
   array-for-of output/behavior control.
3. The implementation owner must first obtain explicit clearance from the
   active IR/direct-frontend ownership program (#3518, *IR-only default and
   direct front-end retirement*) for the direct codegen seams
   `proto-override.ts`, `loops.ts`, and `destructuring-params.ts`. Inventory
   the deletion-slot readers and mutators before selecting one genuine-array
   admission point. No `src/ir/**` routing change, shared global semantic
   change, or ownership claim follows from this handoff.

## 2026-10-05 allocated slice — no-catch finally self-reentry (provisional)

**Reservation and scope.** Parent expressly allocated
`src/codegen/statements/exceptions.ts::compileTryStatement`'s no-catch finally
path to Codex GPT-6.1 Sol High. This is a local issue-MD reservation, not a
GitHub assignment or reopening of every historical #5267 slice. The reviewed
ownership ledger is `06689ca363ec1f99c88cc5148cad5143c39b6d05`. No allocator,
context schema, iterator, generator, inference, runner, provider, oracle,
foreign IR migration, or other source file is in scope.

**Fresh candidate base.** The dedicated worktree is
`/Users/thomas/Code/js2/.codex-worktrees/5267-finally-once-sol61`, branch
`codex/5267-finally-once-sol61`, based on parent-verified latest upstream main
`4d42eec28e0aafbf242bb37150ca5ecac02136f0`. The exception emitter is unchanged
from the earlier `40797360d6268c329b9a4aadcb48f100af1dcff4` baseline (pre-edit
SHA256 `04fac10ebd0e1d38dd8c93a7dda8bb465b0a20ecbb6e204254a004f49787c6d8`).
Other compiler/IR presentation files changed between those commits; the old
measurement is causal evidence, **not** a matched candidate A/B result.

**Required immutable design pin.** Astra's complete planning-worktree issue
MD, including its private-marker refinement at lines 2265–2358, has SHA256
`bc527ef86e39fc05a0276fc97aad1cd3b9a70411bf84c565c55a0ba23601597b`.
The implementation follows that refinement: reserve an ordinary private i32
local named `finally@entered$<absolute-index>` before compiling finally;
append directly to locals, never source-name maps or reusable temporary pools.
Each fresh clone (including depth-adjusted and zero-extra-depth clones)
prepends set-one. Reset is outside the protected try after restoring the outer
body/depths. The standardized handler saves its incoming payload first and
throws that same payload if already entered. The legacy catch_all uses
`rethrow 1` inside its one-label guard and retains the original `rethrow 0`
after the ordinary handler clone. Catch-bearing paths retain their existing
behavior. No label wraps a finally clone, and no shared lowering helper changes.

**Actual old-baseline first loss.** The frozen worktree
`5267-finally-reentry-sol61` and its reviewed programs/artifacts are untouched.
Its one executed official original was
`language/statements/for-of/throw-from-finally.js`, SHA256
`58fc041b3b0d9602667d9c6676562145b6e5ae010debf7786d8e61760b1c193b`.
The maintained original harness, standalone target, auto semantic providers,
primary-first/conditional-strict workflow produced an actual reached-test
runtime FAIL: `Expected SameValue(«2», «1») to be true`.
Its captured 400997-byte binary has SHA256
`80fc77571da07bfd6086bdd9eeb6f9c6873ced2597b4e939aa93b7e4c362bfd9`.
The original runtime wrapper subsequently failed its separate default WAT
diagnostic; the old receipt remains incomplete, not relabeled complete.

A separately authorized `wasm-dis --all-features` diagnostic decoded that
same binary without compiling or executing again. Its WAT has SHA256
`f8421b86370268a6b59c1fa4833e44f371d11b1e33c3e1d521b5a491e496f25e`.
In `$__closure_68`, the inner protected normal clone increments counter
global 31 then throws carrier global 32 (lines 210539–210552). Its own handler
stores that payload in local 10 then increments the same counter AGAIN and
throws the same carrier (210557–210569). The second increment at 210557 is
the first wrong observable effect; IteratorClose occurs later at
210639–210670 and is not the repair seam. Diagnostic receipt SHA256:
`a0c1fbf1e8ade9e3a5cf7f875b1df34ed9dca47fc8073fea8739144f968a174d`.

**Authored acceptance coverage (NOT_RUN).** The new focused test file is
`tests/issue-5267-finally-reentry.test.ts`. Its 66 declared cases cover both
gc/legacy and standalone/standardized EH: normal/throw/return/break/continue
try completions, normal/throwing finally, plain/nested-if abrupt sites,
ordered effects, exact pending/replacement object identity, loop-entry reset,
nested finalizers, recursion, nested-loop branch depths, finally
return/break/continue overriding a pending throw, legitimate similarly named
source variables with closure/literal-direct-eval reads, and generator close
exactly once. Four structural cases pin private map/free-list absence, reset
placement, fresh clone writes, distinct slots, payload preservation, legacy
rethrow depths, numeric remapping and speculative-local rollback. Two host
cases pin actual foreign JS exception identity from try/finally and one
finalizer execution. These are authored expectations, not verified passes.

**Remaining gates.** Execution is NOT_RUN on this latest-base candidate.
The two old-baseline official controls (`throw-from-catch.js`, `throw.js`) and
two plain diagnostics remain pending in the frozen recovery packet; do not
rerun the already captured first target. Before publication require a fresh
matched latest-main baseline/candidate build and original-harness comparison,
removal/restoration attribution, focused suite and #2061/#4249/#4716 controls,
finite non-vacuous abrupt-for-of/try family coverage, and normal repository
gates under a separate heavy-work grant. No PR, score improvement, finished
issue claim, build/cache receipt reuse across source changes, or global
population claim is justified by pure authoring.

### 2026-10-06 measured latest-main comparison and fixture correction

Both measurement arms now use base
`4d42eec28e0aafbf242bb37150ca5ecac02136f0`: clean baseline worktree
`5267-finally-latest-baseline-sol61` and candidate `5267-finally-once-sol61`.
Each has its own ordinary compiler/runtime bundles and maintained keyed native
provider cache. Four normal commands passed with actual exit/close/EOF and
source-input equality; command 3 alone used the documented three-file native
artifact selector, command 4 used normal `--require-cache` HIT and linked-pair
verification. Baseline build `5267-build.qDmIcG` postflight SHA256
`2d97fcf68ca385679c3fa5ea959a6815ecc7a0150bbf08babae1e6ae7468dfe7`;
candidate build `5267-build.96svYu` postflight SHA256
`4c6ea0cba982884bcd85b14ffb6b6ecb59b573459dfca696cabb19952075806d`.

Maintained original-harness standalone/auto, unchanged metadata/bodies and
primary/conditional-strict processing measured exactly three official bodies
plus two plain diagnostics per arm (all strict-neutral, 3+2 variants). Baseline
`5267-originals.OD48S2` receipt SHA256
`a543396cfcb629919db1f77e29ee42d82dc2285ccec55208aacada75006dd84f`:
`throw-from-finally.js` FAIL, `throw-from-catch.js` PASS, `throw.js` PASS,
plain normal-finally PASS, plain throwing-finally FAIL. Both failures are
counter 2 instead of 1. Candidate `5267-originals.EdvAW1` receipt SHA256
`b2cdb772b398b62ea25c4c82d1f53b6306a1a3570ff7dd0590f057e7e9b11b39`:
ALL FIVE PASS. All ten workers have one ready/send/result, actual successful
exit/close, both stream EOF/close, executed WASM/meta matched to the owning
compiler bundle, no observation deadlines, and no transport errors. Each
physical floor and before/after input proof is complete. This is one official
flip plus one diagnostic flip, not a global goal-score claim.

The initial exact focused run (`5267-focused.NQYSjQ`) executed all 66 unique
expected titles: 64 PASS, 2 FAIL, no excluded/duplicate/missing titles. Receipt
SHA256 `42296ddf095fa9ce8dc282e5e79d5d54d8d07277f7e30a8d34f4ca637ca7d587`.
Both failures are the combined global-source-name/closure/literal-eval fixture
(expected 18, observed 0). The exact original test file is preserved privately
as `.tmp/5267-original-focused-test.ts`, SHA256
`945c7fda61ad1dfb8fcd4f80c1c18a9ca4413e5a42b7b382afd2724c89e6b816`.
Its unchanged fixture source/options were then run on BOTH latest arms in
BOTH gc and standalone: all four reproduce 0 instead of 18. Therefore these
are inherited fixture dependencies, not a production-patch regression.
The original failed receipts remain immutable. Vitest 3.2.4's JSON reporter
does not include an unhandled-error field: the receipt records unavailable,
not a fabricated zero; complete raw streams are retained.

Bounded first-loss diagnosis `5267-fixture-diagnosis.gORaPL` ran four transparent
probes in each lane, eight total, without production changes. In both lanes,
the closure-only global read gives 9; stage tracking completes the closure
read, reaches stage 2, then the literal global eval throws before stage 3.
The global-eval-only probe fails too. The combined function-local version
gives 18 and additionally confirms exactly one finalizer execution and the
identity of its replacement sentinel. **Residual handoff:** global/module-init
literal-eval binding reads in this fixture are a separate existing capability
gap; no eval/helper/IR repair is part of this finally slice.

Only the own focused fixture is corrected to use function-local bindings,
retaining both similarly named user variables, closure read, literal direct
eval and expected 18; wrong exception identity or duplicate execution now
returns explicit failure values. The private marker's absence from source
lookup/free lists and numeric remapping/rollback remain independently pinned
by the four real-emitter structural tests. The production patch is unchanged.
The corrected exact suite and normal contribution gates remain pending at
this note's creation; no full-suite or publication claim follows yet.

Corrected exact focused validation is now complete: all 66 unique expected
titles PASS, zero missing/unexpected/duplicate titles, zero skipped/todo cases,
zero suite errors, and an actual empty unhandled-error array from Vitest's
maintained blob reporter. `pnpm typecheck` (the repository's normal TS7 check)
and `pnpm lint` also PASS; lint checked 6836 files without fixes. All three
processes have successful actual exit/close and both stream EOF/close. Source
and test inputs remained byte-equal before/after throughout.
`5267-corrected-gates.qqDIpZ/receipt.json` SHA256
`d1e85b0dce8c82c712a1312357a58cba3e8c6f9d64c3c0f6bf4536367ec0b173`;
input proof SHA256
`1f2cd17cf37b68183c8deb3377fc27eacb9b9a7616110f7d3b1312a99305d258`.
`npm test`, explicit removal/restoration attribution, broader finite
abrupt-for-of/try controls and publication remain pending; the heavy-work
lease was released after actual terminal, not a tool timeout.

### 2026-10-06 isolated locked-dependency validation and attribution

This is completion of the allocated no-catch finally slice only, not a new
completion claim for the historical iterator/collection issue or the whole
ES2015 population. Both matched arms used upstream
`ee5dd9deb2a13f5af6043525c45ab855b384bfcc`, Node 24.19.0, pnpm 10.30.2,
one compiler/fork worker and 3072 MiB Node heaps. Each arm received its own
ordinary frozen-lock install, private modules/store/cache and full graph
readback: 45 roots, 996 snapshots, 825 physical packages, 171 explained
platform omissions and 1636 dependency links. Vitest's eight-package family
is 3.2.7, matching lock SHA256
`6a8b59fd4430c6600dc16ac33a749d0f5fed4ef0c100425de8490e43d916f2ac`.
Both normal installer processes exited/closed successfully with both stream
EOFs; shared modules and manifest/lock bytes remained unchanged. This is
installer-integrity/metadata evidence, not attestation of every package byte.

Each arm's four normal build commands passed. The first two invoke maintained
pnpm bundle scripts; command 3 alone uses the documented three-file native
artifact acquisition selector, and command 4 verifies the normal keyed cache
and linked canary. No provider/bundle adapter, forced key or cached verdict is
substituted. An earlier attempted build invoked the newly installed native
esbuild executable through Node and failed before compilation; its failed
packet remains preserved separately, not relabeled successful.

The exact named 124-case floor is 18 numeric-local controls, 66 own regression
cases and 40 neighboring finally/eval/IteratorClose cases. Baseline measured
97 PASS / 27 FAIL; candidate measured **124 PASS / 0 FAIL**. Both reports have
the exact expected title multiplicities, no missing/unexpected/skip/todo
rows, no suite errors and an actual empty maintained-blob unhandled-error
array. Candidate receipt SHA256:
`8d16f4b991ca0a53f5370fb91c6ddd4b9dcf0ac631fab55b99f19a1eb1294685`.
Baseline receipt SHA256:
`7d553232fa2aef946430920607774296238e1e9a820076499af44a732578917c`.

Maintained original-harness, standalone/auto-provider validation retained
nine official bodies and two plain diagnostics per arm. All official bodies
are actually strict-neutral, so each arm executed exactly 11 variants, not
an assumed 18. Baseline: official `throw-from-finally.js` FAIL, the other eight
official controls PASS, plain normal-finally PASS and throwing-finally FAIL.
Candidate: all eleven PASS. Every variant reached its test, has one
ready/send/result and successful physical exit/close/both EOFs, matching
executed WASM/meta/compiler provenance, and no ambient imports. This is
**one official flip and one diagnostic flip**, with no selected control loss.
Baseline receipt SHA256:
`39bdfe93255795c0d4f53fc64044c35372e60f637c0fa6786c61474763153642`;
candidate receipt SHA256:
`cb33fec66a254a77bde7b5dde17d42c54bc59ac6b0f3bdc9edecb3e1a59472b6`.

Explicit attribution removed only the private-entry mechanism, restoring the
exception emitter's exact baseline bytes. Fresh normal builds and the three
official/two-diagnostic packet then reproduced the same two failures and
three control passes (receipt SHA256
`400d57a8485c3e613ec7cd157417c28ac3a757da16959fbc7a3a026ed0830f5a`).
Exact-byte restoration reproduced the accepted complete 8502-input source
inventory, followed by fresh normal builds and **all five PASS** (receipt
SHA256 `eb032c95eefabd373de9bf63dc55975b328fe9a2aa66e1818297265f7ee00889`).
All ten attribution workers settled physically; original accepted packets
and removed/restored build artifacts are retained independently.

Normal quality validation executed all fifteen commands to physical terminal
with unchanged frozen inputs. Twelve passed, including typecheck, lint,
LOC/function budgets, oracle/coercion checks and issue/conformance checks.
Two formatting checks identified only the two owned TypeScript files; normal
Prettier corrected them. Parsed node structure, decoded identifiers/literals,
declaration flags and every test assertion/source literal are unchanged.
Formatted growth is 29 lines (function 465 to 494; file 816 to 845), covered
by this issue's scoped allowances. The complete architecture gate failed
`inventory-valid-architecture-incomplete`, with no inventory errors; the same
unchanged clean baseline independently reproduces that failure. Actual CI
uses inventory mode, which must be checked separately: complete architecture
is **not** certified by this slice. The done-status safety-net reported its
unavailable network/cache citation source and skipped that check, as its
maintained policy allows; this is not a fabricated citation-verification pass.

The owned branch was safely fast-forwarded to current upstream
`76e559f46687617b8e103560818fbea2a9eadc46`; its only delta from measured
`ee5dd9` is six generated npm reports. Compiler, dependencies, configuration,
test bodies and this emitter's upstream bytes are unchanged. Old receipts
remain labeled with their measured epoch. Final formatted-byte builds,
focused/native replay, inventory-mode and ordinary local hooks remain the
publication checks; no prior byte receipt is silently adopted as that replay.

**Full npm limitation, not a green suite.** Original full-run session 77309
was user-authorized to retire a healthy obsolete `4d42eec`/Vitest 3.2.4 epoch.
Its status is **STOPPED_INCOMPLETE**, not stalled, timed out or passed. The
owned process terminated gracefully with actual exit/close/EOF evidence,
partial raw output and unchanged source/generated artifact audit preserved
(receipt SHA256
`e62fe776f4fe6e1aa6d2810ff5203476cb35674ca0a92b80bccfff4b36ccf050`).
No final full-suite JSON/blob/aggregate exists. The legacy Phase-2 wrapper's
missing-precompile-cache labels are synthetic infrastructure outcomes, not
executed source failures or ES2015 score measurements. Current private lock
installation does not repair that distinct producer/reader cache-key gap.
Current full npm is NOT_RUN; no cache/harness/IR repair or fake full-suite
success is included in this bounded fix.

### Final formatted-byte publication checks (2026-10-06)

On source-equivalent upstream `76e559f466`, final emitter SHA256 is
`6f15a9229975145f96a01cdb04a5e3f076fe078b3447bfc5c50c32db897b60b5`;
the unchanged-assertion, normally formatted 66-case test SHA256 is
`9cd37fcdc90a0bb617a0cf7f82141c230b3cff88d79ea026dfcb2277709fff13`.
Fresh four-command build postflight SHA256:
`1a6cbc2961d18fa2bd3bc7e57f497ff89b489c699f18b4025b7066e3e53b3c8e`.
The final exact **124/124 PASS** replay has all five authored floors intact,
zero missing/unexpected/other/suite errors and an empty maintained-blob
unhandled-error array; receipt SHA256:
`0f4258470599f7c40e2f7a156aa692e516430953c324c497c2ca85f120e76b5e`.
The fresh three-original/two-diagnostic replay is **5/5 PASS**, with matching
WASM/meta, reached-test evidence and physical barriers; receipt SHA256:
`13b6ae9a66f7eb7ed499227ac74aba981cebeb84acea9c740846c7098dfa31ea`.

Final normal typecheck, lint, changed/whole-tree formatting, flat-directory,
LOC/function, oracle/coercion, dead-export, issue/spec coverage and conformance
checks pass with unchanged frozen inputs and actual exit/close/both EOFs.
The done-status citation safety-net retains its unavailable-source skip.
One faulty own invocation forwarded a literal `--` through pnpm to the
inventory parser and failed before checking; that complete failed receipt is
preserved. The actual CI direct command
`node scripts/check-compiler-boundaries.mjs --mode inventory --base HEAD^1`
then passed independently (exit/close 0, both EOFs, input equality,
inventoryValid true, errors empty). ArchitectureComplete remains false,
explicitly distinct from inventory-mode success. No policy or gate was edited.
Normal pre-commit/pre-push remain the final ordinary publication operations;
their results are not assumed here. Only these three owned files may be
committed, authored by Thomas Tränkler with Codex GPT-6.1 Sol High attribution.
### 2026-10-06 — Separate current-main finally baseline preparation (runtime HOLD)

Root reviewed Astra's PR6515/U4 reconciliation plan (planner lines 3097–3251),
and this lane read the complete plan before preparing a separate baseline.
Its normal newly created worktree is
`/Users/thomas/Code/js2/.codex-worktrees/5267-finally-main-baseline-sol61`, branch
`codex/5267-finally-main-baseline-sol61`, at freshly authoritative upstream
`47f186384c99840a11dc035b92d2f5b73ee708f5`. Creation handle 10597 physically
exited zero. Thomas's Git identity and normal `.husky` hook selection were
verified before Git mutations. No source merge, queued-branch push, conflict
resolution, compiler build or runtime test was performed. Published PR6515
head `052e9c9daa39de459f5bec71d80da698e3029f36` remains untouched.

The five moved source/test files exactly match the plan's 47f SHA-256 pins:
`exceptions.ts` d6746e9d…451f, `finally-ran-guard.ts` aa784382…f754,
`context/locals.ts` 8dc36097…04f, `ir/lower-generic.ts` 45d0108b…769,
and `issue-6651-u4-forof-collections.test.ts` 9e452c7d…0970.
The landed guard and IR implementation were not edited. This is baseline
setup, not evidence that its guard is behaviorally equivalent to PR6515.

Private dependency preparation completed with normal lifecycle scripts,
frozen lock, explicit package-copy method and own store/cache. The copied
complete Node24.19 runtime has 8,615 verified regular files; its executable
SHA-256 remains `7f9f8346011946e63956e45d1860cc409631802529e8cb18a0c86eed2ff5bf2e`.
Only previously absent own `test262/test` and `test262/harness` mounts were
created, resolving to the existing canonical corpus. Runtime-copy receipt
SHA-256 is `545fe64744efacb39b246fad63219d91fbc03a822367d9449194922422053208`.

Installer handle 6963 / child 62541 completed exit zero, close zero, both
stream end/close barriers true, zero errors and no signal. Its receipt is
`.tmp/5267-private-deps.QOILPF/receipt.json`, SHA-256
`f1abe0c43a4da56ad8f26e70ea1aca3283498d191e91ef1df0119a66542153ad`.
Shared dependency links/metadata and own manifest/lock/workspace inputs
remained unchanged. Normal hooks were configured by the maintained prepare
script, without bypass. The maintained workspace policy reports the existing
ignored `unrs-resolver` build; no new approval-policy change was made.

Unchanged accepted graph-readback logic (handle 41756, actual exit zero)
checked **45 root importers / 996 snapshots / 825 physical packages /
171 explained platform omissions / 1,636 required-peer-alias links** and all
eight Vitest-family packages at **3.2.7**, with errors empty and pending builds
empty. `.tmp/5267-private-deps.QOILPF/graph-readback-r2.json` SHA-256 is
`8ca696ce00e50fdfac39dcf40bce585e3d2ed16c90be0ba63407d62fbb47c199`.
Wanted/installed lock SHA-256 is
`6a8b59fd4430c6600dc16ac33a749d0f5fed4ef0c100425de8490e43d916f2ac`.
This is installation/graph identity evidence, not full package-byte integrity
or compiler/runtime validation.

The original published 66-case test is retained byte-identically in ignored
`.tmp/5267-preserved-inputs/issue-5267-finally-reentry.test.ts`, SHA-256
`9cd37fcdc90a0bb617a0cf7f82141c230b3cff88d79ea026dfcb2277709fff13`.
No published assertion was rewritten or added to tracked baseline tests.
Pure registration-only metadata expanded the actual unchanged loops and titles
while leaving every test callback uninvoked. It verified **136 named cases**:
18 numeric-local, 66 retained, 6 clone-depth, 22 eval/finally, 12 IteratorClose
and all 12 landed U4 cases. The retained 66 explicitly partition into
**60 semantic + 2 foreign-host identity + 4 old-layout diagnostics**. The
IteratorClose title multiplicity remains two for each of six names, retaining
the host/standalone lanes rather than silently deduplicating them.

`.tmp/5267-prepared-inputs.receipt.json` SHA-256 is
`4146b035a2777e039296beca74f65cce4926c1e2def596d8459c077ffee02f8c`.
An initial preparation attempt selected the historical final three-original
attribution contract and correctly rejected the required nine-original floor;
its helper is preserved as `5267-prepared-inputs.before-contract-selection.mjs`.
The corrected finite preparation uses the existing nine-original current-r2
contract, retaining all nine exact official body hashes and two plain-body
hashes. This was a metadata selection correction, not a conformance rerun.

All ten maintained metadata/harness leaves remain byte-identical to the
accepted dedicated-census metadata receipt. Scope/origin rows are reused from
that immutable receipt with physical body and leaf hash checks; no fresh
compiler import or conformance credit is implied. Separate fresh maintained
default-harness assembly (strict override unset) actually verifies **9 official
+ 2 plain = 11 strict-neutral variants**, not an assumed 18 or 22 jobs.
Its receipt SHA-256 is
`720be4813306b7723eda174e3dc88a5775de029779bf3d4e3c5a2c20dc4fd2fb`.
The census receipt's explicit `always` variants remain separately labeled;
they are not silently used as the default execution population.

The runtime lease remains with the dedicated census. Fresh normal builds,
official/diagnostic execution, unchanged-66 diagnostic execution and the full
136-case replay are **NOT_RUN**. Admission of a source-neutral reconciliation
or review/replacement of the four old-layout assertions still requires root
GO and actual current-main measurements. No shared guard/allocator/IR owner
edit, global score, conformance gain, PR readiness or publication is claimed.

Final read-only preservation checked all **1,839 tracked source files** against
the selected HEAD, with zero mismatches, and verified published052e9 emitter
and test bytes equal their Git blobs. Source-preservation receipt SHA-256 is
`4bcaaab693639d1fbad7292b342251d3fb97eafc539111d313ed94bc68239c43`.
All owned preparation handles are terminal; no compiler/native job is live.

### 2026-10-06 — actual five-record helper-only confirmation on 47f

Root admitted the separately bounded helper experiment after the planner's
3252–3459 allocator/reader audit and optional helper-only plan were read in
full. This uses only the owned `codex/5267-finally-main-baseline-sol61`
checkout at `47f186384c99840a11dc035b92d2f5b73ee708f5`. The frozen459 census
and published052e9 branch were not touched. No compiler, provider, Vitest,
Wasm, parser/checker/CreateProgram work, installer, subprocess wrapper,
whole-source JavaScript reproducer or Test262 execution was performed.

One direct canonical Node **24.19.0** launch with
`--max-old-space-size=1024`, `JS2WASM_TS7=0`, and no NODE_OPTIONS/NODE_PATH
executed the actual helpers through native TS stripping and `registerHooks`.
The imported repo closure was exactly six files: finally-ran-guard,
context/locals, ts-api, frontend/typescript, walk-instructions, and
wasm/model/instruction-walk. All six expected pre/post hashes matched.
The private TypeScript5 package was **5.9.3**, realpath inside this checkout's
`.pnpm/typescript@5.9.3/node_modules/typescript`, package SHA256
`822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6`,
entry SHA256
`3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675`.
Its observed built-in imports were perf_hooks/fs/path/os/crypto; the script
also preloaded its pinned Node instrumentation built-ins. Every resolved and
loaded URL is retained. Unexpected imports fail closed and are checked even
if a package catches a resolver exception: actual rejected-import count **0**.
The injected statement was only `{parent: undefined}`, so no TS predicate
or program parser was called by the guard's parent walk.

Actual floor **5 unique named records**, all retained with source maps,
parameter/local slots and instruction bodies before/after:

- `safe-user-positive`: source slot/map stayed **1**, guard slot **2**;
  finalized reset/mark writes remained **2**, distinct from source read **1**.
  An unrelated duplicate temporary actually compacted. Safety invariant true.
- `plain-i32-local-collision`: source `__finally_ran_1` mapped **1 → 2**
  on real guard allocation; actual dedup merged guard2 into source1 and
  redirected both reset/mark writes to **1**, the explicit source-read slot.
  Safety invariant **false**, diagnostic reproduction expectation met.
- `boolean-branded-i32-local-collision`: identical actual map overwrite and
  write/read aliasing with source `{kind: "i32", boolean: true}`. The brand
  did not prevent actual name/type-key dedup. Safety invariant **false**.
- `parameter-collision`: zero locals and parameter `__finally_ran_0`
  originally mapped **0**; guard allocation returned **1** and changed the
  name map to **1**. No dedup invoked. Safety invariant **false**.
- `snapshot-rollback-positive`: fresh collision-seeded context, all seeded
  capture/TDZ/memo/eval maps, tentative body discarded before actual
  restore, no intervening dedup. Exact original state restored, stale free
  index pruned, guard re-emission retained valid references and the same
  allocation shape. Safety invariant true **for rollback only**; re-emission
  still contains the separately demonstrated collision, not safe allocation.

Thus **2 safety-invariant true / 3 false**, not five conformance passes.
Diagnostic expectations were met in **5/5** and the direct execution tool
returned actual exit **0**, terminal (no live session), in **0.336 seconds**
with all output drained. The complete tool return and stdout are retained.
No child-process wrapper was admitted, so a distinct ChildProcess `close`
callback/EOF event timestamp was **not separately instrumented**; terminal
transport completion must not be embellished as that additional event receipt.
No retry or native-loader fallback occurred.

Artifacts, all in the owned ignored `.tmp/5267-helper-confirmation-47f/`:

- `confirm.mjs`: SHA256
  `4b5fe2e5dc9c83d424c24ab39e2f0c5a11b9d10fc2704ac5e9edd047aa4694d1`.
- `receipt.json`: SHA256
  `2045149c2f70c110e31bc50338a9a1ce5a88b8b1a794951d6893b7c89336c8b1`.
- `terminal-tool-result.json`: SHA256
  `ca558f3c5bdc2bb125d055b5d018e7f3b1d1c56854bcf547d958b378f99a0fe3`.

Package.json, wanted/installed locks, modules metadata and the already accepted
private graph receipt were pinned before/after with no change; the graph
receipt remains `8ca696ce…c199`. This is graph/source stability evidence,
not a new graph scan or package-file integrity certification. No tracked
source/test/scripts/hooks/manifest/lock bytes changed. The whole JavaScript
frame/emitted path/runtime effect, four replacement tests, behavioral floor
and official originals remain unmeasured on47f. A narrow repair still requires
U4 guard-owner agreement and root admission; no allocator, reader, capture,
IR twin, async policy or published assertion was changed here.

### 2026-10-06 — private allocator candidate and first seven-record helper result

Root admitted only two production paths after the full Astra appendix3461–3628
was read (planner document SHA256
`8582289689147aa00d537f1144fabd8bac89b8ff4fd0e98ac696a607517fbab1`).
Owned branch remains `codex/5267-finally-main-baseline-sol61`, Git HEAD
`47f186384c99840a11dc035b92d2f5b73ee708f5`; its working source is now the
explicit candidate delta below, **not** an unchanged47f runtime baseline.
Published052e9 and the census checkout remain untouched.

Production delta: new10-line `src/codegen/statements/finally-private-local.ts`
type-imports only FunctionContext/ValType, appends the exact supplied type
at `params.length + locals.length`, names it `finally@private$<absolute-index>`,
and returns the index without changing maps, reusable pools or global state.
`exceptions.ts` adds its import and substitutes only the factory's fourth
argument (now line436). It does not move factory/reset timing or change
guard/handler/payload semantics. The separately allocated no-catch and inner
wrapper payloads remain ordinary allocLocal at their unchanged statements.
Shared finally-ran-guard, context/locals and all IR files are byte-unchanged
against HEAD; no tests, other sources, installer or configuration changed.

Candidate source hashes:
`exceptions.ts` = `134f950290b797d53ef9cd72ce9f4d50537ec2a56b7f06788340b721671fe6f2`;
new private leaf = `60d0da5027c4f525bdd138f33b6788635966968add54b9ee8d41ef87f6240086`.
The ignored candidate byte snapshots have those exact same hashes.
The original five-record script/receipt remain byte-exact
`4b5fe2e5…4694d1` / `2045149c…36c8b1`; neither was relabeled or rewritten.

Separate utility `.tmp/5267-private-allocation-candidate-47f/confirm.mjs`,
**311 lines**, SHA256
`ed5e889ecb6eed6a5db1950d37fc3c5021d54a50b769dab904dadd7472fa1a4c`,
was fully reviewed and pinned by root before its first execution. It requires
explicit private/baseline mode, the exact caller argument and whole-file hash,
and (private mode only) the pinned leaf load. Baseline mode excludes the leaf
from permitted imports; it does not assert the leaf's filesystem absence.
Private mode permits exactly the original
six repo imports plus the new type-import-only leaf, pinned own TypeScript5,
and audited Node built-ins. exceptions.ts itself is read/pinned, never imported.
This confirms caller-source agreement, not execution of statement lowering.

Root separately admitted **FIRST CANDIDATE ONLY**. One direct canonical Node
24.19 process,1024 MiB, TS7=0, NODE_OPTIONS/NODE_PATH/inspector variables absent,
ran private mode with stdout/stderr redirected only into owned ignored files.
Actual terminal tool exit **0**, elapsed **0.308 seconds**, no live session,
stdout **69,550 bytes**, stderr **0 bytes**; no wrapper subprocess or retry.
The retained terminal tool result is not a separately instrumented child-close
callback/EOF event timestamp. No compiler, parser/Program/checker, provider,
Vitest, Wasm, install or whole-source JavaScript execution occurred.

Actual **7 unique helper records = 5 core + 2 payload**, all safety true:
the safe-user, plain-i32 collision, boolean-branded-i32 collision, parameter
collision and exact rollback controls retain their original names/contexts.
Both local collision source maps remain1 with distinct marker2; parameter
source0 remains0 with distinct marker1. Rollback restored the complete seeded
map/body/length state with no dedup between snapshot and restore.

New payload controls: source local `__finally_exn_2` remains source1,
marker2/payload3; parameter `__finally_exn_1` remains source0,
marker1/payload2. Both actual payload prologues retain exact nested local.get,
local.set, throw-tag0 and final payload-read identity after dedup, with
unchanged free lists. These are two added helper controls, not extra official
originals or a retroactively enlarged old diagnostic denominator.

Root requested an additional labeled subcontext inside safe-user-positive,
**not an eighth record**: duplicate temps before guard/payload force real
compaction. Actual marker **4 → 3** and payload **5 → 4**; reset/mark,
handler guard, nested payload get/throw0 and final payload get all remap
consistently while source-read1 stays distinct. No post-finalization localMap
contract is invented. Actual rejected imports0; all source, caller, package,
lock/modules and accepted-graph pins remained identical before/after.

Full receipt `candidate-receipt.json` SHA256
`f8f2bf21e95f4e84f887400037e482b369f8f8c2e0afdbf17a27177f11efbfda`;
terminal tool receipt `candidate-terminal-tool-result.json` SHA256
`56ab72ac977c285a15225d17657bf1610a945d490356df57e0772fd34508c416`.
All artifacts above are under owned `.tmp/5267-private-allocation-candidate-47f/`.

Historical first-candidate checkpoint (superseded by the dated actual
removal/restoration append below): patches were prepared but **not applied**:
`removal.apply-patch.txt` SHA256 `4b439587…92fdc` removes only this injection
and new leaf; `restoration.apply-patch.txt` SHA256 `b8a4cdad…26a15` restores
their exact candidate bytes. The same frozen utility's baseline mode requires
the original caller hash/allocator and excludes the leaf from allowed imports;
actual leaf deletion is checked by the separate removal-source readback,
not by a filesystem-absence assertion in the utility.
its expectations preserve core2 safe/3 unsafe plus both unsafe payload seeds.
Root must review this first receipt and explicitly admit removal/restoration
before those source changes or helper reruns. Currently stopped at first
candidate. This is measured allocation isolation only, no136 named/native
acceptance, original gain, shared-handler/IR repair, PR readiness or global score.

#### Actual bounded removal/restoration attribution, completed after separate GO

Root read the first receipt and exact two-path patches, then separately
admitted removal/restoration. No utility assertion or import policy changed:
every launch used the same `ed5e889e…a1a4c` utility, explicit caller mode
checks (and private-mode leaf pins), canonical Node24/1024, TS7=0 and the
same private dependencies. Baseline leaf deletion was established separately
by the actual removal-source readback, not a frozen-utility absence assertion.

Removal used apply_patch only: the one import/callback substitution returned
exceptions.ts to exact HEAD47f SHA256 `d6746e9d…7451f`, and only our new
private leaf was temporarily deleted. Its exact ignored snapshot remained
recoverable. Actual whole-src diff against HEAD was empty at this boundary.
The direct baseline-mode helper launch exited **0**, terminal/no live session,
**0.251 seconds**, stderr **0 bytes**, receipt **68,693 bytes**. The actual
core five returned **2 safe / 3 unsafe**; both new payload controls were
unsafe, making **2 safe / 5 unsafe / 7 unique records**. In the local payload
collision, source-map1 became3 and actual dedup redirected payload3 to the
source-read1 slot. In the parameter payload collision, source-map0 became2.
The extra safe remap subcontext remained positive, shifting marker4→3 and
payload5→4. Expected safety failures are not a failed diagnostic or conformance
passes; all seven diagnostic expectations were met.

Restoration used the reviewed apply_patch only, restoring exact exceptions
`134f9502…1fe6f2` and leaf `60d0da50…40086` bytes. The direct private-mode
launch exited **0**, terminal/no live session, **0.265 seconds**, stderr
**0 bytes**, receipt **69,550 bytes**, actual **7 safe / 0 unsafe** with
the same five-plus-two floor and actual-shift subcontext. Both source/setup
vectors remained unchanged within each run; rejected imports0. The complete
restoration JSON is byte-identical and deep-equal to the first candidate JSON.

Immutable ignored receipts in `.tmp/5267-private-allocation-candidate-47f/`:

- `removal-receipt.json`: SHA256
  `aae596453dda6bc0541974d64b3c21fd27c26ee88356cd673cfca3c2d16ff766`.
- `removal-terminal-tool-result.json`: SHA256
  `7e367cf0b5fed4630d9514c0d86f0ca4d67a4671303a2cc757fd7b575e696ccc`.
- `restoration-receipt.json`: SHA256
  `f8f2bf21e95f4e84f887400037e482b369f8f8c2e0afdbf17a27177f11efbfda`.
- `restoration-terminal-tool-result.json`: SHA256
  `0be2c21990290bc611efe5c856dc67619760580e58adc4ec7cfa024b99b826f1`.

Current working source is restored candidate, not removal state. Original
five-record script/receipt remain immutable; shared guard/locals/IR remain
HEAD-identical. All three helper execution handles are terminal. No Git
mutation, compiler/provider/Vitest/Wasm/install, published assertion rewrite
or source expansion occurred. Removal/restoration attributes the injected
helper-context isolation result to this exact callback delta; it does not
establish a whole-JavaScript collision path, statement lowering correctness,
136-case/native acceptance, official-original gain or publication readiness.

### 2026-10-06 — Four current-handler test replacements prepared, execution HOLD

**Current checkpoint status: in-progress.** Historical September umbrella
completion and the completed helper-only records are not completion of this
current-main repair. Root admitted TEST PREPARATION ONLY after the full Astra
5267 appendix3630–3798 was read (whole planner SHA256
`2881da1c678656d8e68ef23517cfd4f7eb1b3706caf5e0844f68f815602dfef2`).
Census retains the engine lease; these assertions have not been executed.

Added own `tests/issue-5267-finally-reentry.test.ts`, 520 lines, SHA256
`2be96ff35827f61d4d94fbaad238b6e27e11d818e8b73a53c44cc9efd2363c0a`.
The exact published original remains immutable in
`.tmp/5267-preserved-inputs/issue-5267-finally-reentry.test.ts`, SHA256
`9cd37fcdc90a0bb617a0cf7f82141c230b3cff88d79ea026dfcb2277709fff13`.
Only its structural fixture/helper block was replaced; imports, real compile/
Wasm run helper, 60 semantic cases and two foreign-host identity cases remain
byte-exact. No assertions were weakened in those retained cases.

Four exact replacement titles, under the unchanged structural suite:

- `resets on entry and guards own handlers without replacing the pending exception (false)`
- `resets on entry and guards own handlers without replacing the pending exception (true)`
- `private guard slots preserve source bindings through remapping and rollback (false)`
- `private guard slots preserve source bindings through remapping and rollback (true)`

These unrun checks call actual `compileTryStatement`, not the new leaf in
isolation. They extract the exact legacy catch_all or standardized join/
payload-block/try_table scaffold; derive marker/payload indices from handlers;
check entry domination, two distinct marker writes, original payload transport
and distinct mutable gets. Storage subfixtures cover actual duplicate removal
before two sequential guards, plain/boolean-branded source-local collisions,
parameter collisions and body-discard-before-locals-restore rollback.
Sequential remap requires a marker index shift and retained local-object
identity. No post-dedup source-map contract is invented. Excluded no-catch
handler payload allocation is checked for transport consistency, not private
allocation; excluded callers497/665, shared guard/locals and IR are unchanged.

One bounded pure registration/syntax metadata run used canonical Node24.19,
1024 MiB and private TypeScript5.9.3; imports were not evaluated and every
test callback was left uninvoked. Actual terminal tool result: exit0,
no live handle, 0.105 seconds; stderr183 bytes is Node's native type-stripping
experimental warning only. Result: parseDiagnostics0, 66 unique registrations,
60 semantic / 2 host / 4 replacements; all62 retained names match. This is
authored membership, not test PASS, compiler admission or conformance credit.

Actual independently checked preserved substring pins:

- Semantic matrix: 7481 bytes,
  `74ad5a710a54d4f97eb4709e4cf7574e42e4cbda122761d7b48574e80e37d0c5`.
- Host tail: 1613 bytes,
  `0565a1fc4d38489ffcef8d7eacd34875a0a39d0f4f904da2f7aa03adb2154b3f`.
- Run helper plus semantics: 8458 bytes,
  `43c556bfeed5c2acef1c452cb2ac410a58c2b52672ed8b0fa7a4df3ab0b62619`.

Own ignored review artifacts:

- FULL preserved-original→candidate diff: `.tmp/5267-test-rewrite-full.diff`,
  322 lines, SHA256
  `5345ef2a05eb1437802b2b96678c5ddc0966eb758b7936e11820de83b2f2e0b2`.
- Metadata collector: `.tmp/5267-test-rewrite-preparation.mjs`, SHA256
  `0d97dbc4d7e1f7d2ab5ac9fe7a822f4403e7bf399c2e6dad4b02c98ffacb6769`.
- Actual metadata receipt: `.tmp/5267-test-rewrite-preparation.receipt.json`,
  SHA256 `1e6bf66f556a0847447f92f22322c4a4048fb184baec96aae16e0d8556be76ca`.

Production candidate bytes remain exceptions
`134f950290b797d53ef9cd72ce9f4d50537ec2a56b7f06788340b721671fe6f2`
and private leaf
`60d0da5027c4f525bdd138f33b6788635966968add54b9ee8d41ef87f6240086`.
Original five and frozen seven helper artifacts are unchanged. No compiler,
provider, Vitest, native/Wasm execution, build/formatter, installer or Git
mutation occurred. Root review/test GO remains pending; subsequent all66 and
full136 named cases plus nine official originals/two plain diagnostics,
removal/restoration attribution and normal publication gates remain required.

#### Targeted formatting preparation checkpoint — no test execution

Root reviewed the full proposed diff and admitted only direct private
Prettier formatting of the test and new leaf, followed by the same frozen
metadata collector. Private Prettier3.8.1 file-info explicitly reported both
paths `ignored:false`, inferred parser `typescript`. Its normal two-file
write exited0: the test was formatted; the leaf was explicitly unchanged.
Direct canonical Node24/1024 formatting check on those same two named files
then physically exited0 and reported all matched files compliant (terminal
receipt `.tmp/5267-test-rewrite-format-check-terminal.json`).
No other source path was passed to the formatter.

Formatted test: 540 lines, SHA256
`8e841c594e1e58d04101e78a61acf15bb0f3b9f0ea6f4f918ff746048af16aa1`.
The original preparation receipt, collector and preformat full diff remain
immutable. Same frozen collector `0d97dbc4…cb6769` produced separate
`.tmp/5267-test-rewrite-formatted-metadata.receipt.json`, SHA256
`bb315ed45cba8aa7091fea5df88a2d6f60a9dbda44ae58a26ac23025decde648`,
actual terminal exit0, no live handle, 0.112 seconds. This reconfirms all
three exact byte chunks, all62 retained names, 66 unique registrations,
60 semantic / 2 host / 4 replacement roles and parseDiagnostics0.
Native type-stripping warning only; imports and test callbacks were not
evaluated. No execution verdict was created.

FULL formatted-original diff is `.tmp/5267-test-rewrite-formatted-full.diff`,
327 lines, SHA256
`1f2e7039cc812d662538154ef9e9c302b8080ee366db05656ca7da4efc7b2724`.
Read-only no-index whitespace check emitted no diagnostics (its exit1
records that original and candidate differ, not a successful equality).
Caller `134f9502…1fe6f2`, leaf `60d0da50…40086`, original five/seven
helper pins and shared guard/locals/IR HEAD bytes remain unchanged.
Current checkpoint remains **in-progress / runtime HOLD**: formatting and
membership do not substitute for all66/full136, nine official originals,
two plain diagnostics or removal/restoration and publication gates.

### 2026-10-06 — PR6515 current-main reconciliation and measurement start

Current checkpoint remains in-progress. Normal append-only merge in the owned
published branch preserves PR head052e9 and authoritative incoming upstream
`d1f1fbdebcc7ca387fd2ec272e31862d8e92b315`. The two no-catch handler conflicts
were resolved by preserving landed U4's complete guard/rethrowIfRan behavior,
not stacking the historical PR-only entry flag or restoring its whole emitter.
Only the reviewed allocator import/callback and ten-line private leaf differ
from incoming production. All incoming IR and foreign source changes remain.
The obsolete private-flag function allowance is removed; normal budget gates
must judge the reconciled allocator delta without that historical waiver.

Current exceptions SHA256 `134f9502…1fe6f2`, private leaf `60d0da50…40086` and
reviewed66 test `8e841c59…6aa1` equal the prepared owned packet. The original
published test and every old epoch receipt remain preserved. The 60 semantic
and two foreign-host identity cases retain their original byte chunks; four
structural tests now exercise the actual landed guard and storage privacy.
Current136 named/native9+2/removal/restoration/gates remain NOT_RUN at freeze.
Fresh private graph readback reuses this branch's own installed graph only;
it does not borrow another checkout's node_modules or generated JS bundles.
Full frozen459 census is separate evidence, not current-main validation.

#### Current-main measured attribution and exact restoration

The reconciled fix is **private finally-guard storage isolation**, not a new
current-main Test262 improvement. Incoming U4 already fixes the old throwing
finally original. Candidate, exact-main removal, and exact restored candidate
each pass all nine official bodies under maintained strict-always assembly:
18 official variants plus four variants from two plain diagnostics. Thus the
attributable official delta on `d1f1fbdebcc7ca387fd2ec272e31862d8e92b315` is zero.
The frozen459 failure remains historical evidence, never a current comparator.

Fresh private dependency readback is GRAPH_READBACK_PASS: 45 roots, 996 lock
snapshots, 825 physical packages, 171 explained omissions and 1636 edges, eight
private Vitest3.2.7 family packages, errors/pendingBuilds empty. Wanted and
installed lock bytes match `6a8b59fd…f2ac`. Each arm uses its own freshly built
compiler/runtime/adapter, the documented three-file native acquisition selector
on command3 only, then the normal keyed-cache requirement and canary. No donor
JavaScript bundles, forced keys, shared node_modules edits or provider bypass.

Actual candidate136: `.tmp/5267-current-gates.PSLJi1/receipt.json`, SHA256
`24c8c6b0b478afa2469a332be31b4fc86224e14ed741763e3201b1ac25a74f49`.
Actual removal136: `.tmp/5267-current-gates.aUFMH4/receipt.json`, 134P/2F;
the two failures are private marker spelling/storage assertions, not themselves
proof of user-visible corruption. All six identity floors are intact. Actual
restored136: `.tmp/5267-current-gates.ByNEu8/receipt.json`, SHA256
`8bf6e782f3b41b32740ea87ee28c24cbe3fdb3ccc2a2ff74b75503ce4857b651`,
136P/0F, floors18/66/6/22/12/12, zero missing/unexpected/other/suite/unhandled
errors, physical exit/close0/both EOF and source inputs unchanged.

Strict-always candidate receipt `.tmp/5267-originals.mFulQM/receipt.json`
SHA256 `20d646d39b52f45bcf17b4d30ee5b58a2ef0a0acbdffbdd0f83292bd9881c387`;
exact-main removal `.tmp/5267-originals.bpmR01/receipt.json` SHA256
`34fa336ae7cf5232aa2d1a2855531749cee0633f5e6da98d3679f8faae130335`;
restored `.tmp/5267-originals.RJkPLn/receipt.json` SHA256
`cb9ccad16bd259b81167f65b21f173afe2db52c4ae6f2c70003ab6002776083f`.
All three have 18 official/4 diagnostic variants PASS/reachedTest/valid artifacts,
actual worker exit/close/both EOF, exact body/variant floors and unchanged inputs.

Ten finite compiled source-binding positives were preserved and are not defect
evidence. One naturally observed AST literal-eval allocation supplied suffix8,
without a suffix sweep, IR flag or broad allocator change. Exact typed witness:
`export function probe(__finally_ran_8: number): number { try {} finally {} return eval("__finally_ran_8"); }`.
It fails WebAssembly validation on exact-main removal in both gc and standalone
(local.tee expects the direct-eval reference carrier but receives i32). Neither
failed row reaches runtime. The otherwise identical suffix0 controls both
compile and return37. Restoring the exact allocator bytes, rebuilding normally,
and replaying the identical four source/options pairs makes all four compile,
validate and return37; standalone imports remain empty. This is the concrete
source-binding defect, not merely an allocator-layout preference.

Immutable removal receipt `.tmp/5267-source-binding-observed-removed.86d4xd/receipt.json`
SHA256 `c6f18dd5e9671ce54b747561890626175ac3c2eecd5fdac4bb3c9d12a15df3f0`;
restored `.tmp/5267-source-binding-observed-restored.5XOKtg/receipt.json`
SHA256 `e49cfcfd86a6c9ba6dc743020aec58d63b8ed9b433acce378d1b7f9ea2142a14`.
Both retain their literal `floor:false`: the diagnostic driver accidentally
compared four unique IDs against10. This is an identity-counter typo, not an
expected-failure verdict. Neither old program nor receipt is rewritten.
Independent readback `.tmp/5267-observed-attribution-readback.json`, SHA256
`c5fe72f24e1ab8edb0f2aab178128458e30c5e52a9362916a40d6ed8dc13ce81`,
records countFloor/sourceOptionsParity/expectedFailureAttribution/
restorationRecovery/physicalBarrier all true. Removal is two compilation
failures plus two passing controls, **not four passing tests**.

The exact unannotated equivalent and suffix0 positive also compile, validate
and return37 in both restored backends using allowJs/.js, no routing overrides.
Receipt `.tmp/5267-source-binding-plain-js-restored.SCOWfG/receipt.json` SHA256
`060d1c20a3ffd307a2ceacda6e4721ed32123f7ab94b7daa82acbb404db2c4c0`:
four unique rows/allPass, physical exit/close0/both EOF and unchanged inputs.
Its observed AST cell is `__direct_eval_cell___finally_ran_8_7` and private
guard index9. This is restored JS coverage, not a separately measured JS
removal claim. Four new named tracked regressions each check both exact typed
and plain-JS source in one backend/collision role, above the unchanged66:
final named floor140, with eight new compile/validate/value37 assertions.

Current publication checkpoint remains in-progress until those final140 and
normal current scoped gates/hooks actually terminate. The earlier full npm
run77309 remains STOPPED_INCOMPLETE (user-authorized obsolete epoch/dependency
validation retirement), not passed. Its legacy precompile-cache reader/producer
incompatibility and wrapper missing-cache labels are separate infrastructure
limitations; no current full-npm success or 100% ES2015 claim is made here.

#### Final shipped tests and normal classification gate correction

Final shipped tests `.tmp/5267-current-gates.XNODZF/receipt.json`, SHA256
`e6296f9b4643e2c70a932172708af3e51d9452df66da52a43b3f9c165a8416db`:
140/140 PASS, exact18/70/6/22/12/12 floors, all assertion names/statuses present,
no suite/unhandled/missing/unexpected/other errors, terminal0 and unchanged
inputs. Test SHA256 `e9a7983a0c5b5437430a4e560ac765bd9c0e65cb9573e45e20c9247ed87c76d2`.
The entire original66-test file is its unchanged24647-byte prefix.
Final same-source normal four-command build `.tmp/5267-build.fv36Br/postflight.json`
SHA256 `0fe8174ec9deba7d0453402bc93215dc8517d9b360c4bb06cc6dc0a708cf5c35`;
final strict-always `.tmp/5267-originals.mqiLvZ/receipt.json` SHA256
`6f3944628ec763d4870487dc1090591d229cb219a943221402783f6d23bb99e9`:
all18 official plus4 plain variants PASS/reachedTest/physical barriers,
exact identity floors, errors empty, source/artifacts unchanged.

Normal serial15-command quality packet physically terminated; retained
`.tmp/5267-current-quality.1VHCPK/receipt.json`, SHA256
`2a97a15ad8fdc836850b5f5c10c4a3622e2d20580b17df8bdc144c8e49e76845`.
Fourteen commands exit0: typecheck, lint, owned formatting, flat829/829, LOC,
function, oracle, coercion, configured dead-export/core gates, issue integrity,
issue-spec coverage, done-status integrity, conformance sync and whole-tree
formatting. No source/input changes. The inventory command exits2 because
pnpm forwards its literal `--` to the checker: this is a setup failure, not an
architecture verdict. Done-status's normal citation check explicitly skips
when baseline JSONL is unavailable; the configured dead-export check exits0
but prints modeled graph OPEN and retirement/deletion NOT CERTIFIED. These
limitations are retained, not converted into complete-architecture claims.

Separate unchanged direct CI inventory checker then physically exits1:
`.tmp/5267-inventory-current.3XYC0F/receipt.json`, with exactly
unclassified-module/unclassified-target for the new private-local leaf.
This is **candidate-caused missing factual classification**, not inherited
architecture incompleteness. Root authorizes registering only that new path:
unmigrated / mixed-needs-split / backend-wasmgc / owner5267, adjacent actual
nextBoundary. Pre-edit compiler inventory equals incoming main byte-for-byte,
SHA256 `e91199cafc1788a5e976e29553b0c093a28c53fd7e2dcc3d806c8559c3f9547e`.
All existing records, layers, allowed edges, checker and CI remain unchanged;
no foreign ownership transfer, SourceOrigin/C1 literal refresh or architecture
waiver. This necessary registration is the fifth scoped PR file. Its exact
inventory rerun and maintained detector fixture tests remain pending here.

#### Registered inventory and unchanged supplemental fixture comparison

Actual corrected CI-style inventory receipt
`.tmp/5267-inventory-current.ljVXvR/receipt.json`, SHA256
`73a0a44f6bce5d4cd3839c5736885a3be48319974b89c81a8c777087117fb6ad`:
exit/close0, both EOF, errors empty and inputs unchanged. Its precise result is
inventory-valid-architecture-incomplete, not complete architecture certification.
The sole new8-line record preserves every existing1838 record and all rules;
registered inventory SHA256
`69eaf95c6d675c48c2bb092603c50779309976ec0373d0370a93ed7068445828`.

The unchanged supplemental `tests/issue-3518-compiler-boundaries.test.ts` suite
actually records125 assertions,124 PASS and1 FAIL, unhandled errors empty;
receipt `.tmp/5267-classification-tests.K7ohbA/receipt.json`, SHA256
`b5eeed9bea2a08ad88df650f5ed0707f7c533629c7a3a6053a1b371747c964ab`.
The sole failure is line797, historical held-B moved-symbol authentication.
A whole-file125 baseline comparison under identical private dependencies,
unchanged checker/test/config/package/lock bytes equal incoming d1, and the
exact original inventory policy e911, repeats124 PASS and the same1 FAIL:
`.tmp/5267-classification-baseline-tests.Do4dNF/receipt.json`, SHA256
`6ea07b58a1abc9a31e9c133e4deedb010d66ffc41dfd2fc116748d619413a4ca`.
Physical exit/close1 and both EOF, identity floor125, no unhandled errors and
unchanged inputs are retained. Only the new classification record was
reversibly removed; exact69eaf registered bytes are restored. This fixture
constructs its own source tree and never imports the production allocator.
It uses `manifest.moves.slice(0,2)`, whereas main prepended the unrelated
nested-stackification move: the adapter's two symbols remain external-unbound.
This proves this one supplemental failure baseline-present; it does not make
the125 suite green or waive any CI gate. No historical fixture, IR, checker,
SourceOrigin/C1 literal or assertion was edited. The unchanged3518 file is
neither a pinned issue-test nor a changed TEST path in this PR.

Fresh upstream cdc0255882d45181072342d9fd57f291aca93092 adds only six generated
npm report files after measured d1. Compiler/source/config/dependency inputs
are equivalent; old receipts retain their explicit d1 measured epoch. Normal
append-only integration and unchanged publication hooks remain required;
no source-dependent newer-epoch or full-suite claim is inferred.
