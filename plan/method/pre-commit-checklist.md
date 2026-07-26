# Pre-Commit Checklist

**Read this before every `git add` and `git commit`. The hook injects a reminder automatically.**

## Before staging

1. [ ] Run `pwd && git branch --show-current` — verify you are in YOUR worktree on YOUR branch
2. [ ] **Never** use `git add -A` or `git add .` — always `git add <specific files>` (hook blocks this)
3. [ ] Run `git diff --stat` — review what you're about to stage
4. [ ] Check for accidental deletions: if any files show as deleted that you did NOT delete, do NOT stage them
5. [ ] Check for files outside your issue scope — don't stage changes to files you didn't intentionally edit

## Before committing

6. [ ] Run `git diff --cached --stat` — verify only your intended changes are staged
7. [ ] No test files from other issues being deleted
8. [ ] No source files being reverted to old versions
9. [ ] Commit message references your issue number (#N)

## Lint suppressions — this project uses BIOME, not ESLint

10. [ ] If you suppressed a lint rule, verify the suppression actually works:
        `npx biome lint src tests scripts --diagnostic-level=error`

Two ways a suppression silently does nothing (both cost a CI cycle on #3603):

- **`// eslint-disable-next-line …` is INERT here.** The `quality` and
  `cheap gate` lanes run `biome lint src tests scripts`. An eslint pragma is
  just a comment — it suppresses nothing, and the failure looks like the rule
  ignoring your suppression rather than the suppression not existing. The
  correct form is:

  ```ts
  // biome-ignore lint/<group>/<rule>: <reason>
  ```

- **The pragma must sit on the line DIRECTLY ABOVE the offending statement.**
  Prose between the pragma and the statement breaks it. Put the explanation
  _above_ the pragma, never between it and the code:

  ```ts
  // Why this delete is deliberate: … (explanation goes here, above the pragma)
  // biome-ignore lint/performance/noDelete: reproduces test262 realm mutation
  delete (WeakMap.prototype as any).get;
  ```

A suppression that silently does nothing is the same failure family as a gate
that is never read: the outcome is identical to "the rule rejected me", so you
debug the wrong thing.

## Commit verification

End your commit message with a **✓** (checkmark) once you've completed the checklist. The pre-commit hook rejects commits without it.

## Red flags (stop and ask tech lead)

- You see deletions of `tests/issue-*.test.ts` files you didn't create
- You see reversions in `src/runtime.ts`, `src/codegen/expressions.ts`, or other shared files
- `pwd` shows `/workspace` instead of your worktree path
- `git branch` shows `main` instead of your issue branch
