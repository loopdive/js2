---
id: 4065
title: "RegExp engine is a separate lever hiding inside String.prototype — M1 search-value refusal 51 files, 91 non-pass by method"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: standalone
language_feature: n/a
goal: standalone-mode
---
# RegExp engine is a separate lever hiding inside String.prototype — M1 search-value refusal 51 files, 91 non-pass by method

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Surfaced by L-strwith 2026-08-01 while decomposing the String.prototype area. It is a
DIFFERENT mechanism with a different owner and must not be counted as String work.

POPULATION (fresh baseline, goal scope = es5id present OR none of es5id/es6id/esid):
  built-ins/String/prototype: 630 run / 427 pass / 203 non-pass
  M1 "RegExp / symbol-protocol search-value refusal": 51 files
  By method, split/replace/search/match account for 91 non-pass
  (the two figures are DIFFERENT CUTS — 51 is the mechanism classification,
   91 is a per-method count. Do NOT sum or reconcile them silently.)

Adjacent, already in the tail census (PR #3980): "RegExp engine semantics" 68 files
(39 SA-only) and "RegExp unsupported pattern/arity" 21 files (16 SA-only, Tier-1
conclusive refusals). Whether M1's 51 overlaps those 68/21 is UNMEASURED — establish
that before sizing, or you will double-count.

⚠ THE FRAMING THIS CORRECTS: String.prototype was dispatched as "generic receivers,
218 files, top signature `Cannot access property on null or undefined` (31)". All
three parts were wrong. Normalized, that signature is 22 files, and the area carries
**113 distinct signatures across 203 files**. The real decomposition, from reading
test bodies rather than clustering strings:
  M2 generic receiver / ToString(this) .... 69   <- being fixed as #3989
  M1 RegExp / symbol-protocol search value . 51   <- THIS TASK, unowned
  long tail ............................... 52
  M7 not-a-constructor .................... 10
  M4 explicit not-implemented .............  4
  M5 host-import leak .....................  2
So "generic-receiver defects" is about one third of the area, not the whole of it.
This is the third time today a signature census was mistaken for a mechanism census.

DISCIPLINE: file counts are populations, not flip ceilings (measured reference:
103 reachable gated -> 34 flipped, 33%). Validate the instrument against
43,106 official / 25,755 pass (59.7%) and goal scope 8,545 / 6,176 (72.3%) on a
FRESHLY re-fetched baseline (`fetch-baseline-jsonl.mjs --standalone --force`) — the
cached jsonl goes stale within hours and reproduces its own checks exactly while
answering yesterday's question.

Allocate an id at pickup. CLAIM_ASSIGN_REMOTE=upstream, and EXPORT
GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL/GIT_COMMITTER_* or claim-issue.mjs exits 6.
