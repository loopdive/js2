---
id: 2141
title: "Retire the tag-5 box-the-externref ABI: make consumers tag-agnostic, then allow honest generic boxing"
status: blocked
blocked_by: [2167]
sprint: 65
created: 2026-06-12
updated: 2026-06-12
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: compiler
language_feature: any-type
goal: correctness
related: [2072, 2080, 1987, 2104, 1888, 1624]
origin: "2026-06-12 sprint-62 architecture analysis (value-rep workstream N2)"
---

# #2141 — tag fidelity can never be established while the box site must lie

## Problem

Generic boxing (`type-coercion.ts:1207-1219`) deliberately mis-tags
externrefs as tag 5 (string) because honest tag recovery at the boxing site
flipped **−794 standalone test262** (the #1888 incident): the harness
comparator (`isSameValue` over externref-ABI `any` params) was tuned
against the lie. This freezes invariant V1 (producer honesty) out of reach:
#2104's `boxToAny` "unknown externref → runtime classify" arm and the
#1624-endgame (host-import retirement) are both blocked on it.

## Approach

1. Characterize exactly which equality/`__any_*` paths encode the tag-5
   assumption (the #1776/#1914 blocks, `binary-ops.ts:1833-2028`).
2. Make those consumers tag-agnostic first.
3. Flip honest boxing behind a flag with a measured standalone test262 run.

Sprint 62 delivers the characterization + consumer migration spec (Fable
architect); implementation lands 62-stretch/63.

## Acceptance criteria

- `String(undefined as any)` ≠ `"[object Object]"` via the *generic* path
  (#2072 residue).
- `typeof (true as any) === "boolean"`.
- `isSameValue` test262 buckets unchanged (no −794 repeat).

## Notes

Symptom anchors: #2072, #2080, #1987. Hard constraint: the merged
anyvalue-tag-recovery spec's rule "never re-tag at the box site" holds
until step 2 completes.
