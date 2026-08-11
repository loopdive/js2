import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, compileProject } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<Record<string, WebAssembly.ExportValue>> {
  const result = await compile(source, {
    fileName: "redux-shape.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return instance.exports;
}

describe("#3996 Redux runtime callable dispatch", () => {
  it("keeps an escaped reducer's implicit-any object parameter dynamic", async () => {
    const exports = await run(`
      function reducer(state = 0, action) {
        return action.type === "increment" ? state + action.amount : state;
      }

      export function test() {
        // This direct call is useful evidence, but it is not the reducer's
        // complete runtime domain once the function escapes through an object.
        reducer(void 0, { type: "init" });
        const reducers = {};
        reducers.counter = reducer;
        return reducers.counter(5, { type: "increment", amount: 7 });
      }
    `);
    expect((exports.test as () => number)()).toBe(12);
  });

  it("keeps mutable captures live for retained subscribe callbacks", async () => {
    const exports = await run(`
      function makeStore() {
        let subscriber;
        return {
          subscribe(fn) { subscriber = fn; return function unsubscribe() {}; },
          emit() { subscriber(); },
        };
      }

      export function test() {
        let observed = -1;
        const concreteStore = makeStore();
        /** @type {any} */
        const store = concreteStore;
        store.subscribe(function listener() { observed = 7; });
        store.emit();
        return observed;
      }
    `);
    expect((exports.test as () => number)()).toBe(7);
  });

  it("emits the two-argument closure bridge in a multi-module project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-redux-closure-"));
    try {
      writeFileSync(
        join(dir, "invoke.js"),
        `export function invoke(holder, left, right) { return holder.fn(left, right); }\n`,
      );
      writeFileSync(
        join(dir, "entry.js"),
        `import { invoke } from "./invoke.js";
function add(left, right) { return left + right; }
export function test() {
  const holder = {};
  holder.fn = add;
  return invoke(holder, 20, 22);
}
`,
      );

      const result = await compileProject(join(dir, "entry.js"), {
        allowJs: true,
        skipSemanticDiagnostics: true,
        target: "gc",
        platform: "node",
      });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      const imports = result.importObject ?? buildImports(result.imports, undefined, result.stringPool);
      const instance = await WebAssembly.instantiate(module, imports);
      imports.__setInstance?.(instance);
      expect(typeof instance.exports.__call_fn_2).toBe("function");
      expect((instance.exports.test as () => number)()).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("materializes a host Object.keys result before Array.filter", async () => {
    const exports = await run(`
      function retainedKeyCount(object) {
        return Object.keys(object).filter((key) => key !== "skip").length;
      }

      export function test() {
        return retainedKeyCount({ first: 1, skip: 2, second: 3 });
      }
    `);
    expect((exports.test as () => number)()).toBe(2);
  });

  it("preserves the length of a materialized host Object.keys result", async () => {
    const exports = await run(`
      function countKeys(object) {
        const keys = Object.keys(object);
        return keys.length;
      }

      export function test() {
        return countKeys({ first: 1, second: 2 });
      }
    `);
    expect((exports.test as () => number)()).toBe(2);
  });

  it("enumerates dynamically assigned reducer properties", async () => {
    const exports = await run(`
      function collect(reducers) {
        const selected = {};
        const keys = Object.keys(reducers);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (typeof reducers[key] === "function") selected[key] = reducers[key];
        }
        const selectedKeys = Object.keys(selected);
        return selectedKeys.length * 100 + selected.first(20, 1) + selected.second(20, 2);
      }

      export function test() {
        return collect({ first: (a, b) => a + b, second: (a, b) => a + b });
      }
    `);
    expect((exports.test as () => number)()).toBe(243);
  });

  it("recognizes a compiled closure passed through an untyped parameter", async () => {
    const exports = await run(`
      function acceptsReducer(reducer) {
        if (typeof reducer === "object") return -1;
        if (typeof reducer !== "function") return 0;
        return reducer(20, 22);
      }

      export function test() {
        const reducer = (left, right) => left + right;
        return acceptsReducer(reducer);
      }
    `);
    expect((exports.test as () => number)()).toBe(42);
  });

  it("calls a reducer read from an object by a dynamic key", async () => {
    const exports = await run(`
      function counter(state = 0, action) {
        return action.type === "increment" ? state + action.amount : state;
      }

      function flag(state = false, action) {
        return action.type === "toggle" ? !state : state;
      }

      function assertReducerShape(reducers) {
        let invalid = 0;
        Object.keys(reducers).forEach((key) => {
          const reducer = reducers[key];
          const initialState = reducer(void 0, { type: "@@redux/INIT" });
          if (typeof initialState === "undefined") invalid = 1;
          const probedState = reducer(void 0, { type: "@@redux/PROBE" });
          if (typeof probedState === "undefined") invalid = 2;
        });
        return invalid;
      }

      export function test() {
        const reducers = { counter, flag };
        return assertReducerShape(reducers);
      }

    `);
    expect((exports.test as () => number)()).toBe(0);
  });

  it("builds combined state through dynamic object writes", async () => {
    const exports = await run(`
      function counter(state = 0, action) {
        return action.type === "increment" ? state + action.amount : state;
      }
      function flag(state = false, action) {
        return action.type === "toggle" ? !state : state;
      }

      function combine(reducers) {
        const keys = Object.keys(reducers);
        return function combination(state = {}, action) {
          const nextState = {};
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const reducer = reducers[key];
            const previous = state[key];
            const next = reducer(previous, action);
            nextState[key] = next;
          }
          return nextState;
        };
      }

      export function test() {
        const root = combine({ counter, flag });
        const state = root(void 0, { type: "increment", amount: 2 });
        const keysOk = Object.keys(state).length === 2;
        const counterOk = state.counter === 2;
        const flagOk = state.flag === false;
        return (keysOk ? 100 : 0) + (counterOk ? 10 : 0) + (flagOk ? 1 : 0);
      }
    `);
    expect((exports.test as () => number)()).toBe(111);
  });
});
