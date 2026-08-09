---
id: 3748
title: "clsx dogfood harness — third single-bundle npm package, surfaces a real heterogeneous-object-array for...in bug (#3749)"
status: done
sprint: 77
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
priority: medium
horizon: m
feasibility: easy
reasoning_effort: medium
task_type: test
area: testing
language_feature: n/a
goal: core-semantics
origin: "continuing the tests/dogfood/ npm-package testing effort (acorn #1710, marked #3716, acorn-official-suite #3729) after the dayjs UMD investigation (#3747) — clsx is a genuinely single-file real ESM bundle, matching acorn/marked's shape directly"
related: [1710, 3716, 3729, 3747, 3749]
---

# #3748 — clsx dogfood harness

## Why clsx

After #3747's dayjs investigation established that UMD/CJS-bundled
packages (`module.exports = ...`) hit a real compiler limitation, the
search moved to packages shaped like acorn/marked: a genuine single-file
**ESM** bundle with real named exports. `clsx@2.1.1`'s
`dist/clsx.mjs` fits exactly (330 bytes minified, zero imports,
`export function clsx(){...}`) — a variadic className-joining utility,
a different code shape from both acorn (parser/AST) and marked
(string-transform): `arguments`-object reads, `typeof`-based dynamic
dispatch, recursive array/object traversal, `for...in` property
enumeration.

## A real ABI constraint found first (not a bug)

clsx's exported `clsx()` declares **zero parameters** and reads the
`arguments` object internally — calling it directly across the wasm
export boundary always observes zero arguments. Verified independent of
clsx with a minimal `arguments.length` repro: a wasm export's function
signature is fixed-arity from its declared TS/JS parameter list, so
extra host-JS call-site arguments are never marshaled in — this is
inherent to how WebAssembly exports work, not a compiler defect.

**Adaptation**: rather than calling the raw `clsx`/`default` export, the
harness appends a small internal driver epilogue to the UNMODIFIED
pinned source — each op is a fixed-arity wrapper function making an
ordinary INTERNAL call into `clsx` with hardcoded literal arguments
(`tests/dogfood/clsx-ops.mjs`). The exact same op-code string drives
both the compiled wrapper export AND the native oracle (via
`new Function("clsx", code)` bound to the same pinned tarball's CJS
build), so oracle and compiled side can never drift from each other by
a harness-authoring slip.

## What changed

- `tests/dogfood/clsx-pin.json` — pins `clsx@2.1.1` by canonical npm
  sha1/sha512, same acquisition discipline as acorn/marked.
- `tests/dogfood/setup-clsx.mjs` — acquisition (pinned tarball, no
  run-time network), mirrors `setup-marked.mjs`.
- `tests/dogfood/clsx-ops.mjs` — 18 shared ops (two-strings, falsy
  filtering, numbers, objects, nested/deeply-nested arrays, duplicates,
  whitespace, array-of-objects, etc.), each a `return <expr>;` code
  string used verbatim on both sides of the diff.
- `tests/dogfood/clsx-harness.mjs` — the harness: acquire → compile
  (pinned source + driver epilogue) → validate → run+diff every op →
  report. Robust to a red surface (same acceptance bar as
  acorn/marked): a non-validating binary or a thrown op is RECORDED,
  never crashes the harness.
- `tests/dogfood/clsx.test.ts` — vitest wrapper, opt-in
  (`DOGFOOD_CLSX=1`).
- `pnpm run dogfood:clsx` script; `.gitignore`/`biome.json` entries for
  the gitignored `.clsx/` extraction dir.

## Result: 17 / 18 ops match

One real bug found and filed separately (properly scoped, not fixed
here — this issue is the harness): **#3749** — `for...in` over an array
element throws `dereferencing a null pointer` when the array holds
object literals of DIFFERENT shapes (`op_array_of_objects`:
`clsx([{a:true,b:false},{c:true}])`). Reduced to a minimal repro fully
independent of clsx, isolating the exact trigger (heterogeneous object
shapes as array siblings) from several working near-neighbors
(single object, homogeneous-shape siblings) — see the issue file for
the full isolation table.

## Acceptance criteria

- [x] `pnpm run dogfood:clsx` acquires the pin, compiles clsx + driver
      epilogue, runs the real compiled functions against native clsx
      (same pinned tarball, zero version skew), and emits a structured
      report (`tests/dogfood/report/clsx-surface.json`, gitignored).
- [x] Vitest wrapper passes; harness is robust to a red op (records,
      does not crash).
- [x] The `arguments`-boundary constraint is documented (not worked
      around with anything that would misrepresent it as a compiler
      bug) in `clsx-pin.json` and the harness file header.
- [x] The one real divergence found is triaged and filed as its own
      issue (#3749), not fixed inline.
