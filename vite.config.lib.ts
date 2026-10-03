import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

// Library build config for npm publishing as @loopdive/js2.
// Unlike vite.config.ts (which targets browsers for the playground),
// this targets modern Node so top-level await, dynamic imports, and
// bare `node:*` / `fs` / `path` imports are preserved as externals.
const nodeBuiltins = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
const PROCESS_ENV_BINDING = "__js2wasmProcessEnv";

export default defineConfig(({ mode }) => {
  const jsrBuild = mode === "jsr";

  return {
    plugins: [
      dts({
        entryRoot: "src",
        include: ["src/**/*.ts"],
        exclude: ["src/**/*.test.ts"],
        rollupTypes: false,
        // Don't ship .d.ts.map: the published tarball has no src/, so their
        // "../src/*.ts" sources are dead references that just double the file
        // count. tsconfig keeps declarationMap on for in-repo editor
        // go-to-definition; this overrides it for the published lib build only.
        compilerOptions: { declarationMap: false },
      }),
    ],
    publicDir: false,
    // #6782 — the library must load and compile without a global `process`
    // (browser bundles, `delete globalThis.process`). `src/` reads its switches
    // through `readEnv()`, but a few files cannot be edited without breaking
    // the #3518 source receipts that pin their exact text, so the build also
    // routes every remaining `process.env` through one binding that is `{}`
    // when the host has no `process`. In Node it is the live `process.env`
    // object, so reads and writes behave exactly as before.
    define: { "process.env": PROCESS_ENV_BINDING },
    // JSR's 20 MiB package cap requires a minified dist build. Preserve
    // observable Function/Class names while shrinking the generated runtime.
    esbuild: jsrBuild ? { keepNames: true, legalComments: "none" } : undefined,
    build: {
      target: "node20",
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: false,
      minify: jsrBuild ? "esbuild" : false,
      lib: {
        entry: {
          index: "src/index.ts",
          cli: "src/cli.ts",
          runtime: "src/runtime.ts",
          "runtime-isolated-evaluator": "src/runtime-isolated-evaluator.ts",
          "runtime-node-eval-worker": "src/runtime-node-eval-worker.ts",
          optimize: "src/optimize.ts",
        },
        formats: ["es"],
        fileName: (_format, entry) => `${entry}.js`,
      },
      rollupOptions: {
        external: [
          "typescript",
          "binaryen",
          // #1288: TS7 is opt-in via JS2WASM_TS7=1; mark all its subpaths as
          // external so the lib build doesn't try to bundle them when
          // ts-api.ts conditionally requires them. The package is installed
          // under the `typescript7` alias (`typescript7@npm:typescript@^7`) so
          // it can coexist with the typescript@5 runtime dependency; the old
          // `@typescript/native-preview` pattern is kept so a consumer pinning
          // the frozen preview package still resolves it as external.
          /^typescript7(\/.*)?$/,
          /^@typescript\/native-preview(\/.*)?$/,
          ...nodeBuiltins,
        ],
        output: {
          intro: `const ${PROCESS_ENV_BINDING} = globalThis.process?.env ?? {};`,
          preserveModules: false,
          inlineDynamicImports: false,
        },
      },
    },
  };
});
