# Handover — standalone Temporal (#5383), session of 2026-09-08

Entry point for the next lane. The predecessor handover is
`temporal-standalone-handover-2026-09-07.md`; everything below supersedes it.

**Scope, unchanged from the owner directive of 2026-09-07:** a real `Temporal`
global for `--target standalone`, **standalone only**. The host-lane Temporal
work is finished and landed; do not open new host-lane work, and do not change
the semantics of `src/codegen/temporal-native.ts` (the #661 host lowering) until
S4 deliberately retires it under standalone.

## Where the work stands

The umbrella is [#5383](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5383-standalone-temporal-provider),
`status: in-progress`. Its S2 phase is being landed as a stack of small slices,
each one root-causing a compiler defect that the compiled polyfill exposed.

| slice | what it fixed | state |
| --- | --- | --- |
| S1 | the polyfill compiles under standalone to a binary the engine accepts | merged (PR #5721) |
| S2b | the externref-backed subclass family | merged (PR #5761) |
| S2c | the `Intl` refusal shim; `__module_init` returns | merged (PR #5762) |
| S2d | the getter boundary — a provider-minted object arrived empty | merged (PR #5767) |
| S2e | `invalid calendar identifier` — a scope-blind `defineProperty` sidecar key | merged (PR #5773) |
| S2f | `$__ta_ctor` identity by brand; a class value is `typeof "function"`; callable-kind/construct boundary twins | **open, PR #5777** |
| S2g | `new K(…)` on a class VALUE runs the constructor body, in-module and across the link boundary | **open, PR #5780** |
| S2h | prototype member reads + a `method_call` boundary terminal + the smoke test | **in flight**, branch `issue-5383-standalone-temporal-s2h` |
| S3 | wire the provider into both runners and CI | not started |
| S4 | retire the `__temporal_*` host lowering under standalone | not started |
| S5 | measurement: samples, counts, artifacts | not started |

The two open PRs are stacked: S2g's branch contains S2f's commits, and both have
current `origin/main` (afa68e16) merged in. They are validated locally on those
merged heads — typecheck, compiler-boundaries inventory against `origin/main`,
and the #5383 suite (39 on S2f, 44 on S2g).

## What works today, host-free

Compiling `@js-temporal/polyfill` (jsbi linked) as a separately linked provider
via `buildTemporalProvider` / `compileWithTemporalGlobal`, instantiated with
`instantiateLinkedProject(result, {})` and **no JS host imports at all**:

- the provider binary links and `__module_init` runs to completion;
- `Object.keys(Temporal)` answers the nine namespace members;
- objects, numbers and nested objects cross the link boundary;
- a class value crosses the boundary and reports `typeof "function"`;
- `new Temporal.PlainDate(2024,1,1)` runs the real constructor body and the
  instance carries its own fields.

## The one thing that still blocks the S2 acceptance criterion

**A dynamic read of a class instance's PROTOTYPE member answers `undefined`.**
It is module-local, not a boundary defect, and reproduces in six lines with no
Temporal in sight (the reduction is in the issue file under "S2g findings"):

| probe | answer |
| --- | --- |
| dynamic read of an OWN field | works |
| dynamic CALL of a prototype method | works (via `closed-method-dispatch`) |
| dynamic READ of a prototype accessor or method | **`undefined`** |

The generic `__extern_get` ladder serves own fields but never consults the class
prototype. Across the boundary there is a second, independent gap: a method CALL
on a provider-owned instance has no peer terminal, so
`standalone-link-boundary.ts` needs a `__js2wasm_link_method_call` beside
`memberGet` / `apply` / `construct`.

Consequence for the smoke test: of the three assertions, only
`Object.keys(Temporal).length === 9` passes today.
`new Temporal.PlainDate(2024,1,1).day` needs the accessor read;
`Temporal.Duration.from({hours:1}).total("minutes")` needs both a static-method
read on a class value and a method call on a provider-owned instance. Asserting
only the passing one would hide exactly this, so the smoke test is deliberately
still unwritten. That is what the S2h lane was dispatched to close.

## Pick-up instructions

1. Land the stack. #5777 then #5780; each is enqueued by the server-side
   workflow once `mergeStateStatus` is `CLEAN` and no `hold` label is present.
   Never enqueue by hand and never re-enqueue.
2. Take S2h to completion — see its branch and the brief recorded in the issue
   file. Its two deliverables are the prototype-consulting dynamic read and the
   `method_call` terminal; the smoke test follows from them.
3. Then S3 (runner + CI wiring), S4 (retire the host lowering under standalone),
   S5 (measurement against the 170 / 4,603 baseline).
4. Two independent defects were filed out of this work and are unowned:
   [#5404](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5404-standalone-dynamic-regexp-pattern)
   (the standalone RegExp backend refuses every runtime-built pattern — this is
   why the smoke test must use the object form of `from`, never the string form)
   and [#5405](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5405-never-call-chain-elides-receiver)
   (a property read on the result of a `never`-returning call elides the
   receiver — why `Temporal.Now` is out of scope for the smoke test).

## Two operational lessons worth keeping

**The merge queue parked three of these PRs on collateral rows, not real
regressions.** Each time the row was a TypedArray test that the diff could not
reach, and each time the proof was the same and took about two minutes: compile
the named row with `runTest262File` on the PR head and on the exact
merge-group **baseline compiler sha** named in the park comment, and compare the
runner's own `wasm_sha`. Identical bytes mean no compiler change reached that
row, whatever the aggregate says. Post that table before removing a `hold`;
re-admit at most once, and if the same row parks a third time, dequeue to draft
and open a flake-ledger entry instead. These rows belong to the #1957 fork
realm-mutation class and have been shown collateral repeatedly.

**Deferred, measured, and not this stack's to fix.** Eleven more
`ref.test $__ta_ctor` sites ask a structural question where they mean a nominal
one (recorded in the S2f findings); converting the two in `ta-ctor-meta.ts` /
`dataview-native.ts` moves the provider's `__module_init` to a new stop, so only
the classifier and `__reflect_is_constructor` were converted. Separately,
`tests/issue-2026-dynamic-new-spread`, `-varspread` and
`issue-3981-standalone-construct-function-value` are red on the S2g base and
were measured red both ways; two of the three are gc-lane. They need an owner.
