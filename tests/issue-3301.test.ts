import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #3301 — an eval-inlined regex literal (`eval("/abc/i")`, the #1163 constant-
// string splice) produced a value whose dynamic property reads (`.flags`,
// `.source`, …) returned `undefined`. Root cause: `compileRegExpLiteral`
// registered the `RegExp_new` import on-demand but did NOT add the minimal
// `externClasses` "RegExp" entry the manifest resolver needs to route
// `RegExp_new` to the real RegExp constructor — so it fell to the "builtin"
// intent, a no-op returning `undefined`. The pre-codegen scan registers that
// entry for a `RegularExpressionLiteral` in the REAL source AST, but an
// eval-spliced regex is a FOREIGN node that scan never walks. Fix: register the
// externClasses entry in `compileRegExpLiteral` (mirrors the eval-concat
// peephole). With the arm fixed, the widened-constant regex bail in
// `eval-inline.ts` is also removed so widened bodies inline regex literals.
async function run(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as unknown as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    instance.exports as Record<string, Function>,
  );
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!();
}

describe("#3301 eval-inlined regex literal dynamic property reads", () => {
  it("eval('/abc/i').flags === 'i' (the reported bug)", async () => {
    expect(await run(`export function test(): any { const r: any = eval("/abc/i"); return r.flags; }`)).toBe("i");
  });

  it("eval('/abc/i').source === 'abc'", async () => {
    expect(await run(`export function test(): any { const r: any = eval("/abc/i"); return r.source; }`)).toBe("abc");
  });

  it("eval('/abc/gi').flags preserves multiple flags", async () => {
    expect(await run(`export function test(): any { const r: any = eval("/abc/gi"); return r.flags; }`)).toBe("gi");
  });

  it("eval('/^a/m').multiline reads true", async () => {
    expect(await run(`export function test(): any { const r: any = eval("/^a/m"); return r.multiline ? 1 : 0; }`)).toBe(
      1,
    );
  });

  it("the eval-spliced regex is a real usable RegExp (test + match)", async () => {
    expect(
      await run(`export function test(): any { const r: any = eval("/abc/i"); return r.test("xABCy") ? 1 : 0; }`),
    ).toBe(1);
    expect(
      await run(
        `export function test(): any { const r: any = eval("/(\\\\d+)/"); const m = "a42b".match(r); return m ? m[0] : "none"; }`,
      ),
    ).toBe("42");
  });

  it("instanceof RegExp / String() were already correct (unchanged)", async () => {
    expect(
      await run(`export function test(): any { const r: any = eval("/abc/i"); return (r instanceof RegExp) ? 1 : 0; }`),
    ).toBe(1);
    expect(await run(`export function test(): any { const r: any = eval("/abc/i"); return String(r); }`)).toBe(
      "/abc/i",
    );
  });

  it("matches the non-eval regex literal's dynamic .flags read", async () => {
    expect(await run(`export function test(): any { const r: any = /abc/i; return r.flags; }`)).toBe("i");
  });

  it("widened-constant regex body inlines correctly (guard removal)", async () => {
    // A const-binding-resolved flags tail — previously bailed to the dynamic
    // path by the #1102 `containsRegexLiteral` guard; now inlines with the fixed
    // arm and reads the right flags.
    expect(
      await run(`const F = "gi"; export function test(): any { const r: any = eval("/xyz/" + F); return r.flags; }`),
    ).toBe("gi");
  });
});
