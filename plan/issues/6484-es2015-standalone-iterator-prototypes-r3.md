---
id: 6484
title: "ES2015 standalone: iterator prototypes are unreachable from a dynamically-typed iterator — r3"
status: ready
sprint: current
created: 2026-09-16
updated: 2026-09-16
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: ttraenkler/fable-es2015
model: opus
# 2026-09-16 (#6484 S1+S2): the slice adds a `family` field to `$__IterRec` and
# the two routes that make the intrinsic iterator prototypes reachable. Each
# grant below is where the mechanism has to live, not where it was convenient:
#   - iterator-native.ts owns `$__IterRec`, so the field, the `ITER_FAMILY_*`
#     enum and the per-arm family operand are all in-module. The exhausted-
#     cursor latch (§23.1.5.1 step 6.a) is in the same step body.
#   - array-object-proto.ts owns `emitIteratorPrototypeSingleton`; the new
#     %IteratorPrototype% root and the %ArrayIteratorPrototype% `next` property
#     are two more arms of that one factory, and the ArrayIterator glue sits
#     next to its Map/Set twins.
#   - call-builtin-static.ts / property-access.ts / call-tail-dispatch.ts /
#     index.ts / map-runtime.ts each take ONE call-site arm; the shared
#     mechanism itself is a NEW module, src/codegen/iterator-proto-next.ts.
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/iterator-native.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/property-access.ts
  - src/codegen/map-runtime.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/iterator-native.ts::buildIteratorBody
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
  - src/codegen/iterator-native.ts::buildIteratorNextBody
  - src/codegen/map-runtime.ts::fillMapSetDynDispatchArms
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/index.ts::generateModule
---

# ES2015 standalone: iterator prototypes are unreachable from a dynamically-typed iterator

`Object.getPrototypeOf(<iterator>)` answers a genuine `%XIteratorPrototype%`
singleton **only when the TypeScript checker proves the argument's static type**
(`ArrayIterator<T>`, `MapIterator`, `SetIterator`, `StringIterator`). Every
test262 program is plain JavaScript, so every value there is `any` and the
static key never fires: the four arms in
`src/codegen/expressions/call-builtin-static.ts` are skipped and the generic
fallback answers `ref.null.extern`.

That one fact is behind 20+ ES2015 standalone rows, plus the `%IteratorPrototype%`
family that hangs off those singletons.

## Measured (2026-09-16, `--target standalone`, probes in `.tmp/iter/`)

| probe | result |
| --- | --- |
| `const it: any = [1,2,3][Symbol.iterator]()` | the iterator itself is an object, and `it.next()` steps correctly (`value=1`) |
| `Object.getPrototypeOf(it)` | **null** — `protoIsObject=0` |
| `typeof it.next` | **not `"function"`** — `itHasNext=0`; `next` is callable only through the static call site, never readable as a property value |
| `Object.getPrototypeOf(new Map([[1,2]])[Symbol.iterator]())` | **null** — so `%MapIteratorPrototype%.next` is unreachable |
| `Object.getPrototypeOf(Object.getPrototypeOf([1][Symbol.iterator]()))` (`%IteratorPrototype%`) | **null**; no `[Symbol.iterator]` |
| `new Int8Array([1,2])[Symbol.iterator]()` | **traps** — `[object WebAssembly.Exception]` (a separate defect, S3) |

Baseline: `.test262-cache/test262-standalone-current.jsonl` fetched 2026-09-16
10:46 UTC; ES2015 census `10,303 / 11,704 = 88.0 %`, 1,401 non-pass.

## Why the singletons exist but never answer

