// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { compile } from "../src/index.js";

const EXNREF_RUNNER = String.raw`
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const module = new WebAssembly.Module(Buffer.concat(chunks));
  const imports = WebAssembly.Module.imports(module);
  const calls = [];
  const importObject = {};
  for (const descriptor of imports) {
    importObject[descriptor.module] ??= {};
    importObject[descriptor.module][descriptor.name] = (...args) => {
      calls.push(descriptor.module + "::" + descriptor.name + "(" + args.length + ")");
      return null;
    };
  }
  const instance = await WebAssembly.instantiate(module, importObject);
  instance.exports.__module_init();
  process.stdout.write(JSON.stringify({ value: instance.exports.test(), imports, calls }));
`;

async function runStandaloneJs(source: string): Promise<{
  value: number;
  imports: WebAssembly.ModuleImportDescriptor[];
  calls: string[];
}> {
  const result = await compile(source, {
    target: "standalone",
    platform: "deno",
    fileName: "bootstrap.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

  const child = spawnSync(
    process.execPath,
    ["--experimental-wasm-exnref", "--input-type=module", "--eval", EXNREF_RUNNER],
    { input: result.binary, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  expect(child.status, child.stderr || child.stdout).toBe(0);
  return JSON.parse(child.stdout) as {
    value: number;
    imports: WebAssembly.ModuleImportDescriptor[];
    calls: string[];
  };
}

describe("#4376 — Deno primordials standalone runtime substrate", () => {
  it("materializes a function that captures a buffer-backed typed-array view", async () => {
    const result = await runStandaloneJs(`
      let observed = 0;
      (() => {
        const words = new Uint32Array(2);
        const bytes = new Uint8Array(words.buffer);
        function readLengths() {
          return bytes.length * 5 + words.length;
        }
        const published = Object.assign({}, { readLengths });
        observed = typeof published.readLengths === "function" ? 42 : 0;
      })();
      export function test() { return observed; }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("boxes Int32Array storage when a dynamic closure destructures its parameter", async () => {
    const result = await runStandaloneJs(`
      let observed = 0;
      const values = new Int32Array(1);
      values[0] = 42;
      const consume = function ([value]) {
        observed = value;
      };
      /** @type {any} */
      const dynamicConsume = consume;
      dynamicConsume(values);
      export function test() { return observed; }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("preserves heterogeneous object entries through callback destructuring", async () => {
    const result = await runStandaloneJs(`
      let observed = 0;
      [
        { name: "TypedArray", original: Reflect.getPrototypeOf(Uint8Array) },
        {
          name: "ArrayIterator",
          original: {
            prototype: Reflect.getPrototypeOf(Array.prototype[Symbol.iterator]()),
          },
        },
      ].forEach(({ name, original }) => {
        if (name === "TypedArray" && original.prototype) observed = 42;
      });
      export function test() { return observed; }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("invokes Object.assign after capture through a primordials carrier", async () => {
    const result = await runStandaloneJs(`
      const primordials = { ObjectAssign: Object.assign };
      const { ObjectAssign } = primordials;
      /** @type {any} */
      const assigned = ObjectAssign({}, { value: 42 });
      /** @returns {number} */
      export function test() { return assigned.value; }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("invokes Object.assign after loading it from an any-typed bootstrap carrier", async () => {
    const result = await runStandaloneJs(`
      /** @type {any} */
      const bootstrap = { primordials: { ObjectAssign: Object.assign } };
      /** @type {any} */
      const global = globalThis;
      global.__bootstrap = bootstrap;
      const { ObjectAssign } = global.__bootstrap.primordials;
      /** @type {any} */
      const target = {};
      const assigned = ObjectAssign(target, { value: 42 });
      /** @returns {number} */
      export function test() { return assigned.value; }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("keeps a nested object open when an any-typed primordial publishes it", async () => {
    const result = await runStandaloneJs(`
      /** @type {any} */
      const ObjectAssign = Object.assign;
      const infra = { value: 42 };
      /** @type {any} */
      const global = globalThis;
      ObjectAssign(global, { __infra: infra });
      /** @returns {number} */
      export function test() {
        return global.__infra === infra && global.__infra.value === 42 ? 42 : 0;
      }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("discovers and invokes Object statics through the computed realm-global carrier", async () => {
    const result = await runStandaloneJs(`
      /** @type {any} */
      const global = globalThis;
      /** @type {any} */
      let ObjectAssign;
      /** @type {any} */
      let ObjectDefineProperty;
      /** @type {any} */
      let ObjectFreeze;
      /** @type {any} */
      let ObjectSetPrototypeOf;
      ["Object"].forEach((name) => {
        const original = global[name];
        for (const key of Reflect.ownKeys(original)) {
          if (key === "assign") ObjectAssign = original[key];
          if (key === "defineProperty") ObjectDefineProperty = original[key];
          if (key === "freeze") ObjectFreeze = original[key];
          if (key === "setPrototypeOf") ObjectSetPrototypeOf = original[key];
        }
      });
      /** @type {any} */
      const value = {};
      ObjectAssign(value, { first: 1 });
      ObjectDefineProperty(value, "answer", {
        value: 42,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      ObjectSetPrototypeOf(value, null);
      ObjectFreeze(value);
      /** @returns {number} */
      export function test() { return value.first === 1 && value.answer === 42 ? 42 : 0; }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("resolves shorthand values through the lexical binding instead of the property symbol", async () => {
    const result = await runStandaloneJs(`
      let observed = 0;
      (() => {
        const build = { value: 42 };
        function readBuild() { return build.value; }
        const carrier = { build };
        observed = carrier.build.value === readBuild() ? 42 : 0;
      })();
      /** @returns {number} */
      export function test() { return observed; }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("uses one constructible closure layout for self-referential function shorthand", async () => {
    const result = await runStandaloneJs(`
      let observed = 0;
      (() => {
        const state = { value: 42 };
        function read() { return read === read ? state.value : 0; }
        const carrier = { read };
        observed = carrier.read();
      })();
      /** @returns {number} */
      export function test() { return observed; }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("reifies a nested function that captures a growable object", async () => {
    const result = await runStandaloneJs(`
      let observed = 0;
      (() => {
        const state = { __proto__: null };
        function write(name, value) { state[name] = value; }
        const retained = write;
        observed = typeof retained === "function" ? 42 : 0;
      })();
      /** @returns {number} */
      export function test() { return observed; }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("captures distinct sync and async generator intrinsic prototype objects", async () => {
    const result = await runStandaloneJs(`
      const Generator = Reflect.getPrototypeOf(function* () {});
      const AsyncGenerator = Reflect.getPrototypeOf(async function* () {});
      export function test() {
        return Generator && Generator.prototype && AsyncGenerator &&
          AsyncGenerator.prototype && Generator !== AsyncGenerator &&
          Generator.prototype !== AsyncGenerator.prototype ? 42 : 0;
      }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("constructs Deno's uncurryThis alias for reflected native methods", async () => {
    const result = await runStandaloneJs(`
      const { bind, call } = Function.prototype;
      const uncurryThis = bind.bind(call);
      const Generator = Reflect.getPrototypeOf(function* () {});
      const desc = Reflect.getOwnPropertyDescriptor(Generator.prototype, "next");
      const next = uncurryThis(desc.value);
      export function test() { return typeof next === "function" ? 42 : 0; }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("stores the eval intrinsic without executing the runtime-eval provider", async () => {
    const result = await runStandaloneJs(`
      const indirectEval = eval;
      export function test() { return typeof indirectEval === "function" ? 42 : 0; }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
    expect(result.imports.map(({ module, name }) => `${module}::${name}`)).toContain(
      "js2wasm:runtime-eval::__runtime_indirect_eval",
    );
  });

  it("reuses one eval intrinsic value without executing the runtime-eval provider", async () => {
    const result = await runStandaloneJs(`
      const firstEval = eval;
      const secondEval = eval;
      export function test() { return firstEval === secondEval ? 42 : 0; }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("forwards TDZ-flagged transitive captures from the lifted caller frame", async () => {
    const result = await runStandaloneJs(`
      let observed = 0;
      (() => {
        const p0 = 0, p1 = 1, p2 = 2, p3 = 3, p4 = 4;
        const p5 = 5, p6 = 6, p7 = 7, p8 = 8, p9 = 9;
        const p10 = 10, p11 = 11, p12 = 12, p13 = 13, p14 = 14;
        const p15 = 15, p16 = 16, p17 = 17, p18 = 18, p19 = 19;

        function drainTicks() { queue.value = 42; }
        function runImmediates() {
          runNextTicks();
          return localQueue.value;
        }
        const queue = { value: 1 };
        const localQueue = { value: 42 };
        const runNextTicks = drainTicks;
        function dispatch() { return runImmediates(); }

        const padding = p0 + p1 + p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9 +
          p10 + p11 + p12 + p13 + p14 + p15 + p16 + p17 + p18 + p19;
        observed = dispatch() + queue.value * 0 + padding * 0;
      })();
      export function test() { return observed; }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });

  it("constructs Deno-style Error subclasses that assign this.name", async () => {
    const result = await runStandaloneJs(`
      class BadResource extends Error {
        constructor(msg, options) {
          super(msg, options);
          this.name = "BadResource";
        }
      }
      const error = new BadResource("closed");
      export function test() {
        return error.name === "BadResource" && error.message === "closed" ? 42 : 0;
      }
    `);

    expect(result.value).toBe(42);
    expect(result.calls).toEqual([]);
  });
});
