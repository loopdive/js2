# Releasing

This repo publishes two npm packages in lockstep:

- **`@loopdive/js2`** — the scoped package (repo root `package.json`).
- **`js2wasm`** — an unscoped proxy that re-exports `@loopdive/js2`
  (`packages/js2wasm/package.json`).

Both are published by `.github/workflows/publish-npm.yml`, which triggers on a
`v*` git tag push and also publishes to JSR.

## The drift bug this flow fixes (loopdive/js2wasm#389)

Releases used to be cut as a bare lightweight tag — `git tag vX.Y.Z` — that
**never bumped `package.json`**. But `publish-npm.yml` publishes **whatever
`version` field `package.json` carries at the tagged commit**, not the tag name.
So the published version stayed pinned at `0.52.0` across thousands of commits,
and anyone building from the clone read a stale `0.52.0`. An external tester hit
this on loopdive/js2wasm#389.

The fix has two parts:

1. **A bump step that actually edits `package.json`** — `scripts/release.mjs`,
   which sets BOTH packages to the same explicit version.
2. **A CI guard** — the `verify-version` job in `publish-npm.yml` fails the
   publish unless the tag version equals BOTH `package.json` versions. This
   catches both the original drift bug and a forgotten lockstep proxy bump.

**Version tags are release-only.** The 44 legacy `v0.*` tags that caused #389
came from an old per-sprint / manual version-tagging habit. To prevent a repeat,
`vX.Y.Z` tags are cut **exclusively** via `node scripts/release.mjs <x.y.z>` (the
flow below). **Sprint-end must NOT create a version tag** — the sprint protocol
tags only `sprint/N` (+ `sprint-N/begin`); see `CLAUDE.md` and
`.claude/skills/sprint-wrap-up/SKILL.md`. Never `git tag vX.Y.Z` outside this flow.

## How to cut a release

1. **Bump both packages, commit, and tag — in one step, on a clean tree:**

   ```bash
   node scripts/release.mjs <x.y.z>        # explicit version, e.g. 0.53.0
   # or a semver keyword, computed from the current root version:
   node scripts/release.mjs patch          # 0.52.0 -> 0.52.1
   node scripts/release.mjs minor          # 0.52.0 -> 0.53.0
   node scripts/release.mjs major          # 0.52.0 -> 1.0.0
   ```

   (`pnpm run release <x.y.z>` works too.) The script resolves a single concrete
   target version `V` and applies the **same** string to the root package and the
   `packages/js2wasm` proxy via `pnpm version --no-git-tag-version`, so the two
   can't diverge. It asserts both versions match, then makes **one** commit
   `release: vV` containing both `package.json` files (plus `pnpm-lock.yaml` if it
   changed) and **one** annotated tag `vV` pointing at that commit. This is the
   plain `pnpm version` experience, but covering both packages in a single
   commit + tag.

   The script refuses to run on a dirty tree (so the release commit contains only
   the version bump) and refuses if the tag already exists. It does **not**
   push — see the warning below.

2. **Review the commit and tag:**

   ```bash
   git show vX.Y.Z      # the release: vX.Y.Z commit + the bumped package.jsons
   ```

3. **Push the BRANCH and open a `release: vX.Y.Z` PR — do NOT push the tag yet.**

   ```bash
   git push origin <your-branch>          # pushes the branch + its commits
   gh pr create --base main --title "release: vX.Y.Z" ...
   ```

   > ⚠️ **Never `git push --tags` / `--follow-tags` before the PR merges.**
   > `publish-npm.yml` fires on **any** `vX.Y.Z` tag push and would publish
   > un-reviewed code. Push the branch only; the tag stays local until merge.

4. **After the PR merges, push the tag to trigger publish:**

   ```bash
   git fetch origin
   git push origin vX.Y.Z
   ```

   The tag push triggers `publish-npm.yml`. Its `verify-version` job strips the
   leading `v`, reads both `package.json` versions, and **fails the publish if
   either differs** from the tag. Only when they match does it publish
   `@loopdive/js2`, the `js2wasm` proxy, and JSR.

## Why the tag travels with the branch (and the merge-method dependency)

The script tags the release commit **on your branch**, and the tag stays valid
after merge because the merge queue uses a **merge commit** (`mergeMethod = MERGE`,
confirmed for this repo) — the merge commit keeps your tagged commit reachable in
`main`'s history. So you push the same `vX.Y.Z` tag after merge and it points at a
commit that _is_ on `main`.

> **If the repo ever switches `main` to squash or rebase merges**, the branch
> commit (and therefore the branch tag) would be rewritten or dropped on merge,
> leaving the tag dangling off `main`. In that case this flow must change to
> _tag the merge commit_ after it lands (`git tag vX.Y.Z <merge-sha>`) rather
> than tagging on the branch. The `verify-version` guard is the backstop either
> way: a tag pointing at the wrong commit fails the publish instead of shipping a
> stale version.

## `workflow_dispatch` dry-run

`publish-npm.yml` can be run manually via `workflow_dispatch` for a pack/publish
dry-run. There's no version tag on that path, so `verify-version` is skipped and
the dry-run proceeds without the tag check.
