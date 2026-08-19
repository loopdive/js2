---
id: 4562
title: "BOTH LANES: a partial Object.defineProperty over an existing property RESETS the omitted attributes to false (§10.1.6.3 violated)"
status: ready
sprint: current
created: 2026-08-19
updated: 2026-08-19
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
es_edition: 5
language_feature: property-descriptors
goal: es5
related: [4491, 4555, 4563, 4163]
origin: "2026-08-19 ES5 standalone push, #4555 lane, while attempting bound-function `length`. Pre-existing; proved on the base tree."
---

# #4562 — partial `defineProperty` resets omitted attributes

## The defect

§10.1.6.3 (ValidateAndApplyPropertyDescriptor) **preserves** any attribute the
supplied descriptor omits. The runtime instead resets omitted attributes to
`false`:

```js
Object.defineProperty(fn, "length", { value: NaN });
Object.getOwnPropertyDescriptor(fn, "length").configurable;
// false — want true (the existing property's configurable must survive)
```

**This is not a lane divergence — standalone and js-host answer identically.** It
is a shared `__defineProperty_value` validation bug, which is why it is filed
separately from the standalone push's lane issues.

## Why it matters beyond the descriptor itself

A partial define silently makes the property **non-configurable and
non-writable**, so the *next* `defineProperty` on the same property throws
`Cannot assign to read only property`. Any code that builds a property up in two
steps — an extremely common test262 idiom, and a normal library idiom — fails on
the second step for a reason that has nothing to do with what it asked for.

Measured impact in the #4555 lane: it is what makes **3 of the 5**
bound-function `length` rows throw on their second `defineProperty`, **before
`bind` is even reached**. It will be gating rows in the #4491 descriptor lane
too.

## Acceptance criteria

- A partial descriptor preserves every attribute it does not mention, for data
  and accessor properties alike, matching §10.1.6.3.
- The two-step build idiom works: `defineProperty(o,"p",{value:1})` then
  `defineProperty(o,"p",{enumerable:true})` leaves `writable`/`configurable`
  as they were.
- Verified in **both** lanes — this is shared machinery, and a sibling lane's
  regression this session was a js-host defect in lane-shared code that a
  standalone-only verification loop could not see.
- The 551-row standalone guard and the isolated 121-module prototype-write
  corpus stay at their baselines; GC-lane unit suites measured relative to the
  merge base.

## Note

Found while attempting bound-function `length` (#4555 follow-up). That work is
**blocked behind this issue and #4563** — with both fixed, the `length`/`name`
seed becomes a clean ~9-row win instead of a wash.
