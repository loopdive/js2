// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3366 — assignment value preservation.
//
// ECMA-262 §13.15.5.3/§13.15.5.6 run a default initializer only when the
// extracted value is the actual undefined value. An object carrying the
// host-defined [[IsHTMLDDA]] slot is still an Object for these algorithms
// (Annex B.3.6 special-cases only ToBoolean, IsLooselyEqual, and typeof), so a
// callable host sentinel must flow through either assignment pattern unchanged.
//
// §13.15.2 evaluates an ordinary assignment's RHS once and returns that value;
// §6.2.5.6 PutValue steps 2.b–2.d write a sloppy unresolvable reference to the
// current realm's global object.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(source: string, sandbox: Record<string, unknown> = {}): Promise<WebAssembly.Instance> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-3366.js",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool, { globalSandbox: sandbox });
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance;
}

describe("#3366 assignment values", () => {
  it("preserves a callable host sentinel through array and object assignment patterns", async () => {
    const instance = await instantiate(`
      var $262 = { IsHTMLDDA: function () {} };
      var sentinel = $262.IsHTMLDDA;
      var arrayValue, objectValue, initCount = 0;
      var base = {};
      function counter() { initCount += 1; }

      [arrayValue = counter()] = [sentinel];
      [base.member = counter()] = [sentinel];
      ({ objectValue = counter() } = { objectValue: sentinel });

      export function result() {
        var score = 0;
        if (arrayValue === sentinel) score += 1;
        if (objectValue === sentinel) score += 2;
        if (initCount === 0) score += 4;
        if (base.member === sentinel) score += 8;
        return score;
      }
    `);

    expect((instance.exports.result as () => number)()).toBe(15);
  });

  it("creates a default-attribute global property for sloppy unresolvable assignment", async () => {
    const sandbox: Record<string, unknown> = {};
    await instantiate(
      `
        function assign() {
          return (__issue_3366_implicit_global__ = 42);
        }
        function record(assignmentValue, descriptorValue) {
          __issue_3366_observed_assignment_value__ = assignmentValue;
          __issue_3366_observed_descriptor_value__ = descriptorValue;
        }
        var assignmentValue = assign();
        var desc = Object.getOwnPropertyDescriptor(this, "__issue_3366_implicit_global__");
        record(assignmentValue, desc.value);
      `,
      sandbox,
    );

    expect(sandbox.__issue_3366_observed_assignment_value__).toBe(42);
    expect(sandbox.__issue_3366_observed_descriptor_value__).toBe(42);
    expect(Object.getOwnPropertyDescriptor(sandbox, "__issue_3366_implicit_global__")).toEqual({
      value: 42,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });
});
