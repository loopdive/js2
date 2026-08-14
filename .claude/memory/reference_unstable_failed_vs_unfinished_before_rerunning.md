---
name: reference_unstable_failed_vs_unfinished_before_rerunning
description: "mergeStateStatus UNSTABLE has TWO causes — a non-required check that FAILED, and one that has not FINISHED. Re-running is right for the first and actively harmful for the second."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-01T20:06:27.977Z
---

**Measured 2026-08-01 (PR #3986).** The standing advice — *"UNSTABLE means a red
non-required check; `gh run rerun --failed` to get back to CLEAN"* — is **only
half right**, and the lead repeated the unqualified form to four agents in one
session.

`UNSTABLE` fires when any non-required check is **not SUCCESS**. That includes:

| cause | rollup signature | correct action |
|---|---|---|
| non-required check **FAILED** | a `FAILURE` conclusion | `gh run rerun <id> -R … --failed` |
| non-required check **NOT FINISHED** | conclusion is **empty**, state pending | **wait — do nothing** |

**Re-running in the second case is actively harmful**: it restarts a healthy
in-flight job and *delays* the very CLEAN transition you are waiting for.

On #3986 the rollup had **0 FAILURE conclusions** and one empty conclusion
(`measure-and-gate`, a ~15 min job still running). It resolved to `CLEAN` on its
own and `auto-enqueue` took it to queue position 1.

**Check before acting:**

```bash
gh pr view <N> -R loopdive/js2wasm --json statusCheckRollup \
  -q '.statusCheckRollup[] | select((.conclusion // .state) as $c |
      $c != "SUCCESS" and $c != "SKIPPED" and $c != "NEUTRAL")
      | "\(.name // .context) -> \(.conclusion // .state)"'
```

An **empty** right-hand side means *running*, not *failed*.

Note this is the same family as *absence is not failure* — a check that has not
reported is indistinguishable from one that reported badly if you only look at
"is it SUCCESS?". Distinguish the two before spending an action on it.

Still true and unchanged: `auto-enqueue` takes only `{CLEAN, HAS_HOOKS}` and
**deliberately excludes `UNSTABLE`** (#3878/#3904), so a PR with every REQUIRED
check green can sit forever behind one red non-required check. That is the case
the original advice was written for.

Related: [[reference_autoenqueue_grace0_races_mergestate_recompute]],
[[reference_silent_empty_is_indistinguishable_from_real]],
[[reference_two_checks_share_a_name_head1_watcher_settles_on_a_stub]].
