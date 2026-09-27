---
id: 6709
title: "S3-b: `Array.prototype.reduce` / `reduceRight` (and the small non-HOF tail) as callable VALUES on the native regime"
status: done
completed: 2026-09-27
created: 2026-09-27
updated: 2026-09-27
assignee: ttraenkler/opus-6709
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: array-methods
goal: architecture
sprint: current
parent: 5385
depends_on: [6685]
related: [3170, 4394, 6651, 6689]
---

# #6709 — S3-b: the reduce family as a callable value

Slice S3-b of the #5385 "Implementation Plan v2". Nightly 36305955119
(regime lane) still loses **~243 host-passing rows** to

```
TypeError: Array.prototype.reduce is not yet callable as a value in --target standalone
TypeError: Array.prototype.reduceRight is not yet callable as a value in --target standalone
```

(122 + 121), plus a tail of `lastIndexOf` 14, `splice` 13, `indexOf` 13,
`pop` 10, `shift` 7, `toString` 6, `sort` 6, `toSpliced` 6. The host lane
satisfies these through the host `__array_proto_method` import; the regime
and the standalone lane share the refusal, so this lifts BOTH lanes.

## Where the refusal is

`src/codegen/array-object-proto.ts` ≈ L925–L975 (`compileArrayProtoMemberAsValue`
lineage, #4394): higher-order members are routed to the native standalone
loop `__hof_<name>` from `ensureNativeArrayHof` for the reflective
`Array.prototype.<m>.call(arrayLike, cb, thisArg)` form, **except the reduce
family**, explicitly excluded because its native loop takes
`(recv, cb, init, hasInit)` rather than `(recv, cb, thisArg)` and "stays on
the refusal until its own arg marshalling is written" (the comment at
≈ L934). Everything not in `NATIVE_HOF_METHODS` falls to the
`emitThrowTypeError(… not yet callable as a value …)` at ≈ L975.

## Change

1. **Reduce family (the 243).** In the same arm, add the reduce-shaped
   marshal: the closure ABI declares `(this, cb, initialValue?)`; pass
   `recv`, `cb`, `init` (or `ref.null.extern`) and `hasInit = paramCount > 2
   && !isUndefinedSingleton(init)` — mirror how the direct-call lowering of
   `arr.reduce(cb, init)` computes `hasInit` today (find it via
   `NATIVE_HOF_REDUCE` consumers in `src/codegen/array-methods.ts`), so the
   spec's "initialValue present" test (§23.1.3.24 step 5: presence, not
   `undefined`-ness) is identical in both forms. Keep the §23.1.3 step-1
   ToObject receiver guard the HOF arm already emits.
2. **Tail members** (`indexOf`, `lastIndexOf`, `pop`, `shift`, `splice`,
   `toSpliced`, `sort`, `toString`): only where an AST-free
   `compileArray<member>FromVecLocal` core already exists (grep
   `array-methods.ts`); route like `slice` at ≈ L1000. Members without a core
   stay on the refusal — do not write new cores in this slice; list them in
   the PR body with counts so #6651's PR-C owner can pick them up.

## Acceptance

- [x] Repros pass under the regime AND under `--target standalone`:
      `built-ins/Array/prototype/reduce/15.4.4.21-*` and
      `reduceRight/15.4.4.22-*` rows that fail today with the "not yet
      callable" message (scoped run:
      `JS2WASM_EVAL_ENGINE=interpreter TEST262_SEMANTIC_PROVIDERS=native-first TEST262_PATH_FILTER="built-ins/Array/prototype/reduce/|built-ins/Array/prototype/reduceRight/" TEST262_WORKERS=2 pnpm run test:262`,
      and the same with `TEST262_TARGET=standalone`); record before/after.
- [x] Focused test: `Array.prototype.reduce.call(arrayLike, cb)` with and
      without `initialValue`, including `initialValue: undefined` (must count
      as present) and an empty array-like without init (TypeError).
- [x] `tests/issue-4396-target-profile.test.ts` byte-identity green for
      default `gc` (host-assisted output untouched).
- [x] 321-row sample ≥ 227; standalone high-water floor moves up, never down.

## Implementation notes (2026-09-27)

- New `src/codegen/array-reduce-proto-value.ts`: the reduce family's closure
  takes the receiver-aware **variadic** native-proto ABI
  (`(self, this, (ref null $vec_externref))`, as `join`/`push`/`concat` do) on
  the native regime only (`ctx.standalone || ctx.wasi`). The fixed-slot ABI
  cannot express initialValue PRESENCE; the packed vector's length can, so
  `hasInit = argc >= 2` — the same rule as the direct-call lowering
  (`callExpr.arguments.length >= 3` in array-like-hof-arms.ts, `arity >= 2`
  in the #3098 dispatcher). `.length` stays 1 (read from `nativeClosureMeta`).
- The §23.1.3 step-1 receiver guard is factored into
  `emitArrayProtoHofReceiverGuard`, shared with the existing HOF arm (same
  instructions).
- Tail members: only `slice` has an AST-free `compileArray<member>FromVecLocal`
  core, so `indexOf`, `lastIndexOf`, `pop`, `shift`, `splice`, `toSpliced`,
  `sort`, `toString` stay on the refusal (#6651 PR-C).

## Test Results

Scoped test262, `JS2WASM_EVAL_ENGINE=interpreter TEST262_WORKERS=2`,
path filter `reduce/|reduceRight/` (520 rows), base = file-copy revert of
`src/codegen/array-object-proto.ts`:

| lane | base | after | pass→fail | "not yet callable" rows |
| --- | --- | --- | --- | --- |
| `TEST262_SEMANTIC_PROVIDERS=native-first` | 154 | 367 (+213) | 0 | 243 → 0 |
| `TEST262_TARGET=standalone` | 372 | 375 (+3) | 0 | 14 → 0 |
| 321-row sample (native-first) | 227 | 227 | 0 | — |

The 30 regime rows that left the refusal but still fail now fail inside the
shared `__hof_reduce` loop (mostly `testResult !== true` accessor/length-order
rows), the same residual the standalone lane already carries.

Host-assisted default `gc` and `wasi`: binary sha256 identical base vs after on a
probe using `Array.prototype.reduce` as a value; `tests/issue-4396-target-profile.test.ts`
green. Pinned issue tests at `VITEST_FORK_MAX_OLD_SPACE_SIZE=1024` single fork:
19 files / 294 passed.
