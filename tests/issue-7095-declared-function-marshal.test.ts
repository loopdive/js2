// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7095 — a user `declare function` bound to an embedder dependency receives
// JS values, not native carriers, under the default (native-regime) profile,
// and a string it returns reaches the compiled caller as a string.

import { describe, expect, it } from "vitest";

import { compile, type ImportDescriptor } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
declare function log(s: string): void;
declare function apply1(f: (x: number) => number): number;
declare function count(n: number): void;
declare function greet(): string;
declare function echo(s: string): string;
declare function maybe(): string | null;
declare function dyn(): any;
declare function toNum(): number;
export function run(): string {
  log("hi");
  log("caf\\u00e9 \\ud83d\\ude00");
  count(42);
  const a = apply1((x: number) => x * 3);
  const g = greet();
  const e = echo("yo");
  const m = maybe();
  return g + ":" + g.length + ":" + e + ":" + e.toUpperCase() + ":" + a + ":" + (m === null ? "null" : m) + ":" + dyn() + ":" + toNum();
}
`;

// The same program run by Node directly: what the host must observe.
function nodeReference(deps: Record<string, Function>): string {
  deps.log("hi");
  deps.log("café 😀");
  deps.count(42);
  const a = deps.apply1((x: number) => x * 3);
  const g = deps.greet();
  const e = deps.echo("yo");
  const m = deps.maybe();
  return `${g}:${g.length}:${e}:${e.toUpperCase()}:${a}:${m === null ? "null" : m}:${deps.dyn()}:${deps.toNum()}`;
}

function makeDeps(seen: unknown[][], maybeResult: string | null) {
  return {
    log: (s: unknown) => void seen.push(["log", typeof s, s]),
    count: (n: unknown) => void seen.push(["count", typeof n, n]),
    apply1: (f: unknown) => {
      seen.push(["apply1", typeof f]);
      return typeof f === "function" ? (f as (x: number) => number)(5) : -1;
    },
    greet: () => "hello",
    echo: (s: unknown) => {
      seen.push(["echo", typeof s, s]);
      return `${String(s)}!`;
    },
    maybe: () => maybeResult,
    dyn: () => "any-str",
    toNum: () => 7,
  } as Record<string, Function>;
}

async function compileDefault() {
  const result = await compile(SOURCE, { fileName: "issue-7095.ts", target: "gc" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

async function runWasm(result: Awaited<ReturnType<typeof compileDefault>>, deps: Record<string, Function>) {
  const imports = buildImports(result.imports, deps, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  const exports = instance.exports as Record<string, Function>;
  const raw = exports.run!();
  return typeof raw === "string" ? raw : (exports.__str_to_extern!(raw) as string);
}

describe("#7095 — declared host functions under the native regime", () => {
  it("is a native-regime module (the gap this covers exists)", async () => {
    const result = await compileDefault();
    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result.imports, makeDeps([], null), result.stringPool) as WebAssembly.Imports,
    );
    expect(typeof instance.exports.__str_is_native).toBe("function");
  });

  it.each([
    ["a string", "abc"],
    ["null", null],
  ] as const)("host observes the same values as Node (maybe() returns %s)", async (_label, maybeResult) => {
    const result = await compileDefault();
    const wasmSeen: unknown[][] = [];
    const nodeSeen: unknown[][] = [];
    const wasmOut = await runWasm(result, makeDeps(wasmSeen, maybeResult));
    const nodeOut = nodeReference(makeDeps(nodeSeen, maybeResult));
    expect(wasmSeen).toEqual(nodeSeen);
    expect(wasmOut).toBe(nodeOut);
  });

  it("records refResult only on reference-returning declared imports", async () => {
    const result = await compileDefault();
    const byName = new Map<string, ImportDescriptor>(result.imports.map((entry) => [entry.name, entry]));
    for (const name of ["greet", "echo", "maybe", "dyn"]) expect(byName.get(name)?.refResult, name).toBe(true);
    for (const name of ["log", "count", "apply1", "toNum"]) expect(byName.get(name)?.refResult, name).toBeUndefined();
    const marked = result.imports.filter((entry) => entry.refResult).map((entry) => entry.name);
    expect(marked.sort()).toEqual(["dyn", "echo", "greet", "maybe"]);
  });

  it("leaves a host-assisted module's crossings untouched", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-7095.ts",
      target: "gc",
      semanticProviders: "host-assisted",
    });
    expect(result.success).toBe(true);
    const wasmSeen: unknown[][] = [];
    const out = await runWasm(result, makeDeps(wasmSeen, "abc"));
    expect(wasmSeen.filter((entry) => entry[0] === "log")).toEqual([
      ["log", "string", "hi"],
      ["log", "string", "café 😀"],
    ]);
    // Host-assisted closures still cross opaque (pre-existing, not this marshal's lane).
    expect(wasmSeen.find((entry) => entry[0] === "apply1")).toEqual(["apply1", "object"]);
    expect(out).toBe("hello:5:yo!:YO!:-1:abc:any-str:7");
  });
});
