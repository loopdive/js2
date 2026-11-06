// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7277 — an implicit-any parameter whose legacy slot is already a kind the IR
// names (`f64`, or the non-null native string) projects that kind instead of
// being refused as `param-dynamic-carrier-diverges-from-legacy`: the ABI is
// the same by construction. propertyHelper's verifyEqualTo (`value` is f64 in
// legacy) is now IR-emitted, and its pass and throw paths keep legacy's
// messages.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { originalHarnessCompileOptions, parseMeta, runTest262File } from "./test262-runner.js";

const FIXTURE = `/*---
includes: [propertyHelper.js]
---*/
function mk(v) { var o = {}; Object.defineProperty(o, "n", { value: v, writable: false, enumerable: false, configurable: true }); return o; }
verifyProperty(mk(1), "n", { value: 1, writable: false, enumerable: false, configurable: true });
verifyProperty(mk(NaN), "n", { value: NaN });
verifyProperty(mk(-0), "n", { value: -0 });
var msgs = [];
try { verifyProperty(mk(1), "n", { value: 2 }); } catch (e) { msgs.push(e.constructor.name + ":" + e.message); }
try { verifyProperty(mk(0), "n", { value: -0 }); } catch (e) { msgs.push(e.constructor.name + ":" + e.message); }
throw new Test262Error("MSGS|" + msgs.join("|"));
`;
const MESSAGES =
  "MSGS|Test262Error:n descriptor value should be 2; n value should be 2|Test262Error:n descriptor value should be 0; n value should be 0";
const PROP_DESC = join(__dirname, "..", "test262", "test", "built-ins", "Boolean", "prop-desc.js");

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

describe("#7277 adopt legacy's refined parameter slot", () => {
  it("IR-emits verifyEqualTo and keeps legacy's messages on its throw path", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "issue-7277-")), "verify-equal-to.js");
    writeFileSync(path, FIXTURE);
    expect((await irOutcomes(path)).find((o) => o.displayName === "verifyEqualTo")?.irBodyEmitted).toBe(true);
    const result = await runTest262File(path, "issue-7277", undefined, "standalone");
    expect(result.error).toContain(MESSAGES);
  });

  it("passes built-ins/Boolean/prop-desc.js with verifyEqualTo on the IR path", async () => {
    expect((await irOutcomes(PROP_DESC)).find((o) => o.displayName === "verifyEqualTo")?.irBodyEmitted).toBe(true);
    expect(await runTest262File(PROP_DESC, "built-ins/Boolean", undefined, "standalone")).toMatchObject({
      status: "pass",
    });
  });
});
