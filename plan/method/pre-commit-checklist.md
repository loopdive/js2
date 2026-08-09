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
10. [ ] **Never `git commit --no-verify`.** If the full pre-commit chain is too
        slow for your tool timeout (test:changed-root + ratchets take minutes),
        commit with `SKIP_SLOW_PRECOMMIT=1 git commit …` instead — that keeps
        the seconds-cheap prettier/biome gate (lint-staged) and skips only the
        slow checks, which CI runs anyway. `--no-verify` skips EVERYTHING, and
        that is how PR #4100 shipped an unformatted file to a failing `quality`
        lane (2026-08-04 post-mortem).

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

## Never pipe a command whose exit status you need (#3880)

11. [ ] If you checked `$?` after a command, make sure it wasn't behind a pipe.

`cmd | tail -4; echo $?` reports **`tail`'s** status, not `cmd`'s — so a script
that crashed reads as a clean success. This is not a hypothetical: on 2026-07-31
it made two failed `claim-issue.mjs` operations look clean (nearly leaving an
issue permanently claimed by a departed agent) and printed `EXIT=0` for a
pre-dispatch gate that had actually said **STOP**. Three agents hit it in one
session, one with the rule already written in their own memory — so vigilance is
not the fix; the mechanics are.

Use any of:

```bash
cmd > out.txt 2>&1; echo "EXIT=$?"    # no pipe at all
cmd | tail -4; echo "EXIT=${PIPESTATUS[0]}"
set -o pipefail                        # then $? is the first failing stage
```

**And prefer verifying the EFFECT over the exit code.** For anything that writes
shared state, read the state back (`claim-issue.mjs --check <id>`,
`git ls-remote`, `gh pr view`). A push can land while git reports failure, and a
write can fail while the caller sees 0 — both were observed the same day.

## Re-run gates after every edit, not once per branch (#3880)

12. [ ] If you edited files after the last gate run, run the gates again.

"I ran the gate" can be **true and stale at the same time**. On 2026-07-31 a dev
ran `node scripts/update-issues.mjs --check` (green), then added two more doc
commits, and `quality` failed on the second one. This is not the usual
stale-shared-state failure — it is your own verification aging against your own
work, which feels safe precisely because you did check.

**The specific trap that caused it:** the #1616 link gate resolves any
`plan/issues/<digits>-<slug>.md`-shaped string **anywhere under `plan/`** as a
link to a real file. A **glob** — `plan/issues/` followed by a number, a dash and
a `*` — is the natural way to refer to an issue file in prose, and it resolves to
nothing, so `quality` fails. Write `#2916`, or the full real filename, instead.

Two measurements worth keeping:

- Four glob-shaped paths exist on `main`, and every one of them is in a comment
  under `scripts/`, which the gate does not scan. That is why no file under
  `plan/` had ever hit this.
- **This very warning triggered the trap while being written.** The first draft
  spelled the bad example out literally, in `plan/method/`, and the gate failed
  on it — after the author had already run the gate once and moved on. If you
  need to show the shape, use a placeholder like `<id>` where the digits go.

## Commit verification

End your commit message with a **✓** (checkmark) once you've completed the checklist. The pre-commit hook rejects commits without it.

## Red flags (stop and ask tech lead)

- You see deletions of `tests/issue-*.test.ts` files you didn't create
- You see reversions in `src/runtime.ts`, `src/codegen/expressions.ts`, or other shared files
- `pwd` shows `/workspace` instead of your worktree path
- `git branch` shows `main` instead of your issue branch
