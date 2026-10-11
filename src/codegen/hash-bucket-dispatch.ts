// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3926, #6698) Hash-bucket `br_table` dispatch with bounded block nesting.
 *
 * A Wasm `br_table` can only target ENCLOSING labels, so an N-way dispatch is
 * N nested `block`s: arm `j` sits right after the end of the `j`-th block.
 * The standalone `__extern_get` field-name dispatch emitted exactly that ladder
 * over every distinct closed-struct field name in the program — 2,292 nested
 * blocks for axios. Every post-codegen pass that walks instruction trees
 * recursively (`fixLocalSetCoercion`, `repairBody`, …) then needed one JS
 * stack frame per level and overflowed the default stack
 * ("Codegen error: Maximum call stack size exceeded"); with a raised
 * `--stack-size` the same compile took minutes, because several of those
 * walkers are super-linear in nesting depth.
 *
 * Past {@link FLAT_LADDER_MAX_ARMS} arms the ladder is therefore split in two
 * levels: an outer `br_table` over the masked hash selects a CHUNK of
 * ~sqrt(N) consecutive arms (by slot), and the chunk's own `br_table` over
 * `slot - chunkLo` selects the arm. Nesting drops from N to ~2·sqrt(N) (≈100
 * for axios) while dispatch stays two O(1) table jumps. Table bytes stay the
 * same order: the outer table is the original size and the inner tables
 * partition the occupied slot range. Ladders at or under the limit keep the
 * original single-level shape byte for byte.
 */
import type { Instr } from "../ir/types.js";

/** Largest arm count still emitted as one flat ladder (unchanged shape). */
export const FLAT_LADDER_MAX_ARMS = 256;

/** One dispatch arm: the table slots that select it and the code it runs. */
type LadderArm = readonly [slots: readonly number[], body: readonly Instr[]];

/**
 * One `br_table` ladder. `selector` leaves the table index on the stack; a slot
 * selects its arm, every other index (and the default) skips all arms. After an
 * arm runs, control leaves the wrapper block, so the wrapper's fallthrough means
 * "an arm ran to completion, or nothing matched" — the caller's next code.
 */
function buildLadder(selector: readonly Instr[], tableLength: number, arms: readonly LadderArm[]): Instr {
  const count = arms.length;
  const targets = new Array<number>(tableLength).fill(count);
  arms.forEach(([slots], ordinal) => {
    for (const slot of slots) targets[slot] = ordinal;
  });
  let tree: Instr[] = [...selector, { op: "br_table", targets, defaultDepth: count }];
  for (let ordinal = 0; ordinal < count; ordinal++) {
    tree = [
      { op: "block", blockType: { kind: "empty" }, body: tree },
      ...arms[ordinal]![1],
      // Arm done: skip the outer arms. The last arm falls through to the
      // wrapper end naturally.
      ...(ordinal === count - 1 ? [] : ([{ op: "br", depth: count - 1 - ordinal }] satisfies Instr[])),
    ];
  }
  return { op: "block", blockType: { kind: "empty" }, body: tree };
}

/**
 * Dispatch on `hashLocal & tableMask`. `buckets` pairs each occupied slot with
 * its probe code; they must be sorted by ascending slot. Returns one `block`.
 */
export function buildHashBucketDispatch(
  hashLocal: number,
  tableMask: number,
  buckets: ReadonlyArray<readonly [slot: number, probes: Instr[]]>,
): Instr {
  const masked: Instr[] = [
    { op: "local.get", index: hashLocal },
    { op: "i32.const", value: tableMask },
    { op: "i32.and" },
  ];
  if (buckets.length <= FLAT_LADDER_MAX_ARMS) {
    return buildLadder(
      masked,
      tableMask + 1,
      buckets.map(([slot, probes]) => [[slot], probes] as const),
    );
  }
  const chunkSize = Math.ceil(Math.sqrt(buckets.length));
  const chunks: LadderArm[] = [];
  for (let start = 0; start < buckets.length; start += chunkSize) {
    const chunk = buckets.slice(start, start + chunkSize);
    const lo = chunk[0]![0];
    const hi = chunk[chunk.length - 1]![0];
    // The outer table routes only this chunk's occupied slots here, so
    // `slot - lo` is always inside [0, hi - lo].
    const inner = buildLadder(
      [...masked.map((instr) => ({ ...instr })), { op: "i32.const", value: lo }, { op: "i32.sub" }],
      hi - lo + 1,
      chunk.map(([slot, probes]) => [[slot - lo], probes] as const),
    );
    chunks.push([chunk.map(([slot]) => slot), [inner]]);
  }
  return buildLadder(masked, tableMask + 1, chunks);
}
