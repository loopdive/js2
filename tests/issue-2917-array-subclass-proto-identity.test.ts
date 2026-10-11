// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2917 — prototype identity for `class X extends Array` instances under
 * `--target standalone`.
 *
 * The instance is a plain `$__vec_externref`, so every prototype question
 * asked through a dynamic (`any`) receiver answered as if it were `[]`.
 * Measured on main `fb7607cd9e` (`.tmp/mine.mts`): `id(new J(1)) instanceof J`,
 * `Object.getPrototypeOf(id(new J(1))) === J.prototype`, a vec
 * `Object.setPrototypeOf`, `Object.getPrototypeOf(J.prototype) ===
 * Array.prototype` and `ap() === ap()` (a function returning
 * `Array.prototype`) all answered 0. `src/codegen/vec-proto-link.ts` stores
 * `C.prototype` in the instance's expando-bag `$proto` and teaches
 * `__getPrototypeOf` / `__object_setPrototypeOf` / `instanceof` to read it.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SOURCE = `
function id(v) { if (typeof v === "object") return v; return null; }
class J extends Array { constructor(n) { super(n); } m() { return 42; } }
class K extends J { k() { return 7; } }
function ap() { return Array.prototype; }
export function instJ() { return id(new J(1)) instanceof J ? 1 : 0; }
export function instKofJ() { return id(new K(1)) instanceof J ? 1 : 0; }
export function instKofK() { return id(new K(1)) instanceof K ? 1 : 0; }
export function instJofK() { return id(new J(1)) instanceof K ? 1 : 0; }
export function instPlainOfJ() { return id([]) instanceof J ? 1 : 0; }
export function instArray() { return id(new K(1)) instanceof Array ? 1 : 0; }
export function protoJ() { return Object.getPrototypeOf(id(new J(1))) === J.prototype ? 1 : 0; }
export function protoK() { return Object.getPrototypeOf(id(new K(1))) === K.prototype ? 1 : 0; }
export function setProto() {
  const x = id([1]);
  Object.setPrototypeOf(x, J.prototype);
  return Object.getPrototypeOf(x) === J.prototype && x instanceof J ? 1 : 0;
}
export function chainStatic() { return Object.getPrototypeOf(J.prototype) === Array.prototype ? 1 : 0; }
export function chainDynamic() {
  return Object.getPrototypeOf(Object.getPrototypeOf(id(new J(1)))) === Array.prototype ? 1 : 0;
}
export function chainK() { return Object.getPrototypeOf(K.prototype) === J.prototype ? 1 : 0; }
export function arrayProtoStable() { return ap() === ap() ? 1 : 0; }
export function methodStillOwn() { return id(new J(1)).m(); }
`;

const EXPECTED = {
  instJ: 1,
  instKofJ: 1,
  instKofK: 1,
  instJofK: 0,
  instPlainOfJ: 0,
  instArray: 1,
  protoJ: 1,
  protoK: 1,
  setProto: 1,
  chainStatic: 1,
  chainDynamic: 1,
  chainK: 1,
  arrayProtoStable: 1,
  methodStillOwn: 42,
};

describe("#2917 — Array-subclass prototype identity (standalone)", () => {
  it(
    "answers instanceof / getPrototypeOf / setPrototypeOf through the instance's link",
    { timeout: 120_000 },
    async () => {
      const result = (await compile(SOURCE, {
        target: "standalone",
        hostBridge: "off",
        allowJs: true,
        skipSemanticDiagnostics: true,
      } as never)) as unknown as { success: boolean; errors: { message: string }[]; binary: Uint8Array };
      expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).toBe(true);

      const module = new WebAssembly.Module(result.binary);
      const imports: Record<string, Record<string, () => null>> = {};
      for (const imported of WebAssembly.Module.imports(module)) {
        (imports[imported.module] ??= {})[imported.name] = () => null;
      }
      const exports = (await WebAssembly.instantiate(module, imports)).exports as Record<string, () => number>;
      (exports as Record<string, (() => unknown) | undefined>).__module_init?.();
      const answers: Record<string, number | string> = {};
      for (const name of Object.keys(EXPECTED)) {
        try {
          answers[name] = exports[name]!();
        } catch (error) {
          answers[name] = `threw: ${(error as Error).message}`;
        }
      }
      expect(answers).toEqual(EXPECTED);
    },
  );
});
