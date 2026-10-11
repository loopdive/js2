// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  applyClosureApplyExtraction,
  authenticateApplyExtraction,
  readApplyBuilderSource,
  applyExtractionReceiptText,
} from "./helpers/object-runtime-apply-extraction.js";
import {
  applyFnctorGuardForward,
  authenticateFnctorGuardReceipt,
  fnctorGuardReceiptText,
} from "./helpers/object-runtime-fnctor-guard-forward.js";
import { describe, expect, it } from "vitest";
import {
  applyObjectRuntimeMainComposition,
  authenticateObjectRuntimeMainComposition,
  invertObjectRuntimeMainComposition,
  objectRuntimeMainCompositionText,
  verifyObjectRuntimeMainComposition,
} from "./helpers/object-runtime-main-composition.js";
import {
  conversionSha,
  objectRuntimePath,
  readConversionSource,
  verifyConversionComposition,
} from "./helpers/conversion-source-composition.js";
import {
  verifyObjectRuntimeComposition,
  verifyPreWriteObjectRuntimeComposition,
} from "./helpers/object-get-key-composition.js";
import { invertObjectWriteSource, replayObjectWriteSource } from "./helpers/native-object-write-donor.js";

const receipt = authenticateObjectRuntimeMainComposition();
const actual = readConversionSource(objectRuntimePath);
const rawCurrent = actual;
const verifyCurrentObjectRuntimeComposition = verifyObjectRuntimeComposition;
// Every historical mutant starts from the actual candidate's authenticated write inverse.
const current = invertObjectWriteSource(
  objectRuntimePath,
  applyFnctorGuardForward(applyClosureApplyExtraction(actual, true), true),
);
describe("fixed main changes precede the unchanged conversion and getter/key inverses", () => {
  it("reconstructs the entire signed integration and reciprocally reproduces the actual merge", () => {
    verifyObjectRuntimeComposition(actual);
    const integration = verifyObjectRuntimeMainComposition(current);
    expect(conversionSha(integration)).toBe("2cc32a6af0e913340ac8a27c77befb6b345a61688893aa1cb3fc29d6161719b7");
    expect(integration).not.toBe(current);
    expect(applyObjectRuntimeMainComposition(integration, false)).toBe(current);
    expect(receipt.spans).toHaveLength(19);
    expect(receipt.integration.blob).toBe("77ddd2aabd035307a0be00928f927e158c721bc2");
  });

  it("retains every historical full-source validator and reproduces the exact main Git blob", () => {
    verifyObjectRuntimeMainComposition(current);
    const conversions = verifyConversionComposition();
    expect(conversions).toHaveLength(2);
    const original = verifyPreWriteObjectRuntimeComposition(current).original;
    expect(conversionSha(original)).toBe(receipt.base.sha256);
    const main = applyObjectRuntimeMainComposition(original, false);
    expect(conversionSha(main)).toBe("45b31c33b9524059163ddf8de9945848db3685437d72454a63e5107207fadd35");
    expect(receipt.main.blob).toBe("57375151acd765e8870c3c7f67bf7e25797fd970");
    expect(invertObjectRuntimeMainComposition(main)).toBe(original);
    // A real main-only source must not substitute for the integrated compiler.
    expect(() => verifyObjectRuntimeMainComposition(main)).toThrow("retained source mismatch");
    expect(() => verifyObjectRuntimeMainComposition(invertObjectRuntimeMainComposition(current))).toThrow(
      "span missing or duplicated",
    );
  });

  it.each(receipt.spans)("positive first: main span $ordinal rejects altered, removed and duplicated bytes", (span) => {
    verifyObjectRuntimeMainComposition(current);
    expect(current.split(span.after)).toHaveLength(2);
    const altered = span.after.replace(/\S/, (character) => (character === "~" ? "!" : "~"));
    expect(altered).not.toBe(span.after);
    for (const replacement of [altered, "", span.after + span.after]) {
      const changed = current.replace(span.after, replacement);
      expect(changed).not.toBe(current);
      expect(() => verifyObjectRuntimeMainComposition(changed)).toThrow("span missing or duplicated");
      expect(() => verifyPreWriteObjectRuntimeComposition(changed)).toThrow("span missing or duplicated");
    }
  });

  it("positive first: reordered main spans cannot cross the historical boundary", () => {
    verifyObjectRuntimeMainComposition(current);
    const first = receipt.spans[0]!.after;
    const last = receipt.spans.at(-1)!.after;
    const token = "__main_composition_reorder__";
    expect(current).not.toContain(token);
    const changed = current.replace(first, token).replace(last, first).replace(token, last);
    expect(changed).not.toBe(current);
    expect(() => verifyObjectRuntimeMainComposition(changed)).toThrow("span order mismatch");
    expect(() => verifyPreWriteObjectRuntimeComposition(changed)).toThrow("span order mismatch");
  });

  it("positive first: source outside all main spans remains visible to the old checks", () => {
    verifyObjectRuntimeMainComposition(current);
    verifyPreWriteObjectRuntimeComposition(current);
    const retained = 'name: "previousActive"';
    expect(current).toContain(retained);
    expect(receipt.spans.every((span) => !span.after.includes(retained))).toBe(true);
    const changed = current.replace(retained, 'name: "changedActive"');
    expect(changed).not.toBe(current);
    expect(() => verifyObjectRuntimeMainComposition(changed)).toThrow("retained source mismatch");
    expect(() => verifyPreWriteObjectRuntimeComposition(changed)).toThrow("signed peer source mismatch");
  });

  it("positive first: changed receipt bytes cannot replace signed history", () => {
    expect(authenticateObjectRuntimeMainComposition().base.sha256).toBe(
      "692133e0345a24e3c45071ed031036b96dc3f6e7702dc358e2f99651820eed9e",
    );
    for (const text of [
      objectRuntimeMainCompositionText + "\n",
      objectRuntimeMainCompositionText.replace("35e040c0", "00000000"),
    ])
      expect(() => authenticateObjectRuntimeMainComposition(text)).toThrow("receipt digest mismatch");
  });
});

