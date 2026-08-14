---
id: 4421
title: "Object literal mixing a spread with a method fails: Missing __make_getter_callback import"
status: ready
sprint: current
created: 2026-08-14
updated: 2026-08-14
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
---

## Problem

An object literal that contains **both** a spread and a method fails to
compile:

```ts
const a = { p: 1 };
const o: Record<string, unknown> = {
  ...a,
  m() {
    throw new Error("x");
  },
};
// → Missing __make_getter_callback import
```

Either half alone is fine — `{ m() {} }` compiles, `{ m: () => {} }` compiles,
`{ ...a }` compiles. **The spread is what flips it.**
`src/codegen/closures.ts:3810-3822` routes the method through the host
callback bridge, and the maker import is never registered on the JS-host lane.

## Why this one blocks everything

The failing construct is in **`src/ts-api.ts`** (lines 194, 200, 206), and
**657 of 768** files under `src/` reach `ts-api.ts` transitively. It is the
hard floor for any whole-program self-compile beyond ~10 files: the largest
early-error-clean closure that compiles today is 10 files
(`src/interp/index.ts`, 244 KB → 366 KB of valid Wasm), and there is no closure
between 11 and 42 files, so the next step up is a 43+ file / 1.27 MB graph that
goes straight through `ts-api.ts`.

It is also plain user-facing: `{ ...defaults, method() {} }` is an everyday
JavaScript shape, not something only a compiler writes.

## Acceptance criteria

- [ ] The repro above compiles and runs, on both the JS-host and standalone
      lanes.
- [ ] Coverage for the neighbouring shapes: spread before vs after the method,
      multiple spreads, getter/setter alongside a spread, computed method name
      alongside a spread.
- [ ] `src/ts-api.ts` compiles standalone via `compile()`.

## Provenance

Found by the self-hosting investigation. Minimal repro above is verified;
harnesses in `.tmp/selfhost/`.
