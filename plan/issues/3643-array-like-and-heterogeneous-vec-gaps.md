---
id: 3643
title: "Three measured host-lane gaps: array destructuring never throws, `Array.from` ignores array-like `length`, and a heterogeneous vec null-derefs in slice/flat"
status: done
sprint: 78
created: 2026-07-26
updated: 2026-08-18
completed: 2026-07-31
assignee: ttraenkler/dev-core-semantics
priority: high
loc-budget-allow:
  # UNION of both slices' grants — deliberately not `--theirs`. A grant only
  # resolves from a file the change-set itself touches, so dropping either
  # slice's entries here would pass locally and fail the CI `quality` ratchet.
  #
  # Slice A registers the bounded STRICT drain `__array_from_iter_n_strict`.
  # In `src/runtime.ts` that is one extra `resolveImport` arm plus the comment
  # recording WHY it is a separate import rather than a strictness flag on
  # `__array_from_iter_n` (that import is shared with `__array_from_mapped` and
  # `__iterator_rest`, both of which must KEEP the array-like fallback — the
  # exact trap this note exists to stop the next reader falling into).
  # In `src/codegen/destructuring-params.ts` it is a one-line name selection
  # plus the comment recording the measured pre-fix answer and the
  # standalone/WASI carve-out (#2904: emitting the strict name there would leak
  # an `env::` import and break zero-import instantiation).
  #
  # Slice B adds `_arrayFromNonIterableSource` — the §23.1.2.1 step-6
  # non-iterable array-like arm for `Array.from` — plus the comment recording
  # the measured pre-fix answer and WHY the fix reuses `_wrapForHost` (the
  # proxy that already makes `slice.call(arrayLike)` correct on the identical
  # receiver) instead of re-implementing the spec step.
  #
  # No new branch structure in either file; splitting `resolveImport` is
  # #3399's job, not these slices'.
  - src/runtime.ts
  - src/codegen/destructuring-params.ts
func-budget-allow:
  # The same union at function granularity. `resolveImport` is the host-import
  # factory — a new import arm has nowhere else to live until #3399 splits it,
  # and both slices add one. `destructureParamArray` gains a one-line drain-name
  # selection plus the standalone/WASI carve-out comment; its externref fallback
  # must stay in one piece because the late-import / funcIdx-shift bookkeeping
  # around it is order-sensitive (#3010). Slice B's helper
  # `_arrayFromNonIterableSource` is a NEW top-level function, not more weight
  # in the factory.
  - src/runtime.ts::resolveImport
  - src/codegen/destructuring-params.ts::destructureParamArray
trap-growth-allow:
  count: 1
  reason: "fail -> fail flavour change, NOT a new regression. The baseline (test262-current.jsonl, oracle_version 12, honest lane) records array-like-has-length-but-no-indexes-with-values.js as status:fail with 'The newly created array's length ... Expected SameValue(«0», «5») to be true' — it failed at line 26, the FIRST assertion, because Array.from ignored the array-like length. Confirmed by checking origin/main's src/runtime.ts into this branch and reproducing the identical error at the identical line, rather than inferring the prior state from the gate's 'Newly trapping' wording. Slice B makes that first assertion pass, so execution now reaches line 33, Array.from({length}).map(...), and hits a PRE-EXISTING illegal_cast trap that Slice B neither introduces nor touches. Isolated by probe: Array.from('ab').map(f) and Array.from({length:5}).map(f) both trap on origin/main untouched by this PR, and in the latter case Array.from returns [] there so the callback is invoked ZERO times — the trap does not require the closure to run. Array.from(['a','b']).map(f), Array.from([1,2]).map(f) and [undefined,undefined].map(f) all pass, so it is neither the element type nor undefined elements: it is .map(<compiled closure>) on the host JS array that Array.from returns for any non-vec source. Filed as its own bug with the full probe table in #3916; fixing it is a codegen/representation change (the T[] return type is lowered as a WasmGC vec while the runtime returns an externref host array) well outside this slice's scope. Category: illegal_cast 76 -> 77 (+1), the single file named below."
  tests:
    - test/built-ins/Array/from/array-like-has-length-but-no-indexes-with-values.js
