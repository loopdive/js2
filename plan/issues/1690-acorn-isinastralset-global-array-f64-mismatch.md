---
id: 1690
title: "Stress test: compile acorn.mjs — invalid Wasm in isInAstralSet (f64 op reads global array ref)"
status: ready
created: 2026-05-27
updated: 2026-05-27
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, import-bookkeeping
language_feature: arrays, globals, closures, number-arithmetic
goal: real-world-compat
sprint: Backlog
related: [1679, 1677, 1666, 1618, 1314]
note: "Surfaced behind #1679. With #1679's `new this(...)` blocker gone on current main (e622751f7), acorn.mjs now compiles to success=true with 0 errors but emits INVALID Wasm — the next blocker. Distinct from #1679 (which is codegen-acceptance only)."
---
# #1690 — acorn.mjs compiles but emits invalid Wasm: `f64.lt` reads a global array ref in `isInAstralSet`

## Problem

Stress-testing against [acorn](https://github.com/acornjs/acorn) 8.16.0
(`dist/acorn.mjs`, 6,266 lines, pure ESM, MIT, no deps) on current main
(`e622751f7`):

- `compile(acornSrc, { fileName: "acorn.mjs" })` → **`success = true`, 0 errors**,
  700,820-byte binary, ~31 s compile time.
  (The `new this(...)` errors that #1679 documented are **gone** on this HEAD —
  acorn now passes codegen acceptance. This issue is the *next* blocker.)
- `WebAssembly.compile(binary)` (validation only) → **INVALID**:

```
WebAssembly.instantiate(): Compiling function #56:"isInAstralSet" failed:
f64.lt[0] expected type f64, found global.get of type (ref null 56) @+180284
```

The validator stops at the first bad function, so there may be more behind it.

## The offending source

`acorn.mjs:48-57` — a hot identifier-classification helper:

```js
function isInAstralSet(code, set) {
  var pos = 0x10000;                       // f64 accumulator
  for (var i = 0; i < set.length; i += 2) {
    pos += set[i];                         // numeric += untyped-array element
    if (pos > code) { return false }       // <-- f64.lt here
    pos += set[i + 1];
    if (pos >= code) { return true }
  }
  return false
}
```

Called as `isInAstralSet(code, astralIdentifierStartCodes)` /
`isInAstralSet(code, astralIdentifierCodes)` (`acorn.mjs:68,82`), where the
`set` argument is a **module-level numeric array global**
(`var astralIdentifierStartCodes = [0, 11, 2, …]`, ~700 elements).

The error says an `f64.lt` operand is a `global.get` of type `(ref null 56)` —
i.e. the codegen pushed the **array-struct global reference** onto the stack
where an `f64` (the `pos`/`code` comparison) belongs. The `56` in `(ref null 56)`
matching the failing function index `#56` is coincidental (both are just the
56th type / function), but the symptom is a numeric op consuming a ref operand.

## Why it's an interaction bug (not localizable to isInAstralSet)

The same function in isolation compiles to **valid** Wasm. Confirmed:

| reduced input | result |
|---|---|
| `isInAstralSet` alone (single export) | VALID |
| `pos += set[0]; pos > x` minimal accumulator | VALID |
| acorn lines 1-83 (both big global arrays + RegExp + `isInAstralSet` + `isIdentifierChar`, export `probe`) | VALID — 15,408 bytes |
| full `acorn.mjs` (6,266 lines) | **INVALID** (above) |

So the bug only appears at full-module scale. The signature —
a numeric op fed a stale `global.get` ref — is the classic fingerprint of a
**function/global index-shift miscount** (the `addUnionImports` /
`shiftLateImportIndices` family, cf. #1618, #1677, #1314): once enough
functions/globals/late-imports accumulate, an index the codegen baked into
`isInAstralSet` no longer points at the f64 value it expected but at an
array-struct global, and the validator rejects the resulting `f64.lt`.

## Reproduction

```bash
cd /workspace/.tmp/acorn
npm pack acorn && tar xzf acorn-*.tgz          # → package/dist/acorn.mjs
npx tsx probe.mjs                               # see scratch harness below
# → compile() success=true, binary 700820 bytes
# → WebAssembly.compile(binary) throws:
#   "function #56:\"isInAstralSet\" failed: f64.lt[0] expected type f64,
#    found global.get of type (ref null 56)"
```

Scratch harness used during investigation (`.tmp/acorn/probe.mjs`,
`repro.mjs`, `repro2.mjs`, `repro3.mjs`) — `compile(src,{fileName:"acorn.mjs"})`
then `WebAssembly.compile(r.binary)` for validation-only (no import object
needed). `fileName` MUST end in `.mjs`/`.js` so `allowJs` auto-enables;
with a `.ts` name the untyped JS floods 259 TS type errors and bails before
codegen (also a finding — see Notes).

## Investigation steps for the fixer

1. Bisect acorn between the valid 83-line slice and the full file to find the
   construct/size that flips validity (binary-search by truncating the source,
   keeping the identifier block + a growing tail, re-validating each cut).
2. Dump the WAT for `isInAstralSet` (`r.wat`) from the full-module compile and
   diff the `global.get` index against the global section — confirm whether a
   late-import/global shift left the index pointing at an array global.
3. Cross-check against #1618 / #1677 shift-regime fixes — likely the same
   bookkeeping path needs to also shift this site.

## Acceptance criteria

1. `WebAssembly.compile()` on the `acorn.mjs` binary succeeds (no `f64.lt`
   type-mismatch in `isInAstralSet` or any other function).
2. A focused test reproduces the index-shift class minimally (numeric
   accumulator over a module-global array, in a module large enough to trigger
   the shift) and validates.
3. No regression in test262 (esp. the existing index-shift / closure buckets:
   #1618, #1314, #1601).

## Notes / scope

- Out of scope here: runtime equivalence vs. real acorn output, and the
  pre-codegen TS-noise gate (259 strict-mode `implicit any` / `does not exist
  on type {}` diagnostics when acorn is fed with a `.ts` filename — those are
  suppressed correctly under `allowJs` for `.mjs`/`.js`, so they only bite if a
  caller mislabels the file; worth a docs note but not a codegen bug).
- Builds on #1679: that issue's `new this(...)` blocker is resolved on
  `e622751f7`, exposing this validation failure as the next gate to a clean
  acorn compile.

## Investigation 2026-05-28 (sendev-1542)

**Repro confirmed on current main** (after PR #845 merge): `WebAssembly.compile(acorn.mjs binary)` fails with `function #58:"isInAstralSet" failed: f64.lt[0] expected type f64, found global.get of type (ref null 57) @+185628`. The function index and global index moved (`#58` vs the issue's `#56`, `2472` vs `56`) but the symptom shape is identical.

### WAT-level findings (`.tmp/acorn/acorn.wat`)

`isInAstralSet` body (L2840-2939):

```wat
(func $isInAstralSet (param f64 (ref null 3)) (result i32)
  (local $pos f64)
  (local $__tmp_1 (ref null 3))
  ...
  f64.const 65536
  local.set 2                  ;; pos = 0x10000  (local.set $pos — correct)
  f64.const 0
  global.set 2474              ;; i = 0  — but `i` is a function-local `var i`, NOT a module-level decl
  (block
    (loop
      global.get 2472          ;; STALE INDEX — should be 2474; this is `$__mod_unicodeScriptValues`, type (ref null 57)
      local.get 1
      struct.get 3 0           ;; set.length
      f64.convert_i32_s
      f64.lt                   ;; FAILS: operand is (ref null 57), not f64
      ...
      global.get 2474          ;; i += 2 path reads 2474 correctly
      f64.const 2
      f64.add
      global.set 2474          ;; — correctly writes 2474
      ...
```

Global indices nearby:
- `#2472`  `(global $__mod_unicodeScriptValues (mut (ref null 57)) (ref.null 57))` ← the validator's "ref null 57"
- `#2474`  `(global $__mod_i (mut f64) (f64.const 0))` ← where `i` actually lives

### Two compounding defects

**1. `var i` inside `isInAstralSet` is wrongly hoisted to a module global** (`$__mod_i`). `walkModuleStmtForVars` in `src/codegen/declarations.ts:2873` deliberately does NOT recurse into FunctionDeclarations / methods / arrows — yet `var i` from a nested function ended up at `$__mod_i`. Likely cause: the `var i` at module scope in acorn.mjs:1063 *does* get hoisted (correctly), and the **inner** `var i` then erroneously **resolves to the same module global** (rather than allocating a fresh function-local). Need to find where the name-resolution for `var i` declarations inside functions consults `moduleGlobals` and short-circuits.

**2. The for-loop CONDITION read of `i` doesn't get shifted along with the writes.** The init (`i = 0` → `global.set 2474`) and the increment (`i += 2` → `global.get/set 2474`) are at the correct index 2474; only the condition read at L2851 is at 2472 — an off-by-2. Since `fixupModuleGlobalIndices` walks `loop.body` and `block.body` (the recursion at `src/codegen/registry/imports.ts:150-167` covers `body/then/else/catches/catchAll`), and the writes DID get shifted, the only way the condition read is stale is if it's stored in a **separate Instr[] array** that fixup doesn't reach. Candidates: a `pendingHoistedConditionInstrs`-style buffer, or the savedBody-swap pattern (#1384) missed a body during the for-loop's condition compilation.

### Why both defects compound to the validator failure

Without defect #1 the inner `var i` would be a local and never trigger global-index shifts → no shift bug to expose. Without defect #2 the global-index shift would correctly update the condition read → no validation failure. The combo: `var i` aliases to module-global → for-loop condition reads that global → defect #2 leaves the condition read at stale index 2472 → `global.get 2472` returns `(ref null 57)` → `f64.lt` rejects → invalid Wasm.

### Suggested next steps

1. **Localize defect #1 first** (smaller surface). Audit identifier resolution in `compileIdentifier` /
   `compileVariableStatement` for the path that promotes an inner-function `var <name>` to
   `moduleGlobals.get(name)` instead of allocating a function-local. Likely in
   `src/codegen/expressions/identifiers.ts` or `src/codegen/statements.ts`. Add a guard: a `var <name>`
   binding-declaration inside a FunctionDeclaration/FunctionExpression/ArrowFunction/MethodDeclaration
   must allocate a fresh local even if the outer module also has `__mod_<name>`.
2. **Then validate defect #2 independently.** Build a focused repro that:
   - declares a module-level `var x` (triggers `__mod_x` global allocation)
   - in a separate function uses `for (var i = 0; i < arr.length; i++) ...` — i.e. the same shape, but without name collision — see whether the loop-condition shift also lags.
   If yes, the shift walker is missing an Instr[] array (savedBodies during for-condition compilation is the prime suspect).
3. **Bisect the file size** — the issue file suggests this, but with defect #1 in mind: the size threshold likely correlates with how many module-level `var` declarations have been registered before `isInAstralSet` compiles (each adds a `__mod_*` global; once enough are added that the global-table needs shifting via `addStringConstantGlobal`, defect #2 fires).

### Out of scope here

Compiler also reports 471 diagnostics (TS strict-mode noise from acorn's untyped JS). These are non-fatal under `allowJs: true` and unrelated to the validator failure. Probe at `.tmp/acorn/probe.mts`.
