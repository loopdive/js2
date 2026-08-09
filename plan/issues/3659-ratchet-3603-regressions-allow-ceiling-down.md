---
id: 3659
title: "Ratchet #3603's regressions-allow ceiling down from the stakeholder-directed unmeasured 2500"
status: ready
created: 2026-07-26
priority: high
horizon: s
feasibility: easy
area: ci
goal: correctness
sprint: current
related: [3603, 3635, 3370, 3303]
---

# #3659 — replace the unmeasured 2500 ceiling with a measured one

## What was done, and why it is deliberately provisional

PR #3635 (#3603 S1, host verifyProperty de-inflation) carries:

```yaml
regressions-allow:
  count: 2500
  reason: "... Stakeholder-directed UNMEASURED ceiling (2026-07-26) ..."
```

**2500 is not a measurement.** It was a stakeholder decision taken on 2026-07-26
to land the de-inflation without waiting for a v12 merge_group run, after the
tradeoff was stated explicitly: a ceiling that is too low re-parks, one that is
too high **banks unmeasured regressions**.

## Why no smaller number could be derived at the time

The `ORACLE_VERSION` 11→12 bump **is itself the verdict-logic change**. At v12 the
row classifications differ on **both sides** of the diff, so the prior v11 figures
are not merely stale — they are a **different quantity** and cannot be arithmetically
converted. Additionally the baseline moved four times in one evening
(30,390 → 30,446 → 30,517 → 30,511), so the denominator was not stable either.

For context only, **do not reuse as a ceiling**: at v11 against baseline `895058f`,
two merge_group runs measured **1031–1033** honest regressions and **96–97** gross
fixed (net −989 / −994).

## Do this

1. Take the **first v12 merge_group measurement** on #3635's merged state.
2. Record, per the stakeholder ruling's condition (d), **gross-fixed and
   honest-regressions separately — never a net**.
3. Set `count:` to **measured + a documented margin**, showing the arithmetic.
   Margin must cover at least the observed run-to-run spread (~2) plus baseline
   drift. Never a round number.
4. Note `regressionsWasmChange > count` hard-fails as "not a blank check", so the
   ceiling is a real bound in both directions.

## Related trap

The declaration is honoured post-merge **only** when it carries a nested `tests:`
list (`named-verified`); a bare `count:` + `reason:` without an oracle bump is
classified `inert` and grants zero. See #3644 / #3660.
