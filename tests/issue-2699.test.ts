// #2699 — destructured/named function imports for node:url / node:module /
// node:os route to the `__nodefn__<module>__<fn>` host adapter (eslint imports
// these destructured: `const { pathToFileURL } = require("node:url")`).
//
// Before this fix, the destructured form fell through to a generic `env` stub
// and resolved to `undefined`. The namespace form (`os.platform()`) already
// worked via the `__node_os` module route; this covers the destructured form.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { compile, buildImports } from "../src/index.js";

const require = createRequire(import.meta.url);
const deps = {
  url: require("node:url"),
  module: require("node:module"),
  os: require("node:os"),
};

async function run(src: string) {
  const result = await compile(src, { fileName: "test.ts" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  // Pass the stringPool (3rd arg) so string-literal args resolve to JS strings
  // at the host-import boundary (e.g. `pathToFileURL("/tmp/x.js")`).
  const imports = buildImports(result.imports, deps, (result as { stringPool?: unknown }).stringPool);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return { result, instance };
}

describe("#2699 — node:url/module/os destructured-import host-glue", () => {
  it("classifies __nodefn__ imports for destructured node:url/module/os fns", async () => {
    const src = `
      const { pathToFileURL, fileURLToPath } = require("node:url");
      const { createRequire } = require("node:module");
      const { platform, release, tmpdir } = require("node:os");
      export function main(): number {
        return (typeof pathToFileURL) === "function" &&
               (typeof fileURLToPath) === "function" &&
               (typeof createRequire) === "function" &&
               (typeof platform) === "function" &&
               (typeof release) === "function" &&
               (typeof tmpdir) === "function" ? 1 : 0;
      }
    `;
    const { result, instance } = await run(src);
    const nodefn = result.imports.filter((i) => i.name.startsWith("__nodefn__")).map((i) => i.name);
    expect(nodefn).toContain("__nodefn__url__pathToFileURL");
    expect(nodefn).toContain("__nodefn__url__fileURLToPath");
    expect(nodefn).toContain("__nodefn__module__createRequire");
    expect(nodefn).toContain("__nodefn__os__platform");
    expect(nodefn).toContain("__nodefn__os__release");
    expect(nodefn).toContain("__nodefn__os__tmpdir");
    expect((instance.exports.main as () => number)()).toBe(1);
  });

  it("url.pathToFileURL / fileURLToPath round-trip via the host adapter", async () => {
    const src = `
      const { pathToFileURL, fileURLToPath } = require("node:url");
      export function ok(): number {
        const href = pathToFileURL("/tmp/x.js").href;
        const back = fileURLToPath("file:///tmp/x.js");
        return (href === "file:///tmp/x.js" && back === "/tmp/x.js") ? 1 : 0;
      }
    `;
    const { instance } = await run(src);
    expect((instance.exports.ok as () => number)()).toBe(1);
  });

  it("os.platform / os.release return the host values (non-empty strings)", async () => {
    const src = `
      const { platform, release } = require("node:os");
      export function plen(): number { return platform().length; }
      export function rlen(): number { return release().length; }
    `;
    const { instance } = await run(src);
    expect((instance.exports.plen as () => number)()).toBeGreaterThan(0);
    expect((instance.exports.rlen as () => number)()).toBeGreaterThan(0);
  });

  it("os.tmpdir returns the host temporary directory", async () => {
    const src = `
      const { tmpdir } = require("node:os");
      export function plen(): number { return tmpdir().length; }
    `;
    const { instance } = await run(src);
    expect((instance.exports.plen as () => number)()).toBeGreaterThan(0);
  });

  it("module.createRequire returns a callable", async () => {
    const src = `
      const { createRequire } = require("node:module");
      export function isFn(): number {
        return (typeof createRequire("/tmp/x.js")) === "function" ? 1 : 0;
      }
    `;
    const { instance } = await run(src);
    expect((instance.exports.isFn as () => number)()).toBe(1);
  });

  it("namespace form still works (no regression): os.platform()", async () => {
    const src = `
      const os = require("node:os");
      export function plen(): number { return os.platform().length; }
    `;
    const { instance } = await run(src);
    expect((instance.exports.plen as () => number)()).toBeGreaterThan(0);
  });
});
