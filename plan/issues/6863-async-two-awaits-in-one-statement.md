---
id: 6863
title: "async: two `await`s in one statement (`expect(await a).not.toEqual(await b)`) send the whole function to the synchronous pass-through"
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
goal: dogfood
---

## Problem

`lowerLinearStatements` (`src/codegen/async-cps.ts`) returns `false` for any
statement with more than one await (`if (awaitsHere > 1) return false`), so
the whole async function falls to the synchronous pass-through and EVERY await
in it becomes an identity — not just the two in that statement.

hono `src/utils/crypto.test.ts` "Should create hash for Buffer":

```ts
const hash = createHash('sha256').update(new Uint8Array(1)).digest('hex')
expect(await sha256(new Uint8Array(1))).toBe(hash)
expect(await sha256(new Uint8Array(1))).not.toEqual(await sha256(new Uint8Array(2)))
```

With [#6450](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6450-node-crypto-createhash-null-provider)
fixed the first line is correct, and the row now fails on the SECOND line
(`assertion 1 toBe: object != string` — the first `await` handed `expect` the
Promise) because of the third line. The neighbouring row "Should not be the
same values" passes only vacuously: it compares two Promise objects, which
are always unequal.

## Implementation Plan

The second await is NOT the statement's first observable step — `expect(…)`
and `.not` run between the two suspensions — so the #6846 replay (recompile
the statement after the resume) is unsound here. Needed: a two-suspension
lowering that spills the partially-evaluated operands between them, i.e. the
#6504 spilled-call continuation generalized to a receiver that itself contains
an await: suspend on `a` → deliver → evaluate `expect(va).not` once and spill
the receiver and its `toEqual` read → suspend on `b` → call the spilled method
with the delivered `vb`. Start by measuring how often >1-await statements
occur across the dogfood suites (`expect(await x).toEqual(await y)` is the
common shape) to size it.

Expected: hono `crypto.test.ts` 3/4 → 4/4; "Should not be the same values"
becomes a real (non-vacuous) pass.
