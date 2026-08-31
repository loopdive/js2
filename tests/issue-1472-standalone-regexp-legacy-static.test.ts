// #1472 — standalone inherited Annex B RegExp statics.
//
// A compiled subclass has a class-object carrier, but standalone's generic
// externref property path cannot observe that the inherited legacy accessors
// reject a subclass constructor as `this`. Keep the exact dynamic `$1`–`$9`
// shape alongside direct, alias, and ordinary-static controls.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SOURCE = `
class MyRegExp extends RegExp {}
class OwnRegExp extends RegExp { static input = 7; }
class Plain { static ["$1"] = 7; }

export function subclassLegacyNames(): number {
  let passed = 0;
  for (let i = 1; i <= 9; i++) {
    const key = "$" + i;
    try { MyRegExp[key]; } catch (error) { if (error instanceof TypeError) passed++; }
  }
  try { MyRegExp.input; } catch (error) { if (error instanceof TypeError) passed++; }
  try { MyRegExp.lastMatch; } catch (error) { if (error instanceof TypeError) passed++; }
  try { MyRegExp.lastParen; } catch (error) { if (error instanceof TypeError) passed++; }
  try { MyRegExp.leftContext; } catch (error) { if (error instanceof TypeError) passed++; }
  try { MyRegExp.rightContext; } catch (error) { if (error instanceof TypeError) passed++; }
  try { MyRegExp["$_"]; } catch (error) { if (error instanceof TypeError) passed++; }
  try { MyRegExp["$&"]; } catch (error) { if (error instanceof TypeError) passed++; }
  try { MyRegExp["$+"]; } catch (error) { if (error instanceof TypeError) passed++; }
  try { MyRegExp["$\`"]; } catch (error) { if (error instanceof TypeError) passed++; }
  try { MyRegExp["$'"]; } catch (error) { if (error instanceof TypeError) passed++; }
  return passed;
}

export function controls(): number {
  let directThrows = 0;
  try { RegExp["$1"]; } catch { directThrows++; }
  const ordinaryStatic = Plain["$1"] === 7;
  const ownSubclassStatic = OwnRegExp.input === 7;
  return directThrows * 100 + (ordinaryStatic ? 10 : 0) + (ownSubclassStatic ? 1 : 0);
}
`;

describe("#1472 — standalone inherited RegExp legacy statics", () => {
  it("throws for every legacy name on a RegExp subclass", async () => {
    const result = await compile(SOURCE, {
      allowJs: true,
      fileName: "issue-1472-standalone-regexp-legacy-static.ts",
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports.filter((entry) => entry.module === "env")).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
    const exports = instance.exports as unknown as {
      subclassLegacyNames(): number;
      controls(): number;
    };
    expect(exports.subclassLegacyNames()).toBe(19);
    expect(exports.controls()).toBe(11);
  });
});
