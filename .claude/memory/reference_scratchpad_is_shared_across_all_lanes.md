---
name: reference_scratchpad_is_shared_across_all_lanes
description: "The harness scratchpad is keyed by SESSION uuid, not agent — every lane writes to the same directory. A generic filename silently gets another lane's content. Use the worktree's own .tmp/ for anything you read back."
metadata:
  node_type: memory
  type: reference
  originSessionId: 003c07aa-a2eb-5278-b5b1-6c63a0be18a6
---

**`/tmp/claude-0/<project>/<uuid>/scratchpad/` is SHARED by every agent in the
session.** The harness describes it as "session-specific, isolated", and that is
true — but the uuid is the **session's**, and subagents inherit it. So the lead
and every lane write to one directory.

Verified 2026-08-06: one lane's `msg.txt` sat alongside the lead's
`msg-4195.txt`, `msg-mem.txt`, `traces.txt` in the same folder, with a single
uuid directory under `/tmp/claude-0/-home-user-js2/`. Plain `/tmp` is shared for
the same reason.

## What it costs

A lane wrote its commit message to `scratchpad/msg.txt`; by read-back time the
file held **another lane's** commit message. `git commit --amend -F
scratchpad/msg.txt` then stamped that lane's message onto its commit. The
content of the commit was fine — the message was entirely someone else's, and it
was caught only because the lane re-read the commit afterwards.

The failure mode is the dangerous kind: **silent, and plausible-looking.** You
get a well-formed commit message, just the wrong one. Nothing errors.

Obvious filenames are where lanes collide: `msg.txt`, `out.txt`, `log.txt`,
`base.jsonl`, `probe.mjs`, `results.json`.

## The rule

- **Anything you WRITE THEN READ BACK goes in your worktree's own `.tmp/`**, not
  the shared scratchpad. Commit messages, A/B file copies, probe scripts,
  measurement output — all of it. `.tmp/` is gitignored and per-worktree, which
  is exactly the isolation the scratchpad does not give you.
- Reserve the shared scratchpad for genuinely throwaway, write-once output.
- If you must use a shared path, namespace it with your agent name
  (`scratchpad/W16-msg.txt`) — but prefer `.tmp/`.

## Two adjacent traps found in the same stretch

**`biome check --write` is the WRONG formatter for this repo.** It reorders
imports and reflows at ~80 columns, and **prettier does not undo it** (prettier
preserves manual object-literal breaks). One lane's 4-file diff went from ~115
lines to **581** with unrelated churn — and `format:check` still passed, so
nothing flagged it. Verified in `package.json`:

```
format       = prettier --write 'src/**/*.ts' 'tests/**/*.ts' 'scripts/**/*.ts'
lint         = biome lint src tests scripts --diagnostic-level=error
```

Prettier formats; biome **lints only**. Use `npm run format`.

**The `pre-git-commit.sh` ✓ hook inspects the COMMAND LINE, not the `-F` file.**
So `git commit -F msgfile` is blocked even when the file ends in ✓. The working
shape is a heredoc that writes the file and commits in **one** command, which
puts the ✓ on the command line:

```bash
cat > .tmp/msg.txt <<'EOF'
subject line ✓
EOF
SKIP_SLOW_PRECOMMIT=1 git commit -F .tmp/msg.txt
```

## Related

- [[reference_silent_empty_is_indistinguishable_from_real]] — same family: a
  well-formed wrong answer that nothing flags.
