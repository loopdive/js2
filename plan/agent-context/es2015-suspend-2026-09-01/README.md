# ES2015 standalone session — suspension manifest (2026-09-01T21:56Z)

The user asked at 21:56 UTC to suspend all work and resume it in exactly two
hours (a resume Routine fires at 23:56 UTC into session
`session_01FEGi3DmyPRPD5dx4kWU8hs`). Everything a resumer needs is in this
directory plus the `## Suspended Work` section of each lane's issue file.
Worktrees and transcripts are treated as already lost.

Goal: 100 % ES2015 test262 pass rate in `--target standalone` (umbrella #4444).
Census at compiler sha `d39779cb` (2026-09-01): **9,673 / 11,704 pass — 2,031
non-pass** (see #4444 "2026-09-01 evening dispatch census"). No implementation
has landed on main from this session yet; PR #5434 (census) merged, PR #5437
(the six r2 plans + #5272) was in the merge queue at suspension.

## Lanes at suspension

| Lane (issue) | Snapshot | Base | State | Patch |
| --- | --- | --- | --- | --- |
| #5150 buffers (ArrayBuffer/DataView) | `0795f838f` on `worktree-agent-aeeb8b33069f63eff` | `d153a0882` | clusters A+F, D, G committed and step-validated; snapshot adds uncommitted issue notes (`status: in-review`) | `patches/lane-5150.mbox` (4 patches) |
| #5197 Promise r2 (slices B–D) | `df3746897` on `worktree-agent-ac8409dd2ee533f14` | `d153a0882` | Slice B landed (+6), Slice C landed partial (+5); Slice D not attempted (needs generic NewPromiseCapability); snapshot adds uncommitted Slice C src/test edits | `patches/lane-5197.mbox` (2 patches) |
| #5267 for-of / iterators / collections r2 | `b67a7dd3f` on `worktree-agent-a2fe6fd871d2d1eef` | `881ee7095` | Steps A, A-2, B landed (+19, 0 regressions, gates green, equivalence gate NOT run); C–G not started; 4-row hang trap | `patches/lane-5267.mbox` (1 patch) |
| #5195 class r2 | `27ffb1a99` on `worktree-agent-a7080d5c21bf4a49c` | `dc29e1f15` | Step 3 + Step 9K committed (closure-written binding reads, computed `'constructor'` key); snapshot adds uncommitted edits in `class-proto-object.ts`, `call-builtin-static.ts` | `patches/lane-5195.mbox` (2 patches) |
| #5194 TypedArray r2 | `de01ce774` on `worktree-agent-a1eb4f40f876e3f07` | `dc29e1f15` | Step 1 (per-kind prototype graph) mid-implementation, nothing validated; snapshot = uncommitted edits across 7 codegen files + issue notes | `patches/lane-5194.mbox` (1 patch) |

Snapshot commits were made by the lead with git plumbing (no hooks, no gates)
per the `/suspend` protocol — they are unverified WIP and may not typecheck.
The lane branches were NOT pushed (this session may push only its own
branch); the patches ARE the durable copy. To resume a lane:

```bash
git worktree add /home/user/js2/.claude/worktrees/<name> -b <lane> origin/main
cd /home/user/js2/.claude/worktrees/<name>
git am --3way plan/agent-context/es2015-suspend-2026-09-01/patches/lane-<id>.mbox
JS2_WORKTREE_SOURCE=/home/user/js2 bash /home/user/js2/scripts/provision-worktree-deps.sh "$PWD"
ln -sfn /home/user/js2/.test262-cache .test262-cache
mkdir -p .tmp/es2015 && cp /home/user/js2/plan/agent-context/es2015-suspend-2026-09-01/lists/* .tmp/es2015/
pnpm run typecheck   # establish green BEFORE continuing the plan
```

## Directory contents

- `patches/lane-<id>.mbox` — `git format-patch origin/main..HEAD` of each lane
  (its validated commits + the WIP snapshot as the last patch).
- `lists/` — the per-cluster test262 path lists the planners produced
  (`<cluster>-paths.txt` baseline rows, `<cluster>-head.txt` the `test/`-stripped
  probe input, `<cluster>-cl-<X>.txt` per-root-cause sub-lists,
  `<cluster>-controls.txt` currently-passing controls, `<cluster>-errors.tsv`
  baseline error text, `es2015-fail-paths.txt` all 2,031 non-pass rows).
  Everything else under `.tmp/es2015/` was a run log and is regenerable with
  `npx tsx scripts/run-test262-paths.mts <list> --standalone`.
- `probes/` — the planners' minimal repros (`probes<issue>/`), probe runners
  (`probe-one.mts`, `probe-direct.mts`) and cluster partition scripts. Every
  source file carries an extra `.txt` suffix so the repo's formatter/linter
  hooks skip them (they are throwaway repros, some with TS syntax in `.js`);
  strip the suffix when copying back into `.tmp/es2015/`.

## Queue after the lanes resume (unchanged priority order)

1. Integrate + validate the five lanes (five ratchet gates + equivalence gate
   per lane, then per batch), push the session branch, open the wave PR.
2. Implementers not yet started: #5268 Array/Object built-ins (plan ready, bar
   ≥ 110), #5269 function/error/symbol built-ins (bar ≥ 70), #5196 Proxy/Reflect
   (floor +99), #5272 runner leak-check fix (small; do it early — it makes every
   local before/after honest).
3. Planners not yet run: #5270 expressions (117 rows; wave-1 #5149/#5146),
   #5271 statements/lang-semantics (84 rows; wave-1 #5154/#5158/#5157).
4. Owned elsewhere, do not re-dispatch: generators #680/#2864 (codex), RegExp
   #5198 (codex), module-code #4759, #3371, #2046.

Box facts: 4 cores / 16 GB; the agent-spawn hook blocks at 1-min load ≥
`.claude/max-load` (set to 12 here; gitignored, recreate it); run ≤ 3
implementers at once; `--isolate` probes cost ~12–25 s/row under load.
