---
id: 4275
title: "ES2015 IR: evaluate for-of ArrayAssignmentPattern with the iterator protocol (45 files)"
status: in-progress
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
model: gpt-5.6-sol
task_type: bugfix
area: ir, iterators, destructuring
language_feature: destructuring-binding
es_edition: 2015
goal: es6
parent: 4273
related: [680, 1169, 1182, 1347, 1430, 1642, 2566, 2669, 2952, 3523, 3643, 3783]
assignee: "ttraenkler/codex-es6-forof-dstr-ir"
test262_count: 45
origin: "2026-08-09 pinned exact-ES2015 census: 45 top-level for-of ArrayAssignmentPattern files consume a direct custom iterator; GC is 1 pass/44 fail and standalone is 0 pass/45 fail. Legacy lowering indexes the iterable instead of running the iterator protocol."
---

# #4275 — IR-own for-of ArrayAssignmentPattern iterator evaluation

## Exact opportunity

The exact ES2015 `test/language/statements/for-of/dstr/` population contains
524 files, not the 569 physical paths currently in that directory. Its broad
two-lane baseline is:

| Lane | Pass | Fail | Compile error | Timeout | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| GC/host | 323 | 195 | 1 | 5 | 524 |
| standalone | 320 | 176 | 28 | 0 | 524 |

This issue does not claim that whole heterogeneous directory. The strongest
causal discriminator is an **assignment** array pattern whose value is a direct
custom regular iterable:

| Source shape | Files | GC | Standalone | Non-pass in both |
| --- | ---: | --- | --- | ---: |
| `for ([pattern] of [customIterable])` | 57 | 1P / 56F | 45F / 12CE | 56 |
| declaration binding over the same source kind | 21 | 18P / 3TO | 18P / 3F | 3 |

Twelve of the 57 assignment files execute the `for-of` inside a generator
wrapper. They are excluded from the first programme because their standalone
compile errors require the generator carrier/state machine first. The exact
top-level target is therefore **45 files**:

- GC/host: 1 pass / 44 fail;
- standalone: 0 pass / 45 fail; and
- 44 same-file non-passes plus one standalone-only non-pass.

The 45-file family divides into exact prepared-IR slices:

| Slice | Shape admitted cumulatively | Files | GC baseline | Standalone baseline | Sorted-list SHA-256 |
| --- | --- | ---: | --- | --- | --- |
| A | fixed flat identifiers plus `[]`; no default, elision, rest, nesting, or member target | 16 | 0P / 16F | 0P / 16F | `167dbe1f2ae4b78c9a72a5c2d160a85786a42241ab71443e95023886b6f2372e` |
| A0 | A with only resolved identifier destinations | 15 | 0P / 15F | 0P / 15F | `28ec00e9aa79252e937d4d8a973215ef92191514b3a46320b0884327a4399f27` |
| B | A plus elisions | 27 | 0P / 27F | 0P / 27F | `dd4e734842cb1d1150551035f29a5bada42b275039d6749d03f276f291ffcc7c` |
| C | B plus identifier rest | 33 | 1P / 32F | 0P / 33F | `6113a313f3bad31c812cb84b88f06aeb2c05d2e4bc6af64e13799e565cbcbd53` |
| D | C plus nested/property/abrupt-reference targets | 45 | 1P / 44F | 0P / 45F | to be frozen before Slice D |

Hashes use sorted repo-relative paths joined by newline with one final newline.
The four `[]` tests are intentionally in Slice A: an empty pattern has no
identifier target, but it exercises the same fixed, default-free inner iterator
acquisition and close semantics. Excluding them leaves a 12-file non-empty
identifier core, 12/12 failing in both lanes, hash
`324e04aada72c3eeb29e586ece2f49fea838b87224ab7ea454cd6779cdcdcad9`.

One member of that 12-file core,
`array-elem-iter-thrw-close-skip.js`, assigns to undeclared `x`. Its `next()`
throws before `PutValue`, but a source-site selector may not discard the write
because this fixture happens not to reach it. Slice A0 therefore routes 15/15
files through IR and leaves that one file on the coherent fallback until IR
owns sloppy unresolvable assignment to the global object. Slice A may claim all
16 through IR only after that separate language semantic is implemented.

### Authentic literal-harness ownership blocker (2026-08-09)

The 15-file A0 classification is a sound **language-operation** boundary, but
it is not yet an immediately scoreable prepared-IR terminal. An authentic
`runTest262File` assembly concatenates the runtime shim, `assert.js`, `sta.js`,
and the untouched body at top level. The target `for` statement therefore
belongs to the source's single `<module-init>` terminal; it is not a nested
function that can be selected independently.

