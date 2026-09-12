// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5365 slice 1 — `Function.prototype.length` of a compiled closure that
// crossed a CALL BOUNDARY as a value, in `gc`/JS-host mode.
//
// A closure read at its declaration site answers `.length` from a static fold,
// so `f.length` was always right. Passed as an argument and reflected on inside
// the callee (`function viaParam(x) { return x.length; }`) the receiver is an
// opaque WasmGC carrier, and the read lowers to `__extern_get(carrier,
// "length")`, which had no answer for a closure at all.
//
// What came back depended on the rest of the module, which is why the defect
// reads differently in a reduction than in a package. With any vec struct in
// the module — i.e. any real package — a `__sget_length` getter exists, minted
// for the vec shape whose struct really does have a `length` field. The closure
// struct has no field-name registry, so the boundary helper's "does it own a
// `length` field?" verdict is UNKNOWN and it probed that getter anyway, reading
// back its miss-default **0** (the #1629 anti-pattern, on the closure carrier).
// In a module with no vec there is no getter to probe and the read fell through
// to **undefined** — which is what the fixtures below measure on the parent.
// Both answers are wrong; only the first one is silent.
//
// hono classifies every route with `handler.length > 1`, and handlers reach
// `inspectRoutes` through `#addRoute(method, path, handler)` — across exactly
// this boundary — so every route was labelled `[handler]`.
//
// The fixtures are deliberately UNTYPED `.js` in a two-file project. Annotating
// the parameter routes the read through a typed member-access arm that never
// had the defect, and the test then passes identically with and without the fix.
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
  const root = mkdtempSync(join(tmpdir(), "js2-5365-"));
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

/** `function viaParam(x) { return x.length; }` — the boundary this issue is about. */
const VIA_PARAM = `function viaParam(x) { return x.length; }\n`;

describe("#5365 — a compiled closure keeps its arity across a call boundary", () => {
  it("an arrow with two formals reports 2, not 0", async () => {
    expect(
      await runModule(`${VIA_PARAM}const f = (a, b) => a + b;\nexport function run() { return viaParam(f); }`),
    ).toBe("2");
  });

  it("a function DECLARATION with three formals reports 3", async () => {
    expect(
      await runModule(
        `${VIA_PARAM}function g(a, b, c) { return a + b + c; }\nexport function run() { return viaParam(g); }`,
      ),
    ).toBe("3");
  });

  it("a zero-formal closure reports 0 — the spec value, where the parent had none", async () => {
    expect(await runModule(`${VIA_PARAM}const z = () => 1;\nexport function run() { return viaParam(z); }`)).toBe("0");
  });

  it("a rest parameter is excluded — §15.1.5", async () => {
    expect(
      await runModule(`${VIA_PARAM}const r = (a, ...rest) => a;\nexport function run() { return viaParam(r); }`),
    ).toBe("1");
  });

  it("a function expression stored on an object reports the declaration's arity", async () => {
    expect(
      await runModule(
        `${VIA_PARAM}var o = { h: function (a, b) { return a + b; } };\nexport function run() { return viaParam(o.h); }`,
      ),
    ).toBe("2");
  });

  it("an array element reports the declaration's arity", async () => {
    expect(
      await runModule(
        `${VIA_PARAM}var arr = [function (a, b, c) { return a; }];\nexport function run() { return viaParam(arr[0]); }`,
      ),
    ).toBe("3");
  });

  it("hono's route classifier — `handler.length > 1` in a numeric context", async () => {
    expect(
      await runModule(
        `${""}const isMiddleware = (handler) => handler.length > 1;\n` +
          `const mw = function (c, next) { return next; };\n` +
          `const leaf = function (c) { return c; };\n` +
          `function classify(h) { return isMiddleware(h) ? "middleware" : "handler"; }\n` +
          `export function run() { return classify(mw) + "|" + classify(leaf); }`,
      ),
    ).toBe("middleware|handler");
  });

  describe("anti-vacuity controls — these pass on the parent too", () => {
    it("the DIRECT read was never wrong", async () => {
      expect(await runModule(`const f = (a, b) => a + b;\nexport function run() { return f.length; }`)).toBe("2");
    });

    it("an array's live length still crosses the boundary", async () => {
      expect(await runModule(`${VIA_PARAM}export function run() { return viaParam([1, 2, 3]); }`)).toBe("3");
    });

    it("a string's length still crosses the boundary", async () => {
      expect(await runModule(`${VIA_PARAM}export function run() { return viaParam("abcd"); }`)).toBe("4");
    });

    it("an object that genuinely OWNS a `length` field keeps the field read", async () => {
      expect(await runModule(`${VIA_PARAM}var o = { length: 7 };\nexport function run() { return viaParam(o); }`)).toBe(
        "7",
      );
    });

    it("an explicit own `length` on a closure still outranks the declaration's arity", async () => {
      expect(
        await runModule(
          `${VIA_PARAM}const f = (a, b) => a + b;\n` +
            `Object.defineProperty(f, "length", { value: 9, configurable: true });\n` +
            `export function run() { return viaParam(f); }`,
        ),
      ).toBe("9");
    });
  });
});
