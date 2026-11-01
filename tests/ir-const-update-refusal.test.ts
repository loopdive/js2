// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// `++` / `--` on a `const` binding is a TypeScript error that still emits
// code, and at run time it throws TypeError. Only the legacy lowering raises
// it, so the selector refuses the update (`identifierUpdateRefusal`, the one
// gate of the three update arms) the way it already refuses a module-const
// assignment. Before, a module `const` update was claimed and lowered as a
// plain global write; a function-local one was claimed and then demoted.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { instantiateWasm } from "../src/runtime-instantiate.js";

type Lane = "standalone" | "gc";

const UPDATES = ["locked++", "++locked", "locked--", "--locked"] as const;

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

/** A function-local update, caught: 100 for a TypeError, plus the binding's final value. */
const inFunction = (kind: string, update: string) => `function work(): number {
  ${kind} locked: number = 3;
  let caught = 0;
  try { ${update}; } catch (e) { caught = e instanceof TypeError ? 100 : 200; }
  return caught + locked;
}
export function probe(): number { return work(); }`;

describe.each(["standalone", "gc"] as const)("IR refuses ++/-- on a const (%s)", (lane) => {
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

  it.each(UPDATES)("a function-local const: `%s` throws TypeError, refused at select", async (update) => {
    const outcome = await run(inFunction("const", update), lane);
    expect(outcome).toMatchObject({ init: "ok", value: 103, postClaimErrors: 0 });
    expect(outcome.irUnits).not.toContain("work");
  });

  it.each(["let", "var"])("a function-local %s still updates in the IR", async (kind) => {
    const outcome = await run(inFunction(kind, "locked++"), lane);
    expect(outcome.irUnits).toContain("work");
    expect(outcome).toMatchObject({ init: "ok", value: 4 });
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
});
