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
# 2026-09-16 (S3 review round 1) — closing the two review findings adds, on top of
# the above: the `%ArrayIteratorPrototype%` finalize arm + its doc block
# (iterator-native.ts, ~+70, mostly the block explaining the three narrowings that
# keep it from collapsing Map/Set), the singleton materialisation at the divert
# site (call-tail-dispatch.ts, +19), one ctx flag with its doc comment
# (context/types.ts, +10), the `|| ctx.wasi` gate with the comment naming why
# Map/Set hid the gap (closed-method-dispatch.ts, +7), and two finalize call sites
# plus an import (index.ts, +4). types.ts is the single declaration site for
# CodegenContext and index.ts owns the finalize sequence — neither has another
# home, and the arm cannot be armed without a flag set during body compilation.
loc-budget-allow:
  - src/codegen/iterator-native.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/context/types.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/index.ts
# The +17 inside `compileTailDispatch` is the TypedArray guard plus the comment
# explaining why it is scoped to TypedArray and not to every array receiver.
# Splitting that 2,000-line dispatcher is #3399's job, not a conformance slice's.
# 2026-09-16 (S3 review round 1) — `fillClosedMethodDispatch` +7 is the comment on
# the `|| ctx.wasi` gate (the gate itself is one token); `generateModule` +2 and
# `generateMultiModule` +1 are the two finalize call sites, which must live in the
# finalize sequence itself. Splitting any of the three is #3399's job.
func-budget-allow:
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
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

#### S3 review round 1 (2026-09-16) — two findings, both closed

An adversarial review of the S3 commit raised one regression and one coverage
gap. Both reproduced on my own tree; both are fixed here. One factual correction
to the report is recorded below, because it changes what "correct" means for the
first one.

**(1) REGRESSION — the diverted iterator had no `[[Prototype]]`.** The divert
replaces a snapshot `$Vec` with a `$__IterRec`, and #3013 says in as many words
that the record does not model `[[Prototype]]`. So
`Object.getPrototypeOf(<any-typed binding of <typedArray>[Symbol.iterator]()>)`
answered **`null`** on the S3 branch. Reproduced exactly as reported
(`.tmp/repro_proto2.ts`: branch `bits=1`, base `bits=4`).

*Correction to the report.* The report says base answered "the same object a
plain Array's iterator has (%ArrayIteratorPrototype%)". It did not. Base
answered **`%Array.prototype%`** — the snapshot vec's own answer, because a vec
and the array it snapshots are the same carrier, which is the collapse #3013's
own doc block warns about. Measured with a probe the reviewer's bitmask cannot
express (`.tmp/diag1.ts`, base tree):

| probe (base tree, `any` binding) | result |
| --- | --- |
| `p === Object.getPrototypeOf(arr)` (`%Array.prototype%`) | **true** |
| `p === Object.getPrototypeOf([].values())` (the real `%ArrayIteratorPrototype%`) | false |
| `Object.getPrototypeOf([].values()) === null` | false — the singleton exists and differs |

So the reviewer's expected value of `4` is `%Array.prototype% === %Array.prototype%`,
not the spec identity. Their own corroborating probe shows it: `protoHasNext=0`
on **both** trees — base's answer has no `next`, so it was never
`%ArrayIteratorPrototype%`.

*Fix* — a down-payment on this issue's own S1 step 3/4, using the carrier `kind`
tag S1 will replace with a `family` field:

- `call-tail-dispatch.ts`: at the divert site, materialise the #3013
  `%ArrayIteratorPrototype%` singleton (and drop it — the point is the lazy
  global) and set `ctx.typedArrayIterRecProtoPending`.
- `iterator-native.ts`: `prependIterRecPrototypeArm` — a finalize arm on
  `__getPrototypeOf` answering that global for a `ref.test $__IterRec` whose
  `kind` is `ITER_KIND_VEC`.

Three narrowings keep it from collapsing the other families, which is the exact
hazard #3013 documents:

1. **Armed only when a typed-array `@@iterator` divert compiled in this module.**
   Proven, not asserted: an 8-module sha256 corpus (`--target standalone`) is
   byte-identical base → S3-branch → this commit for array iteration, string
   iteration, Map/Set, ArrayBuffer/DataView, a non-iterating TypedArray,
   generators and class prototypes. **Exactly one** module's bytes move, the one
   that iterates a typed array.
2. **`kind == ITER_KIND_VEC` only**, so a Map/Set record (`ITER_KIND_MAPSET`)
   keeps its own singleton. (The issue text above says the `kind` tag cannot
   tell iterator families apart — measured, it *does* separate MAPSET from VEC;
   what it cannot separate is Array from String, both VEC.)
3. **A null singleton global falls through** to the pre-change answer.

Measured after the fix (`.tmp/p_identity.ts`, standalone, `imports=[]`):
`taIterIsAIP=4` (not null · IS `%ArrayIteratorPrototype%` · is NOT
`%Array.prototype%`), `taIterIsAIPTwice=2` (stable when the site runs twice —
the #5349 r4→r5 lazy-global hazard), `crossFamily=15` (Array/Map/Set all
distinct, TypedArray joins Array), `mapSetAnyProto=0` (no collapse).