A production compile of
`array-elem-iter-nrml-close.js` with
`JS2WASM_IR_SHAPE_DIAG=1`, `experimentalIR: true`, and
`trackIrOutcomes: true` reports:

```text
unitKind=module-init
displayName=<module-init>
kind=unsupported
code=body-shape-rejected
detail=vardecl-var-kind:FirstStatement
legacyBodyEmitted=true
irBodyEmitted=false
irCompiledFuncs=[]
```

The non-empty fixtures also declare their destinations as top-level
uninitialized `var x;` / `var _;`. The four empty-pattern fixtures have no
destination, but the literal harness prefix itself still contains top-level
`var`, so they hit the same terminal gate. Allowing the loop selector alone
does not change this outcome.

#3783 owns genuine module-global `var` storage and hoisting; #3523 owns the
typed ordered module-init plan and prepared emission transaction. Shadowing a
script `var` with a function-local slot, wrapping only this Test262 body in a
synthetic function, or crediting a synthetic unit test would change observable
global semantics and is forbidden. The iterator substrate may land first, but
none of the 15 A0 rows is credited until the authentic module-init terminal is
IR-owned once.

Slice A paths are:

- `array-elem-iter-get-err.js`;
- `array-elem-iter-nrml-close-err.js`;
- `array-elem-iter-nrml-close-null.js`;
- `array-elem-iter-nrml-close-skip.js`;
- `array-elem-iter-nrml-close.js`;
- `array-elem-iter-thrw-close-skip.js`;
- `array-elem-trlg-iter-get-err.js`;
- `array-elem-trlg-iter-list-nrml-close-err.js`;
- `array-elem-trlg-iter-list-nrml-close-null.js`;
- `array-elem-trlg-iter-list-nrml-close-skip.js`;
- `array-elem-trlg-iter-list-nrml-close.js`;
- `array-elem-trlg-iter-list-thrw-close-skip.js`;
- `array-empty-iter-close-err.js`;
- `array-empty-iter-close-null.js`;
- `array-empty-iter-close.js`; and
- `array-empty-iter-get-err.js`.

Every path is relative to `language/statements/for-of/dstr/`.

## Root cause

The transitional assignment-pattern paths
`compileForOfAssignDestructuringExternref` and
`compileForOfIteratorAssignDestructuring` in
`src/codegen/statements/for-of-destructuring.ts` read each element as if the
value were an indexed array-like object:

```text
__extern_get(elem, box(index))
```

They do not perform `GetIterator`, call `next`, observe `done`, validate the
iterator result, step elisions, drain rest, or perform `IteratorClose`. This is
why acquisition errors, step/value errors, call counts, invalid `return()`
results, and close precedence all fail together. It is one mechanism, not a
collection of unrelated assertion strings.

The current IR path cannot own the source yet:

1. `src/ir/select.ts::isPhase1ForOfInScope` rejects every destructuring or bare
   assignment head and admits only a narrow declaration/identifier shape.
2. `src/ir/from-ast.ts::lowerForOfStatement` throws unless the head resolves to
   one identifier.
3. mutated-slot discovery does not record identifiers written through an
   assignment pattern, so the body contract can retain a stale carrier.
4. granular `iter.next` / `iter.done` / `iter.value` nodes are stale after
   `__iterator_next` changed to a `(done, value)` multi-value result;
   `src/ir/lower.ts` deliberately rejects them. Only declarative `forof.iter`
   consumes the current ABI.
5. `forof.iter` currently calls `return()` after normal exhaustion and does not
   close on a throw from the body. Its branch cleanup covers only selected
   `break`/crossing-label paths. Destructuring can throw, so admitting the
   pattern before repairing this would make abrupt completion observably wrong.
6. the vec fast path is not an escape hatch: nested vec types are not prepared
   through `resolveIrVecType`, `lowerArrayLiteral`, `vec.new_fixed`,
   `prepared-vector-support`, or the Program ABI. It also would not implement
   custom `Symbol.iterator` semantics.

Historic #1642 and #1182 are done but do not own this residual: #1642 covered
outer-loop close in transitional codegen, while #1182 deliberately shipped
identifier-only IR `for-of`. #2669 and #1430 remain broad destructuring owners;
this issue is their exact IR-native assignment-pattern child.

## Required semantic split: outer and inner iterators

Two independent iterator records exist in these tests:

