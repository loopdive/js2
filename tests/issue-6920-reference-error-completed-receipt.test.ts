// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import * as literals from "../src/backend/wasmgc/resources/native-string-literals.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  planPhysicalReferenceError,
  reservePhysicalReferenceError,
  fillPhysicalReferenceError,
  completedPhysicalReferenceErrorReceipt,
  verifyCompletedPhysicalReferenceErrorReceipt,
  type PhysicalReferenceError,
} from "../src/ir/program-reference-error.js";

let plan: PhysicalReferenceError;
beforeAll(() => {
  const ast = analyzeMultiSource(
    { "./entry.ts": "export let value:number=1;export function read():number{return value;}" },
    "./entry.ts",
  );
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: typedOptions.policy,
    deferTopLevelInit: true,
  });
  if (source.kind !== "prepared") throw new Error(source.detail);
  const program = requireProgram(prepareTypedIrProgram(captureTypedIrProgramInput(source), typedOptions));
  const actual = planPhysicalReferenceError(program, program.runtime[0]!);
  if (!actual) throw new Error("actual global TDZ source did not declare ReferenceError");
  plan = actual;
});
function fixture(displaced = false, imported = false) {
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  if (displaced)
    tx.reserveType("prefix", {
      kind: "rec",
      types: [
        { kind: "struct", name: "prefix-a", fields: [], superTypeIdx: -1 },
        { kind: "struct", name: "prefix-b", fields: [], superTypeIdx: -1 },
      ],
    });
  if (imported) {
    tx.reserveFunctionImport("prefix:function", "fixture", "identity", {
      params: [{ kind: "i32" }],
      results: [{ kind: "i32" }],
    });
    tx.reserveGlobalImport("prefix:global", "fixture", "value", { kind: "i32" }, false);
  }
  let live = true;
  const guard = () => {
    if (!live) throw new Error("attempt revoked");
  };
  const pack = reservePhysicalReferenceError(tx, plan, guard, {
    reserve: literals.reserveNativeStringLiteralResources,
    inventory: literals.nativeStringLiteralReservationInventory,
    fill: literals.fillNativeStringLiteralResources,
    requireCompleted: literals.requireCompletedNativeStringLiterals,
    requireLiteral: literals.requireNativeStringLiteral,
    globalMatches: literals.nativeStringLiteralGlobalMatches,
  });
  return {
    module,
    tx,
    pack,
    revoke: () => {
      live = false;
    },
  };
}
function completed(displaced = false) {
  const f = fixture(displaced);
  f.tx.freezeReservations();
  fillPhysicalReferenceError(f.tx, f.pack);
  const receipt = completedPhysicalReferenceErrorReceipt(f.tx, f.pack, f.module);
  f.tx.seal();
  f.revoke();
  return { ...f, receipt };
}

