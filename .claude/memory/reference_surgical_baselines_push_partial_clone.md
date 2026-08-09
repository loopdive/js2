---
name: reference-surgical-baselines-push-partial-clone
description: "How to hand-promote test262 baselines when CI's promote job is down: blob:none no-checkout clone + hash-object/update-index --cacheinfo + write-tree --missing-ok (NOT plain write-tree, which lazy-fetches every missing blob) + commit-tree + push. Also: a PR wedged at mergeable UNKNOWN gets NO pull_request runs — close/reopen forces recompute."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
  modified: 2026-07-19T15:43:54.605Z
---

Surgical promote of merged-report artifacts to `loopdive/js2wasm-baselines`
when the CI `promote merged report to main baseline` job is broken (used
2026-07-17 for #3392, script at jobs tmp `surgical-baseline-push.sh`):

1. `git clone --depth=1 --filter=blob:none --no-checkout <repo>` — metadata only.
2. `git read-tree HEAD`; stage each new file with
   `sha=$(git hash-object -w <src>); git update-index --add --cacheinfo 100644,$sha,<path>`.
3. **`TREE=$(git write-tree --missing-ok)`** — plain `write-tree` verifies every
   index entry and batch-lazy-fetches ALL missing promisor blobs (the whole
   runs/ history → hangs for tens of minutes). `--missing-ok` skips that;
   `GIT_NO_LAZY_FETCH=1` as belt-and-suspenders.
4. `git commit-tree "$TREE" -p HEAD -m "... ✓"` (bot author/committer;
   pre-git-commit hook wants the ✓ sign-off even here).
5. Verify with `git diff-tree --name-status -r HEAD <commit>` (tree-level, no
   blobs needed), then
   `git -c pack.window=0 -c pack.depth=0 push https://x-access-token:$(gh auth token)@github.com/... <commit>:refs/heads/main`
   — non-ff rejection is the race guard. **pack.window=0 is required**: normal
   delta-base selection READS blob contents of touched paths → lazy-fetch of
   missing promisor blobs → 'could not fetch <sha>' / hangs under
   GIT_NO_LAZY_FETCH. Also: `"$VAR:refs/heads/main"` in zsh eats `:r` as a
   modifier — use `"${VAR}:refs/heads/main"`. And `cmd | tail -1 && break`
   breaks on tail's exit status, not cmd's — set -o pipefail in retry loops.

**⚠️ WIPE TRAP (2026-07-19, #3468 — cost the landing page):** do the index
via **`git read-tree HEAD`** (step 2), NEVER via `git sparse-checkout set
'runs/'` + `git checkout`. Sparse-checkout truncates the INDEX to only the
sparse paths, so `write-tree --missing-ok` emits a tree containing ONLY `runs/`
— silently DELETING all ~17 root files (`test262-current.json/.jsonl`,
`test262-standalone-current.*`, both reports, categories, README). That breaks
`deploy-pages.yml` (gated on `test262-current.json` existing → falls back to a
stale committed copy, landing page cratered to a 6-week-old 37.8%) and every
root-file consumer (`fetch-baseline-jsonl.mjs`, PR regression gate, validator,
dev-self-merge bucket analysis). **MANDATORY before pushing any surgical
baselines commit: `git ls-tree <newtree> --name-only | wc -l` must show the
FULL root count (~18), not just the added `runs/` files.** The wipe also took MOST of `runs/` (my interrupted sparse `checkout` left only
the 2 hand-seeded files in the index) — recovery needed BOTH the root files AND
a `runs/` archive restore (1,141 per-SHA caches + `runs/index.json`), the latter
done server-side via the **Git Data API** (create-tree/create-commit/update-ref)
because a `blob:none`-clone push lazy-fetched blobs and timed out. **VERIFY the
final state against the REMOTE via `gh api repos/.../git/trees/<runs-sha>`
(`.tree|length`, check `.truncated`), NOT a surgery-polluted local clone** — a
local `git ls-tree "$TIP:runs"` after partial fetches gave a STALE count (showed
1 when the remote had 1,149) and nearly triggered a bogus "it's re-wiped" panic.
Recovery: `git read-tree <current-tip>`, then restore each wiped root file by SHA from the
last-good parent — `sha=$(git rev-parse "<goodparent>:<file>"); git
update-index --add --cacheinfo 100644 "$sha" "<file>"` (3-arg form; the comma
form `100644,$sha,$path` chokes in zsh) — full-tree commit, verify 18 entries,
push. Blobs already on remote ⇒ pack.window=0 push sends only tree+commit.

Root cause the day this was needed (#3392): promote job cloned with
`--depth=1` but no blob filter; the `runs/` per-SHA cache (~1000 × tens of MB)
pushed the clone past the 10-min step timeout. Fix = blob:none + no-cone
sparse-checkout `'/*' '!/runs/*' '/runs/index.json'` + `git add -A --sparse`.

Bonus finding: PR #3307 sat with `mergeable: UNKNOWN` for hours and GitHub
created **no `pull_request` workflow runs** for new pushes (only
`pull_request_target` CLA runs) — no merge ref, no runs. `gh pr close N && gh
pr reopen N` forces mergeability recompute and fires the queued runs.
Related: [[reference_park_diagnosis_check_runs_on_sha_not_run_jobs]].
