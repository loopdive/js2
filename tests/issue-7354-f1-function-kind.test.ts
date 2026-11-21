// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 F1 — the function kind of the Prepared dynamic value: `typeof`, the kind tests, `Object.prototype.toString`,
// and the run-time abort of a ToPrimitive that would call a function (slice F2 calls it). Each accepted program runs
// twice: with node's answer (returns) and with a wrong one (throws).
import { describe, expect, it } from "vitest";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { compile } from "../src/test262/test262-prepared-entry.js";
import { preparedOptions, refusal, runPrepared, yieldToRpc } from "./helpers/prepared-node-agreement.js";

const SLOW = 240_000;

/** `source` and `wrong` (the same program asserting a wrong answer): node returns on the first and throws on both. */
async function agrees(source: string, wrong: string): Promise<void> {
  expect(() => new Function(source)()).not.toThrow();
  expect(() => new Function(wrong)()).toThrow();
  expect(await runPrepared(source)).toBe("returned");
  expect(await runPrepared(wrong)).toBe("threw");
}

/** `source` compiles and validates, and ends at the run-time abort (`js.value.unsupported`) where node returns. */
async function abortsAtRunTime(source: string): Promise<void> {
  expect(() => new Function(source)()).not.toThrow();
  await yieldToRpc();
  const result = await compile(source, preparedOptions());
  expect(result.errors.filter((error) => error.severity !== "warning")).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  // The realm's RuntimeError class is not this vitest context's, so the trap is matched by its class name.
  let trap: unknown;
  try {
    const exports = instantiatePreparedArtifact(result).instance.exports;
    (exports.__module_init as (() => void) | undefined)?.();
  } catch (error) {
    trap = error;
  }
  expect((trap as Error | undefined)?.constructor.name).toBe("RuntimeError");
  expect((trap as Error).message).toBe("unreachable");
}

describe("#7354 F1 — the function kind", () => {
  const KINDS =
    "function t(v) { return typeof v; }\n" +
    'function isObject(v) { return typeof v === "object"; }\n' +
    "function isPrimitive(v) { return typeof v !== 'object' && typeof v !== 'function'; }\n" +
    "var g = function () {};\n";
  it(
    "answers typeof and the harness's isPrimitive for a function value",
    () =>
      agrees(
        `${KINDS}if (typeof g !== "function" || t(g) !== "function" || isObject(g) || isPrimitive(g) || !isPrimitive(1)) throw 1;`,
        `${KINDS}if (t(g) !== "object") throw 1;`,
      ),
    SLOW,
  );

  const TAGS =
    "function tag(v) { return Object.prototype.toString.call(v); }\n" +
    "function nm(v) { return v === null ? 'null' : typeof v; }\n" +
    "var g = function () {}; var o = {};\n";
  it(
    "tags a function value [object Function] beside an object",
    () =>
      agrees(
        `${TAGS}if (tag(g) !== "[object Function]" || tag(o) !== "[object Object]" || nm(g) !== "function" || nm(o) !== "object" || nm(null) !== "null") throw 1;`,
        `${TAGS}if (tag(g) !== "[object Object]") throw 1;`,
      ),
    SLOW,
  );

  // D6: Function.prototype.toString (the source text) and a call of a conversion method are not built yet.
  it.each([
    ["ToString of a function value", 'var g = function () {}; var s = "" + g; if (s === "") throw 1;'],
    [
      "ToPrimitive with an own callable toString",
      'var o = { toString: function () { return "x"; } }; var s = "" + o; if (s !== "x") throw 1;',
    ],
  ])("ends %s at the run-time abort", (_label, source) => abortsAtRunTime(source), SLOW);

  it.each([
    [
      "a member read of a function value",
      "var g = function () {}; var k = g.k; if (k) throw 1;",
      "member read 'k' of a value that may be a function needs the realm's function objects",
    ],
    [
      "a member write of a function value",
      "var g = function () {}; g.k = 1;",
      "member write 'k' of a value that may be a function needs the realm's function objects",
    ],
    // A chunked module-init lowers later statements in another function: the static closure value stays in its own.
    [
      "a static closure call across module-init chunks",
      Array.from({ length: 20 }, (_, i) => `var c${i} = function (x) { return x; };`).join(" ") +
        ` if (${Array.from({ length: 20 }, (_, i) => `c${i}(1) !== 1`).join(" || ")}) throw 1;`,
      'direct call to "c0" has no exact AST-site plan',
    ],
  ])("refuses %s by name", async (_label, source, message) => {
    expect(await refusal(source)).toContain(message);
  });
});
