# Playground AST explorer

The playground's **AST** tab parses your source with **acorn compiled to Wasm by
this compiler** and renders the tree. It is not a JS copy of acorn: the parsing
runs in a WasmGC module in your browser tab, so the panel doubles as a live
demonstration that the compiler handles a real 230 KB parser graph.

## What ships

| File | What it is |
|------|------------|
| `website/public/acorn/acorn.wasm` | acorn 8.16.0 compiled by js2wasm (~369 KB, `-O3`) |
| `website/public/acorn/acorn.manifest.json` | the adapter manifest — the import plan **and** the export metadata `wrapExports` needs |
| `website/public/acorn/meta.json` | provenance: acorn version, byte sizes, compile time, build date |

All three are **committed**. Compiling acorn takes ~30 s and a multi-GB heap —
too much for every `vite build`, and far too much for the browser.

## Refreshing the artifact

```bash
pnpm run build:acorn-wasm     # recompile and write the three files
pnpm run check:acorn-wasm     # recompile and report staleness, writing nothing
```

Nothing regenerates it automatically, so it drifts from the compiler over time.
That drift is not a breakage — an older artifact keeps parsing correctly — but a
compiler fix that would change acorn's output is invisible in the panel until
someone reruns the build. `tests/playground-acorn-artifact.test.ts` guards the
part that *is* fatal: it loads the committed files exactly as the browser does
and diffs a parse against node-acorn from the same pinned tarball.

## How the panel loads it

Three steps, mirroring what the CLI's generated `<name>.imports.js` helper does:

1. `buildCompiledAdapterImports(manifest)` — the module is a JS-host build, so it
   needs an import object.
2. `instantiateWasm(...)`, then `imports.setInstance(instance)`.
3. `wrapExports(instance, …)` — **not optional**. A raw `exports.parse` returns
   an opaque WasmGC handle and every AST node inspects as `{}`.

The helper file itself is not shipped: its `from "js2wasm"` specifier cannot
resolve from a statically-served file, and the playground already has the
runtime loaded.

## Editor source vs. compiled JS

acorn parses JavaScript; the editor holds TypeScript. The panel tries the editor
text first and falls back to the compiled JS output when annotations trip the
parser. The header says which one is on screen — that distinction matters,
because only the editor case can map a node's range back to what you typed
(hover highlights it, click selects it).

While you type, the tree refreshes live **only** when it is already showing
editor text. On a TypeScript source it waits for the next compile: the compiled
output is cleared on every edit, so re-parsing there would replace a correct
tree with a parse error on each keystroke.

## Known cosmetic differences

Values crossing the Wasm boundary can differ from node-acorn in two harmless
ways — the same ones `tests/dogfood/acorn-corpus.mjs` classifies as QUIRK rather
than a real divergence:

- a compiled-only `sourceFile` field, and
- booleans marshalled as the numbers `0`/`1`.

Neither corrupts tree structure. Anything else is a compiler bug.