`emitIteratorPrototypeSingleton` (`src/codegen/array-object-proto.ts:3964`)
already materialises an identity-stable `$Object` per family, with
`@@toStringTag` and — for Map/Set/String — an own `next` data property
(#3013, #4747, #4777, #5099, #5267 R3-2). The gap is purely the **routing**:
`call-builtin-static.ts:2405-2452` keys each arm on
`ctx.checker.getTypeAtLocation(arg0).getSymbol()?.name`. The iterator record
itself (`$__IterRec`, `iterator-native.ts:421`) carries a `kind` tag that
discriminates the *carrier* (VEC / USER / OBJ / HOSTGEN / ASYNCGEN / GENSTATE),
**not** the iterator family, so no runtime arm can tell an array iterator from a
map iterator today.

## Implementation Plan

Three slices. S1 and S2 share the family tag and should land together; S3 is an
independent defect and may land separately.

### S1 — a family tag on `$__IterRec`, and a dynamic `getPrototypeOf` arm

1. **Add a fifth field to `$__IterRec`** in `getOrRegisterIterRecType`
   (`src/codegen/iterator-native.ts:421`):
   `{ name: "family", type: { kind: "i32" }, mutable: false }`.
   Field order 0..3 is load-bearing and documented — **append, never reorder**.
   Introduce an exported enum next to the existing `ITER_KIND_*` constants:
   `ITER_FAMILY_UNKNOWN = 0`, `ARRAY = 1`, `MAP = 2`, `SET = 3`, `STRING = 4`.
   A TypedArray iterator is an **Array** iterator per §23.2.3.30
   (`CreateArrayIterator`), so it takes family 1 — do not mint a fifth family.
2. **Every `struct.new` of the record must push the new operand.** Grep for the
   IterRec type index at every construction site (`iterator-native.ts`,
   `array-methods.ts:3157` `compileNativeArrayIterator`, and any site reached
   through `getOrRegisterIterRecType`); a missed site is a validation error, not
   a silent wrong answer, so the compiler will find them — but audit them all in
   one pass rather than fixing them as they fail. Producers stamp the family they
   statically know: the array-iterator builders stamp `ARRAY`, the collection
   builders `MAP`/`SET`, the string-iterator builder `STRING`, and every generic
   / user / host-generator carrier stamps `UNKNOWN`.
3. **A runtime prototype resolver.** Add `ensureIterRecPrototypeHelper(ctx)` —
   a defined function `__iter_rec_proto(externref) -> externref` whose body is a
   switch on the `family` field, each arm emitting the existing
   `emitIteratorPrototypeSingleton(ctx, helperFctx, kind)` sequence (it pushes
   into whatever `FunctionContext` it is handed, so a synthesized one works).
   `UNKNOWN`, and a non-record argument, answer `ref.null.extern` — the
   historical result, so nothing that passes today can regress.
4. **Route it.** In `call-builtin-static.ts`, after the four static arms and
   before the generic fallback, add a standalone/wasi arm: compile the argument,
   `any.convert_extern` + `ref.test $__IterRec`, and on a hit call
   `__iter_rec_proto`. Keep the static arms — they are cheaper and already
   pinned. Evaluation order must stay observable: compile the argument exactly
   once, into a local.
5. **`%ArrayIteratorPrototype%` needs its own `next`.** Map/Set/String already
   install a descriptor-carrying native method closure in
   `emitIteratorPrototypeSingleton`; Array does not. Add the Array arm the same
   way (`name: "next"`, `length: 0`, `writable: true, enumerable: false,
   configurable: true`).
6. **`%IteratorPrototype%`.** Mint a fifth singleton global
   (`__native_iterator_prototype`) with an own `[Symbol.iterator]` data property
   whose value is a native closure returning its `this` (§27.1.2.1), and set it
   as the `[[Prototype]]` of all four family singletons through the same
   object-runtime call the rest of the file uses for a prototype link. Its
   `@@iterator` closure must have `name: "[Symbol.iterator]"` and `length: 0`.

**S1 acceptance** (`scripts/run-test262-paths.mts --isolate --standalone`):
`built-ins/ArrayIteratorPrototype/next/{length,name,property-descriptor}.js`,
`built-ins/Iterator/prototype/Symbol.iterator/{is-function,length,name,prop-desc,return-val}.js`
— 8 rows fail → pass, with no loss anywhere in
`built-ins/{Array,Map,Set,String,TypedArray}`, `language/statements/for-of`,
`language/expressions/spread` (run those as the control set).

### S2 — `it.next` as a readable property, and the receiver brand check

`iterator.next.call(false)` is the shape of all ten Map/Set rows. Two things are
missing: reading `next` off a `$__IterRec` value at all, and the closure's
§23.1.5.2 step-2 receiver check.

1. **An `$__IterRec` arm in the object runtime's property read** (`__extern_get`,
   `src/codegen/object-runtime.ts`): on a record receiver, resolve the key
   through `__iter_rec_proto(receiver)` — i.e. the record has no own properties,
   so every read is a prototype read. This keeps one source of truth for the
   prototype and automatically picks up S1's `next`.
