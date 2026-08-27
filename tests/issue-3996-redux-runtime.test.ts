import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, compileProject } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fileName = "redux-shape.js"): Promise<Record<string, WebAssembly.ExportValue>> {
  const result = await compile(source, {
    fileName,
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
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

  it("invokes closure values retained in a Map during forEach", async () => {
    const exports = await run(`
      function makeStore() {
        const listeners = new Map();
        return {
          subscribe(listener) { listeners.set(0, listener); },
          dispatch() {
            let visits = 0;
            listeners.forEach((listener) => { visits++; listener(); });
            return visits;
          },
        };
      }

      export function test() {
        let calls = 0;
        const store = makeStore();
        store.subscribe(function listener() { calls++; });
        return store.dispatch() * 10 + calls;
      }
    `);
    expect((exports.test as () => number)()).toBe(11);
  });

  it("keeps a variable-held closure callable after Map storage", async () => {
    const exports = await run(`
      export function test() {
        let calls = 0;
        const listeners = new Map();
        const listener = function listener() { calls++; };
        listeners.set(0, listener);
        listeners.forEach((retained) => retained());
        return calls;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
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

  it("retains destructured callable parameters in a linked middleware closure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-redux-middleware-capture-"));
    try {
      writeFileSync(
        join(dir, "store.js"),
        `export function dispatch(action) { return action; }
export function getState() { return []; }
export function createStore(reducer) {
  let currentState = reducer(void 0, { type: "@@INIT" });
  const store = {
    dispatch(action) { currentState = reducer(currentState, action); return action; },
    getState() { return currentState; },
  };
  return store;
}
export function applyMiddleware(middleware) {
  return (createStore2) => (reducer) => {
    const store = createStore2(reducer);
    let dispatch = () => { throw new Error("early"); };
    const middlewareAPI = {
      getState: store.getState,
      dispatch: (action) => dispatch(action),
    };
    const chain = middleware(middlewareAPI);
    dispatch = chain(store.dispatch);
    return { ...store, dispatch };
  };
}
`,
      );
      writeFileSync(
        join(dir, "entry.js"),
        `import { applyMiddleware, createStore } from "./store.js";
const thunk = ({ dispatch, getState }) => next => action =>
  typeof action === "function" ? action(dispatch, getState) : next(action);
function reducer(state = [], action) { return action.type === "ADD" ? [...state, action.value] : state; }
function add(value) { return (dispatch, getState) => getState().length === 0 ? dispatch({ type: "ADD", value }) : 0; }
export function test() {
  const store = applyMiddleware(thunk)(createStore)(reducer);
  store.dispatch(add(1));
  return store.getState().length;
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
      expect((instance.exports.test as () => number)()).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("materializes a compiled namespace member when it is passed as a function value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-redux-namespace-value-"));
    try {
      writeFileSync(join(dir, "reducers.js"), `export function reducer(left, right) { return left + right; }\n`);
      writeFileSync(
        join(dir, "entry.js"),
        `import * as reducers from "./reducers.js";
function invoke(reducer) { return reducer(20, 22); }
export function test() { return invoke(reducers.reducer); }
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
      expect((instance.exports.test as () => number)()).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calls a namespace-imported reducer retained by a nested dispatch closure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-redux-retained-reducer-"));
    try {
      writeFileSync(
        join(dir, "reducers.js"),
        `export function reducer(state = [], action) { return action.type === "INIT" ? [42] : state; }\n`,
      );
      writeFileSync(
        join(dir, "store.js"),
        `function isPlainObject(obj) {
  if (typeof obj !== "object" || obj === null) return false;
  let proto = obj;
  while (Object.getPrototypeOf(proto) !== null) proto = Object.getPrototypeOf(proto);
  return Object.getPrototypeOf(obj) === proto || Object.getPrototypeOf(obj) === null;
}
export function createStore(reducer, preloadedState) {
  let currentReducer = reducer;
  let currentState = preloadedState;
  function dispatch(action) {
    if (!isPlainObject(action)) throw new Error("not plain");
    if (typeof action.type === "undefined") throw new Error("missing type");
    if (typeof action.type !== "string") throw new Error("bad type");
    currentState = currentReducer(currentState, action);
    return currentState;
  }
  dispatch({ type: "INIT" });
  return currentState;
}
`,
      );
      writeFileSync(
        join(dir, "entry.js"),
        `import { createStore } from "./store.js";
import * as reducers from "./reducers.js";
export function test() { return createStore(reducers.reducer).length === 1 ? 42 : 0; }
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
      expect((instance.exports.test as () => number)()).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("materializes a stable enumerable namespace object for compiled function exports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-redux-namespace-object-"));
    try {
      writeFileSync(
        join(dir, "reducers.js"),
        `export function first(left, right) { return left + right; }
export function second(left, right) { return left + right; }
`,
      );
      writeFileSync(
        join(dir, "entry.js"),
        `import * as reducers from "./reducers.js";
function collect(namespace) {
  const keys = Object.keys(namespace);
  return keys.length * 100 + namespace[keys[0]](20, 1) + namespace[keys[1]](20, 2);
}
export function test() {
  return (reducers === reducers ? 1000 : 0) + collect(reducers);
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
      expect((instance.exports.test as () => number)()).toBe(1243);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dynamically calls a namespace reducer read into a local", async () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-redux-namespace-dynamic-call-"));
    try {
      writeFileSync(
        join(dir, "reducers.js"),
        `export function todos(state = [], action) {
  return action.type === "ADD" ? [...state, 1] : state;
}
`,
      );
      writeFileSync(
        join(dir, "combine.js"),
        `export function assertReducerShape(reducers) {
  Object.keys(reducers).forEach((key) => {
    const reducer = reducers[key];
    const initialState = reducer(void 0, { type: "INIT" });
    if (initialState.length !== 0) throw new Error("bad initial state");
  });
}
`,
      );
      writeFileSync(
        join(dir, "entry.js"),
        `import { assertReducerShape } from "./combine.js";
import * as reducers from "./reducers.js";
export function test() {
  assertReducerShape(reducers);
  return reducers.todos(void 0, { type: "ADD" }).length;
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
      expect((instance.exports.test as () => number)()).toBe(1);
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

  it("keeps structural closure parameters open across dynamic calls", async () => {
    const exports = await run(
      `
        type IncrementAction = { type: "increment" };

        function callFromObject(reducers: any) {
          return reducers.counter(0, { type: "probe" });
        }

        const counter = (state: number = 0, action: IncrementAction) =>
          action.type === "increment" ? state + 1 : state;

        export function test() {
          return callFromObject({ counter });
        }
      `,
      "redux-structural-action.ts",
    );
    expect((exports.test as () => number)()).toBe(0);
  });

  it("calls an untyped JavaScript function returned by another call", async () => {
    const exports = await run(`
      function select(fn) { return fn; }
      export function test() {
        const square = (value) => value * value;
        return select(square)(5);
      }
    `);
    expect((exports.test as () => number)()).toBe(25);
  });

  it("packs positional arguments for an earlier capturing rest-closure instance", async () => {
    const exports = await run(`
      function compose(...funcs) {
        if (funcs.length === 0) return (arg) => arg;
        if (funcs.length === 1) return funcs[0];
        return funcs.reduce((a, b) => (...args) => a(b(...args)));
      }

      export function test() {
        const double = (value) => value * 2;
        const square = (value) => value * value;
        const composed = compose(double, square, double);
        return composed(5);
      }
    `);
    expect((exports.test as () => number)()).toBe(200);
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
