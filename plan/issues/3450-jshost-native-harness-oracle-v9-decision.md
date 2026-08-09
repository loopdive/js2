---
id: 3450
title: "decision(test262): JS-host lane native-JS harness — oracle v9 policy proposal [DECISION — needs sign-off]"
status: blocked
sprint: Backlog
created: 2026-07-19
updated: 2026-07-19
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: decision
area: ci
language_feature: n/a
goal: maintainability
depends_on: [3433]
blocked_by: stakeholder-decision
---

# JS-host lane native-JS harness — oracle v9 policy proposal (L3 / Spec E)

> **[DECISION — needs stakeholder sign-off]** This is a policy-decision issue, NOT
> claimable dev work. It stays `status: blocked` until the lane owner + user sign
> off on the design. Do **not** start implementation, and do **not** sequence CI
> health on it — L1 (#3448) / L2 (#3447) / L6 (#3449) deliver the queue-throughput
> fix without touching the oracle.

Implements lever **L3** from `plan/ci-acceleration-review.md` (§3-L3, §5-E), gated
behind a decision.

## Context

The measured structural cost in the test262 pipeline is the **~146k full-assembly
harness compiles per full run** (both lanes) — the assembled prelude is 75–97 % of
every compile (issue #3433). #3374 made prelude codegen linear but it remains the
dominant per-compile cost: body-only compile is **59–173 ms** vs full assembly
**250–511 ms** post-#3374.

The JS-host lane already executes with full JS interop (`buildImports`, sandbox
globals — `scripts/test262-worker.mjs:1397-1431`). Mechanically, `assert.js` /
`sta.js` / `propertyHelper.js` **could execute natively in the sandbox** with only
the untouched test **body** compiled to wasm — a **~2–4× host-compile win** on
~73k host-lane compiles (host shards ~9 → ~5–6 min at 40-way, or halve the host
shard count at constant wall).

## Why this is a decision, not a perf tweak

This is an **ORACLE POLICY change** (ORACLE_VERSION 8 → 9 + `ORACLE_REBASE`), not
a performance optimisation. #3370/v8's honesty contract is "compile the literal
assembly"; moving the harness across the wasm/JS boundary changes what a verdict
*measures*:

- **`Test262Error` cross-boundary identity** — a native-JS harness throws a JS
  `Test262Error`; the wasm body's `instanceof`/catch semantics must still classify
  it correctly.
- **`verifyProperty` MOP on wasm-created objects** — property-helper meta-object
  operations run natively against objects created inside wasm.
- **script-global sharing** — harness `var`s must be visible to the test body and
  vice versa across the boundary.
- **strict rerun** — a native harness is strict-neutral, but the *body* still needs
  both compilations, so the 1.7× strict-rerun multiplier stays.

Some current honest fails would become boundary artifacts; some current passes
could flip. That is exactly the class of change ORACLE_VERSION + `ORACLE_REBASE` +
promote-baseline force-refresh exist to gate (see the header of
`tests/test262-oracle-version.ts`), and #3433's roadmap already records this same
conclusion plus the user design input of 2026-07-18.

## Acceptance criteria (for the decision — NO implementation)

1. **Design doc** covering: `Test262Error` cross-boundary identity,
   `verifyProperty`-on-wasm-objects MOP, script-global sharing, strict-rerun
   handling.
2. **A/B verdict-flip measurement** on a ≥**200-test** stratified sample (native
   harness vs v8 literal-assembly), quantifying how many verdicts flip and in which
   direction.
3. **Explicit sign-off** from the lane owner **and** the user, per the #3433
   roadmap note, recorded in this issue.
4. If approved: an ORACLE_VERSION → 9 + `ORACLE_REBASE` plan per the
   `tests/test262-oracle-version.ts` header — filed as a separate implementation
   issue. This issue does not carry implementation.

## References

- Review: `plan/ci-acceleration-review.md` §3-L3, §5-E, §2.1, §2.3.
- #3433 (prelude compile cache — profiling + Roadmap section, lane-asymmetric
  end-state), oracle contract in `tests/test262-oracle-version.ts:34,180-193`.
