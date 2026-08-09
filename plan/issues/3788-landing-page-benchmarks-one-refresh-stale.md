---
id: 3788
title: "the landing page always publishes benchmark numbers from BEFORE the current push's refresh — deploy-pages races benchmark-refresh, and `[skip ci]` stops the refresh commit from ever deploying"
status: done
completed: 2026-07-30
sprint: 77
created: 2026-07-30
updated: 2026-07-30
priority: high
horizon: s
feasibility: easy
task_type: infrastructure
area: ci
goal: performance
depends_on: []
related: [1216, 1951, 3786]
---

# #3788 — the site is structurally one refresh behind

## Symptom

Reported from the live landing page: the `loop.ts` sidebar showed wasm and JS
**on par**, hours after #3786 (PR #3809) landed a change measured at 1.69x
faster on CI hardware.

The data was never wrong. `main` was correct and the site was stale.

| where                                           | loop wasm | loop js  | ratio                |
| ----------------------------------------------- | --------- | -------- | -------------------- |
| `main` @ `0fb8066de` (00:42)                    | 208.4 µs  | 351.7 µs | **1.69x faster**     |
| what the live page was built from (`01b763220`) | 311.5 µs  | 311.5 µs | **1.00x — "on par"** |

## Root cause — a race that never self-corrects

Both workflows trigger on `push: main`, and they finish minutes apart:

1. `deploy-pages.yml` starts immediately and builds from the **currently
   committed** `benchmarks/results/playground-benchmark-sidebar.json`.
2. `benchmark-refresh.yml` spends ~4 minutes actually running the benchmarks,
   then commits the new numbers — with `[skip ci]`.
3. `[skip ci]` suppresses **every** workflow for that push, `deploy-pages`
   included. So the refresh commit never deploys itself.

Net: the site publishes the numbers from _before_ the current push's refresh,
and only picks them up when some unrelated later push to main happens to
trigger a deploy. On 2026-07-30 the deploy at 00:38 beat the refresh at 00:42
by four minutes, so the pre-#3786 `311.5/311.5` row stayed live.

This is not specific to #3786 — **every** benchmark change has always been
published one cycle late. It was invisible until a change moved a number
enough for someone to notice.

## Why `[skip ci]` is not the thing to remove

It is load-bearing twice over, per `benchmark-refresh.yml:201-209`:

- it stops the auto-commit retriggering `benchmark-refresh` itself, and
- #1951: any push to main — **even `[skip ci]`** — makes GitHub rebuild every
  queued merge group, which is why `baseline-summary-sync.yml` and
  promote-baseline apply the same reasoning.

So the fix has to leave the commit non-triggering and reach the deploy by
another route.

## Fix

Add a `workflow_run` trigger to `deploy-pages.yml`, keyed on **Refresh
Benchmarks** completing on `main`. It needs no new token or secret (unlike
dispatching from inside the refresh job: a `workflow_dispatch` issued with
`GITHUB_TOKEN` does not create a run, and the refresh job pushes with an SSH
deploy key that cannot call the Actions API).

Two details that make it actually work rather than silently redeploy the same
stale tree:

- **Checkout must pin `main`.** On a `workflow_run` event `github.sha` is the
  head SHA of the _triggering_ run — i.e. the pre-refresh commit. Taking the
  default would redeploy exactly the numbers this trigger exists to replace.
- **Gate on `conclusion == 'success'`.** A failed or cancelled refresh has
  nothing new to publish.

`push` and `workflow_dispatch` behaviour is unchanged.

### Accepted cost

A push to main whose refresh produces **no** diff still fires a second deploy,
so most pushes now cost one extra pages build (~3-4 min of runner time). Stated
here rather than hidden: the alternative — dropping the `push` trigger and
deploying only via `workflow_run` — would put every deploy behind the refresh
job's 90-minute timeout and break deploys entirely whenever the refresh fails.
The `github-pages` concurrency group (`cancel-in-progress: true`) already
collapses overlapping runs.

No loop risk: `deploy-pages` never pushes to this repo's `main` (its only push
is to the `labs/graph-data` branch of `loopdive/js2wasm-labs`).

## Acceptance criteria

- [x] `deploy-pages.yml` runs after a successful `Refresh Benchmarks` on main.
- [x] That run checks out the tip of `main`, not the triggering run's SHA, so
      it sees the refresh commit.
- [x] A failed/cancelled refresh does not trigger a deploy.
- [x] `push` and `workflow_dispatch` paths are unchanged.
- [ ] Verified end-to-end on the next push to main: the served
      `playground-benchmark-sidebar.json` matches the committed one.

## Immediate remediation (already applied)

`deploy-pages.yml` was dispatched manually against `main` on 2026-07-30 to
publish `0fb8066de`, so the live page stopped showing the pre-#3786 row without
waiting for the next push.