- the **outer** `for-of` iterator produces one value per loop iteration; and
- the **inner** ArrayAssignmentPattern obtains a new iterator from that value.

Normal exhaustion does not close the outer iterator. `break` or an abrupt body
completion closes it exactly once while incomplete. The fixed inner pattern,
however, must close its iterator when the pattern finishes before the inner
iterator reports done; an empty `[]` therefore still acquires and normally
closes an incomplete inner iterator. Elisions perform steps, and rest drains to
done rather than closing early.

The implementation must track these `done` states independently and preserve
completion precedence. In particular, when destructuring throws, inner close is
performed as required and then the outer iterator is closed; the original
abrupt completion wins over an error thrown while closing the outer iterator.
Normal inner close errors and non-object `return()` results remain observable
where the specification requires them.

## IR implementation programme

### Slice 0 — make `forof.iter` completion-correct

- Extend `IrInstrForOfIter` and its builder/from-AST plan with an explicit i32
  outer-done slot and remove the stale single-result slot left from the old
  pre-multi-value ABI.
- Acquire the iterator outside the protected body and initialise done to false.
  Set done to true **before each `next` call**, then replace it with the returned
  done flag only after the atomic `(done, value)` step succeeds. A throw from
  `next`, `done`, or `value` therefore does not call `return()`, while a later
  body/destructuring throw sees the iterator as incomplete.
- Run `return()` after the loop only when incomplete; do not call it after
  normal exhaustion.
- Before every close, mark done true. On a body throw, close the incomplete
  outer iterator inside a nested try and rethrow the original completion even
  if outer close throws. A normal `break`/truncation closes once and propagates
  close errors. Carry the done slot through `CtrlFrame`/crossing-label cleanup
  and use the same guarded, set-before-call recipe without double-close.
- Mirror the proven direct-codegen throw-wins pattern covered by #1347, but own
  the terminal through IR and record its prepared outcome.

### Slice A — fixed flat assignment pattern

The enumerated files use the existing outer array/vec route, so they exercise
the shared close state machine through the new **inner** operation rather than
through outer `forof.iter`. Slice 0 remains a required shared correction for
future custom-outer-iterator ownership and must not be credited as these 15
file flips.

- Introduce one exact source-site plan shared by selector and lowering, for
  example `forOfDestructuringPlan(stmt)`. It returns a frozen plan only for
  Slice A0's resolved-target **operation shapes** and `undefined` otherwise.
  The 16th file remains fallback until unresolved sloppy assignment is
  prepared. Authentic Test262 ownership additionally requires #3783/#3523;
  function-local probes are substrate evidence, not file flips.
- Prove every non-empty target is an already-existing writable mutable slot.
  Do not create bindings. Reject const/TDZ, unresolved or module/global names,
  captures, duplicate/unsafe targets, defaults, rest, elisions, nesting,
  member targets, generators, and override-uncertain iterator shapes.
- Extend mutated-slot discovery for the exact planned identifiers and use a
  value-based identifier-store helper rather than synthesising an AST right
  hand side.
- Add an explicit structured inner array-assignment operation, for example
  `iter.destructure.fixed`, over the existing atomic
  `(iterator) -> (i32 done, externref value)` step ABI. It carries the source
  iterable, iterator/done/value slots, ordered assignment/elision steps, and
  frozen `{getIterator, next, close}` provider references. Register it in the
  IR structural walkers, effect/verifier tables, local allocation and use
  collectors, preparation/dependency collectors, and relevant pass switches.
  Do not model it as a `forof.iter` body prelude and do not revive the stale
  split `iter.next/done/value` contract.
- Keep values on the dynamic carrier. Do not infer number/string/vec semantics
  from these test shapes.
- Make inner iterator acquisition, result validation, early fixed-pattern
  close, invalid `return()` result, and abrupt-completion precedence explicit in
  the IR/provider contract.
- An already-exhausted inner iterator assigns canonical `undefined`. Empty `[]`
  still performs GetIterator and closes normally without calling `next`.
- Preserve AssignmentElement order: resolve the destination before the
  corresponding iterator step, then observe `done`/`value`, evaluate any later
  default, and finally perform the write. The fixed identifier slice makes
  destination resolution inert, but the IR shape must not prevent Slices B–D
  from retaining the specified order.

