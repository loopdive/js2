---
id: 4755
title: "Transitional direct module-lexical assignments enforce TDZ before #4260 fallback"
status: ready
created: 2026-08-26
updated: 2026-08-26
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, ir, classes
language_feature: lexical-bindings
es_edition: 2015
goal: ir-full-coverage
sprint: current
parent: 4260
depends_on: []
related: [723, 800, 1177, 1597, 3521, 3522, 3523, 3518, 4259, 4260]
assignee: "ttraenkler/codex"
model: gpt-5.6-sol
horizon: s
complexity: M
origin: "2026-08-26 #4260 literal fallback acceptance: direct identifier assignment to an uninitialized module lexical writes storage without consulting its TDZ flag"
---

# #4755 — Transitional direct module-lexical assignments enforce TDZ before #4260 fallback

## Product reason

#4260 makes prepared provider publication atomic. Its acceptance deliberately
aborts one prepared class-setter component before sealing and requires the
temporary hybrid policy to execute the direct body once. That fallback is not
safe on current `main`: a setter that assigns to a top-level `let` before its
declaration silently writes the value global instead of throwing
`ReferenceError`.

The transaction repair did not cause this defect. It exposed a pre-existing
semantic hole in the still-reachable direct frontend. The IR body already
checks the paired TDZ flag and behaves correctly; the direct body does not.
Until R9 removes hybrid demotion, an aborted Prepared component must retain
JavaScript semantics. This issue supplies that bounded prerequisite without
expanding direct-codegen ownership beyond the write path that is already live.

## Reproduction and measured boundary

The authoritative #4260 acceptance shape is a class instance setter whose
write executes before the module lexical is initialized:

```ts
function trigger(): void {
  const C = class {
    set value(next) {
      target = next;
    }
  };
  new C().value = 42;
}

var verdict: number = 0;
try {
  trigger();
} catch (error) {
  verdict = error instanceof ReferenceError ? 1 : 2;
}
let target: any;

export function run(): number {
  return verdict;
}
```

On the current direct route, GC and standalone both return `0`; the assignment
neither throws nor preserves the expected abrupt completion. The un-injected
Prepared route returns `1`. This is not an accessor-dispatch failure: the setter
runs, reaches the assignment, and stores through `ctx.moduleGlobals`.

The exact missing simple-write guards are in
`src/codegen/expressions/assignment.ts`:

- the ordinary identifier `=` module-global arm compiles/coerces the RHS and
  immediately emits `global.set`; and
- `emitIdentifierWriteFromLocal`, used by dynamic-`with` and
  runtime-eval-shadow miss paths after they have evaluated the RHS once, also
  immediately emits `global.set` for the module-global arm.

Both paths ignore `ctx.tdzGlobals`. A 2026-08-26 source audit also found that
ordinary object/array destructuring does **not** call
`emitIdentifierWriteFromLocal`: its externref, typed, iterator-override, and
defaulted identifier-target branches either emit their own `global.set` or
incorrectly auto-allocate a local when the target is a module binding. The
required destructuring acceptance therefore cannot be proved by patching only
the two simple arms.

Direct identifier **reads** already own the correct symbol/order classifier in
`src/codegen/expressions/identifiers.ts`, but their dynamic `check` emitter is
not yet a complete semantic oracle: `emitTdzCheck` currently throws
`ref.null.extern` through the exception tag. It is catchable, but the caught
value is not a `ReferenceError` instance. The cross-function class setter takes
that `check` arm, so merely adding the planned guard would change the measured
verdict from `0` to `2`, not the required `1`. This implementation must reuse
the classifier while also closing that existing real-instance gap.

## Implementation plan

### 1. Share the existing identifier TDZ decision

In `src/codegen/expressions/identifiers.ts`, expose the existing symbol-aware
TDZ classifier under a write-neutral internal name such as
`analyzeIdentifierTdzAccess`. Do not copy its ordering/closure/loop logic into
`assignment.ts`, add a second declaration scan, or decide from text position
alone.

The shared result remains exactly:

- `skip` when the same-scope access is provably after the declaration and no
  relevant loop back-edge exists;
- `throw` when the same-scope access is provably before initialization; and
- `check` for cross-function, closure, loop, or otherwise ambiguous timing.

