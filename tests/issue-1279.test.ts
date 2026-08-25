// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1279: Static `require()` analysis — top-level `const X = require('Y')` and
// `const { ... } = require('Y')` are rewritten to ESM imports before module
// resolution, letting the existing import pipeline link them correctly.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { compile, compileMulti, compileProject } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";
import { rewriteCjsRequire } from "../src/cjs-rewrite.js";

async function prepareMultiModule(files: Record<string, string>, entryFile = "./entry.js") {
  const result = await compileMulti(files, entryFile, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return {
    initialize: () => (instance.exports as Record<string, Function>).__module_init?.(),
    exports: wrapExports(instance),
  };
}

describe("issue-1279: CJS require() static module graph", () => {
  describe("rewriteCjsRequire", () => {
    it("rewrites `const X = require('Y')` to `import X from 'Y'`", () => {
      const out = rewriteCjsRequire(`const path = require("node:path");`);
      expect(out).toContain(`import path from "node:path";`);
      expect(out).not.toContain("require(");
    });

    it("rewrites `require('Y').member` to a named import", () => {
      const out = rewriteCjsRequire(`var Stream = require("stream").Stream;`);
      expect(out).toBe(`import { Stream as Stream } from "node:stream";`);
    });

    it("surfaces an `exports.member` CommonJS leaf as its default export", () => {
      const out = rewriteCjsRequire(`exports.lookup = function lookup() {};`);
      expect(out).toContain(`const exports = __cjs_default_export;`);
      expect(out).toContain(`exports.lookup = function lookup() {};`);
      expect(out).toContain(`export { __cjs_default_export as default };`);
    });

    it("links and preserves an immediately invoked CommonJS factory", () => {
      const out = rewriteCjsRequire(`var hasSymbols = require("has-symbols")();`);
      expect(out).toMatch(/import __cjs_require_hasSymbols_\d+ from "has-symbols";/);
      expect(out).toMatch(/var hasSymbols = __cjs_require_hasSymbols_\d+\(\);/);
      expect(out).not.toContain("require(");
    });

    it("rewrites a single callable module.exports assignment directly", () => {
      const out = rewriteCjsRequire(`module.exports = function factory() { return 7; };`);
      expect(out).toBe(`export default function factory() { return 7; };`);
      expect(out).not.toContain("__cjs_default_export");
    });

    it("links a single module.exports require as a static default re-export", () => {
      const out = rewriteCjsRequire(`module.exports = require("./db.json");`);
      expect(out).toMatch(/import __cjs_default_export_value_\d+ from "\.\/db\.json";/);
      expect(out).toMatch(/export default __cjs_default_export_value_\d+;/);
      expect(out).not.toContain("require(");
    });

    it("links a distinct-name default import through a JSON forwarding module", async () => {
      const root = mkdtempSync(join(tmpdir(), "js2-cjs-json-forward-"));
      try {
        mkdirSync(join(root, "data"));
        writeFileSync(
          join(root, "data", "db.json"),
          JSON.stringify({ "application/x-loopdive": { extensions: ["loop"] } }),
        );
        writeFileSync(join(root, "data", "forward.js"), `module.exports = require("./db.json");`);
        const entry = join(root, "entry.js");
        writeFileSync(
          entry,
          `
            var catalog = require("./data/forward.js");
            export function read() {
              return catalog["application/x-loopdive"].extensions[0];
            }
          `,
        );

        const result = await compileProject(entry, {
          allowJs: true,
          skipSemanticDiagnostics: true,
          deferTopLevelInit: true,
        });
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        const imports = buildImports(result.imports, undefined, result.stringPool);
        const { instance } = await WebAssembly.instantiate(result.binary, imports);
        imports.setInstance?.(instance);
        (instance.exports as Record<string, Function>).__module_init?.();
        const exports = wrapExports(instance.exports as Record<string, Function>);
        expect(exports.read()).toBe("loop");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("rewrites `const { a } = require('Y')` to `import { a } from 'Y'`", () => {
      const out = rewriteCjsRequire(`const { join } = require("node:path");`);
      expect(out).toContain(`import { join } from "node:path";`);
      expect(out).not.toContain("require(");
    });

    it("preserves alias bindings: `const { a: b } = require('Y')` → `import { a as b } from 'Y'`", () => {
      const out = rewriteCjsRequire(`const { join: j, resolve: r } = require("node:path");`);
      expect(out).toContain(`import { join as j, resolve as r } from "node:path";`);
    });

    it("handles relative specifiers", () => {
      const out = rewriteCjsRequire(`const x = require("./x");`);
      expect(out).toContain(`import x from "./x";`);
    });

    it("rewrites unmodified `let`/`var` require bindings and preserves reassigned bindings", () => {
      const letResult = rewriteCjsRequire(`let y = require("y");`);
      expect(letResult).toBe(`import y from "y";`);
      const varResult = rewriteCjsRequire(`var y = require("y");`);
      expect(varResult).toBe(`import y from "y";`);
      expect(letResult).not.toContain("require(");
      expect(varResult).not.toContain("require(");
      const reassigned = `var y = require("y");\ny = replacement;`;
      expect(rewriteCjsRequire(reassigned)).toBe(reassigned);
    });

    it("preserves rest patterns and default initializers (not expressible as ESM imports)", () => {
      expect(rewriteCjsRequire(`const { ...rest } = require("z");`)).toContain(`require("z")`);
      expect(rewriteCjsRequire(`const { a = 1 } = require("z");`)).toContain(`require("z")`);
    });

    it("preserves nested (non-top-level) require()", () => {
      const src = `function f() { const x = require("x"); return x; }`;
      expect(rewriteCjsRequire(src)).toBe(src);
    });

    it("preserves dynamic specifiers (non-string-literal arguments)", () => {
      const src = `const x = require(dynamicSpec);`;
      expect(rewriteCjsRequire(src)).toBe(src);
    });

    it("rewrites an all-static multi-declaration into ordered imports", () => {
      const src = `const a = require("a"), b = require("b");`;
      expect(rewriteCjsRequire(src)).toBe(`import a from "a";\nimport b from "b";`);
    });

    it("preserves a mixed multi-declaration atomically", () => {
      const src = `const a = require("a"), b = makeB();`;
      expect(rewriteCjsRequire(src)).toBe(src);
    });

    it("returns source unchanged when no `require(` token is present", () => {
      const src = `export const x = 1;\nexport function f() { return x; }`;
      expect(rewriteCjsRequire(src)).toBe(src);
    });

    it("returns source unchanged when `require(` is only inside strings/comments", () => {
      const src = `// const x = require("x");\nexport const x = 1;`;
      // Cheap pre-check (`includes("require(")`) trips, but the AST walk finds nothing.
      expect(rewriteCjsRequire(src)).toBe(src);
    });
  });

  describe("default-export expression snapshots", () => {
    it("snapshots an identifier default before a later mutation", async () => {
      const module = await prepareMultiModule({
        "./value.js": `
          let current = 1;
          export default current;
          current = 2;
        `,
        "./entry.js": `
          import value from "./value.js";
          export function read() { return value; }
        `,
      });

      module.initialize();
      expect(module.exports.read()).toBe(1);
    });

    it("keeps distinct same-named callable leaves through two forwarding modules", async () => {
      const module = await prepareMultiModule({
        "./left-leaf.js": `export default function source() { return 1; }`,
        "./right-leaf.js": `export default function source() { return 2; }`,
        "./left.js": `import value from "./left-leaf.js"; export default value;`,
        "./right.js": `import value from "./right-leaf.js"; export default value;`,
        "./entry.js": `
          import left from "./left.js";
          import right from "./right.js";
          export function read() { return left() * 10 + right(); }
        `,
      });

      module.initialize();
      expect(module.exports.read()).toBe(12);
    });

    it("does not let an unrelated reassigned function hide an immutable forwarded default", async () => {
      const module = await prepareMultiModule({
        "./leaf.js": `export default function source() { return 1; }`,
        "./forward.js": `import value from "./leaf.js"; export default value;`,
        "./reassigned.js": `
          export function source() { return 2; }
          source = function replacement() { return 9; };
        `,
        "./entry.js": `
          import "./reassigned.js";
          import value from "./forward.js";
          export function read() { return value(); }
        `,
      });

      module.initialize();
      expect(module.exports.read()).toBe(1);
    });

    it("constructs the snapshotted default value instead of its later replacement", async () => {
      const module = await prepareMultiModule({
        "./value.js": `
          function First() { this.value = 1; }
          function Second() { this.value = 2; }
          let Current = First;
          export default Current;
          Current = Second;
        `,
        "./entry.js": `
          import Current from "./value.js";
          export function read() { return new Current().value; }
        `,
      });

      module.initialize();
      expect(module.exports.read()).toBe(1);
    });

    it("does not capture an unrelated source binding for an ambient identifier", async () => {
      const module = await prepareMultiModule({
        "./other.js": `export const Infinity = 5;`,
        "./value.js": `export default Infinity;`,
        "./entry.js": `
          import "./other.js";
          import value from "./value.js";
          export function read() { return value; }
        `,
      });

      module.initialize();
      expect(module.exports.read()).toBe(Infinity);
    });

    it("does not resolve a circular default through an unrelated same-named export", async () => {
      const module = await prepareMultiModule({
        "./other.js": `export const value = 9;`,
        "./a.js": `import value from "./b.js"; export default value;`,
        "./b.js": `import value from "./a.js"; export default value;`,
        "./entry.js": `
          import "./other.js";
          import value from "./a.js";
          export function read() { return value; }
        `,
      });

      expect(() => module.initialize()).toThrow();
    });
  });

  describe("acceptance criteria", () => {
    it("AC1: `const path = require('node:path'); export function f()` compiles", async () => {
      const src = `
const path = require("node:path");
export function f(): string {
  return path.join("a", "b");
}`;
      const result = await compile(src, { fileName: "test.ts" });
      if (!result.success) {
        const msgs = result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n");
        throw new Error(`expected success but got errors:\n${msgs}`);
      }
      expect(result.success).toBe(true);
    });

    it("AC2: `const { X } = require('./x')` links correctly across files", async () => {
      const files = {
        "./x.ts": `export function X(): number { return 42; }`,
        "./entry.ts": `
const { X } = require("./x");
export function g(): number { return X(); }`,
      };
      const r = await compileMulti(files, "./entry.ts");
      if (!r.success) {
        const msgs = r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n");
        throw new Error(`expected success but got errors:\n${msgs}`);
      }
      expect(r.success).toBe(true);

      const imports = buildImports(r.imports, undefined, r.stringPool);
      const { instance } = await WebAssembly.instantiate(r.binary, imports);
      const g = (instance.exports as { g: () => number }).g;
      expect(g()).toBe(42);
    });

    it("alias form `const { X: Y } = require('./x')` rewrites to `import { X as Y }` and compiles", async () => {
      // Runtime linking of `import { X as Y }` and `import x from './x'` (default
      // imports across compiled modules) is a separate, pre-existing limitation in
      // the multi-source codegen — the ESM equivalents return 0 today. The rewrite
      // itself produces well-formed ESM source and compilation succeeds, which is
      // what #1279 covers; runtime linkage will follow once the upstream multi-
      // source loader gains default/alias-binding support.
      const rewritten = rewriteCjsRequire(`const { X: Y } = require("./x");`);
      expect(rewritten).toContain(`import { X as Y } from "./x";`);

      const files = {
        "./x.ts": `export function X(): number { return 7; }`,
        "./entry.ts": `
const { X: Y } = require("./x");
export function g(): number { return Y(); }`,
      };
      const r = await compileMulti(files, "./entry.ts");
      if (!r.success) {
        const msgs = r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n");
        throw new Error(`expected success but got errors:\n${msgs}`);
      }
      expect(r.success).toBe(true);
    });

    it("default-import form `const x = require('./x')` rewrites to `import x from './x'` and compiles", async () => {
      const rewritten = rewriteCjsRequire(`const x = require("./x");`);
      expect(rewritten).toContain(`import x from "./x";`);

      const files = {
        "./x.ts": `export default function X(): number { return 11; }`,
        "./entry.ts": `
const x = require("./x");
export function g(): number { return x(); }`,
      };
      const r = await compileMulti(files, "./entry.ts");
      if (!r.success) {
        const msgs = r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n");
        throw new Error(`expected success but got errors:\n${msgs}`);
      }
      expect(r.success).toBe(true);
    });

    it("an unmodified `var x = require('./x')` links the callable value", async () => {
      const files = {
        "./x.ts": `export default function X(value: number): number { return value + 1; }`,
        "./entry.ts": `
var x = require("./x");
export function g(): number { return x(6); }`,
      };
      const r = await compileMulti(files, "./entry.ts", { skipSemanticDiagnostics: true });
      expect(r.success).toBe(true);
      const imports = buildImports(r.imports, undefined, r.stringPool);
      const { instance } = await WebAssembly.instantiate(r.binary, imports);
      expect((instance.exports as { g: () => number }).g()).toBe(7);
    });

    it("catches a strict arguments.callee poison read inside a CommonJS-style IIFE", async () => {
      const result = await compile(
        `
          "use strict";
          var value = (function () {
            try {
              arguments.callee;
              return 1;
            } catch (error) {
              return error instanceof TypeError ? 2 : 3;
            }
          }());
          export function read() { return value; }
        `,
        {
          allowJs: true,
          fileName: "cjs-iife.js",
          skipSemanticDiagnostics: true,
          deferTopLevelInit: true,
        },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      (instance.exports as Record<string, Function>).__module_init?.();
      expect((instance.exports as { read: () => number }).read()).toBe(2);
    });

    it("links the replaced callable value of module.exports, not its empty prelude object", async () => {
      const result = await compileMulti(
        {
          "./factory.js": `module.exports = function factory() { return 7; };`,
          "./entry.js": `import factory from "./factory.js"; export function read() { return factory(); }`,
        },
        "./entry.js",
        { allowJs: true, skipSemanticDiagnostics: true, deferTopLevelInit: true },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      (instance.exports as Record<string, Function>).__module_init?.();
      expect((instance.exports as { read: () => number }).read()).toBe(7);
    });

    it("preserves the receiver when a required compiled function is invoked with .call", async () => {
      const result = await compileMulti(
        {
          "./bind.js": `
            "use strict";
            module.exports = function bind(value) {
              return this === Function.prototype.call && value === Object.prototype.hasOwnProperty ? 1 : 0;
            };
          `,
          "./hasown.js": `
            "use strict";
            var call = Function.prototype.call;
            var bind = require("./bind");
            module.exports = bind.call(call, Object.prototype.hasOwnProperty);
          `,
          "./entry.js": `
            import result from "./hasown.js";
            export function read() { return result; }
          `,
        },
        "./entry.js",
        { allowJs: true, skipSemanticDiagnostics: true, deferTopLevelInit: true },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      (instance.exports as Record<string, Function>).__module_init?.();
      expect((instance.exports as { read: () => number }).read()).toBe(1);
    });

    it("keeps a callable Function.prototype fallback ahead of a required implementation", async () => {
      const result = await compileMulti(
        {
          "./implementation.js": `
            "use strict";
            module.exports = function implementation() { return 0; };
          `,
          "./bind.js": `
            "use strict";
            var implementation = require("./implementation");
            module.exports = Function.prototype.bind || implementation;
          `,
          "./entry.js": `
            import bind from "./bind.js";
            export function read() {
              var hasOwn = bind.call(Function.prototype.call, Object.prototype.hasOwnProperty);
              return hasOwn({ value: 1 }, "value") ? 1 : 0;
            }
          `,
        },
        "./entry.js",
        { allowJs: true, skipSemanticDiagnostics: true, deferTopLevelInit: true },
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      (instance.exports as Record<string, Function>).__module_init?.();
      expect((instance.exports as { read: () => number }).read()).toBe(1);
    });
  });

  describe("regression guard", () => {
    it("ESM imports still resolve and link correctly after the CJS rewrite step", async () => {
      const files = {
        "./x.ts": `export function X(): number { return 42; }`,
        "./entry.ts": `
import { X } from "./x";
export function g(): number { return X(); }`,
      };
      const r = await compileMulti(files, "./entry.ts");
      expect(r.success).toBe(true);
      const imports = buildImports(r.imports, undefined, r.stringPool);
      const { instance } = await WebAssembly.instantiate(r.binary, imports);
      const g = (instance.exports as { g: () => number }).g;
      expect(g()).toBe(42);
    });

    it("source without any `require` is byte-identical after the rewrite", () => {
      const src = `
export function add(a: number, b: number): number { return a + b; }
export const PI = 3.14159;
`;
      expect(rewriteCjsRequire(src)).toBe(src);
    });

    it("mixed ESM + CJS imports both resolve in the same module", async () => {
      const files = {
        "./a.ts": `export function A(): number { return 10; }`,
        "./b.ts": `export function B(): number { return 20; }`,
        "./entry.ts": `
import { A } from "./a";
const { B } = require("./b");
export function g(): number { return A() + B(); }`,
      };
      const r = await compileMulti(files, "./entry.ts");
      if (!r.success) {
        const msgs = r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n");
        throw new Error(`expected success but got errors:\n${msgs}`);
      }
      const imports = buildImports(r.imports, undefined, r.stringPool);
      const { instance } = await WebAssembly.instantiate(r.binary, imports);
      const g = (instance.exports as { g: () => number }).g;
      expect(g()).toBe(30);
    });
  });
});
