---
id: 6479
title: "Multi-file compile: timer-shim and cjs-rewrite prepasses cost 9 s on a 1,244-file graph — measure per-file cost and cache by content hash"
status: done
created: 2026-09-14
updated: 2026-09-14
completed: 2026-09-14
priority: medium
horizon: m
feasibility: easy
reasoning_effort: medium
task_type: perf
area: compiler, multi-file
goal: npm-library-support
sprint: current
es_edition: n/a
related: [3946, 3687, 3672, 4157]
# 2026-09-14 (#6479): +16 lines in the god-file `src/import-resolver.ts` — the
# textual pre-filter in `injectTimerShimOnly` is 1 line of code plus the
# derivation comment proving the gate is exact (it enumerates why `used` and
# `queueUsed` cannot be non-empty without one of the gated tokens, and why
# `setImmediate` is deliberately excluded). A false negative here silently
# drops the timer shim, so the proof lives next to the regex rather than in a
# separate doc. Moving the 2-line mechanism to a new module would cost more
# indirection than the lines it saves.
loc-budget-allow:
  - src/import-resolver.ts
---

# #6479 — multi-file prepass cost on large graphs

## Observed (2026-09-10, `JS2WASM_COMPILE_PROFILE=1`, self-compile via `benchmarks/suites/mixed.ts` → `../harness.js` → `src/index.js`, 1,244 input files)

| phase | self | share |
| --- | --- | --- |
| `timer-shim` | 5.8 s | 53 % |
| `cjs-rewrite` | 3.2 s | 29 % |
| `analyze` | 2.0 s | 18 % |

Both prepasses are per-file source rewrites that run before the checker
sees the graph, and their cost is paid again on every compile of the same
graph. (The run itself then died in TypeScript's JSX parser with a stack
overflow on one of the compiler's own `.tsx` sources — a separate finding,
reproduce with the same command.)

## Measured per file (2026-09-14, `.tmp/prepass-cost.mts` over the 1,381 `src/**/*.ts` sources, 34.3 MB)

| pass | total | cost | shape |
| --- | --- | --- | --- |
| `rewriteCjsRequire` (`src/cjs-rewrite.ts`) | 1.9 s | 0.13–0.15 ms/KB on large files, 0.016 ms/KB on small | linear; a full `ts.createSourceFile` per file |
| `injectTimerShimOnly` (`src/import-resolver.ts`) | 4.9 s | 0.13–0.18 ms/KB at every size | linear; a full `ts.createSourceFile` per file |

So each multi-file compile parses every source **three** times before codegen
(cjs pass, timer pass, checker) and neither pass has a cheap bail-out:

- only **13 of 1,381** files contain a timer identifier
  (`setTimeout|setInterval|clearTimeout|clearInterval|queueMicrotask|setImmediate`);
- only **98 of 1,381** contain `require(` / `module.exports` / `exports.`.

A textual pre-filter therefore skips ~99 % of the timer-shim work and ~93 % of
the CJS work on this graph: ≈ 6.5 s of the 6.8 s, with no cache at all.

## Implementation Plan

1. **`src/cjs-rewrite.ts`** — at the top of `rewriteCjsRequire` /
   `rewriteCjsRequireWithMap`: if `!/\brequire\s*\(|\bmodule\.exports\b|\bexports\s*\./.test(source)`
   return the source unchanged (identity position map for the `WithMap`
   variant). The regex must be a superset of every shape the AST pass
   rewrites — read the visitor first and list the shapes in a comment above
   the regex; a false positive costs one parse, a false negative silently
   skips a rewrite, so bias wide.
2. **`src/import-resolver.ts`** — same at the top of `injectTimerShimOnly`
   with `/\b(setTimeout|setInterval|clearTimeout|clearInterval|queueMicrotask|setImmediate)\b/`;
   verify against the timer-call scan's identifier list in that function
   (it must cover everything the scan matches, including
   `globalThis.setTimeout` / `window.setTimeout` member forms).
3. **Tests** — `tests/issue-6479-prepass-prefilter.test.ts`: for a corpus of
   ~20 real files from `src/` plus hand-written positives (each rewrite shape,
   including the member forms and a string containing the token), assert the
   output of the pre-filtered function is byte-identical to the unfiltered
   original (keep the original body callable via an internal
   `{ prefilter: false }` option or by exporting the inner function for the
   test).
