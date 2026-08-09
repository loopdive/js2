---
id: 4184
title: "Eval-consumer mode: top-level bindings widened to externref while consumers still expect `ref_null $AnyValue` — stack-balance papers over it with a blind cast (traps, or mis-tags as \"string\")"
status: ready
sprint: current
created: 2026-08-06
updated: 2026-08-06
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, value-representation, runtime-eval
language_feature: n/a
goal: runtime-eval
related: [4178, 4162, 1888, 2931]
discovered_by: ttraenkler/W3-runtime-eval-ternary
origin: "Found while fixing #4178; this is the real home of the '739 ES5-label standalone failures in eval-consumer modules' figure"
---

# #4184 — eval-consumer `$AnyValue` / externref carrier mismatch

## Problem

In **eval-consumer** mode (a module that reads the global `eval`/`Function`, so
it links `js2wasm:runtime-eval` — see #4162 for how broad that is),
`registerReassignedFunctionGlobals` (`src/codegen/index.ts:6006-6027`) widens
**every** top-level binding to `externref`. Consumers of those bindings still
expect `ref_null $AnyValue`. **Nothing coerces between the two.**

`src/codegen/stack-balance.ts:1504` papers over the resulting type
disagreement with a blind `any.convert_extern; ref.cast_null`. Two outcomes,
both bad:

- on a `$BoxedNumber` carrier it **traps**;
- on an `$AnyValue` carrier it **mis-tags as tag-5 "string"** — the #1888 lie.

## The trap for whoever fixes it

> **Fixing the boxer alone converts the wrong answer into a crash. Do the read
> site first.**

The blind cast is currently absorbing a mismatch that would otherwise surface
as a hard trap. Correct the producer without correcting the consumer and every
program that currently limps along with a wrong tag starts trapping instead.
That is a conformance number moving *down* while the code gets *more* correct,
which is exactly the shape that gets a change reverted.

## Sizing — read this before estimating

A measured figure exists and is easy to misapply: **739 ES5-label standalone
failures live in eval-consumer modules.** That is the population of modules
that link the namespace, **not** the yield of this bug. The same figure was
originally attached to #4178, where it turned out to be incidental correlation
(the eval-mode framing there was refuted outright — see #4178 and PR #4156).

So: 739 is an **upper bound on where this could possibly matter**, nothing
more. Measure the lever before committing to a plan, and use the #4162 shim or
the numbers will be instrument artifact.

Also note the staleness trap that turned a plausible `+25` into a measured `0`
on the sibling issue: **the committed baseline goes stale within hours on an
active day**, so re-run any apparent movers on both trees before believing
them.

## Likely shape of the fix

Two halves, in this order:

1. **Read sites** — teach the consumers of top-level bindings to accept an
   `externref` carrier and unbox it honestly (respecting the #1988 split:
   a native string rides in `externval`, not `refval`).
2. **Producer** — then either stop the blanket widening in
   `registerReassignedFunctionGlobals`, or make it emit a real coercion rather
   than relying on the downstream blind cast.

Only after both should `stack-balance.ts:1504`'s blind cast be removed; it is
the symptom, not the cause, and removing it first just relocates the failure.

## Acceptance criteria

- A top-level binding holding a `$BoxedNumber` survives a round-trip through
  eval-consumer mode without trapping.
- A top-level binding holding an `$AnyValue` reports its true `typeof`, not
  `"string"`.
- The blind `any.convert_extern; ref.cast_null` at `stack-balance.ts:1504` is
  removed, or narrowed to a case where it is provably correct.
- Measured on the eval-consumer population with the #4162 shim; standalone
  floor net ≥ 0.

## Notes

- **Id provenance:** reserved via `claim-issue.mjs --allocate`, taken above 4172
  because ids 4163–4171 were squatted by the (now closed) PR #4124.
- Sibling filed at the same time: **#4183** (inline `$AnyValue === nativeString`
  answers false).
- **#4162** is a prerequisite for trustworthy measurement here, not merely
  adjacent: the in-process runner drops the runtime-eval provider, so
  eval-consumer modules — precisely this issue's population — die at
  instantiate and their real signature is replaced by a link error.
