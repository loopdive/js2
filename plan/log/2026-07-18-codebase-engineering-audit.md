# 2026-07-18 — Codebase engineering audit

**Repository:** `loopdive/js2` (local remote still named `loopdive/js2wasm`)

**Audited tree:** `origin/main` at `852c40a9f5167a2a959d53faa066cb0753b623cc`

**Artifact scope:** audit and implementation-plan issues only; no implementation
source was changed.

## Executive summary

The highest-risk newly verified defect is a reachable silent miscompile: a real
host function passed through an `any` parameter is not called when the module has
zero registered closure candidates. The generated export returns `null` instead
of the function's result. The next reliability defect is in the test262 oracle
pipeline: the current baseline JSONL contains 25 duplicate file keys, including
three contradictory fail/pass pairs. Different consumers resolve those pairs
differently.

Two process ratchets also have holes. The god-file profiler is already red on
clean `main` and is not invoked by CI; that finding is already owned by in-flight
#3400 in PR #3331, so this audit deliberately does not create a competing issue.
The canonical-looking `pnpm run new:issue-id` command still invokes the
deprecated non-reserving predictor even though the repository mandates the
atomic allocator.

Publication preflight exposed two additional hook defects. The private-`labs/`
guard does not recognize this checkout's legacy `loopdive/js2wasm` origin even
though GitHub redirects it to the public repository. Separately, the format
watchdog assumes GNU `timeout`, so a stock macOS push is falsely reported as a
Prettier failure. No private content was staged or disclosed during this audit.

| Rank | Severity | Finding                                                                          | Confidence                                                        | Canonical plan             |
| ---- | -------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------- |
| 1    | Critical | Zero-candidate dynamic calls silently return `null` instead of invoking/throwing | Verified defect                                                   | #3406                      |
| 2    | Critical | Private-`labs/` guard skips the legacy public `js2wasm` origin URL               | Verified safeguard bypass; no disclosure observed                 | #3410                      |
| 3    | High     | test262 JSONL has duplicate and contradictory file verdicts; consumers disagree  | Verified defect                                                   | #3407                      |
| 4    | High     | God-file regression check is unwired and already fails on clean `main`           | Verified process gap                                              | In-flight #3400 (PR #3331) |
| 5    | High     | `new:issue-id` points at a deprecated, non-atomic predictor                      | Verified workflow defect                                          | #3408                      |
| 6    | High     | Pre-push format watchdog assumes GNU `timeout` and blocks stock macOS            | Verified workflow defect                                          | #3409                      |
| 7    | Medium   | #1132 says publication has not happened, but npm and JSR are live at 0.60.1      | Verified stale plan                                               | #1132 updated here         |
| 8    | Medium   | Selector and emitters retain explicitly non-reentrant module state               | Architecture hypothesis; current synchronous core limits exposure | No new issue               |
| 9    | Medium   | Two regression tests accept compile failure by returning early                   | Verified test weakness, bounded                                   | No new issue               |

## Baseline and method

- Read repository agent guidance, compiler/test262 memories, prior audits, issue
  schema, and report conventions before inspection.
- Audited compiler call dispatch, IR selection and emit state, test262 result
  production/merge/diff/report paths, release configuration, CI quality gates,
  issue allocation, and representative regression tests.
- Fetched the current test262 JSONL through the established baseline helper. The
  fetched file contained 48,113 rows and 48,088 distinct `file` keys. The
  committed summary is oracle v7 and reports 32,321/43,106 official passes
  (75.0%), 10,440 fails, 243 compile errors, 83 compile timeouts, and 19 skips
  (`benchmarks/results/test262-current.json:2-20`).
- Measured 42,995 official rows with compile timing: p50 131 ms, p90 337 ms,
  p95 460 ms, p99 1,522 ms, max 10,000 ms, 86 over 5 s, and 8,310,596 ms
  aggregate (~2.31 CPU-hours). This is a material cost surface, but it is already
  guarded by #1942 (`.github/workflows/test262-sharded.yml:866-919`), so no
  duplicate performance issue was filed.
- Ran issue integrity/spec coverage, LOC, stack-balance, and god-file checks on
  clean `main`. The first four completed cleanly; `check:godfiles` failed as
  described in F3.

## F1 — zero-candidate dynamic host calls silently miscompile

