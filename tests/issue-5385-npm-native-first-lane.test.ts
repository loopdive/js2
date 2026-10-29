import { describe, expect, it } from "vitest";
import {
  failedPerfLane,
  npmPerfHistoryPoint,
  npmPerfRows,
  packagePerfRecord,
} from "../scripts/lib/npm-compat-perf.mjs";
import { buildNpmCompatPerfDriver, getNpmCompatPerfSpec } from "./dogfood/npm-compat-perf-specs.mjs";

// (#6979 S7) The JS-host lane IS the native regime; the S6 `jsHostNative`
// alias record and the `jsHostAssisted` control lane are gone.
describe("native-first npm performance evidence", () => {
  it("the JS-host driver takes runtime input and carries no standalone benchmark", () => {
    for (const name of ["react", "hono", "redux"]) {
      const spec = getNpmCompatPerfSpec(name);
      const driver = buildNpmCompatPerfDriver(spec, "./package/index.js", "js-host");
      expect(driver).toContain("export function __npmCompatPerf(input)");
      expect(driver).not.toContain("export function __npmCompatStandaloneBenchmark");
    }
  });

  it("charts and history carry the jsHost and standalone lanes only", () => {
    const measured = (ratio: number) => ({
      status: "measured",
      ratio,
      wasmUs: 1,
      nodeUs: ratio,
      placement: "js-host",
      inputMode: "runtime-dynamic",
    });
    const perf = packagePerfRecord("op", measured(2), failedPerfLane("standalone", "compile-error", "unavailable"), {
      jsHostNative: { ...measured(3), semanticProviders: "native-first" },
    });
    const packages = [{ name: "pkg", entryFile: "index.js", perf }];
    expect(npmPerfRows(packages).map((row) => row.path)).toEqual(["index.js#jsHost"]);
    expect(npmPerfHistoryPoint(packages, "2026-09-07").packages.pkg).toEqual({
      jsHost: { dynamic: 2 },
      standalone: {},
    });
    expect(perf.ratio).toBe(2);
  });

  it("retains JS-host failures without manufacturing timing bars", () => {
    const failure = failedPerfLane("js-host", "compile-error", "string_constants forbidden");
    const perf = packagePerfRecord("op", failure, null);
    expect(perf.lanes.jsHost).toEqual(failure);
    expect(npmPerfRows([{ name: "pkg", perf }])).toEqual([]);
    expect(npmPerfHistoryPoint([{ name: "pkg", perf }], "2026-09-07").packages).toEqual({});
  });
});
