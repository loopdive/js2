# ES5-standalone campaign — standing agent brief

Shared protocol for every agent working a `goal: standalone-gap` ES5 bucket
issue (#4479–#4485 and successors). The issue file gives the WHAT; this brief
gives the HOW. Read both before the first edit.

## Single-test driver

Write verbatim to `.tmp/run-one.mts`, run
`npx tsx .tmp/run-one.mts <rel-path-under-test262/test/>`:

```ts
import { join } from "node:path";
import { runTest262File } from "../tests/test262-runner.js";
const ROOT = join(process.cwd(), "test262", "test");
const rel = process.argv[2];
const cat = rel.split("/").slice(0, -1).join("/");
const r = await runTest262File(join(ROOT, rel), cat, 15000, "standalone");
console.log(JSON.stringify(r, null, 2));
```

- Standalone lane: 4th arg `"standalone"` (as above).
- Host/gc lane: **OMIT the 4th argument entirely.** Passing `"gc"` is wrong —
  it corrupts compile options and disables `deferTopLevelInit` (burned an
  agent on 2026-08-15; see #4456's merge-group record).

Direct compile probes: `compile(src, {target:"standalone", allowJs:true,
skipSemanticDiagnostics:true, deferTopLevelInit:true, hostBridge:"always"})`
from `src/index.js`; `emitWat:true` to read WAT. All probes live in `.tmp/`.

## Methodology (non-negotiable — distilled from this campaign's audit chain)

1. **Re-verify the issue's failure list live before touching anything.** The
   baseline lags main; the issue's row counts are a map, not a measurement.
2. **Capture `.tmp/base-<file>.ts` revert copies at the FIRST edit** of every
   source file (`git show HEAD:src/... > .tmp/base-...`). Every before/after
   delta you report must come from runs YOU executed. A figure inherited from
   an artifact and restated as a measurement is the campaign's most-repeated
   documented defect.
3. **One probe per compiled module where identity matters** (in-process
   pollution confound, #3673). Isolate and re-run anomalous batch results.
4. **Absent-not-wrong.** A new arm that cannot be certain about a dynamic
   receiver must DECLINE (fall through), never answer wrongly. A wrong answer
   in a fold is worse than no fold.
5. **Eval-tier awareness.** CI's changed-root `quality` lane runs
   `JS2WASM_EVAL_ENGINE=interpreter` with the REFUSAL provider: modules that
   CALL `eval`/`Function(...)` at runtime throw there by design. Any vitest
   pin whose module mints from a body string needs a tier arm — see
   `tests/issue-4442.test.ts` / `tests/issue-4464.test.ts` for the pattern.
   Build the provider locally with
   `node scripts/build-runtime-eval-provider.mjs --refusal-only` and run the
   pin under `JS2WASM_EVAL_ENGINE=interpreter` before calling it done.

## Environment trap: fresh worktrees have NO .test262-cache (#4484 finding)

A fresh agent worktree lacks `.test262-cache/`, so eval-dependent rows fail
as "quickjs provider is not built" on BOTH sides of an A/B — a silently
under-measured sweep (21 rows misread in one measured case). Before any
sweep: copy the main checkout's `.test262-cache/` artifacts in, or build the
provider (`npx tsx scripts/build-quickjs-eval-provider.mjs`, falling back to
`node scripts/build-runtime-eval-provider.mjs --refusal-only` +
`JS2WASM_EVAL_ENGINE=interpreter`), and confirm a known eval-dependent row
runs before trusting the numbers.

## Verification floor (every issue, before `status: done`)

- Scoped standalone sweep over the issue's directory before AND after, from
  your own runs; per-file flip list; **zero regressions**.
- The issue's named pin suites green (`npm test -- <files>`); skip-and-say-so
  if a pin file doesn't exist on your base.
- New `tests/issue-<id>.test.ts` pinning each fixed family + `it.fails` pins
  for measured residuals.
- **`tests/equivalence/` CANNOT run in one vitest invocation** in these
  containers (OOMs; chunks >6 files OOM too). Per-file loops only, scoped to
  files your diff plausibly touches.
- Record `## Root cause`, `## Fix`, `## Test Results` (with which runs YOU
  executed), `## Residuals` with owners, in the issue file. `status: done` +
  `completed:` only when the acceptance bar is met and verified.

## Commit rules (worktree branch, do NOT push, do NOT open PRs)

- Author `Thomas Tränkler <git@thomas.traenkler.com>`:
  `git -c user.name="Thomas Tränkler" -c user.email=git@thomas.traenkler.com commit ...`
- Message `fix(#<id>): <summary> ✓` — the ✓ token is required by the hooks.
- Commit-gate failures (LOC/func budget, coercion-sites, dead-export,
  oracle-ratchet): grant a frontmatter allowance in the issue file with
  per-file rationale (see the 44xx issues for the pattern). Use `ctx.oracle`,
  never raw `ctx.checker`.
- The session lead merges your worktree branch, verifies pins independently,
  and ships. Your final report: per-family root cause, fix, before/after
  numbers from your runs, flip list, pin results, commit sha, branch name.

## Reference implementations from this campaign (read before inventing)

- Reflective String dispatch: `src/codegen/string-proto-concat.ts` (#4426),
  `string-proto-match-search.ts` (#4439), `array-object-proto.ts` arms.
- `__current_this` save/install/restore discipline: #4429 record +
  `src/codegen/type-coercion.ts` `emitWithCurrentThis`.
- Identity-stable builtin carriers: `src/codegen/function-intrinsic-carrier.ts`
  (#4442) — the module-level provider-linked vs provider-free dispatch.
- Per-function metadata (`.length`/`.name`): `function-instance-meta*.ts`
  (#4437), `function-instance-props.ts`.
- Construct/return semantics: `src/codegen/construct-return-value.ts` (#4464).
- Nominal-brand guards (`ref.test` on branded structs, never structural):
  `function-instance-meta-arms.ts` family-arm comments.
