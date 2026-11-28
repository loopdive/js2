---
id: 7633
title: "Runtime-link probe: an AOT throw is not caught by interpreted try/catch across the module boundary"
status: ready
sprint: current
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime-eval
goal: runtime-eval
related: [2928, 7632]
---

# #7633: AOT throw → interpreted catch, across the provider boundary

## Problem

The `aotThrowRoundTrip` row of `tests/issue-2928-runtime-link.test.ts` fails:

```ts
function aotThrow(value: any): never { throw value; }
export function aotThrowRoundTrip(): number {
  const value: any = {};
  globalThis.thrownValue = value;
  globalThis.aotThrow = aotThrow;
  const result: any = (0, eval)(dynamic(
    "try { aotThrow(thrownValue); false; } catch (error) { error === thrownValue; }"
  ));
  return result === true ? 1 : 2;
}
```

1. The user module calls indirect eval in the runtime provider (`__runtime_indirect_eval`).
2. The interpreted script calls back into the AOT `aotThrow`, which throws.
3. The interpreted `catch` should receive the value. Instead, a `WebAssembly.Exception` escapes the export.

Found during #7632. Measured on main 28ca865e with #7632's prototype fix and the probe stub fix applied, which are
needed before the probe's user module compiles and runs:

| user module            | `aotThrowRoundTrip` |
| ---------------------- | ------------------- |
| `experimentalIR: true`  | throws `WebAssembly.Exception` |
| `experimentalIR: false` | throws `WebAssembly.Exception` |

So it is not an IR issue. The other 11 execution rows pass in both configurations.

**Unverified hypothesis.** The two modules use different exception tags:
- the runtime exports its own `__exn_tag`;
- the user module's imports are only the four `js2wasm:runtime-eval` functions, and include no tag.

An AOT `throw` raised under the user module's tag is therefore never matched by the interpreter's `catch`, which
catches the runtime's tag.

## Repro

After #7632 lands (it fixes both blockers above):

```bash
npx vitest run tests/issue-2928-runtime-link.test.ts
```

Only `executionErrors.aotThrowRoundTrip` should remain.

## Acceptance

- `aotThrowRoundTrip` reports `1`, and `tests/issue-2928-runtime-link.test.ts` passes in full.
- The thrown value keeps its identity across the boundary (`error === thrownValue`).
