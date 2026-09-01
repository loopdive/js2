---
id: 5254
title: "ES2015 standalone: preserve captured native generator carriers"
status: in-progress
sprint: current
created: 2026-09-01
updated: 2026-09-01
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen, generators, closures
es_edition: ES2015
goal: standalone-mode
assignee: ttraenkler/codex-gen-closure-carrier-terra-20260901
related: [3049, 3591, 5147]
origin: "Post-#3591 exact Test262 validation: a native generator captured by a getter-returned closure loses its state carrier before the inner next() call."
---

# #5254 — Preserve captured native generator carriers

## Problem and locked evidence

Two exact standalone Test262 rows still throw GeneratorValidate's native
`TypeError` after #3591's late-filled opaque resume dispatcher recognizes every
registered generator state type:

- `built-ins/Iterator/prototype/chunks/exhaustion-does-not-call-return.js`
- `built-ins/Iterator/prototype/windows/exhaustion-does-not-call-return.js`

Both rows use the same independently minimal shape. A class getter creates a
native generator state, captures it in a returned ordinary closure, and the
closure later evaluates `n.next()`:

```ts
function* g() {
  yield 0;
}

class TestIterator extends Iterator {
  get next() {
    const n = g();
    return function () {
      return n.next();
    };
  }
}
```

The outer chunks/windows `$LazyIterHelper` is not the failing receiver. The
throw occurs in the getter-returned closure at its inner `n.next()`. Generated
WAT on PR #5402 contains the final `$GenState_g` dispatch arm, so this is not a
second stale-registration bug. The state crosses a captured closure field
whose inferred ABI is `externref`; after that round trip it no longer satisfies
the native-state brand ladder.

This is a narrow continuation of #5147 cluster A's protocol-fidelity tail and
is split from #3591 so that its closure-carrier boundary can be fixed and
reviewed independently. No GitHub issue was created. ID 5254 was allocated and
claimed atomically on `upstream/issue-assignments`.

## Implementation plan

1. Add `tests/issue-5254.test.ts` with a minimal getter-returned closure that
   captures `g()` and calls `.next()` after the getter returns. Assert the
   yielded values, exhaustion, actual error behavior, and zero compiler/Wasm/
   host imports in standalone. Include a control that proves the outer
   iterator's `return()` is not called on normal exhaustion.
2. Trace the exact capture-store and capture-load ValTypes for `n` and confirm
   where `$GenState_g` becomes an opaque external value. Record the generated
   WAT evidence in this file before changing the boundary.
3. Preserve the native generator carrier through that single closure-capture
   path. Prefer an existing `anyref`/`externref` bridge or a generator-state-
   aware capture slot over broad closure-field widening. Storage and reload
   must be symmetric, evaluate the captured expression once, and retain a
   valid host representation for genuinely external captures.
4. Do not special-case chunks/windows or weaken GeneratorValidate. The same
   minimal capture must work without any iterator-helper wrapper. Keep
   `.return()`/`.throw()` behavior and non-generator brand errors unchanged.
5. Validate the two exact rows with the authoritative isolated standalone
   runner on a tree containing #3591, then run #3591's original four cases,
   the relevant #5147 chunks/windows controls, closure-capture controls, and a
   host/GC lane control. Run typecheck, focused lint/format, issue integrity,
   source ratchets, and the repository's normal pre-push checks.

## Acceptance criteria

- Both exact Test262 rows pass in isolated standalone mode.
- A minimal getter-returned closure can capture and resume a native generator
  after the getter frame has returned.
- Generated standalone modules remain host-free with zero new imports.
- Normal exhaustion does not invoke the source iterator's `return()`.
- Generator `.next()`/`.return()`/`.throw()` controls, non-generator brand
  failures, ordinary closure captures, and the host/GC lane do not regress.
- The issue records exact before/after counts, the repaired carrier boundary,
  focused validation, and the final commit.

## Dependency and handoff

The exact red rows reach this boundary only with #3591 / PR #5402's late-filled
native generator dispatch in the candidate tree. Implementation may be
developed as a temporary stack on that head, but the final PR must target
`loopdive/js2:main`, contain only #5254's completed fix after dependencies
land, and remain draft while it is dependency-blocked or otherwise not
mergeable.
