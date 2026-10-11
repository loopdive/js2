// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyModule, type StructTypeDef, type SubTypeDef } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  canonicalHashOfTypeGroup,
  RUNTIME_RECGROUP_ABI_VERSION,
  verifyRuntimeRecGroupBinary,
} from "../src/emit/canonical-recgroup.js";

const forms = [
  "plain",
  "inline final",
  "wrapped final",
  "inline open",
  "inline implicit open",
  "wrapped open",
  "ignored final metadata",
] as const;
type Form = (typeof forms)[number];
const isOpen = (form: Form) => form.includes("open");
function shape(form: Form): StructTypeDef | SubTypeDef {
  const plain: StructTypeDef = { kind: "struct", name: "Renamable", fields: [] };
  if (form === "inline final") return { ...plain, superTypeIdx: -1, final: true };
  if (form === "inline open") return { ...plain, superTypeIdx: -1, final: false };
  if (form === "inline implicit open") return { ...plain, superTypeIdx: -1 };
  if (form === "ignored final metadata") return { ...plain, final: false };
  if (form === "wrapped open" || form === "wrapped final")
    return { kind: "sub", name: "Outer", superType: null, final: form === "wrapped final", type: plain };
  return plain;
}
function runtime(form: Form, offset: boolean) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  if (offset) tx.reserveType("prefix", { kind: "array", name: "Prefix", element: { kind: "i64" }, mutable: false });
  const definition = shape(form),
    root = tx.reserveType("root", { kind: "rec", types: [definition] });
  const make = tx.reserveFunction("make", "make", { params: [], results: [{ kind: "externref" }] });
  const accepts = tx.reserveFunction("accepts", "accepts", {
    params: [{ kind: "externref" }],
    results: [{ kind: "i32" }],
  });
  tx.freezeReservations();
  tx.fillFunction(make, {
    locals: [],
    body: [{ op: "struct.new", typeIdx: root.typeIndex }, { op: "extern.convert_any" }],
  });
  tx.fillFunction(accepts, {
    locals: [],
    body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: root.typeIndex }],
  });
  tx.defineExport("export:make", "make", make);
  tx.defineExport("export:accepts", "accepts", accepts);
  tx.seal();
  const bytes = emitBinary(module),
    wasm = new WebAssembly.Module(bytes as BufferSource);
  return {
    bytes,
    fingerprint: {
      abiVersion: RUNTIME_RECGROUP_ABI_VERSION,
      count: 1,
      members: ["root"],
      hash: canonicalHashOfTypeGroup([definition], [root.typeIndex]),
    },
    api: new WebAssembly.Instance(wasm).exports as { make: () => unknown; accepts: (value: unknown) => number },
  };
}
for (const offset of [false, true])
  describe("emitted root finality, shifted=" + offset, () => {
    let modules: Record<Form, ReturnType<typeof runtime>>;
    beforeAll(() => {
      modules = Object.fromEntries(forms.map((form) => [form, runtime(form, offset)])) as typeof modules;
    });
    for (const left of forms)
      it.each(forms)(left + " matches engine canonicalization against %s", (right) => {
        const a = modules[left],
          b = modules[right],
          expected = isOpen(left) === isOpen(right);
        expect(a.api.accepts(b.api.make())).toBe(Number(expected));
        expect(a.fingerprint.hash === b.fingerprint.hash).toBe(expected);
        expect(verifyRuntimeRecGroupBinary(a.bytes, b.fingerprint).valid).toBe(expected);
      });
    it.each(forms)("verifies its own emitted bytes for %s", (form) => {
      expect(verifyRuntimeRecGroupBinary(modules[form].bytes, modules[form].fingerprint).valid).toBe(true);
    });
  });
it.each(forms)("preserves shifted coordinate identity for %s", (form) => {
  const first = runtime(form, false),
    shifted = runtime(form, true);
  expect(first.fingerprint.hash).toBe(shifted.fingerprint.hash);
  expect(first.api.accepts(shifted.api.make())).toBe(1);
});
it("refuses the old colliding fingerprint ABI", () => {
  const r = runtime("inline open", false);
  expect(RUNTIME_RECGROUP_ABI_VERSION).toBeGreaterThan(2);
  expect(verifyRuntimeRecGroupBinary(r.bytes, { ...r.fingerprint, abiVersion: 2 })).toMatchObject({ valid: false });
});

for (const kind of ["array", "func"] as const) {
  it.each([false, true])("normalizes " + kind + " roots against emitted bytes, shifted=%s", (offset) => {
    const inner =
      kind === "array"
        ? { kind: "array" as const, name: "Array", element: { kind: "i64" as const }, mutable: false }
        : { kind: "func" as const, params: [], results: [] };
    const representations = [
      inner,
      { kind: "sub" as const, superType: null, final: true, type: inner },
      { kind: "sub" as const, superType: null, final: false, type: inner },
    ];
    const fingerprints = representations.map((definition) => {
      const module = createEmptyModule();
      if (offset) module.types.push({ kind: "struct", name: "Prefix", fields: [] });
      module.types.push({ kind: "rec", types: [definition] });
      const bytes = emitBinary(module);
      expect(WebAssembly.validate(bytes as BufferSource)).toBe(true);
      const fingerprint = {
        abiVersion: RUNTIME_RECGROUP_ABI_VERSION,
        count: 1,
        members: [kind],
        hash: canonicalHashOfTypeGroup([definition], [Number(offset)]),
      };
      expect(verifyRuntimeRecGroupBinary(bytes, fingerprint).valid).toBe(true);
      return { bytes, fingerprint };
    });
    expect(fingerprints[0]!.fingerprint.hash).toBe(fingerprints[1]!.fingerprint.hash);
    expect(fingerprints[0]!.fingerprint.hash).not.toBe(fingerprints[2]!.fingerprint.hash);
    expect(verifyRuntimeRecGroupBinary(fingerprints[2]!.bytes, fingerprints[0]!.fingerprint).valid).toBe(false);
  });
}