4. **Measure** the self-compile graph
   (`JS2WASM_COMPILE_PROFILE=1 node --import tsx src/cli.ts benchmarks/suites/mixed.ts -o .tmp/out`)
   before/after; record the two phase lines in this file. The run currently
   dies later in TypeScript's JSX parser on one of the compiler's own `.tsx`
   sources — that is a separate finding; the phase lines print before it.
5. Content-hash caching (the original step 3) is deferred: with the
   pre-filter the remaining cost is the 13 + 98 files that genuinely need
   the pass.

## Measured after (2026-09-14, pre-filter implemented)

`JS2WASM_COMPILE_PROFILE=1 node --import tsx src/cli.ts benchmarks/suites/mixed.ts -o .tmp/out`,
same box, same 1,331-file graph, A/B by file copy (`.tmp/base-*.ts`):

| phase | before | after | delta |
| --- | --- | --- | --- |
| `timer-shim` | 6.89 s | **2.05 s** | −70 % |
| `cjs-rewrite` | 3.92 s | **3.46 s** | −12 % |
| `analyze` | 2.09 s | 1.54 s | (unchanged code; run-to-run) |
| total compile | 12.90 s | **7.05 s** | −45 % |

Per-file microbenchmark (`.tmp/prepass-cost.mts`, 1,381 `src/**/*.ts`, 34.3 MB):

| pass | before | after |
| --- | --- | --- |
| `rewriteCjsRequireWithMap` | 2,492 ms | 1,885–1,920 ms (steady-state, `.tmp/cjs-only.mts`, base 2,234–2,238 ms) |
| `injectTimerShimOnly` | 6,208 ms | **428 ms** |

### Why the first acceptance box is NOT met, and why a pre-filter cannot meet it

The plan's premise — "only 98 of 1,381 files contain the CJS tokens, so ~93 %
of the work is skipped" — counts **files**, not **bytes**, and both passes cost
time proportional to bytes. On this graph the matching files are the big ones:

- 112 of 1,428 `src/**/*.ts` files match the CJS pattern, but they are
  **11.2 MB of 36.1 MB (31 % of the bytes)**. Most of the large hits are
  `exports.` occurring inside strings/comments of the compiler's own codegen
  files (e.g. the import path `"./vec-access-exports.js"` in
  `src/codegen/array-methods.ts`), which no textual filter can distinguish
  from real code.
- The dominant residual in the *graph* run is a single file:
  `node_modules/typescript/lib/typescript.js`, 9.1 MB, which genuinely
  contains `require(`, `module.exports` **and** `setTimeout`. Measured alone:
  **2,699 ms cjs + 1,622 ms timer** — i.e. 78 % of the remaining `cjs-rewrite`
  time and 79 % of the remaining `timer-shim` time is that one vendor bundle.

So the deferred step 5 (content-hash caching) is **not** obsolete after all: it
is now the only remaining lever, together with the option of not running the
prepasses over `node_modules` bundles at all. Filed as follow-up work.

## Acceptance

- [ ] Both prepass phases on the self-compile graph ≤ 0.5 s each — **not met
      and not reachable by a pre-filter**: `timer-shim` 6.89 s → 2.05 s,
      `cjs-rewrite` 3.92 s → 3.46 s, with ~79 % of both residuals being one
      9.1 MB vendor bundle that genuinely contains every gated token. See the
      section above.
- [x] Byte-identical output for every file in the test corpus, positives
      included — `tests/issue-6479-prepass-prefilter.test.ts` (62 assertions:
      every rewrite shape, the `globalThis`/`window` member forms, tokens
      inside strings and comments, and 24 sampled real `src/` files) compares
      the pre-filtered output against `{ prefilter: false }`.
- [x] `tests/multi-file.test.ts` and `tests/issue-1279.test.ts` unchanged
      (109 tests green), `node scripts/equivalence-gate.mjs` green.

## Original sketch (superseded by the plan above)

1. Instrument the two prepasses with `profilePhase` per file and report the
   top-20 files by cost; establish whether cost is linear in bytes or
   superlinear (the #3433 pattern).
2. Skip the rewrite for files whose source contains no candidate token
   (`setTimeout`/`setInterval`/`queueMicrotask`/… for the timer shim;
   `require(`/`module.exports`/`exports.` for the CJS rewrite) — a cheap
   textual pre-filter like `referencesTemporal` in `src/temporal-provider.ts`.
3. Cache rewrite results by content hash in the existing `packageCacheDir`
   so an unchanged file is never rewritten twice across compiles.

## Acceptance

- Self-compile graph above: prepass time ≤ 25 % of today's on a warm cache,
  and ≤ 50 % cold via the pre-filter alone.
- Output binary byte-identical with and without the cache.
