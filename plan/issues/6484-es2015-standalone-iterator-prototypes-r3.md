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
# 2026-09-16 (S3) — `new <View>Array([…])[Symbol.iterator]()` needs a carrier arm in
# the native `__iterator` dispatcher (iterator-native.ts, +25 lines, almost all the
# doc block explaining why the IsArray filter was the wrong filter) and a
# TypedArray-only routing skip in the @@iterator call arm (call-tail-dispatch.ts,
# +18 lines). Both files are long-standing over-threshold codegen files; the change
# is additive by construction (a new `ref.test` arm / a new guarded branch) and has
# no smaller home — splitting either file is out of scope for a conformance slice.
loc-budget-allow:
  - src/codegen/iterator-native.ts
  - src/codegen/expressions/call-tail-dispatch.ts
# The +17 inside `compileTailDispatch` is the TypedArray guard plus the comment
# explaining why it is scoped to TypedArray and not to every array receiver.
# Splitting that 2,000-line dispatcher is #3399's job, not a conformance slice's.
func-budget-allow:
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
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

#### S3 — what was actually measured (2026-09-16), and where the plan was wrong

**It does not trap, and `compileNativeArrayIterator` is not involved.** The
program throws a catchable `TypeError: value is not iterable` — the §7.4.1
tail of the native `__iterator`. Evidence: a standalone probe that catches the
throw reports `name === "TypeError"` and a 21-character message containing
"not iterable"; the JS side sees `[object WebAssembly.Exception]` (a thrown
tag), not a `RuntimeError: illegal cast`.

**The plan is also wrong that S3 is independent of S1/S2.** Removing the throw
left all nine rows still failing, on a second, separate defect. The nine rows
needed two fixes:

1. **Dynamic (`any`) receiver — the carrier filter.**
   `collectVecFamilyCarriers` (`iterator-native.ts`) used
   `NON_ARRAY_BYTE_VEC_ELEM_KINDS` as its iterability filter. That set is an
   **IsArray classification** set (§7.2.2 — `Array.isArray(new Int8Array(1))`
   is `false`), and `object-runtime.ts` already says so in as many words at the
   `__extern_set` site. Using it here excluded the packed TypedArray element
   carriers `i8_byte` / `i16_byte` / `i32_elem`, so a dynamically-typed typed
   array matched no family arm. `i16_byte` was doubly excluded — it is not even
   in that set, but `boxVecElementToExternref` returns null for `i16`, so the
   carrier was dropped for "no proven boxing". The float views share the
   generic `f64` carrier with `number[]`, which is why Float32/Float64 never
   threw. Fix: filter only `i32_byte` (the raw ArrayBuffer/DataView byte store —
   neither object is iterable), and give `i8`/`i16` the `array.get_u` + f64-box
   recipe the strict spread provider and `__extern_get_idx` already use.
2. **Static receiver — the snapshot-vec carrier had no cursor.** The test262
   wrapper emits `var array = new Int8Array([3,1,2])`, which the checker types
   as `Int8Array`, NOT `any`. That takes the `resolveArrayInfo` arm in
   `call-tail-dispatch.ts`, which returns a snapshot `$Vec`; `iterator.next()`
   on a vec answers null and `result.value` throws "Cannot access property on
   null or undefined". This is the gap the #5147 note in that file documents and
   defers. Fix, scoped to a **TypedArray receiver only**: skip the snapshot
   producer and fall through to `__iterator(recv)`, which hands back a real
   `$__IterRec`. A plain-array receiver keeps the vec carrier byte-for-byte, so
   the #3013 `%ArrayIteratorPrototype%` identity rows S1 owns cannot move.

**Rows measured** (`--standalone`, `scripts/run-test262-paths.mts`, base tree =
the merge-base with both source files reverted via file copies, branch tree =
this commit; every chunk run in the same mode on both sides):

| set | rows | base | branch |
| --- | ---: | --- | --- |
| acceptance `ArrayIteratorPrototype/next/<View>Array.js` (`--isolate`) | 9 | 0 pass / 9 fail | **9 pass / 0 fail** |
| `built-ins/ArrayIteratorPrototype` siblings (`--isolate`) | 18 | 8 pass / 10 fail | identical per-row |
| `built-ins/ArrayBuffer` + `built-ins/DataView` | 802 | 546 pass | identical per-row |
| `built-ins/TypedArray/prototype` + `built-ins/TypedArrayConstructors` | 2,122 | — | identical per-row |

Control total 2,942 rows, **0 lost**, compared per-row (not just by count).
Host (JS-host/gc) output: a 12-module sha256 corpus is byte-identical base vs
branch — both edits are gated on `ctx.standalone || ctx.wasi`. The full
`tests/equivalence` suite has 22 failures across 10 files; all 22 are present on
the base tree too.

**Known residual, inherited not introduced:** the packed carrier is shared by
the signed and unsigned views of a width, so a negative `Int8Array` /
`Int16Array` element iterates as its unsigned bit pattern (`-1` reads `255`).
That is the documented #2903 R4 signedness boundary — every dynamic read
through `__extern_get_idx` already answers the same way — and recovering it
needs a per-signedness carrier type. The acceptance rows use only positive
values.

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
