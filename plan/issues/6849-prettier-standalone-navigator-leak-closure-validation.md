---
id: 6849
title: "prettier standalone-dynamic: env.Navigator_get_platform leak, then __closure_532 fails Wasm validation"
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: globals
goal: standalone
requested_by: ttraenkler/wave9-prettier-intl
related: [6839, 6731, 6664, 6691, 2961]
---

# #6849 — prettier standalone-dynamic: the two blockers after #6839

## What you will see

Measured 2026-10-05 on `b6324ee6d1` + #6839 (Wasm-native `Intl.ListFormat`):

```
npx tsx scripts/generate-npm-compat-report.mjs --only prettier --no-write --perf-only --lane standalone-dynamic
standaloneDynamic: compile-error — Host import leak (warning, #2961):
host import "env.Navigator_get_platform" survives into the finished --target standalone binary
```

An unoptimized `compileProject` of the same perf driver
(`tests/dogfood/.prettier/.js2-npm-compat-perf-standalone-dynamic.mjs`,
`target: "standalone"`, `allowJs`, `deferTopLevelInit`) reports, in order:

1. `env.Navigator_get_platform` (the only remaining leak; `env.Promise_all`
   from #6731's notes no longer leaks on this base);
2. `emitted WebAssembly failed validation — Compiling function "__closure_532"
   failed: type error in fallthru[0] (expected (ref null 38), got (ref 2))`.
   This one is present on the parent too (same function, same message), so it
   is independent of #6839.

## Source shapes

1. prettier's Windows probe, run at module init:

   ```js
   function Ho(){let e=globalThis,t=e.Deno?.build?.os;
     return typeof t=="string"?t==="windows":
       e.navigator?.platform?.startsWith("Win")??e.process?.platform?.startsWith("win")??!1}
   var Xo=Ho();
   ```

   `globalThis.navigator` is typed by lib.dom as `Navigator`, so `.platform`
   lowers through the `Navigator` extern class to `env.Navigator_get_platform`.
   A standalone module has no `navigator` (#6664/#6691 precedent): the read
   should be the dynamic `globalThis` property read (→ `undefined`, the optional
   chain short-circuits), i.e. `Navigator` belongs with the
   `STANDALONE_UNPROVIDED_EXTERN_CLASSES` in
   `src/codegen/standalone-unavailable-globals.ts`.
2. `__closure_532`: not yet localised — bisect with `--inspect-wat` on the perf
   driver and map the closure back through the source map.

## Acceptance

prettier standalone-dynamic moves past `compile-error`; the JS-host lanes stay
byte-identical.
