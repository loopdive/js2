// #6843 — stylelint's standalone lane retained `env.isDynamicPattern`. The
// producer was not globby's import: fast-glob's compiled CommonJS does
// `require("./pattern")`, TypeScript resolves that extensionless relative edge
// to the sibling `pattern.d.ts`, and the graph contains the declaration file in
// place of `pattern.js`. Each `export declare function` in it became a
// free-global `env.<name>` host import, and each `export declare class`
// (postcss's `Result`, `Stringifier`, …) an `env.<Class>_*` extern class.
//
// On `--target standalone` a package declaration file's declarations without
// a body in the program are a warning and a throwing use, never a host import.
// The JS-host lane is unchanged.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";

type Target = "standalone" | "gc";

async function compileFiles(files: Record<string, string>, target: Target) {
  const dir = mkdtempSync(join(tmpdir(), "issue-6843-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  // The large npm-compat lanes compile through the bundled fallback; pin it.
  const result = await compileProject(join(dir, "main.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target,
    packageLinking: false,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  return {
    result,
    module,
    imports: WebAssembly.Module.imports(module)
      .map((i) => `${i.module}.${i.name}`)
      .filter((name) => !name.startsWith("string_constants.")),
  };
}

async function run(module: WebAssembly.Module) {
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

// fast-glob's / postcss's shape: a typed CommonJS package whose body requires
// sibling modules that ship a `.d.ts` next to their `.js`.
const SHADOWED_BODY_PKG = {
  "node_modules/fakeglob/package.json": JSON.stringify({
    name: "fakeglob",
    main: "./out/index.js",
    types: "./out/index.d.ts",
  }),
  "node_modules/fakeglob/out/index.d.ts": "export declare function isDynamicPattern(p: string): boolean;\n",
  "node_modules/fakeglob/out/index.js":
    "const pattern = require('./pattern');\n" +
    "const Matcher = require('./matcher');\n" +
    "exports.isDynamicPattern = function (p) { return pattern.isDynamicPattern(p); };\n" +
    "exports.matches = function (p, s) { return new Matcher(p).test(s); };\n",
  "node_modules/fakeglob/out/pattern.d.ts": "export declare function isDynamicPattern(p: string): boolean;\n",
  "node_modules/fakeglob/out/pattern.js":
    "function isDynamicPattern(p) { return p.indexOf('*') >= 0; }\n" + "exports.isDynamicPattern = isDynamicPattern;\n",
  "node_modules/fakeglob/out/matcher.d.ts":
    "declare class Matcher {\n  constructor(p: string);\n  get source(): string;\n  test(s: string): boolean;\n}\nexport = Matcher;\n",
  "node_modules/fakeglob/out/matcher.js":
    "class Matcher { constructor(p) { this.p = p; } get source() { return this.p; } test(s) { return s === this.p; } }\n" +
    "module.exports = Matcher;\n",
};

// A package that ships only its declaration face: there is no body to compile.
const DECLARATION_ONLY_PKG = {
  "node_modules/declonly/package.json": JSON.stringify({
    name: "declonly",
    type: "module",
    exports: { types: "./index.d.ts", default: "./index.js" },
  }),
  "node_modules/declonly/index.d.ts": "export declare function isDynamicPattern(p: string): boolean;\n",
};

const main = (specifier: string) => `
import { isDynamicPattern } from '${specifier}';
export function f(x) { return isDynamicPattern(x) ? 1 : 0; }
export function guarded(x) { try { return f(x); } catch (e) { return 7; } }
`;

const MAIN_WITH_CLASS = `
import { isDynamicPattern, matches } from 'fakeglob';
export function guarded(x) { try { return isDynamicPattern(x) ? 1 : 0; } catch (e) { return 7; } }
export function guardedClass() { try { return matches("a", "a") ? 1 : 0; } catch (e) { return 7; } }
`;

describe("#6843 — package declaration files never become standalone host imports", () => {
  it("declarations of a body shadowed by a sibling .d.ts are warnings, not env imports", async () => {
    const { imports, module, result } = await compileFiles(
      { ...SHADOWED_BODY_PKG, "main.js": MAIN_WITH_CLASS },
      "standalone",
    );
    expect(imports).toEqual([]);
    const warnings = result.errors.filter((e) => e.message.includes("#6843"));
    expect(warnings.every((w) => w.severity === "warning")).toBe(true);
    expect(warnings.some((w) => w.message.includes('"isDynamicPattern"') && w.message.includes("pattern.d.ts"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.message.includes('"Matcher"') && w.message.includes("matcher.d.ts"))).toBe(true);
    const ex = await run(module);
    expect(ex.guarded("a*")).toBe(7);
    expect(ex.guardedClass()).toBe(7);
  });

  it("a declaration-only package binding is a warning and a throwing call, not env.<name>", async () => {
    const { imports, module, result } = await compileFiles(
      { ...DECLARATION_ONLY_PKG, "main.js": main("declonly") },
      "standalone",
    );
    expect(imports).toEqual([]);
    const warning = result.errors.find((e) => e.message.includes("#6843"));
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("isDynamicPattern");
    expect(warning?.message).toContain("index.d.ts");
    const ex = await run(module);
    expect(ex.guarded("a*")).toBe(7);
  });

  it("an import from an unresolvable package has no host import and no #6843 warning (control)", async () => {
    const { imports, result } = await compileFiles({ "main.js": main("missing-pkg-6843") }, "standalone");
    expect(imports).toEqual([]);
    expect(result.errors.some((e) => e.message.includes("#6843"))).toBe(false);
  });

  it("the JS-host target keeps its existing env imports (anti-vacuity control)", async () => {
    const shadowed = await compileFiles({ ...SHADOWED_BODY_PKG, "main.js": MAIN_WITH_CLASS }, "gc");
    expect(shadowed.imports).toContain("env.isDynamicPattern");
    expect(shadowed.imports.some((name) => name.startsWith("env.Matcher"))).toBe(true);
    const declOnly = await compileFiles({ ...DECLARATION_ONLY_PKG, "main.js": main("declonly") }, "gc");
    expect(declOnly.imports).toContain("env.isDynamicPattern");
  });
});
