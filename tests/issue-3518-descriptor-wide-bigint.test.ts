// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { descriptorRuntime } from "./helpers/native-descriptor-fixture.js";
import type { BigIntOperand } from "./helpers/native-bigint-carrier-fixture.js";

const source = readFileSync(new URL("./fixtures/issue-3518-descriptor-wide-bigint.ts.txt", import.meta.url), "utf8");
const cases: readonly [string, BigIntOperand, BigIntOperand, boolean][] = [
  ["equalWide", "wide64", "wide64", true],
  ["mixedLowBits", "wide64", "zero", false],
  ["mixedReverse", "zero", "wide64", false],
  ["signsDiffer", "wide64", "wideNegative", false],
  ["lengthsDiffer", "wide64one", "wide96one", false],
  ["highLimbDiffers", "wide96one", "wide96high", false],
  ["lowLimbDiffers", "wide96one", "wide96low", false],
  ["narrowEqual", "one", "one", true],
  ["narrowDifferent", "one", "negative", false],
];
let cached: ReturnType<typeof prepare> | undefined;
async function prepare() {
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const scope = { exports: {} as Record<string, () => number | bigint> };
  runInNewContext(output, scope);
  const compiled = await compile(source, {
    target: "standalone",
    hostBridge: "off",
    fileName: "descriptor-wide-bigint.ts",
  });
  expect(compiled.success, JSON.stringify(compiled.errors)).toBe(true);
  expect(WebAssembly.validate(compiled.binary)).toBe(true);
  const module = new WebAssembly.Module(compiled.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return { node: scope.exports, legacy: instance.exports, native: descriptorRuntime(true) };
}
const actual = () => (cached ??= prepare());
describe("exact source, retained compiler and native descriptor wide BigInt agreement", () => {
  it.each(cases)("preserves non-configurable descriptor SameValue: %s", async (name, a, b, equal) => {
    const r = await actual(),
      expected = r.node[name]!();
    expect(expected).toBe(1);
    const object = r.native.create(),
      first = r.native[a](),
      second = r.native[b]();
    r.native.defineData(object, r.native.key(), first, 128);
    let allowed = false;
    try {
      r.native.defineData(object, r.native.key(), second, 128);
      allowed = true;
    } catch (error) {
      expect(error instanceof WebAssembly.Exception).toBe(true);
      expect((error as WebAssembly.Exception).is(r.native.exception)).toBe(true);
    }
    expect(allowed).toBe(equal);
    expect(r.native.sameValue(r.native.entry(object, r.native.key())[1], first)).toBe(1);
    expect((r.legacy[name] as () => number)()).toBe(expected);
  });
  it("uses the complete BigInt value in the retained Object.is path", async () => {
    const r = await actual();
    expect(r.node.sameValueMixed!()).toBe(1);
    expect((r.legacy.sameValueMixed as () => number)()).toBe(1);
  });
  it("recognizes the exact legacy wide carrier with the native owner's canonical layouts", async () => {
    const r = await actual(),
      legacyValue = (r.legacy.wideCarrier as () => unknown)();
    expect(r.node.wideCarrier!()).toBe(1n << 64n);
    expect(r.native.isBigInt(legacyValue)).toBe(1);
    expect(r.native.sameValue(legacyValue, r.native.wide64())).toBe(1);
    expect(r.native.sameValue(legacyValue, r.native.zero())).toBe(0);
  });
});
