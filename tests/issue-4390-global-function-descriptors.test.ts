// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

async function compileStandalone(source: string) {
  const result = await compile(source, {
    fileName: "issue-4390-global-functions.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    emitWat: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return { result, exports: instance.exports as Record<string, Function> };
}

describe("#4390 standalone ES5 global function properties", () => {
  it("materializes genuine callable descriptor values with stable identities", async () => {
    const { exports } = await compileStandalone(`
function descriptorIsCorrect(name: any): boolean {
  const d: any = Object.getOwnPropertyDescriptor(globalThis, name);
  return typeof d.value === "function" &&
    d.value === globalThis[name] &&
    d.writable === true &&
    d.enumerable === false &&
    d.configurable === true;
}
export function test(): number {
  let mask = 0;
  if (descriptorIsCorrect("parseInt")) mask += 1;
  if (descriptorIsCorrect("parseFloat")) mask += 2;
  if (descriptorIsCorrect("isNaN")) mask += 4;
  if (descriptorIsCorrect("isFinite")) mask += 8;
  if (descriptorIsCorrect("decodeURI")) mask += 16;
  if (descriptorIsCorrect("decodeURIComponent")) mask += 32;
  if (descriptorIsCorrect("encodeURIComponent")) mask += 64;

  const parseInteger: any = globalThis.parseInt;
  const parseDecimal: any = globalThis.parseFloat;
  const nanPredicate: any = globalThis.isNaN;
  const finitePredicate: any = globalThis.isFinite;
  const decodeWhole: any = globalThis.decodeURI;
  const decodeComponent: any = globalThis.decodeURIComponent;
  const encodeComponent: any = globalThis.encodeURIComponent;
  if (parseInteger === globalThis.parseInt && parseInteger === parseInt && parseInteger !== parseDecimal) mask += 128;
  if (parseInteger("42", 10) === 42 && parseDecimal("3.5") === 3.5) mask += 256;
  if (nanPredicate(NaN) && !nanPredicate(1) && finitePredicate(1) && !finitePredicate(Infinity)) mask += 512;
  if (
    encodeComponent("a b") === "a%20b" &&
    decodeWhole("a%20b") === "a b" &&
    decodeComponent("a%20b") === "a b"
  ) mask += 1024;
  return mask;
}
`);

    expect(exports.test()).toBe(2047);
  });

  it("is observable through an IR-emitted dyn.member_get consumer", async () => {
    const { result } = await compileStandalone(`
export function readGlobalFunction(receiver: any): any {
  return receiver.parseInt;
}
export function descriptorValue(): any {
  return Object.getOwnPropertyDescriptor(globalThis, "parseInt").value;
}
`);

    expect(
      result.irOutcomes?.find((outcome) => outcome.displayName === "readGlobalFunction"),
      JSON.stringify(result.irOutcomes),
    ).toMatchObject({ kind: "emitted", irBodyEmitted: true, stage: "patch" });
    expect(result.wat).toContain("__dyn_member_get");
    expect(result.wat).toContain("__extern_get");
    expect(result.wat).toContain("__standalone_global_function_parseInt");
  });

  const test262Cases = [5, 6, 7, 8, 9, 10, 11].map(
    (suffix) => `built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-${suffix}.js`,
  );
  for (const relative of test262Cases) {
    it(`passes ${relative} in the assembled standalone harness`, async () => {
      const result = await runTest262File(resolve("test262/test", relative), "issue-4390", 120_000, "standalone");
      expect(result.status, result.reason ?? result.error).toBe("pass");
    }, 130_000);
  }
});
