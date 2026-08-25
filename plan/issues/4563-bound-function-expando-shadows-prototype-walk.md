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

## 2026-08-21 wave-2 census + Implementation Plan (function lane)

The fix above landed (`829ec458`); the **function lane is now 56 rows**:
`language/statements/function` 31, `built-ins/Function/prototype` 24 (bind
`length`/`name` clusters minus the two #4562 already converted), misc 1. Lane
list: `.claude/worktrees/es5w2-function/.tmp/lane-tests.txt`.

Top signatures: `Cannot access property on null or undefined` (3), `Expected a
TypeError but nothing thrown` (3), `obj.prop === X. Actual: null` (2),
`callee === N` (2), `arguments object don't exists` (2),
`__PROTO.isPrototypeOf(__monster) must be true` (2 — #4480 R4 shape, skip).

### Plan (ordered)

1. Re-baseline lane + guard on the branch point.
2. **Bound-function `name` seed**: #4562's `length` seed landed and measured
   +2/0; `name` is the same mechanism (§20.2.3.2 steps 9-11) on the same
   carrier — extend `bound-fn-meta.ts`, expect ~4 rows.
3. **Function-intrinsic `length`/`name` materialisation (#4562 proper)**: seed
   a real record on first define inside `__defineProperty_value`, coordinating
   with `function-instance-props.ts` meta arms. TWO-LANE job — the host lane
   returns `undefined` from `gOPD(fn,"length")` outright; design the cross-lane
   loop in from the start.
4. **`language/statements/function` residue**: `[[Construct]]` return-value
   semantics and typed-field representation rows are #4464/value-representation
   territory — classify, fix the reachable, record the rest against the owning
   issue.
5. **Skip**: `isPrototypeOf` receiver-spelling rows (#4480 R4).

## 2026-08-21 wave-2 FINAL (function lane) — +7 conformance rows, 0 regressions

Branch `es5w2-function`, two commits (`7bfd3590` #4562 intrinsic record,
`dfc66b05` #4563 `name` seed), merged; all 7 rows independently re-verified by
the integrator on the merged tree.

| corpus | base → final |
| --- | --- |
| `bind/` (100) | 75 → **79** |
| Function tree (509) | 265 → **268** |
| defineProperty (1131) | 1077 → 1077 |
| guard (551) | 551 → 551 |
| js-host Function tree | 338 → 338, binaries byte-identical (positive-control hashes) |

**The 56-row lane counter reads 0 and that is correct accounting, not a miss**:
the ES5-classified lane list contains no `name`/`length` row at all, and its
three `bind` rows are hard refusals (#1472 Phase B / an uncovered carrier path).
Judged by the corpus these issues actually name, the lane moved +7.

**DEPENDENCY CORRECTION**: this issue documented itself as the blocker for the
`length`/`name` cluster. Measured, the arrow also runs the other way — #4562
unblocked three of the `instance-length-*` rows, which define `length` on the
target and THEN bind, so the destroyed merge input was corrupting the
§20.2.3.2 step 5-8 read. The two fixes are mutually enabling, not ordered.

vitest: 78-file scope over descriptor/carrier/function-instance machinery incl.
every `describe.each` GC-lane suite — 36 failing at the true merge base and 36
on the branch, failing-test diff empty. Host half filed as #4593; residue
classifications in #4594/#4595 and the issue bodies.
