---
id: 6440
title: "`Promise.try` is lowered to a host intrinsic the declared `engines: node >=20` floor does not have"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: medium
horizon: s
feasibility: easy
task_type: bug
area: runtime
goal: correctness
---

## Problem

Residual from
[#6419](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6419-three-closure-area-tests-red-on-main)
arm 7.

On the JS-host lane the compiler lowers `Promise.try` straight onto the host's
`Promise.try`. That method landed in Node 23; `package.json` declares
`engines: { node: ">=20" }`. On Node 20/22 a compiled program using
`Promise.try` fails at runtime with `Promise.try is not a function` — and
nothing says so at compile time. The standalone lane lowers it natively and is
unaffected.

CI runs Node 24/25, so the whole repo is green on it. The gap surfaced only
because `tests/issue-2637-b2-ctor-closure-registration.test.ts` was run on a
Node 22 box, where its `Promise.try` row failed for a reason that had nothing
to do with the ctor-registration behaviour under test. #6419 gated that row on
`typeof Promise.try === "function"` — a correct thing for that test to assert,
and not a fix for this.

## The decision to make

Three options, and the point of this issue is to pick one rather than leave the
mismatch implicit:

1. **Polyfill it** next to the existing host-lane Promise handling. Note the
   constraint: `src/runtime.ts` is AT the #4401 ceiling, so new runtime code
   belongs in `src/runtime/<module>.ts`, and a library that mutates the host's
   global `Promise` is a real decision, not a detail.
2. **Raise the floor** to the engine that actually supports what the host lane
   emits (`engines: node >=23`), and say so in the README.
3. **Refuse at compile time** on a host target below the floor, with a
   diagnostic naming the method and the required engine.

## Acceptance criteria

1. One of the three is implemented, and the reasoning is written down where a
   reader meets it (`docs/` or the lowering site).
2. `engines` and the host lane agree, in whichever direction is chosen.
3. A test that fails on the unsupported host rather than silently producing a
   runtime `TypeError` at the call site.
