---
id: 3888
slug: null-receiver-method-call-never-raises
title: "Standalone: method call on a null receiver returns normally instead of raising TypeError"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: error-semantics
goal: standalone-mode
sprint: current
es_edition: es5
related: [3468, 3877, 3887, 3885]
---

# #3888 — `null.foo()` returns instead of throwing

## Problem

Calling a method on a `null` receiver must raise a **TypeError** under every
edition of the spec (§7.3.x `GetV` / `RequireObjectCoercible`). Under
`--target standalone` the call **returns normally**.

```js
var a = null;
a.nosuch(); // host: TypeError   ·  standalone: returns, no throw
```

## Measured (2026-07-31, both lanes, instrument proven on the lane)

`7` = threw and was caught · `1` = returned without throwing. Probe
`.tmp/throw-detector.mts`.

```
case                                      host   standalone
DETECTOR hand-written throw/catch         7      7      <- instrument proven
DETECTOR throw from a callee              7      7
DETECTOR instanceof TypeError in catch    7      7
OBSERVED null-receiver method call        7      1      <- returns normally
```

The detector establishes that a raised TypeError **is** observable on the
standalone lane. The null-receiver call still does not produce one.

## "TypeError never raised" — NOT "swallowed". Falsified TWICE.

Do not re-open the exception-swallow theory:

1. **#3468** (`status: done`, 2026-07-24) records the correction in its own
   title — _"root cause is function-object own-property gap, NOT a catch_all
   swallow"_ — and notes there is **zero try/catch in the standalone WAT**.
2. **Directly measured here** — the three detector rows above show throws
   propagating and being caught correctly, with `instanceof TypeError` intact.

Nothing is caught because nothing is raised. Look at where the TypeError should
be **generated**, not where it might be lost.

Not residue of #3468 either: that issue's mechanism (function objects unable to
carry own properties) no longer reproduces on current `main`.

## Why this may be the broader of the two

`RequireObjectCoercible` on a null/undefined receiver is **core ES5 semantics**
exercised by a large number of test262 rows — every `assert.throws(TypeError, …)`
shaped around a null receiver. It is plausibly wider in test262 terms than
#3887's refusal path, and it should not be treated as a footnote to it.

Its conformance impact is **unmeasured**. Do not quote a row count without
running it.

## Acceptance criteria

- `var a = null; a.foo()` raises a catchable TypeError on standalone (probe
  returns `7`), matching host.
- Same for `undefined` receivers.
- The detector control still returns `7` on both lanes.
- Working method calls on valid receivers are unaffected.
- **Kill-switch seen to fail**: revert and confirm the `1` returns.
- `tests/issue-3888.test.ts` covers null and undefined receivers on both lanes,
  with a control that must hold under any spec version.

## Landing risk

As with #3887, making this throw **will change standalone test262 results in
both directions**. Rows scored `pass` because nothing fired will start failing
loudly. Measure the flip count (pass→fail, fail→pass, net) by running the
standalone lane before and after, and state it in the PR description along with
whether a justified re-baseline is needed. Do not estimate it.

## Related

- **#3887** — `emitProtoMemberBodyRefusal` returns `null` instead of raising,
  across brands. Same family, separate defect and separate fix site.
- **#3877** — the investigation that surfaced both.
- **#3885** — the instrument-control rule that made these numbers trustworthy.
