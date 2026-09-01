---
id: 5254
title: "Test262 Iterator shim: provision the original harness and admit native helper dispatch"
status: in-progress
sprint: current
created: 2026-09-01
updated: 2026-09-01
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: conformance, test-infrastructure
area: test262 runner, original harness, iterators, method dispatch
es_edition: ES2015
goal: standalone-mode
assignee: ttraenkler/codex-gen-closure-carrier-terra-20260901
related: [3049, 3123, 3591, 5147, 5215]
origin: "Authoritative original-harness execution omits the Iterator binding/preamble, and the resulting known fnctor-subclass helper call also misses standalone closed dispatch."
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::tryCompileLateFnctorPrototypeMethodCall
---

# #5254 — Provision the `Iterator` shim and admit its native helper dispatch

## Problem and locked evidence

The authoritative isolated standalone runner still fails:

- `built-ins/Iterator/prototype/chunks/exhaustion-does-not-call-return.js`
- `built-ins/Iterator/prototype/windows/exhaustion-does-not-call-return.js`

Both exact upstream files use `class TestIterator extends Iterator` and then
call the inherited `.chunks()` or `.windows()` helper. Neither file declares a
Test262 `includes:` entry that supplies `Iterator`. Two sequential defects are
now locked: the authoritative assembler omits the binding, and a valid compiled
binding still leaves a known fnctor-subclass method miss outside the standalone
closed-dispatch path that reserves the native lazy helper.

The first boundary is runner provisioning and remains distinct from the narrow
compiler admission established later; neither is evidence for a new carrier:

- `runTest262File` always calls `assembleOriginalHarness`
  (`tests/test262-runner.ts` around line 4604).
- `assembleOriginalHarness` concatenates only declared includes,
  `scripts/test262-fyi-runtime.js`, `assert.js`, and `sta.js`
  (`tests/test262-original-harness.ts` around lines 118–175 and 314–327). The
  exact two files have no includes.
- The repository's existing minimal `Iterator` shim lived only in legacy
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
- Assembled WAT without the shim contains no `$__call_next`, no
  `$__iter_lazy_chunks`, and no `$__lazy_iter_step`.

No GitHub issue was created. ID 5254 was allocated and claimed atomically on
`upstream/issue-assignments`.

## Falsified hypotheses and corrected dispatch trace

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

Therefore #5254 must not widen closure storage or weaken GeneratorValidate.

The first shared-preamble implementation then falsified one more premise before
any production compiler edit: provisioning alone is necessary but not
sufficient. The exact original-harness source, the legacy wrapper, and minimal
plain-JS / class-shaped shim variants all compile, yet the resulting WAT still
contains zero `chunks`, `__call_m_chunks_1`, `__iter_lazy_chunks`,
`__lazy_iter_step`, or `__iter_hof_open`; execution throws an opaque Wasm-GC
exception. This is not a preamble syntax problem.

The static route is now precise:

- `TestIterator` is a known class whose ancestor is the runtime `Iterator`
  function. A missing `.chunks()` / `.windows()` member reaches
  `src/codegen/expressions/call-receiver-method.ts` around the #3123 known-class
  miss.
- That miss invokes `emitFnctorSubclassDynamicMethodCall`, whose
  `__extern_method_call` bridge is host-only. Standalone therefore gets no
  usable fallback and, crucially, never reserves a closed method dispatcher.
- The generic standalone dynamic-receiver path does reserve
  `reserveClosedMethodDispatch`. That existing reservation calls
  `ensureNativeLazyIter` for a valid lazy-helper name/arity; its fill already
  owns the `$LazyIterHelper` construction and native `.next()` stepping.

The authorized compiler scope is therefore a narrow admission into the
existing closed dispatcher for a structurally proven standalone fnctor-class
iterator miss. It is not a new helper implementation, generic host bridge, or
class-name/filename special case. The receiver must expose the iterator
protocol (including its compiled `next` member/getter), the name and arity must
be an existing supported lazy-helper form, and every other fnctor-class miss
must remain byte-identical.

## Implementation plan

1. Add focused assembly tests using the exact two upstream files and a minimal
   feature-equivalent fixture. Lock that authoritative assembly previously
   omitted `Iterator`, share the legacy shim, and assert that the literal
   upstream test body remains a byte-for-byte suffix rather than being
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
4. Add regression evidence for the second boundary before editing production
   code: a provisioned exact/minimal source must show the known fnctor-class
   miss and the absence of `__call_m_{chunks,windows}_*` and
   `__iter_lazy_{chunks,windows}` in WAT.
5. In `tryCompileLateFnctorPrototypeMethodCall` / the adjacent known-class miss,
   admit only a structurally proven standalone iterator-like fnctor subclass
   and an existing `LAZY_ITER_METHODS` name with a valid `isLazyIterForm`
   arity. Reuse `reserveClosedMethodDispatch`; do not add a host import, a new
   iterator helper, a filename/class-name check, or a generic coercion. Preserve
   receiver-before-arguments order and evaluate both exactly once.
6. Confirm that the valid assembled source now selects #5147's existing
   chunks/windows `$LazyIterHelper` machinery, reads the `next` getter once,
   caches its returned callable, and does not call the source iterator's
   `return` on normal exhaustion. Cover a non-iterator fnctor subclass and an
   unsupported method/arity as byte-identical negative controls.
7. Run the exact two rows through the authoritative isolated standalone runner
   on a tree containing #3591. Run original-harness assembly/local-vs-sharded
   parity tests, legacy wrapper controls, #5147 chunks/windows spotchecks, the
   direct getter-closure control, and #3591's original generator acceptance
   suite. Run typecheck, focused lint/format, issue integrity, source ratchets,
   and normal pre-push checks.

## Acceptance criteria

- Both exact Test262 rows pass in isolated standalone mode.
- Authoritative original-harness assembly provides the same minimal `Iterator`
  binding contract as the legacy wrapper when a test requires it.
- Both legacy and authoritative provisioned shapes reserve and execute the
  existing native chunks/windows lazy-helper path in standalone.
- Local and sharded runners assemble/provision the binding identically.
- The literal upstream test body is preserved; only harness prefix/provisioning
  changes.
- The `next` getter is evaluated once, its returned callable is reused, and
  normal exhaustion never invokes `return()`.
- Generated standalone modules remain host-free with zero new imports and do
  not depend on Node's host `Iterator` implementation.
- Unrelated fnctor subclasses, unsupported helper arities, ordinary known-class
  calls, and host/GC behavior remain unchanged.
- Existing original-harness, #5147, #3591, invalid-receiver, and host/GC
  controls do not regress.
- The issue records exact before/after counts, assembly evidence, focused
  validation, and the final commit.

## Dependency and handoff

The shared harness extraction is implemented but not complete on its own; the
corrected compiler admission above is required in the same atomic fix because
neither boundary can make the exact rows pass independently. Once the native
helper opens the iterator, the getter-returned closure's inner `n.next()` uses
#3591 / PR #5402's completed late-filled native-generator dispatcher.
Implementation may be developed as a temporary stack on that head, but the
final PR must target `loopdive/js2:main`, contain only #5254's completed atomic
harness-plus-admission fix after dependencies land, and remain draft while
dependency-blocked or otherwise not mergeable.
