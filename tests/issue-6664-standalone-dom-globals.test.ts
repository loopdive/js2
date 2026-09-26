// #6664 — lib.dom-only globals leaked `env::` host imports into a standalone
// binary: `performance.now()` (env.Performance_now), react's `enqueueTask`
// MessageChannel fallback (env.MessageChannel_new + 4 port imports),
// `new window.ErrorEvent(...)` (env.ErrorEvent_new) and `queueMicrotask(cb)`
// (env.queueMicrotask). A standalone module may import nothing, so a module
// that merely CONTAINED such code could not be instantiated host-free.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";

async function compileProjectFiles(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "issue-6664-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const result = await compileProject(join(dir, "main.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
  return { module, imports };
}

async function run(module: WebAssembly.Module) {
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

// 0 = no throw, 1 = ReferenceError, 2 = TypeError, 3 = anything else
const CLASSIFY = `function classify(e) { return e instanceof ReferenceError ? 1 : e instanceof TypeError ? 2 : 3; }`;

describe("#6664 — lib.dom globals stay host-free under --target standalone", () => {
  it("performance.now() lowers to the standalone time origin, not env.Performance_now", async () => {
    const { module, imports } = await compileProjectFiles({
      "timing.js": `export function stamp(info) { info.start = info.end = performance.now(); return info; }`,
      "main.js": `
import { stamp } from "./timing.js";
export function test() {
  var info = stamp({ start: -1, end: -1 });
  var later = performance.now();
  return (info.start === 0 ? 1 : 0) + (info.end === info.start ? 10 : 0) + (later >= info.end ? 100 : 0);
}
`,
    });
    expect(imports).toEqual([]);
    expect((await run(module)).test()).toBe(111);
  });

  it("react's MessageChannel enqueueTask fallback compiles host-free and throws ReferenceError when reached", async () => {
    const { module, imports } = await compileProjectFiles({
      "enqueue.js": `
var warned = false;
export function enqueueTask(callback) {
  if (!warned) { warned = true; if ("undefined" === typeof MessageChannel) warned = "missing"; }
  var channel = new MessageChannel();
  channel.port1.onmessage = callback;
  channel.port2.postMessage(void 0);
  return warned;
}
export function readPort() { return MessagePort; }
`,
      "main.js": `
import { enqueueTask, readPort } from "./enqueue.js";
${CLASSIFY}
export function pure(x) { return x + 1; }
export function typeofs() {
  return (typeof MessageChannel === "undefined" ? 1 : 0) + (typeof MessagePort === "undefined" ? 10 : 0) +
    (typeof ErrorEvent === "undefined" ? 100 : 0);
}
export function callEnqueue() { try { enqueueTask(function () {}); return 0; } catch (e) { return classify(e); } }
export function callRead() { try { readPort(); return 0; } catch (e) { return classify(e); } }
`,
    });
    expect(imports).toEqual([]);
    const exports = await run(module);
    expect(exports.pure(41)).toBe(42);
    expect(exports.typeofs()).toBe(111);
    expect(exports.callEnqueue()).toBe(1);
    expect(exports.callRead()).toBe(1);
  });

  it("a window-guarded new window.ErrorEvent(...) needs no env.ErrorEvent_new", async () => {
    const { module, imports } = await compileProjectFiles({
      "report.js": `
export function report(error) {
  if ("object" === typeof window && "function" === typeof window.ErrorEvent) {
    return window.dispatchEvent(new window.ErrorEvent("error", { error: error }));
  }
  return 7;
}
`,
      "main.js": `import { report } from "./report.js"; export function test() { return report(1) === 7 ? 1 : 0; }`,
    });
    expect(imports).toEqual([]);
    expect((await run(module)).test()).toBe(1);
  });

  it("queueMicrotask with a parameter callback enqueues on the module's own microtask queue", async () => {
    const { module, imports } = await compileProjectFiles({
      "micro.js": `
export function queueSeveralMicrotasks(callback) {
  queueMicrotask(function () {
    return queueMicrotask(callback);
  });
}
`,
      "main.js": `
import { queueSeveralMicrotasks } from "./micro.js";
${CLASSIFY}
var log = 0;
export function schedule() {
  queueSeveralMicrotasks(function () { log = log * 10 + 2; });
  queueMicrotask(function () { log = log * 10 + 1; });
  return log;
}
export function read() { return log; }
export function missing() { try { queueMicrotask(); return 0; } catch (e) { return classify(e); } }
`,
    });
    expect(imports).toEqual([]);
    const exports = await run(module);
    expect(exports.schedule()).toBe(0); // nothing runs synchronously
    (exports.__drain_microtasks as () => void)();
    expect(exports.read()).toBe(12); // the direct job first, the re-queued one after
    expect(exports.missing()).toBe(2);
  });

  it("control: user bindings with the same names keep their own semantics", async () => {
    const { module, imports } = await compileProjectFiles({
      "user.js": `
export class MessageChannel { constructor() { this.port1 = 4; } }
export var performance = { now: function () { return 5; } };
`,
      "main.js": `
import { MessageChannel, performance } from "./user.js";
export function test() { return new MessageChannel().port1 * 10 + performance.now(); }
`,
    });
    expect(imports).toEqual([]);
    expect((await run(module)).test()).toBe(45);
  });
});
