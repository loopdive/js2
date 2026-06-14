---
id: 1747
title: "Array.prototype.pop() on an empty array traps instead of returning undefined (compiled WasmGC)"
status: done
completed: 2026-06-12
created: 2026-05-30
updated: 2026-06-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, arrays, standalone
language_feature: array-pop, empty-array, undefined
goal: standalone-correctness
sprint: 58
related: [1584, 1748]
---
# #1747 — `[].pop()` on an empty array traps instead of returning `undefined`

## Problem

When js2wasm compiles `Array.prototype.pop()` on an **empty** array, the
generated WasmGC code traps (an array out-of-bounds access) instead of
producing the JS-spec `undefined`. Per ECMA-262 §23.1.3.22, `pop()` on a
length-0 array returns `undefined` and leaves length at 0 — it must not throw.

This is a standalone-mode correctness bug independent of #1584; it was
surfaced while building the #1584 bytecode VM (whose `runProgram` `RET` arm
pops a frame stack that is empty on every program exit).

## Repro

```ts
export function run(): number {
  const a: number[] = [];
  const x = a.pop(); // should be `undefined`; instead the module traps
  if (x === undefined) return 1;
  return -1;
}
```

Compiling this with `compile()` and instantiating, then calling `run()`,
throws a `WebAssembly.Exception` (an out-of-bounds trap) rather than returning
`1`. Host JS / `tsx` returns `1`.

## Expected

`[].pop()` lowers to a guarded read: if `length === 0`, push the `undefined`
representation (do not index `array[length-1]`); otherwise pop normally. The
same guard applies to `shift()` on an empty array (likely the same defect —
worth checking in the fix).

## Workaround (in #1584)

The #1584 VM avoids the trap by length-guarding before popping
(`if (frames.length === 0) return result;` rather than relying on
`frames.pop() === undefined`). That workaround is correct for the VM but the
underlying `pop()` codegen should produce spec `undefined` so other compiled
code doesn't hit the same trap.

## Notes

- Found via the slice-(b) "compile the dispatch loop itself" arm — the VM is
  itself compiled by js2wasm, so its `[].pop()` usage exercised the real
  codegen path.
- See [[1748]] for a sibling codegen trap found in the same investigation
  (`readonly` nested array field).

## Implementation notes

- Verified ECMA-262 §23.1.3.22 (`Array.prototype.pop`) and §23.1.3.27
  (`Array.prototype.shift`): both return `undefined` immediately when
  `length = 0`.
- Current branch already guarded the raw array read, so the reproduced failure
  was no longer an out-of-bounds trap; it was an observable wrong result for
  `number[]` because the intrinsic returned the primitive element type and
  could not carry `undefined`.
- Updated `pop`/`shift` lowering to use an `externref` result when the call's
  TypeScript return includes `undefined` and no numeric expected type is
  requesting the old primitive path. Empty arrays initialize that result to JS
  `undefined`; non-empty numeric elements are boxed before storing into the
  result local.
- Left discarded calls (`arr.pop();`) on the primitive path because their
  returned value is not observable and this avoids unnecessary late imports.

## Validation

- `pnpm vitest run tests/issue-1747.test.ts tests/issue-1377.test.ts tests/array-oob-bounds-check.test.ts`
- `pnpm run typecheck`
