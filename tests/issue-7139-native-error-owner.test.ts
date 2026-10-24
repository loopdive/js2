// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import {
  reserveNativeErrorResources,
  requireNativeErrorReservations,
} from "../src/backend/wasmgc/resources/native-errors.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeErrorConstructor,
  requireNativeErrorConstructor,
  fillNativeErrorConstructor,
  requireCompletedNativeErrorConstructor,
} from "../src/backend/wasmgc/resources/native-error-constructor.js";
import { selectNativeErrorConstructorRequirements } from "../src/ir/program/native-error-setup.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
function fixture() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: false,
    literals: [{ value: "ReferenceError" }],
  });
  const requirements = { key: "errors", kind: "ReferenceError" as const },
    dependencies = { strings, tag: -16 };
  const pack = reserveNativeErrorConstructor(tx, requirements, dependencies);
  return { module, tx, strings, requirements, dependencies, pack };
}
it("authenticates the exact constructor/dependencies and rejects copied or stale owners", () => {
  const f = fixture();
  expect(requireNativeErrorConstructor(f.tx, f.pack, f.requirements, f.dependencies)).toBe(f.pack);
  expect(() => requireNativeErrorConstructor(f.tx, { ...f.pack }, f.requirements, f.dependencies)).toThrow(/forged/);
  expect(() => requireNativeErrorConstructor(f.tx, f.pack, { ...f.requirements }, f.dependencies)).toThrow(/stale/);
  expect(() => requireNativeErrorConstructor(f.tx, f.pack, f.requirements, { ...f.dependencies })).toThrow(/stale/);
  f.dependencies.tag = -11;
  expect(() => requireNativeErrorConstructor(f.tx, f.pack, f.requirements, f.dependencies)).toThrow(/stale/);
});
it("rejects a wrong ReferenceError brand before adding a constructor", () => {
  const f = fixture(),
    count = f.module.functions.length;
  expect(() =>
    reserveNativeErrorConstructor(f.tx, { key: "wrong", kind: "ReferenceError" }, { strings: f.strings, tag: -11 }),
  ).toThrow(/incorrect ReferenceError tag/);
  expect(f.module.functions).toHaveLength(count);
});
it("keeps the old TypeError adapter fixed to TypeError despite extra caller fields", () => {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: false,
    literals: [{ value: "TypeError" }, { value: "ReferenceError" }],
  });
  const requirements = { key: "compat", kind: "ReferenceError" as const };
  expect(() => reserveNativeErrorResources(tx, requirements, { strings, typeErrorTag: -16 })).toThrow(
    /incorrect TypeError tag/,
  );
  const dependencies = { strings, typeErrorTag: -11 },
    pack = reserveNativeErrorResources(tx, requirements, dependencies);
  expect(pack.newTypeError.object.name).toBe("__new_TypeError");
  expect(requireNativeErrorReservations(tx, pack, requirements, dependencies)).toBe(pack);
  requirements.key = "changed";
  expect(() => requireNativeErrorReservations(tx, pack, requirements, dependencies)).toThrow(/stale/);
});
it("rejects an altered header and layout", () => {
  const f = fixture();
  f.pack.construct.object.name = "forged";
  expect(() => requireNativeErrorConstructor(f.tx, f.pack, f.requirements, f.dependencies)).toThrow(
    /altered.*(header|descriptor)/,
  );
  const g = fixture();
  if (g.pack.type.object.kind !== "struct") throw Error("canonical Error is not struct");
  g.pack.type.object.fields[0]!.mutable = true;
  expect(() => requireNativeErrorConstructor(g.tx, g.pack, g.requirements, g.dependencies)).toThrow(/altered/);
});
it("requires actual canonical fill and rejects a modified completed constructor body", () => {
  const f = fixture();
  f.tx.freezeReservations();
  fillNativeStringLiteralResources(f.tx, f.strings);
  expect(() => requireCompletedNativeErrorConstructor(f.tx, f.pack, f.requirements, f.dependencies)).toThrow(
    /canonical fill/,
  );
  fillNativeErrorConstructor(f.tx, f.pack);
  expect(requireCompletedNativeErrorConstructor(f.tx, f.pack, f.requirements, f.dependencies)).toBe(f.pack);
  f.pack.construct.object.body = [{ op: "ref.null.extern" }];
  expect(() => requireCompletedNativeErrorConstructor(f.tx, f.pack, f.requirements, f.dependencies)).toThrow();
});
it("does not equate an arbitrary ledger fill with canonical error production", () => {
  const f = fixture();
  f.tx.freezeReservations();
  fillNativeStringLiteralResources(f.tx, f.strings);
  f.tx.fillFunction(f.pack.construct, { locals: [], body: [{ op: "ref.null.extern" }] });
  expect(() => requireCompletedNativeErrorConstructor(f.tx, f.pack, f.requirements, f.dependencies)).toThrow(
    /canonical fill/,
  );
});
it("selects the actual canonical provider and rejects a missing or altered signature", () => {
  const source =
    "let answer:number=0;try{answer=read();}catch(e){answer=17;}let value:number=3;function read():number{return value;}export function run():number{return answer*10+read();}";
  const program = requireProgram(prepareWholeIrProgram(sourceInput({ "./entry.ts": source })));
  const projection = program.runtime[0]!,
    demands = collectNativeStringValueDemands(program, projection);
  expect(selectNativeErrorConstructorRequirements(demands)?.kind).toBe("ReferenceError");
  const changed = (providers: typeof projection.prepared.manifest.providers) => ({
    ...demands,
    projection: {
      ...projection,
      prepared: { ...projection.prepared, manifest: { ...projection.prepared.manifest, providers } },
    },
  });
  expect(() => selectNativeErrorConstructorRequirements(changed([]))).toThrow(/unique selected/);
  const providers = projection.prepared.manifest.providers.map((row) =>
    row.feature === "error.reference.construct" ? { ...row, signature: { ...row.signature!, params: [] } } : row,
  );
  expect(() => selectNativeErrorConstructorRequirements(changed(providers))).toThrow(/noncanonical/);
});
