---
id: 7105
title: "IR module bindings: admit SCRIPT-goal top-level var scalars (test262 is all scripts)"
status: in-progress
sprint: current
created: 2026-10-20
updated: 2026-10-20
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 6920
assignee: "ttraenkler/claude-c"
# 2026-10-20: the script-goal admission predicate (`scriptVarSlotIsSoleHome`)
# lives next to `recordSourceGlobalEnvironment`, the function that records the
# script-only sets it reads; the resolver option is one line at each of the
# two construction sites, and `planIrOverlay` grows by that line.
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
  - src/ir/integration.ts::compileIrPathFunctions
loc-budget-allow:
  - src/codegen/index.ts
  - src/ir/module-bindings.ts
  - src/ir/integration.ts
---

## Problem

Every test262 test is a **script** (no `import`/`export`). The IR module-binding
resolver's #2949 capability — a unique top-level `var` scalar shares legacy's
`__mod_<name>` slot — was gated on `ts.isExternalModule(sourceFile)`, so on
test262 **no** top-level `var` was ever in scope for an IR function body:
every read was `body-shape-rejected` / `expr-ident-not-in-scope`, every write
`nontail-assign-nonprop-lhs`. Measured 2026-10-20 with the #6806 census on
`built-ins/Array/prototype/map` (216 tests): `kValue` / `accessed` /
`called`-style script vars were the largest **test-local** reject arm after
the harness globals (`assert`, `Object`, `JSON`, `Test262Error`).

Legacy allocates the identical slot for a script `var` and compiles a plain
read/write to `global.get` / `global.set` on it (probe: `var called = 0;
function cb(v) { called = called + 1; … }` on the standalone target).

## Implementation

- `src/ir/module-bindings.ts`: `IrModuleBindingResolverOptions.admitScriptVar`
  — a codegen-owned predicate; `directTopLevelDeclaration` accepts a script
  `var` when it answers `true`. The scalar-kind rule (number / boolean) and the
  unique-declaration rule are unchanged.
- `src/codegen/index.ts::scriptVarSlotIsSoleHome` — `false` when the source is
  a runtime-eval consumer (legacy widens every script var to `externref`), when
  the name is in `sloppyImplicitGlobals` (bare reads resolve through the
  global-environment object), or when the allocator has no non-externref slot.
- Both resolver construction sites (`planIrOverlay`, `compileIrPathFunctions`)
  pass the same predicate, so the selector's claim and from-ast's write path
  agree.

## Acceptance

- `tests/issue-7105-script-var-slot.test.ts`: script-goal read + write through
  IR observed by legacy top-level code; the eval-consumer and `this.p = v`
  exclusions stay on the direct path; the module-goal case is unchanged.
- No post-claim bucket growth (`check:ir-fallbacks`).
