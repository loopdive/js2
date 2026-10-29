---
id: 7140
title: "Regime gap: an arrow callback handed out to JavaScript can be called with `new` instead of throwing TypeError"
status: ready
created: 2026-10-25
updated: 2026-10-25
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
language_feature: host-interop
goal: architecture
sprint: current
parent: 5385
related: [6979, 7098, 3526]
---

# #7140 — `new` on a marshalled arrow callback

Found by the S7-a landing (2026-10-25) while re-pinning
`tests/issue-3526-callable-boundary-callback.test.ts` to the native regime.
A closure the module passes to JavaScript (a platform-extern or
declared-function argument) is marshalled by the runtime's closure wrapper
(#7098) as an ordinary `function`, so the host can construct it with `new`
and gets an object; the source arrow is not a constructor and Node throws
`TypeError: … is not a constructor`. The row is marked `it.fails` on the
S7-a PR and fails identically on main's default profile.

## Plan

1. Measure: a `.tmp` probe under native-first via `wrapCompiledExports` for an
   arrow, a function expression, a method and a class passed out; `new f()`,
   `Reflect.construct(f, [])`, `f.prototype`, `typeof f`; against Node.
2. Fix in the runtime wrapper (`src/runtime/platform-arg-marshal.ts` /
   `_wrapWasmClosure*`): the host-facing callable for a non-constructor
   closure must reject construction (a `Proxy` with a throwing `construct`
   trap, or a wrapper without `prototype`/`[[Construct]]` such as an arrow),
   keyed on the closure's kind when the manifest records it; keep Wasm bytes
   unchanged (runtime-only).
3. Tests: turn the `it.fails` row back into a normal row; add function and
   method rows.
4. Acceptance: equivalence gate "No new equivalence regressions";
   `check:host-import-policy` unchanged.
