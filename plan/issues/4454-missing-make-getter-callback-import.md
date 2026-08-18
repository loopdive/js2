---
id: 4454
title: "compileFiles fails with 'Missing __make_getter_callback import' on src/shape-inference.ts — late import registration gap"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
goal: correctness
# The new bridge-registration arm belongs next to its three sibling arms
# (#1239 accessors, #1433 dispose, #3048 computed keys) in the collector's
# object-literal branch; splitting one of four siblings into its own module
# would cost more clarity than the 32 lines are worth.
loc-budget-allow:
  - src/codegen/declarations/import-collector.ts
# The predicate itself is extracted to a module-level helper, so the visitor
# grows by only the 3-line dispatch that every sibling arm also costs.
func-budget-allow:
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
---

# #4454 — `Missing __make_getter_callback import`

Found by the #4420 self-hosting baseline sweep:
`compileFiles("src/shape-inference.ts")` fails (5 errors) including
`Missing __make_getter_callback import` — a compiler-internal error, not a
user-source diagnostic. The compiler decided it needed the getter-callback
host machinery but the import was never registered for this compilation
shape.

## Implementation Plan (Fable, 2026-08-15)

1. **Locate the error**: grep `Missing __make_getter_callback` in `src/` —
   find the emit site that throws/pushes it. `__make_getter_callback` is
   referenced from `src/codegen/expressions/eval-inline.ts`,
   `src/codegen/object-runtime.ts`, `src/codegen/literals.ts`,
   `src/codegen/object-ops.ts` — one of these requests the import index and
   fails because registration didn't happen.
2. **Reproduce + minimize**: `compileFiles("src/shape-inference.ts")` (fast,
   ~3.6 s graph) reproduces. Minimize to the construct that triggers the
   getter-callback path (likely an object literal with a getter, or a class
   accessor, reached via a multi-file/module-graph path where import
   registration runs in a different order than the single-file path).
3. **Root-cause against the known pattern**: CLAUDE.md documents the
   `addUnionImports` hazard — late import addition shifts function indices
   and must also shift `ctx.currentFunc.body`. Check whether
   `__make_getter_callback` uses the same late-registration mechanism and
   whether the multi-module path (`compileMultiSource` /
   `generateMultiModule`) registers it per-module vs per-program. The bug
   class is likely "import registered in single-file mode but not in the
   files/multi-module pipeline" or "registered after the point where the
   import table was frozen".
4. **Fix at the registration site** so the import exists whenever the
   emitting path can be reached; do not paper over by emitting a different
   call. Standalone-mode rule applies (CLAUDE.md dual-mode): if this import
   is host-only, confirm what standalone mode does on the same construct and
   keep that behavior consistent — if standalone has its own lowering, the
   fix must not accidentally route standalone through the host import.
5. **Tests** (`tests/issue-4454*.test.ts`): (a) minimized construct compiles
   with `validate: true`-style honesty if available on this branch (this
   branch is based on origin/main which may not yet have #4420's option —
   use `WebAssembly.validate` directly on the binary in that case) and runs
   correctly in JS-host mode; (b)
   `compileFiles("src/shape-inference.ts")` no longer reports the missing-
   import error (assert on error text; other failures in that file may
   remain — do not assert overall success unless it actually holds).
6. **Collateral**: run the object/getter-adjacent suites (grep tests/ for
   getter/accessor issue tests) — import-table changes are the classic
   index-shift regression source.

## Acceptance criteria

- [x] Emit site + registration gap documented in Results (which pipeline
      path skips registration and why).
- [x] Minimized getter construct compiles to an engine-valid module and runs.
- [x] `src/shape-inference.ts` no longer reports the missing-import error.
- [x] Object/getter suites green; typecheck + gates green.

## Results (2026-08-15)

### It is NOT a pipeline / late-import-ordering bug

The plan's hypothesis (single-file vs `compileFiles` multi-module registration
order) does not hold. The construct is shape-triggered, not pipeline-triggered:
the same literal fails in a plain single-file `compile()`. `compileFiles` was
only how it surfaced — the offending literal lives in `src/ts-api.ts`, which
`src/shape-inference.ts` pulls in transitively, so a single-file compile of the
entry file never reached it. No late-import / index-shift mechanism is involved
in the fix; the import is registered in the ordinary up-front pre-pass.

### Emit site

