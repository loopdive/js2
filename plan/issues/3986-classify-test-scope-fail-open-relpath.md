---
id: 3986
title: "test262 runner: classifyTestScope fails OPEN — a missing filePath silently disables all three path-based skip rules, unskipping ~1170 proposal/annexB tests"
status: ready
created: 2026-08-01
updated: 2026-08-01
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bug
area: testing
language_feature: n/a
goal: n/a
sprint: current
horizon: s
es_edition: n/a
related: [3963, 1390]
---

# #3986 — `classifyTestScope` fails open when `filePath` is absent

## Status: open — not currently firing; filed as a latent fail-open

## Problem

`tests/test262-runner.ts:222` decides a test's scope — and therefore whether it
is skipped — almost entirely from the file path:

```ts
export function classifyTestScope(source: string, meta: Test262Meta, filePath?: string): Test262ScopeInfo {
  const relPath = getTest262RelativePath(filePath) ?? "";   // ← fail-open
  const strict = classifyStrictMode(meta, relPath);

  if (relPath.startsWith("test/staging/") || relPath.startsWith("staging/")) → proposal
  if (relPath.startsWith("test/annexB/")  || relPath.startsWith("annexB/"))  → annex_b
  if (relPath.includes("built-ins/Temporal/"))                               → proposal
  // …then meta.features
}
```

`filePath` is **optional**, and when it is absent `relPath` becomes `""`. Every
one of those three checks then returns false, so:

- staging proposals are no longer classified as proposals,
- annexB tests are no longer classified as `annex_b`,
- Temporal tests are no longer classified as proposals,

and all of them fall through to be **compiled and run** rather than skipped.
`classifyStrictMode(meta, "")` is likewise deprived of its path input.

The failure is silent and inverted: losing the path makes the runner do *more*
work and report *worse* results, with no error anywhere.

## Blast radius, measured

This is not hypothetical arithmetic — a `merge_group` run during #3963 produced
exactly the shape this fail-open would produce, from a different cause:

```
pass           31086 → 31035    -51
compile_error    652 →  1829  +1177
skip            1278 →   108  -1170
```

`skip` −1170 and `compile_error` +1177 as mirror images, with the transition
list wall-to-wall `Temporal/…: skip → compile_error` and `annexB/…` entries.
So the *observable signature* of this fail-open is a ~1170-test swing that
reads as a catastrophic conformance regression and **auto-parks the PR**
(#2547), costing a human-grade diagnosis cycle.

## It is NOT currently firing — and that is the point

Both production call sites pass a `filePath` they have already dereferenced:

- `tests/test262-shared.ts:617-619` — `readFileSync(filePath)` then
  `classifyTestScope(source, meta, filePath)`
- `tests/test262-vitest.test.ts:504-506` — same order

so `filePath` cannot be undefined without `readFileSync` having thrown first.
The #3963 investigation initially blamed this fail-open and was **wrong**; the
real cause there was the Node major moving under the baseline.

That near-miss is the argument for fixing it. The hypothesis was credible
precisely because the code permits it, and ruling it out took reading both call
sites. A gate that *could* fail open costs diagnosis time even on runs where it
doesn't.

## Two distinct defects

1. **`?? ""` converts "unknown" into "definitely not a proposal".** Absent
   information is being treated as a negative answer rather than as an error.
2. **`getTest262RelativePath` is also lossy without being absent.** It is
   `filePath.replace(/.*test262\//, "")` — if the checkout directory is not
   named `test262/`, the replace is a no-op and returns the **full absolute
   path**. Then `startsWith("test/staging/")` and `startsWith("test/annexB/")`
   both fail while `includes("built-ins/Temporal/")` still matches, so the
   classifier degrades *partially* — arguably worse than failing outright,
   because the result looks plausible.

## Suggested fix

Make `filePath` required and fail loud, rather than defaulting:

```ts
export function classifyTestScope(source: string, meta: Test262Meta, filePath: string): Test262ScopeInfo {
  const relPath = getTest262RelativePath(filePath);
  if (relPath === undefined || relPath === filePath) {
    throw new Error(`classifyTestScope: cannot derive a test262-relative path from ${filePath}`);
  }
  …
}
```

`relPath === filePath` catches defect 2 — the replace matched nothing. Both call
sites already have a valid path, so making the parameter required is a
type-level change with no runtime cost at either. `tests/test262-scope-classification.test.ts`
already passes absolute `/tmp/test262/...` paths, so it exercises the happy path.

If a throw is judged too aggressive for a runner that processes ~47k files,
the fallback should at minimum **count and report** the degradation, so a
mass-unskip shows up as a runner diagnostic rather than as a conformance cliff.

## Acceptance criteria

1. A missing or non-`test262/` `filePath` no longer yields a silently
   permissive classification.
2. Whichever behaviour is chosen (throw or counted degradation), it is
   observable in the run output — the current failure produces no signal at all.
3. A test pins the degraded case: classification with a path that does not
   contain `test262/` must not report `standard`/non-proposal for a Temporal or
   annexB file.
4. The existing scope-classification tests still pass.

## Provenance

Found while diagnosing the #3963 auto-park. Filed separately because it is a
real latent defect that was *not* the cause of that park — recording it as
"the thing I wrongly blamed, which is nonetheless broken" rather than folding
it into an unrelated fix.
