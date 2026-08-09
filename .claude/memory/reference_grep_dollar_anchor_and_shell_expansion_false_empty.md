---
name: reference_grep_dollar_anchor_and_shell_expansion_false_empty
description: "Grepping for shell/CI text containing `$` silently returns ZERO — `$` is a regex end-anchor, and `\"$var\"` in double quotes is expanded by the shell first. Not a ugrep bug; `\\|` alternation works fine here."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-01T10:50:53.026Z
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

---

## Third silent cause — a NUL byte makes grep treat the file as BINARY (2026-07-31)

**Measured** while extracting per-path rows from a `test262-merged-report`
artifact: `grep` returned **0 matches** on a file that plainly contained the
string. Cause: **one NUL byte anywhere in the file** makes `grep` classify it as
binary, so it suppresses match output instead of printing lines.

**Cure: `grep -a`** (`--text`), which forces text treatment. `rg -a` likewise.

**Why this one is nastier than A/B/C above:** those are *pattern* bugs — vary the
pattern and the count changes. This is a *file-classification* bug, so the pattern
is correct, the data is correct, and the zero is still wrong. Nothing you do to
the regex will reveal it. The tell is a zero on a file you have independent reason
to believe contains the string.

Applies to any grep over CI artifacts, JSONL dumps, or downloaded reports — data
you did not author and cannot assume is clean text.

Eighth member of tonight's "authoritative-looking zero/green that isn't real"
family. See [[reference_silent_empty_is_indistinguishable_from_real]] and
[[feedback_baseline_drift_cross_check]].

---

## Fourth cause — searching the WRONG REPRESENTATION, so zero was guaranteed

**Measured 2026-07-31.** A probe grepped emitted **WAT text** for a refusal's error
*message string* and found **0 occurrences**, which was filed as "the refusal is
never reached." The message lives in the module's **string pool**, not in WAT
instructions — **zero was structurally guaranteed whether or not the refusal ran.**
Dumping the wrapper verbatim showed the refusal *was* reached and *did* emit its
`throw`.

This is the strongest form of the family, because pattern, tool and data are all
fine — the probe was simply looking at a representation that could never contain
the thing.

> **Before believing a zero, ask: could this probe have returned NON-zero?**
> If you cannot name the input that would have made it fire, the zero is not
> evidence. Bind a known-present case first (positive control) — the same rule as
> [[reference_silent_empty_is_indistinguishable_from_real]], applied to *where you
> look* rather than *what you type*.

**Corollary for compiled artefacts:** strings, names and metadata usually live in
side tables (string pool, name section, type section), not the instruction stream.
**Grep the disassembly for opcodes; dump the function body for behaviour.** To
attribute emitted code to its producer, use a **marker bisect** — put a unique
sentinel in each candidate emitter and see which survives to output — rather than
reading source and reasoning. On one codepath that night, **three** confident
attributions from source-reading were all wrong.

---

## Fifth cause — a PAGING WINDOW, not an absence

**Measured 2026-07-31.** `gh run list --limit 25` filtered for `gh-readonly-queue`
branches returned **zero**, and was read as "no merge_group runs are executing —
the queue is blocked." It was executing fine: the PR merged four minutes later.

**A recent-runs page is dominated by high-frequency workflows** (CI, auto-enqueue,
approve-fork-runs fire several times per push), so low-frequency runs fall off the
end of the window *while actively running*.

```bash
gh api 'repos/OWNER/REPO/actions/runs?event=merge_group'   # filter at the source
```

> **"Absent from a recent-N page" is not "did not run."** Filter server-side by the
> attribute you care about; never infer absence from a truncated list.

This nearly caused a live PR to be dequeued from the merge queue mid-validation.
What prevented it was the instruction **"confirm the mechanism before acting"** —
worth keeping as a standing rule for any destructive remedy proposed off a
diagnosis.

## Sixth cause — `gh api contents/` SILENTLY TRUNCATES at 1000 entries

