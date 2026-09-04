# acorn → Wasm, diffed against node-acorn

Two ways to do the same thing. Pick by what you are iterating on.

## One process (`acorn-diff.mjs`)

```bash
node --max-old-space-size=4096 --import tsx \
  examples/acorn-diff/acorn-diff.mjs --wasm .tmp/acorn.wasm src/foo.js src/bar.mjs
```

Compiles the pinned acorn, instantiates it, and diffs its AST against
node-acorn for each input file. Exits 1 on any real divergence. Use this while
working on the compiler: one command, and the `.wasm` is optional.

The acorn source is the sha1-checked tarball under `tests/dogfood/` — the same
extracted module is both the compiled input **and** the oracle, so there is no
version skew and any divergence is a compiler bug.

## Two steps (CLI, then a plain Node loader)

```bash
# 1. compile once
js2wasm node_modules/acorn/dist/acorn.mjs --skip-semantic-diagnostics -o dist/

# 2. load it — no compiler in the loop
node --max-old-space-size=4096 dist/run.mjs
```

```js
// dist/run.mjs
import { readFileSync } from "node:fs";
import { instantiateBytes } from "./acorn.imports.js";
import * as nodeAcorn from "acorn";

const { exports } = await instantiateBytes(readFileSync("./acorn.wasm"));
const opts = { ecmaVersion: 2022, sourceType: "module" };
const src = readFileSync(process.argv[2], "utf-8");

console.log(exports.parse(src, opts));       // compiled acorn
console.log(nodeAcorn.parse(src, opts));     // oracle
```

Use this when you are iterating on the *inputs*, not the compiler: the 230 KB
parser graph is compiled once instead of on every run.

Two flags carry this route:

- **`--skip-semantic-diagnostics`** — acorn is plain pre-strict-mode JS. Without
  it the compile aborts on 5 `Type 'null' is not assignable to type 'undefined'`
  errors that never reach codegen.
- **`instantiateBytes`** (from the generated `acorn.imports.js`) returns
  `exports` already marshalled into plain JS. The raw `instance.exports.parse`
  returns an opaque WasmGC struct that inspects as `undefined` — every AST node
  would look empty.

Outside this repo the helper's `import … from "js2wasm"` resolves to the
published package. Running it against a source checkout means pointing that
specifier at `src/index.ts` instead.

## Reading the output

`acorn-diff.mjs` splits divergences the way `tests/dogfood/acorn-corpus.mjs`
does:

- **QUIRK** — cosmetic host-marshalling artifacts that do not corrupt the tree:
  the compiled-only `sourceFile` field, and booleans that crossed the boundary
  as i32 `0`/`1` (`computed`, `static`, `optional`, …). Hidden unless you pass
  `--show-quirks`.
- **REAL** — everything else: dropped nodes, missing fields, wrong node kinds.
  These are the compiler bugs.

## The committed harnesses

Neither takes a file path; both answer a fixed question and write a report.

| Command | Answers |
|---------|---------|
| `pnpm run dogfood:acorn` | compile + validate + diff over the 7 fixtures in `tests/dogfood/fixtures/inputs/` |
| `node --import tsx tests/dogfood/acorn-corpus.mjs` | the broad per-feature corpus, with a grouped map of distinct real gaps |
| `tests/dogfood/acorn-standalone-compile.mjs` | the standalone (import-free) lane, via in-module canaries — a JS host cannot construct the native-string carrier `parse` needs, so it cannot be fed real input from outside |
