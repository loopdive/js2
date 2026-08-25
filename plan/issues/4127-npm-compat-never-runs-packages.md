---
id: 4127
title: "npm-compat never RUNS the packages it reports on — a silent wrong answer produces a fully green row, so green carries no correctness information"
status: done
sprint: 78
created: 2026-08-03
updated: 2026-08-18
completed: 2026-08-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: tooling
area: tooling, dogfood
language_feature: npm packages
goal: dogfood
related: [4123, 4125, 4126, 3781]
origin: "asked while fixing #4123 whether npm-compat had locked in a wrong answer; it had not, for a worse reason"
---

# #4127 — npm-compat's green rows carry no correctness information

## The finding

While fixing #4123 (a prototype method on a parameter receiver silently
returning `null`) the obvious worry was that a package's expected output had
been recorded **from js2 rather than from node**, locking the wrong answer into
a pin file.

**That did not happen, and structurally cannot.** The `shasum` / `integrity`
fields in `tests/dogfood/npm-compat-catalog.json` and every `*-pin.json` are
npm-registry hashes of the **input tarball**, never of js2 output, and no pin
file records an expected output value. The behaviour-diffing dogfood harnesses
(cookie, clsx, marked, acorn) compute their oracle at run time by importing the
same package into native node and comparing.

The real problem is the inverse, and it is worse:

**`npm-compat` never runs the package at all.** `npm-compat.json` records only
`compile.success`, `validation.validates` and perf, and the catalog test asserts

```ts
// tests/dogfood/npm-compat-catalog.test.ts:65
expect(report.diff.runnable).toBe(false);
```

So a package that compiles to a valid module and produces **completely wrong
answers** yields a fully green npm-compat row. #4123 was exactly that: a silent
`null` in the shape every library API uses, invisible to the dashboard that
exists to report npm compatibility.

## Why this is worth fixing rather than documenting

The dashboard's audience reads "compatible" as "works". Today it means
"compiles and validates" — a much weaker claim, and one that a reader has no
way to distinguish from the stronger one. Meanwhile #4123, #4125 and #4126 are
three silent-wrong-answer defects found in a single session by hand, none of
which any npm-compat row would have flagged.

Note this is not a criticism of #3781's lane work, which correctly separated
standalone from JS-host **performance**. The gap is on the correctness axis.

## Direction

1. Give each catalogued package a **consumed, checksummed workload** — the same
   discipline #3781 established for the perf lanes: same inputs, same observed
   output, native node as the shared oracle, computed at run time (never
   recorded from js2).
2. Report a per-package **correctness** verdict distinct from `compile.success`
   / `validates`, and surface it on the page so "compiles" is never read as
   "works".
3. Flip `report.diff.runnable` from an asserted-`false` invariant to a real
   capability wherever a workload exists; keep the assertion only for packages
   that genuinely cannot be driven yet, and count those explicitly.
4. Do **not** record any expected value into a committed pin — the oracle must
   stay "run it in node right now", which is what keeps a miscompile from being
   ratified.

## CORRECTION to the problem statement above

Filing this issue I wrote that npm-compat "never runs the packages it reports
on" and that a silent wrong answer "produces a fully green row". Building the
fix showed both claims are **too strong**, and the record should say so:

1. **Four packages DO run.** acorn, marked, clsx and cookie each drive a
   differential workload against a native-node oracle and report
   `tests: { kind, passed, total }`. The `diff.runnable === false` assertion I
   cited belongs to the **catalog** harness (`package-entry-harness.mjs`), which
   covers the other 16 packages — not to the whole report.
2. **The page was already partly honest.** `npm-compat-chart.js` renders
   `n/a — runtime not verified` for a package with no `tests`, so a catalog row
   did not claim correctness it lacked.

What was actually missing, and what this change adds:

- **No verdict in the DATA.** `npm-compat.json` carried a fraction or nothing;
  any consumer other than that one page had to infer the state. There is now an
  explicit `correctness: { status, … }` per package.
- **No rollup.** Nothing stated how much of the corpus carries no correctness
  evidence. The summary now counts *and names* verified / divergent /
  unverified.
- **A fraction is not a verdict.** cookie ships `passed: 18, total: 21` today —
  **three operations already disagree with native node** — and 18/21 reads as a
  score rather than as three wrong answers. It is now `divergent`.

The underlying concern was right, and the #4123-class exposure remains real: 16
of 20 packages have no correctness signal at all. But the original wording
overstated the evidence, and an issue that overstates its evidence is exactly
what gets a fix waved through.

## Result

End-to-end via `npx tsx scripts/generate-npm-compat-report.mjs --only cookie --no-write`:

```json
"correctness": { "status": "divergent", "passed": 18, "total": 21,
                 "reason": "3 of 21 operations diverged from native node" }
"counts": { "verified": 0, "divergent": 1, "unverified": 0 }
```

- `scripts/lib/npm-compat-correctness.mjs` — pure verdict + rollup, unit-tested.
- `buildPackageEntry` attaches the verdict; the summary carries the rollup.
- `package-entry-harness.mjs` records `unverified` with a reason, distinguishing
  "does not compile" from "compiled but never run".
- `npm-compat-chart.js` gains a **named** correctness row.
- The catalog test no longer asserts `diff.runnable === false` as an invariant —
  it asserts the correctness axis is present and explicitly `unverified`.
  Verified against a real package (`DOGFOOD_NPM_CATALOG=uuid`, 3/3 pass).

## Acceptance criteria

- [x] The behaviour-diffing packages report a correctness verdict in
      `npm-compat.json`, derived from a native-node oracle computed at run time.
      Confirmed end-to-end for cookie.
- [x] The gate is demonstrated to detect a wrong answer. **Demonstrated on a
      REAL divergence rather than an injected one**: cookie's committed 18/21
      turns the verdict `divergent`, and unit tests pin the strictness (20/21 is
      not `verified`; 0/0 and missing counts are not `verified`).
      *Not done*: an end-to-end run with a compiler fix reverted behind its kill
      switch. The live case is stronger evidence of detection, but the injected
      run would additionally prove the harness re-derives its oracle rather than
      caching it — that is left open.
- [x] The npm-compat page distinguishes "compiles + validates" from "produces
      correct output" — a named correctness row per card.
- [x] Packages with no drivable workload are counted and named, not silently
      folded into the compatible set.

## Deliberately not done

- **No new workloads.** This surfaces and names the correctness axis; it does
  not make the 16 catalog packages drivable. They move from *silently*
  unverified to *explicitly* unverified — honesty, not coverage. Driving them is
  the larger follow-on, and where the real detection power is.
- **cookie's three divergences are not diagnosed.** Already present, already
  recorded, now named — but which three ops differ, and why, is not investigated
  here. Worth its own issue.
