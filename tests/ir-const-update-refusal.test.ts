// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// A write to a `const` binding (`++`/`--`, `=`, `op=`) is a TypeScript error
// that still emits code, and at run time it throws TypeError. Only the legacy
// lowering raises it, so the selector refuses a subject that writes a const
// (`constBindingWriteRefused`). Before, a module `const` update was claimed and
// lowered as a plain global write, and every function-local const write was
// claimed and then demoted by from-ast.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { firstConstBindingWrite } from "../src/ir/const-binding-writes.js";
import { ts } from "../src/ts-api.js";
import { buildImports } from "../src/runtime.js";
import { instantiateWasm } from "../src/runtime-instantiate.js";

type Lane = "standalone" | "gc";

const UPDATES = ["locked++", "++locked", "locked--", "--locked"] as const;
/** Assignment writes in every position the selector admits for a local: statement, chain, value, loop update. */
const ASSIGNMENTS = [
  "locked = 5",
  "locked += 2",
  "locked *= 2",
  "x = locked = 5",
  "x = (locked = 5)",
  "for (let i = 0; i < 2; locked += 1) { i++; }",
] as const;

interface Outcome {
  readonly init: "ok" | "threw";
  readonly value?: number;
  readonly irUnits: readonly string[];
  readonly postClaimErrors: number;
}

