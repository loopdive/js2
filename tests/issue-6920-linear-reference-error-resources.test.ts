// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";
import * as errorBodies from "../src/runtime/wasmgc/values/error-bodies.js";
import { createErrorStructType } from "../src/runtime/wasmgc/values/string-layouts.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveLinearReferenceErrorResources,
  requireLinearReferenceErrorResources,
  linearReferenceErrorConstructorIndex,
  fillLinearReferenceErrorResources,
  requireCompletedLinearReferenceErrorResources,
} from "../src/backend/linear/program/reference-error.js";

function fixture(displaced = false, text = "ReferenceError") {
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  if (displaced)
    tx.reserveType("fixture:prefix", {
      kind: "rec",
      types: [
        { kind: "struct", name: "prefix-a", fields: [], superTypeIdx: -1 },
        { kind: "struct", name: "prefix-b", fields: [], superTypeIdx: -1 },
      ],
    });
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "fixture:strings",
    utf8Storage: false,
    literals: [{ value: text }],
  });
  const requirements = { key: "fixture:ReferenceError" };
  const dependencies = { strings, referenceErrorTag: -16 };
  let live = true;
  const guard = () => {
    if (!live) throw new Error("whole attempt revoked");
  };
  const pack = reserveLinearReferenceErrorResources(tx, requirements, dependencies, guard);
  return {
    module,
    tx,
    strings,
    requirements,
    dependencies,
    pack,
    guard,
    revoke: () => {
      live = false;
    },
  };
}
function complete(f: ReturnType<typeof fixture>) {
  f.tx.freezeReservations();
  fillNativeStringLiteralResources(f.tx, f.strings);
  fillLinearReferenceErrorResources(f.tx, f.pack);
  requireCompletedLinearReferenceErrorResources(f.tx, f.pack);
}

