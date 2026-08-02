---
name: reference_stale_ref_locks_make_fetch_silently_not_update
description: "Stale 0-byte .git ref locks make `git fetch` fail to update remote-tracking refs while still exiting 0 — every ahead/behind number derived from them is silently stale. Use ls-remote or the server-side compare API."
metadata:
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
---

Measured 2026-08-02 in `/workspace`, which had ~20 stale 0-byte lock files in
`.git/refs/**` and `.git/logs/refs/**` left by crashed git processes.

## The trap

A push was rejected **non-fast-forward** while local git insisted:

```
ahead of fork remote: 3      behind fork remote: 0
```

Both readings were internally consistent. The local one was **wrong**. The
`git fetch` that populated the tracking ref had been blocked by the lock files
— it printed `cannot lock ref` noise into a stream that was being filtered, and
the *derived* numbers surfaced no error at all.

`git ls-remote` answered instantly and correctly: the branch carried a
`js2-merge-queue-bot[bot] Merge branch 'main'` commit that was simply absent
locally.

## Why it belongs to the silent-empty family

The failure is not "fetch errored". It is **"fetch did not update, and every
number computed from the un-updated ref looked normal."** `rev-list --count`
cannot say *"I could not see the remote"* — it answers about whatever ref is on
disk, however old. A detector that cannot say *I don't know* returns a
confident wrong answer instead.

## The rule

> **When a push is rejected but your local refs say fast-forward, trust
> `ls-remote` — never the tracking ref.**

```bash
git ls-remote <remote> refs/heads/<branch> | cut -f1     # authoritative
```

And for merge/ancestry questions, prefer the **server-side compare API**, which
is computed on GitHub's side from refs you never fetch, so it is immune to any
local ref damage:

```bash
gh api repos/<owner>/<repo>/compare/<head>...main --jq .behind_by   # 0 ⇒ landed
```

A peer shepherd had independently adopted this and it was the reason its merge
verifications were unaffected all session while mine were not — worth copying,
not just noting.

## Do NOT clear the locks while a fleet is running

The lock files are 0-byte leftovers, but removing them mid-flight races live
agents' git operations. They need a **quiesce**. Symptom while they persist:
`fatal: failed to run reflog` / `error: task 'gc' failed` trailing otherwise
successful commands — the commit lands, the background `gc` does not.

Related: [[reference_silent_empty_is_indistinguishable_from_real]],
[[reference_merge_queue_snapshots_head_at_enqueue_time]],
[[reference_never_git_worktree_prune_inside_container]].
