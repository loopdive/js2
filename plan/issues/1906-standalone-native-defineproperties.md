---
id: 1906
title: "standalone: native Object.defineProperties over $Object descriptors"
status: done
done_cited_ok: true # #3474 exempt: native defineProperties + refuse-rest; refusals are the expected cites
sprint: 61
created: 2026-06-07
updated: 2026-06-11
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: objects, property-descriptors
goal: standalone-mode
parent: 1472
related: [1472, 1629, 1631, 1888]
test262_bucket: object-property-semantics
test262_count: 748
claimed_by: codex-developer
claimed_at: 2026-06-07T10:51:59.654Z
pr: 1264
completed: 2026-06-08
---
# #1906 — Standalone native `Object.defineProperties`

## Problem

The shared object/property semantics bucket still samples:

```text
Codegen error: '__defineProperties' ... not yet supported in --target standalone
```

Single-property descriptor paths have native standalone coverage for important
data/accessor slices, but the plural `Object.defineProperties` helper is still
caught by the broad dynamic object/property refusal.

## Scope

- Implement a standalone-native `__defineProperties` path for `$Object`.
- Iterate the descriptor map using the existing object-runtime enumeration
  helpers.
- Reuse native single-property helpers for data and accessor descriptors rather
  than introducing a second descriptor representation.
- Keep unsupported descriptor shapes fail-loud with this issue cited.

## Acceptance Criteria

- `Object.defineProperties(o, { a: { value: 1 }, b: { get() { ... } } })`
  compiles and runs under `target: "standalone"` for open `$Object` values.
- The helper performs gather/validate before apply where the current descriptor
  runtime supports it, or refuses before partial mutation for unsupported
  shapes.
- No `env::__defineProperties` import is emitted under standalone.
- Existing `Object.defineProperty` data/accessor tests remain green.

## Implementation Notes

- Added a standalone-native `__defineProperties` helper in the open-object
  runtime and routed it through `OBJECT_RUNTIME_HELPER_NAMES` so standalone does
  not refuse or import `env::__defineProperties`.
- The helper enumerates `$Object` descriptor maps with `__obj_ordered`, gathers
  and validates supported `$Object` descriptor records first, then applies them
  through the existing native `__defineProperty_value` and
  `__defineProperty_accessor` helpers.
- Focused tests in `tests/issue-1906.test.ts` use computed keys to force the
  `$Object` runtime path, covering data descriptors, accessor descriptors, and
  pre-apply refusal for unsupported primitive/conflicting descriptors.

## Validation

- `pnpm test tests/issue-1906.test.ts`
- `pnpm test tests/issue-1629-S6.test.ts tests/issue-1629-S3.test.ts tests/issue-1629-S2.test.ts`
- `pnpm exec tsc --noEmit --incremental false`

Revalidated by `codex-developer` on branch `symphony/1906` after fetching
`origin` and confirming the branch is based on current `origin/main`
`28c668ab4`. Checks above pass locally on 2026-06-07T12:55:59+02:00 in this
worktree. The focused #1906 suite, the existing #1629 defineProperty suites,
and `tsc --noEmit` all passed.

PR #1264 is open, ready for review, and targets `main`:
`https://github.com/loopdive/js2/pull/1264`. Before this validation refresh is
published, GraphQL reports remote head `376140c2b`, `mergeQueueEntry=null`,
`autoMergeRequest=null`, and `mergeStateStatus=BLOCKED` because the required
`Test262 Sharded / merge shard reports` check is failed from the stale-baseline
guard: the `js2wasm-baselines` JSONL baseline main SHA
`ff02d201152dc8777d3e8151ed05dddd47d75ecf` was 202 commits behind
`origin/main`, exceeding the max 50 commit threshold. The standalone guard
itself reported `improvements=24`, `wasm-change regressions=0`, `net=24`. This
is an infrastructure blocker tracked by #1668, not a scoped #1906 implementation
or local validation failure.

## Harvest note — residual (2026-07-13, /harvest-errors)

Standalone baseline run `20260713-085257` (gitHash `bb27494f`) still shows
**79 records** emitting the exact string
`TypeError: Object.defineProperties unsupported descriptor shape in standalone
mode (#1906)`, plus ~180 more failing with `Property description must be an
object` in the same standalone `Object.defineProperties` path. #1906 landed the
common-case native path, but a residual descriptor-shape family (accessor
descriptors / mixed data+accessor / non-object entries) is still refused in
`--target standalone`. Not a full regression of the landed work, but the fix is
incomplete for these shapes — consider a scoped follow-up if the 79-record
bucket is worth clearing (goal: host-independence, umbrella #1781).
