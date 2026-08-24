---
id: 4664
title: "ES5 standalone: a deleted RegExp.prototype ACCESSOR is resurrected by the member CSV — 3 rows, same defect #4491 T9 closed for `constructor`, one member-kind over"
status: ready
sprint: current
created: 2026-08-24
updated: 2026-08-24
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: regexp
goal: standalone-gap
related: [4654, 4491, 3875, 2885]
origin: "split out of #4654 part B by the lane that fixed part A. Root cause below is MEASURED, not suspected — the lane located the exact predicate and the exact restriction that hides the delete."
---

## Problem

Three rows. `RegExp.prototype` is the receiver, not an instance:

```
built-ins/RegExp/prototype/global/S15.10.7.2_A9.js       __re.hasOwnProperty('global') must be false
built-ins/RegExp/prototype/multiline/S15.10.7.4_A9.js    ... 'multiline'
built-ins/RegExp/prototype/ignoreCase/S15.10.7.3_A9.js   ... 'ignoreCase'
```

```js
var __re = RegExp.prototype;
assert.sameValue(__re.hasOwnProperty('global'), true);    // passes
assert.sameValue(delete __re.global, true);               // passes
assert.sameValue(__re.hasOwnProperty('global'), false);   // FAILS
```

The runner attributes two of the three to `at L14`; that is a heuristic artifact.
The assertion **message** ("must return false") is authoritative and is L16 in all three.

## Root cause (measured in the #4654 lane)

`__nproto_hasown` (`src/codegen/native-proto-own-props.ts`) answers `1` for **any**
key present in the brand's `$memberCsv`, and `global` / `ignoreCase` / `multiline`
are in `REGEXP_PROTO_STRING_MEMBERS`. The seeded-member ladder that consults the
**mutable companion** — the one #4491 T9 extended to cover `constructor` — is
restricted to `kind === "method"`, because `ensureNativeProtoCompanionSeeder`
deliberately does not seed accessors.

So the delete succeeds and is then unobservable: nothing on the `hasOwnProperty`
path can ever see it for an accessor-kind member.

Structurally this is the **same defect #4491 T9 closed for `constructor`**, one
member-kind over.

## Why this is filed rather than fixed

Widening the ladder means touching `ensureNativeProtoCompanionSeeder` to seed
accessors. **A prior attempt at exactly this flipped #2885** — the record lives in
`src/codegen/native-proto.ts`. That is why this is a separate issue with its own
canary requirement rather than a rider on #4654.

## Implementation Plan

1. **Read the prior-attempt record first** in `ensureNativeProtoCompanionSeeder` /
   `src/codegen/native-proto.ts`, and state in your report how your approach differs
   from the one that flipped #2885 — or decline with the measurement.
2. **Establish a #2885 canary on BOTH arms before writing any fix.** The failure mode
   this issue guards against is a regression in a *different* issue, so a sweep that
   does not include #2885's rows cannot see it. Run the canary on the base arm first
   so you have a real before-state (file-copy A/B, capture `.tmp/base.ts` at the first
   edit).
3. Widen the companion consult so a deleted **accessor** member is observable:
   either seed accessor-kind members into the mutable companion, or add an
   accessor-aware deleted-key set that `__nproto_hasown` consults before answering
   from `$memberCsv`. Prefer whichever does **not** change what a non-deleted
   accessor read returns.
4. **Check #3875 first if the root moves.** #3875 is "reflection routes disagree on
   built-in prototype properties". If the real root turns out to be #3875's rather
   than this ladder's, hand it back **with evidence** instead of patching here.

## Acceptance

- The three rows above pass in standalone.
- **#2885 measured green on both arms** — this is the gate, not a nice-to-have.
- Blast-radius sweep per `plan/method/es5-standalone-agent-brief.md`: this touches a
  shared prototype-reflection helper, so the sweep covers the native-proto consult's
  call sites, not just `built-ins/RegExp`.
- Zero regressions, with contention-suspect rows re-run serially before they are
  reported as flips.