**Measured 2026-07-31.** `gh api "repos/O/R/contents/plan/issues?ref=main"` returned
**zero** `39xx` files — and zero `38xx` files, though several demonstrably exist. The
directory has 3,364 entries; the endpoint caps at **1000** with no error and no
truncation flag in the payload.

```bash
gh api "repos/OWNER/REPO/git/trees/main:plan/issues"   # 3364 entries, truncated:false
```

Use the **git trees** endpoint for any directory that might exceed 1000 entries, and
check its `truncated` field. A positive control on a *different* range is what caught
this — the first range returning 0 looked plausible.

## Seventh — a TRUE empty, with a WRONG inference drawn from it

**Measured 2026-07-31.** An agent checked whether a swallow-on-failure bug was fixed
on `main` by grepping for the old call `gitTry(["ls-tree", …])`. **Zero hits — and
that was correct**: a merged PR had renamed the call to the non-throwing `git(...)`.
But the swallow itself was **still there** — `main` still read `if (!ls.ok) return
out;`.

> The grep was **true**. The inference was **false**. *A correct observation about a
> proxy, treated as a fact about the thing.*

**Grep for the MECHANISM, not the NAME** — the failing predicate, the returned
sentinel, the swallowed branch. Names change while behaviour persists, and a rename
turns a real check into a vacuous one silently.

Same family as reading `MERGED` + a matching `headRefOid` as proof your commit
landed: both are true statements about the wrong object.

## Eighth — YOUR OWN `head`/`tail` truncation, generalised into a claim

**Five times in one session (2026-08-01), across two actors.** Not a tool defect — a
self-inflicted window, then a conclusion drawn from the visible fragment.

| truncation | claim it produced | truth |
|---|---|---|
| `git stash list \| head -12` | "the stack is 12 entries" | **16** |
| `gh pr create … \| tail -5` | silence read as "it ran" | **no PR created**; the error was eaten |
| `head -70` of a stash's file list | "`stash@{10}` is CI workflows and planning artifacts" | the **largest** entry, 406 lines of real compiler source, never analysed |
| `tail -140` of an analyzer log | a verdict for rows the log never covered | — |
| a **stalled** analyzer run | six rows marked SUPERSEDED | the pass **never analysed them at all** |

> **Each time the visible fragment looked representative, and each time the unseen part
> was the part that mattered.** The fix is never a better instrument — it is reading the
> whole record before claiming, or stating explicitly which rows the evidence covers.

**Rules:**

- Never pipe a command whose **exit status or error** you need — `| tail` returns *tail's*
  status and swallows stderr. Redirect to a file and read it.
- Before quoting a count from a listing, check you did not window it. Print the total
  separately (`wc -l`) from the sample.
- If a tool run **stalls or is killed**, the rows it never reached are **unverified** —
  they are not "fine". Filling a verdict column and putting the caveat in prose below
  reads as hedging, not as *no data*.

Related shape: a **containment ratio is not a verdict** — one entry read "PARTIAL, 86%"
where every missing line was a comment. Split residue into **code vs prose** and read the
code. And a prose heuristic that covers only `md|json|txt` makes **YAML count as code**,
inflating residue enormously.

## Sibling shape — a CHECKER that passes over ZERO inputs

**Measured 2026-07-31.** `prettier --check <path under .tmp/>` printed **"All matched
files use Prettier code style!"** while checking **zero** files — the path is
gitignored and silently skipped. That false green nearly landed 40 files of
unrelated artifact churn in a PR.

> **A pass is only meaningful if the checker names how many inputs it saw.** Any
> linter/formatter/test runner can "succeed" over an empty set. Print the count, or
> pass a known-bad file first and watch it fail.

Same family as a green CI job that committed nothing, and as the five grep causes
above: the tool is fine, the *scope* was empty.

Related: [[reference_grep_false_empties_diff_test262]] ·
[[reference_git_show_ref_glob_no_expand_use_ls_tree]]