`src/codegen/closures.ts:3824` — `compileArrowAsCallback` resolves the maker
name via `resolveCallbackMakerName` (`__make_getter_callback` when
`needsThis`), looks it up in `ctx.funcMap`, and on a miss does
`reportError(ctx, arrow, \`Missing ${makeCallbackName} import\`)`.
(Standalone/WASI never reaches the error — it degrades to
`compileArrowAsClosure` one branch earlier, #3235.)

Reached from `emitObjectLiteralMethodFn` (`src/codegen/literals.ts:1168`), the
MethodDeclaration arms of the host plain-object literal paths
(`compileObjectLiteralAsExternref` ~L532, `compileObjectLiteralWithAccessors`
~L1049).

### Registration gap

`unifiedVisitNode` in `src/codegen/declarations/import-collector.ts` sets
`state.getterCallbackFound` (which materializes the `env::__make_getter_callback`
import in the finalizer, ~L1917) for an object literal only when it carries:

- a `get`/`set` accessor (#1239), or
- a computed method key — `Symbol.dispose`/`asyncDispose` (#1433) or any
  non-plain-literal computed key (#3048).

A **plain-named method shorthand** (`m() {}`, `"m"() {}`, `0() {}`) was not
covered, because in the ordinary case such a literal lowers to a struct with a
compile-time method table and never touches the bridge. But a literal that also
contains a **spread** and has no concrete contextual type is diverted to the
host plain-object path by `objectLiteralSpreadTakesHostPath` (#2804), and that
path installs each method as a real runtime own property through
`emitObjectLiteralMethodFn` → the bridge. Pre-pass and emitter therefore
disagreed, and the emit site found an empty `funcMap`.

`src/ts-api.ts` hits it three times:

```ts
const synthesized: Record<string, unknown> = {
  ...astMod,
  ...isMod,
  factory: factoryMod,
  __js2wasmTs7: true,
  createProgram() { … },
  createSourceFile() { … },
  createCompilerHost() { … },
};
```

`Record<string, unknown>` has zero properties, so
`objectLiteralSpreadTakesHostPath` answers true → host path → three CEs.

Minimized (single-file `compile()`, JS-host mode):

| literal                                                          | before |
| ---------------------------------------------------------------- | ------ |
| `const o: any = { m() {} }`                                       | ok     |
| `const o = { ...s, m() {} }` (no annotation)                      | **CE** |
| `const o: any = { ...s, m() {} }`                                 | **CE** |
| `const o: Record<string, unknown> = { ...s, m() {} }`             | **CE** |
| `const o: any = { ...s, "m"() {} }`                               | **CE** |
| `const o: { a: number; m(): number } = { ...s, m() {} }` (concrete) | ok   |
| `const o: any = { ...s, m: function () {} }` (property, not shorthand) | ok |

### Fix

`src/codegen/declarations/import-collector.ts` — a new module-level predicate
`objectLiteralMethodNeedsGetterBridge(ctx, node)` (true when the literal has a
spread **and** a plain-named method **and** `objectLiteralSpreadTakesHostPath`
answers true), dispatched from one extra 3-line arm in the object-literal branch
of `unifiedVisitNode`. Gating on the emitter's own predicate (rather than on
"has a spread") keeps pre-pass and emit site in lockstep, so the
concretely-annotated struct-path case does not pull in an unused import. The
predicate lives outside the visitor so the already-oversized `unifiedVisitNode`
grows only by the dispatch (#3400 func budget); both budget gates are granted
for this change-set in the frontmatter above.

Dual-mode: gated `!(ctx.standalone || targetProfile.semanticProviders ===
"native-first")`, mirroring `emitObjectLiteralMethodFn`'s own branch —
standalone lowers the method to a host-free closure (#2194) and must not
declare the unsatisfiable `env::` import. Verified: the standalone build of the
failing literal imports no `__make_getter_callback`.

### Validation

- `compileFiles("src/shape-inference.ts")`: was `success: false, 5 errors`
  incl. 3 × `Missing __make_getter_callback import` (at `src/ts-api.ts:194`,
  `:200`, `:206`), 0 binary bytes → now `success: true, 0 missing-import
  errors, 25,939 binary bytes`. The two remaining diagnostics are unrelated
  and pre-existing (a TS1259 `allowSyntheticDefaultImports` diagnostic and an
  IR-path warning).
- `tests/issue-4454-spread-method-getter-callback.test.ts` — 6 tests, all
  pass: JS-host run (`{ ...src, m() { return this.a + 2 } }` → 42), the
  three-method `src/ts-api.ts` shape, four spread+method variants asserted
  `WebAssembly.validate`-valid, standalone host-free, concrete-annotation
  control, and a `compileMulti` two-file graph reproducing the cross-module
  original. The real-file `compileFiles` run is NOT in the suite: compiling
  the compiler's own module graph exceeds vitest's 512 MB per-fork heap
  (`VITEST_FORK_MAX_OLD_SPACE_SIZE`) and OOM-killed the worker.
- Collateral, A/B'd against the unpatched file (file-copy revert, same
  command both runs): 18 object/getter/accessor/spread/callback suites —
  identical failure sets before and after — 20 pre-existing failures in the
  spread/object batch (`spread-rest` 13, `getters-setters` 6,
  `issue-2151-mixed-spread` 1) and 8 in the defineProperty/accessor batch
  (`issue-2992-accessor-merge` 5, `issue-2992-accessor-widening` 1,
  `issue-2580-m3-bacc-defineproperty-accessor` 1, `issue-3214-void-host-callback`
  1), byte-identical lists in both directions; 15 `tests/equivalence/*`
  object/spread suites all green.
- `pnpm run typecheck` 0 · `pnpm run lint` 0 · prettier clean ·
  `check:oracle-ratchet` OK (checker usage +0) · `check:ir-fallbacks` OK.