2. **Brand-check the `next` closure.** The native method closure installed on
   each family prototype must, when invoked with a receiver that is not a
   `$__IterRec` of the matching family, throw a **catchable** `TypeError`
   (never a `ref.cast` trap) — the same discipline as
   `recoverRegExpStructFromExternref` (`regexp-standalone.ts:3107`) and #2100 M2.
   A primitive receiver (`false`, `1`, `''`, `undefined`, `null`) and a plain
   object must both throw.
3. Calling `next` **through** the prototype on a genuine record must still step
   the record (`ArrayIteratorPrototype/next/iteration.js`), so the closure's
   happy path routes into the existing `__iterator_next`.

**S2 acceptance**: `built-ins/MapIteratorPrototype/next/*.js` (5),
`built-ins/SetIteratorPrototype/next/*.js` (5),
`built-ins/ArrayIteratorPrototype/next/{iteration,iteration-mutable}.js` (2)
— 12 rows fail → pass. Same control set as S1, plus
`built-ins/Map/prototype/{keys,values,entries}` and the `Set` twins.

### S3 — `new Int8Array([…])[Symbol.iterator]()` traps

Independent of S1/S2 and diagnosed only as far as the trap. Root-cause it before
changing anything: compile
`const ta: any = new Int8Array([1,2]); const it: any = ta[Symbol.iterator]();`
with `emitWat: true` and find which cast traps. The likely shape is that the
array-iterator builder's receiver discovery
(`compileNativeArrayIterator`, `array-methods.ts:3151`) expects a canonical
externref `$Vec` and a packed TypedArray carrier is not one — the same
representation-identity hazard #5349 hit. Fix at the receiver-normalisation
step, not by widening a cast.

**S3 acceptance**: the nine
`built-ins/ArrayIteratorPrototype/next/{Int8,Uint8,Uint8Clamped,Int16,Uint16,Int32,Uint32,Float32,Float64}Array.js`
rows fail → pass; control set
`built-ins/TypedArray/prototype/{values,keys,entries,Symbol.iterator}` plus the
whole `built-ins/TypedArrayConstructors` tree, 0 lost.

## Order-preservation and hazards

- **Never reorder `$__IterRec` fields 0..3.** Several bodies index them
  positionally.
- **The four static arms stay.** Removing them in favour of the dynamic one
  would change the answer for a statically-typed iterator from a constant-folded
  global read to a runtime call, and the #3013 identity pins would still pass —
  a silent cost regression with no test to catch it.
- **A `ref.cast` that never trapped is load-bearing.** Adding a field to a
  struct changes its canonical type; grep every `ref.test`/`ref.cast` against
  the IterRec type index before and after (#5349 round 3's lesson).
- **Host output must not move.** The whole lane is `ctx.standalone || ctx.wasi`.
  Prove it: compile a representative corpus on the JS-host target before and
  after and compare sha256 per module.
- **Execute each new site twice** (a loop, or two calls on different arms): a
  helper that caches a singleton in a global must initialise its result local on
  every execution, not only on the first (#5349 round 4 → 5).

## Validation required before the PR

- TS7 typecheck, lint, prettier.
- The five source-ratchet gates, bare **and** with `LOC_GATE_BASE=origin/main`;
  growth allowances go in this file's frontmatter with a dated rationale, never
  in `scripts/*-baseline.json`.
- `npm test -- tests/equivalence.test.ts` (all shards).
- A new pin file `tests/issue-6484-iterator-prototypes.test.ts` asserting, on
  standalone with `result.imports` `[]`: the prototype identity across all four
  array-iterator producers, cross-family distinctness (Array ≠ Map ≠ Set ≠
  String — two nulls compare equal, so a broken build must not read as green),
  `%IteratorPrototype%` as the shared parent, `next.length === 0` /
  `next.name === "next"`, and the TypeError on a primitive receiver.
- Row runs for the acceptance and control sets above, each against a base tree
  built from the merge-base sha (`git archive` + `pnpm run -s build:compiler-bundle`),
  reporting pass counts for base and branch side by side.
