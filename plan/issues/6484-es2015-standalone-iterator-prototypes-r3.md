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
# 2026-09-16 (review follow-up): iter-hof-native.ts owns `__iter_hof_open`, the
# positive-admission classifier for the eager Iterator helpers. The S2 carrier
# migration made `arr[Symbol.iterator]()` a `$__IterRec`, which that classifier
# did not admit, so `iter.reduce(cb, init)` silently stopped calling `cb`. The
# one-arm pass-through has to live beside the three arms it copies.
# 2026-09-16 (#6484 S3, merged into this branch): the TypedArray `@@iterator`
# fix adds the packed-carrier arms in iterator-native.ts and one dispatch arm
# each in call-tail-dispatch.ts, closed-method-dispatch.ts and index.ts; the
# iterator-family field it reads lives on the context type.
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/iter-hof-native.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/iterator-native.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/property-access.ts
  - src/codegen/map-runtime.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-09-16 (#6484 S3, merged here): the TypedArray `@@iterator` dispatch arm
  # in `fillClosedMethodDispatch` — one case beside the sibling carrier cases it
  # copies, so it stays with the dispatcher rather than moving out of it.
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  # 2026-09-16 (review follow-up): the `$__IterRec` pass-through arm of
  # `__iter_hof_open`. It is 4 instructions plus the comment that records the
  # measured `calls=3 → calls=0` regression it fixes, and it must sit with the
  # three sibling pass-through arms it copies — moving it out would separate the
  # classifier from one of its cases.
  - src/codegen/iter-hof-native.ts::fillIterHofSteppers
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

## Adversarial review of S1+S2 (2026-09-16) — what was wrong and what is left

Three findings. Two were ONE defect; the third was a false claim in a comment.

### 1 + 2. The run-time route was order-dependent (fixed)

`ensureIterRecPrototypeHelper` declined whenever `$__IterRec` was not registered
yet, and `emitBuiltinGetPrototypeOfFallback` deliberately calls it **before** it
compiles its argument (the #2043 index-shift discipline). So the module's FIRST
`Object.getPrototypeOf(<iterator>)` answered the historical `null`, while the
identical expression one statement later answered a real prototype:

```
.tmp/adv/p14.ts (first statement)  firstTouch=0     <- the #6484 defect, unfixed
.tmp/adv/p15.ts (one warm-up line) afterWarmup=1
```

Every pin in the first cut built its iterators in earlier statements, so all
seven were immune by construction. Test262 programs use the cold shape.

Finding 2 — `Object.getPrototypeOf(this.<field>)` inside a class METHOD
answering `null` while every other access shape answered the real prototype —
is the SAME defect reached by a different compile order: methods are compiled
before the top-level body, so the read inside the method was the module's first
occurrence. It needed no separate fix and is closed by the same change.

Fix: `ensureIterRecPrototypeHelper` now calls `ensureNativeIteratorRuntime(ctx)`
and re-reads `structMap`, exactly as its sibling `resolveIteratorFamilyNextClosure`
has always done. A module that asks either question has an iterator either way.
After the fix, cold-first: `firstTouch=1`, `mapFirst=1`, `protoNotNull=1`,
`fromInsideMethod=1`, and a cold module also gets `typeof it.next === "function"`,
cross-family distinctness and the shared `%IteratorPrototype%` root.

Two new pins (`tests/issue-6484-iterator-prototypes.test.ts`) put the
`getPrototypeOf` call FIRST, one at top level and one inside a class method.
Both fail on the pre-fix helper and pass after — verified by an A/B file-copy
revert, not by assumption.

### 3. Growth during iteration — the comment was wrong, the behaviour is #3100's

The #6484 latch comment claimed the length is re-read every step, full stop.
Measured 2026-09-16 (standalone, `push` after the first step; V8 yields 3 for
all three):

| receiver | steps |
| --- | --- |
| `["a","b"]` (externref elements) | 3 — live |
| `[{v:1},{v:2}]` (externref elements) | 3 — live |
| `[1,2]` (f64 elements) | **2 — snapshot** |

So the step body genuinely has no cached bound, and growth IS observed whenever
the record's `vec` is the subject's own storage. The reviewer's proposed
mechanism — "`push` reallocates and the immutable `vec` field hides it" — is
not what happens: `push` mutates the carrier in place and an alias of the array
reads `length === 3` (`.tmp/fix/alias.ts`: `bLen=3 aliasIdentity=1`). The real
cause is the **#3100 vec-family normalization arm** (`buildVecFamilyArms`),
which boxes a non-externref carrier into a FRESH `$__arr_externref` and cursors
over that copy. It predates this slice and applies to every dynamic
`GetIterator` on a numeric array.

The comment has been corrected to say exactly this. The behaviour is NOT fixed
here: making it live means re-deriving the per-carrier boxing at every step,
which reopens #3100's carrier-normalization tradeoff and touches the hottest
iteration path in the compiler. A pin locks the half that IS correct (the
externref carrier growing live, plus the exhaustion latch); the numeric-carrier
answer is deliberately left unpinned so a later fix does not have to fight a
test that locks in the wrong number.

**Residual (open, pre-existing, no test262 row):** a dynamic iterator over a
numeric array is a snapshot — mid-iteration `push` and `pop` are invisible
(`pushBeforeFirstNext` 12 vs 123, `shrinkMid` 123 vs 1). S1+S2 make this
reachable for a statically-typed receiver, which used to throw instead. The
test262 row that would catch it, `ArrayIteratorPrototype/next/iteration-mutable.js`,
grows from an EMPTY array, and that shape works (empty ⇒ no copy).

### 4. A control row the review did not report: the carrier migration silently broke `iter.reduce`

Found by running the full 641-row control set against a base tree built from
`66405a1244` (the merge base), not by the review. `built-ins/Iterator/prototype/
reduce/reducer-memo-can-be-any-type.js` PASSED on base and FAILED on S1+S2 —
and it fails on the S1+S2 commit alone, so it is the slice's, not the
order-dependence fix's.

Mechanism: `__iter_hof_open` (`src/codegen/iter-hof-native.ts`) is a
positive-admission classifier — it passes through the handles it knows
(`$LazyIterHelper`, a driven generator frame, a next-callable) and hands
everything else to the `__iterator` ladder only for the carriers that ladder can
take, with a NULL SENTINEL for the rest. S2 migrated `arr[Symbol.iterator]()`
from a snapshot `$Vec` (admitted) to a live `$__IterRec` (admitted by nothing),
so `iter.reduce(cb, init)` hit the sentinel and returned `undefined` **without
calling `cb` once** — measured on a 3-element probe: `calls=3` on base,
`calls=0` after the migration. Nothing threw; the failure was silent.

Fix: one pass-through arm — a `$__IterRec` IS the handle, exactly like the three
arms next to it, and `__iter_hof_next` / `__iter_hof_close` already delegate to
`__iterator_next` / `__iterator_return`, which take that record. It is also
closer to §27.1.4 than what it restores: stepping the record consumes the
iterator, where the snapshot-vec route read a frozen copy and left the cursor
untouched.

Pinned in `tests/issue-6484-iterator-prototypes.test.ts`
("an iterator VALUE still drives the eager helper loop").

**Process note:** the review's seven pin tests and the S1+S2 control evidence
were both narrower than the change. This row was only visible from a control set
that included `built-ins/Iterator/prototype/**` and a base measured on this
machine — the kind of run CLAUDE.md asks for and the kind this slice had skipped.

## S3 review round 2 — record (2026-09-16)

Two findings from the second adversarial review. Both reproduced on this tree
with the reviewer's own probes before being touched, both closed here.

### 1. REGRESSION (closed) — `Object.prototype.toString` on the diverted iterator went value → throw

`Object.prototype.toString.call(<any-typed TypedArray iterator>)` answered the
string `"[object Array]"` on base (length 14) and **threw** a catchable TypeError
on the S3 commit and after the round-1 fix. Reproduced exactly as reported:

| tree | `tag` | `tagOnly` | `stepsStillOk` |
| --- | --- | --- | --- |
| base `66405a1244` | 2 (`[object Array]`) | 14 | THREW |
| S3 `7eb5f8eb95` | 8 (catch arm) | THREW | 1 |
| round-1 `7088bf90b4` | 8 (catch arm) | THREW | 1 |
| **here** | **1 (`[object Array Iterator]`)** | **23** | **1** |

Cause: swapping the snapshot `$Vec` for a `$__IterRec` removed the receiver from
every arm of the §20.1.3.6 classifier — the classifier has a `$__vec_base` arm
but none for the record — so control reached the refusal tail. The round-1
`%ArrayIteratorPrototype%` arm did not help: it teaches `__getPrototypeOf` about
the record, and `Object.prototype.toString` does not consult it.

Fix: `fillIterRecObjectProtoToStringArm` (object-proto-tostring-native.ts), a
finalize splice giving a kind-VEC `$__IterRec` the tag `[object Array Iterator]`.

- **Why that tag and not base's `[object Array]`.** §23.2.3.36 makes
  `%TypedArray%.prototype[@@iterator]` be `.values`, i.e. `CreateArrayIterator`,
  so the object IS an Array Iterator and §20.1.3.6 step 15 reads `"Array
  Iterator"` off `%ArrayIteratorPrototype%`. Base's answer was the snapshot vec
  answering for itself — a value, but the wrong one. It also keeps the branch
  self-consistent: the round-1 arm already reports `%ArrayIteratorPrototype%` as
  this exact object's `[[Prototype]]`, and a tag of `"Array"` would contradict
  the prototype the same module hands out.
- **THREE consumers carry the classifier chain, not two.** The one that actually
  answers `Object.prototype.toString.call(v)` for an `any` `v` — the whole
  test262 surface — is `__object_proto_to_string_runtime`. Measured: in a module
  that only uses that spelling, `__opts_classify` and the reflective closure are
  **absent**, so the first cut of this fix (which patched only those two) had
  `consumers=0` and changed nothing observable. Named in the function's doc so
  the next person does not repeat it.
- **A durable flag was required.** `typedArrayIterRecProtoPending` is a one-shot
  cleared by `prependIterRecPrototypeArm`, which runs EARLIER in both finalize
  sequences, so it always reads false by the time the class-tag step runs.
  `typedArrayIterRecDiverted` is set once at the divert site and never cleared.

Scoping, proven not asserted — a 9-module sha256 corpus, `--target standalone`:
**exactly one module's bytes move base → here** (`c9-ta-iter.ts`, the
typed-array-iterator module). Plain-array iteration, string iteration, Map/Set,
ArrayBuffer/DataView, a non-iterating TypedArray, generators, class prototypes
and a plain `Object.prototype.toString` module are all byte-identical. Round-1 →
here is byte-identical on all nine, including `c9`: the arm costs bytes only in a
module that BOTH diverts a typed-array `@@iterator` AND calls
`Object.prototype.toString`.

Neighbour controls, unchanged from base (`p10-tostring-matrix`): plain-array
iterator `[object Array]`, plain object `[object Object]`, plain array
`[object Array]`, Map/Set iterator still REFUSE (they are `ITER_KIND_MAPSET`,
outside the arm).

**RESIDUAL, inherited from round 1 and verified here, not newly introduced.** A
string iterator is also a kind-VEC record, so in a module that iterates BOTH a
typed array and a string an `any`-typed string iterator now reports
`[object Array Iterator]` where base refused. This is the same missing `family`
field as round 1's prototype residual, which was measured independently rather
than taken on trust: `strIterProto` is `null` on base and
`%ArrayIteratorPrototype%` on round-1 AND here. S1's `family` field deletes both
arms at once. Not papered over with a different tag, because two arms disagreeing
about one record would be worse than one shared, documented gap.

Row impact: none. No test under
`built-ins/TypedArray/prototype/{Symbol.iterator,values,keys,entries}` asks for
the iterator's class tag (`grep -rln "Object.prototype.toString"` over those four
directories returns nothing), which is exactly why the row sets could not have
caught this and a probe had to.

