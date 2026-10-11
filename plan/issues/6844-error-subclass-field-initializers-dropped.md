---
id: 6844
title: "regression: prettier upstream unit suite 108 → 75 — field initializers of `class X extends Error` were dropped on the JS host, exposed when #6798 made `typeof C` a class object's correct \"function\""
status: done
sprint: Backlog
created: 2026-10-05
updated: 2026-10-05
completed: 2026-10-05
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: codegen
language_feature: classes, error-subclass, class-fields
goal: core-semantics
related: [6798, 1366a, 2101a, 2101b, 3995, 6845]
requested_by: ttraenkler/wave10-prettier-regression
assignee: "ttraenkler/wave10-prettier-regression"
branch: "issue-6844-prettier-error-subclass-fields"
origin: "2026-10-05 — npm-compat dashboard: prettier 108/151 (2026-10-02 09:13Z refresh) → 75/151 (11:07Z refresh)"
loc-budget-allow:
  # 2026-10-05 externref field-init: route + inject codegen ops into the leaf helper (+15);
  # the emission itself lives in src/codegen/classes/externref-class-fields.ts
  - src/codegen/class-bodies.ts
func-budget-allow:
  # 2026-10-05 externref field-init: the field-init closure routes externref-backed
  # classes to the leaf helper instead of returning early (+1, block form for biome
  # noVoidTypeReturn)
  - src/codegen/class-bodies.ts::compileClassBodiesInner
---

# #6844 — `class X extends Error { name = "X" }` dropped its field initializers (prettier 108 → 75)

## Problem

The prettier 3.8.1 upstream unit suite (`tests/dogfood/prettier-upstream-suite.mjs`)
fell from **108/151 to 75/151** between two dashboard refreshes on 2026-10-02.
Measured on current main (`c3e3fab33d`): 75/151, with
`tests/unit/doc-builders.js` at 9/46 (was 41/46).

### Bisect

`doc-builders.js` alone, `src/` checked out at each first-parent merge:

| src at | merge | doc-builders |
| --- | --- | --- |
| `db906b6007` | window base | 41/46 |
| `1255c536b4` | #6423 | 41/46 |
| `3209125223` | #6427 (intl locale data) | 41/46 |
| `8196eba1ff` | **#6428 (#6798 misc semantics)** | **9/46** |
| `2b8101b9bc` | #6434 | 9/46 |

Culprit merge: **#6428**, the #6798 arm that makes a WasmGC class object
answer `typeof` → `"function"` (`_classObjectOwnPropertyNames.has(v)` in the
host `__typeof` and `isCompiledClosure`).

### Mechanism — #6798 is correct; it unmasked a silent field-drop

The 32 lost rows are the `toThrow(InvalidDocError)` cases. The upstream-suite
shim's matcher is:

```js
if (typeof expected === "function") return error instanceof expected || error.name === expected.name;
return true;
```

Before #6798, `typeof InvalidDocError` (a compiled class held in a variable)
answered `"object"`, so every one of these rows fell through to `return true`
and passed **without checking anything**. After #6798 the check really runs —
and both halves fail:

