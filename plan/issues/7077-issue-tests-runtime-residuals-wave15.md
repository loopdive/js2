---
id: 7077
title: "issue-tests wave 15 residuals: ~30 root suites with real wrong answers / uncaught exceptions left after the grep-other-sentinels slice"
status: ready
sprint: Backlog
created: 2026-10-18
updated: 2026-10-18
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: n/a
goal: ci-hardening
related: [7014, 7072, 7073, 7074, 7075, 7076]
requested_by: ttraenkler/wave15-grep-other-sentinels
---

# #7077 — runtime residuals of the wave-15 grep/other slice

The #7014 follow-up (wave 15, slice "source-grep + other + sentinels", 101
files / 213 tests red on run 38851065732 and not in the July baseline) fixed or
re-pinned what it could (#7072, #7073) and split the IR-pipeline pins (#7074),
fast-path pins (#7075) and generic `yield*` (#7076). These are the rest: each
is a real behaviour difference, measured on upstream/main e8699e30ee one file
at a time. Where a reduced repro was run (standalone/host lane, top level
deferred so a throw can be rendered) its result is given; "uncaught" means the
vitest message was an empty `WebAssembly.Exception`.

## Diagnosed

| file (red) | lane | repro → result | expected (node) |
|---|---|---|---|
| issue-2652 (2) | standalone, wasi | a user `declare function parseInt(s: any, …)` (TS-only redeclaration of the builtin) → `TypeError: parseInt is not a function` | the builtin runs |
| issue-3014 (2) | standalone | `foo.prototype = new Array(1,2,3); var f = new foo(); f.length = 0; f.forEach(cb)` → `TypeError: called value is not a function` | `0`, no call |
| issue-2726 (2 + 1 July) | host | `Object.defineProperty(o, 'foo', { value: 1, configurable: true }); delete o.foo` on `var o = {}` → `TypeError: Cannot delete non-configurable property in strict mode` | `true` |
| issue-856 (2) | host | `Object.defineProperties(obj, { prop: … })` on a struct-literal `obj` → `TypeError: Object method called on null or undefined` | the redefinition TypeError the test catches |
| issue-6485-concat-isconcatspreadable (1) | standalone | `var a = new Array(5)`: `2 in a` → false, `Object.keys(a).length` → 0 (both right), but `Object.prototype.hasOwnProperty.call(a, 2)` → **true** | false. The same test also still pins `Object.keys(new Array(5)).length === 5` ("Node: 0") — re-pin to 0 when fixing |
| issue-5195-r3-review (1) | standalone | mixin factories (`class D extends P` over a parameter, `class extends B` returned from a function) throw | no throw, `m()` answers 1 |
| issue-1557 / issue-2688 / issue-2689 (1 each) | host, compileProject of installed eslint | TS2614 named-import errors fixed by #7072; now stop on the NEXT checker error: "No overload matches this call" (config.js), JSDoc `Directive` warnings + success=false (apply-disable-directives.js), `eslint-scope` dist has no exported member `Variable` (source-code.js) | compile + validate |
| issue-2693-host-delegated-select (2) | host | `Cannot find module 'espree'` — not installed in CI or locally | env, not a compiler bug: skip-if-absent like its siblings |

## Not yet diagnosed (uncaught exception or value)

issue-1712-reflection-identity (5), issue-1833 (2), issue-2086 (1),
issue-2161-b1-boxed-string (1), issue-2875-prototype-installed-tostring (1),
issue-2903-r3 (1), issue-4491-function-binding-widening (2), issue-5193 (1),
issue-928 (1), issue-1472 (1), es5-standalone-callable-tostring (1),
deno-safe-promise-constructor (1), issue-3517-map-module-init (1: strict
no-host requests `env.eval`), issue-3632-eval-early-errors (2: refusal-only eval
provider), issue-2978-forawait-rejected (1: async shape unsupported inside
`try`), issue-3505 (2: FYI GC fixture verdict pass→fail), issue-4383 (3:
cross-module scalar ABI no longer rejects), issue-5150-es2015-buffers (1:
`Atomics.notify` null bufferData), issue-6651-sg1 (1: `yield *` before a
newline no longer emits invalid Wasm — the pinned-WRONG case may now be right),
issue-3899 / promise-combinators (STACK_TRACE_ERROR), v8x-compile-graph (1),
issue-4442 / issue-4483 (need the QuickJS provider locally; CI shows `42`
resolved / empty), issue-1164-es5-eval-slice (4: eval disabled by the host).

## Plan

Take the diagnosed rows first (each has a one-line repro above), bisect, fix
forward with the root test as the regression proof. For each undiagnosed row,
reduce the first red test to a module, render the exception (compile with
`deferTopLevelInit: true`, call `__module_init`, render with
`scripts/lib/wasm-exn-render.mjs`), then classify as in #7014.
