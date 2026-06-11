---
id: 2091
title: "REGEX_STEP_CAP overflow silently reports no-match — must throw RangeError"
status: ready
sprint: Backlog
created: 2026-06-11
updated: 2026-06-11
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: regexp
goal: core-semantics
related: [1959, 2067, 2089]
origin: "2026-06-11 analysis program (report 04 §2f gap); stub 08-B6"
---

# #2091 — cap exhaustion indistinguishable from a true no-match

## Problem

Regexes exceeding 1M VM steps return `null` (no match) with no diagnostic
— a silent wrong answer indistinguishable from a genuine no-match.
Empty-quantifier loops (#1959) burn the cap and hit this today.

## Root cause

`src/codegen/regex/vm.ts:24` (cap) + `:107 return null` on exhaustion, and
`native-regex.ts:68` (duplicated cap constant — second drift smell).

## Fix direction

Throw a catchable RangeError-style error on cap exhaustion (host: throw;
standalone: exn tag), per report 04 §3f; deduplicate the cap constant.
Same loud-cap policy as the for-of 1M guard (#2067).

## Acceptance criteria

- Cap exhaustion throws catchable RangeError with a step-count message
- Normal matches/no-matches unchanged; #1959 repro now errors instead of
  silently failing

## Dupe check

#1959 covers the quantifier-progress bug itself; the cap's silent-null
behavior is unfiled. New (analysis program).
