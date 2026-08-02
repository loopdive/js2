---
name: reference_wire_the_fix_at_the_narrowest_site_not_the_most_general
description: "Blast radius comes from wiring a fix at the most general point available. When a regression's mechanism resists isolation, NARROW the change until the mechanism is out of scope — that beats chasing it."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-02T09:05:08.357Z
---

Measured 2026-08-02 on #4055 / PR #4017, which was auto-parked for breaching the
standalone host-free floor by **−684** (713 files lost, 682 of them
`built-ins/**/{name,length}.js`, 696 with one signature: *"name/length
descriptor should be configurable"*).

## The diagnosis the author reached, in their own words

> *"My +14 never needed the user-visible `Object.prototype.hasOwnProperty` to
> change at all — that was me wiring the fix at the most general point
> available, which is exactly where the blast radius lives."*

The 14 real flips were entirely about `__obj_define_from_desc`'s
ToPropertyDescriptor doing HasProperty over a **function descriptor carrier**.
The fix was wired into `emitHasOwn` — the general, user-visible
`hasOwnProperty` — which also feeds `verifyProperty`/`propertyHelper` and every
`name`/`length` reflection test in the corpus.

**The narrow fix keeps all 14 flips and cannot reach any of that.**

## The rule

> **Wire a fix at the narrowest site that produces the measured effect, not the
> most general site that would produce it.**

The general site is usually easier to find and reads as more "principled". It is
also where every unrelated consumer lives. Ask: *which callers does this site
have that my measured population does not need?* Every one of those is blast
radius you are taking on for free.

## Corollary — when a regression's mechanism resists isolation, NARROW instead of chase

Three sub-mechanisms were measured in isolation and **all three refuted**: gOPD
read `configurable: true` on both arms (not redirected to the carrier bag),
`isConfigurable`'s real body was already wrong on both arms (pre-existing), and
the vacuity gate was `true` on both arms (nothing de-masked). The trigger needed
the **full harness assembly** — closures carrying own properties — and would not
reproduce in isolated spellings.

Narrowing the change put the mechanism **out of scope entirely**, so it never
had to be understood. That is a legitimate and often superior resolution: you do
not owe every regression an explanation if you can make it unreachable.

(The lead's own model — "hasOwn true ⇒ gOPD redirected to the bag ⇒ all-false
defaults" — was plausible, fit the file names, and was **wrong**. It was
refuted by direct measurement rather than argued with.)

## Also from this incident: control STRATUM vs control AXIS

Two independent instruments agreed on the effect — a 220-file corpus-wide sweep
found 7 pass→FAIL (3.2%), the exact artifact diff found 684/26,403 (2.6%). That
agreement established the sweep **axis** was sound and only the **stratum** was
wrong.

"My controls missed it" and "my controls were incapable of seeing it" are
different admissions. Say which. Here the miss was a stratum: the affected
population was `built-ins/**/{name,length}.js` (~700 files, uniformly affected),
which is invisible from any descriptor-area sample no matter how large.

Related: [[reference_bigger_number_bought_with_a_silent_wrong_answer_is_negative_value]],
[[reference_acceptance_bar_denominator_and_killswitch_attribution]],
[[reference_runtest262file_not_ci_path_status_only]].
