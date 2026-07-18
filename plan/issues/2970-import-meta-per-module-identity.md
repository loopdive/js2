---
id: 2970
title: "codegen: import.meta is not a distinct per-module object (identity shared/absent across modules)"
status: done
assignee: ttraenkler/dev-perf
completed: 2026-07-17
priority: medium
sprint: current
created: 2026-07-02
feasibility: medium
task_type: bug
area: codegen
language_feature: module-code
goal: spec-completeness
related: [2932]
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/expressions.ts
---

# #2970 — `import.meta` per-module object identity

Split from #2932's honest-regression bucket. Exposed when `.js` fixture
modules started compiling for real (#2932): the baseline "pass" was the
null-import artifact.

## Failing test

`test/language/expressions/import.meta/distinct-for-each-module.js`

The test imports `{ meta as fixture_meta, getMeta }` from a fixture module and
asserts:

1. `import.meta !== fixture_meta` (each module gets its own object),
2. `import.meta !== getMeta()` (a function returns the `import.meta` of the
   module it is declared in),
3. `fixture_meta === getMeta()` (stable identity within one module).

## Spec

sec-meta-properties-runtime-semantics-evaluation — `module.[[ImportMeta]]` is
created once per module record and cached; distinct module records have
distinct objects.

## Direction

Multi-file compiles need a per-source-file `import.meta` object (lazily
created singleton per module, e.g. one immutable extern/struct global per
compiled module unit), not a shared or absent value.

## Acceptance

- `distinct-for-each-module.js` passes via the test262 runner.
- Identity is stable within a module and distinct across modules.

## Resolution (2026-07-17)

Previously a bare `import.meta` value read compiled to a shared
`"[object Object]"` string constant (`src/codegen/expressions.ts`), so every
`import.meta` in every module was the *same* value — `import.meta !== other`
was always `false` and the distinctness assertions failed.

New module `src/codegen/import-meta.ts` (`ensureImportMetaObject`):

- registers ONE shared zero-field `$ImportMeta` struct type (`ImportMeta`),
- creates a DISTINCT immutable global instance per source file
  (`struct.new $ImportMeta`), keyed by `SourceFile.fileName`.

The bare `import.meta` value handler now emits `global.get` of the current
file's singleton (`expr.getSourceFile().fileName`), typed `(ref $ImportMeta)`.
Because multi-file compiles land in a single Wasm module, "per module record"
== "per source file"; each `struct.new` is a fresh instance, so `ref.eq`
identity gives:

- stable within a module (`fixture_meta === getMeta()` — the function's
  `import.meta` node lives in the fixture file → fixture's global),
- distinct across modules (`import.meta !== fixture_meta`).

`import.meta.<prop>` reads (`.url`, unknown props) are intercepted **upstream**
in `trySuperAndImportMetaRead` (property-access-dispatch), so the object needs
no concrete fields — only reference identity. `import.meta + ""` still yields
`"[object Object]"` (generic struct ToString), and `typeof import.meta` is
still `"object"` (handled by AST in typeof-delete). No raw checker queries
(uses `expr.getSourceFile()`) — oracle-ratchet +0.

## Test Results

`tests/issue-2970.test.ts` — 7 cases green: the `distinct-for-each-module`
shape via `compileMulti` (returns 7 = all three identity assertions), same-
module `===` stability, `typeof === "object"`, `!== null`/`!== undefined`,
`+ ""` → `"[object Object]"`, unknown-prop `=== undefined`, and a two-importer
re-export chain (both importers see the SAME fixture object; entry's own
differs).
