// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5368 — the enumeration behind the widened `check:dogfood-validation` gate.
//
// The gate itself is a wall-clock-expensive compile; what is cheap and worth
// pinning is the SET it compiles. Every assertion here exists because its
// failure mode is silent: an enumeration that quietly collapses back to the
// declared entry restores exactly the blind spot #5339 fell into, and the gate
// would still exit 0.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { dogfoodSurfaceModules } from "./dogfood-surface-modules.mjs";

describe("dogfood surface enumeration (#5368)", () => {
  it("puts hono's #5339 module in the gated suite surface", () => {
    const surface = dogfoodSurfaceModules("hono");
    const paths = surface.modules.map((entry) => entry.path);
    // The measured miss: `dist/helper/dev/index.js` imports `dist/utils/color.js`,
    // whose `getColorEnabledAsync` emitted `type error in return[0] (expected
    // i32, got externref)` on #5676's parent while this gate was green.
    expect(paths).toContain("dist/helper/dev/index.js");
    expect(surface.modules.find((entry) => entry.path === "dist/helper/dev/index.js")?.origin).toBe("suite");
  });

  it("is not vacuous — the suite surface is much wider than the declared entry", () => {
    const surface = dogfoodSurfaceModules("hono");
    const entries = surface.modules.filter((entry) => entry.origin === "entry");
    expect(entries.map((entry) => entry.path)).toEqual(["dist/index.js"]);
    // 20 selected upstream test files, each admitting one published module. An
    // enumeration that regressed to "entry only" would pass every other
    // assertion in this file and gate nothing.
    expect(surface.modules.length).toBe(21);
  });

  it("enumerates only modules that exist in the pinned tarball", () => {
    for (const name of ["hono", "redux", "react", "jest", "moment", "styled-components"]) {
      const surface = dogfoodSurfaceModules(name, { surface: "exports" });
      expect(surface.modules.length).toBeGreaterThan(0);
      for (const entry of surface.modules) {
        expect(existsSync(join(surface.packageRoot, entry.path)), `${name}/${entry.path}`).toBe(true);
      }
    }
  });

  it("orders deterministically and never repeats a module", () => {
    const surface = dogfoodSurfaceModules("hono", { surface: "exports" });
    const paths = surface.modules.map((entry) => entry.path);
    expect(paths).toEqual([...paths].sort());
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("reaches modules the exports map does not publish, and vice versa", () => {
    const suite = dogfoodSurfaceModules("hono").modules;
    const wide = dogfoodSurfaceModules("hono", { surface: "exports" }).modules;
    // Neither surface contains the other. hono's `dist/utils/*.js` is internal
    // — no `exports` subpath resolves to it — yet the suite compiles it, which
    // is why the GATED surface is the suite one. Conversely the exports map
    // publishes ~60 middleware/adapter modules no selected test touches.
    const wideOrigins = new Map(wide.map((entry) => [entry.path, entry.origin]));
    expect(wideOrigins.get("dist/utils/url.js")).toBe("suite");
    expect(wide.filter((entry) => entry.origin === "exports").length).toBeGreaterThan(50);
    expect(wide.length).toBeGreaterThan(suite.length);
  });

  it("falls back to the declared entry for packages whose suite compiles upstream sources", () => {
    // redux/jest/styled-components/moment suites compile the upstream REPO, not
    // published subpaths, so they legitimately contribute no `suite` modules.
    for (const name of ["redux", "moment", "styled-components"]) {
      const origins = new Set(dogfoodSurfaceModules(name).modules.map((entry) => entry.origin));
      expect([...origins]).toEqual(["entry"]);
    }
  });
});