**RESIDUAL, stated plainly:** a string iterator is also a kind-VEC record, so
*inside a module that also iterates a typed array* an `any`-typed string
iterator now reports `%ArrayIteratorPrototype%` instead of `null`. Both answers
are wrong (`%StringIteratorPrototype%` is right); the statically-typed routing
that every test262 program actually takes is untouched. **S1 closes it** — when
the `family` field lands, delete `prependIterRecPrototypeArm` and let
`__iter_rec_proto` answer. The second residual is unchanged and is S1's too: a
plain array's iterator still reports `%Array.prototype%` under an `any` binding,
because the vec carrier IS the array.

Not reachable from the test262 idiom, and this is worth knowing before anyone
spends a row run on it: with the binding left un-annotated (`var iterator =
array[Symbol.iterator]()`, which is what the harness compiles — the checker
infers `ArrayIterator`), the #3013 compile-time arm answers and both trees are
correct. Measured: `.tmp/diag2.ts` `inferredBinding=4` on the S3 branch. The
regression needed an explicit `: any`.

**(2) COVERAGE GAP — the static-receiver fix did not take effect under
`--target wasi`.** Reproduced: `taStep` threw on the branch under wasi and
answered `3121` under standalone. Root cause is one gate, and it is older than
S3: the #5147 native-iterator `.next()` arm in
`closed-method-dispatch.ts` was `ctx.standalone` alone, so under wasi
`iterator.next()` on a `$__IterRec` fell through to `__extern_method_call` and
threw `next is not a function`. Map/Set hid it — `map-runtime.ts` prepends its
OWN `$__IterRec.next()` arm to `__extern_method_call`, so only the vec carriers
were exposed (measured: `.tmp/p_mapnext.ts` passes on both targets, before and
after). Fix: `(ctx.standalone || ctx.wasi)`. After it, wasi matches standalone
exactly on every probe (`taStep=3121`, `taNextShape=103`, `taAnyNextShape=103`),
still `imports=[]`.

**Rows re-measured after the review fixes** (`--standalone`,
`scripts/run-test262-paths.mts --isolate`, `COMPILER_POOL_SIZE=2`; base tree =
`HEAD~1` via file copies of all five sources, so both sides ran in the same
process/mode). Compared **per row** — the `(status, path)` pairs of the two
non-pass lists, not the counts:

| set | rows | base | this commit | per-row delta |
| --- | ---: | --- | --- | --- |
| acceptance `ArrayIteratorPrototype/next/<View>Array.js` | 9 | 0 pass | **9 pass** | +9 |
| `built-ins/ArrayIteratorPrototype` (whole tree) | 27 | 8 pass / 19 fail | **17 pass / 10 fail** | +9, **0 lost** |
| `built-ins/{String,Map,Set,RegExpString,AsyncFromSync}IteratorPrototype` + `built-ins/IteratorPrototype` | 84 | 28 pass | 28 pass | **identical pairs** |
| `built-ins/{Object,Reflect}/getPrototypeOf` | 49 | 39 pass | 39 pass | **identical pairs** |
| `Array/prototype/{values,keys,entries,Symbol.iterator}` + `String/prototype/Symbol.iterator` + `Map/prototype/entries` + `Set/prototype/values` | 71 | 53 pass | 53 pass | **identical pairs** |
| `TypedArray/prototype/{Symbol.iterator,values,keys,entries,from,of}` + `TypedArray/{from,of}` | 89 | 40 pass | 40 pass | **identical pairs** |

Control total **293 rows, 0 lost**. The iterator-prototype and `getPrototypeOf`
families are the sets the new `__getPrototypeOf` arm could plausibly move, and
they do not move. The S3 commit's larger controls
(`built-ins/{ArrayBuffer,DataView}` 802, `TypedArray/prototype` +
`TypedArrayConstructors` 2,122) were **not** re-run here; the corpus proof above
is what stands in for them — those modules' bytes are identical base → this
commit, so their rows cannot move. Say so rather than implying they were re-run.

Host (`--target gc`) output: the 8-module corpus is byte-identical base vs this
commit on every module. WASI bytes move for exactly the three modules that call
`.next()` on a native iterator record, which is the fix; their behaviour under
wasi is unchanged or repaired (`c02-string-iter` base **threw**, now answers;
`c03-map-set` identical; `c08-typedarray-iter` base `312`, now `10312`).

Equivalence suite (6 shards, `VITEST_FORK_MAX_OLD_SPACE_SIZE=2048` — the 512 MB
default fork heap OOMs shard 3 on **base too**, so that is the box, not the
change): 1,745 tests, **22 failures across 10 files**, and re-running those 10
files on the base tree gives the **same 22 of 124**. None is iterator- or
TypedArray-related.

**Out of scope, found in passing, PRE-EXISTING on base (both targets):**
`[...new Int8Array([3,1,2])]` — a *statically*-typed typed-array spread — emits
an invalid module, `array.get: Immediate array type … has packed type i8. Use
array.get_s or array.get_u`. Verified on the base tree, so S3 did not introduce
it; the dynamic spread (`[...({} as any)]` holding the view) is fine. Worth its
own issue — the packed-carrier `array.get_u` discipline S3 applied to the
iterator arms has at least one more site.

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
