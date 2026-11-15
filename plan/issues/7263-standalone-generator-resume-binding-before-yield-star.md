---
id: 7263
title: "Standalone generator: a `const x = yield …` resume binding before a `yield*` is refused (#680) instead of lowered"
status: ready
sprint: Backlog
created: 2026-11-06
updated: 2026-11-06
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: standalone-gap
parent: 6979
related: [2864, 680, 7010]
---

# #7263 — resume binding before `yield*` is refused on standalone

## Problem

On `--target standalone` this generator is a compile error — "native generator
lowering currently supports only sequential numeric yields in standalone/WASI
targets (#680)" — instead of lowering natively:

```ts
function* inner3() { yield 10; yield 20; }
function* outer3(): Generator<number, void, number> {
  const x = yield 1;
  yield* inner3();
  yield x;
}
export function test(): number {
  const it = outer3();
  it.next(0);
  it.next(5);
  it.next(9);
  return it.next(7).value as number; // Node: 5
}
```

Measured on the S7-d base `6a20eb9f18` and on `upstream/main` `ed76cef7a0`:
the refusal is identical on both. #2864 D2 pinned this shape as lowering; it
regressed before #6979 S7-f, which only marked the row.

## Witness

- `tests/issue-2864-standalone-generator-carrier.test.ts` — "#2864 D2 delegation
  abrupt forwarding (standalone) > a resume binding preceding the yield*
  survives mid-delegation .next(v) values", `it.fails` against this issue.

## Acceptance

- The program compiles standalone with zero imports and answers `5`.
- The witness row passes as a plain `it`.
