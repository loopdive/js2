// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7350 B2a — the global object's population (`shared/contracts/native-realm-globals.ts`). Every row the running node has is
// compared with node's `globalThis` descriptor; a row from a later edition than node's engine is compared with
// its spec values, written out below. Completeness is checked against a fresh V8 context, which holds only the
// engine's own globals (no node or web-platform host globals).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CURRENT_DRAFT_EDITION } from "../scripts/generate-editions.ts";
import { classifyTestScope, parseMeta } from "./test262-runner.js";
import { NATIVE_REALM_CATALOG, nativeRealmGlobalSurface } from "../src/runtime/contracts/native-realm-catalog.js";
import {
  NATIVE_REALM_EDITION,
  NATIVE_REALM_GLOBALS,
  type NativeRealmGlobal,
  nativeRealmGlobalTypeof,
} from "../src/shared/contracts/native-realm-globals.js";

const DRAFT = NATIVE_REALM_EDITION + 1;
const callable = (
  id: string,
  length: number,
  edition = NATIVE_REALM_EDITION,
  [prototype, parent] = ["%Function.prototype%", "%Object.prototype%"],
) =>
  ({
    edition,
    writable: true,
    configurable: true,
    value: {
      kind: "function",
      id,
      length,
      construct: "ordinary",
      prototype,
      prototypeObject: { id: id.slice(0, -1) + ".prototype%", prototype: parent },
    },
  }) as const;

/**
 * Rows an engine may predate, with their spec values: Float16Array (ES2025), Temporal (ES2026), and the
 * explicit-resource-management globals of the draft (node 25 has them, node 22 does not).
 */
const SPEC_ROWS: Record<string, Omit<NativeRealmGlobal, "name">> = {
  Float16Array: callable("%Float16Array%", 3, NATIVE_REALM_EDITION, ["%TypedArray%", "%TypedArray.prototype%"]),
  Temporal: {
    edition: NATIVE_REALM_EDITION,
    writable: true,
    configurable: true,
    value: { kind: "namespace", id: "%Temporal%" },
  },
  AsyncDisposableStack: callable("%AsyncDisposableStack%", 0, DRAFT),
  DisposableStack: callable("%DisposableStack%", 0, DRAFT),
  SuppressedError: callable("%SuppressedError%", 3, DRAFT, ["%Error%", "%Error.prototype%"]),
};

/**
 * Directories under test262's `built-ins/` that name no global: intrinsics reached only from another object
 * (`%TypedArray%`, the iterator and function prototypes, %ThrowTypeError%), the NativeError group (its
 * constructors are rows) and the global object's own tests.
 */
const NON_GLOBAL_DIRECTORIES = new Set([
  "ArrayIteratorPrototype",
  "AsyncFromSyncIteratorPrototype",
  "AsyncFunction",
  "AsyncGeneratorFunction",
  "AsyncGeneratorPrototype",
  "AsyncIteratorPrototype",
  "GeneratorFunction",
  "GeneratorPrototype",
  "MapIteratorPrototype",
  "NativeErrors",
  "RegExpStringIteratorPrototype",
  "SetIteratorPrototype",
  "StringIteratorPrototype",
  "ThrowTypeError",
  "TypedArray",
  "TypedArrayConstructors",
  "global",
]);

/**
 * `ShadowRealm` is a stage 2.7 proposal that no edition or draft defines; the runner's classifier still scores its
 * tests as standard (only `import-defer` and `source-phase-imports` are proposal features). It is not a row: the
 * Prepared path refuses it by name instead of calling it a language global.
 */
const RUNNER_STANDARD_PROPOSALS = new Set(["ShadowRealm"]);

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

/** node's object for an intrinsic id the table links to (`null` is no object). */
function intrinsic(id: string | null): unknown {
  if (id === null) return null;
  const path = id.slice(1, -1).split(".");
  const root =
    path[0] === "TypedArray" ? Object.getPrototypeOf(Int8Array) : (globalThis as Record<string, unknown>)[path[0]!];
  return path.slice(1).reduce((object, key) => (object as Record<string, unknown>)[key], root);
}

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
      // (#7350 B2b) The links the realm builds the callable's identity surface from.
      expect(Object.getPrototypeOf(fn)).toBe(intrinsic(value.prototype));
      expect(value.prototypeObject === null).toBe(!Object.hasOwn(fn, "prototype"));
      if (value.prototypeObject) {
        expect(fn.prototype).toBe(intrinsic(value.prototypeObject.id));
        expect(Object.getPrototypeOf(fn.prototype)).toBe(intrinsic(value.prototypeObject.prototype));
      }
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

  it("models the newest ratified edition, and the draft after it", () => {
    const charts = readFileSync("website/components/t262-charts.js", "utf8");
    const chartsDraft = Number(/const T262_CURRENT_DRAFT_EDITION_YEAR = (\d+);/.exec(charts)?.[1]);
    expect([NATIVE_REALM_EDITION, DRAFT, DRAFT]).toEqual([
      CURRENT_DRAFT_EDITION - 1,
      CURRENT_DRAFT_EDITION,
      chartsDraft,
    ]);
    expect(NATIVE_REALM_CATALOG.version).toBe(`ecma262-${NATIVE_REALM_EDITION}:Object+Function:v1`);
    expect(new Set(NATIVE_REALM_GLOBALS.map((row) => row.edition))).toEqual(new Set([NATIVE_REALM_EDITION, DRAFT]));
  });

  it("lists every global the runner's classifier scores as standard", () => {
    const root = "test262/test/built-ins";
    const listed = new Set(NATIVE_REALM_GLOBALS.map((row) => row.name));
    const standard = readdirSync(root).filter((directory) => {
      if (NON_GLOBAL_DIRECTORIES.has(directory)) return false;
      const files = readdirSync(join(root, directory), { recursive: true }) as string[];
      return files.some((file) => {
        if (!file.endsWith(".js") || file.endsWith("_FIXTURE.js")) return false;
        const path = join(root, directory, file);
        const source = readFileSync(path, "utf8");
        return classifyTestScope(source, parseMeta(source), path).scope === "standard";
      });
    });
    expect(standard.filter((name) => !listed.has(name))).toEqual([...RUNNER_STANDARD_PROPOSALS]);
  });

  it("marks exactly the spec's constructors whose `new X()` throws", () => {
    const throws = NATIVE_REALM_GLOBALS.filter(
      (row) => row.value.kind === "function" && row.value.construct === "throws",
    );
    expect(throws.map((row) => row.name)).toEqual(["BigInt", "Iterator", "Symbol"]);
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
