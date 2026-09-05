// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4722 — Reflect.setPrototypeOf must reject every non-object, non-null
// prototype and every non-object target in both the host and standalone lanes.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4722.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), `${lane} module failed validation`).toBe(true);

  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  const imports = result.importObject!;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

const SYMBOL_VALIDATION = `
  export function test(): number {
    let caught = 0;
    try { Reflect.setPrototypeOf(Symbol(1), {}); } catch (error) { caught++; }
    const symbolProto = Symbol("proto");
    try { Reflect.setPrototypeOf({}, symbolProto); } catch (error) { caught++; }
    return caught === 2 ? 1 : 0;
  }
`;

const PRIMITIVE_PROTO_VALIDATION = `
  export function test(): number {
    const target: any = {};
    let caught = 0;
    try { Reflect.setPrototypeOf(target, undefined); } catch (error) { caught++; }
    try { Reflect.setPrototypeOf(target, 42); } catch (error) { caught++; }
    const nullResult = Reflect.setPrototypeOf(target, null);
    return caught === 2 && nullResult === true ? 1 : 0;
  }
`;

const PRIMITIVE_TARGET_CONTROL = `
  export function test(): number {
    try { Reflect.setPrototypeOf(1, {}); return 0; }
    catch (error) { return 1; }
  }
`;

describe("#4722 — Reflect.setPrototypeOf validation", () => {
  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: Symbol target and prototype throw TypeError`, async () => {
      await expect(run(SYMBOL_VALIDATION, lane)).resolves.toBe(1);
    });

    it(`${lane}: undefined and primitive prototypes throw, null remains legal`, async () => {
      await expect(run(PRIMITIVE_PROTO_VALIDATION, lane)).resolves.toBe(1);
    });

    it(`${lane}: ordinary primitive target remains a TypeError`, async () => {
      await expect(run(PRIMITIVE_TARGET_CONTROL, lane)).resolves.toBe(1);
    });
  }
});
