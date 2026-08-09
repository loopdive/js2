---
id: 3549
title: "Standalone: native RegExp step limit exceeded on `\\p{...}+` over long strings — measured 304/311 gate on RegExp property-escapes"
status: done
created: 2026-07-23
updated: 2026-07-24
completed: 2026-07-23
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
goal: standalone
sprint: 76
horizon: l
umbrella: 2860
assignee: ttraenkler/fable-2860
related: [2860, 3541, 3536, 2876, 3507, 2935]
# +19 LOC in native-regex.ts IS the fix (the BUDGET local + its computation at
# __regex_run entry, beside the step-counter it replaces) — not barrel spill.
loc-budget-allow:
  - src/codegen/native-regex.ts
files:
  - src/codegen/regex/vm.ts
  - src/codegen/native-regex.ts
  - tests/issue-3549.test.ts
---

# Native RegExp: step limit exceeded on `\p{…}+` over long strings

## Measured discovery (the #3536 → #3541 chain, 2026-07-23)

With #3536 (call-boundary) and #3541 (reflective `fromCodePoint.apply`)
landed, ALL 311 `built-ins/RegExp/property-escapes/generated/` tests were run
through the real sharded worker. **0/311 pass — the measured wall moved to
the native RegExp engine itself:**

| count | signature                                                                                                 |
| ----: | --------------------------------------------------------------------------------------------------------- |
|   304 | `RangeError: regular expression step limit exceeded`                                                      |
|     6 | `Test262Error: \p{RGI_Emoji…}/\p{Basic_Emoji} should match …` (sequence properties, `v`-mode string sets) |
|     1 | misc                                                                                                      |

The tests build multi-thousand-character strings (`buildString` — every
matching code point of a Unicode property) and assert
`RegExp("^\\p{Prop}+$", "u")` matches the whole string (and its negation
misses per-char). The 304 rows are the engine's backtracking-step cap firing
on that shape — i.e. the `\p{…}` class match is super-linear (likely a large
alternation / per-char backtrack instead of an O(1) class test per char),
so a `+` over N chars blows the step budget.

## Direction (verify against src/codegen/regexp-standalone.ts first)

1. Measure where the steps go: is `\p{…}` compiled to a range-set test
   (good) that the step counter over-charges, or expanded to alternations
   (bad)? A greedy `X+$` over N chars with an O(1) per-char class test
   should cost O(N) steps.
2. Candidate fixes, cheapest first: (a) charge class-set tests as ONE step;
   (b) raise/scale the step limit with subject length; (c) compile `\p{…}`
   to binary-searched range tables if it is not already.
3. The 6 emoji-sequence rows are a DIFFERENT feature (`RGI_Emoji…` string
   properties, `v`-flag territory) — do not conflate; split out if the range
   fix lands without them.

## Acceptance

- Re-run the full 311 through the real worker (the #3541 method —
  `.tmp/drive-worker.mjs` + `.tmp/pe-all.txt` in the fable-2860 worktree)
  and report the REAL flip count. Target: the 304 step-limit rows pass.
- No step-limit regressions on existing passing RegExp rows (the limit
  exists as a runaway-backtracking guard — keep pathological cases bounded).

## Implementation (landed 2026-07-23; cheapest-hypothesis-first per lead)

**Mechanism CONFIRMED before fixing** (the lead's step 1): steps/unit is
CONSTANT across 1k → 1.1M subject lengths in the JS mirror (~5 steps/unit
for `^\p{L}+$`(u) — the 1,263-instr surrogate-alternation program executes
CLASS+SPLIT per unit) — so this was the "genuinely large but LINEAR" branch:
no super-linear class-match bug, the FLAT cap was simply mis-sized for long
subjects (trips at ~200k units; the PE complement subjects are ~1.1M).

**Fix:** length-scaled budget, both VMs in lockstep via shared constants —
`budget = REGEX_STEP_CAP + 50·min(len, 20M)` (`regexStepBudget` in
`regex/vm.ts`; a `BUDGET` local computed from `SLEN` at `__regex_run` entry
in `native-regex.ts`). 50/unit is ~10× the measured legitimate cost; the
saturation keeps the i32 budget < 2³¹−1. The runaway-backtracking guard is
preserved: catastrophic patterns are Ω(n²)/Ω(2ⁿ), so on any subject long
enough to raise the budget they still exceed it (pinned by the (a+)+b test
and the pre-existing #2091 suite, 7/7). Peer-reviewed clean by fable-3549
(select/min idiom, overflow bound, guard argument, lockstep shape); their
suggested `regexStepBudget` unit pins are in the test file.

## Measured results (full 311 through the real worker, all three fixes)

| outcome                         |   count | note                                                                                                                                                                                           |
| ------------------------------- | ------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pass**                        | **290** | was 0/311 before this chain; 0 → 290 real flips                                                                                                                                                |
| fail: step limit                |       4 | `Script_-_Unknown`, `Script_Extensions_-_Unknown`, `General_Category_-_Other`, `Grapheme_Base` — the giant classes: deeper alternation programs push steps/unit past 50 on ~1.1M-unit subjects |
| fail: emoji sequence properties |       7 | `RGI_Emoji…`/`Basic_Emoji`/`Emoji_Keycap_Sequence` — `v`-mode STRING properties, a separate feature (#2591 residual), expected                                                                 |
| timeout (30s worker cap)        |      10 | biggest subjects × interpreted-VM wall time; a faster class match (range-table binary search) would convert these — that is the ESCALATION step the lead gated behind a ping; not taken        |

**Chain note (lead's framing): #3536 → #3541 → #3549 was a three-layer gate,
and the first two were NOT dead ends** — #3536 fixed the declared-function
call-boundary (silent-null params + IR ABI replacement invalid-wasm; value
across the whole standalone corpus) and #3541 fixed reflective
`fromCharCode/fromCodePoint` (spec semantics for any `.call/.apply` user).
Each layer's flip count was only measurable after the previous landed; a
measured gate identifies the NEXT blocker, not the final row count.

**Residual follow-on (NOT filed as an issue yet — lead to route):** the 4+10
step-limit/timeout rows would need the range-table/binary-search class-match
escalation (engine surgery, gated on a lead ping per the decision); the 7
emoji rows belong to the `v`-mode string-property feature, not this issue.
