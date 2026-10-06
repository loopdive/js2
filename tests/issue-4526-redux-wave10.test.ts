// (#4526) Redux upstream residuals — three generic compiler defects, each pinned
// by a two-file untyped fixture whose expected answer is computed by Node
// running the SAME files (so no expectation is hand-typed).
//
//   1. `actionCreator.apply(this, args)` — a runtime argument list was spread
//      as ZERO arguments, and a parameter named like another module's nested
//      function declaration was retargeted to that declaration.
//   2. A host-callback arrow capturing the `const` its own call initializes
//      (`const off = subscribe(() => off())`) snapshotted the TDZ hole.
//   3. An object literal with a runtime computed key (`[$$observable]() {}`)
//      returned through a typed slot was narrowed to a struct snapshot that
//      dropped the runtime-keyed member.
//   4. A bare `setImmediate(cb)` call had no binding at all.
//   5. The upstream harnesses' `toContain` idiom on a compiled array:
//      `typeof actual.includes` (an inherited Array.prototype member read
//      through a dynamic slot) answered "undefined", and a dynamic
//      `actual.includes(x)` bound DOM's `IDBKeyRange.includes`.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compileProject, instantiateLinkedProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

type Fixture = Record<string, string>;

async function settle(value: unknown): Promise<unknown> {
  return value && typeof (value as { then?: unknown }).then === "function" ? await value : value;
}

