---
id: 7279
title: "IR: default-initialised parameters (`function f(a, b = \"\")`) refused as `param-shape-rejected` — measured: no sole-blocker population"
status: blocked
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: investigation
area: ir
goal: ir-full-coverage
related: [7254, 7268]
assignee: "ttraenkler/c-lead"
---

# #7279: default-initialised parameters refused as `param-shape-rejected`

## Problem

The harness function `formatPropertyName(propertyKey, objectName = "")`
(`test262/harness/temporalHelpers.js:12`) refuses as `param-shape-rejected`
(a default-initialised parameter; `src/ir/select.ts`, the identifier-param arm:
`if (p.initializer) return "param-shape-rejected"`, mirrored in from-ast's
parameter map). On main's wrapped stride-40 standalone ledger it is the second
of exactly two legacy units in 66 files.

## Measurement (2026-11-06, base `origin/main` 8b349439)

Wrapped ledger, stride 40, standalone, `JS2WASM_IR_SHAPE_DIAG=1`, `--files-json`:
1296 files, 32 with zero legacy units.

**Files with a `param-shape-rejected` unit: 79. Files where that unit is the
only legacy unit: 0.** Pair partners of the 2-legacy-unit files: module-init
`vardecl-module-storage-unrepresentable` 66, `expr-ident-not-in-scope` 1,
`call-graph-closure` 1, a from-ast demotion 1.

Units by parameter shape:

| unit | parts | shape |
| --- | ---: | --- |
| `formatPropertyName` (temporalHelpers.js) | 69 | identifier `= ""` (string literal) |
| `__js2wasm_Iterator_zip` / `zipKeyed` / `concat` (injected runtime) | 4 + 4 + 4 | not in the test source (runtime helpers) |
| test `f` | 3 | array pattern `= [...]` |
| test `f` | 1 | object pattern `= {...}` |
| test `f` | 1 | identifier `= <binary expression>` |
| test `createOptionsObserver` | 2 | object pattern `= {...}` |
| test `af` | 1 | rest identifier |

### The `formatPropertyName` chain

With the default-parameter refusal lifted locally (a probe, not committed),
`formatPropertyName` next refuses as `expr-ident-not-in-scope(Symbol)`. Its
body still needs, in order:

1. the default parameter (`objectName = ""`, a string-literal default);
2. `Symbol.keyFor(propertyKey)` and `propertyKey.description` (a symbol
   receiver);
3. `ASCII_IDENTIFIER.test(propertyKey)` and
   `propertyKey.replace(/'/g, "\\'")` — a regex held in a module `const`, and
   a regex-literal replace;
4. the test's own module-init (`vardecl-module-storage-unrepresentable`), the
   pair partner in all 66 files.

So admitting literal defaults alone moves 0 of the 66 files. Scope agreed with
the C lead: implement only where the default is the ONLY remaining blocker;
that population is 0, so this issue stays docs-only until (2)–(4) land.

### What legacy emits for a default parameter (`src/codegen/function-body.ts`)

At function entry, in parameter order, each defaulted parameter is tested and,
when it fires, the default is compiled into its local:

- `externref` param: `__extern_is_undefined(p)` (missing and explicit
  `undefined` both fire, `null` does not);
- `ref` / `ref_null` param (a native string): `ref.is_null(p)` (callers pad a
  missing argument with null);
- `f64` / `i32` param: the `__argc` protocol (`cacheParamDefaultArgc`) — and,
  for `f64`, also the sNaN sentinel;
- a default that reads its own or a later parameter throws ReferenceError (TDZ,
  #2121); a non-simple list hoists the `arguments` object before the defaults
  (#6651).

An IR lowering must reproduce that exactly per carrier: the `ref.is_null` arm
for a string default is the bounded first slice once a function needs it.

## Follow-ups

- `Symbol.keyFor` / symbol `.description` on the IR path (chain step 2).
- Regex `.test` on a module-`const` regex and `.replace` with a regex literal
  (chain step 3).
- Then the literal-default parameter slice (chain step 1), for string (`ref`)
  parameters first; the `__argc` carriers after.