1. `error.name === expected.name` — prettier declares the name as a class
   field: `class InvalidDocError extends Error { name = "InvalidDocError"; … }`.
   On the JS-host lane an `extends Error` instance is the host object
   `__new_Error` returned, not a WasmGC struct, and the constructor's field
   loop skipped every externref-backed class (`#1366a`: "would need to be
   installed via host setters, which is out of scope"). The initializer never
   ran, so `error.name` read the inherited `"Error"`. Same defect makes
   `tests/unit/errors.js` 0/3 (`ConfigError`, `UndefinedParserError`,
   `ArgExpansionBailout` all use `name = "…"`).
2. `error instanceof expected` with the class held in a parameter is false on
   the JS host — a separate, pre-existing class-value gap filed as
   [#6845](./6845-class-value-dynamic-instanceof-typeof-name.md). Not needed
   for the suite once (1) is fixed.

Reduced (untyped `.js`, JS host):

```js
class ConfigError extends Error { name = "ConfigError"; }
new ConfigError("foo").name   // wasm "Error", node "ConfigError"
```

The harness is not at fault: its `typeof expected === "function"` arm is
exactly what real JS does, and node passes all 46 rows.

## Implementation Plan

1. New leaf module `src/codegen/classes/externref-class-fields.ts`,
   `emitExternrefBackedFieldInitializers(ctx, fctx, decl, selfLocal)`: for each
   own, non-static, non-`declare`, non-`accessor` `PropertyDeclaration` with an
   initializer and a static key (identifier / string / numeric literal), emit
   §7.3.33 DefineField as `__defineProperty_value(self, key, value, flags)`
   with writable/enumerable/configurable all set (CreateDataPropertyOrThrow —
   a define, not a `Set`, so an inherited setter / non-writable inherited
   `name` is not consulted). Re-read the helper's funcIdx after compiling the
   initializer (late-import shifts). Codegen entry points (`compileExpression`,
   `coerceType`, `ensureLateImport`, `flushLateImportShifts`, string-key push)
   are INJECTED from `class-bodies.ts` so the leaf stays out of the codegen
   import SCC (import-cycles ratchet).
2. `class-bodies.ts` `emitOwnInstanceFieldInitializers`: route
   externref-backed classes to the new helper instead of returning. The call
   site already runs at the right time — the constructor-initialization point
   for implicit constructors, right after `super(...)` returns for explicit
   ones (§13.3.7.1).
3. Scope: JS-host lane only (`ctx.standalone || ctx.wasi` → no-op, standalone
   constructor byte-identical). Private (`#x`) and computed keys keep today's
   behaviour. Fields without an initializer are not defined (in a TS source
   they are usually type-only and defining `undefined` would shadow
   `message`/`name`).
4. Regression test `tests/issue-6844-error-subclass-field-initializers.test.ts`:
   two-file untyped `.js` fixture (errors module + user module), expectations
   from native node, four rows failing on the parent, one field-less control.

Acceptance: prettier suite ≥ 108; no suite in {prettier hono redux lodash
axios jest marked uuid clsx cookie moment} drops; scoped test262 (gc +
standalone) over the class-subclass / Error-subclass files does not drop.

## Resolution

Implemented as planned (2026-10-05). Measured base (main `c3e3fab33d`) vs
fix, same HEAD, suites run one at a time on a loaded box:

| suite | base | fix |
| --- | --- | --- |
| prettier | 75/151 | **111/151** |
| hono | 271/324 | 271/324 |
| redux | 67/82 | 67/82 |
| lodash | 59/62 | 59/62 |
| axios | 208/231 | 208/231 |
| jest | 336/356 | 336/356 |
| marked | 16/30 | 16/30 |
| uuid | 75/75 | 75/75 |
| clsx | 32/32 | 32/32 |
| cookie | 63740/63740 | 63740/63740 |
| moment | 10/10 | 10/10 |

Scoped test262 over the 109 class-subclass / Error-subclass files: gc 80/109
both sides (identical non-pass list), standalone 94/109 both sides.


- `doc-builders.js` 9/46 → 41/46 and `errors.js` 0/3 → 3/3 — the 32
  `toThrow(InvalidDocError)` rows now pass because the check genuinely holds
  (`error.name === "InvalidDocError"`), not because the matcher fell through.
- Remaining prettier residue is unrelated to this mechanism (compile-time
  `--allow-fs` + async-try refusals in four files, TypeError-for-non-array in
  three doc-builders rows, a null deref in `indentIfBreak`).
- Not done here: standalone/WASI field initializers on `$Error_struct`
  instances (needs the #2101a own-field backing — see #2101b) and the
  class-value gaps in #6845.
