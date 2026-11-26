// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7500 / #7508 — on the Prepared path an export of a class, or of any local the module-init plan has no target for,
// made `compile()` throw (an unplanned export alias, or an unresolved-export-target gap at the final validation).
// Both are now refused at select, by name; a file without units is refused at the export specifier.
import { describe, expect, it } from "vitest";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";
import { preparedOptions } from "./helpers/prepared-node-agreement.js";

const options = (fileName: string): Test262CompileOptions => ({
  ...preparedOptions(),
  skipSemanticDiagnostics: true,
  fileName,
});

/** The compile result's error codes; a throw fails the test, whatever its class. */
const codes = async (source: string, fileName: string, unlowerableBodies: "abort" | "refuse") => {
  const result = await compile(source, options(fileName), undefined, unlowerableBodies);
  return { success: result.success, codes: result.errors.map((error) => error.code) };
};

const refusedAs = async (code: string, source: string, fileName = "test.js") => {
  for (const policy of ["abort", "refuse"] as const)
    expect(await codes(source, fileName, policy)).toEqual({ success: false, codes: [code] });
};

describe("#7500 — Prepared path refuses class and unresolved exports by name", () => {
  it.each([
    ["export class C {}"],
    ["export default class D {}"],
    ["export class C {} export { C as D };"],
    // Precedence: a member with no body producer used to refuse first ("no body producer").
    ["export class C { constructor() {} }"],
    ["export class C { x = 1 }"],
  ])("refuses an exported class: %s", async (source) => {
    await refusedAs("class-export-unsupported", source);
  });

  it("refuses an exported abstract class (.ts)", async () => {
    await refusedAs("class-export-unsupported", "export abstract class C {}", "test.ts");
  });

  it.each([
    ["class C {} export { C };"],
    ["class C {} export { C as D };"],
    ["class C {} export { C as default };"],
    ["export { C }; class C {}"],
    ["class C {} export { C }; export { C as D };"],
    ["class C {} { let C = 1; } export { C };"],
    ["class C { static m() {} } export { C };"],
    // #7508: no unit at all in these files; the refusal is located at the specifier.
    ["import { a } from './m'; export { a };"],
    ["import * as m from './m'; export { m };"],
    ["export { zz };"],
  ])("refuses an unresolved local export: %s", async (source) => {
    await refusedAs("export-target-unsupported", source);
  });

  it.each([
    ["declare function f(): void; export { f };"],
    ["type T = number; export { T };"],
    ["import x = require('m'); export { x };"],
  ])("refuses an unresolved local export (.ts): %s", async (source) => {
    await refusedAs("export-target-unsupported", source, "test.ts");
  });

  it("locates a unit-less refusal at the export specifier", async () => {
    const result = await compile("import { a } from './m';\nexport { a };", options("test.js"), undefined, "refuse");
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "export-target-unsupported", file: "test.js", line: 2, column: 10 }),
    ]);
  });

  it("keeps #7488's refusal for an exported class whose definition runs code", async () => {
    await refusedAs("class-definition-evaluation", "export class C extends Object {}");
  });

  it.each([
    ["export default class {}", "test.js"],
    ["class C {} export default C;", "test.js"],
    ["function f() {} export { f as g };", "test.js"],
    ["var v = 1; export { v };", "test.js"],
    ["export declare class C {}", "test.ts"],
  ])("still compiles %s", async (source, fileName) => {
    expect(await codes(source, fileName, "refuse")).toEqual({ success: true, codes: [] });
  });
});
