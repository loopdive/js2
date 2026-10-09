// #6890 — the native regime in a JavaScript environment reads `console` as a
// VALUE from the host: `console` is a platform capability (environment-shaped),
// so the module imports `global_console` (`platform-capability`/`console`) and
// the runtime admits the object at the value boundary; member reads then go
// through the boundary object MOP. Before this, the read fell to the graceful
// null default and react's module-init `console.createTask` feature test threw.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyHostImport } from "../src/host-import-policy.js";
import { compileProject } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

async function runRegime(devSource: string): Promise<{ value: unknown; imports: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "issue-6890-"));
  writeFileSync(join(dir, "dev.js"), devSource);
  writeFileSync(join(dir, "main.js"), `import dev from "./dev.js";\nexport function va() { return dev.va(); }\n`);
  const result = await compileProject(join(dir, "main.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    platform: "node",
    semanticProviders: "native-first",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  const exports = wrapCompiledExports(result, instance) as Record<string, () => unknown>;
  const names = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((i) => i.name);
  return { value: exports.va!(), imports: names };
}

const hostCreateTask = typeof (console as unknown as { createTask?: unknown }).createTask;

describe("#6890 console as a value under the native regime (JS environment)", () => {
  it("reads a console member captured at module init (the issue's reduction)", async () => {
    const { value, imports } = await runRegime(
      `(function () { var createTask = console.createTask; exports.va = function () { return typeof createTask; }; })();`,
    );
    expect(value).toBe(hostCreateTask);
    expect(imports).toContain("global_console");
    expect(imports).not.toContain("__extern_get");
    expect(imports).not.toContain("__get_globalThis");
  });

  it("supports a typeof guard on a console member", async () => {
    const { value } = await runRegime(
      `(function () { exports.va = function () { return typeof console.createTask === "function" ? "fn" : "no"; }; })();`,
    );
    expect(value).toBe(hostCreateTask === "function" ? "fn" : "no");
  });

  it("passes console as a value to a function", async () => {
    const { value } = await runRegime(
      `(function () { function f(c) { return typeof c.log; } exports.va = function () { return f(console); }; })();`,
    );
    expect(value).toBe("function");
  });

  it("calls a console method read through an alias", async () => {
    const seen: unknown[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void seen.push(args.join(" "));
    try {
      const { value } = await runRegime(
        `(function () { var c = console; var l = c.log; exports.va = function () { l("via-alias"); return "ok"; }; })();`,
      );
      expect(value).toBe("ok");
    } finally {
      console.log = original;
    }
    expect(seen).toContain("via-alias");
  });

  it("classifies global_console as the console platform capability", () => {
    const policy = classifyHostImport({
      module: "env",
      name: "global_console",
      kind: "func",
      intent: { type: "declared_global", name: "console" },
    } as Parameters<typeof classifyHostImport>[0]);
    expect(policy.classification).toBe("platform-capability");
    expect(policy.family).toBe("console");
  });
});
