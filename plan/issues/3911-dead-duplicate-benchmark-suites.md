---
id: 3911
title: "benchmarks/{dom,arrays,strings,mixed}.ts are dead byte-identical copies of benchmarks/suites/* — about to diverge with the buggy version on top"
status: done
created: 2026-07-31
updated: 2026-08-18
completed: 2026-07-31
priority: medium
feasibility: easy
reasoning_effort: low
task_type: chore
area: testing
language_feature: n/a
goal: performance
sprint: 78
horizon: s
es_edition: n/a
related: [3904, 3902]
---

# #3911 — delete the dead duplicate benchmark suites before they diverge

## Status: open

## Problem

Four files at `benchmarks/` root are **byte-identical** duplicates of the real
suites under `benchmarks/suites/`, and **nothing imports them**. Verified
2026-07-31:

```
benchmarks/dom.ts     vs suites/dom.ts     : IDENTICAL
benchmarks/arrays.ts  vs suites/arrays.ts  : IDENTICAL
benchmarks/strings.ts vs suites/strings.ts : IDENTICAL
benchmarks/mixed.ts   vs suites/mixed.ts   : IDENTICAL
```

`benchmarks/run.ts:13-16` imports only `./suites/*.js`. A grep for imports of
the root copies returns nothing.

## Why this is urgent-ish rather than cosmetic

They are identical **today**, which is exactly why nobody notices them. Two
in-flight changes are about to make them diverge, and in both cases the dead
copy keeps the **broken** version:

- **#3904** fixes `benchmarks/suites/dom.ts` — the DOM host-call lane failed
  for the entire 170-run recorded history because `deps` passed the extern
  classes but never the `document` global. After it lands, `benchmarks/dom.ts`
  still contains the bug.
- **#3902** edits `benchmarks/suites/arrays.ts` — removing `array/find`'s stale
  `skip: ["gc-native"]` and fixing the `sort-i32` comparator mismatch. After it
  lands, `benchmarks/arrays.ts` still has both defects.

So the next person who opens `benchmarks/dom.ts` — a plausible thing to do, it
is at the top level and correctly named — reads code that was fixed weeks
earlier and re-derives a solved problem. That is the same failure mode #3904
was about: a stale artifact that quietly stopped matching reality.

## Scope

1. Confirm nothing imports them (re-run the grep at the time of the fix — do
   not trust this issue's snapshot).
2. Delete all four.
3. Check whether anything outside `benchmarks/` references them by path —
   `scripts/benchmark-lifecycle.mjs`, the workflows, `website/`, or the
   `BENCH_SUITE_FILES` list in `website/public/benchmarks/performance.html`
   (that list points at `benchmarks/suites/*.ts`, so it should be unaffected —
   verify).

## ⚠️ Grep trap — read before deleting

`grep -rn "benchmarks/dom.ts"` returns hits that are **NOT** these files. All
of them point at `examples/benchmarks/dom.ts`, a genuinely separate file in the
**playground** tree (`website/playground/examples/benchmarks/dom.ts`, which
exists alongside `array.ts`, `fib.ts`, `loop.ts`, `string.ts`, `style.ts`).
Verified 2026-07-31:

```
scripts/generate-size-benchmarks.ts:391  path: "examples/benchmarks/dom.ts"
scripts/check-ir-fallbacks.ts:93         "website/playground/examples/benchmarks/dom.ts"
website/playground/main.ts:1987          path: "examples/benchmarks/dom.ts"
website/playground/main.ts:2018          path === "examples/benchmarks/dom.ts" || ...
```

**None of these reference `benchmarks/dom.ts` at the repo root.** A naive grep
makes the root duplicates look referenced when they are not — which either
scares someone off a safe deletion, or leads them to "fix" the playground path
instead, breaking the size-benchmark and IR-fallback tooling.

The check that actually matters is the import graph, not the path string:
`benchmarks/run.ts:13-16` imports only `./suites/*.js`, and nothing imports the
root copies.

## Acceptance criteria

1. The four root-level duplicates are gone.
2. `npx tsx benchmarks/run.ts` still runs all four suites.
3. The performance page still renders its code snippets (it fetches
   `benchmarks/suites/*.ts` and regex-extracts `name:`/`source:` pairs).

## Notes

Found by `issue-3904-dom-lane`, which deliberately left them alone to keep its
diff scoped and avoid touching #3902's file. That was the right call for that
PR and is why this is a separate issue. Best landed **after** #3902 and #3904,
so the deletion does not conflict with either.
