import { describe, expect, it } from "vitest";
import {
  failedPerfLane,
  npmPerfHistoryPoint,
  npmPerfRows,
  packagePerfRecord,
} from "../scripts/lib/npm-compat-perf.mjs";
import { buildNpmCompatPerfDriver, getNpmCompatPerfSpec } from "./dogfood/npm-compat-perf-specs.mjs";

describe("native-first npm performance evidence", () => {
  it("uses the identical runtime-input driver in both JavaScript semantic profiles", () => {
    for (const name of ["react", "hono", "redux"]) {
      const spec = getNpmCompatPerfSpec(name);
      const native = buildNpmCompatPerfDriver(spec, "./package/index.js", "js-host-native");
      expect(native).toBe(buildNpmCompatPerfDriver(spec, "./package/index.js", "js-host"));
      expect(native).toContain("export function __npmCompatPerf(input)");
      expect(native).not.toContain("export function __npmCompatStandaloneBenchmark");
    }
  });

  it("keeps measured profiles distinct in charts and history", () => {
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
    expect(npmPerfRows(packages).map((row) => row.path)).toEqual(["index.js#jsHost", "index.js#jsHostNative"]);
    expect(npmPerfHistoryPoint(packages, "2026-09-07").packages.pkg).toEqual({
      jsHost: { dynamic: 2 },
      jsHostNative: { dynamic: 3 },
      standalone: {},
    });
    expect(perf.ratio).toBe(2);
  });

  it("retains native failures without manufacturing timing bars", () => {
    const failure = {
      ...failedPerfLane("js-host", "compile-error", "string_constants forbidden"),
      semanticProviders: "native-first",
    };
    const perf = packagePerfRecord("op", null, null, { jsHostNative: failure });
    expect(perf.lanes.jsHostNative).toEqual(failure);
    expect(npmPerfRows([{ name: "pkg", perf }])).toEqual([]);
    expect(npmPerfHistoryPoint([{ name: "pkg", perf }], "2026-09-07").packages).toEqual({});
  });
});