Keep the source-aware module-environment check used by identifier reads
available to the assignment path as well. A flat `moduleGlobals` spelling is
not sufficient evidence: a local shadow, import binding, declaration-file
ambient, or leaked same-spelled script declaration from another source must
not acquire this lexical's TDZ flag. The write-side identity predicate must
join the checker-resolved symbol back to an exact declaration in the current
runtime `SourceFile`, require that declaration to be a source-file-level
`let`, `const`, `using`, or `await using` variable, and reject import-shaped,
ambient/declaration-file, nested, and foreign-source declarations. The
separate `ctx.tdzGlobals` membership check remains mandatory; neither a
same-source spelling nor a checker symbol alone is enough.

Strengthen `emitTdzCheck` in `src/codegen/statements/tdz.ts` to build the
conditional throw through the canonical real-`ReferenceError` instruction
builder in `src/codegen/js-errors.ts`. Build/settle the provider, string, tag,
and late-import dependencies before capturing the TDZ global index; then
re-read the flag index and emit the conditional. Standalone/WASI must use the
existing in-module constructor, while GC may use the existing host/native
provider policy. Do not add a second error representation or an assignment-only
TDZ throw template.

This is an internal codegen seam only. Do not change IR analysis, Program ABI,
the public compiler API, or the shape of a `CompileResult`.

### 2. Centralize the live identifier-target storage writes

Add one typed precomputed-value identifier writer in
`src/codegen/expressions/assignment.ts`. It accepts the exact
assignment-target `Identifier`, value local/type, and the already-resolved
storage family. It must preserve the existing local/captured/dynamic/
unresolvable behavior and may engage the module TDZ guard only when all of the
following are true:

1. the ordinary resolver has selected this identifier's actual module-global
   storage rather than a local, capture, dynamic environment, property, or
   unresolvable reference;
2. the same exact module lexical has a live entry in `ctx.tdzGlobals`; and
3. the source/checker join does not classify the name as foreign or
   undeclared for this module environment.

Map the shared decision without weakening it:

- `skip`: emit nothing;
- `throw`: call the existing `emitStaticTdzThrow` for this identifier; and
- `check`: call the existing `emitTdzCheck` for this exact name.

Route these already-live identifier targets through the shared writer/guard:

- ordinary simple identifier assignment, after the RHS is compiled and
  coerced but before `global.set`; and
- `emitIdentifierWriteFromLocal`, after the caller has captured/evaluated the
  RHS and immediately before its module `global.set`;
- plain and defaulted identifier targets in ordinary object destructuring,
  covering both typed-struct and externref extraction; and
- plain and defaulted identifier targets in ordinary array destructuring,
  covering typed/tuple/vec, externref, and the existing iterator-override
  drive.

Where a destructuring branch currently holds the extracted value on the stack,
store it once in a typed temporary and call the shared writer. Where it already
has a temporary, reuse it. Do not recompile the RHS/default/property read. A
tracked module lexical must no longer be auto-allocated as a function local;
all non-TDZ names retain their current route and representation. Rest targets,
nested-pattern feature expansion, and unrelated missing destructuring support
remain out of scope unless they already reach the shared identifier writer.

JavaScript evaluation order is load-bearing. For `target = rhs()`, `rhs()`
must execute exactly once before `PutValue` observes the TDZ and throws. For a
destructuring assignment, the RHS and property/iterator extraction occur once,
then each binding target performs its own ordered TDZ check before its write.
Do not move the guard before RHS evaluation, mark the lexical initialized,
write and roll back, or catch the thrown error.

Re-read mutable function/global indices after any helper that can register an
exception provider/import/global. Detached destructuring branch buffers must be
registered with the existing repoint machinery for their whole construction
window, and no branch may retain an index captured before RHS/default
compilation or before `emitStaticTdzThrow`/`emitTdzCheck` settles the relevant
runtime seam.

### 3. Preserve every neighboring write route

This prerequisite does not repair or redesign:

- local TDZ storage, captured ref-cell topology, or closure conversion;
- const/read-only assignment policy;
- compound/logical/update expressions, whose required LHS read already owns
  its TDZ decision;
- property/element, class accessor dispatch, global-object, ambient,
  unresolvable, `with`, or runtime-eval binding resolution;
- IR lowering, provider selection, prepared-component sealing, or Program ABI;
  or
- the direct frontend's general module-binding identity model, which R5/R9
  removes rather than extending here.

