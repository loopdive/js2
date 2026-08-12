// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("#3995 generated dogfood checkout lint scope", () => {
  it("keeps every hidden dogfood checkout ignored by Biome", () => {
    const root = resolve(import.meta.dirname, "..");
    const gitignore = readFileSync(resolve(root, ".gitignore"), "utf8");
    const biome = JSON.parse(readFileSync(resolve(root, "biome.json"), "utf8")) as {
      files?: { ignore?: string[] };
    };
    const biomeIgnores = new Set(biome.files?.ignore ?? []);
    const generatedCheckouts = gitignore.split(/\r?\n/).filter((line) => /^tests\/dogfood\/\.[^/]+\/$/.test(line));

    expect(generatedCheckouts.length).toBeGreaterThan(0);
    for (const checkout of generatedCheckouts) {
      expect(biomeIgnores, `Biome must ignore ${checkout}`).toContain(`${checkout}**`);
    }
  });
});
