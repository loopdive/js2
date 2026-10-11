---
id: 6752
title: "standalone: three.js raw module is rejected by wasm-opt — popping from empty stack"
status: ready
sprint: Backlog
created: 2026-09-29
updated: 2026-09-29
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [1599, 6733]
---

# #6752 — three.js standalone-dynamic: wasm-opt cannot parse the raw module

## Problem

With [#6733](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6733-standalone-three-inherited-getter-alias-signature)
fixed (inherited class aliases follow a forward-reference retype), the three
0.185.1 standalone-dynamic lane compiles (~1,620 s under heavy box load) and
stops at optimization:

```
wasm-opt -O4 did not produce the measured artifact: wasm-opt -O4 failed: [parse exception: popping from empty stack (at 0:8674212)]
Fatal: error parsing wasm (try --debug for more info)
```

Binaryen's parser rejects the raw binary, so some emitted function body has an
operand-stack underflow that the stack-balance pass (#2090) did not catch.

## Reproduce

```
npx tsx scripts/generate-npm-compat-report.mjs --only three --no-write --perf-only --lane standalone-dynamic --inspect-binary
```

## Next steps

- Keep the unoptimized binary (`--inspect-binary`) and map byte offset
  8674212 to its function (`wasm-tools print` / `wasm-objdump -d`), then reduce
  the source construct that emits it.
- Validate the raw binary with V8 (`WebAssembly.validate`) to see whether it is
  invalid for every consumer or only for Binaryen.

## Acceptance criteria

- The three standalone-dynamic lane passes wasm-opt -O4 (record the next error
  here).
