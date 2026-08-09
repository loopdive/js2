// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#743) The derivation-flag family's DEFAULT and its token spelling.
 *
 * These flags shipped default-OFF and were flipped default-ON on 2026-08-08
 * ("derive types always; consumers arrive later"). The flip inverts what
 * "unset" means, which is exactly the kind of change that rots silently: a test
 * that establishes its flag-off baseline by DELETING the variable keeps passing
 * while quietly testing the flag-ON path on both sides of its own A/B. Several
 * suites in this family did that; they now spell `"0"`.
 *
 * This file is the pin for the spelling itself. It is deliberately cheap (no
 * compiles) so it can be the thing that fails first and unambiguously if anyone
 * re-inverts a default or hand-rolls a fourth copy of the token rule.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  derivationFlagEnabled,
  dtsEntrypointSeedsFlagEnabled,
  fieldWriteVerdictEnabled,
  fnctorCtorParamSlotsEnabled,
  fnctorCtorParamTypesFlagEnabled,
  fnctorTypedBindingsFlagEnabled,
  fnctorTypedReadsFlagEnabled,
} from "../src/derivation-flags.js";
import { fnctorCtorParamTypesEnabled } from "../src/codegen/fnctor-ctor-param-types.js";
import { fnctorTypedBindingsEnabled } from "../src/codegen/fnctor-typed-bindings.js";
import { fnctorTypedReadsEnabled } from "../src/codegen/fnctor-typed-reads.js";
import { dtsEntrypointSeedsEnabled } from "../src/checker/dts-entrypoint-seeds.js";

const VARS = [
  "JS2WASM_FNCTOR_CTOR_PARAM_TYPES",
  "JS2WASM_DTS_ENTRYPOINT_SEEDS",
  "JS2WASM_FNCTOR_TYPED_READS",
  "JS2WASM_FNCTOR_TYPED_BINDINGS",
] as const;

const saved = new Map(VARS.map((v) => [v, process.env[v]]));

afterEach(() => {
  for (const [v, value] of saved) {
    if (value === undefined) {
      // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
      delete process.env[v];
    } else {
      process.env[v] = value;
    }
  }
});

/** Set every family variable to one spelling. */
function setAll(value: string | undefined): void {
  for (const v of VARS) {
    if (value === undefined) {
      // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
      delete process.env[v];
    } else {
      process.env[v] = value;
    }
  }
}

const PREDICATES: ReadonlyArray<readonly [string, () => boolean]> = [
  ["ctor-param-types (leaf)", fnctorCtorParamTypesFlagEnabled],
  ["ctor-param-types (module)", fnctorCtorParamTypesEnabled],
  ["dts-entrypoint-seeds (leaf)", dtsEntrypointSeedsFlagEnabled],
  ["dts-entrypoint-seeds (module)", dtsEntrypointSeedsEnabled],
  ["typed-reads (leaf)", fnctorTypedReadsFlagEnabled],
  ["typed-reads (module)", fnctorTypedReadsEnabled],
  ["typed-bindings (leaf)", fnctorTypedBindingsFlagEnabled],
  ["typed-bindings (module)", fnctorTypedBindingsEnabled],
];

