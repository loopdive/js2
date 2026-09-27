# npm-suite effort — handoff (2026-09-24)

Lead session `npm-unit-test-failures-420ca0` (Fable 5.1), 2026-09-05 → 09-24.
Goal as last set by the stakeholder: **fix compilation and failing unit
tests of npm packages — standalone lane only from 2026-09-23 on** (the
JS-host unit-test lane is deliberately no longer being dispatched).

## Where things stand

### JS-host dogfood suites (main 586b37dcac, last measured 09-13/09-23)

100 %: webpack 16/16 · clsx 32/32 · cookie 63740 · tailwindcss 13/13 ·
jsdom 6/6 · styled-components 9/9 · uuid 75/75 · moment 10/10 ·
stylelint 108/108. Below 100 %: hono 268/324 · jest 335/356 · axios 208/231 ·
prettier 107/151 · redux 67/82 · lodash 59/62 · marked 16/30 · three 17/18
(Math.exp precision, design decision).

Effort totals since 09-05: ~40 PRs merged, ~45 issues filed (5334–5375,
6412–6461, 6659–6665), four regressions on main found and fixed
(#5333, #5332, #5335, #5348), three CI gates added/repaired
(#5336 validated-floor, #5344 diff-test baseline, #5368 surface-wide
dogfood validation, #6418 boundary-gate verdict in log, #6461 standalone
high-water producer).

### Standalone-dynamic perf lane (the "empty graphs" on npm-compat)

Root causes clustered and worked 09-23/24 (Opus 5.5 agents):

| cluster | state |
|---|---|
| uuid retained 3 host imports | **fixed**, PR #6047 merged — uuid measures in both standalone lanes |
| opaque "entry did not produce a runnable module" (10 pkgs) | **fixed**, PR #6052 merged — each package now reports its real error |
| react `require is not defined` at module init | **fixed**, PR #6053 merged; react now blocks on browser globals → #6664 |
| replace/replaceAll with a runtime RegExp (#1474/#1913) | **fixed**, PR #6054 merged (#6662); hono/marked/moment now block on match/search/split → #6665 |
| standalone lanes inherit the JS-host compile failure on the dashboard | PR #6060 open (#6660) |
| styled-components wasm-opt validation failure in `re` | PR #6067 open |
| RegExp match/search/split as a VALUE (#6665) | agent running at handoff (workflow wf_07a07bbb-6a7) |
| react browser globals: performance/MessageChannel/queueMicrotask (#6664) | agent running at handoff (same workflow) |
| axios: real standalone blocker is `__get_builtin` #1472 in combined-stream (not #3587 as the dashboard said) | recorded in #6660, unowned |

Current lane table (benchmarks/results/npm-compat.json, pre-#6047/#6054
refresh — CI regenerates on every merge):

| package | standaloneDynamic | error |
|---|---|---|
| uuid | measured |  |
| typescript | compile-error |  |
| acorn | measured |  |
| cookie | measured |  |
| lodash | compile-error |  |
| react | host-import-error |  |
| eslint | compile-error |  |
| react-dom | runtime-error |  |
| prettier | compile-error |  |
| tailwindcss | compile-error |  |
| axios | compile-error |  |
| clsx | measured |  |
| jsdom | compile-error |  |
| marked | compile-error |  |
| webpack | compile-error |  |
| hono | compile-error |  |
| jest | runtime-error |  |
| lodash-es | compile-error |  |
| redux | measured |  |
| moment | compile-error |  |
| three | compile-error |  |
| styled-components | optimization-error |  |
| stylelint | compile-error |  |
| lit | skipped | the pinned Lit callback probe currently covers the JS-host lane only |

## Open PRs of this effort

- #6060 fix(#6660) standalone lanes report their own compile error — CLEAN, auto-enqueue
- #6067 styled-components wasm-opt validation — check state
- #6044 fix(#6451) JS-host struct enumeration harness — BEHIND (JS-host lane, low priority)
- #5911 fix(#6440) Promise.try — DIRTY + stale hold from the #6461 gate; needs a main merge + unhold (JS-host lane)

## Unfinished JS-host work parked in worktrees (branches on fork)

`/Users/thomas/Code/js2/.claude/worktrees/wf_bae5b2b6-b12-{8,10,11,12}`:
issue-6450 (createHash null, 2 commits), issue-6453 (`$__ta_view` read arm,
2 commits + 3 dirty files), issue-6455 (native-lane throw attribution,
3 dirty harness files, nothing pushed), issue-6456 (untyped .js module
calls, nothing done). Resume by checking out the branch from fork, merging
main, finishing per the plan in each issue file. The stakeholder said not
to dispatch more JS-host unit-test work; these are recorded, not queued.

## How to resume the standalone lane

1. Read the wave-2 journal for the two agents still running at handoff:
   `~/.claude/projects/-Users-thomas-Code-js2--claude-worktrees-npm-unit-test-failures-420ca0/ff1eafdb-376d-4510-b9db-2ae45f5b023f/subagents/workflows/wf_07a07bbb-6a7/journal.jsonl`
   — they open PRs for #6665 and #6664 on their own.
2. Per package: `npx tsx scripts/generate-npm-compat-report.mjs --only <pkg> --no-write --perf-only --lane standalone-dynamic`
   (`--inspect-ir`, `--inspect-wat`, `--inspect-binary`). Never hand-commit
   npm-compat.json. New host imports are forbidden in standalone; the
   precedent for an unavailable capability is #6659 (throw ReferenceError).
3. Next blockers after #6665/#6664: hono `Array.prototype.flat` (#2717);
   axios `__get_builtin` (#1472); react-dom `require("react")` linkage;
   lodash/prettier after match/split; typescript/webpack standalone compile
   > 25 min (#1058/#4287).

## Environment traps (all bit this effort)

- Agent worktrees start ~3,800 commits stale — step 0 is fetch upstream/main,
  detach, verify SHA equality and a clean tree, then branch.
- git-lfs is now installed, but the inline
  `-c filter.lfs.process= -c filter.lfs.smudge=cat -c filter.lfs.clean=cat -c filter.lfs.required=false`
  form is still what every brief uses; a shell variable holding the flags
  expands as one token in zsh.
- A stale `.git/config.lock` makes `checkout -B` silently not switch branches.
- The Agent/Workflow tools accept `claude-opus-5-5` only on Claude Code ≥ 2.1.280.
- GitHub GraphQL exhausts at 5,000/h with many agents; REST keeps working.
- A bot park-hold does not dequeue a PR — the queue re-groups and can merge
  it on the next passing group. Two producers of the standalone high-water
  mark disagreed (#6461, fixed). The #3518 boundary gate's verdict is only
  in the artifact (#6418 fixed the log).
- `SendMessage` was disabled for the whole session; briefs must be complete.
- One unobserved host-promise rejection or uncaught exception zeroed whole
  dogfood files until #5369/#6424.
