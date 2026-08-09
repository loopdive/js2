---
id: 3946
title: "Compile-phase profiling — JS2WASM_PROFILE_COMPILE=1 emits per-phase elapsed + RSS"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: medium
feasibility: easy
reasoning_effort: low
task_type: feature
area: compiler, observability
goal: npm-library-support
sprint: current
horizon: s
es_edition: n/a
related: [1400, 3339, 3672, 3687]
---

# #3946 — per-phase compile profiling

## What you will see (the observable)

A large `compileProject` graph takes **615.9 s** and you have no idea which
phase spent it. Or it dies of heap exhaustion and you cannot say whether the
checker, codegen, or binary emit was holding the memory. The only number
available today is whole-compile elapsed, measured *outside* the compiler by
`tests/helpers/eslint-graph-probe.ts`.

Both of those are real: the 615.9 s is #3687's measured ESLint Tier-1 compile,
and the heap exhaustion is #3672.

## Gap on `main` (verified @ `e4187572`)

`grep -rn "JS2WASM_PROFILE_COMPILE\|recordCompileProfile\|__JS2_COMPILE_PROFILE__" src/ tests/ scripts/`
returns nothing. `tests/helpers/eslint-graph-probe.ts` and
`tests/helpers/compile-project-probe.ts` measure `elapsedMs` for the whole child
process only. There is no phase attribution anywhere.

## The slice (from the closed PR #3687)

Branch `codex/1400-eslint-e2e` @ `561c933af16651e49f50556b8128967892ce529e`
carries this complete and self-contained:

- **`src/compile-profile.ts`** (66 lines, new). `compileProfileEnabled()` reads
  `process.env.JS2WASM_PROFILE_COMPILE === "1"`; `recordCompileProfile(phase,
  startedAt, details)` writes one JSON line to **stderr** prefixed with
  `__JS2_COMPILE_PROFILE__`, carrying `elapsedMs` plus `rssBytes`,
  `heapUsedBytes`, `heapTotalBytes`, `externalBytes`, `arrayBuffersBytes` and
  Node's `maxRSS` high-water mark. Guarded by `try/catch` — *"diagnostics must
  never make compilation fail"* — and by a `globalThis.process` probe so it is
  inert in a browser.
- **`src/compiler.ts` wiring** at eight phase boundaries: `multi.preprocess`,
  `multi.checker`, `multi.pipeline`, `multi.optimize`, `multi.total`,
  `pipeline.codegen`, `pipeline.binary`, `pipeline.wat`, `pipeline.artifacts`.
  Each records on the failure path too (`success: false`), which is the case
  that matters when a graph dies mid-compile. Phase details carry useful
  denominators: `checkerFiles` vs `codegenFiles`, `functions`/`globals`/`types`,
  `binaryBytes`.

The `multi.checker` phase is the one worth having first: it reports
`checkerFiles` **and** `codegenFiles` separately, which is exactly the number
#3932 (checker-only roots emitted into the binary) needs to demonstrate its fix.

Purely additive and opt-in. No dependency on the parked #3798 identity cluster.

## Acceptance criteria

1. `JS2WASM_PROFILE_COMPILE=1` on a named multi-file fixture emits **one
   parseable `__JS2_COMPILE_PROFILE__<json>` line per phase**, each with a
   numeric `elapsedMs`. Assert the phase *names* present, not just that output
   appeared — a single line with the wrong name would otherwise pass.
2. **Unset ⇒ silent and free**: zero `__JS2_COMPILE_PROFILE__` lines on stderr,
   and the emitted binary is **byte-identical** to a run without the flag.
   Assert the byte equality; "no output" alone does not prove the instrument is
   inert.
3. **Failure path covered**: a fixture that fails codegen still emits
   `pipeline.codegen` with `success: false`. This is the case the feature exists
   for, so it cannot be the untested one.
4. A thrown error inside `recordCompileProfile` does not fail the compile
   (the `try/catch` is load-bearing — verify it, do not assume it).
5. Browser/no-`process` environments: `compileProfileEnabled()` returns `false`
   rather than throwing.