**Severity:** Critical · **Status:** Verified defect
**Plan:** #3406

### Evidence

For an `any`/externref identifier callee, `tryEmitInlineDynamicCall` builds its
dispatch from closure types registered in `ctx.closureInfoByTypeIdx`. If there
are no closure candidates and no standalone special carrier, it returns `null`
before building the host-call fallback
(`src/codegen/expressions/calls.ts:3504-3536,3618`). The caller then evaluates
and drops only the arguments, pushes `ref.null.extern`, and treats that as the
call result (`src/codegen/expressions/call-identifier.ts:1651-1666`).

A temporary end-to-end audit probe (removed after execution) compiled:

```ts
export function test(f: any): any {
  return f(2);
}
```

The module compiled and validated. Calling the export with `(x) => x + 1`
produced:

```text
AUDIT_DYNAMIC_CALL_OUTPUT {"output":null,"type":"object"}
```

Expected output was `3`. This is not merely an unsupported-program diagnostic:
the compiler reports success and emits valid Wasm with the observable call
deleted.

#3335 added a host `__call_function` default arm when a dynamic dispatch chain
exists, but the zero-candidate early return bypasses that arm. This explains why
the adjacent bug can be marked fixed while the simplest no-candidate shape still
miscompiles.

### Impact

- A real function supplied by an embedder through `any` is silently not invoked.
- Argument side effects run, making the output look plausible while callee side
  effects and return values disappear.
- A non-callable value also takes the same synthesized-`null` path instead of the required catchable
  `TypeError`, erasing control flow such as `try/catch`.
- Candidate registration is an incidental whole-module property, so adding an
  unrelated closure can change the lowering selected for the same call site.

### Required direction

Host mode must route a non-null raw callee through the existing
`__call_function` bridge even when the closure candidate set is empty. Host-free
targets must either support a known native callable carrier or refuse/throw
loudly; returning a synthesized nullish value is not an acceptable fallback. See #3406 for the
stack-balance, late-import, and validation plan.

## F2 — duplicate test262 verdict keys survive into promoted JSONL

**Severity:** High · **Status:** Verified defect · **Plan:** #3407
**Related:** #1221, #2913

### Evidence

The fetched current JSONL has **48,113 rows for 48,088 files**: 25 duplicate
rows. All duplicates are fixture/module paths. Twenty-two duplicate pairs are
fail/fail with different diagnostics. Three are contradictory fail/pass pairs:

- `test/language/module-code/top-level-await/module-import-rejection-body.js`
- `test/language/module-code/top-level-await/module-import-rejection-tick.js`
- `test/language/module-code/top-level-await/module-import-rejection.js`

The concrete producer is the fixture execution catch. A non-pass
`recordResult(...)` throws `ConformanceError`; the inner execution catch at
`tests/test262-shared.ts:779-831` catches that sentinel and records a second
verdict. The outer catch contains the intended rethrow guard, but it is one catch
too late (`tests/test262-shared.ts:833-841`). The 22 fail/fail pairs have exactly
this fingerprint: the first diagnostic plus a second
`ConformanceError: [fail] ...` diagnostic. Runtime-negative tests can record
fail and then pass through the same control-flow mistake.

Defensive consumers are inconsistent:

- The report builder uses deterministic worst-status precedence and reports
  dropped duplicates (`scripts/build-test262-report.mjs:902-960`).
- `diff-test262` silently uses last-write-wins (`scripts/diff-test262.ts:519-533`).
- The workflow concatenates shard JSONLs and checks only that the result is
  non-empty; it does not enforce unique keys
  (`.github/workflows/test262-sharded.yml:622-644`).

Thus the published summary can treat a file as failing while the regression
diff treats the same baseline file as passing. Row order, rather than compiler
behavior, can decide whether a future candidate is classified as a regression.

### Why #2913 is not sufficient

#2913 correctly made report and edition totals deterministic, and its own
resolution explicitly left the duplicate-write source for a scoped follow-up.
It did not make the canonical JSONL unique or align the diff loader with the
report policy. #3407 owns that residual rather than reopening or duplicating the
completed defensive-report work.

## F3 — the god-file ratchet is unwired and red

**Severity:** High · **Status:** Verified process/maintainability gap
**Plan ownership:** in-flight #3400 in PR #3331; no duplicate issue created

