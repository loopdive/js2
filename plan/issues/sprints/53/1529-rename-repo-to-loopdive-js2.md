---
id: 1529
sprint: 53
title: "Rename repository loopdive/js2wasm → loopdive/js2 and align branding"
status: ready
created: 2026-05-20
priority: medium
feasibility: easy
reasoning_effort: low
task_type: ops
area: ops, docs
goal: contributor-readiness
related: []
---

# #1529 — Rename repository loopdive/js2wasm → loopdive/js2 and align branding

## Problem

The public URL is now `https://js2.loopdive.com` and the npm package is
`@loopdive/js2` (`package.json:2`). The GitHub repo is still named
`loopdive/js2wasm`. Several docs reference both names interchangeably:

- `package.json` `repository.url`: `github.com/loopdive/js2.git` (already
  the target name — points at a repo that doesn't exist yet)
- `package.json` `bugs.url`: `github.com/loopdive/js2/issues`
- `README.md` and `CLAUDE.md`: `loopdive/js2wasm`
- `ROADMAP.md`: `github.com/loopdive/js2wasm`
- `.gitmodules`, `CHANGELOG.md`, `CONTRIBUTING.md`: mixed

Anyone visiting the URLs from `package.json` today hits a 404.

## Acceptance criteria

1. **GitHub rename**: `loopdive/js2wasm` → `loopdive/js2`. GitHub will
   set up a permanent redirect for the old URL, so existing clones and
   PR links continue to work, but new clones and CI should use the new
   name.
2. **Update every in-repo reference** to the old slug:
   - `README.md`, `ROADMAP.md`, `CONTRIBUTING.md`, `CHANGELOG.md`,
     `CLAUDE.md`, `AGENTS.md`, `CODEOWNERS`, `.gitmodules`,
     `docs/**/*.md`, every workflow under `.github/workflows/*.yml`
     that uses the slug, `dashboard/`, `plan/method/*.md`.
   - Use `git grep -l "loopdive/js2wasm"` as the work list; expect a
     hundred-ish hits.
3. **Update remotes**:
   - `.git/config` `origin` URL → `git@github.com:loopdive/js2.git`
     (this is per-clone, not committed).
   - Any workflow that hard-codes `loopdive/js2wasm` updates to
     `loopdive/js2` (the redirect would work, but explicit is better).
4. **CNAME**: confirm the `CNAME` file at repo root still points at the
   correct hostname (`js2.loopdive.com`).
5. **npm**: `package.json` already says `@loopdive/js2`; verify the next
   publish lands under the right name.
6. **Baselines repo**: rename `loopdive/js2wasm-baselines` →
   `loopdive/js2-baselines` (separate but related; if delayed, document
   so the cross-repo refs in `test262-sharded.yml` are updated in
   lockstep).
7. **Communication**: a short note in the next release CHANGELOG entry
   about the rename and the old-URL redirect.

## Implementation notes

- The rename itself is a repo-admin action and cannot be done from a PR.
  This issue's PR delivers the documentation + workflow updates; the
  actual rename happens in the GitHub UI by an admin.
- After rename, watch the CI workflows for hardcoded slugs — some
  GitHub Actions context variables resolve to the new name
  automatically, others (e.g. `gh repo view loopdive/js2wasm`) do not.
