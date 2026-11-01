// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// A break/continue in a `finally` replaces the pending completion (§14.15.3).
// The IR inlines a guarded copy of the finally on the exception path; its
// guard `if` is one Wasm label, which the br depth must count. Before that,
// `try { throw } finally { break; }` ran its br one frame short: the loop
// re-entered forever (test262 language/statements/try/S12.14_A9_T3) or the
// wrong frame was left (S12.14_A9_T2, S12.14_A10_T2, S12.14_A10_T3).
// Every loop below carries a guard, so a regression answers wrongly instead
// of hanging the run.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { instantiateWasm } from "../src/runtime-instantiate.js";

/** Plain-JS bodies that leave their answer in `r`; node evaluates the same text. */
const BODIES: Record<string, string> = {
  "throw overridden by break (do-while)": `let c = 0; let f = 0;
    do { c += 1; if (c > 9) break; try { throw "x"; } finally { f = 1; break; } } while (c < 2);
    r = c * 10 + f;`,
  "throw overridden by continue (do-while)": `let c = 0; let f = 0;
    do { c += 1; if (c > 9) break; try { throw "x"; } finally { f += 1; continue; } } while (c < 3);
    r = c * 10 + f;`,
  "throw overridden by break (while)": `let c = 0; let f = 0;
    while (c < 5) { c += 1; if (c > 9) break; try { throw "x"; } finally { f += 7; break; } }
    r = c * 10 + f;`,
  "throw overridden by continue (for)": `let s = 0; let n = 0;
    for (let i = 0; i < 4; i++) { n += 1; if (n > 9) break; try { s += i; throw "x"; } finally { s += 100; continue; } }
    r = s;`,
  "break overridden by continue": `let c = 0; let f = 0;
    do { c += 1; if (c > 9) break; try { break; } finally { f += 1; if (c < 3) { continue; } } } while (c < 5);
    r = c * 10 + f;`,
  "a rethrow from catch overridden by break": `let c = 0; let f = 0;
    do { c += 1; if (c > 9) break; try { throw "x"; } catch (e) { f += 10; throw "y"; } finally { f += 1; break; } } while (c < 3);
    r = c * 100 + f;`,
  "nested finally, inner break": `let c = 0; let f = 0; let g = 0;
    while (c < 3) { c += 1; if (c > 9) break; try { try { throw "x"; } finally { f += 1; break; } } finally { g += 1; } }
    r = c * 100 + f * 10 + g;`,
  "nested finally, outer break": `let c = 0; let f = 0;
    while (c < 3) { c += 1; if (c > 9) break; try { try { throw "x"; } finally { f += 1; } } finally { f += 10; break; } }
    r = c * 100 + f;`,
  "labeled continue to the outer loop": `let s = 0; let n = 0;
    outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { n += 1; if (n > 20) break outer; try { s += 1; throw "x"; } finally { s += 10; continue outer; } } }
    r = s;`,
  "labeled break across two finallys": `let s = 0; let n = 0;
    outer: for (let i = 0; i < 3; i++) { try { for (let j = 0; j < 3; j++) { n += 1; if (n > 20) break outer; try { s += 1; throw "x"; } finally { s += 10; break outer; } } } finally { s += 100; } }
    r = s;`,
  "switch break in a finally": `let s = 0; let k = 0; k += 1;
    switch (k) { case 1: try { s += 1; throw "x"; } finally { s += 10; break; } case 2: s += 1000; }
    r = s;`,
};

/** `return` across or inside a finally is refused at select; legacy must still answer like node. */
const RETURN_BODIES: Record<string, string> = {
  "return overridden by return": `function g() { try { return 1; } finally { return 2; } } r = g();`,
  "throw overridden by return": `function g() { try { throw "x"; } finally { return 2; } } r = g();`,
  "return overridden by break": `function g() { while (true) { try { return 1; } finally { break; } } return 3; } r = g();`,
};

const nodeAnswer = (body: string): number => new Function(`let r = 0;\n${body}\nreturn r;`)() as number;

type Lane = "standalone" | "gc";

async function run(source: string, lane: Lane): Promise<{ value: number; irUnits: readonly string[] }> {
  const result = await compile(source, {
    fileName: "ir-finally-abrupt-exit.ts",
    deferTopLevelInit: true,
    trackIrOutcomes: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const irUnits = (result.irOutcomes ?? [])
    .filter((outcome) => outcome.kind === "emitted" && outcome.irBodyEmitted)
    .map((outcome) => outcome.displayName);
  let exports: Record<string, () => number>;
  if (lane === "standalone") {
    exports = (await WebAssembly.instantiate(result.binary, {})).instance.exports as never;
  } else {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(
      result.binary,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    imports.setInstance?.(instance);
    exports = instance.exports as never;
  }
  exports.__module_init?.();
  return { value: exports.probe!(), irUnits };
}

const inFunction = (body: string) =>
  `function work(): number { let r = 0;\n${body}\nreturn r; }\nexport function probe(): number { return work(); }`;
const atTopLevel = (body: string) => `let r: number = 0;\n${body}\nexport function probe(): number { return r; }`;

describe.each(["standalone", "gc"] as const)("IR finally abrupt exit (%s)", (lane) => {
  it.each(Object.entries(BODIES))("%s, in a function and at top level", async (_, body) => {
    const expected = nodeAnswer(body);
    const fn = await run(inFunction(body), lane);
    expect(fn.irUnits).toContain("work");
    expect(fn.value).toBe(expected);
    const top = await run(atTopLevel(body), lane);
    expect(top.irUnits).toContain("<module-init>");
    expect(top.value).toBe(expected);
  });

  it.each(Object.entries(RETURN_BODIES))("%s", async (_, body) => {
    const { value, irUnits } = await run(atTopLevel(body.replace("function g()", "function g(): number")), lane);
    expect(irUnits).not.toContain("g");
    expect(value).toBe(nodeAnswer(body));
  });
});
