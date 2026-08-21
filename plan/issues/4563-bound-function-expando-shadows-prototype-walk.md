---
id: 4563
title: "STANDALONE: defining ANY own property on a bound function stops it inheriting from Function.prototype (expando bag shadows the prototype walk)"
status: ready
sprint: current
created: 2026-08-19
updated: 2026-08-19
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
es_edition: 5
language_feature: functions
goal: es5
func-budget-allow:
  # 2026-08-20: the bag-vs-prototype read order fix. fillClosurePropHelpers is
  # the single emitter for every closure-carrier property helper, so the extra
  # arm has to live inside it — it crosses the 300-LOC threshold by 11.
  - src/codegen/closure-props.ts::fillClosurePropHelpers
related: [4241, 4555, 4562, 4163]
origin: "2026-08-19 ES5 standalone push, #4555 lane, while attempting bound-function `length`. Pre-existing; proved on the base tree."
---

# #4563 — a bound function's expando bag shadows its prototype walk

## The defect

```js
var b = foo.bind({});
Object.defineProperty(b, "zz", { value: 1, configurable: true });
Function.prototype.property = 12;
b.property;   // undefined — want 12
```

**Defining any own property on a bound function makes it stop inheriting from
`Function.prototype`.** The `$__bound_fn` carrier's expando bag (#4241) shadows
the prototype walk once the bag is non-empty: a miss in the bag answers
`undefined` instead of continuing up the chain.

Pre-existing — proved on the base tree, not introduced by any push work.

## Why it blocks the bound-function `length`/`name` cluster

A working §20.2.3.2 steps 5–8 implementation for bound-function `length` was
built and measured in the #4555 lane. It works — `bar.bind(null).length` → 2,
`bar.bind(null,1).length` → 1, descriptor exactly
`{writable:false, enumerable:false, configurable:true}` — and two rows flip to
PASS.

But the directory total stayed **73/100: +2 passing, −2 newly failing**
(`15.3.4.5-11-1`, `15.3.4.5-6-2`). The seed does not *introduce* this defect; it
makes **every** bound function hit it, because every bound function now has an
own property. So shipping it trades 2 rows for 2 rows and degrades semantics for
all bound functions.

The implementation was therefore **reverted rather than shipped** (~120 lines,
reproducible on request). Revive it once this issue lands.

## Scope note: `bind` is bigger than it looked, and mostly already works

`built-ins/Function/prototype/bind` is **73/100 in standalone**. The 27 failures
are not one feature:

| rows | cluster |
| ---: | --- |
| 5 | bound-function `length` — standalone answers `NaN`, js-host is correct |
| 4 | bound-function `name` — standalone `undefined`, js-host `"bound target"` |
| 5 | `Reflect.construct` realm / newTarget — explicit standalone refusals, deep |
| 3 | unrelated exotics (reflective `bind.apply` + [[Construct]] currying on `Date`; `Object.bind(null)`; `JSON.bind()`, which needs an absent-property read off a builtin namespace and is currently a hard `__get_builtin` compile error) |

The `name` half shares this same bag mechanism, so it does not dodge the issue.

## Recommended order — REVISED 2026-08-19

This issue is now the **higher-value** of the pair. #4562 was re-measured and
turned out far narrower than first filed (the general §10.1.6.3 merge is
correct; only a function's intrinsic `length`/`name` are affected, and it does
NOT unlock the #4491 lane as originally claimed). It is also a **two-lane** job,
since the host lane returns `undefined` from `gOPD(fn,"length")` outright.

By contrast this issue is single-lane, standalone-only, and breaks a plain-JS
idiom outright rather than an attribute nuance — a bound function with any own
property silently stops inheriting from `Function.prototype`.

1. **This issue** — bag-vs-prototype read order on callable carriers.
2. **#4562** — materialise the function intrinsic as a record before merging
   (two-lane; design the cross-lane loop in, don't bolt it on).
3. Then revive the `length`/`name` seed: a clean ~9-row win instead of a wash.

## Acceptance criteria

- A bound function with own properties still inherits from `Function.prototype`.
- Verified in both lanes (shared machinery — see #4562's note on why).
- 551-row standalone guard and the isolated prototype-write corpus stay at
  baseline; GC-lane unit suites measured relative to the merge base.
