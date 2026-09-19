import { expect, it } from "vitest";
import { compile } from "../src/index.js";
import { spawnSync } from "node:child_process";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  return runBinary(result.binary);
}

function runBinary(binary: Uint8Array): number {
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-wasm-exnref",
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    const module = new WebAssembly.Module(Buffer.concat(chunks));
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    const instance = await WebAssembly.instantiate(module, {});
    process.stdout.write(JSON.stringify(instance.exports.run()));
  `,
    ],
    { input: binary, encoding: "utf8", timeout: 10000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

it("suspends TypeScript's generic mapIterator without eagerly running its callback", async () => {
  const result = await compile(
    `
    function* mapIterator<T, U>(iter: Iterable<T>, mapFn: (x: T) => U): Generator<U, void, unknown> {
      for (const x of iter) { yield mapFn(x); }
    }
    export function run(): number {
      let calls = 0;
      const iterator = mapIterator([2, 4], x => { calls++; return x * 3; });
      if (calls !== 0) return -1;
      const first = iterator.next();
      if (first.done || first.value !== 6 || calls !== 1) return -2;
      const second = iterator.next();
      if (second.done || second.value !== 12 || calls !== 2) return -3;
      const final = iterator.next();
      return final.done && final.value === undefined && calls === 2 ? 1 : -4;
    }
  `,
    { target: "standalone", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(runBinary(result.binary)).toBe(1);
});

it("iterates numeric arrays without a callback", async () => {
  expect(
    await runStandalone(`
    function* values(xs: number[]) { for (const x of xs) { yield x; } }
    export function run(): number {
      const g = values([2, 4]);
      const a = g.next(); const b = g.next(); const c = g.next();
      return a.value === 2 && b.value === 4 && c.done ? 1 : -1;
    }
  `),
  ).toBe(1);
});

it("iterates generic input without a callback", async () => {
  expect(
    await runStandalone(`
    function* values<T>(xs: Iterable<T>) { for (const x of xs) { yield x; } }
    export function run(): number {
      const g = values([2, 4]);
      const a = g.next(); const b = g.next(); const c = g.next();
      return a.value === 2 && b.value === 4 && c.done ? 1 : -1;
    }
  `),
  ).toBe(1);
});

const customIterator = `
  let steps = 0, closes = 0, opens = 0;
  let nextError = false, closeError = false, callbackError = false;
  const iterable = {
    [Symbol.iterator]() {
      opens++;
      return {
        next() {
          steps++;
          if (nextError) throw 71;
          return { value: steps * 2, done: steps > 2 };
        },
        return() { closes++; if (closeError) throw 91; return { value: 0, done: true }; }
      };
    }
  };
  function* mapIterator<T, U>(iter: Iterable<T>, mapFn: (x: T) => U): Generator<U, void, unknown> {
    for (const x of iter) { yield mapFn(x); }
  }
  function mapped() {
    return mapIterator(iterable, x => { if (callbackError) throw 81; return x * 3; });
  }
`;

it("builds TypeScript's inverse option map during module initialization", async () => {
  expect(
    await runStandalone(`
    export function* mapIterator<T, U>(iter: Iterable<T>, mapFn: (x: T) => U): Generator<U, void, unknown> {
      for (const x of iter) { yield mapFn(x); }
    }
    const first = new Map<string, number>([["preserve", 1], ["react", 2]]);
    const second = new Map(mapIterator(first.entries(), ([key, value]: [string, number]) => ["" + value, key] as const));
    export function run(): number {
      if (first.size !== 2) return -10;
      if (second.size !== 2) return -20 - second.size;
      if (second.get("1") !== "preserve") return -30;
      return second.get("2") === "react" ? 1 : -40;
    }
  `),
  ).toBe(1);
});

it("maps heterogeneous Map entries before constructing the inverse Map", async () => {
  expect(
    await runStandalone(`
    function* mapIterator<T, U>(iter: Iterable<T>, mapFn: (x: T) => U): Generator<U, void, unknown> {
      for (const x of iter) { yield mapFn(x); }
    }
    export function run(): number {
      const first = new Map<string, number>([["preserve", 1], ["react", 2]]);
      const g = mapIterator(first.entries(), ([key, value]: [string, number]) => ["" + value, key] as const);
      const a = g.next();
      if (a.done) return -10;
      if (a.value[0] !== "1") return -20;
      if (a.value[1] !== "preserve") return -30;
      const b = g.next();
      if (b.done || b.value[0] !== "2" || b.value[1] !== "react") return -40;
      return g.next().done ? 1 : -50;
    }
  `),
  ).toBe(1);
});

it("observes array writes and appends between suspensions", async () => {
  expect(
    await runStandalone(`
    function* values<T>(xs: Iterable<T>) { for (const x of xs) { yield x; } }
    export function run(): number {
      const xs = [2, 4]; const g = values(xs);
      if (g.next().value !== 2) return -1;
      xs[1] = 7; xs.push(9);
      if (g.next().value !== 7) return -2;
      if (g.next().value !== 9) return -3;
      return g.next().done ? 1 : -4;
    }
  `),
  ).toBe(1);
});

it("reads escaped tuple fields without losing primitive brands or object identity", async () => {
  expect(
    await runStandalone(`
    const object = { id: 7 };
    function tuple(): any {
      const value: [string, number, boolean, { id: number }] = ["x", 7, false, object];
      return value;
    }
    function read(value: any, index: number): any { return value[index]; }
    export function run(): number {
      const value = tuple();
      if (read(value, 0) !== "x" || read(value, 1) !== 7) return -1;
      if (read(value, 2) !== false || read(value, 3) !== object) return -2;
      if (read(value, -1) !== undefined || read(value, 0.5) !== undefined || read(value, 4) !== undefined) return -3;
      return 1;
    }
  `),
  ).toBe(1);
});

it.each([
  [
    "normal exhaustion never closes",
    `
    const g = mapped();
    if (opens !== 0 || steps !== 0) return -1;
    if (g.next().value !== 6 || g.next().value !== 12 || !g.next().done) return -2;
    return opens === 1 && steps === 3 && closes === 0 ? 1 : -3;
  `,
  ],
  [
    "return before first next never opens",
    `
    const g = mapped(); const r = g.return(undefined);
    return r.done && opens === 0 && steps === 0 && closes === 0 ? 1 : -1;
  `,
  ],
  [
    "return at yield closes exactly once",
    `
    const g = mapped(); g.next(); const r = g.return(undefined); g.next();
    return r.done && steps === 1 && closes === 1 ? 1 : -1;
  `,
  ],
  [
    "throw at yield closes and preserves its value",
    `
    const g = mapped(); g.next(); let error = 0;
    try { g.throw(51); } catch (e) { error = e as number; }
    return error === 51 && closes === 1 && g.next().done ? 1 : -1;
  `,
  ],
  [
    "callback throw closes",
    `
    const g = mapped(); callbackError = true; let error = 0;
    try { g.next(); } catch (e) { error = e as number; }
    return error === 81 && closes === 1 && g.next().done ? 1 : -1;
  `,
  ],
  [
    "next throw does not close",
    `
    const g = mapped(); nextError = true; let error = 0;
    try { g.next(); } catch (e) { error = e as number; }
    return error === 71 && closes === 0 && g.next().done ? 1 : -1;
  `,
  ],
  [
    "close throw replaces return",
    `
    const g = mapped(); g.next(); closeError = true; let error = 0;
    try { g.return(undefined); } catch (e) { error = e as number; }
    return error === 91 && closes === 1 && g.next().done ? 1 : -1;
  `,
  ],
  [
    "close throw does not replace injected throw",
    `
    const g = mapped(); g.next(); closeError = true; let error = 0;
    try { g.throw(51); } catch (e) { error = e as number; }
    return error === 51 && closes === 1 && g.next().done ? 1 : -1;
  `,
  ],
  [
    "close throw does not replace callback throw",
    `
    const g = mapped(); closeError = true; callbackError = true; let error = 0;
    try { g.next(); } catch (e) { error = e as number; }
    return error === 81 && closes === 1 && g.next().done ? 1 : -1;
  `,
  ],
])("mapIterator: %s", async (_name, body) => {
  expect(await runStandalone(`${customIterator}\nexport function run(): number { ${body} }`)).toBe(1);
});
