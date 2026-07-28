---
id: 3721
title: "diff@9.0.0's dist/diff.js rejected with TS8010/8017 'can only be used in TypeScript files' — false positive, real tsc reports zero errors on the same file"
status: ready
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: medium
horizon: m
feasibility: hard
reasoning_effort: medium
task_type: bugfix
area: checker
language_feature: n/a
goal: core-semantics
origin: "ad-hoc probe of 3 more single-bundled-file npm packages (dayjs/mustache/diff), same shape as the acorn/marked dogfood pattern"
related: [3717, 1710, 3716]
---

# #3721 — diff@9.0.0 false-positive TS syntax errors

## Repro

Pin: `diff@9.0.0`, entry `dist/diff.js` (self-contained UMD bundle, 2313
lines, zero `require()` calls — same "single pre-bundled dist file" shape
as acorn/marked; note the package's own `main`/`module` fields point at a
multi-file `libcjs`/`libesm` source tree, but `dist/diff.js` is the
pre-rolled bundle, same relationship as acorn's `dist/acorn.mjs`).

```bash
npm pack diff@9.0.0
tar -xzf diff-9.0.0.tgz
```

```ts
import { compile } from "./src/index.js";
import { readFileSync } from "node:fs";
const src = readFileSync("package/dist/diff.js", "utf-8");
const result = await compile(src, { fileName: "diff.js", skipSemanticDiagnostics: true });
// result.success === false, result.binary.length === 0
// result.errors:
//   TS8017 "Signature declarations can only be used in TypeScript files." @ line 1, col 1
//   TS8010 "Type annotations can only be used in TypeScript files."       @ line 1, col 1  (x3)
```

All 4 diagnostics report `line: 1, column: 1` — a suspicious uniform
position that looks like a fallback/default rather than a real located
error.

## This is confirmed a FALSE POSITIVE, not real content

Ran the exact same file through real `tsc` directly (not js2wasm),
matching js2wasm's own `allowJs` handling:

```bash
npx tsc --noEmit --allowJs --checkJs false --target es2022 --lib es2022 package/dist/diff.js
```

Zero errors on the file itself (only unrelated `@types/node` ambient-lib
resolution noise, nothing referencing `diff.js`). Also grepped the file
directly for any construct that could produce TS8010/8017 (parameter type
annotations `(x: T)`, `interface`, `declare`, `readonly`, generic
`function<T>`, ambient overload signatures ending in `;` with no body) —
**none found**. The file is plain ES2015+ JS (UMD wrapper, `class`
syntax), nothing TS-only.

## What's been ruled out as the cause

js2wasm has a known mechanism where a synthesized **TS source prelude**
(`injectProcessStdinPrelude` / `injectIteratorStaticsPrelude`,
`src/compiler.ts` around line 1287, `#2752`) gets prepended ahead of a
`.js`-named user file and the combined unit must be parsed under
`ts.ScriptKind.TS` (`forceTsGrammar`) or the prelude's own TS syntax gets
rejected with these exact same codes (8010/8017) — that was the leading
hypothesis. Traced both injectors' trigger conditions
(`src/process-stdin-prelude.ts:179-189`,
`src/iterator-statics-prelude.ts:162-182`):

- `injectProcessStdinPrelude` requires both literal substrings `"process"`
  and `"stdin"` present. `diff.js` contains `"process"` (in comments/an
  identifier, e.g. `processIndex`) but **never** `"stdin"` — the cheap
  pre-check short-circuits, `injected: false`.
- `injectIteratorStaticsPrelude` requires the literal substring
  `"Iterator"` (present — once, in a comment: `dist/diff.js:1516` "Iterator
  that traverses...") AND one of `HELPERS = ["zip", "zipKeyed", "concat",
  "from"]` (near-certainly present somewhere in a 111 KB bundle — "concat"
  and "from" are common). This passes the cheap pre-check, but the
  injector then does a real AST walk (`findIteratorHelperAccesses`)
  looking for actual `Iterator.<helper>` property-access expressions —
  diff.js has no real `Iterator.zip`/`.from`/etc. call sites (only the
  unrelated comment), so `accesses.length === 0` and it should correctly
  return `injected: false`.

Both injectors *appear* to correctly no-op for this file based on reading
their trigger logic — **not independently confirmed at runtime** (no
instrumentation/breakpoint was added to verify `forceTsGrammar` is
actually `false` for this compile). That verification step, plus checking
whether some OTHER code path (a diagnostic-collection pass distinct from
the main emit path — e.g. a `analyzeSource`/checker-layer parse that
doesn't thread the same `forceTsGrammar` decision made in
`compiler.ts:1293`) is where the mismatch actually happens, is the
concrete next step.

## Scope

- [ ] Instrument/trace the actual `compile()` call for this file to
      confirm whether `forceTsGrammar` and the resulting `scriptKind` are
      what's expected (`false` / `ts.ScriptKind.JS`) at every parse site
      that runs for a single-source compile — not just the main emit path.
- [ ] If `forceTsGrammar` is correctly `false` throughout: find what other
      mechanism is misclassifying real JS syntax in this file as TS-only
      (the uniform `line:1,col:1` position across all 4 diagnostics is a
      strong clue — likely a diagnostic-position-mapping bug, possibly
      related to `PositionMap` used by the prelude-injection system even
      when no prelude was actually inserted).
- [ ] Minimal repro reduced from the 2313-line bundle (bisect which
      specific construct near the file's `class Diff { diff(...) {`
      opening, or elsewhere, trips this) — not yet attempted here.
- [ ] Re-run — expect `compile.success: true` (or a legitimate diagnostic
      unrelated to TS-syntax-in-JS-file).

## Acceptance criteria

- [ ] Root cause identified with a minimal (non-111KB) repro.
- [ ] `diff@9.0.0`'s `dist/diff.js` compiles without the false TS8010/8017
      diagnostics.
- [ ] A regression test pins the minimal repro.
