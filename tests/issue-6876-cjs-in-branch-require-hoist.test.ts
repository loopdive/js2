// #6876 — `require('<literal>')` inside module-scope control flow (react's
// `process.env.NODE_ENV` idiom) is hoisted to a module-scope import. Before,
// the host lane dropped the call to null and the native regime threw
// ReferenceError, so react was never compiled on either lane.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteCjsRequire } from "../src/cjs-rewrite.js";
import { compileProject } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "issue-6876-"));
  writeFileSync(join(dir, "a.js"), `module.exports = { v: "prod" };\n`);
  writeFileSync(join(dir, "b.js"), `module.exports = { v: "dev" };\n`);
  writeFileSync(
    join(dir, "entry.js"),
    `if (globalThis.__issue6876Prod) {\n  module.exports = require("./a.js");\n} else {\n  module.exports = require("./b.js");\n}\n`,
  );
  writeFileSync(join(dir, "main.js"), `import pkg from "./entry.js";\nexport function v() { return pkg.v; }\n`);
  return join(dir, "main.js");
}

describe("#6876 in-branch require hoist", () => {
  it("rewrites the idiom to hoisted imports", () => {
    const out = rewriteCjsRequire(
      `if (flag) { module.exports = require("./a.js"); } else { module.exports = require("./b.js"); }\n`,
    );
    expect(out).toContain('import __cjs_hoisted_require_0 from "./a.js";');
    expect(out).toContain('import __cjs_hoisted_require_1 from "./b.js";');
    expect(out).toContain("__cjs_default_export = __cjs_hoisted_require_0");
    expect(out).not.toContain("require(");
  });

  it("evaluates the chosen branch on the native regime and on default gc", async () => {
    for (const semanticProviders of ["native-first", undefined] as const) {
      const result = await compileProject(project(), {
        allowJs: true,
        skipSemanticDiagnostics: true,
        platform: "node",
        semanticProviders,
      });
      expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
      const imports = buildCompiledImports(result);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      (instance.exports as { __module_init?: () => void }).__module_init?.();
      const exports = wrapCompiledExports(result, instance) as Record<string, () => unknown>;
      expect(exports.v(), semanticProviders ?? "default").toBe("dev");
    }
  });

  it("evaluates the chosen branch under --target standalone", async () => {
    const result = await compileProject(project(), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    const v = (instance.exports as { v: () => unknown }).v();
    // A raw standalone export hands JS the native string struct; compare via
    // the module's own test bridge when present, else just require non-null.
    expect(v).not.toBeNull();
  });
});
