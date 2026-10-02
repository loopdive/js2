---
id: 6754
title: "tailwindcss standalone-dynamic lane: `class extends Map` with a field breaks the struct hierarchy (`U` / `__anonClass_70` no longer an exact mutable-field prefix of `Map`)"
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

With tailwindcss's generators lowered natively
([#6731](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6731-native-generator-residual-shapes),
2026-09-29), the tailwindcss 4.3.3 `standalone-dynamic` lane fails first on

```
struct hierarchy layout became invalid before finalization: subtype #196 (U) supertype #93 (Map) is no longer an exact mutable-field prefix
```

(`npx tsx scripts/generate-npm-compat-report.mjs --only tailwindcss --no-write --perf-only --lane standalone-dynamic`).
A second diagnostic names `__anonClass_70`, another `Map` subclass. The source
(`package/dist/lib.mjs`):

```js
var U=class extends Map{constructor(r){super();this.factory=r}factory;get(r){let t=super.get(r);return t===void 0&&(t=this.factory(r,this),this.set(r,t)),t}};
```

A class extending the builtin `Map` that adds an own field (`factory`) and
overrides `get` with a `super.get` call.

## Other errors in the same compile (reported, not this issue)

- stack-balance invariant: `__anon_87_parseCandidate` references local 37, but
  only 2 params + 11 locals are declared;
- host-import-leak warnings `env.Intl_ListFormat_new`,
  `env.Intl_ListFormat_format`, `env.Promise_all`.

## Acceptance

A minimal `class extends Map { f; constructor(){ super(); this.f = 1 } get(k){ return super.get(k) } }`
compiles and runs host-free in standalone (regression test failing on its
parent); the tailwindcss lane moves past this diagnostic (report the next one
verbatim).
