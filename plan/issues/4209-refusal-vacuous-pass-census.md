---
id: 4209
title: "Census: how many currently-PASSING standalone tests pass only because a not-yet-implemented refusal throws TypeError? (decisive experiment: swap the refusal to RangeError)"
status: ready
sprint: current
created: 2026-08-07
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: research
area: standalone, test262-infra
es_edition: 5
goal: es5
related: [4207, 2875, 2961, 2921, 1897, 2097]
origin: "2026-08-07 W28 (#4207 transferred-proto-method lane) — found the mechanism, declined to half-measure the count inside its own PR, and handed over the experiment design."
---

# #4209 — the refusal-vacuous-pass census

## The mechanism

A `--target standalone` **not-yet-implemented refusal throws a `TypeError`**. Any
test whose success condition is "a TypeError is thrown" therefore **passes
because the feature is missing**.

Measured on the #4207 lane:

```js
s = new String();
s.valueOf = Number.prototype.valueOf;
s.valueOf();   // TypeError — but from the refusal body,
               // "Number.prototype.valueOf is not yet implemented in --target standalone",
               // NOT from the [[Class]] brand check the test actually exercises
```

## Why this needs a number, not just a warning

The class **inverts the incentive on correctness work**. Implementing the member
properly converts a passing file into a failing one, unless whatever the test is
*really* checking lands in the same change. So a lane doing good work is charged
with a regression caused by a different missing piece.

Worse, the regression gates run on the **merged state**, so it surfaces as a
`merge_group` auto-park (#2547) — after the author has stood down, in front of
whoever is shepherding the queue, and attributed to the wrong PR.

Every future standalone-builtin implementation walks into this. Without the set,
each one rediscovers it as a surprise park.

It also means **the standalone conformance number is inflated by an unknown
amount**, in a way the honest-metric work (#1897/#2097 floors, #2921's host-free
rule) does not currently catch: these files are host-free *and* genuinely
executed. They are simply passing for the wrong reason.

## The decisive experiment (W28's design)

The cheap version — grep for currently-`pass` files asserting a TypeError
against a refused member — is **an upper bound only**, because a file can assert
TypeError for a reason the refusal coincidentally satisfies *and* would still
pass once implemented.

The decisive version is one extra arm:

1. Change the refusal body to throw a **`RangeError`** instead of a `TypeError`.
   Nothing else.
2. Re-run the standalone corpus.
3. **Every currently-passing file that flips is passing because the feature is
   missing.** No inference required — a test that wanted a real TypeError is
   unaffected, and one that was only catching the refusal fails.

This is clean, self-contained, and needs no judgement calls about intent.

## Deliverable

- The **enumerated set**, per file, with the refused member each one depends on.
- Grouped by owning issue (#2875 unimplemented-member, #2961 host-import leak,
  and whatever else appears) so each implementation lane can find its own
  at-risk files before it starts.
- A recommendation on whether the refusal should throw a **distinguishable**
  error type permanently, so this class becomes self-detecting rather than
  needing a census each time. Note the tension: a non-`TypeError` refusal is
  further from spec behaviour for code that legitimately expects a TypeError,
  so this is a real trade-off and not an obvious win.

## Candidate predicate (starting point, not the answer)

Currently-`pass` files whose effective source (body + `includes:` harness) reads
`<Builtin>.prototype.<m>` as a **value** and asserts a TypeError.

## Acceptance criteria

- [ ] The RangeError arm is run over the full standalone corpus, not a sample.
- [ ] The flipped set is enumerated per file and attributed to a refused member.
- [ ] The result is stated as a **count of inflated passes** in the standalone
      metric, so the honest number is known even if nothing is fixed.
- [ ] The at-risk set is written somewhere an implementing lane will hit it —
      the owning issues, not only this one.

## Instrument notes

- `.claude/memory/project_hostfree_pass_can_be_vacuous_inject_throw_probe.md`
  records this as the **second** vacuous-pass mechanism; the first is the #2921
  dead-callback-body class. Read both before designing the run.
- Standard traps apply: use `ensureStandaloneBaselineJsonl({force:true})` (the
  default jsonl is the HOST lane), delete the provider `.wasm` per arm, rebuild
  `scripts/compiler-bundle.mjs` + `scripts/runtime-bundle.mjs` per arm, and use
  `JS2_WORKTREE_SOURCE=/home/user/js2` because
  `scripts/provision-worktree-deps.sh` silently no-ops here.

## Do NOT bound this by the pre-scan dirty gates

Measured by W28 over the effective source of all 48,619 baseline rows: the
js2wasm host-globals shim that `assembleOriginalHarness` prepends to **every**
file contains `return eval(sourceText);`, so `isDynamicCodeUse` sets
`dynamicCodeDirty` ⇒ `protoNamedDirty`. **48,587 of 48,619 rows have the gate
SET; only 32 are provably clear.**

Any "gated on `protoNamedDirty`, therefore byte-identical" safety claim is true
in principle and worth **0.07 %** of the corpus in practice. Size exposure by the
real trigger instead.

---

## Handoff — 2026-08-07

Unowned and unstarted. Two data points arrived after filing, both worth having
before anyone runs the census:

1. **The #4207 lane's estimate of 825 candidates is an UPPER BOUND, not a
   count**, and it said so. The cheap predicate (currently-`pass` files asserting
   a TypeError against a refused member) over-counts, because a file can assert
   TypeError for a reason the refusal coincidentally satisfies and still pass
   once the feature is implemented. Only the RangeError swap distinguishes them.
2. **The #4210 lane found a second flavour that this issue's predicate does NOT
   catch**: files passing because a *write is silently dropped*, with no refusal
   and no throw anywhere (`preventExtensions/15.2.3.10-3-{10,20}.js` on an Error
   receiver). Same class — "passes because the feature is missing" — but the
   RangeError swap will not surface it, because nothing throws. Worth deciding
   whether this issue owns that flavour too, or whether it needs its own probe.

Session-wide context: `plan/agent-context/session-2026-08-07-lead-handoff.md`.
