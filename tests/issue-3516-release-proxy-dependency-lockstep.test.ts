// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3516 — the unscoped js2wasm package version moved with each release while
// its dependency stayed at @loopdive/js2@0.60.1. Pin the dependency in the same
// release transaction and reject a tag whose three version carriers diverge.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pinProxyDependency } from "../scripts/release.mjs";

const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));

describe("#3516 js2wasm proxy dependency lockstep", () => {
  it("pins @loopdive/js2 without mutating the input manifest", () => {
    const pkg = {
      name: "js2wasm",
      dependencies: { "@loopdive/js2": "0.60.1", other: "1.0.0" },
    };
    const pinned = pinProxyDependency(pkg, "0.64.1");

    expect(pinned.dependencies).toEqual({ "@loopdive/js2": "0.64.1", other: "1.0.0" });
    expect(pkg.dependencies["@loopdive/js2"]).toBe("0.60.1");
  });

  it("refuses to invent the canonical dependency when the proxy contract is missing", () => {
    expect(() => pinProxyDependency({ name: "js2wasm", dependencies: {} }, "0.64.1")).toThrow(
      'proxy package.json must depend on "@loopdive/js2"',
    );
  });

  it("keeps the checked-in proxy version and dependency equal to the canonical version", () => {
    const root = readJson("../package.json");
    const proxy = readJson("../packages/js2wasm/package.json");

    expect(proxy.version).toBe(root.version);
    expect(proxy.dependencies["@loopdive/js2"]).toBe(root.version);
  });

  it("guards the proxy dependency in the tag-publish workflow", () => {
    const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
    expect(workflow).toContain("proxy_dependency=$(node -p");
    expect(workflow).toContain('if [ "$proxy_dependency" != "$version" ]');
  });
});
