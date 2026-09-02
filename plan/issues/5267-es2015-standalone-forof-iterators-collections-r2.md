---
id: 5267
title: "ES2015 standalone: for-of + iterator prototypes + collections — r2 residual pass"
status: in-progress
sprint: current
created: 2026-09-01
updated: 2026-09-01
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
