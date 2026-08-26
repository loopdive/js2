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

The exact missing guards are in
`src/codegen/expressions/assignment.ts`:

- the ordinary identifier `=` module-global arm compiles/coerces the RHS and
  immediately emits `global.set`; and
- `emitIdentifierWriteFromLocal`, used by destructuring, dynamic-`with` miss,
  and runtime-eval-shadow miss paths after they have evaluated the RHS once,
  also immediately emits `global.set` for the module-global arm.

Both paths ignore `ctx.tdzGlobals`. Direct identifier **reads** already use the
correct contract in `src/codegen/expressions/identifiers.ts`: resolve the exact
lexical symbol, classify the access as `skip`, `throw`, or `check`, and either
elide the guard, emit a static `ReferenceError`, or call `emitTdzCheck` before
loading storage. The write path must reuse that authority after RHS evaluation
and before storage mutation.

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
not acquire this lexical's TDZ flag.

This is an internal codegen seam only. Do not change IR analysis, Program ABI,
the public compiler API, or the shape of a `CompileResult`.

### 2. Guard the two already-live module storage writes

Add one small helper in `src/codegen/expressions/assignment.ts` that accepts the
exact assignment-target `Identifier`. It may act only when all of the following
are true:

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

Invoke the helper in both module-global write arms:

- ordinary simple identifier assignment, after the RHS is compiled and
  coerced but before `global.set`; and
- `emitIdentifierWriteFromLocal`, after the caller has captured/evaluated the
  RHS and immediately before its module `global.set`.

JavaScript evaluation order is load-bearing. For `target = rhs()`, `rhs()`
must execute exactly once before `PutValue` observes the TDZ and throws. For a
destructuring assignment, the RHS and property/iterator extraction occur once,
then each binding target performs its own ordered TDZ check before its write.
Do not move the guard before RHS evaluation, mark the lexical initialized,
write and roll back, or catch the thrown error.

Re-read mutable indices after any helper that can register an exception
provider/import. Do not retain an index captured before RHS compilation or
before `emitStaticTdzThrow`/`emitTdzCheck` settles the relevant runtime seam.

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

The change is gated by an existing TDZ flag and therefore byte-neutral for
`var`, initialized/elided `let`/`const`, locals, properties, imports, and files
with no module lexical TDZ. Do not add a new runtime helper or a
`__new_ReferenceError` special case; reuse the same exception paths as direct
identifier reads.

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
3. **Destructuring sink.** Cover object and array assignment targets whose
   extracted value targets the same uninitialized module `let`. Require one RHS
   evaluation, spec-order extraction, the TDZ throw before storage mutation,
   and no later binding write after abrupt completion.
4. **Static/elided control.** An assignment provably after initialization must
   execute without a throw and must not manufacture a TDZ provider/import or
   in-module error-constructor call solely for that write. A `var` twin remains
   artifact-neutral.
5. **Identity and shadow controls.** A same-named parameter/local, an imported
   binding, and a same-spelled declaration in another multi-source module must
   not consult or mutate the target module lexical's TDZ flag. Preserve the
   existing direct outcome for genuinely unresolvable and dynamic-`with`
   references.
6. **Abrupt-completion identity.** The caught value must satisfy
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
- [ ] Ordinary and destructuring identifier-write paths use one shared,
      symbol-aware `skip`/`throw`/`check` decision and the existing error
      emitters; there is no name-only TDZ heuristic or second analysis.
- [ ] Writes provably after initialization retain the current no-check fast
      path, while ambiguous cross-function writes retain the runtime flag
      check.
- [ ] Local shadows, imports, foreign same-named source declarations, `var`,
      properties, global-object writes, dynamic environments, and
      unresolvable references do not acquire the module lexical guard.
- [ ] The exact #4260 class-setter prerequisite passes in direct GC and
      standalone, and #4260 can then prove its injected fallback transaction
      without weakening runtime acceptance.
- [ ] Focused TDZ/accessor suites, TypeScript 7 and 5, formatting, IR/codegen
      layering, fallback/oracle/coercion/optimization ratchets, LOC/function
      budgets, and normal precommit/prepush hooks pass with no baseline
      widening.

## Landing and retirement discipline

Land this as a separate prerequisite PR before the #4260 behavioral PR. Keep
the production delta bounded to the two direct module-storage write sites and
the smallest shared TDZ-analysis export/source-identity seam. No LOC or
function-budget allowance is pre-authorized; measure and delete duplication
before requesting one.

Before every heavy command, commit, and push, require a finite, non-negative
one-minute load strictly below `logical cores - 2`. Run
`pnpm run check:loc-budget` immediately before the signed commit, and run every
normal precommit and prepush hook without skips.

This code is intentionally temporary. #3518 R9 must keep this regression green
while hybrid fallback remains reachable; #3090/R10 deletes the direct
assignment handler only after reachability proves every supported module
lexical write is Prepared or fails with a typed pre-emission outcome. Do not
preserve this helper as a second frontend below the final IR-only boundary.
