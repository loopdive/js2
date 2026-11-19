---
id: 7419
title: "JS environment: a JS string passed to an exported function's `string` parameter throws at the boundary"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime, codegen
goal: core-semantics
related: [6979, 4513, 7354]
origin: "2026-11-19 #7312 review (RV7312), found when tests/issue-4513.test.ts ran under changed-root-tests"
---

# #7419: a JS string argument does not cross into an exported `string` parameter

## Problem

On main `89e47482`, calling an exported function with a JS string argument throws at the Wasm boundary:

```ts
export function f(k: string): number { return k.length; }
```

```js
const r = await compile(src, { fileName: "t.ts" });            // also target "node" and "web"
const { instance } = await WebAssembly.instantiate(r.binary, buildImports(r.imports, undefined, r.stringPool));
instance.exports.f("abc");
// TypeError: type incompatibility when transforming from/to JS
```

Measured with the target unset (the default), `node` and `web`: all three throw the same way. The expected answer is 3.

## Where it was found

`tests/issue-4513.test.ts` "a runtime parameter key" passed the key as a JS string argument
(`f(41, "a")`). That test failed on main and was re-pinned in #7312 (2efccd886f) to compute the key inside the
function. Main never runs that file, which is why the failure went unnoticed.

## Analysis (not yet confirmed)

On the JS target native strings are always on (#6979 S7-a: `nativeStrings: false` is a compile error there). An
exported `string` parameter is then a WasmGC string reference, and a JS string handed to it has no value adapter at
the boundary. So the engine rejects the externref → ref conversion. The first breaking merge is not identified: this
checkout's history is shallow. It is likely the merge that made native strings mandatory on the JS target, but that
is unverified.

## Direction

This is a JavaScript-environment boundary issue. The JS-host lane is being sunset (project-lead decision,
2026-10-10). Whether to fix it (a string value adapter on exported parameters and results) or only record it is
the lead's decision. No new JS-host work should start before that decision.

## Acceptance (if fixed)

- `f("abc")` returns 3 on the default, `node` and `web` targets.
- A JS string result crosses back as a JS string.
- `tests/issue-4513.test.ts` could then restore a string-parameter variant of its runtime-key test.
