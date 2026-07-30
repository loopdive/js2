// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #3663 — ToPropertyDescriptor uses prototype-inclusive [[HasProperty]]/[[Get]].
 *
 * A native descriptor carrier (`new Date()`, `Math`, etc.) and the compiler's
 * `$NativeProto` façade use different runtime representations. Consequently,
 * `Date.prototype.writable = true` was visible on the façade but not when
 * Object.defineProperty read the Date instance: the property was created with
 * writable/configurable false. The authentic ES5 slice failed for every tested
 * native carrier in both attribute directions.
 *
 * Each semantic observation has its own bit so direct descriptor reflection
 * cannot hide a broken write/delete enforcement path (or vice versa). The
 * false/omitted rows protect #3661's opposite, over-permissive direction.
 */
const SOURCE = `
export function test(): number {
  let bits = 0;

  // Inherited TRUE, descriptor in a variable: red on the merge base.
  const writableTarget: any = {};
  (Date.prototype as any).writable = true;
  const dateDescriptor: any = new Date();
  Object.defineProperty(writableTarget, "x", dateDescriptor);
  delete (Date.prototype as any).writable;
  const writableDesc: any = Object.getOwnPropertyDescriptor(writableTarget, "x");
  if (writableDesc.writable === true) bits |= 1;
  try { writableTarget.x = 7; } catch {}
  if (writableTarget.x === 7) bits |= 2;

  // Inherited TRUE, direct intrinsic carrier: red on the merge base.
  const configurableTarget: any = {};
  (Object.prototype as any).configurable = true;
  Object.defineProperty(configurableTarget, "x", Math);
  delete (Object.prototype as any).configurable;
  const configurableDesc: any = Object.getOwnPropertyDescriptor(configurableTarget, "x");
  if (configurableDesc.configurable === true) bits |= 4;
  try { delete configurableTarget.x; } catch {}
  if (!Object.prototype.hasOwnProperty.call(configurableTarget, "x")) bits |= 8;

  // Inline and variable own-TRUE shapes stay true.
  const inlineTrue: any = {};
  Object.defineProperty(inlineTrue, "x", { value: 1, writable: true, configurable: true });
  const inlineTrueDesc: any = Object.getOwnPropertyDescriptor(inlineTrue, "x");
  if (inlineTrueDesc.writable === true && inlineTrueDesc.configurable === true) bits |= 16;

  const ownTrue: any = {};
  const ownTrueDescriptor: any = { value: 1, writable: true, configurable: true };
  Object.defineProperty(ownTrue, "x", ownTrueDescriptor);
  const ownTrueDesc: any = Object.getOwnPropertyDescriptor(ownTrue, "x");
  if (ownTrueDesc.writable === true && ownTrueDesc.configurable === true) bits |= 32;

  // Opposite direction: inherited FALSE remains restrictive.
  const inheritedFalse: any = {};
  (Date.prototype as any).writable = false;
  (Date.prototype as any).configurable = false;
  Object.defineProperty(inheritedFalse, "x", new Date());
  delete (Date.prototype as any).writable;
  delete (Date.prototype as any).configurable;
  const inheritedFalseDesc: any = Object.getOwnPropertyDescriptor(inheritedFalse, "x");
  if (inheritedFalseDesc.writable === false && inheritedFalseDesc.configurable === false) bits |= 64;
  try { inheritedFalse.x = 9; } catch {}
  try { delete inheritedFalse.x; } catch {}
  if (inheritedFalse.x === undefined && Object.prototype.hasOwnProperty.call(inheritedFalse, "x")) bits |= 128;

  // Opposite direction: inline + variable own-FALSE/omitted shapes.
  const inlineFalse: any = {};
  Object.defineProperty(inlineFalse, "x", { value: 3, writable: false, configurable: false });
  const inlineFalseDesc: any = Object.getOwnPropertyDescriptor(inlineFalse, "x");
  if (inlineFalseDesc.writable === false && inlineFalseDesc.configurable === false) bits |= 256;

  const variableFalse: any = {};
  const variableFalseDescriptor: any = { value: 3 };
  Object.defineProperty(variableFalse, "x", variableFalseDescriptor);
  const variableFalseDesc: any = Object.getOwnPropertyDescriptor(variableFalse, "x");
  if (variableFalseDesc.writable === false && variableFalseDesc.configurable === false) bits |= 512;

  // Array-element guard for #3661's opposite matrix.
  const arrayFalse: any = [3];
  Object.defineProperty(arrayFalse, "0", { writable: false, configurable: false });
  const arrayFalseDesc: any = Object.getOwnPropertyDescriptor(arrayFalse, "0");
  if (arrayFalseDesc.writable === false && arrayFalseDesc.configurable === false) bits |= 1024;

  // A syntactically earlier but unexecuted write is not a proof.
  const deadWriteTarget: any = {};
  if (false) { (Date.prototype as any).writable = true; }
  Object.defineProperty(deadWriteTarget, "x", new Date());
  const deadWriteDesc: any = Object.getOwnPropertyDescriptor(deadWriteTarget, "x");
  if (deadWriteDesc.writable === false) bits |= 2048;

  return bits;
}
`;

async function run(target: "host" | "standalone"): Promise<number> {
  const result = await compile(SOURCE, {
    fileName: "issue-3663.ts",
    skipSemanticDiagnostics: true,
    ...(target === "standalone" ? { target } : {}),
  });
  if (!result.success) {
    throw new Error(`Compile failed (${target}):\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  const imports = target === "host" ? buildImports(result.imports, undefined, result.stringPool) : {};
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports as never);
  (imports as { setExports?: (exports: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return (instance.exports as unknown as { test(): number }).test();
}

describe("#3663 inherited descriptor flags", () => {
  for (const target of ["host", "standalone"] as const) {
    it(`${target}: preserves both attribute directions across descriptor shapes`, async () => {
      expect(await run(target)).toBe(0xfff);
    });
  }
});
