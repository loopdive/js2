// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it } from "vitest";
import {
  getCompileProfile,
  profilePhase,
  refreshCompileProfileConfig,
  resetCompileProfile,
} from "../src/compile-profile.js";

const originalProfileMode = process.env.JS2WASM_COMPILE_PROFILE;

afterEach(() => {
  if (originalProfileMode === undefined) Reflect.deleteProperty(process.env, "JS2WASM_COMPILE_PROFILE");
  else process.env.JS2WASM_COMPILE_PROFILE = originalProfileMode;
  refreshCompileProfileConfig();
  resetCompileProfile();
});

describe("#3946 compile phase streaming", () => {
  it("announces an active nested phase before it completes", () => {
    process.env.JS2WASM_COMPILE_PROFILE = "stream";
    refreshCompileProfileConfig();
    resetCompileProfile();

    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      profilePhase("outer", () => {
        expect(chunks.join("")).toContain("[js2:profile] START outer\n");
        profilePhase("inner", () => {
          expect(chunks.join("")).toContain("[js2:profile]   START outer/inner\n");
        });
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    const output = chunks.join("");
    expect(output).toMatch(/\[js2:profile\]\s+outer\/inner [\d.]+ms heap=/);
    expect(output).toMatch(/\[js2:profile\] outer [\d.]+ms heap=/);
    expect(getCompileProfile().map((record) => record.path)).toEqual(expect.arrayContaining(["outer", "outer/inner"]));
  });
});
