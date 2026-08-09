---
id: 4212
title: "A missing argument is filled with the ZERO VALUE of the parameter's unified wasm type, not `undefined` — and a second, unrelated call site silently changes the first call site's answer"
status: ready
sprint: current
created: 2026-08-07
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: functions, arity, value-representation
goal: core-semantics
related: [4204, 2106]
origin: "2026-08-07 — found by the project lead while reading emitted WAT for an unrelated question; re-verified on main after that day's 16 merges."
---

# #4212 — a missing argument becomes `0`, not `undefined`

## Repro

```ts
function sum(a, b) {
  return a + b;
}

function addStrings(): string {
  return sum('a' + 'b');   // one argument
}

function addNumbers(): number {
  return sum(1, 2);
}
```

| | expected | measured |
| --- | --- | --- |
| `addNumbers()` | `3` | `3` ✓ |
| `addStrings()` | `"abundefined"` | **`"ab0"`** ✗ |

Measured through the real compiler and executed as Wasm, on `origin/main` rebuilt
after the 2026-08-07 merges (so it is not stale against #4203/#4204/#4207/#4208).

## The trigger is CROSS-CALL-SITE unification, which makes it action-at-a-distance

Delete `addNumbers` — leaving the one-argument call as the only caller — and the
same `addStrings` returns **`"abundefined"`**, correctly.

So the defect is not "we mishandle a missing argument". It is:

> Adding an unrelated second caller **silently changes the first caller's
> result**, in a function neither caller declares anything about.

With both callers present, `sum` unifies to:

```wat
(type $sum_type (func (param externref f64) (result externref)))
```

`a` is boxed (a string and a number reach it), but `b` is only ever passed `2`,
so it lowers to a raw `f64`. The missing argument at the one-argument call site
is then filled with the **zero value of that lowered type**:

```wat
(func $addStrings (result (ref null $AnyString))
  global.get $__strlit_85    ;; "ab"  ('a' + 'b' const-folded)
  extern.convert_any
  f64.const 0                ;; <- the MISSING second argument
  call $sum
  ...
```

`sum` then boxes it and runs the generic dynamic add, so `"ab" + 0` → `"ab0"`.

## Both lanes, not a standalone gap

The host (default `gc`) build emits the same `f64.const 0` in `addStrings`:

```wat
  global.get 9
  f64.const 0
  call 5
```

So this belongs with the shared-semantics bulk of the residue, not the
standalone column — consistent with the 2026-08-07 census finding that ES5
standalone runs 5.4 points *ahead* of ES5 host and ~64 % of failures fail in
both lanes.

## Why it is not caught today

The compiler does emit:

```
warning: Expected 2 arguments, but got 1.
```

but that is the **TypeScript arity check**, not a codegen refusal. It warns and
then emits the wrong value anyway. Per #3725 this is the shape that turns a
discarded refusal into a silent wrong answer, except here it is a warning that
was never load-bearing in the first place.

## Related, and how this differs

**#4204** fixed the neighbouring defect where a primitive-initialized module
`var` reassigned to another type silently became `NaN`. Same family — a value
forced through a lowered slot it does not fit — but a different site: that one is
an assignment to a global's storage, this one is an *absent* argument at a call
site. #4204's predicate keys on assignment-RHS tag disagreement and does not see
a missing argument.

**#2106**'s `undefinedSingleton` is the representation the fix presumably wants
to reach: the arm needs to pass the singleton, and the callee's slot has to be
able to hold it.

## Not measured

- **test262 impact is unknown.** No population was derived and no A/B was run —
  this was found by reading emitted WAT, not by triage. Size it before staffing:
  the reachable shape is a call with fewer arguments than the callee declares,
  where the callee's parameter unified to a non-`externref` type across call
  sites. Derive it from the compiler's own predicates over effective source
  (body + `includes:` harness), **not** an error-string grep.
- Whether the right fix is (a) widen the parameter to `externref` when any call
  site under-supplies it, (b) pass the `$undefined` singleton and make the slot
  hold it, or (c) refuse to lower the parameter at all in this shape. Each has a
  different cost on the hot path for the common fully-applied case, and the
  choice should be measured, not assumed.
- Whether `arguments.length` / `Function.prototype.length` observe the padded
  argument. If they do, the count is wrong too, not just the value.

## Acceptance criteria

- [ ] `addStrings()` in the repro above returns `"abundefined"` **with**
      `addNumbers` present.
- [ ] `addNumbers()` still returns `3` (no over-fix: a fully-applied numeric
      call must keep its `f64` lowering).
- [ ] A permanent test pinning **both** arms of the action-at-a-distance
      property: the one-caller module and the two-caller module must agree.
- [ ] Byte-identity reported for modules with no under-supplied call, so the
      regression surface is an enumeration rather than an estimate.
- [ ] The host lane is fixed too, or the PR states why it is standalone-gated.

---

## Handoff — 2026-08-07

Unowned and unstarted. Filed the same day it was found; nothing has been done
since, and the repro was re-verified on `origin/main` **after** that day's 16
merges (#4203/#4204/#4207/#4208 all landed and none of them changes it).

The one thing not to lose: **test262 impact is deliberately unmeasured.** This
came from reading emitted WAT, not from triage. Do not inherit a number from
this file — there isn't one. Derive the population from the compiler's own
predicates over each file's *effective* source (body + `includes:` harness, which
the runner always prepends), as the acceptance criteria describe.

Session-wide context: `plan/agent-context/session-2026-08-07-lead-handoff.md`.
