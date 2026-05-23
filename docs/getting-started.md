# Getting Started

`js2` (`@loopdive/js2`) is an ahead-of-time compiler that turns TypeScript and
JavaScript into WebAssembly. There is no bundled interpreter and no engine
embedded in the output module — the compiler emits WasmGC directly. This guide
walks through installing the CLI, compiling a first module, and running the
result from Node.js and the browser.

If you have not yet read the FAQ, [`docs/faq.md`](faq.md) explains why `js2`
takes the direct-AOT approach rather than bundling a runtime.

## 1. Install

The compiler ships as a single npm package. Install it globally, or run it on
demand with `npx`:

```bash
# Global install — adds the `js2wasm` binary to PATH
npm install -g @loopdive/js2

# One-shot — no global install
npx @loopdive/js2 input.ts -o out/
```

Verify the install:

```bash
js2wasm --version
js2wasm --help
```

`js2wasm` is the CLI entry point; the npm package name is `@loopdive/js2`.

## 2. Compile your first module

Write a tiny TypeScript file:

```bash
cat > add.ts <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}
EOF
```

Compile it:

```bash
js2wasm add.ts -o .
```

You should now see four files alongside `add.ts`:

| File | Purpose |
|------|---------|
| `add.wasm` | The compiled WebAssembly binary |
| `add.wat` | WebAssembly text format (human-readable) |
| `add.d.ts` | TypeScript declarations for the module's exports |
| `add.imports.js` | A `createImports()` helper that builds the import object |

The `.imports.js` helper centralises the JavaScript host glue (string builtins,
boxed-number constructors, host calls). You import it from your loader rather
than constructing the import object by hand.

## 3. Run in Node.js

Create a small loader, `run.mjs`:

```js
import { readFile } from "node:fs/promises";
import { createImports } from "./add.imports.js";

const bytes = await readFile("./add.wasm");
const { instance } = await WebAssembly.instantiate(bytes, createImports());

console.log(instance.exports.add(2, 3)); // 5
```

Run it:

```bash
node run.mjs
```

Node 22 or newer is recommended (older versions may need
`--experimental-wasm-gc`).

## 4. Run in the browser

The same module loads fetched over HTTP:

```html
<script type="module">
  import { createImports } from "./add.imports.js";

  const response = await fetch("./add.wasm");
  const { instance } = await WebAssembly.instantiateStreaming(
    response,
    createImports(),
  );

  console.log(instance.exports.add(2, 3)); // 5
</script>
```

Any reasonably current Chromium, Firefox, or Safari handles WasmGC natively;
there is no polyfill step.

## 5. Common CLI flags

The flags you reach for most often:

| Flag | What it does |
|------|--------------|
| `-o, --out <dir>` | Output directory (default: same dir as the input file). |
| `-O, --optimize` | Run Binaryen `wasm-opt` (default `-O3`). Smaller, faster. |
| `-O1` .. `-O4` | Pick the optimizer level explicitly. |
| `--target wasi` | Emit WASI imports (`fd_write`, `proc_exit`) instead of JS host glue. |
| `--target linear` | Emit linear-memory output instead of WasmGC. |
| `--allow-fs` | Permit `node:fs` host imports for non-WASI builds (off by default). |
| `--wit` | Also emit a WIT interface file for the Component Model. |
| `--wat` | Print only the `.wat` text to stdout (skip binary output). |
| `--mode production` | Set `process.env.NODE_ENV="production"` at compile time, drops dead branches. |
| `--define K=V` | Substitute an identifier path with a literal before parsing. |

A worked example:

```bash
js2wasm add.ts -o dist/ -O3 --wit
```

This writes optimized `dist/add.wasm`, `dist/add.wat`, `dist/add.d.ts`,
`dist/add.imports.js`, and `dist/add.wit`.

For the complete reference, see [`docs/cli.md`](cli.md).

## 6. Where to next

- The **playground** under `playground/examples/js/` has runnable examples for
  async/await, classes, and algorithms — open them in the in-browser playground
  to see the WasmGC output live.
- The **FAQ** in [`docs/faq.md`](faq.md) covers the project's stance on
  TypeScript types, runtime fallbacks, and Test262 conformance.
- The **methodology** doc, [`docs/methodology.md`](methodology.md), explains
  how the compiler decides between static specialization and dynamic fallback.
