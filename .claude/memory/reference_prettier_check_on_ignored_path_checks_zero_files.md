---
name: reference_prettier_check_on_ignored_path_checks_zero_files
description: "`prettier --check` on a path inside .prettierignore (incl. the project-sanctioned `.tmp/` scratch dir) checks ZERO files and still prints 'All matched files use Prettier code style!' — a pass indistinguishable from a real one. Use --ignore-path /dev/null for out-of-home checks."
metadata:
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-03T22:34:11.728Z
---

Measured 2026-08-04 on PR #4096 (#4061). The dev validated its patch copies
under `.tmp/` and reported "prettier --check clean" for the whole PR; CI's
format lane then failed on one of exactly those files.

## The trap

`.tmp/` is in `.prettierignore`. Prettier silently skips ignored paths and
prints the identical success banner either way:

```
$ npx prettier --check /…/.tmp/patch/tests/issue-4061.test.ts
Checking formatting...
All matched files use Prettier code style!     <- checked ZERO files
```

Byte-identical file checked as `tests/issue-4061.test.ts` from the repo root:
**fails**. Only the path differed; the "pass" was a check of nothing.

**The trap is built into the recommended workflow**: `.tmp/` is the
project-sanctioned scratch location, so any agent validating scratch copies —
including patch-handoff flows where the patch lives in `.tmp/` — hits this by
default.

## The rule

> A formatter/linter "pass" on a file outside its repo-relative home is
> unverified until the tool is forced to actually match it.

```bash
npx prettier --check --ignore-path /dev/null <file>   # for out-of-home checks
```

Or check the real repo-relative path in the real tree. Verify the tool
matched ≥1 file — the silent-empty floor-the-count rule applies to format
checks too.

Every earlier "clean" claim made through the ignored path was vacuous; the
files that were fine were fine by luck, proven only by CI's own lane.

Related: [[reference_silent_empty_is_indistinguishable_from_real]],
[[reference_grep_dollar_anchor_and_shell_expansion_false_empty]],
[[reference_broken_instrument_can_still_give_right_answer]].
