// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7376 — the single-unit harness assembly keeps a runtime-shim binding
// (`print`, `$262`) only when the unit names it as a token. The test is
// textual, so a name inside a string or an eval text still keeps it. The split
// assemblies keep the whole shim, and line numbers do not move.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleLinkedHarness, assembleOriginalHarness, harnessSourceParts } from "./test262-original-harness.js";

const SHIM = readFileSync(join(import.meta.dirname, "..", "scripts", "test262-fyi-runtime.js"), "utf8");
const PRINT = /^var print = /m;
const REALM = /^var \$262 = /m;

const assemble = (body: string, flags: string[] = ["noStrict"]) =>
  assembleOriginalHarness(body, { flags, includes: [] }).primary;

describe("#7376 runtime shim on demand", () => {
  it("emits no shim binding for a unit that names neither", () => {
    const unit = assemble("var x = 1;");
    expect(unit.source).not.toMatch(PRINT);
    expect(unit.source).not.toMatch(REALM);
  });

  it("keeps $262 when the body names it only inside a string or an eval text", () => {
    for (const body of ['var s = "$262";', "eval('$262.gc()');"]) {
      const unit = assemble(body);
      expect(unit.source).toMatch(REALM);
      expect(unit.source).not.toMatch(PRINT);
    }
  });

  it("keeps print for an async test, whose doneprintHandle.js names it", () => {
    expect(assemble("asyncTest(function () {});", ["async"]).source).toMatch(PRINT);
  });

  it("does not count a longer identifier that contains the name", () => {
    expect(assemble("var printer = 1, $2620 = 2;").source).not.toMatch(/^var (print|\$262) = /m);
  });

  it("leaves line numbers and bodyLineOffset unchanged", () => {
    const full = assemble("$262; print;");
    const elided = assemble("var x;");
    expect(elided.bodyLineOffset).toBe(full.bodyLineOffset);
    expect(elided.source.split("\n").length).toBe(full.source.split("\n").length);
  });

  it("keeps the #4626 rename of a shim $262 a body redeclares", () => {
    expect(assemble("var $262 = {};").source).toMatch(/^var \$26_ = /m);
  });

  it("keeps the whole shim in the split assemblies and without a body", () => {
    const linked = assembleLinkedHarness("var x = 1;", { flags: ["noStrict"], includes: [] });
    expect(linked.harnessParts.find((part) => part.name === "__js2wasm_test262_runtime__.js")?.source).toBe(SHIM);
    expect(harnessSourceParts({}, false).some((part) => part.source === SHIM)).toBe(true);
  });
});
