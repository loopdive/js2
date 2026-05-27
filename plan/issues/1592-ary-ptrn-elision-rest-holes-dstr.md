---
id: 1592
title: "Array pattern elision holes and rest-array in destructuring consume wrong iterator step (~305 fails)"
status: blocked
created: 2026-05-24
updated: 2026-05-27
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring, array-pattern, for-of, for-await-of, classes
goal: spec-completeness
sprint: Backlog
test262_fail: 305
test262_category: language/statements/class/dstr, language/statements/for-await-of, language/statements/for-of, language/expressions/class/dstr
---
# #1592 — Array pattern elision holes and rest-array in destructuring

## Problem

**305 test262 failures** across class destructuring, for-of, for-await-of, and function-parameter contexts where:

1. **Elision holes** in an array binding pattern (`[, x]`, `[a, , b]`, `[...rest, ,]`) — the iterator step for the elided slot is not consumed, so subsequent bindings read the wrong value
2. **Rest-of-array** patterns with elision (`[...ary]` where the source has holes) — similar miscount

### Error patterns observed

```
test/language/statements/class/dstr/meth-dflt-ary-ptrn-rest-ary-elision.js
  L8:5 Cannot destructure 'null' or 'undefined' [in C_method() ← test]

test/language/statements/class/dstr/private-gen-meth-static-dflt-ary-ptrn-elision.js
  L8:5 Cannot destructure 'null' or 'undefined' [in C___priv_method() ← test]

test/language/statements/for-await-of/async-func-dstr-const-async-ary-ptrn-rest-ary-elision.js
  returned 2 — assert #1 at L86: assert.sameValue(first, 1);

test/language/statements/for-await-of/async-func-dstr-const-ary-ptrn-rest-ary-empty.js
  returned 2 — assert #1 at L67: assert.sameValue(iterations, 1);
```

### Category breakdown (2026-05-24 run, excluding illegal_cast)

| Category | ~Count |
|----------|--------|
| `language/statements/class` (dstr) | ~72 |
| `language/expressions/class` (dstr) | ~72 |
| `language/statements/for-await-of` | ~42 |
| `language/expressions/object` (dstr) | ~34 |
| `language/expressions/async-generator` (dstr) | ~14 |
| `language/statements/for` | ~12 |
| `language/statements/for-of` | ~9 |
| `language/statements/function` | ~9 |
| other | ~41 |

### Root cause hypothesis

`destructureParamArray` (or the equivalent `decl-mode` path after #1553a–d) consumes iterator steps for each binding element in turn. For elision positions, the spec (§13.3.3.8 IteratorDestructuringAssignmentEvaluation step 2: "If BindingElementList contains an elision, call IteratorStep") requires calling `IteratorStep(iterator)` and discarding the result. Our implementation likely skips the `IteratorStep` call for elision positions entirely, meaning subsequent bindings read one-ahead values, and rest/empty patterns receive a null or undefined instead of the remaining iterator.

The `Cannot destructure 'null' or 'undefined'` error on the first binding of a class method (L8) suggests the iterator itself is being passed null where the caller expects an iterable — possibly the method-default parameter elision path doesn't thread the iterator through correctly.

## Acceptance criteria

- `[a,,b] = iter` leaves a one-step gap (spec §13.3.3.8 step 2b)
- `[...rest] = iter_with_elision_source` collects all remaining values correctly
- All ~305 listed test262 files pass
- No regressions in equivalence or existing dstr tests

## Notes

- Not the same as #1555 (streaming IteratorStep-per-element) or #1158/#1159 (eager/empty patterns) — those fixed iterator consumption order; this is specifically about elision slots being silently skipped
- The class/dstr failures at L8:5 ("Cannot destructure null/undefined in C_method") suggest the problem manifests at method param binding, not just local dstr
- Spec reference: ECMA-262 §13.3.3.8 ArrayBindingPattern evaluation, steps for BindingElisionElement

## Investigation (2026-05-27, dev-1604) — root cause + escalation

**Reproduced.** Real-runner status on representative files (all `fail`):
- `for-of/dstr/const-ary-ptrn-elision.js` → returned 3 (expects `second===0`)
- `for-await-of/async-func-dstr-const-ary-ptrn-rest-ary-empty.js` → returned 2 (expects `iterations===1`)
- `for-await-of/async-func-dstr-const-async-ary-ptrn-rest-ary-elision.js` → returned 2
- `class/dstr/meth-dflt-ary-ptrn-rest-ary-elision.js` → "Cannot destructure 'null' or 'undefined' in C_method"

**Minimal repro** (`[,]` over a generator `function*(){first+=1; yield; second+=1;}`)
returns `first=1, second=1` — i.e. the elision consumed **2** iterator steps
instead of the spec-required **1**.

**Root cause (confirmed, not just hypothesis).** The hypothesis in the issue
(elision slots silently *skipped*) is **inverted** — the real problem is
*over-consumption*. Array destructuring of an externref source materializes the
**entire** iterable up front via the host import `__array_from_iter`
(`src/runtime.ts:3820`, which is `Array.from`/full protocol-walk to `done`).
For a lazy iterator (generator) this runs the generator to completion, so an
N-element non-rest pattern like `[,]` or `[a,,b]` calls `.next()` far more than
the spec's N times (§13.3.3.8: one IteratorStep per element/elision, then stop).
Plain arrays are observationally fine (already fully realized); the failures are
exclusively generator/lazy-iterator sources.

The class-method `null/undefined` variant is a second symptom: the rest+elision
method-param path threads a null where the iterator is expected (separate
binding-path bug, not the same over-consumption).

**Why this is bounded-streaming, not an elision-skip patch.** The fix requires
*bounded* iterator consumption: consume exactly `pattern.elements.length` steps
when there is **no** rest element, and consume-all only when a rest element is
present. The element count + rest-presence are statically known at the
destructure site. Cleanest design: a new host helper
`__array_from_iter_n(obj, n)` (n = -1 ⇒ unbounded/rest) that reuses the existing
protocol walk but stops after `n` steps, opted-in only from the array-dstr
materialization path — leaving the other 15 `__array_from_iter` call sites
untouched. A standalone-mode (no-JS-host) equivalent is also needed per the
dual-mode principle.

**Escalating — needs architect spec.** This is an architectural change to the
iterator-materialization contract in a heavily spec-tuned helper
(`__array_from_iter` carries #1016/#1150/#1219/#1454 handling), spans 5+ dstr
contexts and 16 call sites, and is marked `reasoning_effort: high` with no impl
plan. Attempting a partial inline fix risks regressing the existing
iterator-protocol/IteratorClose tests. Requesting an architect Implementation
Plan for the bounded-consumption design (helper signature, call-site threading,
standalone fallback, IteratorClose interaction) before coding.

Worktree: `/workspace/.claude/worktrees/issue-1592-ary-elision` (branch
`issue-1592-ary-elision`, no code changes committed — investigation only).