`package.json:99-100` exposes `check:godfiles`, and the profiler says
`--check` is a CI gate that rejects new mega-functions or growth beyond a
40-line margin (`scripts/profile-godfiles.mjs:23-31,51-56,120-149`). The quality
workflow invokes file LOC, dead-export, stack-balance, fallback, boxing, and
coercion ratchets, but never invokes the god-file check
(`.github/workflows/ci.yml:103-227`).

On clean `origin/main`, `pnpm run check:godfiles` fails with three regressions:

```text
GREW 438→610 LOC (+172): src/codegen/expressions/calls.ts#tryEmitInlineDynamicCall
GREW 216→285 LOC (+69): src/codegen/object-runtime.ts#fillExternArrayLikeStructArms
NEW mega-function (161 LOC): src/codegen/array-methods.ts#tryCompileArrayFlatNativeDepth1
```

The baseline confirms the older 438/216 values
(`scripts/godfile-profile-baseline.json:3,25`). Simply wiring the existing
absolute-baseline command now would make every PR red and can wedge merge groups
on unrelated main drift. Open PR #3331 already files #3400 to implement a
change-scoped per-function ceiling ratchet, which is the correct ownership and
merge-queue-safe direction. This report records the current failure as evidence
for that plan and deliberately does not modify the other agent's open work.

## F4 — canonical issue-ID shortcut bypasses atomic allocation

**Severity:** High · **Status:** Verified workflow defect
**Plan:** #3408

The repository requires `claim-issue.mjs --allocate` because optimistic IDs can
collide only in `merge_group` and wedge the queue. CI documents that requirement
at `.github/workflows/ci.yml:229-239`, and `next-issue-id.mjs` itself says it is
deprecated, predicts without reserving, and does not scan open PRs
(`scripts/next-issue-id.mjs:12-24`).

Despite that, the shortest and most discoverable package script still maps
`new:issue-id` to the unsafe predictor (`package.json:78-81`); the safe command
is the longer `new:issue-id:allocate` at `package.json:157-160`. The merged-tree
collision checker also tells users to repair a collision using the deprecated
script (`scripts/check-merged-issue-integrity.mjs:160-166`). Stale agent context
repeats the old guidance.

This is not cosmetic documentation drift: it directs users from the failure
message back into the race that caused the failure. #3408 preserves an honestly
named preview command while making the canonical creation path atomic.

## F5 — publication plan #1132 contradicts shipped reality

**Severity:** Medium
**Status:** Verified stale plan; canonical issue updated in this audit

#1132 remained `ready` and said the compiler had no npm presence
(`plan/issues/1132-publish-compiler-as-loopdive-js2.md:1-20`). Current repository
evidence has a complete tag-driven release workflow: it builds, packs, and
publishes `@loopdive/js2` with provenance
(`.github/workflows/publish-npm.yml:90-108`), publishes the unscoped proxy
(`:110-145`), and publishes JSR independently (`:147-183`). Public registry
metadata checked on 2026-07-18 reports all three at 0.60.1:

- npm `@loopdive/js2`: first published 2026-06-27, latest 0.60.1.
- npm `js2wasm` proxy: latest 0.60.1.
- JSR `@loopdive/js2`: latest 0.60.1.

