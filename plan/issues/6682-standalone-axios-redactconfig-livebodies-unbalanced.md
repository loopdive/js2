---
id: 6682
title: "standalone: axios `redactConfig` trips codegen invariant #2182 (liveBodies unbalanced, entry=1 exit=2)"
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
language_feature: closures
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [1472, 2182, 5301, 6660]
---

# #6682 — axios `redactConfig`: liveBodies unbalanced under `--target standalone`

## What you will see

After [#1472](https://js2wasm.loopdive.com/dashboard/issue.html?slug=1472-no-js-host-object-property-ops)'s
`Buffer` receiver slice, the npm-compat **axios** standalone-dynamic lane
(`npx tsx scripts/generate-npm-compat-report.mjs --only axios --no-write --perf-only --lane standalone-dynamic`,
measured 2026-09-26) stops at:

```
Internal error compiling function 'redactConfig': codegen invariant (#2182): liveBodies unbalanced after compiling 'redactConfig' (entry=1, exit=2) — a detached-body liveBodies.add() is missing its matching .delete(), risking funcIdx over-shift.
```

at `package/lib/core/AxiosError.js:29:1`. The full error list of that compile
has one more entry after it:
`.js2-npm-compat-perf-standalone-dynamic.mjs:4:32 Codegen error: Maximum call stack size exceeded (at src/codegen/fixups.ts:207:17)`
(also listed in #6660; possibly a consequence of the unbalanced body).

## Shape

`redactConfig(config, redactKeys)` builds a `Set` from `redactKeys.map(...)`,
then a self-recursive arrow `visit` that closes over `lowerKeys`, `seen`, and
the module imports `utils` / `AxiosHeaders`; the array arm recurses from a
`forEach` callback, the object arm from a `for (const [key, value] of
Object.entries(source))` loop with a ternary (`lowerKeys.has(...) ? REDACTED :
visit(value)`).

A single-file copy with local stubs for `utils` and `AxiosHeaders` compiles and
runs correctly under standalone (`1`), so the trigger involves the imported
bindings (`utils` from `../utils.js`, `AxiosHeaders` from
`./AxiosHeaders.js`) — start the reduction from the real two-module graph.

## Pointers

- `#2182` liveBodies invariant: a detached-body `liveBodies.add()` without a
  matching `.delete()` on some early-return path.
- #5301 fixed the JS-host trap in the same function (self-recursive arrow
  conditional box).
