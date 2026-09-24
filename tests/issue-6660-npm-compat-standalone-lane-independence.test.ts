// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6660 — npm-compat's standalone perf lanes must report their OWN compile
// status, never the JS-host package-entry failure. Before the fix,
// `perfNpmCompatPackage` copied the host block into the compile-time-static
// `standalone` lane (`blocked?.standalone ?? runStatic()`), so axios showed the
// host-only #3587 async refusal in standalone although `--target standalone`
// never raises it (its real blocker is `__get_builtin`, #1472).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  failedPerfLane,
  resolveStandalonePerfLanes,
  skippedPerfLane,
  STANDALONE_PERF_LANES,
} from "../scripts/lib/npm-compat-perf.mjs";

const HOST_DIAGNOSTIC = "JS-host package-entry compile failed: async shape not supported … (#3587)";
const OWN = {
  "standalone-static": "'__get_builtin' (dynamic-shape) is not yet supported in --target standalone (#1472 Phase B)",
  "standalone-dynamic": "String.prototype.replace(...) with a RegExp value … not supported (#1474)",
};

function hostBlockedLanes() {
  // What `packagePerfFailure(spec, hostDiagnostic).lanes` produced for the host gate.
  return {
    jsHost: failedPerfLane("js-host", "compile-error", HOST_DIAGNOSTIC),
    standalone: failedPerfLane("standalone", "compile-error", HOST_DIAGNOSTIC),
    standaloneDynamic: failedPerfLane("standalone", "compile-error", HOST_DIAGNOSTIC, {
      inputMode: "runtime-dynamic",
    }),
  };
}

function ownLane(lane: string) {
  const { inputMode } = STANDALONE_PERF_LANES.find((entry) => entry.lane === lane)!;
  return failedPerfLane("standalone", "compile-error", OWN[lane as keyof typeof OWN], { inputMode });
}

const ALL_SELECTED = { "standalone-static": true, "standalone-dynamic": true };

describe("#6660 standalone perf lanes are independent of the JS-host gate", () => {
  it("control: the pre-fix assembly copied the host diagnostic into the static standalone lane", async () => {
    const blocked = hostBlockedLanes();
    let staticCompiles = 0;
    const runStatic = () => {
      staticCompiles++;
      return ownLane("standalone-static");
    };
    // Pre-#6660 line, verbatim in shape: `blocked?.standalone ?? runStatic()`.
    const standalone = blocked?.standalone ?? runStatic();
    expect(standalone.diagnostic).toBe(HOST_DIAGNOSTIC);
    expect(staticCompiles).toBe(0);
  });

  it("a host-blocked package measures BOTH standalone lanes through their own (bounded) compile", async () => {
    const childRuns: string[] = [];
    const lanes = await resolveStandalonePerfLanes({
      hostBlocked: true,
      selected: ALL_SELECTED,
      inProcess: () => {
        throw new Error("a host-blocked package must use the bounded child, not the unbounded in-process lane");
      },
      inChild: (lane: string) => {
        childRuns.push(lane);
        return ownLane(lane);
      },
    });
    expect(childRuns).toEqual(["standalone-static", "standalone-dynamic"]);
    expect(lanes.standalone.diagnostic).toBe(OWN["standalone-static"]);
    expect(lanes.standalone.inputMode).toBe("compile-time-static");
    expect(lanes.standaloneDynamic.diagnostic).toBe(OWN["standalone-dynamic"]);
    expect(lanes.standaloneDynamic.inputMode).toBe("runtime-dynamic");
    for (const lane of Object.values(lanes)) expect(lane.diagnostic).not.toBe(HOST_DIAGNOSTIC);
  });

  it("an unblocked package measures in process; unselected lanes are skipped, not compiled", async () => {
    const inProcessRuns: string[] = [];
    const lanes = await resolveStandalonePerfLanes({
      hostBlocked: false,
      selected: { "standalone-static": false, "standalone-dynamic": true },
      inProcess: async (lane: string) => {
        inProcessRuns.push(lane);
        return ownLane(lane);
      },
      inChild: () => {
        throw new Error("an unblocked package needs no child");
      },
    });
    expect(inProcessRuns).toEqual(["standalone-dynamic"]);
    expect(lanes.standalone).toEqual(skippedPerfLane("standalone", "compile-time-static"));
    expect(lanes.standaloneDynamic.diagnostic).toBe(OWN["standalone-dynamic"]);
  });

  it("the generator routes both standalone lanes through the resolver (no host-block fallback left)", () => {
    const source = readFileSync(join(__dirname, "..", "scripts", "generate-npm-compat-report.mjs"), "utf-8");
    const body = source.slice(source.indexOf("async function perfNpmCompatPackage("));
    const perfFn = body.slice(0, body.indexOf("\n}\n"));
    expect(perfFn).toContain("resolveStandalonePerfLanes(");
    expect(perfFn).not.toMatch(/blocked\?\.standalone/);
    expect(perfFn).not.toMatch(/blocked\?\.standaloneDynamic/);
  });
});