The assignment change is gated by an exact tracked module lexical and therefore
byte-neutral for `var`, elided `let`/`const`, locals, properties, imports, and
files with no module lexical TDZ. The shared `emitTdzCheck` semantic correction
may change only sites that already retained a dynamic module TDZ check; those
sites must now throw a real `ReferenceError` without adding a new runtime helper
or a special assignment-only constructor path.

## Required focused proof

Add `tests/issue-4755-module-lexical-assignment-tdz.test.ts`. Every runtime row
must run with `experimentalIR: false` in both GC and standalone so a passing IR
body cannot hide a direct-body failure.

1. **Class-setter prerequisite.** Run the exact reproduction above and require
   `run() === 1`. Prove the setter was reached and the lexical storage was not
   mutated before initialization. Repeat with an initialized call after
   `let target` and require the ordinary write to succeed.
2. **RHS-before-PutValue order.** Use a side-effecting RHS in the setter. The
   side effect must occur exactly once, then `ReferenceError` must be caught,
   and statements following the assignment must remain unreachable.
3. **Destructuring sink matrix.** Cover plain and defaulted identifier targets
   separately for each already-live route: typed-struct object extraction,
   `any`/externref object extraction, typed tuple/vec/array extraction, and
   `any`/externref array extraction. Add an isolated
   `Array.prototype[Symbol.iterator]` override row in the existing
   issue-1719-cpr shape so the iterator-driven arm cannot be hidden by the
   native typed/externref controls. In every row the extracted value targets
   the same uninitialized module `let`; require one RHS evaluation, spec-order
   property/default/iterator work, the TDZ throw before storage mutation, and
   no later binding write after abrupt completion. Rest and nested-pattern
   support remain outside this issue and are not acceptance substitutes.

   Measured boundary correction (2026-08-26): do not make this transitional
   writer repair absorb the existing iterator backends. The GC generator used
   by the issue-1719 CPR shape eagerly buffers past the first yield (#2566,
   architectural owner #2662), while its standalone CPR carrier still traps in
   `__iterator_next` (the residual producer/consumer contract described by
   #2038/#3164). The GC row therefore must not pretend to prove per-yield
   suspension; it must prove the override runs and the first target throws
   before either target is written. The standalone row must compile the exact
   guarded CPR route with
   zero host imports and structural `__drive_proto_iterator`,
   `__iterator_next`, and live ReferenceError-provider evidence. All eight
   ordinary typed/externref plain/default sinks remain runtime-required in both
   lanes. Reopen/update #1719 for its untested standalone-clean promise. This is
   not an iterator-semantics waiver or a substitute for those owners.
4. **Static/elided control.** An assignment provably after initialization must
   execute without a throw and must not manufacture a TDZ provider/import or
   in-module error-constructor call solely for that write. A `var` twin remains
   artifact-neutral.
5. **Identity and shadow controls.** A same-named parameter/local, an imported
   binding, an ambient declaration supplied by a `.d.ts`, and a same-spelled
   declaration in another multi-source runtime module must not consult or
   mutate the target module lexical's TDZ flag. The declaration-file collision
   is a distinct row: the read-side module-goal resolver intentionally treats
   ambient symbols differently from ordinary foreign runtime declarations, so
   the import/foreign controls do not prove it.
6. **Precomputed-writer route controls.** Force both branches of the two routes
   that call `emitIdentifierWriteFromLocal`: a dynamic-`with` HasBinding hit and
   miss, plus a runtime-eval value-cell present and miss. Each hit must write
   only its dynamic object/cell and must not consult the module TDZ flag. Each
   miss must fall through to the same uninitialized module lexical, evaluate
   the RHS once, throw a real `ReferenceError`, and leave its storage
   unchanged. A genuinely unresolvable reference remains on its existing
   GlobalEnvironmentRecord/strict-error route rather than borrowing the module
   lexical writer.
7. **Abrupt-completion identity.** The caught value must satisfy
   `error instanceof ReferenceError`, not merely be truthy or carry matching
   text. Standalone must retain zero host imports and a live in-module path;
   GC must not retain an unused error import/provider.

Run the new test with the direct TDZ and class-accessor controls:

- `tests/issue-723-tdz.test.ts`;
- `tests/issue-800.test.ts`;
- `tests/issue-1177.test.ts`;
- `tests/issue-1597-standalone-reference-error.test.ts`;
- `tests/issue-4259-class-accessor-outer-writeback-ir.test.ts`; and
- `tests/issue-4259-top-level-accessor-claim-gating.test.ts`.

The #4260 behavioral branch must subsequently rerun its literal injected
pre-seal matrix. This issue is accepted on direct semantics; it must not claim
that atomic provider publication is fixed.

## Acceptance criteria

- [ ] Direct GC and standalone assignment to an uninitialized top-level
      lexical throws the correct `ReferenceError` after evaluating the RHS
      exactly once and before mutating storage.
- [ ] Ordinary and every in-scope plain/defaulted destructuring
      identifier-write path use one shared, symbol-aware
      `skip`/`throw`/`check` decision and the existing error emitters; there is
      no name-only TDZ heuristic or second analysis.
- [ ] Writes provably after initialization retain the current no-check fast
      path, while ambiguous cross-function writes retain the runtime flag
      check.
- [ ] Local shadows, imports, `.d.ts` ambients, foreign same-named runtime
      declarations, `var`, properties, global-object writes, dynamic
      HasBinding/value-cell hits, and unresolvable references do not acquire
      the module lexical guard; dynamic/eval misses reach the guarded lexical
      writer exactly once.
- [ ] The exact #4260 class-setter prerequisite passes in direct GC and
      standalone, and #4260 can then prove its injected fallback transaction
      without weakening runtime acceptance.
- [ ] Focused TDZ/accessor suites, TypeScript 7 and 5, formatting, IR/codegen
      layering, fallback/oracle/coercion/optimization ratchets, LOC/function
      budgets, and normal precommit/prepush hooks pass with no baseline
      widening.

## Landing and retirement discipline

Land this as a separate prerequisite PR before the #4260 behavioral PR. Keep
the production delta bounded to the shared TDZ classifier/source-identity
seam, the existing dynamic-check emitter's real-`ReferenceError` correction,
the simple module-global assignment arm, the precomputed identifier writer,
and the enumerated typed/externref/iterator object-and-array identifier-target
sinks. Do not describe or review this as a two-write-site patch: ordinary
destructuring currently owns distinct storage routes that are required scope.
No LOC or function-budget allowance is pre-authorized; measure and delete
duplication before requesting one.

Before every heavy command, commit, and push, require a finite, non-negative
one-minute load strictly below `logical cores - 2`. Run
`pnpm run check:loc-budget` immediately before the signed commit, and run every
normal precommit and prepush hook without skips.

This code is intentionally temporary. #3518 R9 must keep this regression green
while hybrid fallback remains reachable; #3090/R10 deletes the direct
assignment handler only after reachability proves every supported module
lexical write is Prepared or fails with a typed pre-emission outcome. Do not
preserve this helper as a second frontend below the final IR-only boundary.

## Implementation handover (2026-08-26)

PR #4997 implements the bounded prerequisite above on current `main`. The
shared writer now uses exact source/checker identity for ordinary and
precomputed module-lexical writes, keeps dynamic/ambient/import/foreign/
unresolvable carriers on their existing routes, re-reads mutable global
indices after provider settlement, and keeps detached default-arm bodies live
through final branch attachment. The production diff adds no LOC/function
allowance and does not widen a baseline.

The changed-root proof is 48/48: 46 rows in
`tests/issue-4755-module-lexical-assignment-tdz.test.ts` plus two detached-body
rows in `tests/issue-4755-detached-assignment-repoint.test.ts`, across direct GC
and standalone as applicable. TypeScript 7/5, IR layering, optimization
retirement, fallback/oracle/coercion ratchets, LOC/function budgets, formatting,
and the normal precommit hook passed on the merged bytes. In the required
`tests/issue-4259-class-accessor-outer-writeback-ir.test.ts` control, every
#4755-relevant TDZ row passes; four other rows fail identically on a detached
clean `origin/main` worktree and therefore remain a pre-existing #4259 baseline
defect rather than a waiver or a regression introduced here.

The continuation boundary is explicit:

- #4260 still owns the injected pre-seal transaction rerun after #4997 lands;
- #1719 owns the standalone CPR iterator producer/consumer contract exposed by
  the isolated destructuring row; and
- #3518 R9/#3090 R10 must preserve this matrix while moving the writer into IR
  ownership and then delete this temporary direct-frontend seam.

PR #4997 was re-anchored without a force push so its final tree is based on
current `main` and excludes stale generated Test262 reports. Merge-queue,
ordinary merge-commit, or squash landing is safe; do not use rebase-and-merge
for this PR because replaying its preserved pre-anchor history can resurrect
those unrelated generated artifacts.
