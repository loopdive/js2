// @ts-check
import process from "node:process";
import { build } from "vite";

/** @typedef {import("vite").InlineConfig} InlineConfig */
/** @typedef {{inline: InlineConfig, root: string, mode: string, configFile: string}} Request */

if (!process.send) throw new Error("Declarations child requires its parent IPC channel");
process.once("message", async (input) => {
  /** @type {Set<string>} */
  const watchFiles = new Set();
  let ok = false;
  try {
    const request = /** @type {Request} */ (input);
    if (
      !request ||
      typeof request.root !== "string" ||
      typeof request.mode !== "string" ||
      typeof request.configFile !== "string" ||
      !request.inline ||
      typeof request.inline !== "object"
    ) {
      throw new Error("Invalid declaration child context");
    }
    /** @type {import("vite").Plugin} */
    const collector = {
      name: "library-declarations-watch-set",
      buildEnd() {
        for (const path of this.getWatchFiles()) watchFiles.add(path);
      },
    };
    // Recreate the original typed factory via Vite's supported TS config loader.
    // Preserve all actual CLI inline options, except child watch and cleanup:
    // parent already honored true/false/auto cleanup and wrote genuine JS.
    const result = await build({
      ...request.inline,
      root: request.root,
      mode: request.mode,
      configFile: request.configFile,
      build: { ...request.inline.build, watch: null, emptyOutDir: false },
      plugins: [collector],
    });
    if (!Array.isArray(result) && !("output" in result)) {
      throw new Error("Declaration child unexpectedly returned a watcher");
    }
    const groups = Array.isArray(result) ? result : [result];
    if (groups.some((group) => group.output.length !== 0)) {
      throw new Error("Unexpected intermediate declaration-phase JS output");
    }
    ok = true;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  process.send?.({ kind: "library-declarations-result", ok, watchFiles: [...watchFiles] }, (error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    if (process.connected) process.disconnect();
  });
});
