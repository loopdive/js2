---
id: 1959
title: "native RegExp VM: empty-body quantifier loops burn the 1M-step cap and silently report no-match (/(?:a?)*/ fails)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: regexp
goal: standalone-mode
related: [1909, 1911, 1912, 1539, 1960]
origin: "2026-06-10 deep-audit sweep (strings agent): verified on main, standalone backend"
---

# #1959 — RegExp quantifier lowering lacks the RepeatMatcher empty-iteration progress guard

## Problem

ES2024 [§22.2.2.3.1 RepeatMatcher](https://tc39.es/ecma262/#sec-runtime-semantics-repeatmatcher-abstract-operation):
if min=0 and an iteration consumes nothing, the iteration fails (loop exits).
The compiled VM has no such guard: a nullable quantifier body loops pushing
backtrack frames until the 1,000,000-step cap, and the cap exhaustion is
reported as **"no match"** — a silent wrong answer plus a multi-second perf
cliff at every scan position.

## Repro (verified on main, `--target standalone`)

```ts
export function test(): boolean { return /(?:a?)*/.test("b"); }
```

wasm: `false` (≈3s runtime) — node: `true` (empty match at 0).
`/(a?)*x/.test("bbb")` returns the right value but takes ~1s.

## Root cause

`src/codegen/regex/compile.ts:123-137` — `star` lowers to
`L1: SPLIT body,exit; body; JMP L1` with no empty-iteration progress check.
Step-cap exhaustion: `runAt` returns null = "no match"
(`src/codegen/regex/vm.ts:85`, mirrored in the Wasm VM at
`src/codegen/native-regex.ts:753-758`).

## Fix direction

Standard PROGRESS/empty-check opcode: at loop re-entry compare sp with the sp
recorded at iteration start; if equal, fail that iteration (take the exit
arm). Eliminates both the wrong result and the step-cap burn. Apply to
star/plus/repeat with nullable bodies. Separately consider making cap
exhaustion a thrown error rather than a silent no-match.

## Acceptance criteria

- `/(?:a?)*/.test("b") === true`, fast
- `/(a?)*x/.test("bbb")` fast
- Greedy/lazy quantifier backtracking unregressed (RegExp test262 buckets
  net non-negative)

## Dupe check

#1909/#1911/#1912/#1914 catalog refusals/unsupported features; #1539 covers
empty-match lastIndex advance and split separators — nothing about the
quantifier-empty-body loop in the VM.
