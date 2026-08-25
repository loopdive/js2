import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WASI } from "node:wasi";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, compileMulti } from "../src/index.ts";

const DYNAMIC_WRITE = `
import { writeFileSync } from "node:fs";

function writeReport(prefix: string, kind: string, body: string): void {
  const file = prefix + "-" + kind + ".txt";
  writeFileSync(file, "payload:" + body);
}

const prefix = "issue-4565";
writeReport(prefix, "dynamic", "hello world");
`;

const MIXED_AND_MUTABLE_WRITES = String.raw`
import { writeFileSync } from "node:fs";

let dynamicPath = "issue-4565-before.txt";
dynamicPath = "issue-4565-after.txt";
let dynamicData = "before";
dynamicData = "after";
writeFileSync(dynamicPath, "literal-data");
writeFileSync("issue-4565-static-path.txt", dynamicData);

function throughAny(value: string): any {
  return value;
}
writeFileSync(throughAny("issue-4565-any.txt"), throughAny("any-data"));

let order = "";
function makePath(): string {
  order += "p";
  return "issue-4565-order.txt";
}
function makeData(): string {
  order += "d";
  return order;
}
function makeOptions(): any {
  order += "o";
  return {};
}
writeFileSync(makePath(), makeData(), makeOptions());
writeFileSync("issue-4565-options-order.txt", order);
`;

const UNICODE_PARITY = String.raw`
import { writeFileSync } from "node:fs";

let dynamic = "snowman:\u2603 emoji:\ud83d\ude00 lone:\ud800";
writeFileSync("issue-4565-dynamic-unicode.txt", dynamic);
writeFileSync("issue-4565-static-unicode.txt", "snowman:\u2603 emoji:\ud83d\ude00 lone:\ud800");
`;

const STRICT_STRING_ERROR = `
import { writeFileSync } from "node:fs";

let caught = "no";
try {
  writeFileSync("issue-4565-must-not-exist.txt", 42 as any);
} catch (error) {
  caught = error instanceof TypeError ? "yes" : "wrong-error";
}
writeFileSync("issue-4565-caught.txt", caught);

let missingCaught = "no";
try {
  writeFileSync("issue-4565-under-supplied.txt");
} catch (error) {
  missingCaught = error instanceof TypeError ? "yes" : "wrong-error";
}
writeFileSync("issue-4565-missing-caught.txt", missingCaught);

let validationOrder = "";
function dataAfterBadPath(): string {
  validationOrder += "d";
  return "unused";
}
function optionsAfterBadPath(): any {
  validationOrder += "o";
  return {};
}
try {
  writeFileSync(42 as any, dataAfterBadPath(), optionsAfterBadPath());
} catch {}
writeFileSync("issue-4565-validation-order.txt", validationOrder);
`;

const SHADOWED_WRITE_FILE_SYNC = `
import { writeFileSync } from "node:fs";

let called = "no";
function invoke(writeFileSync: any): void {
  writeFileSync("issue-4565-shadow-must-not-exist.txt", "wrong");
}
function local(): void {
  called = "yes";
}
invoke(local);
writeFileSync("issue-4565-shadow-called.txt", called);
`;

