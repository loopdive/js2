// #3576 — `deepEqual.js` `format` closure failed Wasm validation with
// `call_ref ... need 4, got 3`. Root cause (measured — NOT the array-callback
// trampoline the original writeup guessed): `format` calls the nested function
// `lazyResult(strings, ...subs)` as a TAGGED TEMPLATE at varying substitution
// counts. `lazyResult` has a rest param AND a TDZ-flagged capture (`usage`), so
// its lifted signature is `[usageVal, usageTdzFlag, strings, subsVec]`. Two
// gaps under-pushed the stack: (1) `nested-declarations.ts` never registered
// the rest param in `ctx.funcRestParams`; (2) `string-ops.ts` tagged-template
// KNOWN-FUNC dispatch pushed only the value captures (not the TDZ-flag box) and
// mis-counted `captureCount`. Fix registers the rest param + pushes the tdz-flag
// box + offsets by the correct capture count.
//
// These guards are self-contained (no test262 submodule dependency): they
// reproduce the exact nested-rest-tag-with-tdz-capture shape.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileGc(src: string) {
  return (await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as any)) as any;
}

async function runExport(src: string, name = "test"): Promise<unknown> {
  const r = await compileGc(src);
  expect(r.success).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  return (instance.exports as Record<string, () => unknown>)[name]!();
}

describe("#3576 — nested rest-param tag function (deepEqual.js format arity fix)", () => {
  it("a nested `(strings, ...subs)` tag with a TDZ-flagged capture, called as a tagged template at VARYING substitution counts, compiles to a VALID binary (no `call_ref need N, got N-1`)", async () => {
    // The exact #3576 shape: rest param + a `let` (TDZ-flagged) capture + a
    // body that materialises the rest as an array, called with 1 AND 2 subs.
    const src = `export function test(): string {
      let usage = "U";                       // let => TDZ-flagged capture
      function lazyResult(strings, ...subs) {
        let r = subs.map(s => String(s)).join(",");
        return strings.length + "|" + r + usage;
      }
      let a = lazyResult\`A\${1}B\`;             // 1 sub
      let b = lazyResult\`A\${1}B\${2}C\`;        // 2 subs
      return a + ";" + b;
    }`;
    const r = await compileGc(src);
    expect(r.success).toBe(true);
    // The regression was a hard WebAssembly validation failure at the tag call.
    await expect(WebAssembly.compile(r.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
  });

  it("renders a nested rest tag (with a TDZ capture) byte-correctly across substitution counts", async () => {
    // Broader guard: the rest param is packed into a vec (correct arity + values)
    // and the capture is threaded. Direct-analogue of the isolation battery.
    const body = (tag: string) => `${tag}\`A\${1}B\` + ";" + ${tag}\`A\${1}B\${2}C\``;
    const src = `export function test(): string {
      let marker = "M";
      function tag(strings, ...subs) { return strings.join("|") + "#" + subs.length + marker; }
      return ${body("tag")};
    }`;
    const got = await runExport(src);
    const expected = new Function(
      'let marker="M"; function tag(strings,...subs){return strings.join("|")+"#"+subs.length+marker;} return ' +
        body("tag") +
        ";",
    )();
    expect(got).toBe(expected);
  });

  it("a nested rest function called DIRECTLY (not as a tagged template) at varying arity renders correctly (was broken on main: undefined / null-deref)", async () => {
    const src = `export function test(): string {
      function f(a, ...xs) { return a + ":" + xs.map(x => String(x)).join(",") + "/" + xs.length; }
      return f("p", 1, 2, 3) + ";" + f("q", 9) + ";" + f("r");
    }`;
    const got = await runExport(src);
    expect(got).toBe("p:1,2,3/3;q:9/1;r:/0");
  });
});
