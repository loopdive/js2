---
id: 4305
title: "RuntimeError: illegal cast — a succeeding direct eval followed by a throwing one with an `instanceof` catch traps in caller-side codegen (engine-independent)"
status: ready
sprint: current
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: m
feasibility: medium
model: opus
reasoning_effort: high
task_type: bug
area: codegen
language_feature: eval
goal: runtime-eval
related: [2928, 2929, 4238, 4242, 4245]
# ids 4262/4263/4264/4265 were reserved and ABANDONED before this file was
# written: claim-issue.mjs --allocate resolves "main" against `origin`, which in
# this checkout is the FORK, and the fork's main was ~90 commits stale, so the
# allocator minted ids already used upstream (4262/4264/4265 all exist on main;
# true max was 4304). Fixed by fast-forwarding the fork's main to upstream and
# re-allocating -> 4305. See the "allocator reads the fork" note in #4242.
# Open-PR scan DEGRADED (no gh in this container) and GitHub code search was
# returning 503, so this id is verified against upstream main + the assignment
# ref only; the required check:issue-ids gate is the backstop.
---

# #4305 — `illegal cast` after a succeeding direct eval, when a later eval throws

## Discovered by

#4238 slice 3 (direct-eval scope snapshot). This was **unreachable before slice
3** because direct eval always returned the typed refusal, so no direct eval
ever *succeeded* and the two-eval sequence below could not occur.

## The defect

Within a single function:

1. a **direct** `eval(...)` that **succeeds**, then
2. a later `eval(...)` that **throws**, caught by a handler that does an
   `instanceof` test

traps with `RuntimeError: illegal cast`.

**It is caller-side codegen, not the eval engine.** The slice-3 author
reproduced it with a **six-line stub adapter** substituted for the real
provider — no QuickJS, no interpreter — so it is engine-independent and will
reproduce against any provider that can make a direct eval succeed.

## Why this is priority: high

It **will bite #4242's Phase-1 parity run**: the test262 harness wraps
assertions in `assert.throws(...)`-shaped code with `instanceof` catches, and
slice 3 has now made direct eval succeed under the quickjs engine, so the
precondition is satisfied across a large slice of `language/eval-code/`. A
parity measurement that trips this trap attributes engine-independent codegen
failures to the engine under test — exactly the mis-attribution #4242's gate
is designed to prevent, and it would land in the `unattributed` bucket (which
always blocks).

## Repro

The precise repro is recorded in the `## Slice 3 — implementation record`
section of `plan/issues/4238-quickjs-runtime-eval-provider-flag.md`, including
the six-line stub adapter that removes the engine from the picture.

## Acceptance criteria

- [ ] Minimal repro lifted into a permanent test (`tests/issue-4305-*.test.ts`)
      that fails on current main and passes after the fix, using the stub
      adapter so the test needs no provider artifact.
- [ ] Root cause identified in `src/codegen/` — name the cast site and why the
      value's static type diverges from its runtime type on the
      succeeded-then-threw path.
- [ ] Fix does not regress the refusal path (eval that always throws) or the
      no-eval path; default-path suites green.
- [ ] Confirm the fix under BOTH engines (`JS2WASM_EVAL_ENGINE=quickjs` and
      `TEST262_FULL_RUNTIME_EVAL=1`) — it is engine-independent, so both must
      clear.
- [ ] Re-run the scoped `language/eval-code/` measurement and record whether
      the `unattributed` bucket shrinks (#4242 gate input).

## Non-goals

- The membrane (#4245) and the parity flip (#4242) — separate issues.
