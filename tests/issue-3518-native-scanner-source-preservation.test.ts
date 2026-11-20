// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Ordinary unit guards are checkout-local. The mandatory full public pair is
// scripts/verify-native-scanner-source-preservation.mjs with explicit CLI roots.
import { it, expect, describe } from "vitest";
import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  scannerProjectionTargets,
  scannerProjectionTarget,
  requireTerminal,
  requirePopulation,
  requireTransformCount,
  requireTargetLoads,
  scannerChildEnvironment,
  scannerRuntimeIdentity,
} from "../scripts/verify-native-scanner-source-preservation.mjs";
const checkoutRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const expectedIds = [
  ...Array.from({ length: 17 }, (_, i) => "3570:" + i),
  ...Array.from({ length: 43 }, (_, i) => "2654:" + i),
  ...Array.from({ length: 4 }, (_, i) => "1184:" + i),
  "malformed:0",
  "malformed:1",
];

describe("positive-first semantic projection and recorder admission", () => {
  for (const count of [0, 1, 2, 3, 5])
    it(`rejects projection transformation count ${count}`, () => {
      requireTransformCount(4, "projection");
      expect(() => requireTransformCount(count, "projection")).toThrow("missing/duplicate/unexpected transformation");
    });
  it("rejects any transform in the untouched candidate", () => {
    requireTransformCount(0, "candidate");
    expect(() => requireTransformCount(1, "candidate")).toThrow("missing/duplicate/unexpected transformation");
  });
  for (const mutate of ["missing", "duplicate", "reordered"] as const)
    it(`rejects ${mutate} source rows`, () => {
      requirePopulation(expectedIds);
      const ids = [...expectedIds];
      if (mutate === "missing") ids.pop();
      else if (mutate === "duplicate") ids[1] = ids[0]!;
      else [ids[0], ids[1]] = [ids[1]!, ids[0]!];
      expect(() => requirePopulation(ids)).toThrow("missing/duplicate/reordered source row");
    });
  it("rejects a failed child despite a passing-looking report", () => {
    const passingLookingReport = { ok: true, rows: expectedIds.map((id) => ({ id, kind: "executed" })) };
    requirePopulation(passingLookingReport.rows.map((row) => row.id));
    requireTerminal({ code: 0, signal: null }, 1);
    expect(() => requireTerminal({ code: 1, signal: null }, 1)).toThrow("unadmitted child terminal/receipt");
  });
  for (const count of [0, 2])
    it(`rejects child receipt count ${count}`, () => {
      requireTerminal({ code: 0, signal: null }, 1);
      expect(() => requireTerminal({ code: 0, signal: null }, count)).toThrow("unadmitted child terminal/receipt");
    });
});

describe("second exact root-bound decoder projection", () => {
  for (const kind of ["missing", "duplicate", "foreign"] as const)
    it("rejects per-target " + kind + " even with a plausible aggregate", () => {
      const root = "/candidate";
      const keys = Object.keys(scannerProjectionTargets(root));
      const counts = Object.fromEntries(keys.map((key) => [key, 1]));
      requireTargetLoads(counts, root, "projection");
      if (kind === "missing") delete counts[keys[1]!];
      else if (kind === "duplicate") counts[keys[0]!] = 2;
      else {
        delete counts[keys[1]!];
        counts["file:///foreign/decoder.ts"] = 1;
      }
      expect(() => requireTargetLoads(counts, root, "projection")).toThrow("missing/duplicate/foreign target load");
    });
});

