// #6910 — the native regime in a JavaScript environment reads the Node
// `process` from the host. Reading the process is a PLATFORM capability (the
// `node` family), so the environment decides: a JS environment imports
// `__get_process_env` and the runtime admits the object at the value boundary
// (member reads go through `__boundary_object_get`, never `__extern_get`); a
// host-free `--target standalone` build keeps the empty stand-in object; WASI
// keeps its #1482 environ path.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyHostImport } from "../src/host-import-policy.js";
import { compileProject } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

const DEV = `(function () {
  exports.va = function () { return process.env.ISSUE_6910; };
  exports.vb = function () { var u = process.env.ISSUE_6910_UNSET; return typeof u + ":" + (u === undefined); };
  exports.vc = function () { var e = process.env; return typeof e.ISSUE_6910 + ":" + (e.ISSUE_6910 === "x"); };
  exports.vd = function () { return process.platform; };
  exports.ve = function () { return (process.env.ISSUE_6910 === undefined ? 1 : 0) + (process.env.ISSUE_6910_UNSET === undefined ? 2 : 0); };
})();`;

async function run(
  options: Record<string, unknown>,
): Promise<{ ex: Record<string, () => unknown>; imports: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "issue-6910-"));
  writeFileSync(join(dir, "dev.js"), DEV);
  const reexport = ["va", "vb", "vc", "vd", "ve"]
    .map((n) => `export function ${n}() { return dev.${n}(); }`)
    .join("\n");
  writeFileSync(join(dir, "main.js"), `import dev from "./dev.js";\n${reexport}\n`);
  const result = await compileProject(join(dir, "main.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    ...options,
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  const names = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((i) => i.name);
  return { ex: wrapCompiledExports(result, instance) as Record<string, () => unknown>, imports: names };
}

describe("#6910 process.env under the native regime (JS environment)", () => {
  process.env.ISSUE_6910 = "x"; // ISSUE_6910_UNSET is never set

  it("reads the host's process.env through the admitted boundary object", async () => {
    const { ex, imports } = await run({ platform: "node", semanticProviders: "native-first" });
    expect(ex.va!()).toBe("x");
    expect(ex.vb!()).toBe("undefined:true");
    expect(ex.vc!()).toBe("string:true");
    expect(ex.vd!()).toBe(process.platform);
    expect(ex.ve!()).toBe(2);
    expect(imports).toContain("__get_process_env");
    expect(imports).toContain("__boundary_object_get");
    expect(imports).not.toContain("__extern_get");
  });

  it("the default gc lane is unchanged", async () => {
    const { ex } = await run({ platform: "node" });
    expect(ex.va!()).toBe("x");
    expect(ex.vb!()).toBe("undefined:true");
    expect(ex.vc!()).toBe("string:true");
  });

  it("a host-free --target standalone build keeps the empty stand-in", async () => {
    const { ex, imports } = await run({ target: "standalone" });
    expect(ex.ve!()).toBe(3); // both keys undefined: the stand-in has no members
    expect(imports).not.toContain("__get_process_env");
  });

  it("classifies the __get_process* readers as the node platform capability", () => {
    for (const name of ["__get_process", "__get_process_env", "__get_process_argv", "__get_process_platform"]) {
      const policy = classifyHostImport({
        module: "env",
        name,
        kind: "func",
        intent: { type: "builtin", name },
      } as Parameters<typeof classifyHostImport>[0]);
      expect(policy.classification).toBe("platform-capability");
      expect(policy.family).toBe("node");
    }
  });
});
