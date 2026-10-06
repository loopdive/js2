---
id: 6876
title: "CJS rewrite: hoist `require('<literal>')` inside module-scope control flow (react's `NODE_ENV` idiom) — the host lane drops it to null, the regime throws ReferenceError"
status: ready
created: 2026-10-06
updated: 2026-10-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: commonjs
goal: architecture
parent: 6749
related: [5385, 6749, 6875]
---

# #6876 — in-branch `require` is neither compiled nor delegated

## Problem (measured 2026-10-06)

react's npm-compat row is vacuous on the host lane and a runtime error on
the native regime, for one reason. react's entry is

```js
if (process.env.NODE_ENV === 'production') { module.exports = require('./cjs/react.production.js'); }
else { module.exports = require('./cjs/react.development.js'); }
```

`src/cjs-rewrite.ts` rewrites `require` only at module scope
(`extractRequireSpecifier`; the `const x = require('…')` /
`module.exports = require('…')` statement shapes). A `require` inside a
statement body is left alone. Disassembly of a minimal
`if (globalThis.__flag) { module.exports = require("./a.js") } else { … }`
on the host lane (`wasm-opt -all --print`, `optimize: false`): BOTH branches
lower to `global.set $exports (ref.null noextern)` — the call is dropped to
the graceful-null default, so react is never compiled or loaded and the perf
driver's sample op never touches it. On the regime the bare `require` read
throws `ReferenceError: require is not defined` (`identifiers.ts`, "truly
undeclared variable" arm) — the only reason the rows differ. Re-keying
declared-global gates is not the fix: there is no `require` binding on either
lane. Notes: #6749 "react, corrected".

## Fix

In `src/cjs-rewrite.ts`, hoist every `require(<static literal>)` inside
module-scope control flow (if/else, ternaries, nested blocks; not function
bodies) into a module-scope import and replace the call with the binding the
existing top-level rewrite produces for `const __cjs_N = require('<spec>')`
(reuse its namespace/default-interop mapping; no second mapping). Non-literal
`require(x)` stays untouched. Hoisted modules evaluate eagerly at module init
(ESM semantics, what bundlers do for this idiom) — document it. Extend the
resolver's `scanRequire` (`src/resolve.ts` ≈ L705-735) to the hoisted shapes
so package edges are discovered. Then record what `process.env.NODE_ENV`
resolves to on each lane; a regime failure there is a separate finding.

## Acceptance

- [ ] `tests/issue-6876-cjs-in-branch-require-hoist.test.ts`: two-file
      project with the idiom, `compileProject({ allowJs, platform: "node" })`
      under default gc, `semanticProviders: "native-first"`, and
      `--target standalone`; the chosen module's export is observable.
- [ ] react measures on BOTH npm-compat lanes with Node's checksum
      (`--only react --perf-only --lane js-host` / `js-host-native`). A
      remaining regime failure is recorded verbatim, box left unticked.
- [ ] Deliberately not byte-identical for programs with the idiom (both lanes
      now compile the module); sha256 identity shown for a program without it
      on default gc / standalone / wasi.
- [ ] Existing CJS suites, `issue-4396`, `issue-6686` green.