describe("four exact loader coordinates, with historical legacy-only baseline", () => {
  const targets = scannerProjectionTargets(checkoutRoot);
  it("requires all four candidate roots and exactly the historical adapter at baseline", () => {
    expect(Object.keys(targets)).toHaveLength(4);
    requireTargetLoads(Object.fromEntries(Object.keys(targets).map((url) => [url, 1])), checkoutRoot, "candidate");
    const adapter = pathToFileURL(join(checkoutRoot, "src/codegen/native-strings-core.ts")).href;
    requireTargetLoads({ [adapter]: 1 }, checkoutRoot, "baseline");
    expect(() => requireTargetLoads({}, checkoutRoot, "baseline")).toThrow("missing/duplicate/foreign target load");
    expect(() => requireTargetLoads({ [adapter]: 2 }, checkoutRoot, "baseline")).toThrow(
      "missing/duplicate/foreign target load",
    );
    for (const [url, kind] of Object.entries(targets)) expect(scannerProjectionTarget(url, targets)).toBe(kind);
  });
  for (const [url, kind] of Object.entries(targets))
    for (const suffix of ["?duplicate=1", "#duplicate"])
      it("actually denies " + kind + suffix + " before loading, without a probe sentinel", () => {
        const script = String.raw`
        import assert from "node:assert/strict";
        import { registerHooks } from "node:module";
        const [root, harness, rejected] = process.argv.slice(1);
        const { scannerProjectionTargets, scannerProjectionTarget } = await import(harness);
        const targets = scannerProjectionTargets(root), denied = [], loaded = [];
        registerHooks({
          resolve(specifier, context, next) {
            const result = next(specifier, context);
            try { scannerProjectionTarget(result.url, targets); }
            catch (error) { denied.push({ url: result.url, message: error.message }); throw error; }
            return result;
          },
          load(url, context, next) { loaded.push(url); return next(url, context); }
        });
        const positive = await import("data:text/javascript,export default 42");
        assert.equal(positive.default, 42);
        let caught;
        try { await import(rejected); } catch (error) { caught = error; }
        assert(caught);
        assert.equal(caught.message, "wrong projection target/root " + rejected);
        assert.deepEqual(denied, [{ url: rejected, message: caught.message }]);
        assert(!loaded.includes(rejected));
        console.log(JSON.stringify({ positive: 42, denied, loaded }));
      `;
        const child = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            script,
            checkoutRoot,
            new URL("../scripts/verify-native-scanner-source-preservation.mjs", import.meta.url).href,
            url + suffix,
          ],
          { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" } },
        );
        expect(child.error).toBeUndefined();
        expect(child.status, child.stderr).toBe(0);
        const report = JSON.parse(child.stdout.trim());
        expect(report.positive).toBe(42);
        expect(report.denied).toEqual([{ url: url + suffix, message: "wrong projection target/root " + url + suffix }]);
        expect(report.loaded).not.toContain(url + suffix);
      });
});

describe("native scanner effective runtime authentication", () => {
  for (const poison of ["/tmp/foreign-esbuild", ""])
    it("removes inherited esbuild override " + JSON.stringify(poison) + " without mutating the parent", () => {
      const clean = scannerChildEnvironment(checkoutRoot);
      const positive = scannerRuntimeIdentity(checkoutRoot, clean);
      expect(positive.paths.nativeExecutable).toBeTruthy();
      const parent = { ...process.env, ESBUILD_BINARY_PATH: poison, JS2WASM_PROOF_SENTINEL: "unchanged" },
        before = { ...parent };
      const child = scannerChildEnvironment(checkoutRoot, parent);
      expect(Object.hasOwn(child, "ESBUILD_BINARY_PATH")).toBe(false);
      expect(parent).toEqual(before);
      expect(child.JS2WASM_PROOF_SENTINEL).toBe("unchanged");
      expect(child.TSX_TSCONFIG_PATH).toBe(join(checkoutRoot, "tsconfig.json"));
      expect(child.TSX_DISABLE_CACHE).toBe("1");
      expect(scannerRuntimeIdentity(checkoutRoot, child)).toEqual(positive);
    });
  for (const poison of ["/tmp/foreign-esbuild", ""])
    it("rejects surviving override " + JSON.stringify(poison) + " before tsx import", () => {
      const env = scannerChildEnvironment(checkoutRoot);
      scannerRuntimeIdentity(checkoutRoot, env);
      expect(() => scannerRuntimeIdentity(checkoutRoot, { ...env, ESBUILD_BINARY_PATH: poison })).toThrow(
        "surviving ESBUILD_BINARY_PATH override",
      );
    });
  it("rejects a mismatched native executable identity after a real positive", () => {
    const env = scannerChildEnvironment(checkoutRoot),
      identity = scannerRuntimeIdentity(checkoutRoot, env);
    expect(scannerRuntimeIdentity(checkoutRoot, env, identity)).toEqual(identity);
    const foreign = structuredClone(identity);
    foreign.content.files.nativeExecutable = "0".repeat(64);
    expect(() => scannerRuntimeIdentity(checkoutRoot, env, foreign)).toThrow("runtime identity differs");
  });
});