describe("native Linear canonical ReferenceError resources", () => {
  it.each([false, true])(
    "executes actual Error struct, name, external message and shared exception tag, displaced=%s",
    async (displaced) => {
      const f = fixture(displaced);
      const ext = { kind: "externref" as const };
      const i32 = { kind: "i32" as const };
      expect(f.pack.type.object).toEqual(createErrorStructType());
      expect(f.pack.newReferenceError.object.body).toEqual([]);
      const tag = f.tx.reserveTag(
        "fixture:exception",
        { params: [ext], results: [] },
        { kind: "defined", name: "__exn" },
      );
      const observers = [i32, ext, ext].map((result, index) =>
        f.tx.reserveFunction(`fixture:field:${index}`, `field${index}`, { params: [ext], results: [result] }),
      );
      const nameLength = f.tx.reserveFunction("fixture:name-length", "nameLength", { params: [ext], results: [i32] });
      const nameChar = f.tx.reserveFunction("fixture:name-char", "nameChar", { params: [ext, i32], results: [i32] });
      const throwError = f.tx.reserveFunction("fixture:throw", "throwError", { params: [ext], results: [] });
      complete(f);
      const type = f.tx.physicalIndex(f.pack.type);
      const readName = [
        { op: "local.get" as const, index: 0 },
        { op: "any.convert_extern" as const },
        { op: "ref.cast" as const, typeIdx: type },
        { op: "struct.get" as const, typeIdx: type, fieldIdx: 2 },
        { op: "any.convert_extern" as const },
        { op: "ref.cast" as const, typeIdx: f.strings.layout.nativeStrTypeIdx },
      ];
      observers.forEach((token, fieldIdx) =>
        f.tx.fillFunction(token, {
          locals: [],
          body: [
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: type },
            { op: "struct.get", typeIdx: type, fieldIdx },
          ],
        }),
      );
      f.tx.fillFunction(nameLength, {
        locals: [],
        body: [...readName, { op: "struct.get", typeIdx: f.strings.layout.nativeStrTypeIdx, fieldIdx: 0 }],
      });
      f.tx.fillFunction(nameChar, {
        locals: [],
        body: [
          ...readName,
          { op: "struct.get", typeIdx: f.strings.layout.nativeStrTypeIdx, fieldIdx: 2 },
          { op: "local.get", index: 1 },
          { op: "array.get_u", typeIdx: f.strings.layout.nativeStrDataTypeIdx },
        ],
      });
      f.tx.fillFunction(throwError, {
        locals: [],
        body: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: linearReferenceErrorConstructorIndex(f.tx, f.pack) },
          { op: "throw", tagIdx: f.tx.physicalIndex(tag) },
        ],
      });
      for (const token of [f.pack.newReferenceError, ...observers, nameLength, nameChar, throwError])
        f.tx.defineExport(`fixture:export:${token.key}`, token.object.name, token);
      f.tx.defineExport("fixture:export:tag", "__exn", tag);
      requireCompletedLinearReferenceErrorResources(f.tx, f.pack);
      f.tx.seal();
      const bytes = new Uint8Array(emitBinary(f.module));
      expect(WebAssembly.validate(bytes)).toBe(true);
      const wasm = await WebAssembly.instantiate(bytes, {});
      const exports = wasm.instance.exports;
      const ctor = exports.__new_ReferenceError as (message: unknown) => unknown;
      const field0 = exports.field0 as (error: unknown) => number;
      const field1 = exports.field1 as (error: unknown) => unknown;
      const field2 = exports.field2 as (error: unknown) => unknown;
      const message = { actual: "external identity" };
      const error = ctor(message);
      const other = ctor(null);
      expect(field0(error)).toBe(-16);
      expect(field1(error)).toBe(message);
      expect(field1(other)).toBeNull();
      expect(Object.is(field2(other), field2(error))).toBe(true);
      expect(Object.is(other, error)).toBe(false);
      expect((exports.nameLength as (e: unknown) => number)(error)).toBe("ReferenceError".length);
      expect(
        Array.from("ReferenceError", (_, index) =>
          (exports.nameChar as (e: unknown, i: number) => number)(error, index),
        ),
      ).toEqual(Array.from("ReferenceError", (char) => char.charCodeAt(0)));
      let thrown: unknown;
      try {
        (exports.throwError as (m: unknown) => void)(message);
      } catch (caught) {
        thrown = caught;
      }
      expect(thrown).toBeInstanceOf(WebAssembly.Exception);
      const exception = thrown as WebAssembly.Exception;
      expect(exception.is(exports.__exn as WebAssembly.Tag)).toBe(true);
      const payload = exception.getArg(exports.__exn as WebAssembly.Tag, 0);
      expect(field0(payload)).toBe(-16);
      expect(field1(payload)).toBe(message);
      expect(Object.is(field2(payload), field2(error))).toBe(true);
      expect(f.module.imports).toEqual([]);
    },
  );

  it("uses exact canonical body with real type and literal coordinates", () => {
    const f = fixture();
    complete(f);
    const name = requireNativeStringLiteral(f.tx, f.strings, "ReferenceError");
    if (name.kind !== "global") throw new Error("canonical short name did not select native global");
    expect(f.pack.newReferenceError.object.body).toEqual(
      errorBodies.buildErrorConstructorBody(f.tx.physicalIndex(f.pack.type), -16, 1, {
        kind: "global",
        index: f.tx.physicalIndex(name.global),
        representation: "gc",
      }),
    );
    expect(f.pack.newReferenceError.object.locals).toEqual([]);
    requireCompletedLinearReferenceErrorResources(f.tx, f.pack);
  });
  it("requires actual ReferenceError name dependency and rejects TypeError's tag before allocation", () => {
    const f = fixture();
    const before = structuredClone(f.module);
    expect(() =>
      reserveLinearReferenceErrorResources(
        f.tx,
        { key: "wrong-tag" },
        { strings: f.strings, referenceErrorTag: -11 },
        f.guard,
      ),
    ).toThrow("incorrect ReferenceError tag");
    expect(f.module).toEqual(before);
    const module = createEmptyModule();
    const tx = new PhysicalModuleReservations(module);
    const strings = reserveNativeStringLiteralResources(tx, {
      key: "wrong-name",
      utf8Storage: false,
      literals: [{ value: "TypeError" }],
    });
    const original = structuredClone(module);
    expect(() =>
      reserveLinearReferenceErrorResources(tx, { key: "missing-name" }, { strings, referenceErrorTag: -16 }, () => {}),
    ).toThrow("missing literal");
    expect(module).toEqual(original);
  });
  it("rejects forged pack and substituted producer identities", () => {
    const f = fixture();
    expect(() => requireLinearReferenceErrorResources(f.tx, { ...f.pack }, f.requirements, f.dependencies)).toThrow(
      "forged",
    );
    expect(() => requireLinearReferenceErrorResources(f.tx, f.pack, { ...f.requirements }, f.dependencies)).toThrow(
      "substituted",
    );
    expect(() => requireLinearReferenceErrorResources(f.tx, f.pack, f.requirements, f.dependencies)).toThrow("failed");
  });
  it("makes foreign transaction use and stale dependencies terminal", () => {
    const f = fixture();
    expect(() =>
      requireLinearReferenceErrorResources(
        new PhysicalModuleReservations(createEmptyModule()),
        f.pack,
        f.requirements,
        f.dependencies,
      ),
    ).toThrow("foreign");
    expect(() => requireLinearReferenceErrorResources(f.tx, f.pack, f.requirements, f.dependencies)).toThrow("failed");
    const other = fixture();
    other.dependencies.referenceErrorTag = -11;
    expect(() =>
      requireLinearReferenceErrorResources(other.tx, other.pack, other.requirements, other.dependencies),
    ).toThrow("stale");
  });
  it("phase misuse and missing literal fill cannot be rehabilitated", () => {
    const f = fixture();
    expect(() => linearReferenceErrorConstructorIndex(f.tx, f.pack)).toThrow("frozen");
    f.tx.freezeReservations();
    expect(() => fillLinearReferenceErrorResources(f.tx, f.pack)).toThrow("failed");
    const other = fixture();
    other.tx.freezeReservations();
    expect(() => fillLinearReferenceErrorResources(other.tx, other.pack)).toThrow("incomplete literal");
    fillNativeStringLiteralResources(other.tx, other.strings);
    expect(() => fillLinearReferenceErrorResources(other.tx, other.pack)).toThrow("failed");
  });
  it("terminally handles canonical construction failure before kernel fill", () => {
    const f = fixture();
    f.tx.freezeReservations();
    fillNativeStringLiteralResources(f.tx, f.strings);
    const spy = vi.spyOn(errorBodies, "buildErrorConstructorBody").mockImplementation(() => {
      throw new Error("canonical constructor fault");
    });
    try {
      expect(() => fillLinearReferenceErrorResources(f.tx, f.pack)).toThrow("constructor fault");
      expect(f.pack.newReferenceError.object.body).toEqual([]);
      expect(() => linearReferenceErrorConstructorIndex(f.tx, f.pack)).toThrow("failed");
    } finally {
      spy.mockRestore();
    }
  });
  it("rejects duplicate fill, corrupted tokens and incomplete completion", () => {
    const f = fixture();
    complete(f);
    expect(() => fillLinearReferenceErrorResources(f.tx, f.pack)).toThrow("single unfilled");
    expect(() => requireCompletedLinearReferenceErrorResources(f.tx, f.pack)).toThrow("failed");
    const other = fixture();
    other.tx.freezeReservations();
    other.pack.newReferenceError.object.name = "fake";
    expect(() => linearReferenceErrorConstructorIndex(other.tx, other.pack)).toThrow();
    const unfilled = fixture();
    unfilled.tx.freezeReservations();
    expect(() => requireCompletedLinearReferenceErrorResources(unfilled.tx, unfilled.pack)).toThrow("incomplete");
  });
  it("guard revocation rejects all live bindings after successful fill", () => {
    const f = fixture();
    complete(f);
    f.revoke();
    expect(() => linearReferenceErrorConstructorIndex(f.tx, f.pack)).toThrow("revoked");
    expect(() => requireCompletedLinearReferenceErrorResources(f.tx, f.pack)).toThrow("failed");
  });
});
