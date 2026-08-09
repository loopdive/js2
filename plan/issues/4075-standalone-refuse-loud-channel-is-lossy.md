---
id: 4075
title: "The standalone refuse-loud channel is LOSSY — a non-`sticky` reportError is discarded by rollbackSpeculative and silently becomes a wrong answer"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-mode
related: [3725, 4044]
---

# The standalone refuse-loud channel is lossy

Found 2026-08-02 by the `H-errmodel` agent while implementing #4044 (PR #4005).
Traced, not inferred. Reported to the lead rather than folded into that PR,
because the blast radius is the whole refusal channel, not one call site.

## Mechanism

A codegen site calls `reportError` in order to **refuse** rather than answer
wrong. If that call omits `sticky` (#3725), `compileExpressionBody`'s
null-result unwind (`rollbackSpeculative`) **discards the diagnostic** and
substitutes `pushDefaultValue`.

Measured trace:

```
errors.len 1 → rollback DROPPING 1 diag → generateModule returns errors.len 0
             → success:true, imports:[]
```

The emitted body was:

```wat
global.get $undefined
extern.convert_any
drop
```

— a placeholder standing in for a refusal **that had already been erased**.

## Why this is worse than one bad lowering

The entire point of the standalone refuse-loud channel is *"refuse rather than
answer wrong."* Every site that omits `sticky` **silently inverts that
contract**. And the inversion is invisible to every gate we have:

- no host-import leak is recorded (`imports:[]`)
- no compile error is reported (`success:true`)
- the test does not crash — it returns a plausible wrong value

An erased refusal leaves **no evidence anywhere**. This is the same failure
family as a gate whose output is never read: the observable outcome is identical
to "everything is fine."

It also means any conformance measurement taken over an affected shape has been
measuring a *placeholder*, not a refusal — so the failure was never attributable
to the feature that actually did not work.

## Work

1. Sweep every `reportError` on the standalone codegen path; determine which are
   non-`sticky` and reachable from a speculative-rollback context.
2. For each, decide: make it `sticky`, or prove the rollback is legitimate for
   that site.
3. Add a gate so a **new** non-sticky refusal cannot be introduced silently.

## ⚠ Required control — a zero result here is not trustworthy without it

The sweep **must** carry a **positive control** that proves the detector fires
on a known-lossy site (the one in this report, from #4044). Without it, "no
lossy sites found" is indistinguishable from "the detector does not work" —
which is precisely the trap this codebase keeps falling into, and precisely the
trap this defect *is*.

Report the count of sites audited (the denominator), not just the count found.

## Not yet done

`H-errmodel` explicitly did **not** audit the other refusal sites. Nothing here
has been sized. Do not quote a population until the sweep runs.
