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

   **One snapshot per touched file, and check `git diff --stat` before each
   arm (2026-08-23, dev-4491).** Restoring only ONE snapshot when your change
   spans two files silently measures a HYBRID tree — half your change, half
   the base — and nothing in the run announces it. The cheap detector is
   `git diff --stat` immediately before each arm: if it names a different
   number of files than your change touches, you have a partial restore. That
   count mismatch is the only reason the one measured instance was caught.

   **Branch-update merges use a PLAIN `git merge <ref>` — never `--ff-only`.**
   `pre-merge.sh` treats `--ff-only` as the legacy merge-TO-main path and
   refuses it without a fresh test-proof artifact, so a lane pulling the
   campaign tip into its own feature branch gets blocked and may be tempted to
   `--no-verify` past a gate doing its job. The documented protocol is a plain
   merge anyway (CLAUDE.md: "Dev merges `origin/main` INTO their branch —
   `git merge origin/main` (not rebase)"). Use the right form; do not bypass.
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
   - **A pin that asserts a shape is not a pin that exercises the shape.**
     Both wave-3 lanes wrote one while actively hunting this class: one
     asserted identity relations and sat one property READ away from an
     uncatchable trap, reporting green; the other read the property and
     was `it.fails`-green *because* the read trapped. Neither assertion
     was wrong; neither pin could fail for the reason it existed. Every
     pin must execute the operation whose behavior it guards.
   - A sibling's change alters not only what is CORRECT but what is
     REACHABLE: the wave-3 trap needed one lane's classification widening
     plus a shape only the other lane's domain produced, and no sweep
     either lane could run would have compiled the combination. Cross-lane
     hazards are only visible on the combined tree — the lead's merge
     verification must include running each lane's suite there.
   - The merge check confirms the run says **N passed** — never that it
     exited 0 (`describe.skipIf` gates can skip an entire suite green).

8. **A residual is a CLAIM, and `it.fails` protects it from ever being
   tested (2026-08-23, dev-4653 self-correction).** This is the cheapest
   place in the method for a wrong statement to survive indefinitely, and
   it was found the only way it can be — by accident, when a sibling
   lane's message forced a re-open of a row already written up, swept
   green, pinned, and committed.

   The failure shape: a lane attributes a residual to a root it inferred
   rather than probed, then pins it `it.fails`. The pin **passes**,
   because the row does fail — just not for the stated reason. The sweep
   is green, the suite is green, and the wrong root is now documented as
   a measurement for the next lane to build on. Nothing in the workflow
   ever re-examines it. Measured instance: "the minted function does not
   bind its declared parameters" survived a full lane and its pins, while
   `new Function("p","return p;")(7)` answers `7` — one probe, never run,
   and the attribution was backwards (the defect is `++` on a
   mint-LOCAL name, only inside an enclosing function; see #4662).

   Rules that fall out:
   - **Probe the NEGATIVE case before attributing a residual.** State the
     one observation that would refute your root, run it, and record the
     result. An attribution you did not try to falsify is a hypothesis,
     so label it one — `suspected root`, not `root`.
   - **Every `it.fails` pin carries POSITIVE CONTROLS that must pass**,
     chosen so the suite claims the specific root rather than the general
     area. dev-4653's corrected pins are the worked example: two
     `it.fails` on "`++` on a mint-local name" plus controls asserting
     that parameter binding works and that outer-`++` works. Without the
     controls, a future fix that widens the wrong thing repairs the pin
     and reads as green.
   - Residual attributions are what the NEXT lane starts from, so a wrong
     one costs more than a missing one. "Root unknown, here is what I
     ruled out" is a better handover than a confident wrong root.

## Environment trap: fresh worktrees have NO .test262-cache (#4484 finding)

A fresh agent worktree lacks `.test262-cache/`, so eval-dependent rows fail
as "quickjs provider is not built" on BOTH sides of an A/B — a silently
under-measured sweep (21 rows misread in one measured case). Before any
sweep: copy the main checkout's `.test262-cache/` artifacts in, or build the
provider (`npx tsx scripts/build-quickjs-eval-provider.mjs`, falling back to
`node scripts/build-runtime-eval-provider.mjs --refusal-only` +
`JS2WASM_EVAL_ENGINE=interpreter`), and confirm a known eval-dependent row
runs before trusting the numbers.

## Environment trap: a suite that runs ZERO tests and exits 0 (2026-08-23, dev-4491)

`tests/issue-4504-inherited-set.test.ts` spins its **own `CompilerPool`**, whose
worker imports the GITIGNORED `scripts/runtime-bundle.mjs` and
`scripts/compiler-bundle.mjs`. A fresh worktree has NEITHER, so the worker dies
(`[pool] worker failed before ready (exit 1)`), vitest reports **`36 skipped`**,
and the process **exits 0**. Every lane that ran it in a fresh worktree read a
green that measured nothing.

This is the concrete instance of the brief's "N passed, never exit 0" rule:
`skipped` is not `passed`. Read the counts. When a suite spins its own pool,
build BOTH bundles from **the arm you are measuring**
(`pnpm run build:compiler-bundle`), or its verdict is about your bundle, not
your branch. Built correctly this suite is 1 failed / 35 passed, and that one
failure is pre-existing on the campaign base.

## Environment trap: CONTENTION fakes both failures and regressions (2026-08-23, dev-4491 + lead)

With several lanes sweeping at once, load on this box runs 12–16 and a compile
that normally takes ~9 s can take **47–123 s**, so `runTest262File`'s timeout
fires and the row reports `compile_error: compilation timeout`. Measured the
same day in both directions: three of dev-4491's 2,279 sweep rows moved for
infrastructure reasons alone — one of them (`15.2.3.6-4-298-1`, an ENOENT from
the symlink-farm race) **would have read as a regression** — and two lead-run
pins (`issue-4641`, `issue-4643`) failed on timeout under 5-lane load and passed
**25/25** when re-run serially minutes later.

**Standing practice: re-run every apparent flip AND every apparent regression
serially before it goes in a report.** A timeout is not a verdict about your
change. Note also that `runTest262File`'s `timeoutMs` is a POST-HOC check — it
measures elapsed time after `await compile(...)` returns and cannot interrupt a
slow compile, so a 600 s compile runs the full 600 s and only then reports a
timeout; bounding it needs an OS-level `timeout` on the driver process.

## Environment trap: STALE `scripts/compiler-bundle.mjs` poisons every eval-tier A/B (2026-08-23, dev-4647)

The quickjs eval ADAPTER is a js2wasm-compiled artifact, and
`loadProviderCompiler` prefers the prebuilt, GITIGNORED
`scripts/compiler-bundle.mjs` over live `src/`. The adapter cache key is
sha256(adapter source ∥ bundle hash) — it hashes the BUNDLE, so a stale
bundle produces a **self-consistent cache HIT**: the build script reports
"adapter cache HIT + linked-pair verification" while handing you an
adapter compiled by a compiler that may be WEEKS behind your tree.
Measured 2026-08-23: the shared cache's adapter was 8 days / 3 waves
stale; rebuilding the bundle + adapter with ZERO source change flipped 12
`built-ins/Function` SyntaxError-family rows green. Both directions are
live: a stale-adapter base OVERSTATES your flips (rows your change never
touched read as yours) and can HIDE a real regression (a truly-passing
row reads "already failing on base").

Before ANY eval-dependent A/B or sweep:
`pnpm run build:compiler-bundle && npx tsx scripts/build-quickjs-eval-provider.mjs`
— on BOTH arms if the arms differ in compiler source. A cache HIT is not
freshness; check the bundle's mtime against your base commit date. CI is
unaffected (it rebuilds per run).

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
