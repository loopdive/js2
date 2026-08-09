// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3571 — test262's propertyHelper.js stores these two uncurryThis helpers:
//
//   __push = Function.prototype.call.bind(Array.prototype.push)
//   __join = Function.prototype.call.bind(Array.prototype.join)
//
// Standalone could construct the bound-function carrier, but invoking it lost
// the Array builtin target and null-dereferenced. The compiler now recognizes
// that exact immutable builtin identity and invokes the existing native Array
// lowering on the first call argument. These checks observe results and
// mutations; merely compiling is not considered a pass.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(
    WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter((entry) => entry.module === "env"),
  ).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  return (instance.exports as { test(): unknown }).test();
}

const PROPERTY_HELPER_BINDINGS = `
  var __push: any = Function.prototype.call.bind(Array.prototype.push);
  var __join: any = Function.prototype.call.bind(Array.prototype.join);
`;

describe("#3571 standalone propertyHelper uncurryThis dispatch", () => {
  it("uncurried push mutates the receiver and returns its new length", async () => {
    expect(
      await runStandalone(`
        ${PROPERTY_HELPER_BINDINGS}
        export function test(): number {
          var values: any[] = [];
          var firstLength: any = __push(values, "first");
          var secondLength: any = __push(values, "second");
          if (firstLength !== 1 || secondLength !== 2) return 10;
          if (values.length !== 2) return 11;
          if (values[0] !== "first" || values[1] !== "second") return 12;
          return 1;
        }
      `),
    ).toBe(1);
  });

  it("uncurried join observes the receiver and separator", async () => {
    expect(
      await runStandalone(`
        ${PROPERTY_HELPER_BINDINGS}
        export function test(): number {
          return __join(["a", "b"], ";") === "a;b" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("the propertyHelper failure-accumulation shape is no longer vacuous", async () => {
    expect(
      await runStandalone(`
        ${PROPERTY_HELPER_BINDINGS}
        export function test(): number {
          var failures: any[] = [];
          __push(failures, "expected 1 but got 2");
          if (failures.length !== 1) return 10;
          return __join(failures, "; ") === "expected 1 but got 2" ? 1 : 11;
        }
      `),
    ).toBe(1);
  });
});
