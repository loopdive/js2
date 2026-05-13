import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [dts()],
  optimizeDeps: {
    exclude: ["binaryen", "typescript"],
  },
  server: {
    fs: {
      // Allow serving files from the project workspace during local development.
      allow: ["."],
    },
  },
  build: {
    target: "esnext",
    lib: {
      entry: {
        index: "src/index.ts",
        cli: "src/cli.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        "typescript",
        "binaryen",
        "path",
        "fs",
        "url",
        "os",
        "child_process",
        "node:fs",
        "node:path",
        "node:process",
        "node:module",
        "node:url",
        "node:os",
        "node:child_process",
      ],
    },
  },
});
