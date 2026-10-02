// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { irIntrinsicFuncRef, irRuntimeFuncRef, irImportFuncRef } from "../src/ir/core/callable-bindings.js";
import type { IrType } from "../src/ir/core/types.js";
import { irRuntimeCallableDeclaration } from "../src/ir/runtime/callable-declarations.js";
import { ORDINARY_OBJECT_RUNTIME_FEATURES } from "../src/ir/runtime/contracts/manifest.js";
import { RuntimeManifestBuilder } from "../src/ir/runtime/manifest.js";

const REF: IrType = { kind: "val", val: { kind: "externref" } };
const FLAGS: IrType = { kind: "val", val: { kind: "f64" } };
const BOOL: IrType = { kind: "val", val: { kind: "i32", boolean: true } };
const CONTRACTS = [
  ["js.object.create-default", [], [REF]],
  ["js.object.create-null", [], [REF]],
  ["js.object.create-with-prototype", [REF], [REF]],
  ["js.object.define-data", [REF, REF, REF, FLAGS], []],
  ["js.object.define-accessor", [REF, REF, REF, REF, FLAGS], []],
  ["js.object.define-attributes", [REF, REF, FLAGS], []],
  ["js.object.get", [REF, REF, REF], [REF]],
  ["js.object.has", [REF, REF], [BOOL]],
] as const;

describe("ordinary object semantic contracts", () => {
  it("declares prototype modes, descriptor presence, original receiver and boolean Has independently", () => {
    expect(ORDINARY_OBJECT_RUNTIME_FEATURES).toEqual(CONTRACTS.map(([name]) => name));
    for (const [name, params, results] of CONTRACTS) {
      const declaration = irRuntimeCallableDeclaration(irIntrinsicFuncRef(name));
      expect(declaration).toMatchObject({ feature: name, params, results });
    }
  });

  it.each(CONTRACTS)("requires the exact semantic binding for %s", (name) => {
    const declared = irRuntimeCallableDeclaration(irIntrinsicFuncRef(name));
    expect(declared).toBeDefined();
    expect(irRuntimeCallableDeclaration(irIntrinsicFuncRef(name, "renamed diagnostic"))).toBe(declared);
    expect(irRuntimeCallableDeclaration(irRuntimeFuncRef(name))).toBeUndefined();
    expect(irRuntimeCallableDeclaration(irImportFuncRef("env", name))).toBeUndefined();
    expect(irRuntimeCallableDeclaration(irIntrinsicFuncRef(name + ".foreign", name))).toBeUndefined();
    expect(Object.isFrozen(declared)).toBe(true);
    expect(Object.isFrozen(declared!.params)).toBe(true);
    expect(Object.isFrozen(declared!.results)).toBe(true);
    expect(Reflect.set(declared!, "feature", "js.object.get")).toBe(false);
  });

  it.each(["toString", "constructor", "__proto__", "object.new", "object.get", "object.set"])(
    "does not turn inherited names or fixed-field operations into an ordinary contract: %s",
    (name) => expect(irRuntimeCallableDeclaration(irIntrinsicFuncRef(name))).toBeUndefined(),
  );

  it.each(CONTRACTS)("cannot materialize %s merely because its semantic declaration exists", (name) => {
    const builder = new RuntimeManifestBuilder({ target: "standalone", backend: "wasmgc" });
    builder.requestFeature(name);
    expect(() => builder.freeze()).toThrow(expect.objectContaining({ code: "missing-runtime-provider" }));
  });
});
