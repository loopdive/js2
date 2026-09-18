// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6631 — a mixed-primitive array literal (`["x", 1976]`) under
// `--target standalone` (native strings) reported `typeof` "string" for EVERY
// element, not just the string one, because the literal's raw-externref
// elements (each already boxed by its OWN static type — `__box_number` for
// the number, a native-string cast for the string) get widened into the
// declared `(string | number)[]`'s `$AnyValue`-element vec via the generic
// `coerceType` → `boxToAny` path. That path's `undefinedSingleton` default
// (`__any_box_extern_s1`) only honestly recovers NULL and the UNDEF_F64
// sentinel `$BoxedNumber`; every other externref — including a perfectly
// ordinary boxed number — falls to the #1888 tag-5 "string" lie. The value
// itself survived (`"" + row[1]` read "1976" correctly); only the `$AnyValue`
// tag was wrong, so every `typeof`/tag-dispatched consumer misread it.
//
// The fix (type-coercion.ts `emitVecToVecBody`) routes this specific
// externref → `$AnyValue` vec-element widen through `ensureAnyFromExternHelper`
// (the #3055 classifier already used for the `===`/`==` operand seam) instead
// of the generic default, scoped to exactly this call site — `boxToAny`'s
// shared default is untouched, so the −788/−794 standalone regression a prior
// attempt hit by flipping that default globally cannot recur here.

import { describe, expect, it } from "vitest";
import { compileMulti, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

async function runStandalone(body: string): Promise<string> {
  const entry = "/__main.js";
  const result = await compileMulti(
    {
      [entry]:
        `let __s = "";\n` +
        `export function prepare() { try { ${body} } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }\n` +
        `export function at(i) { return __s.charCodeAt(i); }\n`,
    },
    entry,
    { allowJs: true, skipSemanticDiagnostics: true, canonicalRuntimeTypes: true, ...STANDALONE } as never,
  );
  if (!result.success) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const { instance } = await instantiateLinkedProject(result, {});
  const exports = instance.exports as unknown as { prepare: () => number; at: (i: number) => number };
  const length = exports.prepare();
  let out = "";
  for (let index = 0; index < length; index++) out += String.fromCharCode(exports.at(index));
  return out;
}

async function runGc(body: string): Promise<string> {
  const entry = "/__main.js";
  const result = await compileMulti(
    {
      [entry]:
        `let __s = "";\n` +
        `export function prepare() { try { ${body} } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }\n` +
        `export function at(i) { return __s.charCodeAt(i); }\n`,
    },
    entry,
    { allowJs: true, skipSemanticDiagnostics: true, canonicalRuntimeTypes: true } as never,
  );
  if (!result.success) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const { instance } = await instantiateLinkedProject(result);
  const exports = instance.exports as unknown as { prepare: () => number; at: (i: number) => number };
  const length = exports.prepare();
  let out = "";
  for (let index = 0; index < length; index++) out += String.fromCharCode(exports.at(index));
  return out;
}

describe("#6631 — mixed-primitive array literal element carries the correct typeof tag (standalone)", () => {
  it("typeof the NUMBER element of a string-then-number literal is 'number'", async () => {
    expect(await runStandalone(`const row = ["x", 1976]; __s = typeof row[1];`)).toBe("number");
  });

  it("typeof the STRING element of a number-then-string literal is 'string'", async () => {
    expect(await runStandalone(`const row = [1976, "x"]; __s = typeof row[0];`)).toBe("number");
    expect(await runStandalone(`const row = [1976, "x"]; __s = typeof row[1];`)).toBe("string");
  });

  it("typeof the BOOLEAN element of a string-then-boolean literal is 'boolean'", async () => {
    expect(await runStandalone(`const row = ["x", true]; __s = typeof row[1];`)).toBe("boolean");
  });

  it("for-of destructure + rest spread preserves the element tag", async () => {
    expect(
      await runStandalone(`
        const rows = [["x", 1976]];
        for (const [a, ...rest] of rows) { __s = typeof rest[0]; }
      `),
    ).toBe("number");
  });

  it("control: strict-equality on the recovered tag (already fixed by #3055) still agrees", async () => {
    expect(await runStandalone(`const row = ["x", 1976]; __s = (typeof row[1] === "number") ? "yes" : "no";`)).toBe(
      "yes",
    );
  });

  it("control: the VALUE itself was never corrupted, only the tag", async () => {
    expect(await runStandalone(`const row = ["x", 1976]; __s = "" + row[1];`)).toBe("1976");
  });

  it("control: an all-string literal is unaffected", async () => {
    expect(await runStandalone(`const row = ["x", "y"]; __s = typeof row[1];`)).toBe("string");
  });

  it("control: an all-number literal is unaffected", async () => {
    expect(await runStandalone(`const row = [1, 2]; __s = typeof row[1];`)).toBe("number");
  });

  it("control: --target gc (non-standalone) is unaffected by the standalone-specific arm", async () => {
    expect(await runGc(`const row = ["x", 1976]; __s = typeof row[1];`)).toBe("number");
  });
});
