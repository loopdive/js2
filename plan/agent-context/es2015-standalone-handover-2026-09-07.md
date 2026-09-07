---
agent: fable-lane (ES2015 standalone close-out)
session: claude/es6-test262-standalone-g10c7u (session_01FEGi3DmyPRPD5dx4kWU8hs)
session_end: 2026-09-07
next_session_entry_point: >
  Read this file, then the "## Handover (2026-09-06 …, wave 5)" and
  "### Wave-5 close (2026-09-07)" sections of
  plan/issues/4444-es6-standalone-edition-closeout-umbrella.md.
  Nothing is in flight: no open PR, no running lane, no claim held.
---

# ES2015 standalone lane — handover 2026-09-07

Goal: `/goal 100% es2015 pass rate in test262 in standalone mode`
(umbrella #4444). Process in force since 2026-09-05: Fable writes the
`## Implementation Plan` in the issue file, an Opus subagent (medium; high for
the hard lanes; Sonnet high for mechanical work) implements in an isolated
worktree, a separate Opus reviewer tries to break it, and fix rounds repeat
until a review comes back with nothing reproducible. Everything below was
measured, not inferred; every number names its artifact.

## Where the number stands

| | ES2015 standalone | whole corpus standalone |
| --- | --- | --- |
| after wave 4 (#5604, 2026-09-05) | 10,188 / 11,704 = 87.0 % | — |
| after #5688 (PR-1, 2026-09-06 20:21 UTC) | 10,219 (87.3 %) | +46 / −2 |
| after #5694 (PR-2, 2026-09-07 03:14 UTC) | **10,228 / 11,704 = 87.4 %** | 35,213 / 48,735; +21 / 0 |
| after #5696 (hotfix, 03:57 UTC) | unchanged (Annex B rows are outside the ES2015 scope) | the −2 restored |

Artifact: `.test262-cache/test262-standalone-current.jsonl` fetched
2026-09-07 04:35 UTC via `node scripts/fetch-baseline-jsonl.mjs --standalone
--force`; census via `node .tmp/census0903/census.mjs` (scope =
`website/public/benchmarks/results/test262-file-editions.json`, edition
`ES2015`). The website's edition percentage is integer-rounded, so 87.0 → 87.4
reads as "87 %" on the landing page until it crosses 87.5.

Remaining ES2015 non-pass: **1,476** (1,146 fail, 329 compile_error, 1
compile_timeout). Clusters (`census.mjs` at 04:35 UTC):

| cluster | non-pass | fail | CE | owning issue / note |
| --- | --- | --- | --- | --- |
| expressions | 219 | 122 | 96 | #5270 r2 lane (33 pins landed); the CE half is mostly `super`/class-field shapes |
| typedarray | 177 | 176 | 1 | #5349 steps 6–7 (26 `speciesctor-*` rows diagnosed), #5359, the `u8.buffer` snapshot-copy family |
| other-builtins | 167 | 165 | 2 | untriaged tail: `String`/`Number`/`Math`/`Symbol` residuals |
| class | 158 | 104 | 54 | #5318 (r6 residuals), #5350 (7 rows behind the block-scoped-class captured-`var` write defect) |
| regexp | 139 | 129 | 10 | dual-backend RegExp gaps, unowned |
| generators | 121 | 75 | 46 | unowned; CE half is `yield*`/return-in-finally shapes |
| array+object | 116 | 111 | 5 | #5268 done; the rest is Annex B / integrity residuals |
| promise | 99 | 51 | 48 | unowned; CE half is `await`-in-generator shapes |
| proxy+reflect | 97 | 90 | 7 | #5316 residuals (TypedArray integer-index `Reflect.set`, `with(proxy)`), #3371 r3 |
| for-of+collections | 83 | 47 | 36 | unowned |
| statements+lang | 73 | 55 | 18 | unowned |
| module-code | 25 | 19 | 6 | unowned |

## What landed this session (all merged through the queue)

| PR | issue lanes | rows | notes |
| --- | --- | --- | --- |
| #5688 | #5316 r5, #5350 r1, #5318 r4/round 2, #3371 r2, #5351 | +46 / −2 whole corpus | the −2 was found only by set-diffing the promoted baseline against its predecessor (the merge-group gates score the host target and the standalone aggregate) |
| #5694 | #5349 rounds 1–5 | +19 owned (10 `Array` species, 9 `ArrayBuffer.prototype.slice` species), +21 / 0 whole corpus | five reviewed rounds; the packed-byte TypedArray brand split (`$__vec_i8_byte` final vs `$__vec_i32_byte` open, wasi/standalone only, host byte-identical) |
| #5696 | #5316 r6 | the 2 Annex B rows back | an accessor define on an EXISTING key of a non-extensible literal/instance carrier threw; guarded with own-only `__hasOwnProperty` |
| #5698 | docs | — | the #4444 wave-5 close section |

Issue status after the wave: #5316, #5349, #5351 `done`; #5350, #5318, #3371
deliberately `in-progress` (each shipped a reviewed round, not its full
acceptance set; the residual rows and the next round's mechanism are in the
issue files).

## Follow-ups, in priority order (mechanisms in the issue files)

1. **#5350 block-scoped-class captured-`var` write defect** — 7 target rows;
   the largest single ES2015 item with a known mechanism. Then the `super.x`
   read reached before a nested function's `super()` (needs a flag the nested
   function can store; the never-invent-a-throw direction was chosen and
   pinned).
2. **TypedArray cluster (177)** — #5349 steps 6–7 (`speciesctor-*`, 26 rows,
   diagnosed to `emitTaDynSpeciesCreate`), #5359 (spread of a packed-byte
   TypedArray emits invalid wasm), the `u8.buffer` snapshot-copy family
   (probes t1/t2/t11/t17 in #5349's records), `Int8Array` widening reads
   unsigned, `Object.prototype.toString` / `ArrayBuffer.isView` on a packed
   slice result.
3. **`class B extends ArrayBuffer {}` as the species TRAPs** (node 4) — needs
   ArrayBuffer subclassing; the `IsConstructor` family cannot answer intrinsic
   identity for a subclass.
4. **wasi own-key ladder for closed-struct carriers** — on `--target wasi`
   `__hasOwnProperty` answers false for a struct-field key and
   `hasOwnProperty.call` on a plain literal traps, so the #5316 r6 guard is
   emitted but inert there. No test262 row at stake (conformance runs
   standalone); a wasi-lane task.
5. **`Reflect.defineProperty`** — accessor over an existing key is a silent
   no-op; over a NEW key of a non-extensible object it traps instead of
   returning `false` (the throw is right, the wrapper's catch is missing).
6. **#3371 r3** — three conservative refusals of shapes base also refused;
   `let T = (function(){…})` answers 4 on base too.
7. **The Temporal host-flake cluster** — the rebuilt merge group of #5696 was
   parked on 28 `built-ins/Temporal/*` host rows that flip run-to-run (the
   same content passed one run earlier with 10 different flips; a local A/B on
   26 of them answers identically on the PR head and on main). If it recurs,
   the gate's own text prescribes a `scripts/test262-host-noise-quarantine.json`
   entry citing both runs.

Unowned clusters worth a plan next: regexp (139), generators (121), promise
(99), for-of+collections (83). Sibling issues #2864 / #2867 / #2175 belong to
the other team — do not touch.

## How to resume (mechanics that cost time to rediscover)

- **Branch**: `claude/es6-test262-standalone-g10c7u` == `origin/main`
  (`41b2dfcef5` at handover). Every PR of this lane was opened from it or from
  a `claude/es6-test262-standalone-<issue>-r<N>` branch cut from it. Commits
  carry `Model: Claude Fable 5.1 High` (lanes: `Claude Opus 5 Medium/High`,
  `Claude Sonnet 5 High`), subject ends with ✓ (put it in the command string
  too), `SKIP_SLOW_PRECOMMIT=1`, never `--no-verify`. The stop hook asks to
  re-author commits as `Claude <noreply@anthropic.com>` after every turn —
  always decline (the repo's commit-msg hook wants the repo identity as author
  and Claude only in trailers; "Unverified" on GitHub is expected).
- **Push**: always in the background with the exit captured to a file — the
  pre-push hook (typecheck + lint) takes 5–50 min under load. A push to a
  QUEUED PR ejects it; close+reopen is the sanctioned dequeue.
- **Lanes**: `Workflow` scripts under
  `/tmp/claude-0/-home-user-js2/<session>/scratchpad/` (may not survive a
  container restart — the persisted copy is under
  `/root/.claude/projects/-home-user-js2/<session>/workflows/scripts/`);
  journals at `/root/.claude/projects/-home-user-js2/<session>/subagents/workflows/<runId>/journal.jsonl`.
  A container restart kills every agent: commit the surviving worktree as a
  snapshot (after merging `origin/main` and re-running the LOC gate — main's
  post-merge baseline refresh can lower a ceiling, e.g. `src/codegen/index.ts`
  needed a restated grant), then launch a finisher + reviewer workflow.
- **Measuring**: compile API `import { compile } from '<tree>/src/index.ts'`
  via `npx tsx`, `{ target, allowJs: true, skipSemanticDiagnostics: true,
  emitWat?: true }`, assert `result.imports` is `[]` on standalone; rows via
  `COMPILER_POOL_SIZE=2 npx tsx scripts/run-test262-paths.mts --isolate <list>
  --standalone` in ≤150-row chunks (nothing usable until `=== counts ===`;
  OOM-killed chunks re-run split); the ONLY valid base tree is `git archive
  <main sha>` + `pnpm run -s build:compiler-bundle` + the esbuild runtime
  bundle + `node scripts/build-quickjs-eval-provider.mjs`. Host probes need
  `result.importObject.__setInstance(instance)`. Node 25 lives at
  `/home/user/js2/.tmp/wrap/node25/cache/_npx/8758e404b5eed2f3/node_modules/node/bin`.
- **After every merge**: `node scripts/fetch-baseline-jsonl.mjs --standalone
  --force`, copy the previous baseline aside FIRST, set-diff pass→non-pass.
  That one-minute diff is what caught #5688's −2; no gate did.
- **Scratch kept**: `.tmp/census0903/census.mjs`, `.tmp/rev5349d/` (the
  round-3 reviewer's ~350 probes + harnesses `run.mts`, `wasirun2.mts`,
  `nodeoracle.mjs`), `.tmp/rev5349e/`, `.tmp/rev5349f/`, `.tmp/rev5316r6/`,
  `.tmp/w5/i8brand/` (the brand-split proof probes), `.tmp/pr1-body.md`,
  `.tmp/pr2-body.md`, `.tmp/pr3-body.md`, `.tmp/baseline-before-5694.jsonl`.
  Worktrees: only the pre-existing `agent-*` snapshots and `issue-5271-plan`
  remain; every wave-5 worktree was removed after its branch merged.

## Lessons this session added (also in the umbrella)

- Execute a site twice on different arms: a gate around an emitter that
  RETURNS a local to its caller must keep that local's initialisation outside
  the gate (#5349 round 4 → 5).
- Set-diff the promoted baseline after every merge; the aggregate gates cannot
  see a small loss behind a larger gain.
- A push to main (the benchmark-artifact refresh follows every merge) rebuilds
  the in-flight queue group and re-rolls the Temporal host bucket; read the
  cited run, the changed-path count and a local A/B before touching a park.
- A representation identity is load-bearing wherever a `ref.cast` never
  trapped; grep every cast site before changing a canonical type.
- Static predicates over dynamic facts converge only by review rounds; budget
  the review loop, not the first implementation.
