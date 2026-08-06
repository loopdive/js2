---
id: 4021
title: "annexB eval-code: `assert is not defined` inside eval'd code — 120 tests, harness bindings not visible to the eval scope"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: eval
goal: runtime-eval
related: [3083, 2928, 1387]
origin: "2026-08-01 /harvest-errors of loopdive/js2wasm-baselines test262-current.jsonl (run 20260801-090441, gitHash c601e89b)"
---

# #3974 — `assert is not defined` inside annexB eval'd code

## TL;DR

**120 official failing tests**, all in `annexB/language`, fail with:

```
assert is not defined
```

Every one of them exercises **Annex B web-compat function hoisting**
(`B.3.3.*`) through `eval` — `func-block-decl-eval-func-*`,
`global-if-decl-else-decl-b-eval-global-*`, and friends. The test body calls
`assert(...)` or `assert.throws(...)` from *inside* the eval'd string, and the
harness `assert` binding is not reachable from that scope.

So these are not Annex B semantics failures. They fail before they can test
anything — the harness itself is invisible inside `eval`.

## Evidence

Source: `test262-current.jsonl` from `loopdive/js2wasm-baselines`, run
`20260801-090441` (gitHash `c601e89b`). All 120 records are in category
`annexB/language`; no other category contributes.

Samples:

```
test/annexB/language/eval-code/direct/func-block-decl-eval-func-skip-early-err-block.js
test/annexB/language/eval-code/direct/func-if-decl-no-else-eval-func-skip-early-err-try.js
test/annexB/language/eval-code/direct/func-switch-case-eval-func-skip-early-err-block.js
test/annexB/language/eval-code/direct/func-switch-dflt-eval-func-skip-early-err-for-of.js
test/annexB/language/eval-code/direct/global-if-decl-else-decl-b-eval-func-skip-early-err-switch.js
test/annexB/language/eval-code/direct/global-if-decl-else-decl-b-eval-global-skip-early-err.js
```

A closely-related 96-record bucket sits right next to it in the same harvest —
`An initialized binding is not created prior to evaluation / Expected a
ReferenceError to be thrown but no exception was thrown at all`, over
`annexB/language/function-code` and `annexB/language/global-code`. Those are
the **non-eval** siblings of the same Annex B hoisting family and are probably
a genuine semantics gap. Worth checking whether they move when this lands, but
they are **not** in scope here.

## Why this is not #3083

#3083 is `wont-fix` and covers a **different** 13-file cluster
(`matchAll`/`RegExpStringIterator`) whose root cause is a specific unshimmed
harness helper (`assert.compareIterator` / `matchValidator`). Its verdict —
"shimming it would be a #2939 vacuity trap" — is about *that* helper, and does
not generalise to `assert` itself being unresolvable inside `eval`.

Do read #3083 before designing a fix, though: its vacuity argument is the right
lens. A fix that makes `assert` resolve but does not actually execute the Annex
B hoisting semantics under test would be exactly the trap #3083 warns about.
**The bar is that the tests genuinely exercise B.3.3, not merely stop erroring.**

## Root-cause hypothesis

Direct `eval` should run in the caller's variable environment, so `assert`
(a harness global) ought to resolve by scope chain. Two candidates:

1. the harness binds `assert` in a way that is not on the global object (e.g. a
   module-local or compiler-synthesised binding), so eval'd code compiled as a
   separate unit cannot see it; or
2. the eval implementation does not thread the caller's scope, so *any*
   outer binding is invisible and `assert` is simply the first one hit.

Hypothesis 2 predicts that non-harness outer bindings also fail inside eval —
cheap to test and worth doing first, because it would make this a general
`eval` scoping bug (goal `runtime-eval`, cf. #2928) rather than a harness gap.

## Acceptance criteria

- [ ] `assert` resolves inside directly-eval'd code in the host lane.
- [ ] The 120-record `assert is not defined` bucket drops to ~0 in a fresh
      host-lane harvest.
- [ ] The tests are verified to actually exercise Annex B hoisting (not merely
      stop throwing) — spot-check at least 3 against expected B.3.3 behaviour,
      per the #3083 vacuity lesson.
- [ ] Whichever hypothesis holds is recorded here; if it is (2), file the
      general eval-scoping defect as its own issue.
- [ ] Net official pass count does not regress.
