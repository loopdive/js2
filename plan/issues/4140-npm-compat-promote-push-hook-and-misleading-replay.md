---
id: 4140
title: "npm-compat promotion STILL fails: the commit was opted out of husky but the PUSH was not, and the retry loop reports every push failure as a mid-promotion race"
status: done
sprint: 78
created: 2026-08-03
updated: 2026-08-18
completed: 2026-08-03
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: tooling, ci
language_feature: none
goal: dogfood
related: [4130, 4132, 3988, 4127]
origin: "the third blocker, found by watching the first refresh run that carried both prior fixes — 2026-08-03"
---

# #4140 — the promote PUSH runs husky too

## How this surfaced

Third blocker in a chain. #4130 fixed the staleness floor so the gate stops
deferring; #4132 fixed the pre-COMMIT hook. Run `30843466125` (18:55, the first
with both) got further than any before it — the promote step ran for **6
minutes** instead of failing in 11 seconds — and still failed.

The artifact has now been stuck on the manual 2026-08-01 snapshot
(`3ffd8ed5c`) through three separate causes.

## Root cause A — the push runs the pre-push hook

```
Fix direct checker growth before pushing, or use --no-verify (CI will catch).
error: failed to push some refs to 'github.com:loopdive/js2.git'
```

#4132 added `--no-verify` to `git commit` and **not** to `git push`. Both hooks
are live in this job because it runs `pnpm install`:

| hook | runs | why it fails here |
| ---- | ---- | ----------------- |
| pre-commit | `test:changed-root` | needs a merge base with `origin/main` |
| pre-push | oracle ratchet | reports huge "direct checker growth" |

The checkout is `fetch-depth: 1` with `persist-credentials: false` and the push
remote is `deploykey`, so `origin/main` does not exist and neither hook can do
its job. The hook's own message even suggests the remedy ("or use `--no-verify`
(CI will catch)") — and CI does catch it: the ratchet is a required check on
every PR.

This one is mine. #4132's PR said "if a third blocker sits behind this one, the
same method applies" — and the third blocker was one line below the line I
changed.

## Root cause B — the retry loop mislabels every failure as a race

```
push rejected (main advanced mid-promotion); replaying onto the new head — attempt 5/5.
::error::could not publish npm-compat artifacts after 5 replay attempts.
```

The loop treats ANY push failure as "main advanced mid-promotion" and replays
five times. Replaying only helps for a genuine non-fast-forward. For a rejected
hook the replay fails identically every time, and the honest error
(`Fix direct checker growth before pushing`) is buried under five rounds of a
confident, wrong diagnosis.

That is why this took an extra cycle to find: the log's own summary line said
"race", and it was not a race.

## Fix

1. `git push --no-verify` alongside the existing `git commit --no-verify`.
2. Capture the push's stderr and replay **only** on race markers
   (`non-fast-forward` / `fetch first` / `behind its remote` / `stale info`).
   Anything else fails immediately with the real message surfaced.

Also re-indents #4132's comment block, which I left mis-indented.

## Acceptance criteria

- [x] The promote step pushes without invoking the pre-push hook.
- [x] A non-race push failure exits immediately with the underlying error
      instead of five misleading replays.
- [x] Structural guard extended in
      `tests/issue-4130-npm-compat-refresh-staleness-gate.test.ts` — asserts
      `--no-verify` on the push and the race-marker discrimination.
- [x] Both new assertions demonstrated to FAIL against main's version
      (2 of 9 fail without the fix; 9 of 9 pass with it).

## Not yet verified

**The artifact has still never moved.** Three fixes in, and the only evidence
that counts is `npm-compat-perf.json` leaving `3ffd8ed5c`. Do not record this
chain as working until that commit line changes. If a FOURTH blocker appears,
read the failing step — the pattern so far is that each fix reveals the next
one, and twice the log's own summary line pointed the wrong way.
