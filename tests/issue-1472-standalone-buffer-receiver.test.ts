// #1472 — `Buffer.isBuffer(x)` (combined-stream's `isStreamLike`, reached from
// axios's form-data) refused the whole standalone compile: `Buffer` is in
// BUILTIN_CLASS_NAMES for the JS-host lane (#1793), whose generic
// static-method arm resolves the receiver through `__get_builtin("Buffer")` —
// a host import `--target standalone` refuses. A standalone module has no
// `Buffer`, so the receiver is an ordinary reference to an unresolvable name:
// `ReferenceError: Buffer is not defined`, thrown before any argument runs.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";

async function compileProjectFiles(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "issue-1472-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const result = await compileProject(join(dir, "main.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  return WebAssembly.compile(result.binary);
}

async function run(module: WebAssembly.Module) {
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

describe("#1472 — `Buffer.m(...)` receiver under --target standalone", () => {
  it("combined-stream's isStreamLike compiles host-free; Buffer is not defined", async () => {
    const module = await compileProjectFiles({
      "combined.js": `
export function isStreamLike(stream) {
  return (typeof stream !== 'function')
    && (typeof stream !== 'string')
    && (typeof stream !== 'boolean')
    && (typeof stream !== 'number')
    && (!Buffer.isBuffer(stream));
}
`,
      "main.js": `
import { isStreamLike } from "./combined.js";
export function shortCircuit() { return isStreamLike("x") ? 1 : 0; }
export function reached() {
  var n = 0;
  try { Buffer.isBuffer(n++); return 10; }
  catch (e) { return (e instanceof ReferenceError ? 1 : 2) + (n === 0 ? 0 : 20) + (e.message === "Buffer is not defined" ? 0 : 40); }
}
export function reachedViaModule() { try { isStreamLike({}); return 10; } catch (e) { return e instanceof ReferenceError ? 1 : 2; } }
export function noArgs() { try { Buffer.alloc(); return 10; } catch (e) { return e instanceof ReferenceError ? 1 : 2; } }
export function typeofBuffer() { return typeof Buffer === "undefined" ? 1 : 0; }
`,
    });
    const exports = await run(module);
    expect(exports.shortCircuit()).toBe(0);
    expect(exports.reached()).toBe(1);
    expect(exports.reachedViaModule()).toBe(1);
    expect(exports.noArgs()).toBe(1);
    expect(exports.typeofBuffer()).toBe(1);
  });

  it("an ambient `Buffer` (--emulate node) is still unavailable in a host-free module", async () => {
    const result = await compile(
      `export function call(): number { try { return Buffer.isBuffer(3) ? 10 : 20; } catch (e) { return e instanceof ReferenceError ? 1 : 2; } }
export function from(): number { try { return Buffer.from("x").length + 10; } catch (e) { return e instanceof ReferenceError ? 1 : 2; } }
export function typeofBuffer(): number { return typeof Buffer === "undefined" ? 1 : 0; }`,
      { target: "standalone", emulateNode: true } as Parameters<typeof compile>[1],
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const exports = await run(await WebAssembly.compile(result.binary));
    expect(exports.call()).toBe(1);
    expect(exports.from()).toBe(1);
    expect(exports.typeofBuffer()).toBe(1);
  });

  it("control: a user-declared `Buffer` keeps its own binding", async () => {
    const module = await compileProjectFiles({
      "main.js": `
var Buffer = { isBuffer: function (x) { return x === 5; } };
export function test() { return (Buffer.isBuffer(5) ? 1 : 0) + (Buffer.isBuffer(4) ? 10 : 0); }
`,
    });
    expect((await run(module)).test()).toBe(1);
  });
});
