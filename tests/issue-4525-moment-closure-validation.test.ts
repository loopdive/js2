// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileProject } from "../src/index.js";
import { setupNpmCompatCatalogPackage } from "./dogfood/npm-compat-catalog.mjs";

describe("#4525 Moment closure capture validation", () => {
  it("keeps the pinned Moment entry module valid after recursive capture materialization", async () => {
    const packageSetup = setupNpmCompatCatalogPackage("moment");
    const result = await compileProject(packageSetup.entryModulePath, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "web",
      experimentalIR: true,
      emitWat: false,
      deferTopLevelInit: true,
    });

    expect(result.success, result.errors?.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  }, 120_000);
});
