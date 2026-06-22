---
name: reference_git_corrupt_loose_object_refetch
description: "Recover a corrupt loose object in the shared /workspace/.git (fatal \"loose object … is corrupt\" on merge) via git fetch --refetch"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

The shared `/workspace/.git` object store occasionally has a **corrupt loose
object** (`.git/gc.log` warns "too many unreachable loose objects"; a merge or
checkout dies with `fatal: loose object <sha> (stored in
.git/objects/xx/…) is corrupt`). Plain `git fetch origin main` does NOT fix it —
git's negotiation believes it already has the referencing commit (it's in a
packfile) so it won't re-send the object.

**Recovery (non-destructive to refs/history):**
```bash
cd /workspace
git config gc.auto 0                 # stop the background auto-gc that aborts the fetch
git config fetch.negotiationAlgorithm noop
rm -f .git/gc.log                    # the gc.log warning makes git exit 128 mid-fetch
chmod u+w .git/objects/xx/<rest> && rm -f .git/objects/xx/<rest>   # drop the corrupt loose obj
git fetch --refetch origin main      # re-download ALL objects, ignoring negotiation
```
`--refetch` is the key flag — it bypasses the have/want negotiation and re-pulls
the full object set, repacking it cleanly. After it completes, the merge/checkout
that was failing proceeds. If the corrupt object is no longer reachable from the
*current* main tip (main advanced past it), it simply isn't refetched and that's
fine — only objects reachable from live refs are needed.

Do this from `/workspace` (the shared store), not a worktree. It does not touch
refs, branches, or published history — safe for concurrent agents. See
[[feedback_check_before_cleanup]].
