// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7350 B2a — the global object's population (`native-realm-globals.ts`). Every row the running node has is
// compared with node's `globalThis` descriptor; a row from a later edition than node's engine is compared with
// its spec values, written out below. Completeness is checked against a fresh V8 context, which holds only the
// engine's own globals (no node or web-platform host globals).
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CURRENT_DRAFT_EDITION } from "../scripts/generate-editions.ts";
import { NATIVE_REALM_CATALOG, NATIVE_REALM_EDITION } from "../src/runtime/contracts/native-realm-catalog.js";
import {
  NATIVE_REALM_GLOBALS,
  type NativeRealmGlobal,
  nativeRealmGlobalSurface,
  nativeRealmGlobalTypeof,
} from "../src/runtime/contracts/native-realm-globals.js";

/** Rows an engine may predate, with their spec values: Float16Array (ES2025), Temporal (ES2026). */
const SPEC_ROWS: Record<string, Pick<NativeRealmGlobal, "writable" | "configurable" | "value">> = {
  Float16Array: {
    writable: true,
    configurable: true,
    value: { kind: "function", id: "%Float16Array%", length: 3, construct: "ordinary" },
  },
  Temporal: { writable: true, configurable: true, value: { kind: "namespace", id: "%Temporal%" } },
};

/** The engine's own globals that ECMA-262 does not define: ECMA-402, the WebAssembly JS API, V8's console and
 * `--expose-gc`'s `gc`. */
const ENGINE_NON_ECMASCRIPT = new Set(["Intl", "WebAssembly", "console", "gc"]);

const isConstructor = (value: unknown): boolean => {
  try {
    Reflect.construct(String, [], value as new () => unknown);
    return true;
  } catch {
    return false;
  }
};
const newThrows = (value: unknown): boolean => {
  try {
    new (value as new () => unknown)();
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
};

const present = NATIVE_REALM_GLOBALS.filter((row) => Object.hasOwn(globalThis, row.name));

describe("#7350 B2a — the global object's population", () => {
  it.each(present.map((row) => [row.name, row] as const))("%s answers as node's globalThis", (name, row) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)!;
    expect({ writable: row.writable, enumerable: false, configurable: row.configurable }).toEqual({
      writable: descriptor.writable,
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable,
    });
    expect(nativeRealmGlobalTypeof(name)).toBe(typeof descriptor.value);
    const value = row.value;
    if (value.kind === "global-object") expect(descriptor.value).toBe(globalThis);
    if (value.kind === "number") expect(Object.is(value.value, descriptor.value)).toBe(true);
    if (value.kind === "function") {
      const fn = descriptor.value as (...args: unknown[]) => unknown;
      expect([value.length, fn.name]).toEqual([fn.length, name]);
      expect(value.construct !== "none").toBe(isConstructor(fn));
      // An ordinary constructor may also throw on missing arguments (`new Proxy()`), so only "throws" is pinned.
      if (value.construct === "throws") expect(newThrows(fn)).toBe(true);
    }
  });

  it.each(Object.entries(SPEC_ROWS))("%s carries its spec values", (name, expected) => {
    expect(NATIVE_REALM_GLOBALS.find((row) => row.name === name)).toEqual({ name, ...expected });
  });

  it("lacks from node only rows of a later edition than node's engine", () => {
    const absent = NATIVE_REALM_GLOBALS.filter((row) => !Object.hasOwn(globalThis, row.name)).map((row) => row.name);
    expect(absent.filter((name) => !Object.hasOwn(SPEC_ROWS, name))).toEqual([]);
  });

  it("lists every ECMAScript global of the engine", () => {
    const listed = new Set(NATIVE_REALM_GLOBALS.map((row) => row.name));
    const engine = runInNewContext("Object.getOwnPropertyNames(globalThis)") as string[];
    expect(engine.filter((name) => !listed.has(name) && !ENGINE_NON_ECMASCRIPT.has(name))).toEqual([]);
  });

  it("models the newest ratified edition", () => {
    expect(NATIVE_REALM_EDITION).toBe(CURRENT_DRAFT_EDITION - 1);
    expect(NATIVE_REALM_CATALOG.version).toBe(`ecma262-${NATIVE_REALM_EDITION}:Object+Function:v1`);
  });

  it("agrees with the catalog on the rows the catalog completes", () => {
    const complete = NATIVE_REALM_GLOBALS.flatMap((row) =>
      row.value.kind === "function" && nativeRealmGlobalSurface(row.value.id) === "complete" ? [row.value] : [],
    );
    expect(complete.map((value) => value.id)).toEqual(["%Function%", "%Object%"]);
    for (const value of complete) {
      const row = NATIVE_REALM_CATALOG.intrinsics.find((intrinsic) => intrinsic.id === value.id)!;
      expect([value.length, value.construct !== "none"]).toEqual([row.callable!.length, row.constructible]);
    }
  });

  it("names each intrinsic once and refuses an id it does not name", () => {
    const ids = NATIVE_REALM_GLOBALS.flatMap((row) => ("id" in row.value ? [row.value.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
    expect(nativeRealmGlobalSurface("%TypeError%")).toBe("identity");
    expect(() => nativeRealmGlobalSurface("%TypError%")).toThrow("not a global intrinsic");
  });

  it("answers no typeof for a name that is not a language global", () => {
    for (const name of ["console", "print", "Intl", "document"])
      expect(nativeRealmGlobalTypeof(name)).toBe("not-a-language-global");
    expect(nativeRealmGlobalTypeof("undefined")).toBe("undefined");
    expect(nativeRealmGlobalTypeof("Temporal")).toBe("object");
  });

  it("shapes the Annex B functions as the catalog's Normative Optional rows", () => {
    const legacy = NATIVE_REALM_GLOBALS.filter((row) => row.legacy);
    expect(legacy.map((row) => [row.name, row.normativeOptional])).toEqual([
      ["escape", true],
      ["unescape", true],
    ]);
  });
});
