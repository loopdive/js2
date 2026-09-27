---
id: 6699
title: "standalone: axios `__native_globalThis_ensure` stack underflow — a void call's result is dropped (#2090)"
status: ready
sprint: current
created: 2026-09-26
updated: 2026-09-26
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [1032, 5383, 6698]
---

# #6699 — axios standalone-dynamic: `__native_globalThis_ensure` operand-stack underflow

## What you will see

With [#6698](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6698-standalone-extern-get-bucket-ladder-stack-overflow)
(the `__extern_get` ladder stack overflow) fixed, the npm-compat **axios**
standalone-dynamic lane
(`npx tsx scripts/generate-npm-compat-report.mjs --only axios --no-write --perf-only --lane standalone-dynamic`,
measured 2026-09-26) stops at:

```
stack-balance (#2090): cannot supply a missing stack value in function "__native_globalThis_ensure" — operand stack underflow by 2 in an empty-typed block (body delta -2, expected 0); this is not a missing block result; site function body[2].if.then[210].if.then, physical body #0; first negative net prefix at instruction 282 (initial stack depth 0); window: [280] f64.const {"value":189} (delta 1, running 3); [281] call {"funcIdx":2097530} (delta -3, running 0); [282] drop (delta -1, running -1); [283] local.get {"index":6} (delta 1, running 0); [284] global.get {"index":1098} (delta 1, running 1). The repair pass refuses to invent a value here because doing so would mask a producing codegen bug as a silent null. This is a compiler defect at the value producer; report the failing input.
```

## First reading

The window shows a 3-argument `call` to a stable-handle function
(`funcIdx 2097530` = 2^21 + 378, a `mintDefinedFunc` handle, see
`src/codegen/func-space.ts`) whose last argument is `f64.const 189`, followed by
`drop` — the producer assumed the callee returns a value but its resolved
signature is void (net -3). The helper is the outlined realm-global seed from
`src/codegen/native-globalthis-outline.ts` (#5383 S2p), site
`body[2].if.then[210].if.then`. Start by naming the callee (map the handle back
through `func-space`) and the seed step that emits the `call … drop`.
