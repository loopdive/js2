---
id: 3566
title: "standalone: arr.entries() for-of — pair.length reads NaN (value-rep carrier regression, #1320 guard silently red)"
status: ready
sprint: current
created: 2026-07-24
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: iterator, array-entries, standalone
es_edition: es2015
goal: standalone-gap
related: [1320, 2773, 3008]
origin: "2026-07-24 bounded standalone-test audit (dev-opus / #3565 lane): tests/issue-1320-standalone.test.ts silently red on main — outside required checks (#3008), like #680/#3562/#2047."
---

# #3566 — standalone `arr.entries()` for-of yields NaN `pair.length`

## Problem

`tests/issue-1320-standalone.test.ts` (the Slice-1 standalone iterator bridge)
is **silently red on current main** — not PR-touched, not in the required guard
suite (#3552), so the #3008 gap hid it. **2 of 10 subtests fail**; both drive an
`arr.entries()` iterator through a native for-of and read `pair.length` on each
`[index, value]` pair.

## Measured evidence (current main, `--target standalone` and `--target wasi`)

```ts
export function f(): number {
  const it = [10, 20, 30].entries();
  let n = 0;
  for (const pair of it) {
    n = n + pair.length;
  } // each pair is [i, v], length 2
  return n; // expect 6; GOT NaN
}
```

- "drives a stored arr.entries() through native for-of" → **expected NaN to be 6**.
- "compiles arr.entries() under --target wasi with no host imports" → **expected NaN to be 4**.
- The two SPREAD subtests (`[...it].length`) still pass — so the iterator drive
  itself works; the regression is specifically **`.length` on the yielded pair
  reading NaN** (the pair carrier's length field is not populated / mis-read).

Verified red on clean `origin/main` (not introduced by any in-flight branch).

## Root cause (pointer, not yet fixed)

The yielded `[index, value]` pair's `.length` read returns NaN in standalone —
a **value-rep / carrier substrate** issue (the entries()-pair array carrier).
This sits in the Fable-gated value-rep substrate program (#2773); it is **not**
a contained fix and is out of scope for the guard-audit lane. Filed for tracking
so it is no longer invisible.

## Guard status

`tests/issue-1320-standalone.test.ts` already exists and detects this
post-merge (issue-tests.yml) but is NOT enforced. It **cannot** be folded into
the required guard suite (#3552) while red — a red entry blocks every PR. Fold
it once the substrate fix greens it.
