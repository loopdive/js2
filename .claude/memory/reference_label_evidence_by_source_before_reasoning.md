---
name: reference-label-evidence-by-source-before-reasoning
description: "Never emit ambiguous evidence and then reason over it — a combined multi-source command with one output stream produces results you cannot attribute, and attributing them anyway yields confident wrong conclusions"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-25T13:40:00.456Z
---

**Rule: one source per command, or label every line by its source. An
unattributable result is not evidence.**

Two confident-but-wrong conclusions in one session (2026-07-24/25), same root
cause — a query whose output could not be attributed, reasoned over as if it
could:

1. **Combined `git ls-remote origin` + `ls-remote upstream` in one command,
   single output stream.** One line came back; the command shape made it
   impossible to tell which remote produced it. It was attributed to `upstream`,
   then a follow-up upstream-only query returned absence, and the pair was read
   as "the branch was DELETED and the work abandoned." The branch was alive on
   the fork the whole time and actively advancing. On this repo "absent from
   upstream" is the **expected** state for any dev branch not yet PR'd (branches
   live on the `ttraenkler` fork) — so the normal case got read as the alarming
   one.
2. **A `grep` that silently returned nothing** on a file it treats as binary
   ([[reference_grep_false_empties_diff_test262]]) was read as "this mechanism
   does not exist here."

Both are the same shape: **absence/ambiguity treated as a positive finding.**

**Third instance, 2026-07-25 — a hand-rolled classifier that silently agreed with
itself.** A trap census grepped the runtime message for `/null reference/`, but the
runner emits **`dereferencing a null pointer`** — so it reported **0 `null_deref`**
when the true count was **297**, a ~280 undercount, and the total was 461 instead of
739. Nothing looked wrong: a classifier finding zero is indistinguishable from a
clean population. **Rule: classify using the SAME field the real gate consumes**
(here each baseline row's own `error_category`, which is what the #3189 ratchet
reads) — never a hand-rolled regex over rendered message text. If you must
hand-roll, validate it against the authoritative field on a known-non-empty subset
first.

**Fourth instance, 2026-07-25 — a truncated tail read as a pass.** A gate was run
locally and only its truncated **tail** was read (`"is refreshed on main only
(#3273)"`), which looks like a footer and is in fact the bottom of a FAILURE
message. The push then failed CI on that same gate. **Rule: read the HEAD of a
gate's output, not the tail** — gates put the verdict first and boilerplate last.
(Corollary from the same session: the oracle ratchet counts the literal token
`getTypeAtLocation`, so quoting code **inside a doc comment** trips it. Reword the
comment; do NOT grant an `oracle-ratchet-allow` for a comment — an allowance that
records "someone added checker usage here" when nobody did is false bookkeeping
that misleads every future reader.)

**How to apply:**
- One remote / one source per command. If combining for speed, print a labeled
  header per section (`echo "=== upstream:"`) so every line is attributable.
- Before concluding something is *absent*, confirm the query could have found it
  had it been there — a positive control. (Prior art in this repo:
  `check-free.sh` labels every hit by PR precisely so attribution can't be
  guessed; the test262 vacuity probe verified a known-FAIL control first and that
  control is what caught a bad probe methodology.)
- "X is not in place P" is a narrower claim than "X does not exist." Do not
  silently widen it — especially where fork/upstream, baseline-vs-local, or
  PR-number-vs-issue-number splits make the narrower claim the normal case.

Related: [[reference_false_done_audit_nnnn_vs_wasm_funcidx]],
[[reference_baseline_jsonl_authoritative_over_local_repro_status]],
[[feedback_verify_fix_in_git_not_narrative]].
