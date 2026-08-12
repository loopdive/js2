// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3975 — the literal Test262 runtime now routes `$262.detachArrayBuffer` to
// the native detached-buffer marker when no JS host provides structuredClone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const ROOT = join(import.meta.dirname, "..");
const runtimeSource = readFileSync(join(ROOT, "scripts", "test262-fyi-runtime.js"), "utf8");

const detachProgram = `
function detach(buffer: any): void {
  if (typeof structuredClone !== "function") {
    (buffer as any).__detached__ = true;
    return;
  }
  structuredClone(buffer, { transfer: [buffer] });
}

export function test(): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  detach(buffer);
  try {
    view.getUint8(0);
    return 0;
  } catch (error) {
    return 1;
  }
}
`;

describe("#3975 Test262 detachArrayBuffer runtime", () => {
  it("uses the marker fallback in a host-free runtime", () => {
    const context: Record<string, unknown> = {};
    runInNewContext(
      `${runtimeSource}\nvar __buffer = {}; $262.detachArrayBuffer(__buffer); __result = __buffer.__detached__;`,
      context,
    );
    expect(context.__result).toBe(true);
  });

  it("keeps the host structuredClone transfer path", () => {
    const calls: unknown[][] = [];
    const context: Record<string, unknown> = {
      structuredClone: (...args: unknown[]) => {
        calls.push(args);
      },
    };
    runInNewContext(
      `${runtimeSource}\nvar __buffer = {}; $262.detachArrayBuffer(__buffer); __marker = __buffer.__detached__;`,
      context,
    );
    expect(context.__marker).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual({ transfer: [calls[0]?.[0]] });
  });

  it("detaches the native buffer in standalone with zero host imports", async () => {
    const result = await compile(detachProgram, {
      fileName: "issue-3975-standalone.ts",
      target: "standalone",
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it("keeps structuredClone as a real import in the GC lane", async () => {
    const result = await compile(detachProgram, {
      fileName: "issue-3975-gc.ts",
      target: "gc",
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports.map((entry) => entry.name)).toContain("structuredClone");
  });
});
