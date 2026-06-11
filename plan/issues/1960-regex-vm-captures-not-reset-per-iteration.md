---
id: 1960
title: "native RegExp VM: capture groups not reset between quantifier iterations"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
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
