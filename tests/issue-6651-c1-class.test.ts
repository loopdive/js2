// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 lane C1 — §15.7.14 `constructor` as an OWN property, and `static
 * constructor(){}` as an ordinary static method.
 *
 * Three facts, all target-independent (§15.7 / §15.7.14 say nothing about a
 * host), each of which the compiler answered wrongly before this lane:
 *
 *  1. `MakeConstructor(F, false, proto)` installs `constructor` on
 *     `C.prototype` as an own, NON-enumerable data property. The
 *     `hasOwnProperty` / `propertyIsEnumerable` compile-time fold in
 *     `object-ops.ts` answers a prototype receiver from the class's DECLARED
 *     elements, and `constructor` is not one — so it folded a constant `false`
 *     while standalone's prototype `$Object` (#3976) genuinely carried the
 *     property and `gOPD` / `getOwnPropertyNames` on the SAME object both said
 *     it was own.
 *  2. `static constructor(){}` is a static METHOD whose PropName is
 *     "constructor" (§15.7), so it owns a key on the class object. TypeScript
 *     parses it as a `ConstructorDeclaration` with a `static` modifier, so it
 *     is not a member of `typeof C` and the same fold could not see it. The
 *     class-EXPRESSION spelling needs `classExprNameMap` to reach the
 *     collector's synthetic class name.
 *  3. `static async constructor(){}` is LEGAL. The early-error check rejected
 *     every async `ConstructorDeclaration`, and the `static` exemption one
 *     branch up cannot apply because `getMemberName` reports no name for a
 *     `ConstructorDeclaration`.
 *
 * test262 rows these carry (measured 2026-09-26, `--target standalone`,
 * original-harness runner): the 10-row `grammar-static-ctor-*-valid` family
 * went 0/10 → 8/10 standalone and 0/10 → 10/10 host. The two
 * `accessor-meth` rows still fail on standalone for a DIFFERENT reason — a
 * comparison fold, not a presence one; see the issue receipt.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "host" | "standalone";

/** Compile `decl` plus a boolean probe of `expr`, run it, return the answer. */
async function probe(decl: string, expr: string, target: Target): Promise<boolean> {
  const source = `${decl}
export function test(): number { return (${expr}) ? 1 : 0; }`;
  const options: Record<string, unknown> = { fileName: "test.ts" };
  if (target === "standalone") options.target = "standalone";
  const result = await compile(source, options as never);
  expect(
    result.success,
    `[${target}] compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  imports.setInstance?.(instance);
  const test = (instance.exports as Record<string, () => number>).test;
  expect(test, `[${target}] module has no \`test\` export`).toBeTypeOf("function");
  return Number(test()) !== 0;
}

const TARGETS: Target[] = ["host", "standalone"];

describe("#6651 C1 — §15.7.14 own `constructor` on a class prototype", () => {
  for (const target of TARGETS) {
    it(`[${target}] C.prototype has an own, non-enumerable \`constructor\``, async () => {
      const decl = `class C { constructor() {} m() {} }`;
      expect(await probe(decl, `C.prototype.hasOwnProperty('constructor')`, target)).toBe(true);
      expect(await probe(decl, `C.prototype.propertyIsEnumerable('constructor')`, target)).toBe(false);
      // The declared method stays own; the instance field surface is untouched.
      expect(await probe(decl, `C.prototype.hasOwnProperty('m')`, target)).toBe(true);
    });

    it(`[${target}] a member-less class still reports own \`constructor\``, async () => {
      expect(await probe(`class C {}`, `C.prototype.hasOwnProperty('constructor')`, target)).toBe(true);
    });

    it(`[${target}] a class WITHOUT \`static constructor\` has no own \`constructor\` on C`, async () => {
      // Guard against over-reach: only a declared static member named
      // "constructor" may make the class object report the key as own.
      expect(
        await probe(`class C { static foo() {} constructor() {} }`, `C.hasOwnProperty('constructor')`, target),
      ).toBe(false);
    });
  }
});

describe("#6651 C1 — `static constructor(){}` is an ordinary static method", () => {
  const shapes: Array<[string, string]> = [
    ["declaration", `class C { static constructor() {} constructor() {} }`],
    ["expression", `var C = class { static constructor() {} constructor() {} };`],
    ["generator", `class C { static * constructor() {} constructor() {} }`],
    ["async", `class C { static async constructor() {} constructor() {} }`],
    ["async generator", `class C { static async * constructor() {} constructor() {} }`],
  ];
  for (const target of TARGETS) {
    for (const [name, decl] of shapes) {
      it(`[${target}] ${name}: C owns "constructor" and C.prototype still owns its own`, async () => {
        expect(await probe(decl, `C.hasOwnProperty('constructor')`, target)).toBe(true);
        expect(await probe(decl, `C.prototype.hasOwnProperty('constructor')`, target)).toBe(true);
      });
    }
  }
});

describe("#6651 C1 — `static async constructor(){}` is not an early error", () => {
  it("compiles, while a non-static `async constructor(){}` is still rejected", async () => {
    const ok = await compile(`class C { static async constructor() {} constructor() {} }`, { fileName: "test.ts" });
    expect(ok.success, ok.errors.map((e) => e.message).join("; ")).toBe(true);
    const bad = await compile(`class C { async constructor() {} }`, { fileName: "test.ts" });
    expect(bad.success).toBe(false);
    expect(bad.errors.some((e) => e.message.includes("may not be an async method"))).toBe(true);
  });
});
