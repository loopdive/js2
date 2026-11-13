// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6655: compiler fnctor ownership, rather than a legal class-name prefix,
// decides whether reflective operations leave the closed-struct path.
import { describe, expect, it } from "vitest";
import { tryNativeExnRender } from "../scripts/lib/wasm-exn-render.mjs";
import { buildImports, compile, instantiateWasm } from "../src/index.ts";

type Lane = "gc" | "standalone";

function runNode(source: string): string {
  const main = new Function(`"use strict";\n${source.replace(/^export /gm, "")}\nreturn main;`)() as () => unknown;
  return String(main());
}

async function runLane(source: string, lane: Lane): Promise<string> {
  const result = await compile(source, {
    fileName: "case.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone", hostBridge: "always" } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const value = (instance.exports.main as () => unknown)();
    return value !== null && typeof value === "object"
      ? (tryNativeExnRender(instance, value) ?? "[wasm-object]")
      : String(value);
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return String((instance.exports.main as () => unknown)());
}

const EXPECTED = "$user|ordinary/7|3/2:$user:7|ordinary:3/7,true,true,true";

describe("#6655 reflective class ownership", () => {
  for (const name of ["OrdinaryUser", "__fnctor_User"] as const) {
    for (const lane of ["gc", "standalone"] as const) {
      it(`${lane}: legitimate ${name} keeps its own dollar and ordinary fields`, async () => {
        const source = `class ${name} {
  constructor() { this.$user = 7; this.ordinary = 3; }
}
export function main() {
  var value = new ${name}();
  var descriptor = Object.getOwnPropertyDescriptor(value, "$user");
  var entries = Object.entries(value);
  return Object.keys(value).join("|") + "/" + Object.values(value).join("|") + "/" +
    entries.length + ":" + entries[0][0] + ":" + entries[0][1] + "|" + entries[1][0] + ":" + entries[1][1] + "/" +
    (descriptor ? descriptor.value + "," + descriptor.enumerable + "," + descriptor.writable + "," + descriptor.configurable : "missing");
}`;
        const node = runNode(source);
        expect(node).toBe(EXPECTED);
        expect(await runLane(source, lane)).toBe(node);
      });
    }
  }
});
