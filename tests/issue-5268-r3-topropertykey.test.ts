// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5268 r3 step R3-9 S) §20.1.3.2 step 1 is `? ToPropertyKey(V)` — it runs
 * BEFORE step 2's `ToObject(this)`, so a key whose `toString` throws beats the
 * nullish-receiver TypeError, and the key is coerced with hint "string".
 *
 * The borrowed-nullish-receiver arm compiled the argument and DROPPED it,
 * which evaluates the expression but performs no coercion — the key's getter
 * never ran. Verified RED on the pre-change tree (`.tmp/basetree`): the same
 * program prints "threw TypeError" / "hint=none".
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runLines(body: string): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5268-r3-topropertykey.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    nativeStrings: true,
    hostBridge: "always",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, (...args: number[]) => number>;
  let threw = false;
  try {
    exports.__module_init!();
  } catch {
    threw = true;
  }
  const length = exports.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < length; i++) sink += String.fromCharCode(exports.__stdout_char!(i) & 0xffff);
  const lines = sink.split("\n").filter((l) => l.length > 0);
  if (threw) lines.push("THREW");
  return lines;
}

describe("#5268 r3 — hasOwnProperty coerces the key before the nullish-this throw", () => {
  it("the key's abrupt ToPropertyKey beats the receiver TypeError, with hint string", async () => {
    const lines = await runLines(`
      var hint = "none";
      try {
        Object.prototype.hasOwnProperty.call(null, {
          toString: function () { hint = "string"; throw new RangeError("key"); }
        });
        LOG("no-throw");
      } catch (e) {
        LOG("threw " + e.constructor.name);
      }
      LOG("hint=" + hint);
    `);
    expect(lines).toEqual(["threw RangeError", "hint=string"]);
  });

  it("an ordinary key still gets the receiver TypeError, and normal calls are unchanged", async () => {
    const lines = await runLines(`
      try { Object.prototype.hasOwnProperty.call(null, "k"); LOG("no-throw"); }
      catch (e) { LOG("threw " + e.constructor.name); }
      try { Object.prototype.propertyIsEnumerable.call(undefined, 3); LOG("no-throw"); }
      catch (e) { LOG("threw " + e.constructor.name); }
      LOG("own=" + ({ a: 1 }).hasOwnProperty("a"));
      LOG("notOwn=" + ({ a: 1 }).hasOwnProperty("b"));
    `);
    expect(lines).toEqual(["threw TypeError", "threw TypeError", "own=true", "notOwn=false"]);
  });
});
