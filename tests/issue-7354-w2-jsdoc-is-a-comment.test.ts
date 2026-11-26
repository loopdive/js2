// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice W2 — on the Prepared path a JSDoc tag is a comment, not a type annotation: JavaScript callers may pass
// anything. A `@param {number}` parameter holds the dynamic value, a `@returns {number}` result is the dynamic value
// its body returns, and a value passed into either is no flow into `number`. A syntactic TypeScript annotation still
// types its parameter, and a dynamic value flowing into it is still refused by name.
import { describe, expect, it } from "vitest";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { compile, requiredPreparedAbortBodies } from "../src/test262/test262-prepared-entry.js";
import { agreesWithNode, preparedOptions, yieldToRpc } from "./helpers/prepared-node-agreement.js";

/** Compile TypeScript `source` through the strict Prepared entry; its abort-body rows and whether it returned. */
async function runTs(source: string): Promise<{ aborts: string[]; outcome: "returned" | "threw" }> {
  await yieldToRpc();
  const result = await compile(source, { ...preparedOptions(), fileName: "test.ts", allowJs: false });
  expect(result.errors.map((error) => error.message)).toEqual([]);
  const aborts = requiredPreparedAbortBodies(result)!.map((row) => `${row.name}: ${row.detail}`);
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    return { aborts, outcome: "returned" };
  } catch {
    return { aborts, outcome: "threw" };
  }
}

describe("#7354 W2 — JSDoc is a comment on the Prepared path", () => {
  it("passes a string, undefined and an object to a `@param {number}` parameter as node does", async () => {
    await agreesWithNode(
      "/** @param {number} x */\nfunction f(x) { return typeof x + ':' + (x + 1) + ';'; }\n" +
        "function call(v) { return f(v); }\nvar out = call(1) + call('a') + call(undefined) + call({});",
    );
  });

  it("returns the body's value from a `@returns {number}` function", async () => {
    await agreesWithNode(
      "/** @returns {number} */\nfunction g(x) { return x; }\n" +
        "function call(v) { var r = g(v); return typeof r + ';' + r + ';'; }\n" +
        "var out = call('s') + call(undefined) + call(2);",
    );
  });

  it("keeps a `@type {number}` local holding its initializer's value", async () => {
    await agreesWithNode(
      "function h(a) { /** @type {number} */ var v = a; return typeof v + v; }\nvar out = h('q') + h(3) + h(undefined);",
    );
  });

  it("stores a string into a `@type {number}` script var as node does", async () => {
    await agreesWithNode(
      '/** @type {number} */ var t = 1;\nfunction set(v) { t = v; }\nset("s");\nvar out = typeof t + t;',
    );
  });

  // Found, not fixed: a typed home is still chosen from the tag when every store is typed (the checker only accepts
  // the string initializer with semantic diagnostics off, as the test262 runner compiles).
  it("refuses by name a `@type {number}` script var initialized with a string", async () => {
    const result = await compile('/** @type {number} */ var t = "s";\nvar out = typeof t;', {
      ...preparedOptions(),
      skipSemanticDiagnostics: true,
    });
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "module binding 't' initializer is string but its global is f64",
    );
  });

  it("still types a syntactically annotated parameter", async () => {
    const source = "function k(x: number): number { return x + 1; }\nvar out = k(2) === 3 ? 'ok' : 'no';\n";
    expect(await runTs(`${source}if (out !== "ok") throw 1;`)).toEqual({ aborts: [], outcome: "returned" });
    expect(await runTs(`${source}if (out !== "no") throw 1;`)).toEqual({ aborts: [], outcome: "threw" });
  });

  it("still refuses a dynamic value flowing into a syntactically annotated parameter", async () => {
    const { aborts } = await runTs(
      "function k(x: number): number { return x + 1; }\n" +
        "function call(v: any) { return k(v) === 3 ? 'ok' : 'no'; }\nvar out = call(2);",
    );
    expect(aborts).toEqual(["call: a dynamic value flows into number without a conversion (CallExpression)"]);
  });
});
