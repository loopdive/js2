// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5319 — every single-callback array HOF except `map` sent a REFERENCE element
// through the numeric callback bridge, so an unresolved callback saw `NaN`.
//
// Root cause: `setupArrayCallback`'s fallback bridge for a callback that did not
// compile to a wasm closure is `__call_1_f64` — `(externref cb, f64 arg) -> f64`.
// `buildBridgeCallInstrs` therefore pushed the loop element through
// `__unbox_number` (ToNumber). For a string / object element that is `NaN`, so
// `["x","y"].filter(Boolean)` evaluated `Boolean(NaN)` twice and returned `[]`.
// #4527 fixed exactly this for `map` by routing it to the reference-preserving
// `__call_dyn_1` bridge; `filter`/`forEach`/`find`/`findIndex`/`some`/`every`
// lowered the same fallback and kept the numeric one.
//
// "Unresolved callback" is much broader than the builtin case that surfaced it:
// only an inline arrow / function expression or a hoisted function DECLARATION
// compiles to a closure. A bare ambient builtin (`Boolean`, `String`), a
// `var`-bound function expression and an object member (`o.keep`) all fall back.
//
// These fixtures are deliberately UNTYPED `.js` in a two-file project. Adding
// `: any` / `: string[]` annotations routes the call through a different arm and
// the test then passes identically with and without the fix.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const ENTRY = `import { run } from "./mod.js";\nexport function test(): string { return String((run as unknown as () => unknown)()); }`;

async function runModule(moduleSource: string): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "js2-5319-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), moduleSource);
  writeFileSync(join(root, "entry.ts"), ENTRY);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "binary must validate").toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, () => unknown>).test!();
}

describe("#5319 — reference elements reach an unresolved array-HOF callback intact", () => {
  describe("filter", () => {
    it("filter(Boolean) keeps string elements", async () => {
      expect(await runModule(`export function run() { return ["x", "y"].filter(Boolean).length; }`)).toBe("2");
    });

    it("filter(Boolean) drops only the genuinely falsy string", async () => {
      expect(await runModule(`export function run() { return ["x", "", "y"].filter(Boolean).join("|"); }`)).toBe("x|y");
    });

    it("filter(Boolean) keeps object elements", async () => {
      expect(await runModule(`export function run() { return [{}, {}].filter(Boolean).length; }`)).toBe("2");
    });

    it("filter(Boolean) over a mixed reference/number array", async () => {
      expect(await runModule(`export function run() { return ["x", 0, "y", null].filter(Boolean).length; }`)).toBe("2");
    });

    it("filter(String) — the defect is not Boolean-specific", async () => {
      expect(await runModule(`export function run() { return ["x", "y"].filter(String).length; }`)).toBe("2");
    });

    it("split(...).filter(Boolean) — the idiom as it appears in packages", async () => {
      expect(await runModule(`export function run() { return "a,b,,c".split(",").filter(Boolean).length; }`)).toBe("3");
    });

    it("a var-bound function expression callback also gets live elements", async () => {
      expect(
        await runModule(
          `var keep = function (s) { return s.length > 0; };\nexport function run() { return ["x", "", "y"].filter(keep).length; }`,
        ),
      ).toBe("2");
    });

    it("an object-member callback also gets live elements", async () => {
      expect(
        await runModule(
          `var o = { keep: function (s) { return s !== "skip"; } };\nexport function run() { return ["x", "skip", "y"].filter(o.keep).join("|"); }`,
        ),
      ).toBe("x|y");
    });

    it("map(...).filter(Boolean) chains", async () => {
      expect(
        await runModule(
          `export function run() { return ["a b", "", "c"].filter(Boolean).map(function (s) { return s.length; }).join("|"); }`,
        ),
      ).toBe("3|1");
    });

    it("numeric elements keep the compact numeric bridge and stay correct", async () => {
      expect(await runModule(`export function run() { return [1, 0, 2, null, 3].filter(Boolean).length; }`)).toBe("3");
    });
  });

  describe("the rest of the single-callback family", () => {
    it("some(Boolean) sees the string, not NaN", async () => {
      expect(await runModule(`export function run() { return ["", "y"].some(Boolean); }`)).toBe("true");
    });

    it("every(Boolean) sees the string, not NaN", async () => {
      expect(await runModule(`export function run() { return ["x", "y"].every(Boolean); }`)).toBe("true");
    });

    it("every(Boolean) still reports false for a genuinely falsy element", async () => {
      expect(await runModule(`export function run() { return ["x", ""].every(Boolean); }`)).toBe("false");
    });

    it("find(Boolean) returns the matching element", async () => {
      expect(await runModule(`export function run() { return ["", "y"].find(Boolean); }`)).toBe("y");
    });

    it("findIndex(Boolean) returns the matching index", async () => {
      expect(await runModule(`export function run() { return ["", "y"].findIndex(Boolean); }`)).toBe("1");
    });

    it("forEach with an unresolved callback observes the element", async () => {
      expect(
        await runModule(
          `var seen = "";\nvar note = function (s) { seen += s; };\nexport function run() { ["x", "y"].forEach(note); return seen; }`,
        ),
      ).toBe("xy");
    });

    it("map(Boolean) — #4527's arm stays correct", async () => {
      expect(await runModule(`export function run() { return ["x", ""].map(Boolean).join("|"); }`)).toBe("true|false");
    });
  });
});
