// #6671 — in a host-free `--target standalone` module, `console` read as a
// VALUE lowered to `ref.null.extern`, so react's module-init feature test
// `console.createTask ? console.createTask : function () { … }` threw
// `TypeError: Cannot access property on null or undefined`. `console` is now a
// real object: log/warn/error/info/debug are callables writing to the same
// host-free stdout sink as direct `console.log(...)` calls, and every other
// member (`createTask`) reads undefined.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";

async function runProject(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "issue-6671-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const result = await compileProject(join(dir, "main.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return {
    imports: WebAssembly.Module.imports(module),
    exports: instance.exports as Record<string, () => number>,
  };
}

/** Single-file standalone compile, returning what the host-free stdout sink captured. */
async function standaloneStdout(source: string): Promise<{ stdout: string; importCount: number }> {
  const r = await compile(source, { fileName: "main.js", target: "standalone", hostBridge: "always" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance, module } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, unknown>;
  (ex.__module_init as (() => void) | undefined)?.();
  (ex.main as () => void)();
  const prepare = ex.__stdout_prepare as () => number;
  const charAt = ex.__stdout_char as (i: number) => number;
  const len = prepare();
  let stdout = "";
  for (let i = 0; i < len; i++) stdout += String.fromCharCode(charAt(i));
  return { stdout, importCount: WebAssembly.Module.imports(module).length };
}

describe("#6671 — standalone `console` is a host-free object", () => {
  it("react's console.createTask feature test takes its fallback instead of throwing", async () => {
    const { imports, exports } = await runProject({
      "task.js": `
var createTask = console.createTask ? console.createTask : function () { return null; };
export function probe() {
  try { return createTask("x") === null ? 0 : 5; }
  catch (e) { return e instanceof TypeError ? 2 : 3; }
}
`,
      "main.js": `import { probe } from "./task.js";\nexport function test() { return probe(); }\n`,
    });
    expect(imports).toEqual([]);
    expect(exports.test!()).toBe(0);
  });

  it("known members are identity-stable functions, unknown members are undefined", async () => {
    const { exports } = await runProject({
      "shape.js": `
export function shape() {
  var n = 0;
  if (typeof console === "object" && console !== null) n += 1;
  if (typeof console.log === "function") n += 10;
  if (typeof console.error === "function" && typeof console.debug === "function") n += 100;
  if (console.createTask === undefined && !("createTask" in console)) n += 1000;
  if (console.log === console.log && console === console) n += 10000;
  if (console.log !== console.error) n += 100000;
  return n;
}
`,
      "main.js": `import { shape } from "./shape.js";\nexport function test() { return shape(); }\n`,
    });
    expect(exports.test!()).toBe(111111);
  });

  it("method values print every argument through the stdout sink, however they are called", async () => {
    const { stdout, importCount } = await standaloneStdout(`
function run(cb) { cb("callback", 3); }
export function main() {
  var log = console.log;
  log("alias", 1, true);
  var c = console;
  c.warn("method", "call");
  var err = c.error;
  err.call(c, "via %s", "call");
  err.apply(c, ["via", "apply"]);
  run(console.info);
  log();
}
`);
    expect(importCount).toBe(0);
    expect(stdout).toBe("alias 1 true\nmethod call\nvia %s call\nvia apply\ncallback 3\n\n");
  });

  it("a user binding named console keeps its own value", async () => {
    const { exports } = await runProject({
      "shadow.js": `
export function shadowed(console) { return console.tag; }
export function local() { var console = { tag: 7 }; var c = console; return c.tag; }
`,
      "main.js": `import { shadowed, local } from "./shadow.js";\nexport function test() { return shadowed({ tag: 40 }) + local(); }\n`,
    });
    expect(exports.test!()).toBe(47);
  });
});
