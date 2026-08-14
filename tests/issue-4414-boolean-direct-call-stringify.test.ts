// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4414 — a devirtualized prototype-method call returns the callee's BRANDED
// boolean i32 (`{kind:"i32", boolean:true}`) under a static type of `any` (the
// receiver is an untyped constructor-function instance). Three stringification
// sites decided "is this a boolean?" from the static TS type alone and fell
// into their numeric arm, so `true` printed as "1":
//
//   - `compileNativeConcatOperand` (the standalone `+`-concat cascade,
//     deliberately NOT migrated to the coercion engine — see its #1917 note)
//   - the template-literal span path in string-ops.ts
//   - the `String(x)` builtin lowering's i32 arm (call-identifier.ts)
//
// The migrated coercion engine (`emitToString`) and the binary-op concat path
// already honoured the brand; these three now do too. The repro needs the
// DIRECT-CALL path (default-ON, standalone) — `JS2WASM_DIRECT_CALLS=0` never
// exhibited the bug because the dynamic dispatcher returns a boxed boolean
// externref that stringifies at runtime.
//
// Lane note: the equivalence oracle here is plain JS (`new Function`), not the
// js-host wasm lane — that lane cannot yet CALL an untyped-constructor
// prototype method in this harness at all (`TypeError: value is not callable`
// from `externCallRawCallable`, reproduced byte-identically on unmodified
// HEAD; the #4227 js-host reflection drift family). Nothing boolean-specific.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const PROTO_PREAMBLE = `
function P(n) { this.n = n; }
P.prototype.eat = function (x) { return this.n === x; };
`;

async function runStandalone(body: string): Promise<unknown> {
  const src = `${PROTO_PREAMBLE}
export function test() { var p = new P(5); ${body} }
`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

/** Assert the standalone build matches what plain JS evaluates the body to. */
async function matchesJs(body: string): Promise<void> {
  const oracle = new Function(`${PROTO_PREAMBLE}
var p = new P(5); ${body}`)();
  expect(await runStandalone(body), `standalone vs JS oracle for: ${body}`).toStrictEqual(oracle);
}

describe("#4414 devirtualized boolean return keeps its brand at stringification", () => {
  // Every body returns a NUMBER — a standalone module's string return is a
  // native WasmGC struct, opaque to the JS harness, so assert on .length.
  it('("" + p.eat(5)) is "true" (length 4), not "1"', async () => {
    await matchesJs(`return ("" + p.eat(5)).length;`);
  });

  it('("" + p.eat(6)) is "false" (length 5), not "0"', async () => {
    await matchesJs(`return ("" + p.eat(6)).length;`);
  });

  it("template literal spans stringify to true/false", async () => {
    // "true|false".length === 10
    await matchesJs("return `${p.eat(5)}|${p.eat(6)}`.length;");
  });

  it('String(p.eat(5)) is "true" (length 4)', async () => {
    await matchesJs(`return String(p.eat(5)).length;`);
  });

  it("strict equality against true observes a boolean, not 1", async () => {
    await matchesJs(`return p.eat(5) === true ? 10 : 20;`);
  });

  it("typeof the devirtualized result is boolean", async () => {
    await matchesJs(`return typeof p.eat(5) === "boolean" ? 10 : 20;`);
  });
});
