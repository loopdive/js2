// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { applyClosureApplyExtraction } from "./helpers/object-runtime-apply-extraction.js";
import { applyFnctorGuardForward } from "./helpers/object-runtime-fnctor-guard-forward.js";
import { beforeDescriptorUndefinedCorrection } from "./helpers/descriptor-undefined-correction.js";
import { afterEach, describe, expect, it } from "vitest";
import type { Instr } from "../src/wasm/model/instructions.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeErrorResources,
  requireNativeErrorReservations,
  fillNativeErrorResources,
  requireCompletedNativeErrors,
} from "../src/backend/wasmgc/resources/native-errors.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  declareNativeObjectStorageResources,
  reserveNativeObjectStorageResources,
  requireNativeObjectStorageReservations,
  fillNativeObjectStorageResources,
  requireCompletedNativeObjectStorage,
  nativeObjectStorageReservationInventory,
} from "../src/backend/wasmgc/resources/native-object-storage.js";
import {
  objectStorageFixture,
  fillStorageDependencies,
  objectWriteRuntime,
} from "./helpers/native-object-write-fixture.js";
import {
  originalWriteDonors,
  readWriteSource,
  writeSourceHash,
  authenticateWriteExtraction,
  invertObjectWriteSource,
  writeExtractionText,
  writeRegisterScope,
  captureWriteDonor,
} from "./helpers/native-object-write-donor.js";

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
const complete = (f: ReturnType<typeof objectStorageFixture>) => {
  f.tx.freezeReservations();
  fillStorageDependencies(f);
  fillNativeObjectStorageResources(f.tx, f.pack);
  return requireCompletedNativeObjectStorage(f.tx, f.pack, f.dependencies);
};
const noAllocation = (f: ReturnType<typeof objectStorageFixture>, run: () => unknown) => {
  const before = structuredClone(f.module);
  expect(run).toThrow();
  expect(f.module).toStrictEqual(before);
};
function errorFixture() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: false,
    literals: [{ value: "TypeError", encoding: "wtf16" }],
  });
  const requirements = { key: "errors" },
    dependencies = { strings, typeErrorTag: -11 };
  const pack = reserveNativeErrorResources(tx, requirements, dependencies);
  return { module, tx, strings, requirements, dependencies, pack };
}
describe("canonical TypeError dependency assertions", () => {
  it("authenticates reservations separately from actual canonical completion", () => {
    const f = errorFixture();
    expect(Object.is(requireNativeErrorReservations(f.tx, f.pack, f.requirements, f.dependencies), f.pack)).toBe(true);
    f.tx.freezeReservations();
    fillNativeStringLiteralResources(f.tx, f.strings);
    expect(() => requireCompletedNativeErrors(f.tx, f.pack, f.requirements, f.dependencies)).toThrow(
      "missing canonical fill",
    );
    fillNativeErrorResources(f.tx, f.pack);
    expect(Object.is(requireCompletedNativeErrors(f.tx, f.pack, f.requirements, f.dependencies), f.pack)).toBe(true);
    expect(f.module.exports).toEqual([]);
  });
  it.each(["pack", "requirements", "dependencies"] as const)("rejects copied %s authority", (role) => {
    const f = errorFixture();
    expect(() =>
      requireNativeErrorReservations(
        f.tx,
        role === "pack" ? { ...f.pack } : f.pack,
        role === "requirements" ? { ...f.requirements } : f.requirements,
        role === "dependencies" ? { ...f.dependencies } : f.dependencies,
      ),
    ).toThrow();
  });
  it("rejects a foreign ledger and changed dependency tag", () => {
    const f = errorFixture(),
      other = errorFixture();
    expect(() => requireNativeErrorReservations(other.tx, f.pack, f.requirements, f.dependencies)).toThrow("foreign");
    f.dependencies.typeErrorTag = -12;
    expect(() => requireNativeErrorReservations(f.tx, f.pack, f.requirements, f.dependencies)).toThrow("substituted");
  });
  it("does not certify a byte-shaped external fill as the canonical owner", () => {
    const f = errorFixture();
    f.tx.freezeReservations();
    fillNativeStringLiteralResources(f.tx, f.strings);
    f.tx.fillFunction(f.pack.newTypeError, { locals: [], body: [{ op: "local.get", index: 0 }] });
    expect(() => requireCompletedNativeErrors(f.tx, f.pack, f.requirements, f.dependencies)).toThrow(
      "missing canonical fill",
    );
    expect(() => fillNativeErrorResources(f.tx, f.pack)).toThrow("duplicate function fill");
  });
  it("checks the complete key batch before appending a type", () => {
    const f = errorFixture();
    f.tx.reserveFunction("next:new-TypeError", "collision", { params: [], results: [] });
    const before = structuredClone(f.module);
    expect(() => reserveNativeErrorResources(f.tx, { key: "next" }, f.dependencies)).toThrow();
    expect(f.module).toStrictEqual(before);
  });
  it("rejects descriptor mutation after a genuine successful fill", () => {
    const f = errorFixture();
    f.tx.freezeReservations();
    fillNativeStringLiteralResources(f.tx, f.strings);
    fillNativeErrorResources(f.tx, f.pack);
    requireCompletedNativeErrors(f.tx, f.pack, f.requirements, f.dependencies);
    f.pack.newTypeError.object.body.push({ op: "nop" });
    expect(() => requireCompletedNativeErrors(f.tx, f.pack, f.requirements, f.dependencies)).toThrow(
      "altered completed function",
    );
  });
});
describe("issued ordinary storage prerequisite", () => {
  it("declares and completes every owned slot without publishing", () => {
    const f = objectStorageFixture(true),
      before = nativeObjectStorageReservationInventory(f.tx, f.pack);
    expect(before.functions).toHaveLength(5);
    expect(before.plan.declarations).toHaveLength(5);
    expect(Object.is(requireNativeObjectStorageReservations(f.tx, f.pack, f.dependencies), f.pack)).toBe(true);
    expect(f.module.exports).toEqual([]);
    expect(Object.is(complete(f), f.pack)).toBe(true);
    expect(
      nativeObjectStorageReservationInventory(f.tx, f.pack).functions.every((v, i) =>
        Object.is(v, before.functions[i]),
      ),
    ).toBe(true);
    expect(f.module.exports).toEqual([]);
  });
  it.each(["lookup", "lookupDependencies"] as const)("rejects copied %s before allocation", (role) => {
    const f = objectStorageFixture(),
      deps = { ...f.dependencies, [role]: { ...f.dependencies[role] } };
    noAllocation(f, () =>
      reserveNativeObjectStorageResources(
        f.tx,
        "copy",
        deps,
        declareNativeObjectStorageResources("copy", f.layouts.object.key),
      ),
    );
  });
  it("rejects a foreign lookup owner before allocation", () => {
    const f = objectStorageFixture(),
      other = objectStorageFixture();
    noAllocation(f, () =>
      reserveNativeObjectStorageResources(
        f.tx,
        "other",
        other.dependencies,
        declareNativeObjectStorageResources("other", f.layouts.object.key),
      ),
    );
  });
  it("rejects a changed plan before allocation", () => {
    const f = objectStorageFixture(),
      plan = structuredClone(f.plan),
      row = plan.declarations[0]!;
    if (row.space !== "function") throw Error("missing positive function row");
    (row.signature.results as { kind: string }[])[0] = { kind: "f64" };
    noAllocation(f, () => reserveNativeObjectStorageResources(f.tx, "storage", f.dependencies, plan));
  });
  it("preflights the last resource key before allocating the first", () => {
    const f = objectStorageFixture(),
      plan = declareNativeObjectStorageResources("next", f.layouts.object.key);
    f.tx.reserveFunction("next:grow", "collision", { params: [], results: [] });
    noAllocation(f, () => reserveNativeObjectStorageResources(f.tx, "next", f.dependencies, plan));
  });
  it("rejects copied owner and substituted expected dependency identity", () => {
    const f = objectStorageFixture();
    expect(() => requireNativeObjectStorageReservations(f.tx, { ...f.pack }, f.dependencies)).toThrow(
      "foreign or copied",
    );
    expect(() => requireNativeObjectStorageReservations(f.tx, f.pack, { ...f.dependencies })).toThrow(
      "foreign expected",
    );
  });
  it("requires actual lookup completion before writing any body", () => {
    const f = objectStorageFixture();
    f.tx.freezeReservations();
    const before = structuredClone(f.module);
    expect(() => fillNativeObjectStorageResources(f.tx, f.pack)).toThrow("missing canonical fill");
    expect(f.module).toStrictEqual(before);
  });
  it("detects dependency substitution after reservation", () => {
    const f = objectStorageFixture();
    f.dependencies.lookup = { ...f.lookup };
    expect(() => requireNativeObjectStorageReservations(f.tx, f.pack, f.dependencies)).toThrow(
      "substituted dependency",
    );
  });
  it("refuses completion after external prefill and duplicate fill", () => {
    const f = objectStorageFixture();
    f.tx.freezeReservations();
    fillStorageDependencies(f);
    f.tx.fillFunction(f.pack.createDefault, { locals: [], body: [{ op: "ref.null.extern" }] });
    expect(() => requireCompletedNativeObjectStorage(f.tx, f.pack, f.dependencies)).toThrow("missing canonical fill");
    expect(() => fillNativeObjectStorageResources(f.tx, f.pack)).toThrow("duplicate function fill");
    expect(f.tx.state).toBe("failed");
  });
  it("rejects mutation of a completed body", () => {
    const f = objectStorageFixture();
    complete(f);
    f.pack.grow.object.body.push({ op: "nop" });
    expect(() => requireCompletedNativeObjectStorage(f.tx, f.pack, f.dependencies)).toThrow(
      "altered completed function",
    );
  });
});

