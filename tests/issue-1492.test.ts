// #1492 — Node.js crypto.randomBytes / crypto.randomUUID host imports.
//
// `import { randomBytes, randomUUID } from "node:crypto"` now binds the
// named imports through a typed host-import (`node_builtin_fn`
// ImportIntent). Under Node the runtime resolver delegates to the real
// `crypto` module; under a browser it falls back to
// `globalThis.crypto.{randomUUID,getRandomValues}`. A non-secure shim
// keeps the call non-throwing when no host crypto is available.
import { describe, it, expect } from "vitest";
import { compile, buildImports } from "../src/index.js";

async function compileAndInstantiate(src: string, opts: { deps?: Record<string, any> } = {}) {
  const result = await compile(src, { fileName: "test.ts" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const imports = buildImports(result.imports, opts.deps);
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return { result, instance };
}

describe("crypto host imports (#1492)", () => {
  it("classifies __nodefn__crypto__* imports with the correct ImportIntent", async () => {
    const src = `
      import { randomBytes, randomUUID } from "node:crypto";
      export function main(): number {
        const a = randomUUID();
        const b = randomBytes(8);
        return a.length + b.length;
      }
    `;
    const result = await compile(src, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    const cryptoImports = result.imports.filter((i) => i.name.startsWith("__nodefn__"));
    expect(cryptoImports.length).toBe(2);
    for (const imp of cryptoImports) {
      expect(imp.intent.type).toBe("node_builtin_fn");
      const intent = imp.intent as { type: string; moduleName: string; fnName: string };
      expect(intent.moduleName).toBe("crypto");
      expect(["randomBytes", "randomUUID"]).toContain(intent.fnName);
    }
  });

  it("randomBytes(n) returns a Uint8Array of length n", async () => {
    const src = `
      import { randomBytes } from "node:crypto";
      export function lenOf(n: number): number {
        const buf = randomBytes(n);
        return buf.length;
      }
    `;
    const { instance } = await compileAndInstantiate(src);
    expect((instance.exports.lenOf as (n: number) => number)(16)).toBe(16);
    expect((instance.exports.lenOf as (n: number) => number)(32)).toBe(32);
    expect((instance.exports.lenOf as (n: number) => number)(1)).toBe(1);
  });

  it("randomUUID() returns a 36-char string and successive calls differ", async () => {
    const src = `
      import { randomUUID } from "node:crypto";
      export function uuidLen(): number {
        return randomUUID().length;
      }
      export function uuidsDiffer(): number {
        const a = randomUUID();
        const b = randomUUID();
        return a !== b ? 1 : 0;
      }
    `;
    const { instance } = await compileAndInstantiate(src);
    expect((instance.exports.uuidLen as () => number)()).toBe(36);
    expect((instance.exports.uuidsDiffer as () => number)()).toBe(1);
  });

  it("combined randomBytes + randomUUID acceptance criteria", async () => {
    // Mirrors the spec's acceptance code block.
    const src = `
      import { randomBytes, randomUUID } from "node:crypto";
      export function main(): number {
        const id1 = randomUUID();
        const id2 = randomUUID();
        const bytes = randomBytes(16);
        const ok1 = bytes.length === 16 ? 1 : 0;
        const ok2 = id1.length === 36 ? 1 : 0;
        const ok3 = id1 !== id2 ? 1 : 0;
        return (ok1 << 0) | (ok2 << 1) | (ok3 << 2);
      }
    `;
    const { instance } = await compileAndInstantiate(src);
    expect((instance.exports.main as () => number)()).toBe(0b111);
  });

  it("deps override takes precedence over require()", async () => {
    // Inject a deterministic crypto so we can prove the deps path is wired.
    const fakeCrypto = {
      randomUUID: () => "00000000-0000-0000-0000-000000000000",
      randomBytes: (n: number) => new Uint8Array(n).fill(0x42),
    };
    const src = `
      import { randomBytes, randomUUID } from "node:crypto";
      export function uuidFirstByte(): number {
        return randomUUID().charCodeAt(0);
      }
      export function byte0(n: number): number {
        const buf = randomBytes(n);
        return buf[0]!;
      }
    `;
    const { instance } = await compileAndInstantiate(src, { deps: { crypto: fakeCrypto } });
    expect((instance.exports.uuidFirstByte as () => number)()).toBe("0".charCodeAt(0));
    expect((instance.exports.byte0 as (n: number) => number)(4)).toBe(0x42);
  });
});