async function run(source: string, lane: Lane): Promise<Outcome> {
  const result = await compile(source, {
    fileName: "ir-const-update-refusal.ts",
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
  const postClaimErrors = (result.irPostClaimErrors ?? []).length;
  try {
    exports.__module_init?.();
  } catch {
    return { init: "threw", irUnits, postClaimErrors };
  }
  return { init: "ok", value: exports.probe!(), irUnits, postClaimErrors };
}

/** A top-level update: the TypeError leaves `__module_init`, so `after` is never written. */
const topLevel = (kind: string, update: string) => `${kind} locked: number = 1;
let after: number = 0;
${update};
after = 1;
export function probe(): number { return after * 10 + locked; }`;

/** A function-local write, caught: 100 for a TypeError, plus the final values. Untyped, it is the JS node runs. */
const localBody = (kind: string, write: string, type = "") => `${kind} locked${type} = 3;
  let caught = 0;
  let x = 0;
  try { ${write} } catch (e) { caught = e instanceof TypeError ? 100 : 200; }
  return caught + locked * 10 + x;`;
const inFunction = (kind: string, write: string) =>
  `function work(): number {\n  ${localBody(kind, write, ": number")}\n}\nexport function probe(): number { return work(); }`;
const nodeAnswer = (kind: string, write: string): number => new Function(localBody(kind, write))() as number;

describe.each(["standalone", "gc"] as const)("IR refuses writes to a const (%s)", (lane) => {
  it.each(UPDATES)("a module const: `%s` throws out of the initializer, unclaimed", async (update) => {
    const outcome = await run(topLevel("const", update), lane);
    expect(outcome.init).toBe("threw");
    expect(outcome.irUnits).not.toContain("<module-init>");
  });

  it.each(UPDATES)("a module let: `%s` still updates in the IR", async (update) => {
    const outcome = await run(topLevel("let", update), lane);
    expect(outcome.irUnits).toContain("<module-init>");
    expect(outcome).toMatchObject({ init: "ok", value: 10 + (update.includes("++") ? 2 : 0) });
  });

  it.each([...UPDATES, ...ASSIGNMENTS])(
    "a function-local const: `%s` throws TypeError, refused at select",
    async (write) => {
      const outcome = await run(inFunction("const", write), lane);
      expect(outcome).toMatchObject({ init: "ok", value: nodeAnswer("const", write), postClaimErrors: 0 });
      expect(outcome.irUnits).not.toContain("work");
    },
  );

  it.each([...UPDATES, ...ASSIGNMENTS])("a function-local let: `%s` still writes in the IR", async (write) => {
    const outcome = await run(inFunction("let", write), lane);
    expect(outcome.irUnits).toContain("work");
    expect(outcome).toMatchObject({ init: "ok", value: nodeAnswer("let", write), postClaimErrors: 0 });
  });

  it("a function-local var still updates in the IR", async () => {
    const outcome = await run(inFunction("var", "locked++"), lane);
    expect(outcome.irUnits).toContain("work");
    expect(outcome).toMatchObject({ init: "ok", value: nodeAnswer("var", "locked++") });
  });

  it("a const for-loop incrementor throws on its first step", async () => {
    const source = `function work(): number {
  let caught = 0;
  let steps = 0;
  try { for (const i = 0; i < 3; i++) { steps += 1; } } catch (e) { caught = e instanceof TypeError ? 100 : 200; }
  return caught + steps;
}
export function probe(): number { return work(); }`;
    const outcome = await run(source, lane);
    expect(outcome).toMatchObject({ init: "ok", value: 101, postClaimErrors: 0 });
    expect(outcome.irUnits).not.toContain("work");
  });

  it("a const captured by a nested function throws there", async () => {
    const source = `function work(): number {
  const locked: number = 3;
  let caught = 0;
  function bump(): void { locked++; }
  try { bump(); } catch (e) { caught = e instanceof TypeError ? 100 : 200; }
  return caught + locked;
}
export function probe(): number { return work(); }`;
    const outcome = await run(source, lane);
    expect(outcome).toMatchObject({ init: "ok", value: 103, postClaimErrors: 0 });
  });

  // Review round 1: a const bound by a destructuring pattern is a const too.
  it.each([
    ["a for-of head pattern leaf", "for (const [a, b] of rows) { s = a + b; a = 5; }", 103],
    ["a declaration pattern leaf", "const [a] = rows[0]!; s = a; a = 5;", 101],
    ["a declaration pattern leaf, ++", "const { length: a } = rows; s = a; a++;", 101],
  ])("%s: the write throws TypeError, refused at select", async (_, write, expected) => {
    const source = `function work(rows: number[][]): number {
  let caught: number = 0;
  let s: number = 0;
  try { ${write} } catch (e) { caught = e instanceof TypeError ? 100 : 200; }
  return caught + s;
}
export function probe(): number { return work([[1, 2]]); }`;
    const outcome = await run(source, lane);
    expect(outcome).toMatchObject({ init: "ok", value: expected, postClaimErrors: 0 });
    expect(outcome.irUnits).not.toContain("work");
  });

  // Review round 1: a catch parameter shadowing a module const is its own binding; the subject stays claimed.
  it("a catch parameter shadowing a module const is not a const write", async () => {
    const source = `const x: number = 1;
let r: number = 0;
function work(): number { try { throw "q"; } catch (x) { x = "z"; r = 5; } return r; }
export function probe(): number { return work() * 10 + x; }`;
    const outcome = await run(source, lane);
    expect(outcome.irUnits).toContain("work");
    expect(outcome).toMatchObject({ init: "ok", value: 51 });
  });
});

/** The write the selector refuses a subject for, by name, or "-" when none. */
const constWriteIn = (source: string): string =>
  firstConstBindingWrite(ts.createSourceFile("t.ts", source, ts.ScriptTarget.ES2022, true))?.text ?? "-";

describe("firstConstBindingWrite resolves the nearest binding", () => {
  it.each([
    ["a for-of head pattern leaf", "function w(rows) { for (const [a] of rows) { a = 5; } }", "a"],
    ["a nested object pattern leaf", "function w(rows) { for (const { a: [b] } of rows) { b++; } }", "b"],
    ["a declaration rest leaf", "function w(o) { const { ...r } = o; r = 5; }", "r"],
    ["a for-in head", 'function w(o) { for (const k in o) { k = "z"; } }', "k"],
    ["a const written from a nested function", "function w() { const k = 1; function g() { k += 1; } }", "k"],
    ["a catch parameter", "const x = 1;\nfunction w() { try { throw 1; } catch (x) { x = 2; } }", "-"],
    ["a catch pattern", "const x = 1;\nfunction w() { try { throw {}; } catch ({ x }) { x = 2; } }", "-"],
    ["a hoisted nested var", "const x = 1;\nfunction w(n) { if (n) { var x = 4; } x = 7; }", "-"],
    ["a block class", "const x = 1;\nfunction w() { { class x {} x = 2; } }", "-"],
    ["a destructured parameter", "const x = 1;\nfunction w({ x }) { x = 2; }", "-"],
    ["a named function expression", "const x = 1;\nconst g = function x() { x = 2; };", "-"],
  ])("%s", (_, source, expected) => {
    expect(constWriteIn(source)).toBe(expected);
  });
});