describe("executed issued storage with controlled descriptor dependencies", () => {
  it.each([false, true])("retains creation prototype channels and physical offsets (offset=%s)", (offset) => {
    const r = objectWriteRuntime(offset).runtime,
      implicit = r.createDefault(),
      nil = r.createNull();
    expect(r.stats(implicit)).toEqual([0, 0, 0, 0, 8]);
    expect(r.stats(nil)).toEqual([0, 0, 128, 0, 8]);
    expect(r.has(implicit, r.key(0))).toBe(2);
    expect(r.has(nil, r.key(0))).toBe(0);
    expect(r.has(r.createWithPrototype(implicit), r.key(0))).toBe(2);
    expect(r.has(r.createWithPrototype(nil), r.key(0))).toBe(0);
    expect(r.has(r.createWithPrototype(null), r.key(0))).toBe(0);
  });
  it("updates data without changing entry sequence or present null/undefined", () => {
    const r = objectWriteRuntime().runtime,
      o = r.createNull(),
      k = r.key(0),
      u = r.undefinedValue();
    r.insert(o, k, null, 7, 17);
    expect(r.entry(o, k)).toEqual([7, 17, null, null, null]);
    r.insert(o, k, u, 3, 29);
    const row = r.entry(o, k);
    expect(row.slice(0, 2)).toEqual([3, 17]);
    expect(Object.is(row[2], u)).toBe(true);
    expect(r.has(o, k)).toBe(1);
    expect(r.stats(o)[0]).toBe(1);
  });
  it("retains Symbol identity and a distinct string table key", () => {
    const r = objectWriteRuntime().runtime,
      o = r.createNull(),
      a = r.symbol(3),
      b = r.symbol(4);
    r.insert(o, a, 11, 7, 0);
    r.insert(o, b, 22, 7, 1);
    r.insert(o, r.key(3), 33, 7, 2);
    expect(r.entry(o, r.symbol(3))[2]).toBe(11);
    expect(r.entry(o, b)[2]).toBe(22);
    expect(r.entry(o, r.key(3))[2]).toBe(33);
  });
  it("grows actual tables, removes tombstones and preserves every live sequence", () => {
    const r = objectWriteRuntime().runtime,
      o = r.createNull();
    for (let i = 0; i < 16; i++) r.data(o, r.key(i), i * 3, 191);
    expect(r.stats(o)).toEqual([16, 0, 128, 16, 32]);
    r.tombstone(o, r.key(2));
    expect(r.stats(o).slice(0, 2)).toEqual([15, 1]);
    r.grow(o);
    expect(r.stats(o)).toEqual([15, 0, 128, 16, 64]);
    expect(r.has(o, r.key(2))).toBe(0);
    for (let i = 0; i < 16; i++) if (i !== 2) expect(r.entry(o, r.key(i)).slice(0, 3)).toEqual([7, i, i * 3]);
  });
  it("merges getter and setter halves in source order and preserves them across growth", () => {
    const getter = () => 7,
      setter = () => {},
      seen: unknown[][] = [];
    const r = objectWriteRuntime(false, (receiver, callee) => {
      seen.push([receiver, callee]);
      return 7;
    }).runtime;
    const o = r.createNull(),
      k = r.key(0),
      receiver = {};
    r.accessor(o, k, getter, null, 310);
    r.accessor(o, k, null, setter, 566);
    r.grow(o);
    const row = r.entry(o, k);
    expect(row.slice(0, 2)).toEqual([14, 0]);
    expect(Object.is(row[3], getter)).toBe(true);
    expect(Object.is(row[4], setter)).toBe(true);
    expect(r.get(o, k, receiver)).toEqual([1, 7]);
    expect(seen).toEqual([[receiver, getter]]);
  });
  it("generic attribute-only updates preserve an accessor and data updates clear old halves", () => {
    const r = objectWriteRuntime().runtime,
      o = r.createNull(),
      k = r.key(0),
      get = () => 8;
    r.accessor(o, k, get, null, 310);
    r.data(o, k, null, 16);
    const accessor = r.entry(o, k);
    expect(accessor[0]).toBe(12);
    expect(Object.is(accessor[3], get)).toBe(true);
    r.data(o, k, 19, 191);
    expect(r.entry(o, k)).toEqual([7, 0, 19, null, null]);
  });
  it("data descriptor attribute presence preserves omitted values and flags", () => {
    const r = objectWriteRuntime().runtime,
      o = r.createNull(),
      k = r.key(0);
    r.data(o, k, 4, 191);
    r.data(o, k, null, 16);
    expect(r.entry(o, k)).toEqual([5, 0, 4, null, null]);
    r.data(o, k, 6, 128);
    expect(r.entry(o, k)).toEqual([5, 0, 6, null, null]);
  });
  it.each(["data", "accessor"] as const)(
    "throws a tagged TypeError before adding a %s key on a non-extensible object",
    (operation) => {
      const f = objectWriteRuntime(),
        r = f.runtime,
        o = r.createNull();
      r.flags(o, 129);
      const before = r.stats(o);
      expect(() =>
        operation === "data" ? r.data(o, r.key(0), 1, 191) : r.accessor(o, r.key(0), () => 1, null, 310),
      ).toThrow();
      expect(f.errorValues).toHaveLength(1);
      expect(f.errorValues[0]).toBeInstanceOf(TypeError);
      expect(r.stats(o)).toEqual(before);
      expect(r.has(o, r.key(0))).toBe(0);
    },
  );
  it.each([
    ["configurable", 128 + 32 + 4, 1],
    ["enumerable", 128 + 16 + 2, 1],
    ["writable", 128 + 8 + 1, 1],
    ["changed value", 128, 2],
  ] as const)("rejects non-configurable data %s changes without mutation", (_label, mask, value) => {
    const f = objectWriteRuntime(),
      r = f.runtime,
      o = r.createNull(),
      k = r.key(0);
    r.data(o, k, 1, 128);
    expect(() => r.data(o, k, value, mask)).toThrow();
    expect(r.entry(o, k)).toEqual([0, 0, 1, null, null]);
    expect(f.errorValues).toHaveLength(1);
  });
  it("uses SameValue for frozen NaN and distinguishes positive/negative zero", () => {
    const r = objectWriteRuntime().runtime,
      o = r.createNull();
    r.data(o, r.key(0), NaN, 128);
    r.data(o, r.key(0), NaN, 128);
    r.data(o, r.key(1), 0, 128);
    expect(() => r.data(o, r.key(1), -0, 128)).toThrow();
    expect(Object.is(r.entry(o, r.key(1))[2], 0)).toBe(true);
  });
  it("retains non-configurable accessor identity and refuses a replaced half", () => {
    const f = objectWriteRuntime(),
      r = f.runtime,
      o = r.createNull(),
      k = r.key(0),
      get = r.closure(),
      replacement = r.closure();
    expect(r.invokeClosure(get)).toBe(1);
    expect(r.sameValue(get, get)).toBe(1);
    expect(r.sameValue(get, replacement)).toBe(0);
    r.accessor(o, k, get, null, 256);
    r.accessor(o, k, get, null, 256);
    expect(() => r.accessor(o, k, replacement, null, 256)).toThrow();
    expect(Object.is(r.entry(o, k)[3], get)).toBe(true);
    expect(f.errorValues).toHaveLength(1);
  });
  it("retains all SameValue donor families with explicit controlled primitive providers", () => {
    const r = objectWriteRuntime().runtime,
      object = r.createNull(),
      a = r.key(0),
      b = r.key(0),
      u = r.undefinedValue();
    for (const [x, y, expected] of [
      [null, null, 1],
      [u, u, 1],
      [true, true, 1],
      [true, false, 0],
      [1n, 1n, 1],
      [1n, 2n, 0],
      [a, b, 1],
      [a, r.key(1), 0],
      [object, object, 1],
      [object, r.createNull(), 0],
      [r.symbol(1), r.symbol(1), 1],
      [r.symbol(1), r.symbol(2), 0],
      [NaN, NaN, 1],
      [0, -0, 0],
    ] as const)
      expect(r.sameValue(x, y)).toBe(expected);
  });
  it("detects removal of the real accessor-copy arm after a passing growth control", () => {
    const getter = () => 7;
    const run = (mutant: boolean) => {
      const r = objectWriteRuntime(
        false,
        () => 7,
        mutant
          ? (body) => {
              let changed = 0;
              const visit = (value: unknown) => {
                if (!value || typeof value !== "object") return;
                const n = value as { op?: string; then?: Instr[] };
                if (n.op === "if" && n.then?.some((i) => i.op === "struct.set" && i.fieldIdx === 4)) {
                  n.then = [];
                  changed++;
                } else Object.values(value).forEach(visit);
              };
              visit(body);
              expect(changed).toBe(1);
              return body;
            }
          : undefined,
      ).runtime;
      const o = r.createNull(),
        k = r.key(0);
      r.accessor(o, k, getter, null, 310);
      r.grow(o);
      return { value: r.get(o, k, o)[1], undefinedValue: r.undefinedValue() };
    };
    expect(run(false).value).toBe(7);
    const mutant = run(true);
    expect(Object.is(mutant.value, mutant.undefinedValue)).toBe(true);
  });
});

