---
id: 4062
title: "D3 — array `length` absent from descriptor reflection in standalone (gOPD undefined, gOPN omits it) while hasOwnProperty says true"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: n/a
goal: standalone-mode
---
# D3 — array `length` absent from descriptor reflection in standalone (gOPD undefined, gOPN omits it) while hasOwnProperty says true

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Found by g-arraylen 2026-08-01 alongside D2 (task #49). Standalone-lane only. NOT fixed by #3984.

DEFECT: on standalone, an array's `length` is invisible to descriptor reflection —
`Object.getOwnPropertyDescriptor(arr,"length")` returns undefined and
`Object.getOwnPropertyNames(arr)` omits it — yet `arr.hasOwnProperty("length")` returns
true. The property exists but is not reflected.

DISCRIMINATORS ALREADY RUN (these rule out the broad alternatives — do not redo them):
  - gOPD works correctly on array INDICES        ⇒ not "gOPD broken on arrays"
  - gOPD works correctly on plain-object props   ⇒ not "gOPD broken generally"
  - gOPD works on the key "length" when the RECEIVER is a plain object
                                                  ⇒ not "the key 'length' is special"
  The defect is specifically the (array receiver × "length" key) cell.

WHY IT MATTERS BEYOND ITS OWN FILES: it makes the STANDALONE lane useless as an
instrument for any descriptor question about array length — it is precisely what
confounded the first D2 probe. Fixing D3 restores the ability to measure D2 on the
standalone lane directly.

Together with D2 this gates most of the 69 files #3984's fix did not flip.

⚠ Validate any probe against Node first (all 11 of g-arraylen's did pass on a real
  engine), and keep an in-sweep control — the control is what caught the confound here,
  not the pass count.

Context: /workspace/plan/log/analysis-2026-08-01-descriptor-dedup-map.md, PR #3973.
No issue id allocated yet — allocate at pickup. Do NOT reserve an id you may not use
(#3890/#3891 became permanent holes exactly that way).