horizon: m
feasibility: medium
task_type: bug
area: runtime
language_feature: destructuring, array-methods, iteration-protocol
es_edition: multi
goal: core-semantics
related: [3637, 2836, 3486, 3916]
origin: "Measured while auditing #3637. Each item was A/B'd against #3637's merge base and is byte-identical there, so none is caused by #3637 — they are separate, pre-existing gaps that the audit surfaced."
---

# #3643 — three measured host-lane gaps surfaced by the #3637 audit

## Correction — 2026-07-31 (re-measured before implementing)

Everything below the `## Measurements` heading is the **original filing, kept
visible as superseded**. Two of its claims did not survive re-measurement. All
numbers in this section: **harness `runTest262File`** (the authoritative path —
real upstream harness assembly + strict rerun), **host lane** unless stated,
**`origin/main` @ `51c8d8a8`** (verified equal to
`gh api repos/loopdive/js2/commits/main`). Controls: a designed-fail probe went
red (so the battery is non-vacuous) and every slice control was green before any
edit.

**All three slices did still reproduce** — 7 defect rows / 13 probes; A 3/3,
B 2/2, C 2/2. But:

### Correction 1 — Slice A row 3 is harness-dependent, and A is ONE defect, not two

The table records `function f([p]) {}; f({a:1})` as **trapping** while the `var`
form silently binds. That difference is an artifact of the measuring harness:

| harness                          | `function f([p]){}; f({a:1})`           |
| -------------------------------- | --------------------------------------- |
| bare `compile()` + `wrapExports` | traps "dereferencing a null pointer"    |
| `runTest262File` (authoritative) | returns `undefined` — same as `var [p]` |

So the original's "two binding forms fail **differently** … two distinct paths"
framing is wrong, and with it the implied two-fix scope. Both forms have the
same defect.

