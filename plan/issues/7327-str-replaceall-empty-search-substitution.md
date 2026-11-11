---
id: 7327
title: "__str_replaceAll with an empty search inserts $-patterns literally instead of GetSubstitution"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [7313, 1822]
---

# `__str_replaceAll("", "$…")` skips GetSubstitution

## Problem

The native `__str_replaceAll` (`src/codegen/native-strings-rewrite.ts`,
`emitStrReplaceAllHelper`) handles an empty search value in a separate branch
(#1822). That branch interleaves the replacement text **literally**. The
helper's own comment says it skips `$` expansion "for the dominant case".
§22.1.3.19 step 14 applies GetSubstitution at every match, including the
empty matches before each code unit and at the end.

Repro (`var s = "ab"`), on base `cc27f70d`, gc and standalone:

| call | node | js2wasm |
| --- | --- | --- |
| `s.replaceAll("", "[$&]")` | `[]a[]b[]` | `[$&]a[$&]b[$&]` |
| `s.replaceAll("", "$$")` | `$a$b$` | `$$a$$b$$` |
| `` s.replaceAll("", "[$`]") `` | ``[]a[a]b[ab]`` | ``[$`]a[$`]b[$`]`` |
| `s.replaceAll("", "[$']")` | `[ab]a[b]b[]` | `[$']a[$']b[$']` |

This predates #7313. #7313's `replaceAll` row calls the same helper, so
the IR inherits the wrong answer and does not change it.

## Fix

In the empty-search branch, call `__str_getSubstitution` at each position,
as the non-empty branch does: matched `""`, position `i`, and the subject
for `` $` `` / `$'`. A replacement with no `$` can keep the literal fast
path.

## Acceptance criteria

- The four rows above match node on gc and standalone.
- `test262/test/built-ins/String/prototype/replaceAll/` shows no new failures.
