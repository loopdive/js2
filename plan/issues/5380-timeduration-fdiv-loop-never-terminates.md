---
id: 5380
title: "`TimeDuration.fdiv`'s bounded `for (; !JSBI.equal(s, ZERO) && c.length < 50; ) { … c.push(…) }` never terminates through the linked provider — `ZonedDateTime.prototype.hoursInDay` hangs (fail → hang once #5378 makes the path reachable; a synchronous Wasm loop kills the shard fork at 30 s)"
status: ready
sprint: current
priority: high
horizon: s
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-07
---

# #5380 — a `c.length < 50`-bounded loop runs forever in the compiled polyfill

## Problem

Found by dev-5378 (PR #5706): with the time-zone offset finite for the first
time, `built-ins/Temporal/ZonedDateTime/prototype/hoursInDay/basic.js` goes
from `fail` (6 s, `infinity is out of range` before any duration arithmetic) to
a **hang** — still running after 900 s on an idle box, for `UTC`, `+00` and
`+01` alike. `startOfDay()`, `.year`, `.offsetNanoseconds` on the same receiver
answer in 5–6 s; only `hoursInDay` — the one getter that divides a
`TimeDuration` — hangs. The polyfill's method:

```js
fdiv(n) {
  const r = m(n), i = e.BigInt(r);                 // e = JSBI
  let { quotient: a, remainder: s } = g(this.totalNs, i);
  const c = [];
  let d;
  const h = (e.lessThan(this.totalNs, t) ? -1 : 1) * Math.sign(e.toNumber(r));
  for (; !e.equal(s, t) && c.length < 50; ) {     // t = ZERO
    s = e.multiply(s, o);                          // o = TEN
    ({ quotient: d, remainder: s } = g(s, i));
    c.push(Math.abs(e.toNumber(d)));
  }
  return h * Number(y(a).toString() + "." + c.join(""));
}
```

The loop has TWO exits and hits neither: `c.length < 50` must become false
after at most 50 pushes whatever the remainder does. So either `c.push(...)`
does not advance the `length` the condition reads (a `const c = []` literal
lowered to a shape whose `.length` read and `.push` go to different carriers —
cf. #1589A's empty-literal host path, and the `numeric-literal array` vs
`vec` split), or the destructuring assignment `({ quotient: d, remainder: s } =
g(s, i))` rebinds `s`/`d` to something `c.push` never sees advance (an
assignment-pattern to OUTER `let` bindings from an object returned across the
JSBI/host seam). Both are compiler defects, neither is Temporal-specific.

**Operational hazard**: a synchronous Wasm loop cannot be interrupted by the
runner's `TEST_TIMEOUT_MS`; the sharded worker kills the fork at 30 s and
recycles it, so the blast radius is the in-flight rows sharing that fork, not
one row. Every row that divides a `TimeDuration` on a receiver whose offset
used to be non-finite is exposed — `hoursInDay`, and plausibly
`round`/`total`/`since`/`until` rows outside #5378's sample. dev-5378
deliberately did NOT add the row to `HANGING_TESTS` (that converts a counted
fail into a skip); this issue is the fix instead.

## Implementation Plan (Fable, 2026-09-07)

**Step 1 — reduce without Temporal.** Two candidates, run as synthetic rows
through `tests/test262-runner.ts` (provider-linked lane AND single-module):

```js
// (a) length-bounded push loop on an empty literal, with the loop body's
//     values coming from a destructuring assignment to outer lets
function f(total, div) {
  let q, r = total % div;
  const c = [];
  for (; r !== 0 && c.length < 50; ) {
    r = r * 10;
    ({ q, r } = { q: Math.floor(r / div), r: r % div });
    c.push(Math.abs(q));
  }
  return c.length + ":" + c.join("");
}
f(7, 3)   // node: "50:3333…"   — the c.length exit must fire
// (b) the same with a BigInt-ish object returned from a linked provider:
//     provider `export function divmod(a, b) { return { quotient: …, remainder: … } }`
```

If (a) already hangs in the single-module lane, it is the `c.length`/`push`
carrier split or the assignment-pattern rebinding — instrument which by
printing `c.length` inside the loop with an iteration cap. If only (b) hangs,
it is the seam: the destructured object comes back through `__extern_get` and
`s` never changes identity (compare `JSBI.equal(s, ZERO)` inputs). State which.

**Step 2 — fix the primitive.** Expected shapes: (i) `const c = []` with only
`push` + `length` reads lowered to a vec whose `length` is read from a stale
struct field — make the read consult the live vec (`src/codegen/` array
lowering; `__array_len` vs struct field); (ii) assignment-pattern to outer
`let` targets from a call result inside a `for(;;)` — the pattern's writes must
target the same locals the loop condition reads (`src/codegen/destructuring*`,
`for` statement lowering). Consumer-only and single-module lanes must stay
byte-identical for the untouched shapes.

**Step 3 — guard the runner regardless.** Independently of the fix, a linked
row that spins must not take its fork's neighbours down: check that
`scripts/test262-worker.mjs`'s 30 s kill + recycle is what actually happens
(one row → `compile_timeout`/`fail`, neighbours unaffected) and record the
measured behaviour in the PR; if neighbours ARE lost, that is a #1957-class
finding for its own issue, not this one.

**Step 4 — tests + measure.** `tests/issue-5380-length-bounded-push-loop.test.ts`
(the reduction, both lanes, with an iteration cap so a regression fails
instead of hanging). Measure `hoursInDay/basic.js` (must terminate and pass or
fail with a reason), `built-ins/Temporal/ZonedDateTime/prototype/{hoursInDay,round,total,since,until}/**`
and the 123-row family, base (PR #5706's branch) vs fix, per row, with a 60 s
per-row deadline, 0 pass→fail. Never the full bucket.

## Acceptance criteria

1. Step 1 answered: which lane reproduces and which primitive.
2. `hoursInDay/basic.js` terminates; the reduction is green in both lanes.
3. Samples measured, 0 pass→fail, counts with artifacts.

## Notes

- Filed from PR #5706's "reported, not fixed". Stacks on #5378 (the hang is
  unreachable before it).
- Id reserved via `claim-issue --allocate --allow-unscanned`; open PRs
  hand-checked 2026-09-07 — highest in-flight issue file is #5379.
