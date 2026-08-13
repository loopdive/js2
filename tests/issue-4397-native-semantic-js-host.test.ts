// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { sourceMayContainRuntimeEvalBoundary } from "../src/ir/runtime-eval-boundary-plan.js";
import { buildCompiledAdapterImports, buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

function wasmImports(binary: Uint8Array): WebAssembly.ModuleImportDescriptor[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(binary));
}

async function instantiate(source: string, semanticProviders?: "native-first") {
  const result = await compile(source, {
    fileName: `issue-4397-${semanticProviders ?? "host-assisted"}.ts`,
    semanticProviders,
  });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return { result, imports, instance, exports: wrapCompiledExports(result, instance) };
}

describe("#4397 native semantics in a JavaScript environment", () => {
  it("skips runtime-eval planning for definitely irrelevant source while retaining ambiguous spellings", () => {
    const source = (text: string) => ts.createSourceFile("runtime-eval-gate.ts", text, ts.ScriptTarget.Latest, true);
    expect(sourceMayContainRuntimeEvalBoundary(source("export const value = 1;"))).toBe(false);
    expect(sourceMayContainRuntimeEvalBoundary(source("export const value = eval('1');"))).toBe(true);
    expect(sourceMayContainRuntimeEvalBoundary(source("export const value = new Function('return 1');"))).toBe(true);
    expect(sourceMayContainRuntimeEvalBoundary(source("function __runtime_direct_eval() {}"))).toBe(true);
    expect(sourceMayContainRuntimeEvalBoundary(source(String.raw`export const value = \u0065val;`))).toBe(true);
  });

  it("keeps provider-owned caller realm state representation-neutral", async () => {
    const result = await compile(
      `
        var callerRealm: any = undefined;
        export function __runtime_new_function(_params: any, _body: any, realm: any): any {
          callerRealm = realm;
          return callerRealm;
        }
        export function __runtime_indirect_eval(_source: any, realm: any): any {
          callerRealm = realm;
          return callerRealm;
        }
        export function __runtime_direct_eval(_source: any, realm: any): any {
          callerRealm = realm;
          return callerRealm;
        }
        export function __runtime_apply_interpreted(_callable: any, realm: any): any {
          callerRealm = realm;
          return callerRealm;
        }
      `,
      {
        fileName: "issue-4397-runtime-eval-provider-realm.ts",
        target: "standalone",
        experimentalIR: false,
        emitWat: true,
        skipSemanticDiagnostics: true,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(result.wat).toContain("(global $__mod_callerRealm (mut externref)");
  });

  it("builds native-first imports without installing compatibility semantics into ambient intrinsics", async () => {
    const native = await compile(`export function value(): number { return 1; }`, {
      fileName: "issue-4397-no-ambient-compat.ts",
      semanticProviders: "native-first",
    });
    expect(native.success, native.errors.map((error) => error.message).join("; ")).toBe(true);

    let definitions = 0;
    const observedRegExp = new Proxy(function BoundaryRegExp() {}, {
      defineProperty(target, key, descriptor) {
        definitions += 1;
        return Reflect.defineProperty(target, key, descriptor);
      },
    });
    buildCompiledImports(native, { RegExp: observedRegExp });
    expect(definitions).toBe(0);
    expect(native.adapterManifest).toMatchObject({
      schemaVersion: 1,
      targetProfile: { semanticProviders: "native-first" },
    });
    expect(Object.isFrozen(native.adapterManifest)).toBe(true);
    expect(Object.isFrozen(native.adapterManifest?.imports)).toBe(true);
    expect(native.importsHelper).toContain("buildCompiledAdapterImports");
    expect(native.importsHelper).toContain('"semanticProviders": "native-first"');
    buildCompiledAdapterImports(native.adapterManifest!, { RegExp: observedRegExp });
    expect(definitions).toBe(0);

    const compatibility = await compile(`export function value(): number { return 1; }`, {
      fileName: "issue-4397-ambient-compat.ts",
    });
    buildCompiledImports(compatibility, { RegExp: observedRegExp });
    expect(definitions).toBeGreaterThan(0);
  });

  it("selects native strings without disabling JS capabilities or their boundary marshal", async () => {
    const result = await compile(
      `
        export function stringSemantics(): number {
          const value = "  ab  ".trim().toUpperCase();
          console.log(value);
          return value === "AB" ? value.charCodeAt(1) : 0;
        }
      `,
      { fileName: "issue-4397-capability.ts", semanticProviders: "native-first" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);

    const imports = wasmImports(result.binary);
    expect(imports.some((entry) => entry.module === "wasm:js-string")).toBe(false);
    expect(imports.some((entry) => entry.module === "env" && entry.name === "console_log_string")).toBe(true);
    expect(imports.some((entry) => entry.module === "env" && entry.name.startsWith("__str_"))).toBe(true);

    const inventory = result.hostImportInventory ?? [];
    expect(inventory.filter((entry) => entry.classification === "unknown")).toEqual([]);
    expect(inventory.filter((entry) => entry.classification === "legacy-semantic")).toEqual([]);
    expect(inventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "console_log_string", classification: "platform-capability" }),
        expect.objectContaining({ name: "__str_to_mem", classification: "value-adapter" }),
      ]),
    );
  });

  it("keeps Wasm-owned objects live and identity-stable at the JS boundary", async () => {
    const result = await compile(
      `
        interface Box { value: number }
        const box: Box = { value: 1 };
        export function getBox(): Box { return box; }
        export function readBox(value: Box): number { return value.value; }
        export function bumpBox(value: Box): number { value.value += 1; return value.value; }
        export function makeOpen(text: string): any { return JSON.parse(text); }
        export function echoOpen(value: any): any { return value; }
        export function bumpOpen(value: any): number {
          const next: number = value.count as number;
          value.count = next + 1;
          return next + 1;
        }
        export function readOpenLabel(value: any): string { return value.label; }
        export function hasOpenLabel(value: any): boolean { return "label" in value; }
      `,
      { fileName: "issue-4397-live-boundary.ts", semanticProviders: "native-first" },
    );
    expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);

    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    const exports = wrapCompiledExports(result, instance);

    const first = exports.getBox();
    const second = exports.getBox();
    expect(first).toBe(second);
    expect(first.value).toBe(1);
    expect(exports.readBox(first)).toBe(1);
    expect(exports.bumpBox(first)).toBe(2);
    expect(first.value).toBe(2);

    first.value = 9;
    expect(exports.readBox(first)).toBe(9);

    const open = exports.makeOpen('{"count":1,"label":"a"}');
    expect(exports.echoOpen(open)).toBe(open);
    expect(open.count).toBe(1);
    expect(open.label).toBe("a");
    expect(Object.keys(open)).toEqual(["count", "label"]);
    expect(exports.bumpOpen(open)).toBe(2);
    expect(open.count).toBe(2);
    open.count = 7;
    open.label = "b";
    expect(exports.bumpOpen(open)).toBe(8);
    expect(exports.readOpenLabel(open)).toBe("b");
    expect(exports.hasOpenLabel(open)).toBe(1);
    expect(Reflect.deleteProperty(open, "label")).toBe(true);
    expect(exports.hasOpenLabel(open)).toBe(0);
    expect(Object.keys(open)).toEqual(["count"]);
    expect(result.exportBoundaryPolicies).toMatchObject({
      getBox: { result: { kind: "aggregate", policy: "live-view" } },
      readBox: { params: [{ kind: "aggregate", policy: "live-view" }] },
      echoOpen: {
        params: [{ kind: "dynamic", policy: "live-view" }],
        result: { kind: "dynamic", policy: "live-view" },
      },
    });
    expect(result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual([]);
  });

  it("keeps compatibility-profile dynamic values on the identity-preserving host boundary", async () => {
    const result = await compile(`export function echoAny(input: any): any { return input; }`, {
      fileName: "issue-4397-compatibility-dynamic-boundary.ts",
    });
    expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(result.exportSignatures?.echoAny).toEqual({ params: ["dynamic"], result: "dynamic" });
    expect(result.exportBoundaryPolicies?.echoAny).toEqual({
      params: [{ kind: "dynamic", policy: "copied-value" }],
      result: { kind: "dynamic", policy: "copied-value" },
    });

    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    const exports = wrapCompiledExports(result, instance);
    const input = { value: 42 };
    expect(exports.echoAny(input)).toBe(input);
  });

  it("keeps native arrays canonical and exposes a live array facade only at the boundary", async () => {
    const native = await instantiate(
      `
        const values: number[] = [1, 2, 3];
        export function getValues(): number[] { return values; }
        export function getValue(index: number): number { return values[index]; }
        export function getLength(): number { return values.length; }
        export function tail(): number[] { return values.slice(1); }
        export function echo(value: any): any { return value; }
      `,
      "native-first",
    );

    const first = native.exports.getValues();
    expect(Array.isArray(first)).toBe(true);
    expect(Array.from(first)).toEqual([1, 2, 3]);
    expect(native.exports.getValues()).toBe(first);
    expect(native.exports.echo(first)).toBe(first);
    expect(Array.from(native.exports.tail())).toEqual([2, 3]);

    first[0] = 9;
    expect(native.exports.getValue(0)).toBe(9);
    first.push(4);
    expect(native.exports.getLength()).toBe(4);
    expect(Array.from(first)).toEqual([9, 2, 3, 4]);

    expect(wasmImports(native.result.binary).some((entry) => entry.name === "__make_iterable")).toBe(false);
    expect(native.result.exportBoundaryPolicies).toMatchObject({
      getValues: { result: { kind: "aggregate", policy: "live-view" } },
    });
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "unknown")).toEqual([]);
  });

  it("runs object-rest CopyDataProperties natively while retaining JS-owned boundary objects", async () => {
    const native = await instantiate(
      `
        export function localRest(): number {
          const { a, ...rest }: any = { a: 1, b: 2, c: 3 };
          return rest.b * 10 + rest.c;
        }
        export function assignmentRest(): number {
          let a = 0;
          let rest: any = {};
          ({ a, ...rest } = { a: 1, b: 4 });
          return a * 10 + rest.b;
        }
        export function loopRest(): number {
          let result = 0;
          for (const { a, ...rest } of [{ a: 1, b: 5 }]) result = a * 10 + rest.b;
          return result;
        }
        export function boundaryRest(source: any): any {
          const { skip, ...rest } = source;
          return rest;
        }
      `,
      "native-first",
    );

    expect(native.exports.localRest()).toBe(23);
    expect(native.exports.assignmentRest()).toBe(14);
    expect(native.exports.loopRest()).toBe(15);

    let getterCalls = 0;
    const source = Object.defineProperties(
      { skip: 1, kept: 2 },
      {
        doubled: {
          enumerable: true,
          get() {
            getterCalls += 1;
            return 6;
          },
        },
        hidden: { enumerable: false, value: 9 },
      },
    );
    const rest = native.exports.boundaryRest(source);
    expect(source.skip).toBe(1);
    expect(getterCalls).toBe(1);
    expect(Object.keys(rest)).toEqual(["kept", "doubled"]);
    expect(rest.kept).toBe(2);
    expect(rest.doubled).toBe(6);
    expect("skip" in rest).toBe(false);
    expect("hidden" in rest).toBe(false);

    expect(wasmImports(native.result.binary).some((entry) => entry.name === "__extern_rest_object")).toBe(false);
    expect(native.result.hostImportInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "__boundary_object_keys", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_object_get", classification: "value-adapter" }),
      ]),
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "unknown")).toEqual([]);
  });

  it("keeps DataView window and byte semantics in Wasm while admitting caller-owned views", async () => {
    const native = await instantiate(
      `
        export function windowed(): number {
          const buffer = new ArrayBuffer(12);
          const left = new DataView(buffer, 2, 8);
          const right = new DataView(buffer, 4, 4);
          left.setUint32(2, 0x01020304);
          return right.getUint32(0);
        }
        export function attributes(): number {
          const view = new DataView(new ArrayBuffer(10), 3, 4);
          return view.byteOffset * 100 + view.byteLength;
        }
        export function readBoundary(view: any): any { return view.getUint8(0); }
      `,
      "native-first",
    );

    expect(native.exports.windowed()).toBe(0x01020304);
    expect(native.exports.attributes()).toBe(304);
    const bytes = new Uint8Array([9, 8]);
    expect(native.exports.readBoundary(new DataView(bytes.buffer))).toBe(9);

    expect(wasmImports(native.result.binary).some((entry) => entry.name === "__dv_register_view")).toBe(false);
    expect(native.result.hostImportInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "__boundary_object_call", classification: "value-adapter" }),
      ]),
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "unknown")).toEqual([]);
  });

  it("keeps compiled bind state in Wasm and binds JS functions only at the admitted boundary", async () => {
    const local = await instantiate(
      `
        function add(left: number, right: number): number { return left + right; }
        const receiver: any = { base: 3 };
        function seesReceiver(): number { return this === receiver ? 3 : 0; }
        export function localArgs(): number {
          const bound = add.bind(undefined, 4);
          return bound(5);
        }
        export function localThis(): number {
          const bound = seesReceiver.bind(receiver);
          return bound();
        }
        export function nestedBound(): number {
          const first = add.bind(undefined, 1);
          const second = first.bind(undefined, 2);
          return second() * 10 + 3;
        }
      `,
      "native-first",
    );

    expect(local.exports.localArgs()).toBe(9);
    expect(local.exports.localThis()).toBe(3);
    expect(local.exports.nestedBound()).toBe(33);
    const localImports = wasmImports(local.result.binary).map((entry) => entry.name);
    expect(localImports).not.toContain("__boundary_callback_call_0");
    expect(localImports).not.toContain("__boundary_callback_call_1");

    const boundary = await instantiate(
      `
        export function boundaryBound(fn: any): any {
          const bound = fn.bind({ base: 7 }, 3);
          return bound(2);
        }
      `,
      "native-first",
    );

    const hostFunction = function (this: { base: number }, left: number, right: number) {
      return this.base + left + right;
    };
    expect(boundary.exports.boundaryBound(hostFunction)).toBe(12);

    const imports = wasmImports(boundary.result.binary).map((entry) => entry.name);
    expect(imports).not.toContain("__bind_function");
    expect(imports).not.toContain("__call_function");
    expect(imports).not.toContain("__js_array_new");
    expect(imports).not.toContain("__js_array_push");
    expect(boundary.result.hostImportInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "__boundary_callback_call_1", classification: "value-adapter" }),
      ]),
    );
    expect(boundary.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
    expect(boundary.result.hostImportInventory?.filter((entry) => entry.classification === "unknown")).toEqual([]);
  });

  it("declares copied TypedArray inputs and live native-first aggregate results", async () => {
    const result = await compile(`export function echoBytes(value: Uint8Array): Uint8Array { return value; }`, {
      fileName: "issue-4397-boundary-policy.ts",
      semanticProviders: "native-first",
    });
    expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(result.exportBoundaryPolicies?.echoBytes).toEqual({
      params: [{ kind: "uint8array", policy: "copied-value" }],
      result: { kind: "uint8array", policy: "live-view" },
    });
  });

  it("rejects an undeclared aggregate boundary policy before exposing exports", async () => {
    const result = await compile(`export function makeValue(): any { return { count: 1 }; }`, {
      fileName: "issue-4397-missing-boundary-policy.ts",
      semanticProviders: "native-first",
    });
    expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);

    expect(() =>
      buildCompiledAdapterImports({
        ...result.adapterManifest!,
        exportBoundaries: {},
      }),
    ).toThrow("Invalid JavaScript adapter manifest: export 'makeValue' has no boundary policy");

    expect(() =>
      wrapCompiledExports(
        {
          ...result,
          exportBoundaryPolicies: {},
        },
        instance,
      ),
    ).toThrow("Invalid export boundary policy manifest: export 'makeValue' has no boundary policy");
  });

  it("scopes admitted JS-owned objects to one module instance", async () => {
    const source = `
      export function readBoundary(value: any): any { return value.secret; }
      export function echo(value: any): any { return value; }
    `;
    const result = await compile(source, {
      fileName: "issue-4397-boundary-authority.ts",
      semanticProviders: "native-first",
    });
    expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);

    const instantiateOne = async () => {
      const imports = buildCompiledImports(result);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      return { instance, exports: wrapCompiledExports(result, instance) };
    };
    const first = await instantiateOne();
    const second = await instantiateOne();
    const shared = { secret: 42 };

    expect(first.exports.readBoundary(shared)).toBe(42);
    const unadmittedResult = (second.instance.exports.readBoundary as (value: any) => any)(shared);
    expect(second.exports.echo(unadmittedResult)).toBe(undefined);
    expect(second.exports.readBoundary(shared)).toBe(42);
  });

  it("matches host-assisted string values and observable errors", async () => {
    const source = `
      export function value(): string {
        return "  alpha-beta  ".trim().toUpperCase().slice(0, 5);
      }
      export function echo(value: string): string {
        return value.trim().toUpperCase();
      }
      export function invalidRepeat(): string {
        return "x".repeat(-1);
      }
    `;
    const host = await instantiate(source);
    const native = await instantiate(source, "native-first");

    expect(native.exports.value()).toBe(host.exports.value());
    expect(native.exports.echo("  beta  ")).toBe(host.exports.echo("  beta  "));
    expect(() => host.exports.invalidRepeat()).toThrow();
    expect(() => native.exports.invalidRepeat()).toThrow();
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
  });

  it("runs the native JSON provider in a JS environment", async () => {
    const source = `
      export function normalize(text: string): string {
        const value: any = JSON.parse(text);
        value.extra = 3;
        return JSON.stringify(value);
      }
      export function invalid(text: string): number {
        JSON.parse(text);
        return 0;
      }
    `;
    const host = await instantiate(source);
    const native = await instantiate(source, "native-first");

    expect(native.exports.normalize('{"a":1}')).toBe(host.exports.normalize('{"a":1}'));
    expect(() => host.exports.invalid("{")).toThrow();
    expect(() => native.exports.invalid("{")).toThrow();
    expect(wasmImports(native.result.binary).filter((entry) => /^JSON_(parse|stringify)$/.test(entry.name))).toEqual(
      [],
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
  });

  it("translates Wasm-owned errors only at the JS boundary", async () => {
    const source = `
      export function make(): TypeError { return new TypeError("bad"); }
      export function fail(): never { throw new TypeError("bad"); }
      export function isTypeError(value: any): boolean { return value instanceof TypeError; }
      export function echo(value: any): any { return value; }
    `;
    const native = await instantiate(source, "native-first");

    const made = native.exports.make();
    expect(made).toBeInstanceOf(TypeError);
    expect(made.name).toBe("TypeError");
    expect(made.message).toBe("bad");
    expect(native.exports.isTypeError(made)).toBe(1);
    expect(native.exports.echo(made)).toBe(made);

    let thrown: unknown;
    try {
      native.exports.fail();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toBe("bad");
    expect(wasmImports(native.result.binary).some((entry) => entry.name === "__new_TypeError")).toBe(false);
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
  });

  it("runs the native RegExp provider in a JS environment", async () => {
    const source = `
      export function matches(value: string): boolean { return /^a+b$/i.test(value); }
      export function invalid(): number { new RegExp("["); return 0; }
    `;
    const host = await instantiate(source);
    const native = await instantiate(source, "native-first");

    expect(native.exports.matches("AAAb")).toBe(host.exports.matches("AAAb"));
    expect(native.exports.matches("ac")).toBe(host.exports.matches("ac"));
    expect(() => host.exports.invalid()).toThrow(SyntaxError);
    expect(() => native.exports.invalid()).toThrow(SyntaxError);
    expect(
      wasmImports(native.result.binary).filter(
        (entry) => entry.name === "RegExp_new" || entry.name.startsWith("RegExp_"),
      ),
    ).toEqual([]);
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
  });

  it("runs collection, Date, Number, and BigInt providers without semantic host imports", async () => {
    const source = `
      export function mapValue(): number {
        const value = new Map<string, number>();
        value.set("x", 1);
        return value.get("x")!;
      }
      export function setValue(): boolean {
        const value = new Set<number>();
        value.add(1);
        return value.has(1);
      }
      export function weakMapValue(): number {
        const key = {};
        const value = new WeakMap<object, number>();
        value.set(key, 2);
        return value.get(key)!;
      }
      export function dateValue(): number { return new Date(0).getUTCFullYear(); }
      export function numberValue(): string { return (12.5).toFixed(1); }
      export function bigintValue(): bigint { return BigInt("42") + 1n; }
    `;
    const host = await instantiate(source);
    const native = await instantiate(source, "native-first");

    expect(native.exports.mapValue()).toBe(host.exports.mapValue());
    expect(native.exports.setValue()).toBe(host.exports.setValue());
    expect(native.exports.weakMapValue()).toBe(host.exports.weakMapValue());
    expect(native.exports.dateValue()).toBe(host.exports.dateValue());
    expect(native.exports.numberValue()).toBe(host.exports.numberValue());
    expect(native.exports.bigintValue()).toBe(host.exports.bigintValue());
    expect(
      wasmImports(native.result.binary).filter((entry) => /^(Map|Set|WeakMap|Date|number|bigint)_/.test(entry.name)),
    ).toEqual([]);
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "unknown")).toEqual([]);
  });

  it("formats the full signed-i64 BigInt range natively for radices 2 through 36", async () => {
    const native = await instantiate(
      `
        export function hex(): string { return 255n.toString(16); }
        export function binary(): string { return (-10n).toString(2); }
        export function minimum(): string { return (-9223372036854775807n - 1n).toString(); }
        export function maximum(): string { return 9223372036854775807n.toString(); }
        export function zero(): string { return 0n.toString(36); }
      `,
      "native-first",
    );

    expect(native.exports.hex()).toBe("ff");
    expect(native.exports.binary()).toBe("-1010");
    expect(native.exports.minimum()).toBe("-9223372036854775808");
    expect(native.exports.maximum()).toBe("9223372036854775807");
    expect(native.exports.zero()).toBe("0");
    expect(wasmImports(native.result.binary).map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["bigint_toString", "bigint_toString_radix"]),
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
  });

  it("selects native String.raw and extern-array join providers in a JavaScript environment", async () => {
    const native = await instantiate(
      `
        export function joined(): string {
          return "aba".split(/b/).join("-");
        }
        export function raw(): string {
          return String.raw({ raw: ["x", "y"] }, 1);
        }
      `,
      "native-first",
    );

    expect(native.exports.joined()).toBe("a-a");
    expect(native.exports.raw()).toBe("x1y");
    expect(wasmImports(native.result.binary).map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["__array_join_any", "__get_builtin"]),
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "unknown")).toEqual([]);
  });

  it("keeps Proxy.revocable and its revoker in Wasm", async () => {
    const native = await instantiate(
      `
        export function run(): number {
          const target: any = { value: 1 };
          const pair: any = Proxy.revocable(target, {
            get(inner: any, key: string): any { return inner[key]; },
          });
          pair.proxy.value;
          pair.revoke();
          let revoked = false;
          try { pair.proxy.value; } catch (error) { revoked = error instanceof TypeError; }
          pair.revoke();
          return revoked ? 42 : 0;
        }
        export function inspect(): any {
          const pair: any = Proxy.revocable({ value: 1 }, {});
          return pair.proxy.value;
        }
      `,
      "native-first",
    );

    expect(native.exports.inspect()).toBe(1);
    expect(native.exports.run()).toBe(42);
    expect(wasmImports(native.result.binary).map(({ name }) => name)).not.toContain("__proxy_revocable");
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "unknown")).toEqual([]);
  });

  it("constructs ordinary native-first Proxy objects without a semantic host provider", async () => {
    const native = await instantiate(
      `
        export function run(): number {
          let gets = 0;
          const proxy: any = new Proxy({ value: 2 }, {
            get(target: any, key: any, receiver: any): any {
              gets += 1;
              return Reflect.get(target, key, receiver);
            },
          });
          return proxy.value + gets;
        }
      `,
      "native-first",
    );

    expect(native.exports.run()).toBe(3);
    expect(wasmImports(native.result.binary).map(({ name }) => name)).not.toContain("__proxy_create");
    expect(native.result.hostImportInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "__boundary_object_callable_kind",
          classification: "value-adapter",
        }),
      ]),
    );
  });

  it("runs native Proxy [[Call]] and [[Construct]] traps and enforces construct results", async () => {
    const native = await instantiate(
      `
        function add(value: number): number { return value + 1; }
        function Box(value: number): void { (this as any).value = value; }

        export function callTrap(): number {
          const callable: any = new Proxy(add, {
            apply(target: any, receiver: any, args: any): any { return args[0] + 4; },
          });
          return callable(3);
        }

        export function constructTrap(): number {
          const Constructor: any = new Proxy(Box, {
            construct(target: any, args: any, newTarget: any): any {
              return { value: args[0] + 5 };
            },
          });
          return new Constructor(6).value;
        }

        export function constructForward(): number {
          const Constructor: any = new Proxy(Box, {});
          return new Constructor(7).value;
        }

        export function primitiveConstructResultThrows(): number {
          const Constructor: any = new Proxy(Box, {
            construct(): any { return 1; },
          });
          try { new Constructor(); }
          catch (error) { return error instanceof TypeError ? 1 : -1; }
          return 0;
        }

        export function nonConstructorTargetThrows(): number {
          const Constructor: any = new Proxy(() => 1, {});
          try { new Constructor(); }
          catch (error) { return error instanceof TypeError ? 1 : -1; }
          return 0;
        }
      `,
      "native-first",
    );

    expect(native.exports.callTrap()).toBe(7);
    expect(native.exports.constructTrap()).toBe(11);
    expect(native.exports.constructForward()).toBe(7);
    expect(native.exports.primitiveConstructResultThrows()).toBe(1);
    expect(native.exports.nonConstructorTargetThrows()).toBe(1);
    const imports = wasmImports(native.result.binary).map(({ name }) => name);
    expect(imports).not.toContain("__proxy_create");
    expect(imports).not.toContain("__construct_closure");
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
  });

  it("rejects primitive ProxyCreate inputs and retains admitted JS function targets", async () => {
    const native = await instantiate(
      `
        export function rejectsPrimitives(): number {
          let count = 0;
          try { new Proxy(1 as any, {}); } catch (error) { if (error instanceof TypeError) count += 1; }
          try { new Proxy({} as any, "handler" as any); } catch (error) { if (error instanceof TypeError) count += 2; }
          return count;
        }

        export function callTarget(target: any, value: number): number {
          const callable: any = new Proxy(target, {});
          return callable(value);
        }

        export function constructTarget(target: any, value: number): any {
          const Constructor: any = new Proxy(target, {});
          return new Constructor(value);
        }
      `,
      "native-first",
    );

    expect(native.exports.rejectsPrimitives()).toBe(3);
    const target = (value: number) => value + 2;
    expect(native.exports.callTarget(target, 5)).toBe(7);
    function Box(this: { value?: number }, value: number) {
      this.value = value;
    }
    const result = native.exports.constructTarget(Box, 9);
    expect(result).toBeInstanceOf(Box);
    expect(result.value).toBe(9);
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
  });

  it("keeps array and object result builders native instead of materializing JS intermediates", async () => {
    const native = await instantiate(
      `
        export function arrayValue(value: number): string {
          return [value, value + 1, value + 2].map(item => item * 2).join("-");
        }
        export function keys(value: number): string[] { return Object.keys({ value }); }
        export function assigned(value: number): any { return Object.assign({}, { value }); }
        export function spread(value: number): any { return { ...{ value }, next: value + 1 }; }
      `,
      "native-first",
    );

    expect(native.exports.arrayValue(2)).toBe("4-6-8");
    expect(native.exports.keys(3)).toEqual(["value"]);
    expect(native.exports.assigned(4).value).toBe(4);
    expect(native.exports.spread(5)).toMatchObject({ value: 5, next: 6 });
    const imports = wasmImports(native.result.binary).map((entry) => entry.name);
    expect(imports).not.toContain("__array_from_iter");
    expect(imports).not.toContain("__js_array_new");
    expect(imports).not.toContain("__js_array_push");
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "unknown")).toEqual([]);
  });

  it("runs parse and URI string globals through their native providers", async () => {
    const source = `
      export function parsed(value: string): number { return parseInt(value, 16) + parseFloat(value); }
      export function uri(value: string): string { return decodeURIComponent(encodeURIComponent(value)); }
      export function escaped(value: string): string { return unescape(escape(value)); }
      export function malformed(): string {
        try { decodeURIComponent("%"); return "no error"; }
        catch (error) { return (error as Error).name; }
      }
    `;
    const host = await instantiate(source);
    const native = await instantiate(source, "native-first");

    expect(native.exports.parsed("10.5")).toBe(host.exports.parsed("10.5"));
    expect(native.exports.uri("a b/✓")).toBe(host.exports.uri("a b/✓"));
    expect(native.exports.escaped("a b/✓")).toBe(host.exports.escaped("a b/✓"));
    expect(native.exports.malformed()).toBe("URIError");
    const imports = wasmImports(native.result.binary).map((entry) => entry.name);
    for (const name of [
      "parseInt",
      "parseFloat",
      "decodeURI",
      "decodeURIComponent",
      "encodeURI",
      "encodeURIComponent",
      "escape",
      "unescape",
    ]) {
      expect(imports).not.toContain(name);
    }
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "unknown")).toEqual([]);
  });

  it("presents a native async result as a JavaScript Promise only at the boundary", async () => {
    const native = await instantiate(
      `
        const shared = Promise.resolve(7);
        export function getShared(): Promise<number> { return shared; }
        export async function value(): Promise<number> { return await Promise.resolve(41).then(v => v + 1); }
        export async function recover(): Promise<number> { return await Promise.reject(4).catch(v => v + 1); }
        export async function fromHost(input: Promise<number>): Promise<number> { return await input; }
      `,
      "native-first",
    );

    const value = native.exports.value();
    expect(value).toBeInstanceOf(Promise);
    await expect(value).resolves.toBe(42);
    await expect(native.exports.recover()).resolves.toBe(5);
    const shared = native.exports.getShared();
    expect(native.exports.getShared()).toBe(shared);
    await expect(shared).resolves.toBe(7);
    await expect(native.exports.fromHost(Promise.resolve(9))).resolves.toBe(9);
    await expect(
      native.exports.fromHost(new Promise<number>((resolve) => setTimeout(() => resolve(10), 0))),
    ).resolves.toBe(10);
    const hostReason = new Error("host rejection");
    await expect(native.exports.fromHost(Promise.reject(hostReason))).rejects.toBe(hostReason);
    expect(native.result.exportSignatures).toMatchObject({
      getShared: { result: "promise" },
      value: { result: "promise" },
      fromHost: { params: ["promise"], result: "promise" },
    });
    expect(native.result.exportBoundaryPolicies).toMatchObject({
      getShared: { result: { kind: "promise", policy: "live-view" } },
      fromHost: {
        params: [{ kind: "promise", policy: "live-view" }],
        result: { kind: "promise", policy: "live-view" },
      },
    });
    expect(native.result.hostImportInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "__boundary_promise_resolve", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_promise_reject", classification: "value-adapter" }),
      ]),
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "unknown")).toEqual([]);
  });

  it("keeps Symbol semantics native and converts identity only at the JS boundary", async () => {
    const source = `
      const shared = Symbol("shared");
      export function make(description: string): symbol { return Symbol(description); }
      export function getShared(): symbol { return shared; }
      export function echo(value: symbol): symbol { return value; }
      export function echoDynamic(value: any): any { return value; }
      export function registered(key: string): symbol { return Symbol.for(key); }
      export function registeredKey(value: symbol): string { return Symbol.keyFor(value)!; }
    `;
    const native = await instantiate(source, "native-first");

    const first = native.exports.make("x");
    const second = native.exports.make("x");
    expect(typeof first).toBe("symbol");
    expect(first.description).toBe("x");
    expect(second.description).toBe("x");
    expect(first).not.toBe(second);
    expect(native.exports.getShared()).toBe(native.exports.getShared());

    const hostSymbol = Symbol("host");
    expect(native.exports.echo(hostSymbol)).toBe(hostSymbol);
    expect(native.exports.echoDynamic(hostSymbol)).toBe(hostSymbol);
    expect(native.exports.echo(Symbol.iterator)).toBe(Symbol.iterator);
    expect(native.exports.registered("issue-4397")).toBe(Symbol.for("issue-4397"));
    expect(native.exports.registeredKey(Symbol.for("issue-4397"))).toBe("issue-4397");
    expect(native.result.exportBoundaryPolicies).toMatchObject({
      make: { result: { kind: "symbol", policy: "primitive-value" } },
      echo: {
        params: [{ kind: "symbol", policy: "primitive-value" }],
        result: { kind: "symbol", policy: "primitive-value" },
      },
    });
    expect(
      wasmImports(native.result.binary).filter((entry) =>
        ["__symbol_register_desc", "__symbol_description", "__box_symbol"].includes(entry.name),
      ),
    ).toEqual([]);
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "unknown")).toEqual([]);
  });

  it("runs dynamic operators in Wasm without losing JS primitive interop", async () => {
    const source = `
      export function add(left: any, right: any): any { return left + right; }
      export function loose(left: any, right: any): boolean { return left == right; }
      export function strict(left: any, right: any): boolean { return left === right; }
      export function less(left: any, right: any): boolean { return left < right; }
      export function echo(value: any): any { return value; }
      export function readBoundary(value: any): any { return value.count; }
      export function writeBoundary(value: any, next: any): any {
        value.count = next;
        return value.count;
      }
      export function hasBoundary(value: any, key: any): boolean { return key in value; }
      export function deleteBoundary(value: any, key: any): boolean { return delete value[key]; }
      export function keysBoundary(value: any): any { return Object.keys(value); }
      export function keysBoundaryLength(value: any): number { return Object.keys(value).length; }
      export function firstBoundaryKey(value: any): any { return Object.keys(value)[0]; }
      export function callBoundary(value: any, next: any): any { return value.increment(next); }
      export function callBoundarySelf(value: any): any { return value.self(); }
      export function getBoundaryPrototype(value: any): any { return Object.getPrototypeOf(value); }
      export function setBoundaryPrototype(value: any, proto: any): any { return Object.setPrototypeOf(value, proto); }
      export function boundaryDescriptorValue(value: any): any {
        return Object.getOwnPropertyDescriptor(value, "count").value;
      }
      export function boundaryDescriptorEnumerable(value: any): any {
        return Object.getOwnPropertyDescriptor(value, "count").enumerable;
      }
      export function boundaryDescriptorMissing(value: any): any {
        return Object.getOwnPropertyDescriptor(value, "missing");
      }
      export function defineBoundaryValue(value: any): any {
        Object.defineProperty(value, "hidden", {
          value: 9,
          writable: false,
          enumerable: false,
          configurable: true,
        });
        return value.hidden;
      }
      export function boundaryHiddenDescriptor(value: any): any {
        return Object.getOwnPropertyDescriptor(value, "hidden");
      }
      export function defineBoundaryAccessor(value: any): any {
        Object.defineProperty(value, "doubled", {
          get() { return value.count * 2; },
          set(next: number) { value.count = next / 2; },
          enumerable: true,
          configurable: true,
        });
        value.doubled = 24;
        return value.doubled;
      }
      export function boundaryOwnNames(value: any): any { return Object.getOwnPropertyNames(value); }
      export function boundaryOwnSymbols(value: any): any { return Object.getOwnPropertySymbols(value); }
      export function boundaryForInCount(value: any): number {
        let count = 0;
        for (const key in value) count += 1;
        return count;
      }
      export function cycleBoundary(value: any): any { value.self = value; return value.self; }
      export function mutateBoundaryArray(value: any): any { value.push(4); return value; }
      export function makeAdder(base: number): any {
        return (value: number): number => base + value;
      }
      export function makeBoundaryArray(): any { return [1, 2, 3]; }
      export function invokeBoundaryCallback(callback: any, value: any): any {
        return callback(value);
      }
      export function reflectGet(value: any, key: any): any { return Reflect.get(value, key); }
      export function reflectGetWithReceiver(value: any, key: any, receiver: any): any {
        return Reflect.get(value, key, receiver);
      }
      export function reflectSet(value: any, key: any, next: any): boolean { return Reflect.set(value, key, next); }
      export function reflectSetWithReceiver(value: any, key: any, next: any, receiver: any): boolean {
        return Reflect.set(value, key, next, receiver);
      }
      export function reflectHas(value: any, key: any): boolean { return Reflect.has(value, key); }
      export function reflectDelete(value: any, key: any): boolean { return Reflect.deleteProperty(value, key); }
      export function reflectOwnKeys(value: any): any { return Reflect.ownKeys(value); }
      export function reflectDescriptor(value: any, key: any): any {
        return Reflect.getOwnPropertyDescriptor(value, key);
      }
      export function reflectDefine(value: any, key: any, descriptor: any): boolean {
        return Reflect.defineProperty(value, key, descriptor);
      }
      export function reflectGetPrototype(value: any): any { return Reflect.getPrototypeOf(value); }
      export function reflectSetPrototype(value: any, proto: any): boolean {
        return Reflect.setPrototypeOf(value, proto);
      }
      export function reflectPreventExtensions(value: any): boolean { return Reflect.preventExtensions(value); }
      export function reflectIsExtensible(value: any): boolean { return Reflect.isExtensible(value); }
      export function reflectApply(target: any, thisArg: any, args: any): any {
        return Reflect.apply(target, thisArg, args);
      }
      export function reflectConstruct(target: any, args: any, newTarget: any): any {
        return Reflect.construct(target, args, newTarget);
      }
      export function boundaryPreventExtensions(value: any): any { return Object.preventExtensions(value); }
      export function boundarySeal(value: any): any { return Object.seal(value); }
      export function boundaryFreeze(value: any): any { return Object.freeze(value); }
      export function boundaryIsExtensible(value: any): boolean { return Object.isExtensible(value); }
      export function boundaryIsSealed(value: any): boolean { return Object.isSealed(value); }
      export function boundaryIsFrozen(value: any): boolean { return Object.isFrozen(value); }
      export function objectAdd(): any {
        const value = { valueOf() { return 2; } };
        return (value as any) + 3;
      }
    `;
    const host = await instantiate(source);
    const native = await instantiate(source, "native-first");
    native.imports.startImportCounting?.();

    for (const args of [
      [1, 2],
      ["x", 2],
      [true, 2],
    ] as const) {
      expect(native.exports.add(...args)).toBe(host.exports.add(...args));
    }
    expect(native.exports.objectAdd()).toBe(host.exports.objectAdd());
    const boundaryObject = {
      count: 1,
      increment(next: number) {
        this.count += next;
        return this.count;
      },
      self() {
        return this;
      },
    };
    expect(native.exports.echo(boundaryObject)).toBe(boundaryObject);
    expect(native.exports.readBoundary(boundaryObject)).toBe(1);
    expect(native.exports.writeBoundary(boundaryObject, 4)).toBe(4);
    expect(boundaryObject.count).toBe(4);
    expect(native.exports.hasBoundary(boundaryObject, "count")).toBe(1);
    expect(native.exports.keysBoundary(boundaryObject)).toEqual(["count", "increment", "self"]);
    expect(native.exports.keysBoundaryLength(boundaryObject)).toBe(3);
    expect(native.exports.firstBoundaryKey(boundaryObject)).toBe("count");
    expect(native.exports.callBoundary(boundaryObject, 3)).toBe(7);
    expect(native.exports.callBoundarySelf(boundaryObject)).toBe(boundaryObject);
    expect(native.exports.boundaryDescriptorValue(boundaryObject)).toBe(7);
    expect(native.exports.boundaryDescriptorEnumerable(boundaryObject)).toBe(true);
    expect(native.exports.boundaryDescriptorMissing(boundaryObject)).toBe(undefined);
    expect(native.exports.defineBoundaryValue(boundaryObject)).toBe(9);
    const hiddenDescriptor = native.exports.boundaryHiddenDescriptor(boundaryObject);
    expect(hiddenDescriptor.value).toBe(9);
    expect(hiddenDescriptor.writable).toBe(false);
    expect(hiddenDescriptor.enumerable).toBe(false);
    expect(hiddenDescriptor.configurable).toBe(true);
    const accessorResult = native.exports.defineBoundaryAccessor(boundaryObject);
    const accessorDescriptor = Object.getOwnPropertyDescriptor(boundaryObject, "doubled");
    expect(typeof accessorDescriptor?.get).toBe("function");
    expect(typeof accessorDescriptor?.set).toBe("function");
    expect(accessorResult).toBe(24);
    expect(boundaryObject.count).toBe(12);
    expect(native.exports.boundaryOwnNames(boundaryObject)).toEqual([
      "count",
      "increment",
      "self",
      "hidden",
      "doubled",
    ]);
    const boundarySymbol = Symbol("boundary");
    Object.defineProperty(boundaryObject, boundarySymbol, { value: 1 });
    expect(native.exports.boundaryOwnSymbols(boundaryObject)).toEqual([boundarySymbol]);
    const replacementPrototype = { inherited: 12 };
    expect(native.exports.setBoundaryPrototype(boundaryObject, replacementPrototype)).toBe(boundaryObject);
    expect(native.exports.getBoundaryPrototype(boundaryObject)).toBe(replacementPrototype);
    expect(native.exports.hasBoundary(boundaryObject, "inherited")).toBe(1);
    expect(native.exports.boundaryForInCount(boundaryObject)).toBe(5);
    expect(native.exports.cycleBoundary(boundaryObject)).toBe(boundaryObject);
    expect(boundaryObject.self).toBe(boundaryObject);
    const boundaryArray = [1, 2, 3];
    expect(native.exports.mutateBoundaryArray(boundaryArray)).toBe(boundaryArray);
    expect(boundaryArray).toEqual([1, 2, 3, 4]);
    const addFive = native.exports.makeAdder(5);
    expect(typeof addFive).toBe("function");
    expect(addFive(7)).toBe(12);
    expect(native.exports.invokeBoundaryCallback((value: number) => value + 2, 8)).toBe(10);
    const callbackArray = native.exports.makeBoundaryArray();
    expect(native.exports.invokeBoundaryCallback((value: unknown) => value, callbackArray)).toBe(callbackArray);
    const reflectSymbol = Symbol("reflect");
    const reflectBoundary: Record<PropertyKey, any> = { visible: 1, [reflectSymbol]: 3 };
    Object.defineProperty(reflectBoundary, "hidden", { value: 2, configurable: true });
    expect(native.exports.reflectGet(reflectBoundary, "visible")).toBe(1);
    expect(native.exports.reflectSet(reflectBoundary, "visible", 4)).toBe(1);
    expect(reflectBoundary.visible).toBe(4);
    const receiverTarget = Object.defineProperty({}, "routed", {
      get(this: { slot?: number }) {
        return this.slot;
      },
      set(this: { slot?: number }, value: number) {
        this.slot = value;
      },
      configurable: true,
    });
    const explicitReceiver = { slot: 5 };
    expect(native.exports.reflectGetWithReceiver(receiverTarget, "routed", explicitReceiver)).toBe(5);
    expect(native.exports.reflectSetWithReceiver(receiverTarget, "routed", 11, explicitReceiver)).toBe(1);
    expect(explicitReceiver.slot).toBe(11);
    expect(Object.prototype.hasOwnProperty.call(receiverTarget, "slot")).toBe(false);
    expect(native.exports.reflectHas(reflectBoundary, reflectSymbol)).toBe(1);
    expect(native.exports.reflectOwnKeys(reflectBoundary)).toEqual(["visible", "hidden", reflectSymbol]);
    expect(native.exports.reflectDescriptor(reflectBoundary, "hidden")).toMatchObject({
      value: 2,
      enumerable: false,
      configurable: true,
    });
    expect(
      native.exports.reflectDefine(reflectBoundary, "defined", {
        value: 6,
        writable: true,
        enumerable: true,
        configurable: true,
      }),
    ).toBe(1);
    expect(reflectBoundary.defined).toBe(6);
    const reflectPrototype = { inherited: 5 };
    expect(native.exports.reflectSetPrototype(reflectBoundary, reflectPrototype)).toBe(1);
    expect(native.exports.reflectGetPrototype(reflectBoundary)).toBe(reflectPrototype);
    expect(native.exports.reflectHas(reflectBoundary, "inherited")).toBe(1);
    expect(native.exports.reflectDelete(reflectBoundary, "hidden")).toBe(1);
    expect(Reflect.has(reflectBoundary, "hidden")).toBe(false);
    function boundaryApply(this: { base: number }, left: number, right: number) {
      return this.base + left + right;
    }
    expect(native.exports.reflectApply(boundaryApply, { base: 4 }, [2, 3])).toBe(9);
    const applyEvents: string[] = [];
    const applyProxy = new Proxy(boundaryApply, {
      apply(target, thisArg, args) {
        applyEvents.push("apply");
        return Reflect.apply(target, thisArg, args);
      },
    });
    expect(native.exports.reflectApply(applyProxy, { base: 5 }, [1, 2])).toBe(8);
    expect(applyEvents).toEqual(["apply"]);
    class BoundaryBox {
      constructor(public value: number) {}
    }
    class BoundaryNewTarget {}
    const constructed = native.exports.reflectConstruct(BoundaryBox, [7], BoundaryBox);
    expect(constructed).toBeInstanceOf(BoundaryBox);
    expect(constructed.value).toBe(7);
    const retargeted = native.exports.reflectConstruct(BoundaryBox, [8], BoundaryNewTarget);
    expect(Object.getPrototypeOf(retargeted)).toBe(BoundaryNewTarget.prototype);
    expect(retargeted.value).toBe(8);
    const constructEvents: string[] = [];
    const constructProxy = new Proxy(BoundaryBox, {
      construct(target, args, newTarget) {
        constructEvents.push("construct");
        return Reflect.construct(target, args, newTarget);
      },
    });
    expect(native.exports.reflectConstruct(constructProxy, [9], constructProxy).value).toBe(9);
    expect(constructEvents).toEqual(["construct"]);
    const proxyEvents: string[] = [];
    const boundaryProxy = new Proxy(
      { value: 3 },
      {
        get(target, key, receiver) {
          proxyEvents.push(`get:${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
        set(target, key, value, receiver) {
          proxyEvents.push(`set:${String(key)}`);
          return Reflect.set(target, key, value, receiver);
        },
        ownKeys(target) {
          proxyEvents.push("ownKeys");
          return Reflect.ownKeys(target);
        },
      },
    );
    expect(native.exports.echo(boundaryProxy)).toBe(boundaryProxy);
    expect(native.exports.reflectGet(boundaryProxy, "value")).toBe(3);
    expect(native.exports.reflectSet(boundaryProxy, "value", 8)).toBe(1);
    expect(native.exports.reflectOwnKeys(boundaryProxy)).toEqual(["value"]);
    expect(proxyEvents).toEqual(["get:value", "set:value", "ownKeys"]);
    const reflectPrevented = { value: 1 };
    expect(native.exports.reflectIsExtensible(reflectPrevented)).toBe(1);
    expect(native.exports.reflectPreventExtensions(reflectPrevented)).toBe(1);
    expect(native.exports.reflectIsExtensible(reflectPrevented)).toBe(0);
    expect(Reflect.isExtensible(reflectPrevented)).toBe(false);
    const prevented = { value: 1 };
    expect(native.exports.boundaryIsExtensible(prevented)).toBe(1);
    expect(native.exports.boundaryPreventExtensions(prevented)).toBe(prevented);
    expect(native.exports.boundaryIsExtensible(prevented)).toBe(0);
    expect(Object.isExtensible(prevented)).toBe(false);
    const sealed = { value: 1 };
    expect(native.exports.boundaryIsSealed(sealed)).toBe(0);
    expect(native.exports.boundarySeal(sealed)).toBe(sealed);
    expect(native.exports.boundaryIsSealed(sealed)).toBe(1);
    expect(Object.isSealed(sealed)).toBe(true);
    const frozen = { value: 1 };
    expect(native.exports.boundaryIsFrozen(frozen)).toBe(0);
    expect(native.exports.boundaryFreeze(frozen)).toBe(frozen);
    expect(native.exports.boundaryIsFrozen(frozen)).toBe(1);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(native.exports.deleteBoundary(boundaryObject, "count")).toBe(1);
    expect(native.exports.hasBoundary(boundaryObject, "count")).toBe(0);
    expect("count" in boundaryObject).toBe(false);
    expect(native.exports.echo(null)).toBe(null);
    expect(native.exports.echo(undefined)).toBe(undefined);
    const equalityCases = [
      ["1", 1],
      [true, 1],
      [false, 0],
      ["x", 0],
      [null, undefined],
    ] as const;
    expect(equalityCases.map((args) => native.exports.loose(...args))).toEqual(
      equalityCases.map((args) => host.exports.loose(...args)),
    );
    expect(equalityCases.map((args) => native.exports.strict(...args))).toEqual(
      equalityCases.map((args) => host.exports.strict(...args)),
    );
    const relationalCases = [
      ["2", 10],
      [10, "2"],
      ["10", "2"],
    ] as const;
    expect(relationalCases.map((args) => native.exports.less(...args))).toEqual(
      relationalCases.map((args) => host.exports.less(...args)),
    );
    expect(wasmImports(native.result.binary).some((entry) => entry.name === "__host_loose_eq")).toBe(false);
    expect(native.result.hostImportInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "__boundary_object_get", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_object_set", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_object_has", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_object_delete", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_object_keys", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_object_call", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_object_apply", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_object_construct", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_object_reflect_get", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_object_reflect_set", classification: "value-adapter" }),
        expect.objectContaining({
          name: "__boundary_object_define_property_value",
          classification: "value-adapter",
        }),
        expect.objectContaining({
          name: "__boundary_object_define_property_accessor",
          classification: "value-adapter",
        }),
        expect.objectContaining({
          name: "__boundary_object_get_own_property_names",
          classification: "value-adapter",
        }),
        expect.objectContaining({
          name: "__boundary_object_get_own_property_symbols",
          classification: "value-adapter",
        }),
        expect.objectContaining({ name: "__boundary_object_for_in_keys", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_object_own_keys", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_object_is_admitted", classification: "value-adapter" }),
        expect.objectContaining({ name: "__boundary_callback_call_1", classification: "value-adapter" }),
      ]),
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "legacy-semantic")).toEqual(
      [],
    );
    expect(native.result.hostImportInventory?.filter((entry) => entry.classification === "unknown")).toEqual([]);
    expect(native.result.hostImportSummary?.byClassification).toMatchObject({
      "legacy-semantic": 0,
      unknown: 0,
    });
    const crossingCounts = native.imports.takeImportCounts?.() ?? {};
    expect(crossingCounts.__boundary_object_get).toBeGreaterThan(0);
    expect(crossingCounts.__boundary_object_call).toBeGreaterThan(0);
    expect(crossingCounts.__boundary_object_apply).toBeGreaterThan(0);
    expect(crossingCounts.__boundary_object_construct).toBeGreaterThan(0);
    expect(crossingCounts.__boundary_object_reflect_get).toBeGreaterThan(0);
    expect(crossingCounts.__boundary_object_reflect_set).toBeGreaterThan(0);
    expect(crossingCounts.__boundary_object_own_keys).toBeGreaterThan(0);
    expect(crossingCounts.__boundary_object_freeze).toBeGreaterThan(0);
    expect(crossingCounts.__boundary_object_is_frozen).toBeGreaterThan(0);
    expect(crossingCounts.__boundary_callback_call_1).toBeGreaterThan(0);
  });
});
