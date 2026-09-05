---
id: 5336
title: "Pre-merge floor on compile.validated — invalid Wasm must fail the PR that emits it"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infra
area: testing
goal: correctness
assignee: ttraenkler/claude
---

## Problem

#5333 (`82be803ac7`, PR #5390) made every moment dogfood module compile to a binary
that **no engine will load**:

```
CompileError: Compiling function #721:"__closure_47" failed:
  call[25] expected type (ref null 84), found struct.get of type i32
```

moment went 10/10 → 0/10 upstream tests, `compile.validated` 6/6 → **0/6**, and it
**survived five merges with all six required checks green**. It was found days later,
by hand, only because somebody re-ran a package suite.

The blind spot is precise and small:

- `tests/dogfood/moment-upstream-suite.test.ts` runs its heavy arm only behind
  `DOGFOOD_MOMENT_UPSTREAM_SUITE=1`, and even then asserted **nothing** about
  `compile.validated` — only the native oracle and the scored/passed bookkeeping,
  both of which stay internally consistent when Wasm produces nothing at all.
- No `scripts/check-*` read the field. Only `tests/dogfood/upstream-suite-runner.mjs`
  and `tests/dogfood/typescript-upstream-suite.mjs` even mentioned it.
- `benchmarks/results/npm-compat.json` **did** record it correctly the whole time
  (`validation.validates: false`, with the exact error). It is refreshed post-merge
  and gates nothing, so the fact was published and unread.

## What landed

`scripts/check-dogfood-validation.mjs`, wired as a step inside the already-required
`quality` job (`pnpm run check:dogfood-validation`).

For six pinned npm-compat packages it compiles the tarball's declared **entry module
only** — no test execution, no upstream repo clone — and asserts one thing:

> `compile.success` ⇒ the emitted binary passes `WebAssembly.compile`.

All machinery is reused. `runNpmCompatCatalogHarness`
(`tests/dogfood/npm-compat-catalog-harness.mjs`) already compiles a pinned entry via
`tests/helpers/compile-project-probe.ts` in a child process with a hard timeout and
returns `{compile:{success,…}, validation:{validates, firstError}}`. The gate spawns
that harness per package with bounded concurrency and applies the implication. Because
it calls the same harness npm-compat calls, its verdict cannot diverge from the
dashboard's.

`tests/dogfood/moment-upstream-suite.test.ts`'s heavy arm now also asserts
`compile.validated === compile.succeeded` and lists any offending module — the
specific assertion whose absence let the regression through that file.

## Why an invariant and not a baseline

`compile.succeeded == compile.validated` is not a target, it is a theorem: a module
that codegens but that no engine will load is **always** a compiler bug. Pass counts
move daily for legitimate reasons; this does not. No baseline file, no golden number,
nothing to refresh.

**Asserting `compile.success` itself was considered and rejected on measurement.**
Sampling all 80 revisions of `benchmarks/results/npm-compat.json` on `main` between
2026-08-29 and 2026-09-05:

| package           | compile-status flips | validate-status flips | revisions with `success && !validates` |
| ----------------- | -------------------- | --------------------- | -------------------------------------- |
| moment            | 2                    | 3                     | **10**                                 |
| lit               | 0                    | 0                     | **80**                                 |
| prettier          | 1                    | 0                     | 2                                      |
| hono              | 2                    | 2                     | 0                                      |
| styled-components | 2                    | 2                     | 0                                      |
| lodash-es         | 3                    | 3                     | 0                                      |
| react/jest/redux  | 0                    | 0                     | 0                                      |

The flips are not independent: **one** refresh revision (`b8fecd5d19`, 2026-08-29
03:18Z) flipped hono, styled-components, moment, lodash-es and prettier to
`success: false` simultaneously and back — a measurement outage, not five compiler
regressions. A compile-success assertion would have failed five packages on noise.
The implication above is *vacuously true* during exactly that outage, so it cannot.

