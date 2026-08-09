---
id: 3545
title: "Standalone: an uncaught trap inside a microtask job silently ends __drain_microtasks — async scoring INTEGRITY defect"
status: ready
sprint: current
priority: high
horizon: m
feasibility: hard
task_type: bug
area: codegen, standalone, async, test262-runner
language_feature: promises, async-functions
goal: standalone-mode
related: [3178, 3417, 3469, 3542, 1326]
created: 2026-07-23
origin: "2026-07-23 fable-3417, discovered probing the #3542 null-reason cluster: a rejection handler that read `e.message` off a null reason trapped, and every subsequent console.log in that job AND the rest of the drain silently vanished."
---

# #3545 — uncaught microtask trap silently ends the drain

## Problem

On `--target standalone`, when a job running on the native microtask ring
(`__drain_microtasks`, `src/codegen/async-scheduler.ts`) hits an **uncaught
wasm trap** (e.g. `null` dereference — observed concretely: reading
`e.message` when the rejection reason was null, pre-#3542), the trap
propagates out of the job and **terminates the whole drain silently**:

- the remaining statements of that job never run;
- every job still queued BEHIND it never runs;
- the runner's drain call site catches/ignores, reads the stdout sink, and
  scores whatever partial output exists.

Observed repro (pre-#3542 tree, but the mechanism is independent of that fix):

```js
async function fn() { for await (let [{ x }] of [[]]) { return; } }
fn().then(_ => { console.log("resolved"); }, (e) => {
  console.log("rejected");     // printed
  console.log(e.message);      // e was null -> TRAP; nothing after this line
  console.log("never");        //  ran, in THIS job or any queued job
});
```

Sink contained only `rejected` — no error, no marker, no signal that the run
was truncated.

## Why this is an INTEGRITY defect, not a cosmetic one

This can corrupt async scoring in BOTH directions — the same class of
observability failure as the vacuous-pass (#3468) and `(start)`-throw-masking
(#2860) problems:

- a test whose `$DONE()` job is queued behind a trapping job is scored
  `async completion marker not observed` (or on partial output) — a FALSE
  fail or wrong signature;
- a test whose FAILURE path traps before printing `AsyncTestFailure` can look
  like a hang instead of a fail — or, if a pass marker was already printed by
  an earlier job, the truncation is invisible entirely;
- every measurement of standalone async (including the #3538 70/70 and #3542
  30/33 cohort probes) implicitly trusts that the drain ran to quiescence.

## Direction (for whoever takes it — do NOT assume, verify first)

- Decide the contract: per spec, HostEnqueuePromiseJob jobs that throw abort
  the job, not the queue; a wasm TRAP is outside JS semantics but the drain
  loop should at minimum (a) survive to run the remaining queued jobs, or
  (b) surface the trap loudly to the runner (a `__drain_trapped` flag /
  re-throw after queue exhaustion) so a truncated run is never scored
  silently.
- Ground in `__drain_microtasks`'s loop (`src/codegen/async-scheduler.ts`)
  and the runner-side drain call sites (`scripts/test262-worker.mjs` ~1264,
  `tests/test262-runner.ts` ~4245, `tests/test262-shared.ts` ~812 — the
  #3469 channel): check what each does with a drain exception today.
- Any fix must keep the #2961 zero-import discipline and be
  verdict-accounted: making truncation LOUD will re-bucket some current
  passes/fails — that is truth becoming visible, measure and report the
  split (observability-unblocker rule, #3417 F2 precedent).

## Acceptance

- A trapping job cannot silently swallow subsequent queued jobs' output; the
  runner can distinguish "drain completed" from "drain truncated by trap".
- Measured before/after split of affected corpus rows reported (both
  directions), not just the improvements.
