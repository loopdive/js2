---
name: draft-pr-checkpoints
description: "Project-lead standing rule (2026-08-14): keep work checkpoints in a DRAFT PR from the first push; undraft once done. Draft = checkpoint vehicle, not a pause button — keep merging main in (auto-refresh-prs skips drafts)."
metadata:
  node_type: memory
  type: feedback
---

Project-lead directive, 2026-08-14: **"Going forward keep your work checkpoints
in a draft pr and undraft it once done."**

How to apply:

1. When a branch gets its first pushed commit, open a **draft PR** for it
   immediately. The draft is the work's visible, remote-persisted checkpoint —
   this rule exists because a container rebuild destroyed an unpushed
   integration branch (four verified lever implementations + docs) on
   2026-08-14. Pushed-branch + draft-PR would have preserved it and made it
   discoverable.
2. Push every checkpoint commit to that branch as you go — never accumulate
   local-only work.
3. **Undraft only when the work is complete AND freshly synced with main.**
   Two repo facts make this load-bearing:
   - Drafts are never auto-enqueued (`auto-enqueue.yml` skips drafts), so a
     draft can't accidentally enter the merge queue.
   - `auto-refresh-prs` SKIPS drafts — a draft silently rots behind main
     (PR #3919 hit 177 commits behind). Merge `origin/main` in yourself
     before undrafting.
4. Undrafting is the "done" signal: after it, the normal pipeline owns the PR
   (green checks → auto-enqueue → merge queue).
