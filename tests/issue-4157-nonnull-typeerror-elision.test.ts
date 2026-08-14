// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) `JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR` — eliding the member-access
 * null guard where the receiver is provably non-null.
 *
 * Three things have to hold, and the second and third are the ones a parity-only
 * fixture would skip.
 *
 * 1. **`=0` is byte-identical.** The flag defaults ON since the #4157 tuned-set
 *    flip; with `=0` every wired call site falls through to the legacy
 *    emission, which is the only revert.
 * 2. **ON actually engages.** Measured on the standalone acorn build, only 2 of
 *    3,629 guard sites are provable, so a fixture that merely "looks like" it
 *    should qualify can easily qualify nowhere and leave a green test that
 *    measures nothing. The binaries are therefore asserted to DIFFER.
 * 3. **The guard is still there where it is needed.** The failure mode of this
 *    optimisation is not a wrong number, it is a *missing throw* — a null
 *    receiver that should raise a catchable `TypeError` instead traps on
 *    `struct.get`, which Wasm exception handling cannot catch. So a null
 *    receiver is exercised under BOTH flag states and must still throw.
 *
 * Answers are checked against what the equivalent JavaScript produces, not
 * against the OFF build — ON and OFF would happily agree on a wrong answer.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/**
 * `g`'s parameter is declared as the class type, so `p` compiles to a
 * NON-nullable `(ref $P)` and the guard's `ref.is_null` is dead by the wasm
 * type system alone — the `nonnull-ref` proof. `h` is the isolation control:
 * its receiver is `any`, which no proof reaches, so its guard must survive.
 */
const SOURCE = `
class P { x: number = 11; y: number = 31; }
function g(p: P): number { return p.x + p.y; }
function h(o: any): number { return o.x; }
export function run(): number { return g(new P()) * 2 + h({ x: 1 }); }
export function nullReceiver(): number {
  const bad: any = null;
  return bad.x;
}
`;

const FLAG = "JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR";

/**
 * `Reflect.deleteProperty` rather than `delete`: assigning `undefined` to a
 * `process.env` key stores the STRING "undefined", which reads as flag-on.
 */
function setFlag(value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, FLAG);
  else process.env[FLAG] = value;
}

async function build(flag: string | undefined): Promise<Uint8Array> {
  const previous = process.env[FLAG];
  setFlag(flag);
  try {
    const result = await compile(SOURCE, { fileName: "t.ts", target: "standalone", optimize: 0 });
    if (!result.binary?.length) throw new Error(`compile failed: ${JSON.stringify(result.errors?.slice(0, 2))}`);
    return result.binary;
  } finally {
    setFlag(previous);
  }
}

async function instantiate(binary: Uint8Array): Promise<Record<string, CallableFunction>> {
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(binary), {});
  return instance.exports as unknown as Record<string, CallableFunction>;
}

describe("#4157 provably-non-null TypeError elision", () => {
  // Default flipped to ON by the #4157 tuned set (`src/perf-flags.ts`): unset
  // now equals `=1`, and `=0` is the legacy emission. The elision-shrinks-the-
  // binary assertion is unchanged; only which build it is compared against is.
  it("ON is the default and OFF changes the emitted binary", async () => {
    const [off, unset, on] = await Promise.all([build("0"), build(undefined), build("1")]);
    expect(Buffer.from(unset)).toEqual(Buffer.from(on));
    // Mechanism: if this ever becomes equal the fixture stopped qualifying and
    // the rest of this file is measuring nothing.
    expect(Buffer.from(on)).not.toEqual(Buffer.from(off));
    expect(on.length).toBeLessThan(off.length);
  });

  it("answers match JavaScript under every flag state", async () => {
    // (11 + 31) * 2 + 1
    const expected = 85;
    for (const flag of ["0", "1", undefined]) {
      const exports = await instantiate(await build(flag));
      expect(exports.run!(), `flag=${flag ?? "unset"}`).toBe(expected);
    }
  });

  it("still throws on a genuinely null receiver under every flag state", async () => {
    for (const flag of ["0", "1", undefined]) {
      const exports = await instantiate(await build(flag));
      expect(() => exports.nullReceiver!(), `flag=${flag ?? "unset"}`).toThrow();
    }
  });
});