The old acceptance text also specified CJS and `<5 MB` unpacked. The shipped
package is explicitly ESM-only (`package.json:23-50`) and npm reports 8,904,177
bytes unpacked, partly because `examples/` is intentionally shipped
(`package.json:52-57`, #2828). Those are superseded product decisions, not
evidence that publication is still pending. #1132 is marked done with a
reconciliation note while retaining the original plan as history.

## F6 — explicitly non-reentrant compiler internals

**Severity:** Medium
**Status:** Architecture hypothesis, not a reproduced public-API defect

The IR selector stores per-run resolver, declaration, scope, and return-shape
state in module variables (`src/ir/select.ts:789-838,1248-1257`) and explicitly
states that `planIrCompilation` is not reentrant (`:831-838`). The WAT emitter
does the same for resolved layout and likewise documents non-reentrancy
(`src/emit/wat.ts:15-22,120-124`). Binary emission uses module globals too, but
at least clears them in `finally` (`src/emit/binary.ts:296-307`).

Today the main compilation core is deliberately synchronous; only optional
post-codegen Binaryen optimization awaits (`src/compiler.ts:1084-1109`). That
substantially limits ordinary `Promise.all(compile(...))` overlap, so this audit
does **not** claim a verified concurrent-compile bug. The architecture still
creates a trap for callback-driven re-entry, direct consumers of exported
selector/emitter APIs, and any future asynchronous or parallel codegen pass.
Before adding such concurrency, state should become invocation-local and an
overlapping/reentrant compile test should extend #923's sequential idempotency
coverage.

## F7 — bounded false-green regression tests

**Severity:** Medium
**Status:** Verified test weakness; not broad enough for a separate high-value issue

- The full Axios regression case catches any `compileProject` exception and
  returns, then also returns on an unsuccessful result
  (`tests/issue-1693.test.ts:47-61`). Dependency resolution failure, OOM, or a
  compiler crash can therefore make the test green without validating Wasm.
- The class-method destructuring equivalence case explicitly skips on compile
  failure (`tests/equivalence/binding-null-guard.test.ts:97-121`).

Most superficially similar `if (!result.success) return` sites are safe because
they immediately follow `expect(result.success).toBe(true)`; these two do not.
They should be tightened when their canonical implementation areas are next
touched. A repository-wide lint is not justified by the two-case residual.

## F8 — pre-push formatting watchdog is not portable to macOS

**Severity:** High · **Status:** Verified workflow defect · **Plan:** #3409

The pre-push format stage unconditionally executes
`timeout 90 pnpm run format:check` and treats every nonzero result other than
124 as a real formatting defect (`.husky/pre-push:151-170`). On this Darwin
host, neither `timeout` nor `gtimeout` exists. A publication push therefore
passed typecheck and lint, then failed with an empty `Offending files` section.
Direct `pnpm run format:check` and direct Markdown Prettier checks both passed.

The captured `command not found` diagnostic is suppressed by a filter that only
prints Prettier warnings or `.ts` paths. This leaves `--no-verify` as the only
obvious workaround, which disables all other hook checks too. #3409 specifies a
portable timed-command helper and a host/exit-code test matrix.

## F9 — private-labs guard skips the repository's normal public origin

**Severity:** Critical · **Status:** Verified safeguard bypass; no disclosure observed · **Plan:** #3410

The same hook intends to block every `labs/` path sent to the public repository,
but it considers only URLs matching `loopdive/js2` public
(`.husky/pre-push:20-58`). This checkout's normal origin is still
`https://github.com/loopdive/js2wasm.git`. GitHub redirects that legacy name to
the canonical public repository, while the local shell pattern falls into
`is_public=0`; the forbidden-path scan never runs. Public fork URLs are also
unrecognized.

The bypass is verified from the exact remote URL and hook branch condition. No
actual `labs/` file was staged, read for the probe, or pushed, and the audit
found no evidence of a disclosure. The impact is nevertheless critical because
the control's sole purpose is preventing private material from entering public
history. #3410 requires canonical/legacy/fork URL coverage and a fail-safe,
explicit private-destination policy.

## Existing coverage deliberately not duplicated

- The current official conformance residual (10,785 non-passes) remains the
  dominant correctness backlog, but its large clusters are already represented
  by the July 12 audit issues (#3184–#3189) and subsequent slices. This audit did
  not create another conformance umbrella.
- Compile-time regression signals are already enforced by #1942.
- File-level god-file growth is already guarded by #3102; the missing
  function-level enforcement is owned by in-flight #3400.
- Report/edition duplicate counting was fixed by #2913; #3407 is limited to the
  still-broken producer, canonical JSONL invariant, and cross-consumer policy.

## Recommended execution order

1. #3410 — restore the private-path safety boundary for the actual public origin.
2. #3406 — stop the verified silent call deletion and lock it with an E2E test.
3. #3407 — restore one-verdict-per-file and make baseline consumers agree.
4. #3409 — make normal macOS pushes run the intended gates without requiring
   `--no-verify`.
5. Land/review in-flight #3400 — establish a merge-queue-safe function-size
   ratchet, then triage the three current overages rather than rebasing them
   silently.
6. #3408 — remove the unsafe issue-ID creation affordance before the next
   collision incident.
