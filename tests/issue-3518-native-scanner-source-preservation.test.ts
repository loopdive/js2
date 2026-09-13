// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Ordinary unit guards are checkout-local. The mandatory full public pair is
// scripts/verify-native-scanner-source-preservation.mjs with explicit CLI roots.
import { it, expect, describe } from "vitest";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  projectScanner,
  projectDecoder,
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
  function genuine() {
    const root = checkoutRoot;
    const path = join(realpathSync(root), "src/runtime/wasmgc/values/string-number-bodies.ts"),
      url = pathToFileURL(path).href,
      source = readFileSync(path, "utf8");
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const result = projectScanner(source, url, url, sha);
    expect(result.evidence.deltas).toHaveLength(3);
    expect(result.text).not.toBe(source);
    return { source, url, sha, result };
  }
  it("projects exactly the frozen span and two exact import bindings", () => {
    genuine();
  });
  for (const suffix of ["?duplicate=1", "#duplicate"])
    it(`rejects a wrong target URL ${suffix}`, () => {
      const { source, url, sha } = genuine();
      expect(() => projectScanner(source, url + suffix, url, sha)).toThrow("wrong projection target/root");
    });
  it("rejects a different compiler root", () => {
    const { source, url, sha } = genuine();
    expect(() => projectScanner(source, url.replace("/src/", "/foreign/src/"), url, sha)).toThrow(
      "wrong projection target/root",
    );
  });
  for (const mutation of [
    "missing-span",
    "duplicate-span",
    "misplaced-span",
    "missing-import",
    "renamed-import",
    "character",
    "index",
    "return",
    "unrelated-removal",
  ] as const)
    it(`rejects ${mutation} without repinning`, () => {
      const { source, url, sha, result } = genuine();
      const span = result.evidence.deltas[2]!.text;
      let changed: string;
      if (mutation === "missing-span") changed = source.replace(span, "");
      else if (mutation === "duplicate-span") changed = source.replace(span, span + span);
      else if (mutation === "misplaced-span") changed = source.replace(span, "") + span;
      else if (mutation === "missing-import") changed = source.replace(result.evidence.deltas[0]!.text, "");
      else if (mutation === "renamed-import") changed = source.replace("  C_LC_E,", "  C_UC_E as C_LC_E,");
      else if (mutation === "character") changed = source.replace(span, span.replace("value: C_LC_E", "value: C_ZERO"));
      else if (mutation === "index") changed = source.replace(span, span.replace("index: L_I", "index: L_END"));
      else if (mutation === "return") changed = source.replace(span, span.replace('{ op: "return" }', '{ op: "nop" }'));
      else changed = source.replace('    { op: "any.convert_extern" },\n', "");
      expect(changed).not.toBe(source);
      expect(() => projectScanner(changed, url, url, sha)).toThrow("projection input hash differs");
    });
  for (const count of [0, 1, 3])
    it(`rejects projection transformation count ${count}`, () => {
      requireTransformCount(2, "projection");
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
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  function genuine() {
    const root = checkoutRoot;
    const url = pathToFileURL(join(realpathSync(root), "src/runtime/wasmgc/values/string-utf8-decode-bodies.ts")).href;
    const source = readFileSync(new URL(url), "utf8");
    const result = projectDecoder(source, url, url, sha);
    expect(result.evidence.outputHash).toBe("bced4ba015efad207b0e2fbce7f3dfb7da4a0782f9fbc5c8625bea45133f9ac6");
    return { source, url, result };
  }
  it("authenticates the complete decoder inverse", () => {
    genuine();
  });
  for (const kind of [
    "wrong target",
    "wrong root",
    "missing",
    "duplicate",
    "misplaced",
    "altered",
    "unrelated instruction",
  ] as const)
    it("rejects decoder " + kind + " after positive", () => {
      const { source, url, result } = genuine(),
        d = result.evidence.deltas[0]!;
      if (kind === "wrong target" || kind === "wrong root") {
        expect(() =>
          projectDecoder(
            source,
            kind === "wrong target" ? url + "?other" : url.replace("/src/", "/foreign/src/"),
            url,
            sha,
          ),
        ).toThrow("wrong decoder projection target/root");
        return;
      }
      const changed =
        kind === "missing"
          ? source.replace(d.text, "")
          : kind === "duplicate"
            ? source + d.text
            : kind === "misplaced"
              ? "\n" + source
              : kind === "altered"
                ? source.replace("local.tee", "local.set")
                : source.replace("value: 0x80", "value: 0x81");
      expect(changed).not.toBe(source);
      expect(() => projectDecoder(changed, url, url, sha)).toThrow("decoder projection input hash differs");
    });
  for (const kind of ["missing", "duplicate", "foreign"] as const)
    it("rejects per-target " + kind + " even with a plausible aggregate", () => {
      const root = "/candidate";
      const keys = ["string-number-bodies.ts", "string-utf8-decode-bodies.ts"].map(
        (name) => pathToFileURL(join(root, "src/runtime/wasmgc/values", name)).href,
      );
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
