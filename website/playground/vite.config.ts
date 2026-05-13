import { defineConfig, type Plugin } from "vite";
import { resolve } from "node:path";
import { copyFileSync } from "node:fs";
import { test262Plugin } from "./vite-plugin-test262.js";
import { compilerBundlePlugin } from "./vite-plugin-compiler-bundle.js";
import { adrPlugin } from "./vite-plugin-adr.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const websiteRoot = resolve(projectRoot, "website");

function frameNavSyncPlugin(): Plugin {
  let outDir = resolve(projectRoot, "dist/playground");
  return {
    name: "frame-nav-sync",
    apply: "build",
    configResolved(config) {
      outDir = resolve(projectRoot, config.build.outDir);
    },
    closeBundle() {
      copyFileSync(resolve(websiteRoot, "frame-nav-sync.js"), resolve(outDir, "frame-nav-sync.js"));
    },
  };
}

export default defineConfig(async () => {
  const plugins = [compilerBundlePlugin(), test262Plugin(), adrPlugin(), frameNavSyncPlugin()];

  return {
    root: websiteRoot,
    appType: "mpa",
    base: "./",
    publicDir: "public",
    plugins,
    optimizeDeps: {
      // Pre-bundle heavy deps so Vite doesn't transform them on each page load.
      // compiler-bundle.mjs (3.2MB) and runtime-bundle.mjs (3.2MB) cause OOM without this.
      include: ["typescript", "monaco-editor/esm/vs/editor/editor.api"],
      esbuildOptions: {
        target: "esnext",
      },
    },
    resolve: {
      alias: {
        path: resolve(import.meta.dirname, "stubs/path-shim.js"),
        "node:path": resolve(import.meta.dirname, "stubs/path-shim.js"),
        "node:fs": resolve(import.meta.dirname, "stubs/node-fs-stub.js"),
        "node:child_process": resolve(import.meta.dirname, "stubs/node-stub.js"),
        "node:os": resolve(import.meta.dirname, "stubs/node-stub.js"),
        "node:module": resolve(import.meta.dirname, "stubs/node-module-stub.js"),
      },
    },
    server: {
      fs: {
        allow: [projectRoot],
      },
      watch: {
        // Exclude large dependency, conformance, and build output trees.
        ignored: [
          "**/test262/**",
          "**/node_modules/**",
          "**/.test262-cache/**",
          "**/dist/pages/**",
          "**/dist/playground/**",
          "**/benchmarks/results/test262-results-*.jsonl",
        ],
      },
    },
    build: {
      outDir: resolve(projectRoot, "dist/playground"),
      emptyOutDir: true,
      target: "esnext",
      rollupOptions: {
        input: {
          index: resolve(websiteRoot, "index.html"),
          playground: resolve(import.meta.dirname, "index.html"),
        },
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/monaco-editor")) return "monaco";
            if (id.includes("node_modules/typescript")) return "typescript";
          },
        },
      },
    },
  };
});
