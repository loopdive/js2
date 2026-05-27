---
id: 1680
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
# #1680 — acorn.mjs compiles but emits invalid Wasm: `f64.lt` reads a global array ref in `isInAstralSet`

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