Do **not** implement Slice A with a host-only bounded materializer. A
materializer front-loads all steps before the assignment writes, cannot preserve
AssignmentElement ordering as the plan grows, hides the two independent done
states/close precedence, and creates a second ABI that standalone cannot share.
Current `_drainIterable` also fails to close a plain native iterator on finite
stop. Both host and standalone must implement the same semantic operation over
the atomic step contract before Slice A0 outcomes are claimed. Slice A's 16th
outcome additionally requires sloppy unresolvable PutValue. A backend without
the iterator provider rejects before selection; it does not leak imports or
withdraw after claiming.

### Provider and preparation prerequisites

The semantic operation is not ready to select until both backends satisfy the
same provider contract:

- Host `__iterator` validates that GetIterator returned an Object.
- Host `__iterator_next` validates the iterator result Object and does not read
  `value` when `done` is true.
- Host `__iterator_return` distinguishes an absent/null `return` method (a
  no-op) from the result of calling a present method, and rejects every
  non-Object call result, including null or undefined.
- Standalone GetIterator and next apply the same Object checks instead of
  degrading falsy/non-Object results. Its return dispatcher must expose method
  presence separately from call result; the current null sentinel cannot
  distinguish an absent method from `return() { return null; }`.
- Preparation adds host iterator imports or ensures the native iterator runtime
  before sealing. It traverses instructions deeply, freezes exact provider refs
  after transforms, records them in prepared-component dependencies, and makes
  lowering resolve those refs rather than hard-coded helper names.

Selector capability is the frozen prepared plan itself, never a target-mode
proxy. If any provider is unavailable, selection fails closed before claiming
the terminal.

### Slices B–D

- B adds elision stepping without binding a value.
- C adds identifier rest by draining the inner iterator to done.
- D adds property/nested targets and their reference-evaluation/abrupt
  completion rules through existing IR stores. Freeze its exact list/hash
  before implementation.

Each slice extends the same source-site plan monotonically. No slice may broaden
the legacy indexed-array impostor or add Test262 filename checks.

## Required tests and evidence

- exact plan positive and negative matrices, including every rejected syntax,
  target mutability, target backend, generator wrapper, and iterator-override
  boundary;
- prepared report proves each targeted terminal is `kind=emitted`,
  `legacyBodyEmitted=false`, and `irBodyEmitted=true` with no post-claim
  withdrawal;
- two loop iterations write distinct values to the existing target slots;
- normal outer exhaustion does not call outer `return`; `break` calls it once;
- inner fixed completion closes an incomplete iterator once; empty `[]` has the
  same acquisition/close behavior and does not call `next`;
- acquisition, `next`, `done`, and `value` abrupt completions preserve source
  order and close requirements;
- `done: true` does not touch the value getter or call `return`;
- destructuring/body throw closes the incomplete outer iterator once and the
  original throw wins even if outer `return` throws or is non-callable;
- inner `return()` returning a primitive throws TypeError where required;
- iterator `return` observes the correct receiver and zero arguments;
- the targeted IR route never calls the legacy indexed `__extern_get` path;
- rejected standalone/linear/WASI cases gain no host imports and retain one
  coherent fallback contract; and
- the exact slice is rerun through the authentic Test262 harness in both lanes
  with file-level gains and losses.

Primary regression references are `tests/issue-2952-slice3.test.ts` for branch
cleanup, `tests/issue-1347.test.ts` for throw-wins precedence, and
`tests/issue-3643-array-dstr-getiterator.test.ts` for strict GetIterator.

## Acceptance criteria

- [ ] Slice 0 makes existing prepared `forof.iter` close exactly once while
      incomplete, never after normal exhaustion, and on body throws with the
      required completion precedence.
- [ ] Slice A's measured 16-file list and Slice A0's safely routable 15-file
      list are reproduced at their recorded hashes and measured before/after in
      both lanes.
- [ ] All 15 Slice A0 files pass in GC/host and standalone through the same
      semantic IR operation and backend-specific prepared providers. The
      undeclared-target outlier remains a coherent fallback until sloppy
      unresolvable PutValue is owned; linear or otherwise unavailable backends
      reject before claim without host-import leakage or false credit.
- [ ] The literal-harness `<module-init>` terminal containing each target loop
      is emitted once by prepared IR through #3783/#3523-compatible
      module-global storage; no local shadow, body-only wrapper, or synthetic
      probe is counted as a Test262 pass-rate gain.
- [ ] Targeted loop terminals and assignment stores are emitted once by
      prepared IR, with no legacy body and no Test262-shaped code path.
- [ ] Slices B and C reach 27 and 33 files respectively without regressing prior
      slices; Slice D freezes its 45-file list before claiming it.
- [ ] Generator-wrapper files remain owned by the generator programme rather
      than being counted as failures of this slice.
