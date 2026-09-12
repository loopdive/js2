// #5356 — a hoisted inner `function` that mutates an enclosing `let`/`const`
// had its ref cell minted at the FIRST CALL SITE, into whatever body buffer was
// active there. A call in an untaken branch left the cell null while
// `localMap[name]` had already been re-aimed at it, so every later read of the
// binding answered `null` / NaN (prettier's `printDocToString`: `output` read
// `null` after the loop, #5346). `emitEagerCaptureBoxes` (#2692) already
// minted the cell at function top for `var`/parameter captures and skipped
// `let`/`const`; this pins the skip's removal AND the races the bare removal
// exposed (a `case`-clause `let`, a shadowing block, block-`let` re-install,
// destructured bindings) — each read a wrong value or trapped on the parent.
//
// Fixtures are untyped two-file `.js` compiled as a PROJECT with the same
// options and instantiation path as the dogfood upstream-suite worker
// (`tests/dogfood/upstream-suite-compile-worker.mjs`): a `: any` annotation
// or the single-file `compile()` lane routes these bindings through different
// arms and does not reproduce the upstream failure.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileProject, instantiateLinkedProject } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";
import { getWebHostConstructors } from "../src/runtime/web-host-constructors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "fixtures", "issue-5356", "entry.js");

type FixtureExports = Record<string, (...args: unknown[]) => unknown>;
let fixturePromise: Promise<FixtureExports> | undefined;

async function loadFixture(): Promise<FixtureExports> {
  const result = await compileProject(ENTRY, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "web",
    experimentalIR: true,
    emitWat: false,
    deferTopLevelInit: true,
  });
  if (!result.success) {
    throw new Error(`compile failed:\n${result.errors.map((error) => error.message).join("\n")}`);
  }
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildCompiledImports(result, getWebHostConstructors()) as unknown as WebAssembly.Imports & {
    setInstance?: (instance: WebAssembly.Instance) => void;
    __setInstance?: (instance: WebAssembly.Instance) => void;
  };
  const { instance } = result.linkedModules?.length
    ? await instantiateLinkedProject(result, imports)
    : await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  (instance.exports as Record<string, unknown>).__module_init &&
    ((instance.exports as Record<string, () => void>).__module_init as () => void)();
  return wrapExports(instance, { signatures: result.exportSignatures }) as FixtureExports;
}

function fixture(): Promise<FixtureExports> {
  return (fixturePromise ??= loadFixture());
}

describe("#5356 — eager ref cell for let/const captured by a hoisted function", () => {
  it("dead-branch call keeps the let intact (the issue's minimal reproduction)", async () => {
    const value = (await fixture()).runDeadBranch();
    // The parent's failure mode, named so a regression is recognisable.
    expect(value).not.toBe("v=null");
    expect(value).toBe('v="a"');
  });

  it("never-called hoisted mutator keeps the let intact", async () => {
    expect((await fixture()).runNeverCalled()).toBe('v="aa"');
  });

  it("number-valued counter with a dead-branch reset", async () => {
    expect((await fixture()).runNumberCounter()).toBe(2);
  });

  it("anti-vacuity: a TAKEN call still resets through the cell and differs from the dead-branch shape", async () => {
    const exports = await fixture();
    expect(exports.runTakenBranch()).toBe('v="b"');
    expect(exports.runTakenBranch()).not.toBe(exports.runDeadBranch());
  });

  it("dead reset inside a loop, counter read after the loop", async () => {
    expect((await fixture()).runCounterInLoop()).toBe(6);
  });

  it("two sibling mutators share ONE cell (dead reset, taken adds)", async () => {
    expect((await fixture()).runTwoSiblings()).toBe(7);
  });

  it("nested async function mutating the let, dead call", async () => {
    expect((await fixture()).runAsyncNested()).toBe(5);
  });

  it("case-clause `let` mutated by a clause-level function (the race the bare skip removal exposed)", async () => {
    expect((await fixture()).runSwitchClause()).toBe("6");
  });

  it("block `let` + block-level mutator inside a loop body re-installs the cell", async () => {
    expect((await fixture()).runLoopBlock()).toBe("0,11,20,");
  });

  it("shadowing block: a dead call must not hijack the inner binding's name", async () => {
    expect((await fixture()).runShadowDead()).toBe("x");
  });

  it("shadowing block: a taken call mutates the OUTER binding through its cell", async () => {
    expect((await fixture()).runShadowTaken()).toBe("outer=cleared");
  });

  it("array-destructured let captured by a dead-branch mutator (stores go through the cell)", async () => {
    expect((await fixture()).runArrDstr()).toBe(10);
  });

  it("object-destructured let captured by a dead-branch mutator", async () => {
    expect((await fixture()).runObjDstr()).toBe(5);
  });

  it("printDocToString skeleton: string doc", async () => {
    expect((await fixture()).runPrintString()).toBe("hi");
  });

  it("printDocToString skeleton: array doc (destructured `doc` shadows the parameter)", async () => {
    expect((await fixture()).runPrintArray()).toBe("ab");
  });

  it("printDocToString skeleton: trim through the cell on a taken `line` arm", async () => {
    expect((await fixture()).runPrintLine()).toBe("\nP\n");
  });
});
