---
id: 3410
title: "Private labs pre-push guard misses the legacy public js2wasm origin URL"
status: done
completed: 2026-07-23
created: 2026-07-18
updated: 2026-07-19
priority: critical
horizon: s
feasibility: easy
reasoning_effort: high
task_type: infrastructure
area: tooling
language_feature: n/a
goal: reliability
sprint: 75
related: [3409]
origin: "2026-07-18 codebase engineering audit publication preflight (plan/log/2026-07-18-codebase-engineering-audit.md, F9)"
---

# #3410 — close the legacy-origin bypass in the private-labs guard

## Problem

The first responsibility of `.husky/pre-push` is to stop any `labs/` path from
being pushed to the public repository. It classifies a remote as public only
when its URL matches the canonical post-rename path:

```sh
case "$remote_url" in
  *loopdive/js2.git|*loopdive/js2) is_public=1 ;;
  *) is_public=0 ;;
esac
```

(`.husky/pre-push:20-34`). The normal `origin` in this repository is still:

```text
https://github.com/loopdive/js2wasm.git
```

GitHub redirects that legacy repository name to the same public `loopdive/js2`
repository, but the local shell matcher does not. `is_public` is therefore zero
and the entire private-path diff scan is skipped for the standard origin. Public
fork URLs are likewise outside the two accepted patterns.

This is a verified safety-control bypass. The audit did not stage or push any
`labs/` content and observed no disclosure; the defect is that the guard does
not run on a normal public destination.

## Scope

- Recognize both canonical and legacy upstream URLs across HTTPS, SSH, and SCP
  syntax.
- Protect public forks as well as the upstream repository.
- Make the allow/deny model explicit and fail safely when destination visibility
  cannot be inferred offline.
- Keep the private `loopdive/js2wasm-labs` remote usable for intentional labs
  pushes.
- Add tests without reading, staging, or publishing real private content.

## Implementation steps

1. Extract remote classification and forbidden-path scanning into testable shell
   helpers or a small cross-platform script.
2. Normalize URL syntax, optional `.git`, and the known `js2wasm` → `js2` legacy
   alias before classifying the destination.
3. Prefer an explicit private-destination allowlist/configuration: the known
   labs repository is allowed; canonical upstream, legacy upstream, and public
   forks are blocked for `labs/` paths. Define the behavior for unknown remotes
   deliberately rather than defaulting them to safe.
4. Preserve new-branch and existing-branch diff calculation, then test both
   paths with synthetic object IDs and fixtures named under `labs/`.
5. Emit the normalized destination and classification in the block diagnostic
   so contributors can see why a push was refused.
6. Add `tests/hooks/pre-push-labs-remote.test.ts` (or the established hook-test
   location) covering all supported URL forms and `--no-verify` documentation.

## Acceptance criteria

- [ ] `labs/` changes are blocked when pushing to `loopdive/js2` through HTTPS
      or SSH.
- [ ] The legacy `loopdive/js2wasm` origin URL receives the identical block.
- [ ] A public fork URL cannot bypass the guard.
- [ ] The explicit private labs remote still permits intentional labs pushes.
- [ ] Unknown or malformed remote URLs follow a documented fail-safe policy and
      cannot silently masquerade as non-public.
- [ ] Tests exercise new-branch, update, and delete ref inputs without touching
      actual private files or a network remote.

## Validation plan

- Table-driven remote-classification tests for canonical/legacy HTTPS, SSH URL,
  SCP syntax, public fork, labs remote, local path, and malformed URL.
- Synthetic pre-push stdin tests with one `labs/example.txt` fixture and one
  ordinary public path for both new and existing branch ranges.
- Verify the exact current `origin` URL is classified as public.
- Verify `git push labs <branch>` remains allowed in the synthetic harness.
- Existing hook tests, shell lint, and issue-integrity checks.

## Dependencies

- Coordinate with #3409 because both change `.husky/pre-push`; they can share a
  portable hook-test harness but have independent acceptance criteria.
- PR #3355 does not modify Husky pre-push today, but avoid colliding if its hook
  test infrastructure changes before this lands.

## Risks

- Treating every unknown remote as public is confidentiality-safe but may block
  legitimate pushes to another private labs mirror. Provide an explicit,
  reviewable allowlist rather than a permissive default.
- URL string matching alone can drift on future repository renames. Centralize
  repository identity aliases and cover them with tests.
- `--no-verify` necessarily bypasses client-side protection. Server-side secret
  scanning and repository separation remain defense in depth, but do not replace
  a correct local guard.