describe("#4565 — WASI dynamic writeFileSync string args use linear-memory helper", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "issue-4565-"));
  });

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  async function compileAndRun(source: string) {
    const r = await compile(source, { fileName: "test.ts", target: "wasi" });
    if (!r.success) {
      console.error(r.errors?.map((e) => `${e.code}: ${e.message}`));
    }
    expect(r.success).toBe(true);

    const wasi = new WASI({
      version: "preview1",
      preopens: { ".": workDir },
    });
    const mod = await WebAssembly.compile(r.binary);
    const instance = await WebAssembly.instantiate(mod, wasi.getImportObject());
    wasi.start(instance);
    return r;
  }

  test("compiles dynamic path and data strings through the sequenced helper", async () => {
    const r = await compile(DYNAMIC_WRITE, { fileName: "test.ts", target: "wasi" });
    if (!r.success) {
      console.error(r.errors?.map((e) => `${e.code}: ${e.message}`));
    }
    expect(r.success).toBe(true);

    const mod = new WebAssembly.Module(r.binary);
    const imports = WebAssembly.Module.imports(mod);
    expect(new Set(imports.map((i) => i.module))).toEqual(new Set(["wasi_snapshot_preview1"]));
    const importNames = imports.map((i) => i.name);
    expect(importNames).toContain("path_open");
    expect(importNames).toContain("fd_write");
    expect(importNames).toContain("fd_close");
    expect(r.wat ?? "").toContain("__wasi_write_file_strings");
  });

  test("writes file with runtime-composed path/data strings under Node WASI", async () => {
    await compileAndRun(DYNAMIC_WRITE);
    const files = readdirSync(workDir).sort();
    if (!files.includes("issue-4565-dynamic.txt")) {
      console.error("workDir files:", files);
    }
    const outputPath = join(workDir, "issue-4565-dynamic.txt");
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf-8")).toBe("payload:hello world");
  });

  test("preserves direct lowering when compileMulti retains the import specifier", async () => {
    const r = await compileMulti(
      {
        "./main.ts":
          'import { writeFileSync } from "node:fs"; const name = "issue-4565-multi.txt"; writeFileSync(name, "multi");',
      },
      "./main.ts",
      { target: "wasi", emitWat: true, skipSemanticDiagnostics: true },
    );
    expect(r.success).toBe(true);
    expect(r.wat ?? "").toContain("__wasi_write_file_strings");

    const wasi = new WASI({ version: "preview1", preopens: { ".": workDir } });
    const mod = await WebAssembly.compile(r.binary);
    const instance = await WebAssembly.instantiate(mod, wasi.getImportObject());
    wasi.start(instance);
    expect(readFileSync(join(workDir, "issue-4565-multi.txt"), "utf-8")).toBe("multi");
  });

  test("does not confuse an unrelated multi-file namesake with the node:fs binding", async () => {
    const r = await compileMulti(
      {
        "./fs-user.ts": 'import { writeFileSync } from "node:fs"; export const marker = 1;',
        "./user.ts":
          'export function writeFileSync(): string { return "user"; } export const alias = writeFileSync; export const result = alias();',
        "./main.ts":
          'import { marker } from "./fs-user.js"; import { result } from "./user.js"; export const combined = marker + result.length;',
      },
      "./main.ts",
      { target: "wasi", skipSemanticDiagnostics: true },
    );
    expect(r.success).toBe(true);
    expect(r.errors?.map((error) => error.message).join("\n") ?? "").not.toContain(
      "first-class aliases are unavailable",
    );
  });

  test("handles mixed literals, reassigned lets, any-carried strings, and evaluation order", async () => {
    await compileAndRun(MIXED_AND_MUTABLE_WRITES);

    expect(existsSync(join(workDir, "issue-4565-before.txt"))).toBe(false);
    expect(readFileSync(join(workDir, "issue-4565-after.txt"), "utf-8")).toBe("literal-data");
    expect(readFileSync(join(workDir, "issue-4565-static-path.txt"), "utf-8")).toBe("after");
    expect(readFileSync(join(workDir, "issue-4565-any.txt"), "utf-8")).toBe("any-data");
    expect(readFileSync(join(workDir, "issue-4565-order.txt"), "utf-8")).toBe("pd");
    expect(readFileSync(join(workDir, "issue-4565-options-order.txt"), "utf-8")).toBe("pdo");
  });

  test("matches literal UTF-8 for multibyte text and unmatched surrogates", async () => {
    await compileAndRun(UNICODE_PARITY);
    const dynamic = readFileSync(join(workDir, "issue-4565-dynamic-unicode.txt"));
    const literal = readFileSync(join(workDir, "issue-4565-static-unicode.txt"));
    expect(dynamic).toEqual(literal);
    expect(dynamic).toEqual(Buffer.from("snowman:☃ emoji:😀 lone:\ufffd", "utf-8"));
  });

  test("throws a catchable TypeError for a runtime non-string", async () => {
    await compileAndRun(STRICT_STRING_ERROR);
    expect(existsSync(join(workDir, "issue-4565-must-not-exist.txt"))).toBe(false);
    expect(readFileSync(join(workDir, "issue-4565-caught.txt"), "utf-8")).toBe("yes");
    expect(existsSync(join(workDir, "issue-4565-under-supplied.txt"))).toBe(false);
    expect(readFileSync(join(workDir, "issue-4565-missing-caught.txt"), "utf-8")).toBe("yes");
    expect(readFileSync(join(workDir, "issue-4565-validation-order.txt"), "utf-8")).toBe("do");
  });

  test("does not hijack a lexical shadow of the imported binding", async () => {
    await compileAndRun(SHADOWED_WRITE_FILE_SYNC);
    expect(existsSync(join(workDir, "issue-4565-shadow-must-not-exist.txt"))).toBe(false);
    expect(readFileSync(join(workDir, "issue-4565-shadow-called.txt"), "utf-8")).toBe("yes");
  });

  test("re-reads the dynamic helper index after a late host import shift", async () => {
    const r = await compile(
      'import { writeFileSync } from "node:fs"; const box: any = { value: "late" }; writeFileSync("late.txt", box.value);',
      { fileName: "test.ts", target: "wasi", strictNoHostImports: false },
    );
    expect(r.success).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(r.binary))).toContainEqual({
      module: "env",
      name: "__extern_get",
      kind: "function",
    });
  });

  test.each(["chmodSync", "renameSync", "watch"])("rejects unsupported node:fs member %s", async (member) => {
    const r = await compile(`import { ${member} } from "node:fs"; ${member}("x", "y");`, {
      fileName: "test.ts",
      target: "wasi",
    });
    expect(r.success).toBe(false);
    expect(r.errors?.map((error) => error.message).join("\n")).toContain("not available in WASI target");
  });

  test("retains the precise no-provider error for a known path-based member", async () => {
    const r = await compile('import { appendFileSync } from "node:fs"; appendFileSync("x", "y");', {
      fileName: "test.ts",
      target: "wasi",
    });
    expect(r.success).toBe(false);
    expect(r.errors?.map((error) => error.message).join("\n")).toContain("needs a filesystem provider");
  });

  test("rejects a mixed supported and unsupported node:fs import", async () => {
    const r = await compile(
      'import { writeFileSync, chmodSync } from "node:fs"; writeFileSync("x", "y"); chmodSync("x", 420);',
      { fileName: "test.ts", target: "wasi" },
    );
    expect(r.success).toBe(false);
    expect(r.errors?.map((error) => error.message).join("\n")).toContain("not available in WASI target");
  });

  test.each([
    ["writeFileSync", "const alias = writeFileSync; alias('x', 'y');"],
    ["appendFileSync", "const alias = appendFileSync; alias('x', 'y');"],
  ])("rejects first-class use of node:fs binding %s", async (member, body) => {
    const r = await compile(`import { ${member} } from "node:fs"; ${body}`, {
      fileName: "test.ts",
      target: "wasi",
    });
    expect(r.success).toBe(false);
    expect(r.errors?.map((error) => error.message).join("\n")).toContain("first-class aliases are unavailable");
  });

  test.each([
    ["writeFileSync as wf", "wf('x', 'y');"],
    ["chmodSync as writeFileSync", "writeFileSync('x', 'y');"],
  ])("fails closed for aliased node:fs import %s", async (binding, body) => {
    const r = await compile(`import { ${binding} } from "node:fs"; ${body}`, {
      fileName: "test.ts",
      target: "wasi",
    });
    expect(r.success).toBe(false);
    expect(r.errors?.map((error) => error.message).join("\n")).toContain("not available in WASI target");
  });
});
