// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7011 — `new SharedArrayBuffer(n)` and `Atomics.*` are native on every
// native-regime WasmGC profile: no `SharedArrayBuffer_*` (or any SAB/Atomics)
// host import, results equal to Node's single-agent answers.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

type Lane = "native-first" | "standalone" | "wasi";

function sabAtomicsImports(binary: Uint8Array): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(binary))
    .map((i) => `${i.module}::${i.name}`)
    .filter((n) => /SharedArrayBuffer|Atomics/.test(n));
}

async function compileLane(source: string, lane: Lane) {
  const result = await compile(source, {
    fileName: `issue-7011-${lane}.ts`,
    skipSemanticDiagnostics: true,
    ...(lane === "native-first" ? { semanticProviders: "native-first" as const } : { target: lane }),
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  expect(sabAtomicsImports(result.binary)).toEqual([]);
  return result;
}

/** Run `test()` under the JS environment (native-first, wrapped exports). */
async function runNativeFirst(source: string): Promise<unknown> {
  const result = await compileLane(source, "native-first");
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (wrapCompiledExports(result, instance) as { test(): unknown }).test();
}

/** Run a numeric `test()` with no imports at all. */
async function runStandalone(source: string): Promise<number> {
  const result = await compileLane(source, "standalone");
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/** The same source evaluated by Node — the reference answer. */
function runNode(source: string): unknown {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const mod = { exports: {} as { test(): unknown } };
  new Function("module", "exports", js)(mod, mod.exports);
  return mod.exports.test();
}

const CORE = `
export function test(): number {
  const sab = new SharedArrayBuffer(16);
  const a = new Int32Array(sab);
  a[1] = 5;
  const r1 = Atomics.store(a, 0, 3);
  const r2 = Atomics.add(a, 0, 4);
  const r3 = Atomics.compareExchange(a, 0, 7, 9);
  const r4 = Atomics.sub(a, 1, 2);
  const r5 = Atomics.exchange(a, 2, -1);
  const r6 = Atomics.and(a, 2, 0xff);
  const r7 = Atomics.or(a, 3, 6);
  const r8 = Atomics.xor(a, 3, 3);
  const s = sab.slice(4, 12);
  const v = new Int32Array(s);
  return (
    sab.byteLength * 1e9 + Atomics.load(a, 0) * 1e7 + a[1] * 1e6 +
    r1 + r2 * 10 + r3 * 100 + r4 * 1000 + r5 + r6 * 10000 + r7 + r8 * 100000 +
    s.byteLength * 1e8 + v[0] * 1e5 + Atomics.load(a, 2) * 0.5 + a[3] * 0.25
  );
}
`;

const SEMANTICS = `
function thrower(f: () => void): string {
  try { f(); return "none"; } catch (e: any) {
    return e instanceof TypeError ? "T" : e instanceof RangeError ? "R" : "?";
  }
}
export function test(): string {
  const out: string[] = [];
  const g: any = new SharedArrayBuffer(4, { maxByteLength: 16 });
  out.push(String(g.byteLength), String(g.maxByteLength), String(g.growable));
  g.grow(8);
  out.push(String(g.byteLength), thrower(() => g.grow(2)), thrower(() => g.grow(32)));
  const f = new SharedArrayBuffer(8);
  out.push(String(f.growable), String(f.maxByteLength), thrower(() => (f as any).grow(8)));
  const d: any = f;
  out.push(String(d.slice(2).byteLength), String(d.slice(-3, -1).byteLength));
  out.push(Object.prototype.toString.call(f));
  out.push(thrower(() => new SharedArrayBuffer(-1)));
  out.push(String(new SharedArrayBuffer(0, 5 as any).growable));
  out.push(String(new SharedArrayBuffer({ valueOf() { return 3; } } as any).byteLength));
  out.push(thrower(() => SharedArrayBuffer.prototype.slice.call(new ArrayBuffer(4))));
  out.push(String(Atomics.isLockFree(4)), String(Atomics.isLockFree(3)));
  const ia = new Int32Array(f);
  out.push(String(Atomics.notify(ia, 0, 1)));
  out.push(thrower(() => Atomics.add(new Float64Array(4) as any, 0, 1)), thrower(() => Atomics.add(ia, 5, 1)));
  const u8 = new Uint8Array(new SharedArrayBuffer(4));
  out.push(String(Atomics.add(u8, 0, 300)), String(u8[0]), String(Atomics.sub(u8, 0, 50)), String(u8[0]));
  const fresh = new Int16Array(4);
  out.push(String(Atomics.add(fresh, 1, 40000)), String(fresh[1]));
  out.push(String(Atomics.compareExchange(u8, 0, 250, 9)), String(u8[0]));
  out.push(String(ia.buffer === f), String(Object.getPrototypeOf(f) === SharedArrayBuffer.prototype));
  return out.join(",");
}
`;

const BIGINT = `
export function test(): string {
  const sab = new SharedArrayBuffer(32);
  const v: any = new BigInt64Array(sab);
  const out: any[] = [];
  out.push(Atomics.store(v, 0, 5n), Atomics.add(v, 0, 7n), Atomics.load(v, 0));
  out.push(Atomics.sub(v, 0, 20n), Atomics.load(v, 0));
  out.push(Atomics.compareExchange(v, 0, -8n, 3n), Atomics.exchange(v, 1, 1n << 40n), Atomics.load(v, 1));
  out.push(Atomics.notify(v, 0, 1));
  const u: any = new BigUint64Array(new ArrayBuffer(16));
  out.push(Atomics.or(u, 1, 12n), Atomics.xor(u, 1, 10n), Atomics.and(u, 1, 3n));
  try { Atomics.add(v, 0, 1 as any); out.push("none"); } catch (e) { out.push(e instanceof TypeError ? "T" : "?"); }
  return out.map(String).join(",");
}
`;

describe("#7011 SharedArrayBuffer + Atomics on the native regime", () => {
  it("native-first (JS environment) matches Node", async () => {
    expect(await runNativeFirst(CORE)).toBe(runNode(CORE));
  });

  it("standalone links with no imports and matches Node", async () => {
    expect(await runStandalone(CORE)).toBe(runNode(CORE));
  });

  it("wasi emits no SharedArrayBuffer/Atomics import", async () => {
    await compileLane(CORE, "wasi");
  });

  it("construction, growable/maxByteLength/grow, slice, brands and Atomics edge cases match Node", async () => {
    expect(await runNativeFirst(SEMANTICS)).toBe(runNode(SEMANTICS));
  });

  it("Atomics.wait validates, coerces, then throws: this agent cannot suspend", async () => {
    const source = `
      export function test(): number {
        let coerced = 0;
        const t = { valueOf() { coerced++; return 0; } };
        const ia = new Int32Array(new SharedArrayBuffer(16));
        let r = 0;
        try { Atomics.wait(ia, 0, 0, t as any); } catch (e) { if (e instanceof TypeError) r = 1; }
        // a non-shared view is rejected before any coercion
        try { Atomics.wait(new Int32Array(new ArrayBuffer(16)), t as any, 0, 0); } catch (e) { if (e instanceof TypeError) r += 10; }
        return r + coerced * 100;
      }
    `;
    expect(await runStandalone(source)).toBe(111);
  });

  it("BigInt64Array / BigUint64Array Atomics operate in i64 and match Node", async () => {
    expect(await runNativeFirst(BIGINT)).toBe(runNode(BIGINT));
  });
});
