import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
  requireCompletedNativeStringLiterals,
} from "../src/backend/wasmgc/resources/native-string-literals.js";

function fixture(oversized = false) {
  const tx = new PhysicalModuleReservations(createEmptyModule());
  const pack = reserveNativeStringLiteralResources(tx, {
    key: "completion",
    utf8Storage: true,
    literals: [
      { value: "", encoding: "utf8-guaranteed" },
      { value: "", encoding: "wtf16" },
      ...(oversized ? [{ value: "x".repeat(20001), encoding: "wtf16" as const }] : []),
    ],
  });
  return { tx, pack };
}

describe("native string producer completion", () => {
  it("selects UTF16 empty identity even when UTF8 is demanded first", () => {
    const { tx, pack } = fixture();
    const utf8 = requireNativeStringLiteral(tx, pack, "", "utf8-guaranteed");
    const utf16 = requireNativeStringLiteral(tx, pack, "", "wtf16");
    expect(utf8).not.toBe(utf16);
    expect(utf16).toBe(pack.literals[1]);
    expect(requireNativeStringLiteral(tx, pack, "")).toBe(utf8);
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, pack);
    expect(requireCompletedNativeStringLiterals(tx, pack)).toBe(pack);
  });
  it("rejects unfilled resources before accepting their genuine fill", () => {
    const { tx, pack } = fixture();
    expect(() => requireCompletedNativeStringLiterals(tx, pack)).toThrow("incomplete");
    tx.freezeReservations();
    expect(() => requireCompletedNativeStringLiterals(tx, pack)).toThrow("incomplete");
    fillNativeStringLiteralResources(tx, pack);
    expect(requireCompletedNativeStringLiterals(tx, pack)).toBe(pack);
  });
  it("rejects copied owners and foreign ledgers after a genuine positive", () => {
    const { tx, pack } = fixture();
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, pack);
    expect(requireCompletedNativeStringLiterals(tx, pack)).toBe(pack);
    expect(() => requireCompletedNativeStringLiterals(tx, { ...pack })).toThrow("forged");
    expect(() => requireCompletedNativeStringLiterals(fixture().tx, pack)).toThrow("foreign");
  });
  it("rejects altered completed globals", () => {
    const { tx, pack } = fixture();
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, pack);
    expect(requireCompletedNativeStringLiterals(tx, pack)).toBe(pack);
    const binding = requireNativeStringLiteral(tx, pack, "", "wtf16");
    if (binding.kind !== "global") throw Error("expected actual empty global");
    binding.global.object.init = [];
    expect(() => requireCompletedNativeStringLiterals(tx, pack)).toThrow("altered completed global");
  });
  it("rejects altered oversized literal bodies", () => {
    const { tx, pack } = fixture(true);
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, pack);
    expect(requireCompletedNativeStringLiterals(tx, pack)).toBe(pack);
    const binding = pack.literals[2]!;
    if (binding.kind !== "callable") throw Error("expected actual oversized helper");
    binding.function.object.body = [];
    expect(() => requireCompletedNativeStringLiterals(tx, pack)).toThrow("altered completed function");
  });
});