// Authenticate and remove only the signed later invocation/main layers.
// The unchanged write receipt still checks its exact full source and offsets.
function readWriteLayerSource(path: string): string {
  const actual = beforeDescriptorUndefinedCorrection(path, readWriteSource(path));
  if (path !== "src/codegen/object-runtime.ts") return actual;
  const source = applyFnctorGuardForward(applyClosureApplyExtraction(actual, true), true);
  expect(applyClosureApplyExtraction(applyFnctorGuardForward(source, false), false)).toBe(actual);
  return source;
}

describe("fixed donor and whole-source preservation", () => {
  const donors = originalWriteDonors();
  it.each(donors)("reconstructs and forward-replays the complete original $file", (donor) => {
    expect(invertObjectWriteSource(donor.file, readWriteLayerSource(donor.file))).toBe(donor.source);
  });
  it.each([
    "__new_plain_object",
    "__obj_insert",
    "__obj_grow",
    "__defineProperty_value",
    "__defineProperty_accessor",
    "__object_is",
  ])("preserves %s instructions, locals and all acquisition effects", (name) => {
    const donor = donors.find((r) =>
      name === "__object_is"
        ? r.file.endsWith("enumeration.ts")
        : name.startsWith("__define")
          ? r.file.endsWith("descriptors.ts")
          : r.file.endsWith("object-runtime.ts"),
    )!;
    const before = writeRegisterScope(donor.source, name),
      after = writeRegisterScope(beforeDescriptorUndefinedCorrection(donor.file, readWriteSource(donor.file)), name);
    for (const flag of [false, true])
      for (const changing of [false, true]) {
        const options = { symbol: flag, own: flag, carrier: flag, offset: flag ? 29 : 0, changing };
        const original = captureWriteDonor(before, options),
          current = captureWriteDonor(after, options);
        expect(current).toStrictEqual(original);
      }
  });
  it.each(donors)("rejects an unowned edit in $file after a positive reconstruction", (donor) => {
    const source = readWriteLayerSource(donor.file);
    expect(invertObjectWriteSource(donor.file, source)).toBe(donor.source);
    expect(() => invertObjectWriteSource(donor.file, source + "\n// unowned edit\n")).toThrow("source mismatch");
  });
  it("rejects missing, duplicated, reordered and semantic span mutations", () => {
    const receipt = authenticateWriteExtraction();
    for (const d of receipt.deltas) {
      const current = readWriteLayerSource(d.file);
      expect(invertObjectWriteSource(d.file, current)).toBe(donors.find((r) => r.file === d.file)!.source);
      expect(d.spans.length).toBeGreaterThan(1);
      for (const span of d.spans)
        for (const replacement of ["", span.after + span.after, span.after.replace(/\S/, "!")]) {
          const changed = current.replace(span.after, replacement);
          expect(changed).not.toBe(current);
          expect(() => invertObjectWriteSource(d.file, changed)).toThrow("source mismatch");
        }
      const [a, b] = d.spans;
      const reordered = current.replace(a!.after, "\u0000").replace(b!.after, a!.after).replace("\u0000", b!.after);
      expect(reordered).not.toBe(current);
      expect(() => invertObjectWriteSource(d.file, reordered)).toThrow("source mismatch");
    }
  });
  it("rejects altered receipts, old-source substitution and unknown paths", () => {
    const text = writeExtractionText();
    expect(authenticateWriteExtraction(text).deltas).toHaveLength(3);
    expect(() => authenticateWriteExtraction(text + " ")).toThrow("receipt mismatch");
    const d = donors[0]!;
    expect(() => invertObjectWriteSource(d.file, d.source)).toThrow("source mismatch");
    expect(() => invertObjectWriteSource("unknown", "")).toThrow("unknown write donor path");
    expect(writeSourceHash(d.source)).toBe(d.sha256);
  });
});
