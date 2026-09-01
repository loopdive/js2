---
id: 5254
title: "Test262 original harness: provision the Iterator shim"
status: in-progress
sprint: current
created: 2026-09-01
updated: 2026-09-01
priority: high
horizon: s
feasibility: medium
reasoning_effort: max
task_type: conformance, test-infrastructure
area: test262 runner, original harness, iterators
es_edition: ES2015
goal: standalone-mode
assignee: ttraenkler/codex-gen-closure-carrier-terra-20260901
related: [3049, 3591, 5147, 5215]
origin: "Authoritative original-harness execution omits the Iterator binding/preamble that the legacy wrapper already provisions for Iterator helper tests."
---

# #5254 — Provision the `Iterator` shim in the Test262 original harness

## Problem and locked evidence

The authoritative isolated standalone runner still fails:

- `built-ins/Iterator/prototype/chunks/exhaustion-does-not-call-return.js`
- `built-ins/Iterator/prototype/windows/exhaustion-does-not-call-return.js`

Both exact upstream files use `class TestIterator extends Iterator` and then
call the inherited `.chunks()` or `.windows()` helper. Neither file declares a
Test262 `includes:` entry that supplies `Iterator`.

This is a runner-boundary defect, not evidence for a new compiler carrier or
helper-admission change:

- `runTest262File` always calls `assembleOriginalHarness`
  (`tests/test262-runner.ts` around line 4604).
- `assembleOriginalHarness` concatenates only declared includes,
  `scripts/test262-fyi-runtime.js`, `assert.js`, and `sta.js`
  (`tests/test262-original-harness.ts` around lines 118–175 and 314–327). The
  exact two files have no includes.
- The repository's existing minimal `Iterator` shim lives only in legacy
  `wrapTest` / `buildPreamble` (`tests/test262-runner.ts` around lines
  2292–2302), behind `needsIteratorBinding`. Authoritative original assembly
  never invokes that path.
- `SANDBOX_GLOBAL_NAMES` omits `Iterator`. Both the local original-harness
  sandbox and sharded worker copy only that list
  (`scripts/test262-sandbox-globals.mjs`, `tests/test262-runner.ts`, and
  `scripts/test262-shard-worker.ts`). The VM realm happens to expose an
  `Iterator` function, but the sandbox has no own binding and Node's
  `Iterator.prototype.chunks` is undefined, so copying the host object would
  not provide the required semantics anyway.
- Assembled WAT for the exact chunks file contains no `$__call_next`, no
  `$__iter_lazy_chunks`, and no `$__lazy_iter_step`. The getter and its returned
  closure are emitted but unreachable because the source never receives the
  shim whose prototype exposes the compiled native helper surface.

No GitHub issue was created. ID 5254 was allocated and claimed atomically on
`upstream/issue-assignments`.

## Falsified compiler hypotheses

The issue was initially filed as a native-generator closure-capture boundary,
then briefly narrowed to inherited compiler helper admission. Both were
rejected before any production source edit:

- A direct getter-returned closure resumes the captured generator host-free.
- Native factory `$g` emits `struct.new 90`; the closure stores it as
  `externref`, reloads it via `any.convert_extern`, and calls the final native
  resume dispatcher. That dispatcher tests/casts the same type 90 and calls
  `__gen_resume_g`.
- The exact original-harness module never contains the lazy-helper machinery at
  all because the harness omitted the binding/preamble that exposes it.

Therefore #5254 must not widen closure storage, weaken GeneratorValidate, or
change compiler Iterator-subclass admission without separate evidence after
the runner surface is made valid.

## Implementation plan

1. Add focused assembly tests using the exact two upstream files and a minimal
   feature-equivalent fixture. Lock that authoritative assembly currently
   omits `Iterator`, while the legacy wrapper injects the existing shim. Assert
   that the literal upstream test body remains byte-for-byte present and is not
   rewritten.
2. Extract or share the existing `needsIteratorBinding` decision and minimal
   source preamble so legacy `wrapTest` and `assembleOriginalHarness` cannot
   drift. Gate it only for tests that actually require the `Iterator` binding
   (using parsed metadata and/or the existing source predicate); do not inject
   it into every Test262 file.
3. Provision the binding as compiled source, not by copying Node's host
   `Iterator`: the host prototype lacks chunks/windows and would violate
   standalone host independence. Reuse the existing shape that defines a
   minimal constructor and points its prototype at the compiled iterator
   prototype surface. If runtime sandbox identity also needs a named global,
   update local and sharded original-harness paths together; never make the two
   runners disagree.
4. Confirm that the valid assembled source now selects #5147's existing
   chunks/windows `$LazyIterHelper` machinery, reads the `next` getter once,
   caches its returned callable, and does not call the source iterator's
   `return` on normal exhaustion. Do not special-case filenames, class names,
   or generator receivers.
5. Run the exact two rows through the authoritative isolated standalone runner
   on a tree containing #3591. Run original-harness assembly/local-vs-sharded
   parity tests, legacy wrapper controls, #5147 chunks/windows spotchecks, the
   direct getter-closure control, and #3591's original generator acceptance
   suite. Run typecheck, focused lint/format, issue integrity, source ratchets,
   and normal pre-push checks.

## Acceptance criteria

- Both exact Test262 rows pass in isolated standalone mode.
- Authoritative original-harness assembly provides the same minimal `Iterator`
  binding contract as the legacy wrapper when a test requires it.
- Local and sharded runners assemble/provision the binding identically.
- The literal upstream test body is preserved; only harness prefix/provisioning
  changes.
- The `next` getter is evaluated once, its returned callable is reused, and
  normal exhaustion never invokes `return()`.
- Generated standalone modules remain host-free with zero new imports and do
  not depend on Node's host `Iterator` implementation.
- Existing original-harness, #5147, #3591, invalid-receiver, and host/GC
  controls do not regress.
- The issue records exact before/after counts, assembly evidence, focused
  validation, and the final commit.

## Dependency and handoff

Once the harness exposes the helper, the getter-returned closure's inner
`n.next()` uses #3591 / PR #5402's completed late-filled native-generator
dispatcher. Implementation may be developed as a temporary stack on that
head, but the final PR must target `loopdive/js2:main`, contain only #5254's
completed fix after dependencies land, and remain draft while
dependency-blocked or otherwise not mergeable.
