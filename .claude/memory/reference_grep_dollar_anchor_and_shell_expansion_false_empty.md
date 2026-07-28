---
name: reference_grep_dollar_anchor_and_shell_expansion_false_empty
description: "Grepping for shell/CI text containing `$` silently returns ZERO — `$` is a regex end-anchor, and `\"$var\"` in double quotes is expanded by the shell first. Not a ugrep bug; `\\|` alternation works fine here."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-26T21:26:41.983Z
---

**Symptom:** you grep a file for a string you can see in it, and get a
confident **0 / empty**. It reads exactly like "the change didn't land."

**Measured 2026-07-26** against `.github/workflows/test262-sharded.yml` on
`upstream/main`, which provably contains `wait $pid_tc` at line 185:

| # | pattern as typed | matches |
|---|---|---|
| A | `grep -c 'wait \$pid_tc\|wait \$pid_lint'` (single-quoted, `$` escaped) | **2** ✓ |
| B | `grep -c "wait \$pid_tc\|wait \$pid_lint"` (**double**-quoted) | **0** ✗ |
| C | `grep -c 'wait $pid_tc\|wait $pid_lint'` (`$` **unescaped**) | **0** ✗ |

Two independent causes, both silent:

- **C — `$` is an end-of-line anchor.** `wait $pid_tc` means *"`wait ` then
  end-of-line, then `pid_tc`"*, which can never match. Escape it: `\$`.
- **B — double quotes expand first.** The shell substitutes `$pid_tc` (unset →
  empty) before `grep` ever sees the pattern. **Single-quote grep patterns
  containing `$`**, always.

**NOT the cause: ugrep.** This container's `grep` is ugrep 7.5.0, and BRE
alternation `\|` works correctly — verified with a positive control
(`grep -c 'alpha\|beta'` → 2) and a negative control (unescaped `|` → 0). A
2026-07-26 report blamed ugrep's `\|` for exactly this false empty; that
explanation is **falsified**. The false empty was real, the diagnosis was not —
same error shape as
[[reference_workflow_touching_prs_never_autoenqueue]]: a plausible mechanism
accepted without varying the suspected variable.

**Why it bites hardest:** CI/workflow/shell files are *full* of `$`. This is
precisely the corpus you grep when verifying that a CI fix landed — so the
failure mode is concentrated exactly where a false "didn't land" is most
expensive, and it is indistinguishable from the real thing
([[reference_silent_empty_is_indistinguishable_from_real]]).

**Cures:**

- Single-quote the pattern; escape `$` as `\$`; or use `grep -F` for a fixed
  string, which sidesteps all regex metacharacters.
- `rg` is installed (ripgrep 13.0.0) and takes a literal with `-F` too.
- **Floor the expectation**: know the count you expect (≥1) *before* running,
  and treat 0 as "my pattern is wrong" until proven otherwise.
- Best: don't grep at all — `git show <ref>:<file> | sed -n 'A,Bp'` and read
  the lines ([[reference_origin_is_the_fork_verify_against_upstream_main]]).

Related: [[reference_grep_false_empties_diff_test262]] ·
[[reference_git_show_ref_glob_no_expand_use_ls_tree]]
