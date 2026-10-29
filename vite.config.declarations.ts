import { defineConfig, normalizePath, type Plugin } from "vite";
import { createLibraryConfig } from "./vite.config.lib";

// Import only the typed original factory; never invoke the parent default plugin.
export default defineConfig((env) => {
  const config = createLibraryConfig(env, { declarationOnly: true });
  let entries = new Set<string>();
  const loaded = new Set<string>();
  const boundary: Plugin = {
    name: "library-declaration-entry-boundary",
    enforce: "pre",
    async buildStart(options) {
      // Options are final Rollup inputs, after Vite's CLI/config resolution.
      // Resolve only these exact entries; do not replace src/** or strip queries.
      const input = options.input;
      const originals = typeof input === "string" ? [input] : Array.isArray(input) ? input : Object.values(input);
      if (!originals.length) throw new Error("No declaration Rollup entry");
      entries = new Set();
      loaded.clear();
      for (const entry of originals) {
        const resolved = await this.resolve(entry, undefined, { skipSelf: true });
        if (!resolved || resolved.external || resolved.id.startsWith("\0")) {
          throw new Error(`Declaration entry is not a resolved physical module: ${entry}`);
        }
        entries.add(normalizePath(resolved.id));
      }
    },
    load(id) {
      const exact = normalizePath(id);
      if (!entries.has(exact)) return null;
      loaded.add(exact);
      // This is only the intermediate Rollup input. The original DTS program
      // still reads every real lib entry and filtered tsconfig source file.
      return { code: "", map: null };
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        if (loaded.size !== entries.size) {
          throw new Error("Incomplete declaration entries");
        }
        // DTS deletes its intermediate JS before Vite's later manifest hooks.
        // Suppress only those late child assets: the parent already wrote the
        // genuine full-graph assets. Any unexpected surviving JS is still fatal.
        for (const fileName of Object.keys(bundle)) {
          if (bundle[fileName].type !== "asset") {
            throw new Error("Unexpected intermediate declaration JavaScript");
          }
          delete bundle[fileName];
        }
      },
    },
  };
  config.plugins.unshift(boundary);
  return config;
});
