// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 U — the real test262 prelude (the runner's shim + assert.js + sta.js) through the strict Prepared entry, with
// the runner's options. Before abort bodies the prelude refused at compile time, so no positive test could pass; now
// only the prelude functions the path cannot lower get the abort, and a test that never calls them runs. Each body is
// checked twice: as written it returns (or ends where it must), and with a wrong value it never returns.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runnerOptions, yieldToRpc } from "./helpers/prepared-node-agreement.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { compile, requiredPreparedAbortBodies } from "../src/test262/test262-prepared-entry.js";

afterEach(() => vi.restoreAllMocks());

const ROOT = join(__dirname, "..");
const TEST262 = existsSync(join(ROOT, "test262", "harness", "assert.js"));
const SLOW = 300_000;
const prelude = (): string =>
  [
    join(ROOT, "scripts", "test262-fyi-runtime.js"),
    ...["assert.js", "sta.js"].map((f) => join(ROOT, "test262", "harness", f)),
  ]
    .map((file) => readFileSync(file, "utf8"))
    .join("");

/** "returned", "threw" (a JavaScript throw) or "trap in <top frame>". */
async function run(body: string): Promise<{ outcome: string; table: string[] }> {
  await yieldToRpc();
  const result = await compile(prelude() + body, runnerOptions());
  expect(result.errors.filter((error) => error.severity === "error")).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const table = requiredPreparedAbortBodies(result)!.map((row) => `${row.name}: ${row.detail}`);
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as () => void)();
    return { outcome: "returned", table };
  } catch (error) {
    if ((error as Error).constructor.name !== "RuntimeError") return { outcome: "threw", table };
    const frames = [...(error as Error).stack!.matchAll(/at\s+(\S+)\s+\(wasm:\/\//g)].map((match) => match[1]);
    return { outcome: `trap in ${frames[0]}`, table };
  }
}

describe.skipIf(!TEST262)("#7354 U — the real prelude", () => {
  it(
    "compiles and runs; only the functions it cannot lower get the abort, each with its refusal",
    async () => {
      expect(await run("assert.sameValue(1, 1);\n")).toEqual({
        outcome: "returned",
        table: [
          // (#7354 T) `typeof JSON` refuses by name: JSON is a standard global this path does not provide.
          'formatIdentityFreeValue: ir/from-ast: identifier "JSON" is not in scope in formatIdentityFreeValue',
          "compareArray: dynamic operation dyn.member_get with a computed key has no Prepared intrinsic",
          // (#7352) `compareArray.format` lowers: `Array` is the realm's value.
        ],
      });
    },
    SLOW,
  );

  // (#7354 T) A failed assertion formats its message with formatIdentityFreeValue, whose body is the abort: the run
  // ends there, uncatchably, instead of with Test262Error.
  it(
    "a wrong value ends the run in the message formatter's abort",
    async () => expect((await run("assert.sameValue(1, 2);\n")).outcome).toBe("trap in formatIdentityFreeValue"),
    SLOW,
  );

  it(
    "compareArray's abort is uncatchable: assert.throws does not see it as the expected throw",
    async () =>
      expect((await run("assert.throws(Test262Error, function(){ compareArray(1, 2); });\n")).outcome).toBe(
        "trap in compareArray",
      ),
    SLOW,
  );
});