describe("#743 — derivation flag defaults (flipped ON 2026-08-08)", () => {
  it("unset ⇒ ON for every flag in the family, through both the leaf and the per-pass predicate", () => {
    setAll(undefined);
    for (const [name, predicate] of PREDICATES) {
      expect(predicate(), `${name} must default ON when unset`).toBe(true);
    }
  });

  it("the per-pass predicate and the leaf never disagree", () => {
    // The per-pass modules keep their own exported name and delegate. If one
    // ever stops delegating, this catches it on every spelling rather than only
    // on the default.
    for (const spelling of [undefined, "", " ", "0", "off", "OFF", "1", "true", "yes"]) {
      setAll(spelling);
      expect(fnctorCtorParamTypesEnabled()).toBe(fnctorCtorParamTypesFlagEnabled());
      expect(dtsEntrypointSeedsEnabled()).toBe(dtsEntrypointSeedsFlagEnabled());
      expect(fnctorTypedReadsEnabled()).toBe(fnctorTypedReadsFlagEnabled());
      expect(fnctorTypedBindingsEnabled()).toBe(fnctorTypedBindingsFlagEnabled());
    }
  });

  it("token rule: only 0/off/empty disable; case-insensitive and whitespace-trimmed", () => {
    // Disabling spellings — the one-variable revert this family promises.
    for (const off of ["0", "off", "OFF", "Off", "", "  ", " 0 ", "\toff\n"]) {
      expect(derivationFlagEnabled(off), `${JSON.stringify(off)} must disable`).toBe(false);
    }
    // Everything else enables, INCLUDING typos. Boolean-shaped on purpose:
    // there is no numeric knob here, so a malformed value cannot half-enable
    // anything — it merely fails to disable, which is the safe direction for a
    // flag whose OFF position exists as an escape hatch.
    for (const on of [undefined, "1", "true", "yes", "on", "2", "ofF!", "false"]) {
      expect(derivationFlagEnabled(on), `${JSON.stringify(on)} must enable`).toBe(true);
    }
  });

  it("`false` enables — recorded as a known sharp edge, not an oversight", () => {
    // This mirrors `JS2WASM_FNCTOR_LAYOUT_EMIT` (#4241) exactly, and the
    // consistency is worth more than the intuition: one rule across the family
    // beats four flags that each guess differently at what a user meant. The
    // documented off-switch is `=0`.
    setAll("false");
    for (const [name, predicate] of PREDICATES) {
      expect(predicate(), `${name}: "false" is not an off-spelling`).toBe(true);
    }
  });

  it("the field-SLOT sub-lever follows the token rule since #4250, and the verdict flag dominates it", () => {
    // Until #4250 this was the family's one default-OFF exception: the
    // narrowing typed a slot from the constructor's writes alone, so a later
    // `a.f = "s"` read back wrong. The whole-program write-kind verdict now
    // gates every narrowing fail-closed inside
    // `inferFnctorFieldTypeFromCtorParam`, which is what licensed the flip —
    // and is also why the lever is FORCED OFF whenever the verdict itself is
    // disabled: the unsound-lever-ON combination must not be reachable by one
    // stray environment line.
    const savedSlots = process.env.JS2WASM_FNCTOR_CTOR_PARAM_SLOTS;
    const savedVerdict = process.env.JS2WASM_FIELD_WRITE_VERDICT;
    try {
      // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
      delete process.env.JS2WASM_FIELD_WRITE_VERDICT;
      // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
      delete process.env.JS2WASM_FNCTOR_CTOR_PARAM_SLOTS;
      expect(fnctorCtorParamSlotsEnabled(), "ON when unset — the family rule").toBe(true);
      expect(fieldWriteVerdictEnabled(), "verdict ON when unset").toBe(true);
      for (const spelling of ["", "0", "off", " OFF "]) {
        process.env.JS2WASM_FNCTOR_CTOR_PARAM_SLOTS = spelling;
        expect(fnctorCtorParamSlotsEnabled(), `${JSON.stringify(spelling)} must disable`).toBe(false);
      }
      for (const spelling of ["1", "on", "yes"]) {
        process.env.JS2WASM_FNCTOR_CTOR_PARAM_SLOTS = spelling;
        expect(fnctorCtorParamSlotsEnabled(), `${JSON.stringify(spelling)} keeps it on`).toBe(true);
      }
      // The verdict flag DOMINATES: verdict off ⇒ lever off, whatever its own
      // variable says.
      process.env.JS2WASM_FNCTOR_CTOR_PARAM_SLOTS = "1";
      process.env.JS2WASM_FIELD_WRITE_VERDICT = "0";
      expect(fieldWriteVerdictEnabled()).toBe(false);
      expect(fnctorCtorParamSlotsEnabled(), "verdict off forces the lever off").toBe(false);
    } finally {
      if (savedSlots === undefined) {
        // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
        delete process.env.JS2WASM_FNCTOR_CTOR_PARAM_SLOTS;
      } else {
        process.env.JS2WASM_FNCTOR_CTOR_PARAM_SLOTS = savedSlots;
      }
      if (savedVerdict === undefined) {
        // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
        delete process.env.JS2WASM_FIELD_WRITE_VERDICT;
      } else {
        process.env.JS2WASM_FIELD_WRITE_VERDICT = savedVerdict;
      }
    }
  });

  it("each flag is independently disablable — no flag disables a sibling", () => {
    setAll(undefined);
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "0";
    expect(fnctorCtorParamTypesFlagEnabled()).toBe(false);
    expect(dtsEntrypointSeedsFlagEnabled()).toBe(true);
    expect(fnctorTypedReadsFlagEnabled()).toBe(true);
    expect(fnctorTypedBindingsFlagEnabled()).toBe(true);
  });
});
