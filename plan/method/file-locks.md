# File Locks — retired (#7559, 2026-11-27)

This was a hand-kept table of file/function claims. It is retired: nothing forced
an entry in or out, so it rotted — on 2026-11-27 it still listed claims from April
2026, while two PRs of one lane silently conflicted with four PRs of another.

The open pull requests' changed-file lists are the same information and are always
current. Ask them instead:

```bash
node scripts/pr-file-overlap.mjs                    # this branch's changes vs every open PR
node scripts/pr-file-overlap.mjs --paths a.ts b.ts  # files you intend to touch, before you start
node scripts/pr-file-overlap.mjs --issue <id>       # paths named in the issue's Implementation Plan
```

The check is advisory and also runs inside `scripts/pre-dispatch-gate.mjs` (a
FILE OVERLAP caution) and at the end of the pre-push hook. Settle an overlap with
the other lane on the standing coordination PR #7526. There is nothing to add here
and nothing to remove.
