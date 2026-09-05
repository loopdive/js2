import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const source = `
  const accessorTarget = { get attr() { return this; } };
  const direct = new Proxy(accessorTarget, { get: undefined });
  const inherited = Object.create(new Proxy(accessorTarget, {}));

  export function receiverForwarding(): number {
    return (direct.attr === direct ? 1 : 0) + (inherited.attr === inherited ? 1 : 0);
  }

  export function trapKinds(): number {
    const target: any = { value: 7 };
    const missing: any = new Proxy(target, {});
    const explicitUndefined: any = new Proxy(target, { get: undefined });
    const explicitNull: any = new Proxy(target, { get: null });
    return (missing.value === 7 && missing.missing === undefined ? 1 : 0) +
      (explicitUndefined.value === 7 ? 1 : 0) +
      (explicitNull.value === 7 ? 1 : 0);
  }

  export function nonCallableGetTrap(): number {
    const p: any = new Proxy({}, { get: {} });
    try { p.attr; return 0; } catch (_) { return 1; }
  }
`;

type TestExports = Record<string, () => unknown>;

async function compileHost(): Promise<TestExports> {
  const result = await compile(source);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return instance.exports as TestExports;
}

async function compileStandalone(): Promise<TestExports> {
  const result = await compile(source, { target: "standalone" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as TestExports;
}

describe("#4721 Proxy get trap absence and receiver forwarding", () => {
  let host: TestExports;
  let standalone: TestExports;
  beforeAll(async () => {
    [host, standalone] = await Promise.all([compileHost(), compileStandalone()]);
  });

  for (const [label, getExports] of [
    ["host", () => host],
    ["standalone", () => standalone],
  ] as const) {
    it(`${label}: forwards the Object.create receiver`, async () => {
      expect(getExports().receiverForwarding()).toBe(2);
    });

    it(`${label}: distinguishes missing, undefined, and null traps`, async () => {
      expect(getExports().trapKinds()).toBe(3);
    });

    it(`${label}: rejects a non-callable get trap`, async () => {
      expect(getExports().nonCallableGetTrap()).toBe(1);
    });
  }
});
