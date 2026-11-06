import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { compileProject, ModuleResolver, resolveAllImports } from "../src/index.js";

/**
 * (#6855) `--target standalone`: an ESM `import` of a bare package resolves
 * through the package's `exports` map, as Node's ESM loader does.
 *
 * styled-components' module init threw `TypeError: called value is not a
 * function` at `o.rulesheet(...)` (`import * as o from "stylis"`). The resolver
 * handed `"stylis"` to TypeScript's Node10 resolver, which ignores `exports`
 * and answers `main` — stylis's UMD build `dist/umd/stylis.js`, whose
 * `typeof exports === "object" ? r(exports) : r(e.stylis = {})` wrapper
 * populates no ESM namespace, so every named import of it read `undefined`.
 * Node picks `exports["."].import` → `./index.js`.
 *
 * The `dualpkg` fixture reproduces that shape: `main` is a UMD build, the
 * `import` condition an ESM `export *` barrel. Rows r1–r3 are red on the parent
 * commit (r1 throws at module init, exactly the styled-components symptom).
 *
 * Controls (anti-vacuity, green on the parent too and must stay so):
 *  - c1: a package with no `exports` keeps Node10 `main` resolution.
 *  - c2: a CommonJS `require` edge keeps Node10 `main` — Node would pick the
 *    `require` condition there, so `exports.import` must not leak into it.
 *  - c3: the gc (JS-host) graph is unchanged — the fix is standalone-only.
 *  - c4: the bundler `module` condition outranks Node's `import`/`default`
 *    branches when listed first (`@emotion/is-prop-valid` shape: Node's
 *    `import` branch is a `cjs.mjs` → `cjs.js` CommonJS wrapper).
 */

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const UMD = `(function (e, r) {
  typeof exports === "object" && typeof module !== "undefined" ? r(exports) : ((e = e || self), r((e.dualpkg = {})));
})(this, function (e) {
  "use strict";
  e.twice = function (x) { return x * 2; };
  e.marker = function () { return 1; };
  Object.defineProperty(e, "__esModule", { value: true });
});
`;

function writeTree(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    const full = join(root, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "js2-6855-"));
  roots.push(root);
  writeTree(root, {
    "node_modules/dualpkg/package.json": JSON.stringify({
      name: "dualpkg",
      main: "dist/umd/dualpkg.js",
      exports: { ".": { import: "./index.js", require: "./dist/umd/dualpkg.js" } },
    }),
    "node_modules/dualpkg/dist/umd/dualpkg.js": UMD,
    "node_modules/dualpkg/index.js": `export * from "./src/a.js";\nexport * from "./src/b.js";\n`,
    "node_modules/dualpkg/src/a.js": `export function twice(x) { return x * 2; }\n`,
    "node_modules/dualpkg/src/b.js": `export function marker() { return 2; }\n`,
    "node_modules/plainpkg/package.json": JSON.stringify({ name: "plainpkg", main: "main.js" }),
    "node_modules/plainpkg/main.js": `export function plus1(x) { return x + 1; }\n`,
    "node_modules/modpkg/package.json": JSON.stringify({
      name: "modpkg",
      main: "dist/cjs.js",
      exports: { ".": { module: "./dist/esm.js", import: "./dist/cjs.mjs", default: "./dist/cjs.js" } },
    }),
    "node_modules/modpkg/dist/esm.js": `export function tag() { return 3; }\n`,
    "node_modules/modpkg/dist/cjs.mjs": `export { tag } from "./cjs.js";\n`,
    "node_modules/modpkg/dist/cjs.js": `exports.tag = function () { return 4; };\n`,
    "cjs-consumer.js": `const d = require("dualpkg");\nmodule.exports = { viaRequire: d };\n`,
    "main.js": [
      `import { twice, marker } from "dualpkg";`,
      `import * as ns from "dualpkg";`,
      `import { plus1 } from "plainpkg";`,
      `import { tag } from "modpkg";`,
      `const atInit = twice(5);`,
      `export function r1() { return atInit; }`,
      `export function r2() { return ns.twice(21); }`,
      `export function r3() { return marker(); }`,
      `export function c1() { return plus1(41); }`,
      `export function c4() { return tag(); }`,
      ``,
    ].join("\n"),
  });
  return root;
}

function graphOf(entry: string, target: "standalone" | "gc"): string[] {
  const root = realpathSync(dirname(entry));
  const resolver = new ModuleResolver(root, { allowJs: true, target });
  return [...resolveAllImports(entry, resolver).keys()].map((file) => relative(root, file)).sort();
}

describe("#6855 standalone ESM import honours package `exports`", () => {
  it("r1–r3 + c1/c4: named, namespace and module-init calls reach the ESM build", async () => {
    const root = makeProject();
    const result = await compileProject(join(root, "main.js"), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.r1()).toBe(10);
    expect(ex.r2()).toBe(42);
    // 2 (ESM `src/b.js`), not 1 (the UMD build's `marker`).
    expect(ex.r3()).toBe(2);
    expect(ex.c1()).toBe(42);
    expect(ex.c4()).toBe(3);
  });

  it("resolution: import edge → exports.import; plain package → main; module condition first", () => {
    const root = makeProject();
    const graph = graphOf(join(root, "main.js"), "standalone");
    expect(graph).toContain("node_modules/dualpkg/index.js");
    expect(graph).not.toContain("node_modules/dualpkg/dist/umd/dualpkg.js");
    expect(graph).toContain("node_modules/plainpkg/main.js");
    expect(graph).toContain("node_modules/modpkg/dist/esm.js");
    expect(graph).not.toContain("node_modules/modpkg/dist/cjs.mjs");
  });

  it("control c2: a CommonJS require edge keeps Node10 main", () => {
    const root = makeProject();
    const graph = graphOf(join(root, "cjs-consumer.js"), "standalone");
    expect(graph).toContain("node_modules/dualpkg/dist/umd/dualpkg.js");
    expect(graph).not.toContain("node_modules/dualpkg/index.js");
  });

  it("control c3: the gc (JS-host) graph keeps Node10 main resolution", () => {
    const root = makeProject();
    const graph = graphOf(join(root, "main.js"), "gc");
    expect(graph).toContain("node_modules/dualpkg/dist/umd/dualpkg.js");
    expect(graph).not.toContain("node_modules/dualpkg/index.js");
  });
});
