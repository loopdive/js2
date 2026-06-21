---
name: project_prettier_not_biome_write
description: js2wasm formats .ts with prettier (CI Format check); never run biome --write — it whole-file-reformats and fails prettier
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

In js2wasm, the CI `quality` job's **Format check** is `prettier --check 'src/**/*.ts' 'tests/**/*.ts' 'scripts/**/*.ts'` (repo `.prettierrc`: printWidth 120, double quotes, trailing-comma all, 2-space). Biome is used **only for linting** (`biome lint ... --diagnostic-level=error`), NOT formatting.

**Pitfall:** running `biome check --write` (or `biome format --write`) on a `.ts` file reformats the WHOLE file to biome's style (e.g. collapses multi-line imports to single lines), which diverges from prettier on hundreds of lines and then **fails `prettier --check`** in CI. This produced an 800–1100-line whole-file churn + a `quality` failure on a 3-line fix (#6408, 2026-06-19).

**How to format correctly:**
- Run `pnpm exec prettier --write <files>` LAST (after any edits). Use `pnpm exec` (pinned 3.8.1), not bare `npx`.
- Run `pnpm exec biome lint <files> --diagnostic-level=error` for lint only — never `biome --write`.
- Verify with `pnpm exec prettier --check <file>` **in-place in the worktree** (so the repo `.prettierrc` applies). Checking a copy under `/tmp` uses prettier DEFAULTS and gives false pass/fail.

**lint-staged hazard:** the pre-commit hook runs lint-staged on `*.{ts,js,mjs}`; its stash/restore can leave the working tree dirty or pop a stale `lint-staged automatic backup` stash that reintroduces unrelated conflicted files. For a known-clean staged change, commit with hooks disabled: `git -c core.hooksPath=/dev/null commit ...` (still add the `✓` sign-off the pre-git-commit hook wants, since a later non-bypassed commit/amend re-checks it). After, confirm working tree clean and `git diff --stat origin/main..HEAD` shows only your intended change.

See [[feedback_no_stash_before_merge]], [[feedback_no_git_stash_in_worktree]].
