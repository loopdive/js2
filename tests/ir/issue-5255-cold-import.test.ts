// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5255 — keep the IR allocation test graph safe when codegen is loaded cold.
// The original corrective CI failure was an initialization cycle: importing
// the generator receiver path eagerly reached collections-brand.ts while its
// map-runtime dependency was still evaluating, leaving MAP_LAYOUT undefined.
// This file intentionally imports the IR surface first and only then loads the
// codegen module, matching the order used by the allocation suites.
import { describe, expect, it } from "vitest";

import type { CodegenContext } from "../../src/codegen/context/types.js";
import { AllocSiteRegistry, irVal } from "../../src/ir/index.js";

describe("#5255 cold codegen/IR module graph", () => {
  it("keeps collection brand constants initialized after IR allocation imports", async () => {
    const registry = new AllocSiteRegistry();
    const site = registry.fresh("object", irVal({ kind: "f64" }));
    expect(registry.resolve(site)?.id).toBe(site);

    // Dynamic import is deliberate: IR has evaluated before the codegen graph
    // starts, so a future eager this-keyword edge cannot hide an init cycle
    // behind a warm module cache.
    const { collectionBrandSpec } = await import("../../src/codegen/collections-brand.js");
    const spec = collectionBrandSpec({ mapTypeIdx: 17 } as CodegenContext, "Map");
    expect(spec.structTypeIdx).toBe(17);
    expect(spec.kindField).toEqual({ fieldIdx: 4, accept: [0] });
  });
});
