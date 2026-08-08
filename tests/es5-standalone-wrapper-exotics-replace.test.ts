// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4232) Reflective `String.prototype.replace` in `--target standalone` — the
 * arm #4224 named as its own leftover.
 *
 * #4224 made the DIRECT path (`"abc".replace(…)`) handle function replacers and
 * non-string replacement values. The ES5 sputnik battery under
 * `test/built-ins/String/prototype/replace/` mostly does something else: it
 * TRANSFERS the method onto a non-string receiver
 * (`__instance.replace = String.prototype.replace`), which reaches the
 * `native-proto.ts` closure factory. That closure had no `replace` arm and
 * threw "not yet implemented in --target standalone".
 *
 * Compiled as JS (`allowJs`) for the same reason `es5-standalone-split.test.ts`
 * is: the transferred-method idiom has no TypeScript spelling, and the TS-typed
 * spellings route to a different (already-native) lowering — so a TS-lane
 * version of these cases would silently exercise the wrong path and pass
 * vacuously.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<unknown> {
  const result = await compile(`export function f() {\n${body}\n}`, {
    allowJs: true,
    fileName: "es5-standalone-replace-transfer.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { f: () => unknown }).f();
}

describe("#4232 — reflective String.prototype.replace (standalone)", () => {
  it("ToStrings this, the search value and the replacement (§22.1.3.19 steps 3/4/6)", async () => {
    // S15.5.4.11_A1_T1 verbatim: every one of the three operands is a
    // non-string, so a body that only handled strings would answer nothing
    // useful here.
    const src = `var o = new Object(true); o.replace = String.prototype.replace;
      return o.replace(true, 1) === "1" ? 1 : 0;`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("returns the subject unchanged when the search value is absent (step 9)", async () => {
    const src = `var o = new Object("abcabc"); o.replace = String.prototype.replace;
      return o.replace("zz", "X") === "abcabc" ? 1 : 0;`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("replaces the FIRST occurrence only, splicing around it (steps 10/12)", async () => {
    const src = `var o = new Object("abcabc"); o.replace = String.prototype.replace;
      return o.replace("b", "X") === "aXcabc" ? 1 : 0;`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("expands $-patterns through GetSubstitution, not literally (step 11)", async () => {
    // The STRING-search path calls the same GetSubstitution the RegExp path
    // does, so `$&` / `` $` `` / `$'` / `$$` are live here. Concatenating the
    // replacement literally would answer "a[$&]cabc".
    const src = `var o = new Object("abcabc"); o.replace = String.prototype.replace;
      return o.replace("b", "[$&]") === "a[b]cabc" ? 1 : 0;`;
    expect(await runStandalone(src)).toBe(1);
    const dollars = `var o = new Object("abc"); o.replace = String.prototype.replace;
      return o.replace("b", "$$") === "a$c" ? 1 : 0;`;
    expect(await runStandalone(dollars)).toBe(1);
    const before = `var o = new Object("abc"); o.replace = String.prototype.replace;
      return o.replace("b", "<$\`>") === "a<a>c" ? 1 : 0;`;
    expect(await runStandalone(before)).toBe(1);
    const after = `var o = new Object("abc"); o.replace = String.prototype.replace;
      return o.replace("b", "<$'>") === "a<c>c" ? 1 : 0;`;
    expect(await runStandalone(after)).toBe(1);
  });

  it("an out-of-range $n passes through literally (no capture groups exist)", async () => {
    // nGroups is 1 (group 0 = the whole match), so `$1` has no referent and
    // §22.1.3.19 GetSubstitution leaves it alone.
    const src = `var o = new Object("abc"); o.replace = String.prototype.replace;
      return o.replace("b", "$1") === "a$1c" ? 1 : 0;`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("the DIRECT path is untouched by the reflective arm", async () => {
    const src = `return "abcabc".replace("b", "X") === "aXcabc" ? 1 : 0;`;
    expect(await runStandalone(src)).toBe(1);
  });
});