describe("committed fnctor prototype guard composes outside historical main", () => {
  it("restores the current compiler through old receipts and replays the guard", () => {
    verifyCurrentObjectRuntimeComposition(rawCurrent);
    verifyConversionComposition();
    const historical = verifyObjectRuntimeMainComposition(current);
    expect(
      applyClosureApplyExtraction(
        applyFnctorGuardForward(
          replayObjectWriteSource(objectRuntimePath, applyObjectRuntimeMainComposition(historical, false)),
          false,
        ),
        false,
      ),
    ).toBe(rawCurrent);
  });
  it.each(["missing", "altered", "duplicated"])("refuses %s guard after the live positive", (mutation) => {
    verifyCurrentObjectRuntimeComposition(rawCurrent);
    const { before, after } = authenticateFnctorGuardReceipt();
    expect(rawCurrent.split(after)).toHaveLength(2);
    const replacement =
      mutation === "missing"
        ? before
        : mutation === "duplicated"
          ? after + after
          : after.replace("!== undefined", "=== undefined");
    expect(replacement).not.toBe(after);
    const changed = rawCurrent.replace(after, replacement);
    expect(() => verifyCurrentObjectRuntimeComposition(changed)).toThrow("fnctor guard span missing or duplicated");
  });
  it("refuses changed guard provenance", () => {
    verifyCurrentObjectRuntimeComposition(rawCurrent);
    expect(() => authenticateFnctorGuardReceipt(fnctorGuardReceiptText + " ")).toThrow("receipt digest mismatch");
  });
});

describe("signed apply extraction outside prior main receipts", () => {
  const extraction = authenticateApplyExtraction();
  it("reconstructs the original full source and reciprocally replays actual merged bytes", () => {
    verifyCurrentObjectRuntimeComposition(rawCurrent);
    verifyConversionComposition();
    const inverse = applyClosureApplyExtraction(rawCurrent, true);
    expect(inverse).not.toBe(rawCurrent);
    expect(applyClosureApplyExtraction(inverse, false)).toBe(rawCurrent);
    expect(
      conversionSha(
        verifyObjectRuntimeMainComposition(
          invertObjectWriteSource(objectRuntimePath, applyFnctorGuardForward(inverse, true)),
        ),
      ),
    ).toBe("2cc32a6af0e913340ac8a27c77befb6b345a61688893aa1cb3fc29d6161719b7");
  });
  it.each(
    extraction.spans.flatMap((span) => ["missing", "altered", "duplicated"].map((mutation) => ({ span, mutation }))),
  )("refuses $mutation apply extraction span $span.id after live positive", ({ span, mutation }) => {
    verifyCurrentObjectRuntimeComposition(rawCurrent);
    const replacement =
      mutation === "missing"
        ? span.before
        : mutation === "duplicated"
          ? span.after + span.after
          : span.after.replace(
              /\bbuildClosureApply(?:Argument|CallArm|Length|ProxyGuard)\b/,
              (name) => `${name}Corrupted`,
            );
    expect(replacement).not.toBe(span.after);
    const changed = rawCurrent.replace(span.after, replacement);
    expect(changed).not.toBe(rawCurrent);
    if (mutation === "altered") expect(changed).not.toContain(span.after);
    expect(() => verifyCurrentObjectRuntimeComposition(changed)).toThrow("apply extraction span missing or duplicated");
  });
  it("rejects actual runtime builder mutation independently of unchanged adapter source", () => {
    verifyCurrentObjectRuntimeComposition(rawCurrent);
    const builder = readApplyBuilderSource();
    const changed = builder.replace('op: "ref.is_null"', 'op: "i32.eqz"');
    expect(changed).not.toBe(builder);
    expect(() => applyClosureApplyExtraction(rawCurrent, true, changed)).toThrow("actual builder mismatch");
  });
  it("rejects edited extraction provenance", () => {
    verifyCurrentObjectRuntimeComposition(rawCurrent);
    expect(() => authenticateApplyExtraction(applyExtractionReceiptText + " ")).toThrow("receipt digest mismatch");
  });
});
