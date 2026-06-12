---
id: 1959
title: "native RegExp VM: empty-body quantifier loops burn the 1M-step cap and silently report no-match (/(?:a?)*/ fails)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
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

## Resolution

Implemented the PROGRESS/empty-check opcode (`ReOp.EMPTYCHECK = 13`).

- **bytecode.ts** — new `EMPTYCHECK` opcode; `CompiledRegex` gains `nSlots`
  (`2*nGroups` capture slots + one scratch slot per EMPTYCHECK).
- **compile.ts** — `nodeMatchesEmpty()` nullability analysis. A nullable-bodied
  `star` emits `SAVE scratch` at iteration start and `EMPTYCHECK scratch` before
  the JMP-back; a nullable-bodied `plus` is lowered as `body · star(body)` so the
  mandatory first rep may match empty while 2nd+ reps are guarded. `repeat`
  inherits the guard via its star/opt expansion. Scratch slots are allocated
  past the capture slots; `nSlots` is recorded.
- **vm.ts** (reference VM) — `EMPTYCHECK` case: `caps[slot] === sp ⇒ FAIL` (take
  the loop exit) else `pc++`. `runAt`/`search` now take `nSlots` (was `nGroups`)
  so the scratch slot is in-bounds.
- **native-regex.ts** (Wasm VM) — `emptyCheckArm()` dispatch + `nSlots` threaded
  as a trailing param through `__regex_replace` / `__regex_split` /
  `__regex_match_all` (caps allocation only; result-array shape still uses
  `nGroups`). `__regex_search`/`__regex_run` already took `nSlots`.
- **regexp-standalone.ts** — `$NativeRegExp` struct gains field 6 `nSlots`; the
  caps allocation + every helper call now pass it.

## Test Results

`tests/issue-1959.test.ts` — 14 standalone-Wasm cases via `String.prototype.search`
vs native (headline `(?:a?)*`, nested `(?:a*)*`, `(a*)+`, `(?:|a)*`, anchored-fail
`(a?)*x`, plus non-nullable controls). All match native, all <1ms (was 300ms–3s,
silent wrong answer). `tests/regex-bytecode.test.ts` (TS VM) + the #1539 suite:
454/455 pass. The one failure (`refuses unicode flag (u)`) is **pre-existing on
main** — the `u`-flag refusal was lifted earlier and that test was never updated
(confirmed by running it on a clean checkout); tracked separately (task #46), not
caused by this change.

## Dupe check

#1909/#1911/#1912/#1914 catalog refusals/unsupported features; #1539 covers
empty-match lastIndex advance and split separators — nothing about the
quantifier-empty-body loop in the VM.
