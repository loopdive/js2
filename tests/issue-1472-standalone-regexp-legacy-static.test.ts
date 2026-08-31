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
class OwnRegExp extends RegExp { static input = 7; static ["$_"] = 8; }
class Plain { static ["$1"] = 7; }
class ParentRegExp extends RegExp {
  static input = 7;
  static ["$1"] = 8;
  static get lastMatch() { return 6; }
}
class ChildRegExp extends ParentRegExp {}
class TransitiveRegExp extends MyRegExp {}
const ChildRegExpAlias = ChildRegExp;
const MyRegExpAlias = MyRegExp;
const TransitiveRegExpAlias = TransitiveRegExp;
const DirectHeritageAlias = RegExp;
class DirectAliasRegExp extends DirectHeritageAlias {}
class AliasedParentRegExp extends RegExp {}
const TransitiveHeritageAlias = AliasedParentRegExp;
class TransitiveAliasRegExp extends TransitiveHeritageAlias {}

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

export function subclassLegacySetters(): number {
  let passed = 0;
  try { MyRegExp.input = ""; } catch (error) { if (error instanceof TypeError) passed++; }
  try { MyRegExp["$_"] = ""; } catch (error) { if (error instanceof TypeError) passed++; }
  return passed;
}

export function controls(): number {
  let directThrows = 0;
  try { RegExp["$1"]; } catch { directThrows++; }
  const ordinaryStatic = Plain["$1"] === 7;
  const ownSubclassStatic = OwnRegExp.input === 7;
  return directThrows * 100 + (ordinaryStatic ? 10 : 0) + (ownSubclassStatic ? 1 : 0);
}

export function inheritedAndAliasedStatics(): number {
  const key = "$1";
  return (
    ChildRegExp.input +
    ChildRegExp[key] +
    ChildRegExp.lastMatch +
    ChildRegExpAlias.input +
    ChildRegExpAlias[key] +
    ChildRegExpAlias.lastMatch
  );
}

export function aliasedLegacyNames(): number {
  try {
    MyRegExpAlias.input;
    return 0;
  } catch (error) {
    return error instanceof TypeError ? 1 : 2;
  }
}

export function aliasedLegacySetters(): number {
  let passed = 0;
  try { MyRegExpAlias.input = ""; } catch (error) { if (error instanceof TypeError) passed++; }
  try { MyRegExpAlias["$_"] = ""; } catch (error) { if (error instanceof TypeError) passed++; }
  try { TransitiveRegExp.input = ""; } catch (error) { if (error instanceof TypeError) passed++; }
  try { TransitiveRegExpAlias["$_"] = ""; } catch (error) { if (error instanceof TypeError) passed++; }
  return passed;
}

export function aliasedHeritageRegExpStatics(): number {
  let passed = 0;
  try { DirectAliasRegExp.input; } catch (error) { if (error instanceof TypeError) passed++; }
  try { DirectAliasRegExp.input = ""; } catch (error) { if (error instanceof TypeError) passed++; }
  try { TransitiveAliasRegExp.input; } catch (error) { if (error instanceof TypeError) passed++; }
  try { TransitiveAliasRegExp["$_"] = ""; } catch (error) { if (error instanceof TypeError) passed++; }
  return passed;
}

export function setterControls(): number {
  let result = 0;
  try { RegExp.input = "intrinsic"; if (RegExp.input === "intrinsic") result |= 1; } catch {}
  try { RegExp["$_"] = "intrinsic-alias"; if (RegExp["$_"] === "intrinsic-alias") result |= 2; } catch {}
  try { OwnRegExp.input = 11; if (OwnRegExp.input === 11) result |= 4; } catch {}
  try { OwnRegExp["$_"] = 12; if (OwnRegExp["$_"] === 12) result |= 8; } catch {}
  try { Plain.input = 13; if (Plain.input === 13) result |= 16; } catch {}
  try { Plain["$_"] = 14; if (Plain["$_"] === 14) result |= 32; } catch {}
  return result;
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
      subclassLegacySetters(): number;
      controls(): number;
      inheritedAndAliasedStatics(): number;
      aliasedLegacyNames(): number;
      aliasedLegacySetters(): number;
      aliasedHeritageRegExpStatics(): number;
      setterControls(): number;
    };
    expect(exports.subclassLegacyNames()).toBe(19);
    expect(exports.subclassLegacySetters()).toBe(2);
    expect(exports.controls()).toBe(11);
    expect(exports.inheritedAndAliasedStatics()).toBe(42);
    expect(exports.aliasedLegacyNames()).toBe(1);
    expect(exports.aliasedLegacySetters()).toBe(4);
    expect(exports.aliasedHeritageRegExpStatics()).toBe(4);
    expect(exports.setterControls()).toBe(63);
  });
});
