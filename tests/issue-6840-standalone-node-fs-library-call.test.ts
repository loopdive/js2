// #6840 — a node:fs `readFileSync`/`writeFileSync` call inside a DEPENDENCY
// (a `node_modules` package) refused the whole `--target standalone` compile
// with the #1491 `--allow-fs` error (jest's graph: yargs, y18n, v8-to-istanbul,
// …). #1491 guards the JS-host `__node_fs_*` import against leaking the host
// filesystem to third-party code; a host-free module imports nothing, so the
// dependency call lowers to a documented throw at the call site instead. The
// program's own source keeps the #1491 compile error.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";

const ESM_DEP = `
import { readFileSync } from "fs";
export function readConfig(path) { return readFileSync(path, "utf8"); }
`;
const CJS_DEP = `
const { readFileSync, writeFileSync } = require("fs");
function load(path) { return readFileSync(path, "utf8"); }
function save(path, data) { writeFileSync(path, data); }
module.exports = { load, save };
`;

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "issue-6840-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return join(dir, "main.js");
}

function compile(entry: string, target: "standalone" | "gc") {
  return compileProject(entry, { allowJs: true, skipSemanticDiagnostics: true, target });
}

const DEP_FILES = {
  "node_modules/esm-dep/package.json": JSON.stringify({ name: "esm-dep", type: "module", main: "index.js" }),
  "node_modules/esm-dep/index.js": ESM_DEP,
  "node_modules/cjs-dep/package.json": JSON.stringify({ name: "cjs-dep", main: "index.js" }),
  "node_modules/cjs-dep/index.js": CJS_DEP,
};

const MAIN = `
import { readConfig } from "esm-dep";
import cjs from "cjs-dep";
let seen = 0;
function arg(v) { seen = seen + 1; return v; }
function attempt(f) {
  try { f(); return 0; } catch (e) {
    return e instanceof Error && !(e instanceof TypeError) && !(e instanceof ReferenceError) &&
      String(e.message).indexOf("node:fs.") === 0 ? 1 : 2;
  }
}
export function pure(x) { return x + 1; }
export function reached() {
  seen = 0;
  const r = attempt(() => readConfig(arg("/etc/hosts"))) +
    attempt(() => cjs.load(arg("/a"))) * 10 +
    attempt(() => cjs.save(arg("/b"), arg("data"))) * 100;
  return r + seen * 1000;
}
`;

describe("#6840 — standalone dependency node:fs calls throw at the call site", () => {
  it("a graph whose dependencies call readFileSync/writeFileSync compiles host-free", async () => {
    const result = await compile(project({ ...DEP_FILES, "main.js": MAIN }), "standalone");
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    (instance.exports.__module_init as (() => void) | undefined)?.();
    const exports = instance.exports as Record<string, () => number> & { pure(x: number): number };
    expect(exports.pure(41)).toBe(42);
    // Each reached call throws a catchable `Error` (1 per digit), after the
    // four arguments were evaluated (4000).
    expect(exports.reached()).toBe(4111);
  });

  it("the program's own readFileSync keeps the #1491 compile error (anti-vacuity control)", async () => {
    const entry = project({
      ...DEP_FILES,
      "main.js": `import { readFileSync } from "fs";\nexport function own(p) { return readFileSync(p, "utf8"); }`,
    });
    const result = await compile(entry, "standalone");
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join("\n")).toContain("requires the --allow-fs flag");
  });

  it("the JS-host target keeps the #1491 compile error for dependency code too", async () => {
    const result = await compile(project({ ...DEP_FILES, "main.js": MAIN }), "gc");
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join("\n")).toContain("requires the --allow-fs flag");
  });
});
