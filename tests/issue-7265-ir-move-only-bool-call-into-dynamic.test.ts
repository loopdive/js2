// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7265 — the move-only scan admits two shapes from propertyHelper's
// isWritable: a local call's boolean result assigned to a dynamic `var`
// (`writeSucceeded = isSameValue(...)`, boxed onto the carrier like a
// comparison) and a dynamic element read with a computed dynamic key
// (`obj[verifyProp || name]`). The fixture is isWritable with #7250 step 1
// (the module-alias locals) replaced by plain locals, run through the test262
// runner in sloppy and strict mode and compiled the same way to read the IR
// outcomes.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { originalHarnessCompileOptions, parseMeta, runTest262File } from "./test262-runner.js";

const BODY = `function isSameValue(a, b) { if (a === 0 && b === 0) return 1 / a === 1 / b; if (a !== a && b !== b) return true; return a === b; }
function isWritable(obj, name, verifyProp, value) {
  var unlikelyValue = "unlikelyValue";
  var newValue = value || unlikelyValue;
  var oldValue = obj[name];
  var writeSucceeded;
  if (arguments.length < 4 && newValue === oldValue) {
    newValue = newValue + "2";
  }
  try {
    obj[name] = newValue;
  } catch (e) {
    if (!(e instanceof TypeError)) {
      throw e;
    }
  }
  writeSucceeded = isSameValue(obj[verifyProp || name], newValue);
  if (writeSucceeded) {
    obj[name] = oldValue;
  }
  return writeSucceeded;
}
var o = { w: 1 };
Object.defineProperty(o, "nw", { value: 2, writable: false });
Object.defineProperty(o, "acc", { get: function () { return 3; }, set: function (v) {} });
var sym = Symbol("s");
o[sym] = 4;
assert.sameValue(isWritable(o, "w"), true, "w");
assert.sameValue(o.w, 1, "w restored");
assert.sameValue(isWritable(o, "nw"), false, "nw");
assert.sameValue(isWritable(o, "acc"), false, "acc");
assert.sameValue(isWritable(o, sym), true, "sym");
assert.sameValue(isWritable(o, "w", undefined, 9), true, "w with value");
assert.sameValue(isWritable([1, 2], "length", undefined, 5), true, "array length");
assert.sameValue(isWritable(Object.freeze({ f: 1 }), "f"), false, "frozen");
`;

const dir = mkdtempSync(join(tmpdir(), "issue-7265-"));

function fixture(flag: string): string {
  const path = join(dir, `${flag}.js`);
  writeFileSync(path, `/*---\nflags: [${flag}]\n---*/\n${BODY}`);
  return path;
}

async function irOutcomes(path: string) {
  const source = readFileSync(path, "utf8");
  const meta = parseMeta(source);
  const variant = assembleOriginalHarness(source, meta).primary;
  const result = await compile(variant.source, {
    ...originalHarnessCompileOptions(meta, "standalone"),
    fileName: path,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result.irOutcomes ?? [];
}

describe("#7265 boolean call result into a dynamic var, dynamic computed key", () => {
  // Strict function code keeps #7260's store on legacy (#7270), so the strict
  // fixture stays legacy and still passes.
  for (const [flag, claimed] of [
    ["noStrict", true],
    ["onlyStrict", false],
  ] as const) {
    it(`${claimed ? "IR-emits" : "keeps legacy"} isWritable and passes the ${flag} fixture`, async () => {
      const path = fixture(flag);
      const outcome = (await irOutcomes(path)).find((o) => o.displayName === "isWritable");
      expect(outcome?.irBodyEmitted).toBe(claimed);
      expect(await runTest262File(path, "issue-7265", undefined, "standalone")).toMatchObject({ status: "pass" });
    });
  }
});
