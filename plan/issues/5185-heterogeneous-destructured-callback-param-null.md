---
id: 5185
title: "Destructured callback param on a heterogeneous literal reads null (post-#5204)"
status: ready
sprint: current
assignee:
created: 2026-08-29
updated: 2026-08-29
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 6
language_feature: destructuring
goal: standalone-gap
related: [1058, 4376]
origin: "2026-08-29 — PR #5202 post-merge sweep; first-bad bisected to upstream merge 523bd042 (PR #5204, the #1058 selfhost merge-conflict fix)."
---

# Destructured callback param on a heterogeneous literal reads null

## Problem

Since upstream merge `523bd042` (PR #5204 — "compile TypeScript 5 parser
graph to Wasm", the #1058 self-hosting wave), a destructured callback
parameter over a heterogeneous array-of-object-literals reads `null` for
every element in a standalone build. `origin/main` is red on this — the
regression did not come from the Deno branch; PR #5202's
`tests/issue-4376-deno-primordials-runtime.test.ts` merely carries the first
tests that observe it ("preserves heterogeneous object entries through
callback destructuring", "invokes Object.assign after loading it from an
any-typed bootstrap carrier").

## Repro (deterministic, ~20s)

```ts
let observed = 0;
[
  { name: "TypedArray", original: Reflect.getPrototypeOf(Uint8Array) },
  { name: "ArrayIterator", original: { prototype: Reflect.getPrototypeOf(Array.prototype[Symbol.iterator]()) } },
].forEach(({ name }) => {
  observed += 100;
  if (name === "TypedArray") observed += 1;
});
export function test() { return observed; }
```

Compiled with `compileMulti(..., { target: "standalone", allowJs: true })`:
`test()` answers **200** (callback ran twice, `name` never matched) on
`main`; **201** at `523bd042^` (= `4dfedbdc`). A non-destructured callback
(`(entry) => entry.name === "TypedArray"`) still answers correctly on main —
only the destructured-parameter read path is broken.

## Measured facts (2026-08-29)

- Bisect over `merge-base(#5148 checkpoint, main)..main` (66 first-parent
  commits, probe above): first-bad = `523bd042` (PR #5204). All prior
  commits PASS.
- Characterization probe: with `({ name }) =>`, in the same run
  `typeof name === "string"` is TRUE (statically folded) while
  `name === null` is ALSO TRUE and `name === "TypedArray"` is FALSE for
  BOTH elements — the binding's runtime carrier is `ref.null` while its
  static type stays `string`. The destructure's element read produces null
  for every entry, not just the shape-mismatched one.
- Suspected mechanism (unproven): the two literal shapes lower to distinct
  `$anon` structs; #5204's shape-branding / structural-param machinery
  (`brandCollidingShapeTypes`, `identity-preserving-structural-param.ts`,
  the `member-get`/`property-access` rewrites in that PR) leaves the
  destructure's cast targeting a differently-branded twin, so the
  `ref.test`/cast misses every instance and the read defaults to null.
  During partial-tree bisection the same shape surfaced as the
  "one instruction array is owned by multiple functions" #1058 refusal
  (`fixups.ts`), so shared-array ownership in the per-shape specialization
  is the other candidate.

## Acceptance

- The repro answers 201; both #4376 tests above pass.
- No regression in #5204's own suites (`issue-1058-*`), the equivalence
  destructuring family, or test262 destructuring buckets.