describe("completed actual ReferenceError receipt", () => {
  it.each([false, true])(
    "binds actual source declaration and exact native resource coordinates, displaced=%s",
    (displaced) => {
      const f = completed(displaced);
      const receipt = verifyCompletedPhysicalReferenceErrorReceipt(f.module, f.receipt);
      expect(receipt.bindingId).toBe(plan.bindingId);
      expect(receipt.referenceKey).toBe(plan.referenceKey);
      expect(receipt.constructor.supportKey).toBe(f.pack.error.newReferenceError.key);
      expect(receipt.constructor.index).toBe(f.tx.physicalIndex(f.pack.error.newReferenceError));
      expect(receipt.constructor.signature.params).toEqual([{ kind: "externref" }]);
      expect(receipt.constructor.signature.results).toEqual([{ kind: "externref" }]);
      expect(receipt.types).toHaveLength(6);
      expect(receipt.globals).toHaveLength(1);
      expect(receipt.functions).toHaveLength(1);
      expect(receipt.types.map((row) => row.index)).toContain(receipt.errorType.index);
      expect(receipt.name.text).toBe("ReferenceError");
      expect(receipt.globals[0]!.index).toBe(receipt.name.globalIndex);
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(Object.isFrozen(receipt.constructor.descriptor.body)).toBe(true);
      expect(() => (receipt.constructor.descriptor.body as unknown[]).push({ op: "nop" })).toThrow();
      expect(WebAssembly.validate(new Uint8Array(emitBinary(f.module)))).toBe(true);
    },
  );
  it("rejects fabricated receipt and same-byte foreign module copies", () => {
    const f = completed();
    expect(() => verifyCompletedPhysicalReferenceErrorReceipt(f.module, structuredClone(f.receipt))).toThrow("forged");
    expect(() => verifyCompletedPhysicalReferenceErrorReceipt(structuredClone(f.module), f.receipt)).toThrow("foreign");
  });
  it("requires completed actual fills and does not manufacture a receipt", () => {
    const f = fixture();
    f.tx.freezeReservations();
    expect(() => completedPhysicalReferenceErrorReceipt(f.tx, f.pack, f.module)).toThrow("incomplete");
  });
  it("rejects same-byte foreign module during actual-token capture", () => {
    const f = fixture();
    f.tx.freezeReservations();
    fillPhysicalReferenceError(f.tx, f.pack);
    expect(() => completedPhysicalReferenceErrorReceipt(f.tx, f.pack, structuredClone(f.module))).toThrow(
      "actual token-owned",
    );
  });
  it.each(["constructor-body", "error-type", "literal-global", "literal-type", "signature"] as const)(
    "detects post-completion %s mutation",
    (kind) => {
      const f = completed();
      if (kind === "constructor-body") f.pack.error.newReferenceError.object.body = [{ op: "ref.null.extern" }];
      else if (kind === "error-type") {
        const type = f.pack.error.type.object;
        if (type.kind !== "struct") throw new Error("expected canonical Error struct");
        type.fields[0]!.mutable = true;
      } else if (kind === "literal-global") f.module.globals[0]!.init = [{ op: "ref.null.extern" }];
      else if (kind === "literal-type") {
        const type = f.pack.strings.types[0]!.object;
        if (type.kind !== "array") throw new Error("expected canonical string data");
        type.mutable = false;
      } else {
        const signature = f.module.types[f.receipt.constructor.signatureIndex]!;
        if (signature.kind !== "func") throw new Error("expected function type");
        signature.results = [];
      }
      expect(() => verifyCompletedPhysicalReferenceErrorReceipt(f.module, f.receipt)).toThrow();
    },
  );
  it("rejects revoked wrapper before any literal fill or completed receipt capture", () => {
    const f = fixture();
    f.tx.freezeReservations();
    f.revoke();
    const before = structuredClone(f.module);
    expect(() => fillPhysicalReferenceError(f.tx, f.pack)).toThrow("revoked");
    expect(f.module).toEqual(before);
    expect(() => completedPhysicalReferenceErrorReceipt(f.tx, f.pack, f.module)).toThrow("revoked");
  });
  it("uses actual imported function/global offsets and excludes foreign reference resources", () => {
    const f = fixture(true, true);
    const foreign = f.tx.reserveType("foreign:struct", {
      kind: "struct",
      name: "foreign",
      fields: [{ name: "value", type: { kind: "externref" }, mutable: false }],
    });
    f.tx.freezeReservations();
    fillPhysicalReferenceError(f.tx, f.pack);
    const receipt = completedPhysicalReferenceErrorReceipt(f.tx, f.pack, f.module);
    expect(receipt.constructor.index).toBe(1);
    expect(receipt.name.globalIndex).toBe(1);
    expect(receipt.types.some((row) => row.index === f.tx.physicalIndex(foreign))).toBe(false);
    expect(receipt.functions).toHaveLength(1);
    expect(receipt.globals).toHaveLength(1);
    f.tx.seal();
    f.revoke();
    expect(verifyCompletedPhysicalReferenceErrorReceipt(f.module, receipt)).toBe(receipt);
    expect(WebAssembly.validate(new Uint8Array(emitBinary(f.module)))).toBe(true);
  });
});
