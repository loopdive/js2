// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7098 — a closure handed to a platform extern (`addEventListener`) or a user
// `declare function` is called back by the host, and the host must read its
// result as a JS value. Before: the native regime returned the raw
// `__call_fn_*` externref, so `void`/`undefined`/Boolean/string results reached
// the host as empty null-prototype objects (host-assisted answered correctly).

import { describe, expect, it } from "vitest";

import { compile, type CompileOptions } from "../src/index.js";
import { buildImports, wrapCompiledExports } from "../src/runtime.js";

const RESULT_CASES: ReadonlyArray<readonly [string, string, (value: unknown) => void]> = [
  ["nothing", `() => { sink.textContent = "x"; }`, (v) => expect(v).toBeUndefined()],
  ["undefined", `() => undefined`, (v) => expect(v).toBeUndefined()],
  ["null", `() => null`, (v) => expect(v).toBeNull()],
  ["true", `() => true`, (v) => expect(v).toBe(true)],
  ["false", `() => false`, (v) => expect(v).toBe(false)],
  ["number", `() => 42`, (v) => expect(v).toBe(42)],
  ["string", `() => "lit"`, (v) => expect(v).toBe("lit")],
  ["closure", `() => (y: number) => y + 1`, (v) => expect((v as (y: number) => number)(1)).toBe(2)],
];

async function captureCallback(
  via: "listener" | "declared",
  body: string,
  options: CompileOptions = {},
): Promise<{ callback: Function; exports: Record<string, Function> }> {
  const source =
    via === "listener"
      ? `export function install(target: EventTarget, sink: HTMLElement): void {
           target.addEventListener("tick", ${body});
         }`
      : `declare function hostCall(f: () => any): void;
         export function install(sink: any): void { hostCall(${body}); }`;
  const result = await compile(source, {
    fileName: "issue-7098.ts",
    experimentalIR: true,
    skipSemanticDiagnostics: true,
    ...options,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  let captured: unknown;
  const deps = { hostCall: (f: unknown) => void (captured = f) };
  const imports = buildImports(result.imports, via === "declared" ? deps : undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  const wrapped = wrapCompiledExports(result, instance);
  const sink = { textContent: "" };
  const target = { addEventListener: (_type: string, listener: unknown) => void (captured = listener) };
  if (via === "listener") wrapped.install(target, sink);
  else wrapped.install(sink);
  expect(typeof captured).toBe("function");
  return { callback: captured as Function, exports: instance.exports as Record<string, Function> };
}

describe("#7098 closure results read by the host (native regime, JS environment)", () => {
  for (const via of ["listener", "declared"] as const) {
    it.each(RESULT_CASES)(`${via}: a closure returning %s answers the JS value`, async (_name, body, check) => {
      const { callback } = await captureCallback(via, body);
      check(callback());
    });
  }

  it("the host-facing callable is identity-stable per closure", async () => {
    const result = await compile(
      `export function install(target: EventTarget, sink: HTMLElement): void {
         const f = () => { sink.textContent = "x"; };
         target.addEventListener("a", f);
         target.removeEventListener("a", f);
       }`,
      { fileName: "issue-7098-identity.ts", experimentalIR: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const seen: Function[] = [];
    wrapCompiledExports(result, instance).install(
      {
        addEventListener: (_t: string, l: Function) => {
          seen.push(l);
        },
        removeEventListener: (_t: string, l: Function) => {
          seen.push(l);
        },
      },
      { textContent: "" },
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]!()).toBeUndefined();
  });

  it("exports the result probes only where the closure bridge meets a JS boundary", async () => {
    const { exports } = await captureCallback("listener", `() => true`);
    expect(Object.keys(exports)).toEqual(
      expect.arrayContaining(["__dynamic_boundary_tag", "__typeof_boolean", "__unbox_boolean"]),
    );
    const plain = await compile(`export function add(a: number, b: number): number { return a + b; }`, {
      fileName: "issue-7098-plain.ts",
    });
    const plainExports = WebAssembly.Module.exports(new WebAssembly.Module(plain.binary)).map((entry) => entry.name);
    expect(plainExports).not.toContain("__dynamic_boundary_tag");
    for (const target of ["standalone", "wasi"] as const) {
      const hostFree = await compile(`export function run(): number { const f = () => true; return f() ? 1 : 0; }`, {
        fileName: "issue-7098-host-free.ts",
        target,
      });
      expect(hostFree.success).toBe(true);
      const names = WebAssembly.Module.exports(new WebAssembly.Module(hostFree.binary)).map((entry) => entry.name);
      expect(names.filter((name) => name === "__dynamic_boundary_tag" || name.endsWith("_boolean"))).toEqual([]);
    }
  });
});
