---
id: 2109
title: "BigInt mixed loose-equality uses parseFloat instead of StringToNumber (accepts trailing garbage, rejects 0x forms)"
status: ready
sprint: Backlog
created: 2026-06-11
updated: 2026-06-11
priority: low
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: bigint
goal: core-semantics
related: [2044]
origin: "2026-06-11 analysis program (report 03 §2.3 E8); stub 08-F24"
---

# #2109 — the drift disease #1134 fixed elsewhere, alive in the BigInt path

## Problem

`10n == "10"`-class comparisons route the string operand through JS
`parseFloat` semantics instead of §7.1.4.1 StringToNumber — so
`10n == "10abc"` is true (trailing garbage accepted) and `16n == "0x10"`
is false (hex form rejected), both wrong.

## Root cause

`src/codegen/binary-ops.ts:960-1010` — an inline conversion that predates
the StringToNumber consolidation #1134 applied to the non-BigInt paths.

## Fix direction

Route through the spec-correct StringToNumber (the native
`__str_to_number` from the #2073 work, or the coercion engine's
emitToNumber once Step 3 lands — this issue can be absorbed into that
step). Cite §7.2.13 step 6 in the fix.

## Acceptance criteria

- `10n == "10"` true, `10n == "10abc"` false, `16n == "0x10"` true
- Non-BigInt == unchanged

## Dupe check

#2044 slug (BigInt i64 brand decision) is representation, not equality
semantics; no BigInt loose-eq issue exists. New (analysis program).
