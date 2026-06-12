---
id: 1960
title: "native RegExp VM: capture groups not reset between quantifier iterations"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: regexp
goal: standalone-mode
related: [1539, 1959]
origin: "2026-06-10 deep-audit sweep (strings agent): verified on main, standalone backend"
---

# #1960 — quantifier iterations keep stale capture slots

## Problem

RepeatMatcher (§22.2.2.3.1) clears captures `parenIndex..parenIndex+parenCount`
on each repetition entry — only the **last** iteration's participation counts.
The compiled VM keeps SAVE slots from earlier iterations.

## Repro (verified on main, `--target standalone`)

```ts
export function test(): number {
  const m = /(?:(a)|(b))+/.exec("ab");
  if (m === null) return -1;
  let r = 0;
  if (m[1] !== undefined) r += 100;
  if (m[2] !== undefined) { r += 10; r += m[2].charCodeAt(0) % 10; }
  return r;
}
```

wasm: `118` (group 1 still holds `"a"` from iteration 1) — node: `18`
(group 1 `undefined`).

## Root cause

`src/codegen/regex/compile.ts` star/plus/opt/repeat lowering (123-203) emits
no capture-clear at iteration start; SAVE slots persist (`vm.ts:130-135` SAVE
only ever writes). The bytecode has no CLEAR op (`bytecode.ts`).

## Fix direction

Track each quantified subtree's capture-index span at compile time; emit a
`CLEAR lo,hi` op (set slots to -1) at the head of every loop body, with
support in `vm.ts` and the Wasm VM in `native-regex.ts`. CLEAR must be
backtrack-aware (restore on backtrack like SAVE).

## Acceptance criteria

- Repro matches Node (`18`)
- Nonparticipating-group `undefined` semantics in alternation-under-quantifier
  correct
- Existing capture tests unregressed

## Dupe check

#1539's Phase 2b `.exec` capture work has no reset note; no grep hit for
"capture reset"/RepeatMatcher in plan/issues.

## Resolution (2026-06-12)

Added a `CLEAR loSlot,hiSlot` opcode (`ReOp.CLEAR = 14`) that resets capture
slots `[loSlot..hiSlot]` to -1. The compiler emits it at the head of every
star/plus body (`emitClearForBody`), using a new `captureSpan` helper to find
the body's group-index span `[lo, hi]` → slot range `[2*lo, 2*hi+1]`. Bodies
with no capture groups emit no CLEAR (common case unchanged). CLEAR runs once
per iteration (the loop back-edge re-enters at the body head), so a group that
doesn't participate in the final iteration reads as unset.

CLEAR mutates the caps array in place (like SAVE); the enclosing SPLIT's caps
snapshot restores it on backtrack, so the reset is correctly undone when an
iteration is abandoned. Implemented in both the reference VM (`vm.ts`) and the
hand-authored Wasm VM (`native-regex.ts` `clearArm()`).

This builds on the #1959 PROGRESS work (same loop lowering); the branch is
stacked on #1959 (PR #1395).

### Files

- `src/codegen/regex/bytecode.ts` — `ReOp.CLEAR`
- `src/codegen/regex/compile.ts` — `captureSpan`, `emitClearForBody`, CLEAR at
  star/plus body heads
- `src/codegen/regex/vm.ts` — reference VM `CLEAR` dispatch
- `src/codegen/native-regex.ts` — Wasm VM `clearArm()` dispatch

## Test Results

All match Node `RegExp` on the standalone backend:

- `/(?:(a)|(b))+/.exec("ab")` → group 1 `undefined`, group 2 `"b"` (was group 1
  stale `"a"`) — `test()` returns 18, matching Node
- `/(?:(a)|(b))+/.exec("ba")` → group 1 `"a"`, group 2 `undefined`
- `/((a)|(b))*/.exec("abab")`, `/(?:a(b)?)+/.exec("aa")` correct
- `tests/issue-1960.test.ts` (5 cases) green
- `regex-bytecode.test.ts` (277), replace (17), phase2b (#1912), #1914 — all
  green, no capture regression