### 2. VACUOUS PIN (closed) — the Map/Set distinctness test asserted nothing

Confirmed: `Object.getPrototypeOf(m.keys())` bound to an `any` local is `null` on
base AND on branch, so the old test's `pm !== aip` / `ps !== aip` were
`null !== <singleton>` — true whatever the arm does. The test could not have
caught the collapse it advertised, and its comment (and the round-1 commit
message) claimed Map/Set "keep their own singletons" when they keep `null`. That
claim is withdrawn.

Fixing it needed the module SHAPE, not a weaker assertion. The shape decides
which mechanism answers:

- **Shape A** — Map/Set queried only through an `any` local. The iterator stays a
  `$__IterRec`, so `__getPrototypeOf` and the new arm are what answer, and the
  answer is `null`. Pinning it AT `null` is what catches a collapse.
- **Shape B** — the same query with the static type visible. `m.keys()` has
  static type `MapIterator`, which fires the #3013 **compile-time** arm and
  reaches the real singleton, so every comparison is object-vs-object.

The `any` **local** is load-bearing: passing `m.keys()` straight into
`Object.getPrototypeOf` keeps its static type and never reaches the runtime arm.
That is the issue's own core defect, and it is why the first round-2 attempt —
one module carrying both spellings — still passed with the narrowing defeated.

Both shapes are now asserted, and the guard was verified to FAIL when it should:
forcing the arm's `kind == ITER_KIND_VEC` test to constant 1 (so every record
collapses onto `%ArrayIteratorPrototype%`) drives shape A's `dynIsNull` from
`3` to `0` and the test red. Restored afterwards; `tests/issue-6484-s3-typedarray-iterator.test.ts`
is 27/27 green on the real compiler.

### Note on the round-1 wasi coverage

While A/B-ing, a partial `src/` restore (leaving `closed-method-dispatch.ts` at
base) made the `--target wasi` pin fail and briefly looked like a new regression.
It was the restore, not the code: with the tree fully restored, the wasi test
passes. Recorded because the same partial-restore mistake is easy to repeat — a
file-copy A/B must restore EVERY file the branch touches, not only the ones the
current edit touches.
