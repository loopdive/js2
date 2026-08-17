---
name: feedback_always_give_issue_titles
description: "Always give an issue's title when referencing it by number — a bare #NNNN is unreadable and, in PR bodies, autolinks to the wrong thing"
metadata:
  node_type: memory
  type: feedback
---

**User directive (2026-08-17): "Remember to always give the title of issues you
reference."**

When citing an issue in prose — chat replies, issue bodies, ADRs, PR
descriptions, commit-message bodies — give its **title**, not just its number:

> **#2860 — "Umbrella: close the standalone-vs-js-host test262 gap (~20,500
> host-free, honest metric #2879/#2360)"**

not

> #2860

**Why.** A bare number is unreadable without a lookup, and in this repo the
lookup is expensive: there are ~3,900 issue files, and issue ids share GitHub's
sequence with PR numbers, so `#2860` is ambiguous between an issue file and a
pull request. A reader who cannot resolve the reference silently skips it, and
a reviewer cannot tell whether the citation supports the claim. Titles also
survive copy-paste out of the repo, which numbers do not.

**How to apply.**

- First mention in a document gets the full `**#NNNN — "title"**` form.
  Repeated mentions in the same document may use the bare number once the title
  has been established.
- Get the title from the file, don't recall it:
  `grep -m1 "^title:" plan/issues/<id>-*.md`. A misremembered title is worse
  than a bare number, because it looks authoritative.
- **In PR bodies specifically this compounds with an existing rule** (project
  lead, 2026-08-16): link to the website issue page rather than writing a bare
  `#NNNN`, because GitHub autolinks it to the PR/issue sequence and lands the
  reader on an unrelated pull request —
  `[#NNNN](https://js2wasm.loopdive.com/dashboard/issue.html?slug=<file-basename-without-.md>)`.
  Commit messages keep plain `#NNNN`, since tooling greps them — but the title
  still belongs in the prose.
- Applies to every agent, not just the lead. Worth including in spawn prompts
  for agents that will write issue files, ADRs, or PR descriptions.
