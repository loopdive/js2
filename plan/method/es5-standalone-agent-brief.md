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

7. **Cross-lane claims need a third arm (2026-08-23, #4637/#4639).** With
   sibling lanes branching from one tip, your two-arm A/B (tip vs your
   branch) answers "did I change this" and is STRUCTURALLY SILENT on "did
   the other lane fix or break it". One measured case: a defect was
   pre-existing on the tip AND fixed by the sibling's change — one lane's
   tip-vs-own A/B read "unaffected", the other's branch-only read
   "introduced by them"; both were measured correctly and both concluded
   wrongly. Rules that fall out:
   - A claim about ANOTHER lane's effect requires an arm containing their
     change — measured by whoever owns it and cited as theirs, or measured
     by the lead on the combined tree. Never infer it from your own pair.
   - **Verify every pin fails on the arm it claims to test** (revert for
     your own change; DELETE the named interaction for a cross-lane pin —
     a revert proves sensitivity to *your* change only). A canary nobody
     has seen fail is an assertion about the code, not a test of it.
   - Write pins UNFOLDABLE where a compile-time fold could bypass the
     path under test (loop-carried index beats a syntactic literal).
   - The merge check confirms the run says **N passed** — never that it
     exited 0 (`describe.skipIf` gates can skip an entire suite green).

## Environment trap: fresh worktrees have NO .test262-cache (#4484 finding)

A fresh agent worktree lacks `.test262-cache/`, so eval-dependent rows fail
as "quickjs provider is not built" on BOTH sides of an A/B — a silently
under-measured sweep (21 rows misread in one measured case). Before any
sweep: copy the main checkout's `.test262-cache/` artifacts in, or build the
provider (`npx tsx scripts/build-quickjs-eval-provider.mjs`, falling back to
`node scripts/build-runtime-eval-provider.mjs --refusal-only` +
`JS2WASM_EVAL_ENGINE=interpreter`), and confirm a known eval-dependent row
runs before trusting the numbers.

## Environment trap: the worktree `test262/` symlink farm + the GITLINK hazard

The isolation layer rebuilds a fresh worktree's `test262/` as a symlink farm
pointing at SIBLING worktrees (whose chains can dead-end in an empty dir),
and it does so repeatedly — measured ~every 2s / at the start of every Bash
call. `ls` works intermittently while `node` gets ENOENT, so sweeps fail
silently. Fixes, in order of robustness: re-point the link to
`/home/user/js2wasm/test262` **in-process immediately before each read** and
retry on ENOENT (fighting it from the shell is futile); at minimum verify a
LEAF test file resolves (`readlink -f`) before trusting any sweep. Also:
`test262/test/test` is a self-referential symlink — use lstat, skip symlinks
in every recursive walk.

**The gitlink hazard that rides along (2026-08-23, hit independently by two
lanes):** `test262` is a git SUBMODULE gitlink. Replacing the directory with
a symlink flips the gitlink to a symlink in the index — it shows as `T` in
`git status` and silently rides into any `git commit -a`, breaking every
other checkout. If you repoint `test262`, (1) never use `commit -a` (the
brief already requires staging specific files), (2) check `git status --
test262` before every commit, and (3) before finishing, verify with
`git diff <base>..HEAD --stat -- test262` that NO commit touched it, and
restore the plain directory/gitlink state.

## Engine trap: a CONCRETE-ref `try_table` block type traps on entry (#4620)

A `try_table` whose **block type is a concrete ref** (`(ref null <typeidx>)` /
`(ref <typeidx>)` — the two-byte `0x63`/`0x64 <typeidx>` form) traps with
`RuntimeError: unreachable` **when the instruction is entered**, before its
protected body runs and with nothing thrown. Measured 2026-08-22 on Node
v22.22.2 / V8 12.4.254.21 in a **hand-built module with no compiler involved**;
the same module with an `i32` or `externref` block type runs correctly.
Abstract single-byte ref types (`externref`, `funcref`) are fine — only the
two-byte concrete form is affected.

Why it hides: the ordinary `try`/`catch` lowering emits an **empty** try_table
block type and `return`s out of the protected body, so it never produces this
shape. Only hand-built scaffolds do — `named-this-call.ts`'s receiver-install
trampoline did, which made every `foo.call(x)` on a named function that reads
`this` and returns a **string or object** trap (`language/function-code/
10.4.3-1-{1,2,4,5}-s`, the primitive-`this` boxing family). Scalar-returning
targets were fine, which is why it stayed invisible.

**The pattern to use instead:** give the `try_table` an EMPTY block type and
park the value in a local INSIDE the protected body
(`…call…; local.set $result`), then read the local after the scaffold. See
`ensureNamedThisCallTrampoline` (#4620) for the worked example, and keep scalar
block types as they are so their bytes do not move.

**How to recognise it:** a trap whose innermost frame is the function
CONTAINING the try_table, at an offset that decodes to the try_table's own
bytes, with the protected callee provably never entered (set a global in the
callee's first statement and read it after the trap). Binary-patching the
`try_table` bytes to a plain `block` + `nop`s is a cheap confirmation.

Other emitters that pass a non-empty block type to `buildStandardTryTable` /
`buildTargetTaggedTry` are suspect; grep for them before assuming a lane is
clean (`src/ir/backend/wasmgc-emitter.ts` passes a variable block type).

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
