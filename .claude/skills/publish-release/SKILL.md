---
name: publish-release
description: Cut and publish a versioned release of @loopdive/js2 + the js2wasm proxy — bump both manifests in lockstep, land a reviewed release PR, then push the vX.Y.Z tag that triggers npm/JSR publish. Use this whenever the user wants to release, publish, ship, cut, or tag a version, bump the version number, push a release tag, cut a patch/minor/major, cut release notes, or get a fix onto npm — even if they only say "ship it" or name a version like "0.70.0" without saying the word release. Also use it when a publish failed on verify-version, when a vX.Y.Z tag needs pushing or re-pushing, or when someone is about to run `git tag vX.Y.Z` by hand (that is the bug this skill exists to prevent).
---

# /publish-release — cut a release and push the version tag

Two npm packages ship in lockstep, plus JSR:

| package | manifest |
| --- | --- |
| `@loopdive/js2` | root `package.json` |
| `js2wasm` (proxy that re-exports the scoped package) | `packages/js2wasm/package.json` |

`.github/workflows/publish-npm.yml` fires on **any** `v*` tag push and publishes
all three. The authoritative reference is
[`docs/releasing.md`](../../../docs/releasing.md); this skill is the operator
protocol on top of it.

## The one thing that makes this dangerous

**Pushing the tag IS the publish.** There is no confirmation step and no
practical undo — npm unpublish is heavily restricted, and JSR versions are
immutable. Everything below exists so the tag goes up exactly once, pointing at
reviewed code that is already on `main`.

So the ordering is not stylistic:

> **Push the branch. Get it merged. Only then push the tag.**

A tag pushed before merge publishes un-reviewed code to the public registry.

## Never hand-write a version tag (#389)

`git tag vX.Y.Z` on its own is the bug this flow was built to kill. The publish
workflow ships **whatever `version` field `package.json` carries at the tagged
commit** — not the tag name. Releases used to be bare tags that never touched
the manifest, so the published version sat pinned at `0.52.0` across thousands
of commits while the tags kept climbing. An external tester found it.

Two consequences worth holding onto:

- Version tags come **exclusively** from `scripts/release.mjs`. If you catch
  yourself typing `git tag v…`, stop — you are re-introducing #389.
- Sprint-end tags `sprint/N`, never `vX.Y.Z`. The two are unrelated.

## Step 1 — bump, commit, tag (one command, clean tree)

```bash
node scripts/release.mjs 0.70.0     # explicit version
node scripts/release.mjs patch      # or a semver keyword: patch | minor | major
```

The script resolves one concrete version and applies the **same string** to four
places: the root manifest, the proxy manifest, the proxy's
`dependencies["@loopdive/js2"]`, and `jsr.json` (which carries its own version
field and is what JSR publishes). Then it makes one commit
`release: vX.Y.Z` and one annotated tag `vX.Y.Z` on your branch. It also drafts
`docs/release-notes/vX.Y.Z.md` from the commit subjects since the last release
tag, amends it into the commit, and re-points the tag.

It refuses a dirty tree (so the release commit is only the bump) and refuses if
the tag already exists. **It does not push** — deliberately.

Read the NEXT STEPS block it prints; it is generated against the actual remote
you have and is more current than any transcription.

## Step 2 — review what it produced

```bash
git show vX.Y.Z --stat
```

Confirm the diff is exactly these, and nothing else:

| file | what moved |
| --- | --- |
| `package.json` | version |
| `packages/js2wasm/package.json` | version **and** the `@loopdive/js2` dependency pin |
| `jsr.json` | version |
| `docs/release-notes/vX.Y.Z.md` | the drafted notes |

Plus `pnpm-lock.yaml` if it moved. `jsr.json` surprises people — it is a real,
intended part of the bump, not stray noise.

The drafted notes open with two generated sections:

- **Summary** — counts by type, the most active scopes, how many issues were
  referenced, and how many automated baseline/artifact commits were left out.
- **Conformance** — test262 pass/total, with the delta against the previous
  release tag. If that tag's baseline is unreadable (shallow clone, missing
  tag) the section says so instead of showing a delta; leave that sentence in
  rather than filling the gap with a number you did not measure.

**Then edit the file, before the PR.** The summary counts commits — it does not
read diffs, so it reports volume, not significance. Lead with the two or three
changes a user would actually notice and cut the rest; the grouped lists are
raw material. If you add conformance figures of your own, carry the denominator
and say which artifact they came from and when — a bare "74.8%" is
unattributable a month later.

## Step 3 — push the BRANCH and open the release PR

