---
id: 1534
title: "test: Web API host import unit tests (fetch, timers, localStorage, crypto.getRandomValues)"
status: ready
created: 2026-05-20
updated: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: test
area: runtime
language_feature: host-imports
goal: browser-support
sprint: Backlog
related: [1500, 1501, 1502, 1503, 1504]
---
# #1534 — Web API host import unit tests

## Problem

Sprint 52 landed browser host import features (#1500 fetch, #1501 timers, #1502 localStorage, #1503 crypto.getRandomValues). No unified test suite validates these end-to-end in a Node test environment with mock implementations.

## Goal

Create `tests/issue-1534.test.ts` covering browser Web API host imports compiled with the default JS-host target, run in Node with mock host bindings substituted for browser globals.

## Test cases

1. **`setTimeout(fn, 0)`** — mock fires callback synchronously, assert callback was called
2. **`clearTimeout(id)`** — mock, assert no error thrown
3. **`fetch(url)`** — mock returning `{ ok: true, json: () => Promise.resolve({x:1}) }`, assert JSON parsed correctly
4. **`localStorage.setItem` / `getItem`** — in-memory mock store, assert round-trip
5. **`localStorage.removeItem`** — assert item gone after removal
6. **`crypto.getRandomValues(new Uint8Array(16))`** — use Node `crypto.randomFillSync` as mock, assert array is 16 bytes and not all-zero

## Mock approach

Inspect what import names the compiler emits for web APIs by checking `WebAssembly.Module.imports(mod)` on a compiled snippet. Provide matching mock functions in the `env` import object:

```ts
const module = await WebAssembly.compile(r.binary);
const requiredImports = WebAssembly.Module.imports(module);
console.log(requiredImports); // reveals __fetch, __setTimeout, etc.
```

Build mock implementations matching those exact names and signatures.

## Acceptance criteria

- All 6 test cases pass locally with mock implementations
- Clearly documents which import names the compiler uses for each API
- No `src/` changes — tests-only PR

## Files to create

- `tests/issue-1534.test.ts`

## Notes

If the actual import signatures are hard to mock (e.g. complex externref passing), document the gap and ship what works. The goal is coverage, not perfection.

## Frontmatter reconcile (2026-06-12)

Was `in-progress` with no open PR, no active agent, and no Suspended Work section (session died sprints 42-52). Reset to `ready` during the sprint-62 issue review; re-validate against current main before claiming (#2148).
