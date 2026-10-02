---
id: 6743
title: "prettier standalone-dynamic lane: `__closure_336` emits invalid Wasm — `extern.convert_any[0] expected type anyref, found local.get of type f64`"
status: ready
sprint: current
created: 2026-09-29
updated: 2026-09-29
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone-mode
---

## Problem

After [#6730](./6730-prettier-standalone-print-doc-invalid-wasm.md) (`Ce` /
`printDocToString` now validates), the prettier `standalone-dynamic` lane's
next validation failure is a lifted closure:

```
CompileError: WebAssembly.compile(): Compiling function #1621:"__closure_336" failed: extern.convert_any[0] expected type anyref, found local.get of type f64 @+2359308
```

wasm-opt reports the same site:

```
[wasm-validator error in function __closure_336] unexpected false: unreachable instruction must have unreachable child, on
(extern.convert_any
 (local.get $1)
)
```

The closure's body opens with a string/element index read on its first user
parameter (`__strix_recv` = `local.get 1` + `extern.convert_any`, index
`f64.const 0`), then a `.length` read on the result. The closure's signature
types that parameter `f64`, while the body's index lowering assumes a
reference receiver — the parameter's ABI type and the body's receiver
representation disagree.

## Reproduce

```bash
npx tsx scripts/generate-npm-compat-report.mjs --only prettier --no-write --perf-only \
  --lane standalone-dynamic --inspect-binary .tmp/prettier.wasm --preserve-debug-names
node -e 'WebAssembly.compile(require("fs").readFileSync(".tmp/prettier.wasm")).catch(e=>console.log(String(e)))'
```

Compiling `node_modules/prettier/standalone.mjs` alone as the entry
(`compileMulti`, `target: "standalone"`, `deferTopLevelInit`,
`runtimeEvalProvider: false`, `preserveDebugNames`) reproduces the same
function (`#1618:"__closure_336"`); `emitWatOnlyFunctions: ["__closure_336"]`
prints its body.

## Acceptance

- The lane's unoptimized binary validates; the lane reports the next blocker
  (or a measured perf row).
- A reduced regression test for the offending closure shape, failing on the
  parent and passing with the fix.