The same table is the case for the gate: the invariant was violated on `main` for
moment in 10 of 80 revisions — **two distinct windows totalling ~3.5 days of one
week** (2026-09-02 19:57Z → 09-05 10:12Z, then again from 09-05 11:18Z, right after
#5390 merged at 11:06Z) — with zero false positives among the gated packages.

## Package set

The gated set is not hand-picked: it is **every npm-compat catalog package that both
compiles and validates today**. Re-derive it with
`pnpm run survey:dogfood-validation`, which runs the whole catalog and prints which
packages qualify.

| package           | entry compile | why it is in |
| ----------------- | ------------- | ------------ |
| redux             | ~5 s          | small ESM project |
| react             | ~4 s          | CJS project, classic UMD prologue |
| jest              | ~4 s          | ESM re-export surface |
| hono              | ~10 s         | ESM project, heavy generic inference |
| styled-components | ~12 s         | ESM bundle, large closure graph |
| **moment**        | ~15 s         | **the only catalog package that reproduces #5333** |

Excluded, deliberately:

- **lit** — compiles but does not validate, and has in all 80 sampled revisions
  (`local.set[0] in "y_createRenderRoot"`, tracked by #3977). Excluded rather than
  waived so the gate stays a clean invariant; fixing it means moving it into `GATED`.
- The eleven catalog packages that do not compile at all (uuid, typescript, lodash,
  lodash-es, react-dom, tailwindcss, axios, jsdom, webpack, stylelint, three). The
  implication is vacuous for them, so they would cost wall clock and buy nothing.

`moment` is load-bearing. On the reverted tree, redux/react/jest/hono/
styled-components **all still validated** — they are breadth against future
regressions, not coverage of this one. A gate without moment would not have caught
#5333.

## Vacuity floor

If **no** gated package produces a binary, the implication holds the way "all
unicorns are pink" does. The gate fails in that case with an explicit message, in the
same spirit as `scripts/check-harness-compile-budget.ts`'s `VACUITY_FLOOR`. A blown
compile budget (120 s harness budget vs ≤15 s observed — 8× headroom) also fails.

## What this does NOT catch

**#5332** — `multi-prepared-module-init-census:terminal-join`, which took prettier
61/151 → 2/151 — is a hard **codegen error**, not a validation failure. It shows up as
`compile.success: false`, which makes this implication vacuous, so **this gate misses
it and deliberately does not try to cover it.**

What would catch it is a per-package **compile-status baseline** over the same
harness — roughly ten more lines on top of this script. It is not shipped here because
the flip table above says such a baseline is noisy: it would have produced five false
failures in one week from a single measurement outage, and a gate that cries wolf gets
disabled. If it is wanted, it needs a debounce (e.g. two consecutive revisions) that
this effort did not measure.

Residual hole in the meantime: if **moment's own compile** regresses to a hard error,
the gate goes vacuous *for the detector* and passes. The per-package compile status is
printed on every run (`no-build` in the table) so it is at least visible in the log.

## Proof

Both runs on this branch, `upstream/main` @ `eb97d2e817` (i.e. #5620 already merged),
concurrency 4, 8-core box. The A/B is a single-file swap of
`src/codegen/statements/nested-declarations.ts` between its post-#5620 content and
`upstream/main`'s pre-#5620 content — the diff is exactly #5333's fix hunk, nothing
else.

**Fails on the regressed codegen** (exit 1):

```
  ok       redux                   5.1s  72,512 bytes
  ok       react                   3.8s  1,760 bytes
  ok       jest                    4.3s  15,240 bytes
  ok       hono                   10.4s  472,527 bytes
  ok       styled-components      11.8s  567,443 bytes
  INVALID  moment                   15s  WebAssembly.Module(): Compiling function #561:"__closure_45" failed: …
[dogfood-validation] 19509ms wall
::error::[dogfood-validation] moment@2.30.1 (package/moment.js) compiled 559,367 bytes that do NOT
validate: WebAssembly.Module(): Compiling function #561:"__closure_45" failed: call[25] expected
type (ref null 46), found struct.get of type i32 @+310643
```

**Passes on current main** (exit 0):

```
  ok       moment                 15.3s  559,158 bytes
[dogfood-validation] 19851ms wall
[dogfood-validation] ok — 6/6 gated packages compiled, 6/6 validated.
```

(The reproduced error names `#561:"__closure_45"` rather than the originally reported
`#721:"__closure_47"` — same defect, different function numbering because main has
advanced since #5390.)

## Cost

**19.9 s wall** locally at concurrency 4, bounded by moment's ~15 s compile; 51 s if
run serially. Against a `quality` job that took **9 m 44 s** on PR #5620, that is ~3 %.
The measured per-package compile times on GitHub's `ubuntu-latest` (from
`npm-compat.json`) sum to ~59 s, so expect roughly 30–60 s there at the default
concurrency of `min(4, cores − 1)`.

## Required-check proposal

The gate is a **step inside `quality`**, which is already one of the six required
contexts — so it gates from the moment this merges, with **no ruleset change**. That
was the deliberate choice over a new top-level job: a new job would need
`docs/ci-policy.md` §7 and the branch ruleset amended, which is a project-lead
decision, not a workflow edit.

Recommendation: **keep it required, as a `quality` step.** ~20 s against a ~10 min job
is cheap for the class of bug it catches (`main` shipping unloadable Wasm, undetected,
for days). If it later proves to be on the critical path, promoting it to its own
parallel required context is the follow-up — and that goes through §8.

## Files

- `scripts/check-dogfood-validation.mjs` — the gate
- `package.json` — `check:dogfood-validation`, `survey:dogfood-validation`
- `.github/workflows/ci.yml` — step in `quality`
- `tests/dogfood/moment-upstream-suite.test.ts` — heavy arm now asserts validation
- `docs/ci-policy.md` §7 — records that `quality` carries this floor