**The real one-variable diff** (which the original did not run): `var [a] = null`
and `var [a] = undefined` **already throw** TypeError — #1225's guard. `var [a] = 5`,
`= true`, `= {a:1}` do not. And **array SPREAD already throws**: `[...{b:1}]` was
a _passing_ control before any change. So the strict-drain machinery existed
(#1454/#3637) and only the destructuring arm was unwired. Slice A is a
**strictness wiring fix at an existing guard**, not a new GetIterator machine.

Additional rows measured, all failing the same way on `origin/main` and all
fixed by the same one-line wiring: `var [...r] = {a:1}`, `var [p,...r] = {a:1}`,
and an **array-LIKE** RHS `var [a,b] = {length:2, 0:'x', 1:'y'}` (array-like is
_not_ iterable, so this must throw even though `slice.call` walks it happily).

**Residual, NOT fixed by the Slice A PR:** `var [] = {a:1}` (empty pattern) still
does not throw. §8.6.2 runs GetIterator before the empty-pattern rule, so it
should — but the empty-pattern path deliberately performs no materialisation at
all (#1016/#3010: an empty pattern must not call `.next()`), so it needs a
separate GetIterator-only probe. Recorded here so a later sweep does not read
Slice A as complete.

### Correction 2 — Slice C is misdiagnosed, and its control was invalid

It is **not** a `slice`/`flat` defect and **not** about heterogeneity as such:

| source                                          | measured                              |
| ----------------------------------------------- | ------------------------------------- |
| `var a = [{x:1}, 2];` **alone**, no method call | **traps** at the literal line         |
| `[{x:1}, 1].concat([])`                         | **traps**                             |
| `[1, {x:1}].concat([])`                         | passes                                |
| `[2, {x:1}].slice(0)` / `.flat()`               | passes                                |
| `[{x:1}, "s"].slice(0)`                         | `r[1] === null` — **silent, no trap** |
| `[1, "s"].slice(0)`                             | `r[1] === NaN` — **silent, no trap**  |

**Lead with the silent corruption, not the trap.** A trap fails loudly and
stops; a silently wrong element propagates into whatever consumes it. The
`null`/`NaN` rows are the worse half of this defect.

**The discriminator is element ORDER, not the method.** The original's `concat`
"working control" was `[1, {x:1}]` — **number-first** — while its failing cases
were object-first. _A control that varies the discriminating variable is not a
control_: it proved nothing and actively misdirected the diagnosis toward
`concat`/`slice`/`flat`.

**Root cause**: first-element-wins element typing in `compileArrayLiteral` /
the tuple lowering (`src/codegen/literals.ts`) — the element that does not fit
the first element's inferred type is destroyed at CONSTRUCTION (`ref.null` for a
reference slot, `NaN` for an f64 slot), and the later read traps or returns the
wrong kind. This is **exactly** the root cause #2190c already fixed, but #2190c
gated its widenings on `ctx.nativeStrings` and covered only the _string-first_
and _number-first-with-`any`-context_ orderings. The **object-first** ordering is
unfixed, and I A/B'd host vs standalone: **both lanes fail identically**, so it
is not a lane gap.

Slice C therefore belongs to the value-rep substrate family (#2190c, #2773), not
to array methods, and is larger than `horizon: m`. It is being sized separately
rather than forced into this issue.

### Slice status

- **Slice A** — fixed (host lane). `__array_from_iter_n_strict`; tests in
  `tests/issue-3643-array-dstr-getiterator.test.ts`, kill-switch verified (6 red
  on revert, 8 controls green). Standalone lane unchanged by construction and
  A/B-verified byte-identical.
- **Slice B** — still open, unchanged by Slice A.
- **Slice C** — re-scoped per Correction 2; see above.

## Provenance

These were found while enumerating `__vec_len` discriminator sites for #3637 and
were explicitly held **out of that PR's scope**. Every row below was A/B'd
against #3637's merge base (`upstream/main` @ `6f3e43580`) and is **byte-identical
with and without #3637**, so none of them is a regression from that change — the
audit simply walked past them.

Unclaimed on purpose. Three independent slices; take one or all.

## Measurements

Compiled with `compile(src, { fileName: "probe.mjs" })` and run through
`wrapExports`. `host` is what plain V8 answers for the identical source.

### Slice A — array destructuring never performs GetIterator

| source                             | got                                      | host        |
| ---------------------------------- | ---------------------------------------- | ----------- |
| `var [p] = { a: 1 }`               | binds `undefined`, no throw              | `TypeError` |
| `var [p, q] = { a: 1, b: 2 }`      | binds `undefined, undefined`             | `TypeError` |
| `function f([p]) {} ; f({ a: 1 })` | **traps** "dereferencing a null pointer" | `TypeError` |
| `var [p] = [7]`                    | `7` (correct)                            | `7`         |

§8.6.2 ArrayBindingPattern requires GetIterator(§7.4.2) on the RHS, which throws
`TypeError` for a non-iterable. Array destructuring does **not** route through
the `__iterator` host import — #3637 made `__iterator` itself spec-correct
(`for (x of {a:1})` now throws), and destructuring was measurably unaffected,
which localises the gap to the destructuring lowering rather than the host
import.

Note the two binding forms fail **differently**: a `var` pattern silently binds
`undefined`, a **parameter** pattern traps. Two distinct paths; neither reaches
the spec's TypeError.

### Slice B — `Array.from` ignores `length` on a WasmGC array-like

| source                                           | got                 | host          |
| ------------------------------------------------ | ------------------- | ------------- |
| `Array.from({ length: 2 })`                      | `[]`                | `[null,null]` |
| `Array.from({ length: 2, 0: "a", 1: "b" })`      | `[]`                | `["a","b"]`   |
| `Array.from([1, 2, 3])`                          | `[1,2,3]` (correct) | `[1,2,3]`     |
| `Array.prototype.slice.call({length:2,0:5,1:6})` | `[5,6]` (correct)   | `[5,6]`       |
| `({length: 2, 0: 5, 1: 6}).length`               | `2` (correct)       | `2`           |

§23.1.2.1 step 6: when the source is **not** iterable, `Array.from` falls back to
`LengthOfArrayLike` + indexed reads. The struct's `length` field is readable
(row 5) and `slice.call` already does the array-like walk correctly (row 4), so
only `Array.from`'s non-iterable fallback is missing for a WasmGC receiver.

**FIXED — 2026-07-31.** This diagnosis held up exactly. `slice.call` was correct
because it routes the receiver through `_wrapForHost` (the live-mirror proxy
over a WasmGC struct); `__array_from` did not, so native `Array.from` read
`length` off an opaque object as `undefined` and answered `[]`. The fix
(`_arrayFromNonIterableSource`) routes a non-vec, non-iterable struct through
that same proxy, so the spec's own step 6 runs rather than being
re-implemented.

Three further rows failed the same way on `origin/main` and were never listed
here — all fixed by the same change: `Array.from(arrayLike, mapFn)` (answered
`[]`), `length` coercion (`{length: "2"}`), and sparse indices
(`{length: 3, 1: "b"}`). Plus the parity row: `Array.from` and
`Array.prototype.slice.call` now agree on the identical receiver.

**Residual, NOT fixed and A/B-verified pre-existing:** an object carrying BOTH a
`length` and a callable `@@iterator` still answers `[]` — it failed identically
on unmodified `origin/main`, so it is a separate gap in the
`@@iterator`-on-a-struct path, not collateral. Recorded so a later sweep does
not read Slice B as covering it.

### Slice C — heterogeneous vec null-derefs in `slice` / `flat`

| source                        | got                                      | host          |
| ----------------------------- | ---------------------------------------- | ------------- |
| `[{x:1}, 2].flat()`           | **traps** "dereferencing a null pointer" | `[{"x":1},2]` |
| `[o, 1].slice(0)` (`o={x:1}`) | **traps** "dereferencing a null pointer" | `[{"x":1},1]` |
| `[{x:1}].flat()`              | `[{"x":1}]` (correct)                    | `[{"x":1}]`   |
| `[{x:1},{y:2}].flat()`        | `[{"x":1},{"y":2}]` (correct)            | same          |
| `[o, o].slice(0)`             | `[{"x":1},{"x":1}]` (correct)            | same          |
| `[1, 2].slice(0)`             | `[1,2]` (correct)                        | `[1,2]`       |
| `[1, {x:1}].concat([])`       | `[1,{"x":1}]` (correct)                  | same          |

**The discriminator is heterogeneity, not the presence of a struct.** All-struct
and all-number literals are fine; **mixing a struct with a number in one literal**
traps, and only on the `slice` / `flat` paths — `concat` handles the identical
mixed literal correctly. That points at the element-read lowering for a mixed
literal's vec (a `ref.cast` to the struct type over a boxed number, or a null
element) rather than at the method implementations, and `concat` is the working
control to diff against.

Rows 3 and 4 (`[{x:1}].flat()`, `[{x:1},{y:2}].flat()`) answered `[]` before
#3637 and are correct now — recorded here so a future bisect does not
misattribute them.

## Acceptance criteria

- [x] Slice A: `var [p] = {a:1}`, `var [p,q] = {...}` and `function f([p]){}`
      called with a non-iterable all throw `TypeError`; iterable RHS unaffected.
      Also `var [...r]`, `var [p,...r]`, an array-LIKE RHS, and `= 5` / `= true`
      — four rows the original filing did not list. Residual: the empty pattern
      `var [] = {a:1}` (see Correction 1).
- [x] Slice B: `Array.from` on a WasmGC array-like honours `length` and indexed
      reads, matching `slice.call`'s existing behaviour — the two now agree on
      the identical receiver. Also `mapFn` over an array-like, `length`
      coercion, and sparse indices. Residual: an object carrying BOTH `length`
      and a callable `@@iterator` (A/B-verified pre-existing).
- [ ] **Slice C — MOVED OUT of this issue, not abandoned.** Re-measurement
      showed it is not a `slice`/`flat` defect and that the `concat` control in
      the table above is invalid (it varied element ORDER, the discriminating
      variable). Root cause is first-element-wins element typing in
      `compileArrayLiteral` / the tuple lowering, failing identically in BOTH
      lanes — the value-rep substrate family (#2190c, #2773), larger than this
      issue's `horizon: m`. **The `## Correction 2` section above is a complete,
      self-contained spec** — measured table, root cause, both-lane A/B, and the
      invalid-control finding — so nothing is lost by closing #3643. Routed to
      the tech lead for an id and lane assignment; `claim-issue.mjs --allocate`
      failed three times (ref contention) and an id was deliberately NOT
      hand-picked.
- [x] Each landed slice's test asserts the **observable value** and is verified
      to fail before the fix (kill-switch: Slice A 6 red / 8 controls green;
      Slice B 5 red / 2 controls green).
