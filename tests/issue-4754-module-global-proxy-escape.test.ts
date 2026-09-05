// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const GATE = "JS2WASM_PROXY_MODULE_ESCAPE_GATE";
const originalGate = process.env[GATE];

afterEach(() => {
  if (originalGate === undefined) Reflect.deleteProperty(process.env, GATE);
  else process.env[GATE] = originalGate;
});

async function compileProxySource(source: string, gate: "default" | "one" | "off" = "default") {
  if (gate === "off") process.env[GATE] = "0";
  else if (gate === "one") process.env[GATE] = "1";
  else Reflect.deleteProperty(process.env, GATE);
  const result = await compile(source, { fileName: "issue-4754.ts", emitWat: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

function moduleGlobal(wat: string | undefined, name: string): string {
  const line = wat?.split("\n").find((candidate) => candidate.includes(`(global $__mod_${name} `));
  expect(line, `missing $__mod_${name} in WAT`).toBeDefined();
  return line!;
}

function expectStructuralModuleGlobal(wat: string | undefined, name: string): void {
  const line = moduleGlobal(wat, name);
  expect(line).toMatch(/\(mut \(ref null \d+\)\)/);
  expect(line).not.toContain("externref");
}

function expectExternrefModuleGlobal(wat: string | undefined, name: string): void {
  expect(moduleGlobal(wat, name)).toContain("(mut externref)");
}

async function instantiate(result: Awaited<ReturnType<typeof compile>>): Promise<WebAssembly.Exports> {
  const imports = result.importObject ?? buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setExports?: (exports: object) => void }).__setExports?.(instance.exports);
  return instance.exports;
}

describe("#4754 module-global Proxy escape gate", () => {
  it("keeps an escaping new Proxy structural while the revocable result object stays dynamic", async () => {
    const result = await compileProxySource(`
      function consume(value: any): number { return value ? 1 : 0; }
      const target = { x: 1 };
      const direct = new Proxy(target, {});
      const revocable = Proxy.revocable(target, {});
      consume(direct);
      consume(revocable);
      export function test(): number { return 1; }
    `);

    expectStructuralModuleGlobal(result.wat, "direct");
    // `Proxy.revocable` returns a result record that contains a callable
    // `revoke` field. Its checker-derived representation is already externref;
    // declining the #4931 Proxy arm must not invent a closed struct for it.
    expectExternrefModuleGlobal(result.wat, "revocable");
  });

  it("treats .call/.apply argument zero and constructor arguments as direct escapes", async () => {
    const result = await compileProxySource(`
      class Consumer { constructor(value: any) { void value; } }
      const a = new Proxy([1], {});
      const b = new Proxy([2], {});
      const c = new Proxy({ x: 3 }, {});
      Array.prototype.push.call(a, 2);
      Array.prototype.push.apply(b, [3]);
      new Consumer(c);
      export function test(): number { return 1; }
    `);

    expectStructuralModuleGlobal(result.wat, "a");
    expectStructuralModuleGlobal(result.wat, "b");
    expectStructuralModuleGlobal(result.wat, "c");
  });

  it("unwraps every transparent TypeScript expression around an escaping binding", async () => {
    const result = await compileProxySource(`
      function consume(value: any): number { return value ? 1 : 0; }
      const target = { x: 1 };
      const paren = new Proxy(target, {});
      const asExpr = new Proxy(target, {});
      const asserted = new Proxy(target, {});
      const nonNull = new Proxy(target, {});
      const satisfiesExpr = new Proxy(target, {});
      consume((paren));
      consume(asExpr as any);
      consume(<any>asserted);
      consume(nonNull!);
      consume(satisfiesExpr satisfies { x: number });
      export function test(): number { return 1; }
    `);

    for (const name of ["paren", "asExpr", "asserted", "nonNull", "satisfiesExpr"]) {
      expectStructuralModuleGlobal(result.wat, name);
    }
  });

  it("uses binding identity: a shadow is inert but a genuine captured escape is structural", async () => {
    const shadow = await compileProxySource(`
      function consume(value: any): number { return value ? 1 : 0; }
      const p = new Proxy({ x: 1 }, { get: function () { return 7; } });
      function nested(): void {
        const p = new Proxy({ x: 2 }, {});
        consume(p);
      }
      nested();
      export function test(): number { return p.x; }
    `);
    expectExternrefModuleGlobal(shadow.wat, "p");

    const capture = await compileProxySource(`
      function consume(value: any): number { return value ? 1 : 0; }
      const p = new Proxy({ x: 1 }, {});
      function nested(): void { consume(p); }
      nested();
      export function test(): number { return 1; }
    `);
    expectStructuralModuleGlobal(capture.wat, "p");
  });

  it("keeps member-only Proxy carriers externref and observes their get traps", async () => {
    const direct = await compileProxySource(`
      const p = new Proxy({ x: 1 }, { get: function () { return 7; } });
      export function test(): number { return p.x; }
    `);
    expectExternrefModuleGlobal(direct.wat, "p");
    expect(((await instantiate(direct)).test as () => number)()).toBe(7);

    const revocable = await compileProxySource(`
      const holder = Proxy.revocable({ x: 1 }, { get: function () { return 9; } });
      export function test(): number { return holder.proxy.x; }
    `);
    expectExternrefModuleGlobal(revocable.wat, "holder");
    expect(((await instantiate(revocable)).test as () => number)()).toBe(9);
  });

  it("does not widen the out-of-scope Proxy.revocable(...).proxy declaration", async () => {
    const result = await compileProxySource(`
      function consume(value: any): number { return value ? 1 : 0; }
      const p = Proxy.revocable({ x: 1 }, {}).proxy;
      consume(p);
      export function test(): number { return 1; }
    `);

    expectStructuralModuleGlobal(result.wat, "p");
  });

  it("does not promote assignment aliases into direct binding-flow evidence", async () => {
    const result = await compileProxySource(`
      function consume(value: any): number { return value ? 1 : 0; }
      const p = new Proxy({ x: 1 }, { get: function () { return 7; } });
      const alias = p;
      consume(alias);
      export function test(): number { return p.x; }
    `);

    expectExternrefModuleGlobal(result.wat, "p");
  });

  it("only exact =0 restores #4931 unconditional widening", async () => {
    const source = `
      function consume(value: any): number { return value ? 1 : 0; }
      const p = new Proxy({ x: 1 }, {});
      consume(p);
      export function test(): number { return 1; }
    `;
    const gated = await compileProxySource(source);
    const explicitOne = await compileProxySource(source, "one");
    const legacy = await compileProxySource(source, "off");

    expectStructuralModuleGlobal(gated.wat, "p");
    expectStructuralModuleGlobal(explicitOne.wat, "p");
    expectExternrefModuleGlobal(legacy.wat, "p");
  });

  it("preserves #4707's member-only proxiedIterator externref carrier and behavior", async () => {
    const result = await compileProxySource(`
      const iterable: any = {};
      let nextResult = { value: 23, done: false };
      const lastResult = { value: 0, done: true };
      const iterator = {
        next: function() {
          const result = nextResult;
          nextResult = lastResult;
          return result;
        },
      };
      const proxiedIterator = new Proxy(iterator, {
        get: function(target: any, name: any) { return target[name]; },
      });
      iterable[Symbol.iterator] = function() { return proxiedIterator; };

      export function test(): number {
        let total = 0;
        for (const value of iterable) total += value;
        return total;
      }
    `);

    expectExternrefModuleGlobal(result.wat, "proxiedIterator");
    expect(((await instantiate(result)).test as () => number)()).toBe(23);
  });

  it("preserves the function-local #2615 member-only and escaping slot split", async () => {
    const result = await compileProxySource(`
      function consume(value: any): number { return value ? 1 : 0; }
      export function memberOnly(): number {
        const p = new Proxy({ x: 1 }, { get: function () { return 7; } });
        return p.x;
      }
      export function escaping(): number {
        const p = new Proxy({ x: 1 }, {});
        return consume((p as any)!);
      }
    `);
    const memberOnly = result.wat.split("\n").find((line) => /\(local \$p\s/.test(line));
    expect(memberOnly).toContain("externref");

    const escapingBody = result.wat.slice(result.wat.indexOf("(func $escaping"));
    const escaping = escapingBody.split("\n").find((line) => /\(local \$p\s/.test(line));
    expect(escaping).toBeDefined();
    expect(escaping).not.toContain("externref");
  });
});
