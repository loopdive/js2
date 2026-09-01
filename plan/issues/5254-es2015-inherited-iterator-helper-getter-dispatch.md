---
id: 5254
title: "ES2015 standalone: admit inherited Iterator helpers with getter next"
status: in-progress
sprint: current
created: 2026-09-01
updated: 2026-09-01
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen, iterators, calls, classes
es_edition: ES2015
goal: standalone-mode
assignee: ttraenkler/codex-gen-closure-carrier-terra-20260901
related: [3049, 3591, 5147]
origin: "Post-#3591 exact Test262 validation: Iterator subclasses whose next accessor returns a closure do not admit inherited chunks/windows helper calls."
---

# #5254 — Admit inherited Iterator helpers with getter `next`

## Problem and locked evidence

Two exact standalone Test262 rows still throw `TypeError`:

- `built-ins/Iterator/prototype/chunks/exhaustion-does-not-call-return.js`
- `built-ins/Iterator/prototype/windows/exhaustion-does-not-call-return.js`

Both construct a subclass of the runner-provided `Iterator`, expose `next`
through a getter that returns a closure, and call the inherited `.chunks()` or
`.windows()` helper:

```ts
function* g() {
  yield 0;
  yield 1;
  yield 2;
}

class TestIterator extends Iterator {
  get next() {
    const n = g();
    return function () {
      return n.next();
    };
  }
  return() {
    throw new Test262Error();
  }
}

new TestIterator().chunks(2).next();
```

This is the narrow inherited-helper / GetIteratorDirect tail left by #5147
cluster A. No GitHub issue was created. ID 5254 was allocated and claimed
atomically on `upstream/issue-assignments`.

## Falsified initial hypothesis

The issue was initially filed as a native-generator closure-capture boundary.
The required pre-change trace disproved that hypothesis before any production
edit:

- A focused direct-getter fixture obtains the returned closure and calls it
  through `any`; it passes host-free on the #3591 candidate.
- In assembled WAT for the exact chunks source, native factory `$g` emits
  `struct.new 90`. `$TestIterator_get_next` stores that value in
  `$__closure_8_struct`'s `externref` field, and `$__closure_8` reloads it via
  `any.convert_extern`.
- `$__closure_8` calls the final `$__native_gen_dispatch_next`; the dispatcher
  tests and casts type 90 before calling `__gen_resume_g`. The state type,
  closure round trip, dispatcher index, and final brand arm all agree.
- The same exact module contains no `$__call_next`, no
  `$__iter_lazy_chunks`, and no `$__lazy_iter_step`. Although
  `$TestIterator_get_next` is emitted, it is unreachable. The outer inherited
  `.chunks()` call never admits or instantiates the native lazy-helper path, so
  the getter-returned closure is never invoked.

Therefore #5254 must not widen closure fields or weaken GeneratorValidate. The
real repair belongs at inherited Iterator-helper call admission and its
getter-`next` opening path.

## Implementation plan

1. Keep a passing direct-getter closure control beside a red exact-shape
   regression. Assert that the getter is read once, its returned `next`
   callable is cached, normal exhaustion does not call the outer `return`, and
   standalone compilation emits zero compiler/Wasm/host imports.
2. Trace `new TestIterator().chunks(2)` from checker/oracle receiver facts
   through `compileReceiverMethodCall`, lazy-helper form recognition, and the
   native helper wrapper. Identify the exact predicate that rejects a class
   derived from the runner's `Iterator` when `next` is an accessor rather than
   a direct method.
3. Admit the inherited chunks/windows helper only from proven Iterator-derived
   shapes with a callable GetIteratorDirect `next`. Reuse #5147's existing
   `$LazyIterHelper`, `__iter_hof_open`, and `__iter_hof_next` machinery; do not
   special-case `TestIterator`, chunks/windows Test262 filenames, or generator
   receivers.
4. Ensure opening the helper evaluates the `next` getter exactly once and
   caches the closure it returns. The normal exhausted step must not invoke the
   source iterator's `return`; abrupt completion and explicit wrapper return
   retain the existing #5147 behavior.
5. Rerun the exact two rows through the authoritative isolated standalone
   runner on a tree containing #3591. Run the direct closure control, #5147's
   passing chunks/windows spotchecks, inherited/direct helper controls,
   #3591's original generator acceptance suite, and a host/GC control. Run
   typecheck, focused lint/format, issue integrity, source ratchets, and normal
   pre-push checks.

## Acceptance criteria

- Both exact Test262 rows pass in isolated standalone mode.
- `new IteratorSubclass().chunks(...)` and `.windows(...)` emit and use the
  existing native lazy-helper path when `next` is supplied by an accessor.
- The `next` getter is evaluated once and the returned callable is reused.
- Normal exhaustion never invokes the source iterator's `return()`.
- The proven direct generator-capture control remains green; closure storage
  and native generator brand validation are unchanged.
- Existing #5147 chunks/windows passes, #3591 generator controls, invalid
  receivers, and the host/GC lane do not regress.
- Generated standalone modules remain host-free with zero new imports.
- The issue records exact before/after counts, the repaired admission
  predicate, focused validation, and the final commit.

## Dependency and handoff

The getter-returned closure's inner `n.next()` needs #3591 / PR #5402's
late-filled native-generator dispatcher after the outer helper is admitted.
Implementation may be developed as a temporary stack on that completed head,
but the final PR must target `loopdive/js2:main`, contain only #5254's fix after
dependencies land, and remain draft while dependency-blocked or otherwise not
mergeable.