async function runBoth(files: Fixture, names: string[]): Promise<{ wasm: unknown[]; node: unknown[] }> {
  const dir = mkdtempSync(join(tmpdir(), "js2-4526-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const result = await compileProject(join(dir, "main.js"), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "web",
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = buildCompiledImports(result, {}, { dynamicCode: "hostEval" });
    const { instance } = result.linkedModules?.length
      ? await instantiateLinkedProject(result, imports)
      : await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    (imports as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
    (instance.exports.__module_init as (() => void) | undefined)?.();
    const wasm: unknown[] = [];
    for (const name of names) wasm.push(await settle((instance.exports[name] as () => unknown)()));
    const native = (await import(pathToFileURL(join(dir, "main.js")).href)) as Record<string, () => unknown>;
    const node: unknown[] = [];
    for (const name of names) node.push(await settle(native[name]!()));
    return { wasm, node };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#4526 Redux residual compiler defects", () => {
  it("applies a runtime argument list and resolves the parameter, not a same-named nested declaration", async () => {
    const { wasm, node } = await runBoth(
      {
        "package.json": `{"type":"module"}`,
        "lib.js": `
function bindOne(actionCreator, dispatch) {
  return function (...args) { return dispatch(actionCreator.apply(this, args)); };
}
export function bind(creators, dispatch) {
  if (typeof creators === "function") return bindOne(creators, dispatch);
  const out = {};
  for (const key in creators) {
    const actionCreator = creators[key];
    if (typeof actionCreator === "function") out[key] = bindOne(actionCreator, dispatch);
  }
  return out;
}
`,
        "main.js": `
import { bind } from "./lib.js";
function add(text) { return { type: "ADD", text }; }
const tests = [];
function it(body) { tests.push(body); }
it(() => {
  const bound = bind(add, (x) => x);
  return JSON.stringify(bound("Hello"));
});
it(() => {
  function actionCreator() { return { type: "UNK", self: this, args: [...arguments] }; }
  const bound = bind(actionCreator, (x) => x);
  const self = { q: 1 };
  const list = [1, 2, 3];
  return JSON.stringify(bound.apply(self, list)) + " " + JSON.stringify(actionCreator.apply(self, list));
});
it(() => JSON.stringify(bind({ add }, (x) => x).add("Hi")));
export function t1() { return tests[0](); }
export function t2() { return tests[1](); }
export function t3() { return tests[2](); }
`,
      },
      ["t1", "t2", "t3"],
    );
    // Anti-vacuity: the oracle really distinguishes the defect's two wrong
    // answers (the nested `actionCreator`'s shape, and an empty argument list).
    expect(node[0]).toBe('{"type":"ADD","text":"Hello"}');
    expect(String(node[1])).toContain('"args":[1,2,3]');
    expect(wasm).toEqual(node);
  });

  it("boxes a callback capture of the const its own call initializes", async () => {
    const { wasm, node } = await runBoth(
      {
        "package.json": `{"type":"module"}`,
        "lib.js": `
export function createStore() {
  let current = new Map();
  let next = current;
  let id = 0;
  function subscribe(listener) {
    if (next === current) next = new Map(current);
    const key = id++;
    next.set(key, listener);
    return function unsubscribe() {
      if (next === current) next = new Map(current);
      next.delete(key);
    };
  }
  function dispatch() { (current = next).forEach((listener) => listener()); }
  return { subscribe, dispatch };
}
`,
        "main.js": `
import { createStore } from "./lib.js";
// Two call-site shapes keep this a dynamic slot, as Redux's typed \`Store\` is
// to the compiled test: \`store.subscribe(cb)\` then passes a host callback.
function dynamic(value) { return value; }
dynamic(0);
export function t1() {
  const store = dynamic(createStore());
  const log = [];
  store.subscribe(() => log.push("A"));
  const unSubB = store.subscribe(() => { log.push("B"); unSubB(); });
  store.subscribe(() => log.push("C"));
  store.dispatch();
  store.dispatch();
  return log.join(",");
}
`,
      },
      ["t1"],
    );
    expect(node).toEqual(["A,B,C,A,C"]);
    expect(wasm).toEqual(node);
  });

  it("keeps a runtime computed key on an object literal returned through a typed slot", async () => {
    const { wasm, node } = await runBoth(
      {
        "package.json": `{"type":"module"}`,
        "lib.js": `
const $$observable = (() => (typeof Symbol === "function" && Symbol.observable) || "@@observable")();
export default $$observable;
export function createStore() {
  function observable() {
    return {
      subscribe(observer) { return { unsubscribe() {} }; },
      [$$observable]() { return this; },
    };
  }
  return { getState() { return 1; }, [$$observable]: observable };
}
`,
        "main.js": `
import $$observable, { createStore } from "./lib.js";
export function t1() {
  const obs = createStore()[$$observable]();
  const self = obs[$$observable];
  return typeof self + " " + String(self.call(obs) === obs) + " " + Object.keys(obs).join("|");
}
`,
      },
      ["t1"],
    );
    expect(node).toEqual(["function true subscribe|@@observable"]);
    expect(wasm).toEqual(node);
  });

  it("schedules a bare setImmediate callback", async () => {
    const { wasm, node } = await runBoth(
      {
        "package.json": `{"type":"module"}`,
        "lib.js": `
export function later(text) {
  return new Promise((resolve) => setImmediate(() => resolve(text + "!")));
}
`,
        "main.js": `
import { later } from "./lib.js";
export function t1() { return later("x"); }
`,
      },
      ["t1"],
    );
    expect(node).toEqual(["x!"]);
    expect(wasm).toEqual(node);
  });

  it("supports the toContain idiom (typeof + call of includes) on a compiled array in a dynamic slot", async () => {
    const { wasm, node } = await runBoth(
      {
        "package.json": `{"type":"module"}`,
        "main.js": `
function toContain(actual, expected) {
  if (actual == null || typeof actual.includes !== "function" || !actual.includes(expected)) return "miss";
  return "hit " + typeof actual.length + " " + typeof actual.nope;
}
export function t1() { return toContain(["a", "b"], "b"); }
export function t2() { return toContain(Object.keys({ x: 1, y: 2 }).filter((k) => k !== "z"), "y"); }
// A string call site widens actual to a dynamic slot: includes must then
// dispatch on the runtime receiver, not bind DOM's IDBKeyRange.includes.
export function t3() { return toContain("abc", "b"); }
`,
      },
      ["t1", "t2", "t3"],
    );
    expect(node).toEqual(["hit number undefined", "hit number undefined", "hit number undefined"]);
    expect(wasm).toEqual(node);
  });
});
