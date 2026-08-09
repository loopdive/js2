---
id: 4253
title: "Latent-red root test files stay invisible until someone edits them (#3008 gate is change-scoped)"
status: ready
created: 2026-08-08
priority: medium
horizon: m
feasibility: medium
task_type: ci
area: ci
goal: release-pipeline
related: [3008, 3617, 3683, 3685, 4155, 743]
---

## Problem

**PR CI never runs the root `tests/*.test.ts` population.** The `#3008` gate
(`scripts/hooks/changed-root-tests.sh`, in `quality`) runs only root test files
the branch **added or modified** — deliberately, because the full population is
2,646 files and far too slow per commit. Nothing else in PR CI covers the rest:
`equivalence-shard`, `linear-tests`, `smoke` and `semantic-sanitizers` each run
their own scoped selections.

The consequence is a ratchet with a hole in it: a root test can go red from
ordinary main-side drift and **stay red indefinitely**, because the only thing
that would run it is a PR that happens to touch that exact file. It then
ambushes the next unrelated PR that edits it — which now must fix a
pre-existing failure it did not cause, or drop its own change to that file.

This is not hypothetical. It happened twice within one PR (#4255):

| file | assertion | why it drifted |
| --- | --- | --- |
| `tests/issue-3683-numeric-fields.test.ts` | `fieldType(wat,"A","$has_maybe") === "i32"` → `undefined` | presence tracking moved from one boolean companion per field (`$$has_<f>`) to a **packed word** (`$$presence_0`); the assertion had been reading `undefined` ever since |
| `tests/issue-3683-numeric-fields.test.ts` | reflection bitmask `=== 3` → `11` | `Object.keys` over a standalone fnctor instance started working (arm `8`); the hard-coded total was never updated |

Both were fixed in #4255 only because that PR had to touch the file for an
unrelated reason.

## Two more, still red on `main` right now

Found by a targeted sweep of the 19 root test files that assert on
`__fnctor_` struct shapes. Both reproduce with **identical assertion values** on
pristine `upstream/main` @ `d0019f86e`, so neither is caused by any in-flight
work:

- `tests/issue-3685-presence-tracked-proven-reads.test.ts` —
  *"takes the proven-receiver inline path, not the dynamic `__extern_get` arm"*
  → `expected false to be true`
- `tests/issue-3617.test.ts` —
  *"keeps constructor off the instance's enumerable own keys"*
  → `expected +0 to be 1`

These were left unfixed in the PR that found them: each is an unrelated
behavioural question, and fixing them inside an unrelated PR would pull them
into that PR's `#3008` gate and hide the diagnosis.

### TRIAGED 2026-08-09 — both STALE PINS, neither a real defect

Diagnosed on pristine `upstream/main` @ `49cab5c82`. **Both suspicions above
were wrong, and both for the same structural reason: each test compared a
single SCALAR — a length, a boolean — that two very different causes could
produce.** A pin that cannot distinguish "the thing I guard broke" from "the
thing I guard got better" is not a guard.

**`tests/issue-3617.test.ts` — NOT an enumerability regression.** Probed:

| probe | value | meaning |
| --- | ---: | --- |
| `Object.keys(new DummyError("boom")).length` | 1 | node/spec says `["message"]` — correct |
| `hasOwnProperty("constructor")` | 0 | the invariant the test is NAMED for still holds |
| `hasOwnProperty("message")` | 1 | |
| `Object.keys(new Empty()).length` | 0 | no leak on a field-less instance |
| `value.constructor === DummyError` | 1 | back-pointer intact |

`constructor` never leaked. The pin asserted `length === 0`, which pinned the
BUG — closed fnctor source fields were not surfaced at all, so `message` was
missing too. Its own comment admitted this ("pin the zero-key baseline").
`23fcac402` **fix(#3920): standalone reflection over closed structs enumerated
nothing** made reflection work, `message` correctly appeared, and the stale pin
went red *looking like* a leak.

**`tests/issue-3685-presence-tracked-proven-reads.test.ts` — a stale FIXTURE,
and the machinery is intact.** The census showed all four `n.label` reads
declining `nofield:Node.label`, and the struct said why — `label` is not a
field. `$__fnctor_Node` is now `(start, type, $$presence_0, $$constructor,
$$shape, $$resid)`: `500c4f99b` **feat(standalone): instance expando substrate
(#4194)** routes a field first written from OUTSIDE the constructor into the
`$$resid` bag, so the fixture stopped producing the shape it was written for.

"The #3685 S2 slice is dead code" would have been a real finding (the slice was
built for ~156 acorn sites), so it was checked rather than assumed. Positive
control — conditionally assigned INSIDE the ctor from an UNTYPED param:

```
(field $label (mut externref)) (field $$presence_0 (mut i32))
proven=5 inlined=5    4x  ok:Node.label:externref:presence
```

That is the exact key the file has always asserted: neither the machinery nor
the census format moved.

**Neither is test262-visible.** Semantics matched plain JavaScript in every
configuration probed, for both files — so neither contributes to main's floor
drift, and neither needs attribution back into the #4252/#4254 story.

Fixed by asserting CONTENT instead of a scalar, each with a kill-switch:
`#3617` gains an `Empty()` control plus exact-key assertions; `#3685` moves to
a fixture that produces the externref presence slot, and pins BOTH shapes it
used to have (`presence-nonextern:...:ref_null`, `nofield:Node.label`) as
kill-switches, since either one silently turns the main assertion into a test
of nothing.

## What to do

Two independent pieces of work; the second is the point of this issue.

1. **Triage the two red files above** — decide stale-assertion vs real
   regression for each, and fix accordingly.
2. **Close the visibility hole.** The gate does not need to become
   run-everything-per-PR; it needs the population to be swept *somewhere* on a
   cadence, with the result visible. Options, cheapest first:
   - a **post-merge / nightly** job that runs the full root population (sharded,
     like the equivalence lanes) and opens or updates a single tracking issue
     listing every red file. Latency of a day is fine — the current latency is
     unbounded.
   - a **ratchet file** (`scripts/root-tests-known-red.json`) listing the
     currently-red files with a reason. The nightly fails only on files that
     went red and are NOT in the list, and a PR that touches a listed file must
     remove it from the list. That converts "invisible" into "counted", which is
     the property the repo already relies on for the IR fallback budget and the
     trap-growth gate.

## Acceptance criteria

- [x] The two files named above are triaged and either fixed or recorded with a
      reason. **Done 2026-08-09** — both stale pins, both fixed, verdicts and
      probes recorded above. This was the *symptom*; everything below is the
      issue proper and remains open.
- [ ] The full root `tests/*.test.ts` population is executed on some cadence
      that does not depend on a PR touching each file.
- [ ] A file that goes red is *discoverable without editing it* — a list, an
      issue, or a failing scheduled job.
- [ ] The change-scoped `#3008` gate stays as-is for per-PR latency; this issue
      adds coverage, it does not replace that gate.

## Notes

- Sizing measured 2026-08-08: `ls tests/*.test.ts` = **2,729**; after the gate's
  own exclusions (`linear-`, `c-abi.`, `simd`, `test262-chunk|vitest`) =
  **2,646**.
- The 19-file `__fnctor_`-asserting subset took roughly 2 minutes to run in two
  batches, so a full sharded sweep is plausibly tens of minutes — nightly-sized,
  not per-PR-sized.
- Related lesson already in the repo's memory: *a detector must be able to say
  "I don't know"*. A change-scoped gate answers "nothing wrong" for every file
  it did not look at, which is indistinguishable from "no failures".
