---
id: 6841
title: "standalone: browser DOM globals (document, navigator, …) emitted 12 env:: extern-class imports (styled-components)"
status: done
sprint: current
created: 2026-10-05
updated: 2026-10-05
completed: 2026-10-05
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
language_feature: globals
goal: standalone
requested_by: ttraenkler/wave9-styled-hostimports
related: [6664, 6691, 6675, 6659, 4576, 6855, 6858]
---

# #6841 — browser DOM globals leak `env::` imports into a standalone binary

## What you will see

Measured 2026-10-05 on upstream/main `b6324ee6d1`:

```
npx tsx scripts/generate-npm-compat-report.mjs --only styled-components --no-write --perf-only --lane standalone-dynamic
standaloneDynamic: host-import-error — "standalone binary retained 12 host import(s)" (1.86 MB optimized)
  env.Document_get_head, env.Document_createElement, env.Element_setAttribute,
  env.Node_appendChild, env.Document_createTextNode, env.HTMLStyleElement_get_sheet,
  env.Node_getRootNode, env.Document_get_styleSheets, env.Node_get_childNodes,
  env.Node_insertBefore, env.Node_removeChild, env.Navigator_get_product
```

One construct cluster: lib.dom browser globals. styled-components'
`makeStyleTag` / `CSSOMTag` / `TextTag` / `getRootNode` helper read `document`
(and values derived from it), and the dev warning reads `navigator.product`.
The lane's sample op (`typeof css + text.length`) reaches none of it.

Root cause, two halves:

1. `document` / `navigator` / `window` / `location` / `history` reads in a
   host-free module produced `null` (the `ref.null.extern` graceful default),
   although `typeof` already folds them to `"undefined"`
   (`HOST_ONLY_AMBIENT_GLOBALS`, `src/codegen/typeof-delete.ts`).
2. `Document`, `Node`, `Element`, `HTMLStyleElement`, `Navigator`, … were still
   registered as extern classes from lib.dom, so every member access typed
   through them lowered to `env::<Class>_<member>`.

## Implementation Plan

Follow the #6664/#6691 precedent in `src/codegen/standalone-unavailable-globals.ts`:

- Add the browser value globals (`document`, `window`, `navigator`,
  `location`, `history`) to `isUnavailableName`, gated on a host-free
  environment (`targetProfile.environment === "none"`) and NOT a certified
  DOM-capability module (`ctx.requiresStandaloneDomCapability`, #4576 — that
  module's embedder provider owns `document`). The existing identifier and
  `typeof` hooks then throw `ReferenceError: <name> is not defined` on a read.
- Add the lib.dom node/document/CSSOM interfaces (explicit set plus the
  `HTML*Element` / `SVG*Element` families) to `isStandaloneUnprovidedExternClass`
  under the same gate, so their members take the ordinary dynamic-property
  lowering (in standalone: in-module) instead of extern-class imports.
- `src/codegen/lib-extern-scan-memo.ts`: the memo key must carry the
  environment and the DOM-capability bit, because the scan's result now
  depends on them (it already depended on the environment through the #6691
  Fetch gate).

JS-host lane: every gate requires `ctx.standalone`; byte-identical.

Acceptance: styled-components standalone-dynamic retains 0 host imports;
regression test fails on the parent and passes with the fix; a user binding
of the same name and DOM-typed user objects keep working (anti-vacuity).

## Resolution

- `src/codegen/standalone-unavailable-globals.ts`: browser value globals
  (`document`, `window`, `navigator`, `location`, `history`) are unavailable
  names in a host-free module that is not a certified DOM-capability module;
  a read throws `ReferenceError: <name> is not defined` (was `null`). The
  lib.dom node/document/CSSOM interfaces (explicit set + `HTML*Element` /
  `SVG*Element`, `MediaQueryList`) are not registered as extern classes under
  the same gate, so their members lower through the ordinary in-module
  dynamic-property path.
- `src/codegen/standalone-timers.ts`: `requestAnimationFrame`,
  `cancelAnimationFrame`, `getComputedStyle`, `matchMedia` join the
  no-event-loop set. `getComputedStyle` was the 13th import, visible only in
  the unoptimized binary (the optimizer folds styled-components'
  `createTheme().resolve` away behind `IS_BROWSER`).
- `src/codegen/lib-extern-scan-memo.ts`: memo key carries the environment and
  the DOM-capability bit (the scan result depends on both; the #6691 Fetch
  gate already depended on the environment without being in the key).

Measured (`--only styled-components --perf-only --lane standalone-dynamic`):

| | before (`b6324ee6d1`) | after |
|---|---|---|
| status | `host-import-error` — 12 imports | `runtime-error`, phase `module-init` — `TypeError: called value is not a function` |
| imports (optimized) | 12 | 0 |
| imports (unoptimized) | 12 + `getComputedStyle` | 0 |
| optimized bytes | 1,857,970 | 1,853,070 |

Next blocker filed as
[#6855](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6855-standalone-styled-components-module-init-typeerror).
Found on the way:
[#6858](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6858-standalone-typeof-imported-function-binding)
(`typeof importedFn` is not `"function"` standalone; pre-existing).

JS-host lane: styled-components driver compiled `--target gc` before/after,
unoptimized — byte-identical (sha1 `c42f5143f4…`, 602,047 bytes). Every gate
requires `ctx.standalone` or `environment === "none"`.

Scoped standalone test262 (`language/expressions/typeof`, `built-ins/global`,
45 rows), before/after: 29 pass / 16 non-pass both, same rows (the one row
that read `compile_error` after was a load timeout; re-run alone: same `fail`
as base). Targeted vitest A/B over 21 DOM/standalone test files: every failure
also fails on the parent (load timeouts and pre-existing).

Regression test `tests/issue-6841-standalone-browser-dom-globals.test.ts`:
4 of 5 cases fail on the parent (imports), all pass with the fix; the
same-name user-binding case is the anti-vacuity control (passes both ways),
and the typed-member case proves the dynamic member path resolves on ordinary
objects rather than throwing.
