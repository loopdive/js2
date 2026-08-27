import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileStandalone(source: string) {
  const result = await compile(source, {
    allowJs: true,
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  if (!result.success || result.errors.some((error) => error.severity === "error")) {
    throw new Error(result.errors.map((error) => error.message).join("\n"));
  }
  return result.binary;
}

async function runInit(binary: Uint8Array) {
  const { instance } = await WebAssembly.instantiate(binary, {});
  const exports = instance.exports as Record<string, CallableFunction>;
  exports.__module_init?.();
}

async function runHostInit(source: string) {
  const result = await compile(source, {
    allowJs: true,
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  if (!result.success || result.errors.some((error) => error.severity === "error")) {
    throw new Error(result.errors.map((error) => error.message).join("\n"));
  }
  const imports = buildImports(result.imports, { console }, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
}

describe("#3966 — update expressions persist on sloppy implicit globals", () => {
  it("writes postfix ++ through the realm global object from a closure", async () => {
    const binary = await compileStandalone(`
this.position = 0;
(function () { position++; })();
if (position !== 1) throw new Error("position");
`);
    await expect(runInit(binary)).resolves.toBeUndefined();
  });

  it("preserves postfix-old and prefix-new results", async () => {
    const binary = await compileStandalone(`
this.up = 4;
var old = up++;
this.down = 4;
var next = --down;
if (old !== 4 || up !== 5) throw new Error("postfix");
if (next !== 3 || down !== 3) throw new Error("prefix");
`);
    await expect(runInit(binary)).resolves.toBeUndefined();
  });

  it("writes numeric compound assignment through the realm global object", async () => {
    const binary = await compileStandalone(`
this.total = 1;
total += 2;
if (total !== 3) throw new Error("numeric compound assignment");
`);
    await expect(runInit(binary)).resolves.toBeUndefined();
  });

  it("preserves string += semantics on an implicit-global accumulator", async () => {
    const binary = await compileStandalone(`
this.text = "";
for (var i = 0; i < 2; i++) text += i;
if (text !== "01") throw new Error("string compound assignment");
`);
    await expect(runInit(binary)).resolves.toBeUndefined();
  });

  it("keeps update and compound write-back aligned in the host lane", async () => {
    await expect(
      runHostInit(`
this.value = 0;
(function () { value++; })();
value += 2;
if (value !== 3) throw new Error("host write-back");
`),
    ).resolves.toBeUndefined();
  });
});
