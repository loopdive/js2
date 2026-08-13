// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) `JS2WASM_INLINE_HINTS` argument construction.
 *
 * The two properties worth pinning are both silent-failure guards, not
 * formatting checks:
 *
 * 1. **`=0` is byte-identical argv.** The flag's contract was that an *unset*
 *    build passes exactly the arguments it passed before; the #4157 tuned-set
 *    flip moved that guarantee onto an explicit off-token, because unset now
 *    selects the `cold` profile. A test that only checked the ON case would
 *    let a stray always-on argument through, and one that still pinned "unset
 *    adds nothing" would pin the pre-flip default.
 * 2. **`--no-inline` is a PASS and must precede `-O<level>`,** and its pass-arg
 *    accepts exactly ONE pattern. Measured against binaryen 125 on standalone
 *    acorn: `no-inline@__new_*` shrinks the binary by 32,938 B, while
 *    `no-inline@__new_TypeError,__new_Error` produces a BYTE-IDENTICAL binary
 *    and still exits 0 — a comma list is silently ignored. Both mistakes fail
 *    as "the optimisation quietly did not happen", which is why they are
 *    asserted here rather than left to a size measurement to notice.
 */
import { describe, expect, it } from "vitest";

import { inlineHintArgs } from "../src/inline-hints.js";

/** The `cold` profile — what `1`, and now absence, select. */
const COLD = ["--no-inline", "--pass-arg=no-inline@__new_*"];

describe("#4157 JS2WASM_INLINE_HINTS", () => {
  it("adds nothing for an explicit off-token — the byte-identical-OFF contract", () => {
    for (const off of ["", "0", "   ", "off", "false", "no"]) {
      expect(inlineHintArgs(off), `${JSON.stringify(off)} must be OFF`).toEqual({ pre: [], post: [] });
    }
  });

  it("unset selects the default profile — the tuned-set flip", () => {
    expect(inlineHintArgs(undefined)).toEqual({ pre: COLD, post: [] });
  });

  it("`1` selects the measured shrink profile, not a threshold bump", () => {
    // `-fimfs=60` GROWS the acorn binary 11.3 % and reaches only leaf helpers;
    // `cold` shrinks it 3.0 %. The default profile is the one that shrinks.
    const { pre, post } = inlineHintArgs("1");
    expect(pre).toEqual(COLD);
    expect(post).toEqual([]);
  });

  it("puts --no-inline in `pre` so it can be placed before -O<level>", () => {
    // Binaryen runs passes in command order: after `-O4` the marking happens
    // once inlining has already run, which is a silent no-op.
    expect(inlineHintArgs("cold").pre[0]).toBe("--no-inline");
  });

  it("emits exactly one no-inline pattern and rejects a comma list", () => {
    expect(inlineHintArgs("no-inline=__new_TypeError").pre).toEqual([
      "--no-inline",
      "--pass-arg=no-inline@__new_TypeError",
    ]);
    // A list is what binaryen ignores, so it is still refused — but refusing it
    // now leaves the spec having selected nothing, which under the tuned
    // default means the default profile, NOT an empty argv. The multi-pattern
    // request is dropped either way; what changed is what replaces it.
    expect(inlineHintArgs("no-inline=__new_TypeError|__new_Error").pre).toEqual(COLD);
    expect(inlineHintArgs("cold,no-inline=__str_*").pre).toEqual(COLD);
  });

  it("maps the numeric budget knobs to their binaryen 125 long flags", () => {
    expect(inlineHintArgs("fimfs=60,aimfs=8,pii=2,ifwl").post).toEqual([
      "--flexible-inline-max-function-size=60",
      "--always-inline-max-function-size=8",
      "--partial-inlining-ifs=2",
      "--inline-functions-with-loops",
    ]);
  });

  it("drops unknown or malformed knobs rather than failing wasm-opt", () => {
    // An unrecognised argument makes wasm-opt exit non-zero, which optimize.ts
    // reports as "wasm-opt failed" and answers with the UNOPTIMIZED binary. So
    // the junk is still dropped; an all-junk spec then falls back to the tuned
    // default, since only `0` means off.
    expect(inlineHintArgs("nonsense=3,fimfs=abc,alsoNonsense")).toEqual({ pre: COLD, post: [] });
    // A spec that DID name a real knob keeps exactly that knob — the fallback
    // is for "nothing was recognised", not "something was mistyped alongside".
    expect(inlineHintArgs("nonsense=3,fimfs=60")).toEqual({
      pre: [],
      post: ["--flexible-inline-max-function-size=60"],
    });
  });
});