```bash
git push -u origin <branch>          # branch only — no --tags, no --follow-tags
```

Open a PR titled `release: vX.Y.Z` against `main`. Follow the normal PR rules:
issue references in the body link to the website issue page rather than a bare
`#NNNN` (PR and issue numbers share one sequence, so a bare number points at an
unrelated PR).

Then let it go green and merge like any other PR — the server-side
`auto-enqueue.yml` enqueues it. Do not enqueue by hand.

> `git push --tags` and `git push --follow-tags` are the two commands that turn
> a routine push into an unreviewed publish. Push the branch by name.

## Step 4 — after merge, prove the tagged commit is on main

The tag was created on your branch. It stays valid only because the merge queue
uses **merge commits**, which keep your commit reachable from `main`. Verify
rather than assume — if the repo ever switches to squash or rebase, your tagged
commit is rewritten and the tag would point at an orphan:

```bash
git fetch origin main
git merge-base --is-ancestor vX.Y.Z^{commit} FETCH_HEAD && echo IN-MAIN
```

No `IN-MAIN`? **Do not push the tag.** Re-tag the merge commit that actually
landed (`git tag -f -a vX.Y.Z <merge-sha> -m vX.Y.Z`) and re-run the check.

## Step 5 — push the tag (this publishes)

```bash
git push --no-verify origin refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
git ls-remote --tags origin refs/tags/vX.Y.Z    # verify it LANDED
```

The explicit `refs/tags/…:refs/tags/…` refspec matters: a bare
`git push origin vX.Y.Z` can resolve as a branch refspec and report
`Everything up-to-date` while pushing nothing. `--no-verify` skips the local
pre-push gate, which CI re-runs anyway.

**Check the effect, not the exit code.** Git can report failure on a push that
landed, and the reverse. `ls-remote` is the answer.

## Step 6 — put the real notes on the GitHub release

Once the publish workflow finishes it creates the GitHub release with
`--generate-notes` — GitHub's raw auto-generated commit list, which is not what
you spent Step 2 writing. Replace it:

```bash
gh release edit vX.Y.Z -R loopdive/js2wasm --notes-file docs/release-notes/vX.Y.Z.md
gh release view vX.Y.Z -R loopdive/js2wasm --json body      # verify it landed
```

`edit`, not `create` — the workflow already created it.

## What CI checks before it publishes

`verify-version` strips the leading `v` and refuses to publish unless **all
three** match the tag:

- root `package.json` version
- `packages/js2wasm/package.json` version
- the proxy's `dependencies["@loopdive/js2"]`

**`jsr.json` is bumped but not checked.** The guard covers the three npm-side
values only, while the JSR publish reads `jsr.json`. `release.mjs` keeps it in
lockstep, so this is only a gap if someone edits versions by hand — which is
the same habit the whole flow exists to discourage. Worth an eye during Step 2.

A failure here means the tag and the manifests disagree — almost always a
hand-cut tag, or a bump that missed the proxy. The fix is never to force the
tag: delete it, re-run `scripts/release.mjs`, and land a corrected release PR.

The three publish targets (npm scoped, npm proxy, JSR) are independent and each
re-runnable, so one failing registry does not block the others.

## Dry run

`publish-npm.yml` accepts `workflow_dispatch` with a `dry-run` input for a
pack/publish rehearsal. There is no tag on that path, so `verify-version` is
skipped — a green dry-run says the packages *build and pack*, not that the
versions are consistent. Only a real tag push exercises the version guard.

## Environment gotchas

- **`gh` is not installed in the remote-session containers.** Use the GitHub MCP
  tools for PR and release operations. `git` itself works normally.
- **Tag pushes can be rejected `HTTP 403` where branch pushes succeed.** Remote
  Claude Code sessions are commonly scoped to branch writes only. Confirm it is
  not the egress proxy — `curl -sS "$HTTPS_PROXY/__agentproxy/status"` showing
  `recentRelayFailures: []` means the refusal came from GitHub — then hand the
  tag push to someone with tag permission rather than trying to route around it.
  Leave the tag created locally and say plainly that the release is un-published
  and why; a half-finished release that reads as done is worse than a blocked one.

## Done means

- `git ls-remote --tags origin refs/tags/vX.Y.Z` returns the tag.
- The publish workflow is green, including `verify-version`.
- `npm view @loopdive/js2 version` and `npm view js2wasm version` both report the
  new version.
- The GitHub release shows the curated notes, not the auto-generated list.

If any of these is not true, the release is not finished — report which one and
why, rather than reporting a version that is not installable.
