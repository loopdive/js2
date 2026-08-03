---
id: 4127
title: "npm-compat never RUNS the packages it reports on — a silent wrong answer produces a fully green row, so green carries no correctness information"
status: ready
sprint: current
created: 2026-08-03
updated: 2026-08-03
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

## Acceptance criteria

- [ ] At least the packages that already have behaviour-diffing harnesses
      (cookie, clsx, marked, acorn) report a correctness verdict in
      `npm-compat.json`, derived from a native-node oracle computed at run time.
- [ ] A deliberately miscompiled package (e.g. compiled with the #4123 fix
      reverted behind its kill switch, or an injected fault) turns that verdict
      **red** — the gate is demonstrated to detect a wrong answer, not merely
      added.
- [ ] The npm-compat page distinguishes "compiles + validates" from "produces
      correct output"; a package with the former and not the latter cannot read
      as green.
- [ ] Packages with no drivable workload are counted and named, not silently
      folded into the compatible set.
