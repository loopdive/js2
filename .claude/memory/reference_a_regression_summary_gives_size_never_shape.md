---
name: reference_a_regression_summary_gives_size_never_shape
description: "Summary counts tell you the SIZE of a regression, never its SHAPE. 'It both fixes and breaks heavily, so it cannot be one bug' is UNSOUND — one defect on a shared hot path produces exactly that profile. Read the rows and diff the error texts."
metadata:
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
---

Measured 2026-08-02 on PR #4027. Two agents (a shepherd and the tech lead)
independently reached the same wrong conclusion from the same aggregate, and it
was filed as a dispatch instruction before measurement refuted it.

## The unsound inference

Gate summary:

```
host:       146 improvements / 152 regressions
standalone: 107 improvements / 143 regressions
```

Reasoning applied: *"it both fixes and breaks heavily — a single defect does not
produce that shape, so this is partially-complete work needing a split."*

**Wrong.** It was **one defect**: `getSourceFile()` returns `undefined` for a
synthesized identifier, the new module memoized on that key,
`WeakMap.set(undefined, …)` threw, and a speculative catch converted the throw
into a **whole-file compile_error**.

**Why the mixed profile appeared anyway:** the defect sat in a **cache on a hot
path**, consulted by improving and regressing cases alike. A shared-path defect
and two half-finished changes produce *the same aggregate signature*. The counts
were correct; they simply could not discriminate, and were treated as if they
could.

## The rule

> **A regression summary tells you the SIZE of a problem, never its SHAPE.
> The rows do.**

The discriminating check took minutes and was available the whole time:

- **read the regressed FILES, not the summary**;
- **diff their error texts.** Here **152/152 host and 143/143 standalone**
  carried byte-identical error text — which collapses the hypothesis space to
  "one defect" instantly;
- **look at WHICH buckets regressed.** They were `statements/with`,
  `compound-assignment`, `Object/defineProperty` — none of them Annex B, i.e.
  nothing to do with the change's subject. That mismatch alone should trigger
  suspicion of your own model.

## The missing causal link — the CATEGORY field was actively wrong

Reported by the owner after the fix. CI's category field recorded
**`runtime_error: 152`** for what were **compile-time throws**.

That is not CI being sloppy — it is accurate *for what CI could see*. The
speculative catch in `compileExpressionBody` swallowed a compile-time
`TypeError` and re-emitted it as a generic failure, so by the time the
categoriser saw it, the compile-time origin was gone. **The laundering happened
upstream of the instrument.**

This is why the aggregate was not merely uninformative but *misleading*: a
category that says `runtime_error` steers you toward "many different runtime
behaviours changed" — i.e. a broad, multi-cause change — and away from "one
compile-time crash". It cost a 20-minute fix a full split-the-PR dispatch.

Adjacent to #4075 (*the standalone refuse-loud channel is LOSSY*): the same
catch that discards a non-sticky `reportError` also destroys the provenance a
triage tool needs. **When an error passes through a catch that re-labels it,
every downstream classification inherits the re-label — and nothing marks it as
second-hand.**

## Corollary — label hypotheses as hypotheses when dispatching

The wrong diagnosis was handed to the owner explicitly as *"a hypothesis with
good support, NOT established fact — if measurement refutes it, follow the
evidence."* The owner refuted it in the first hour.

**Had it been filed as settled fact, the owner would plausibly have spent the
session hunting a split that did not exist.** The framing, not the content, is
what made the dispatch survivable. Do this whenever dispatching a diagnosis you
have not measured yourself.

Related: [[reference_silent_empty_is_indistinguishable_from_real]],
[[feedback_measure_never_extrapolate]],
[[reference_shape_matrix_is_not_a_population_estimate]],
[[reference_wire_the_fix_at_the_narrowest_site_not_the_most_general]].
