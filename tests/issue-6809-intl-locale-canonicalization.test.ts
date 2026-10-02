import { describe, expect, it } from "vitest";
import {
  canonicalizeUnicodeLocaleIdentifier,
  IntlLocaleDataError,
  IntlLocaleSyntaxError,
  isWellFormedUnicodeBcp47LocaleIdentifier,
  parseUnicodeBcp47LocaleIdentifier,
  type IntlLocaleCanonicalizationData,
  validateIntlLocaleCanonicalizationData,
} from "../src/codegen/intl-locale-canonicalization.js";

const localeData: IntlLocaleCanonicalizationData = {
  schemaVersion: 1,
  localeAliases: {
    language: {
      old: { reason: "deprecated", replacement: "neo-Latn" },
      "art-lojban": { reason: "deprecated", replacement: "jbo" },
    },
    script: {
      qaai: { reason: "deprecated", replacement: "Zinh" },
    },
    region: {
      ZZ: { reason: "deprecated", replacement: "AA BB" },
    },
    variant: {
      heploc: { reason: "deprecated", replacement: "alalc97" },
    },
  },
  likelySubtags: {
    "neo-Latn": "neo-Latn-BB",
    und: "und-Latn-AA",
  },
  unicodeExtension: {
    keyAliases: {},
    keys: {
      ca: {
        aliases: [],
        preferred: null,
        typeAliases: {
          islamicc: "islamic-civil",
        },
        types: {
          "islamic-civil": { aliases: [], preferred: null },
          islamicc: { aliases: ["islamic-civil"], preferred: "islamic-civil" },
        },
      },
      kk: {
        aliases: [],
        preferred: null,
        typeAliases: {},
        types: {
          true: { aliases: [], preferred: null },
        },
      },
    },
  },
  transformedExtension: {
    fields: {
      m0: {
        aliases: [],
        preferred: null,
        valueAliases: {
          names: "prprname",
        },
        values: {
          names: { aliases: ["prprname"], preferred: "prprname" },
          prprname: { aliases: [], preferred: null },
          ungegn: { aliases: [], preferred: null },
        },
      },
    },
  },
};

function copyData(): IntlLocaleCanonicalizationData {
  return JSON.parse(JSON.stringify(localeData)) as IntlLocaleCanonicalizationData;
}

describe("#6809 generic Unicode BCP 47 locale kernel", () => {
  it("parses generic Unicode BCP 47 grammar without an available-locales filter", () => {
    expect(
      isWellFormedUnicodeBcp47LocaleIdentifier(
        "qaa-Latn-001-fonipa-a-foobar-t-en-latn-ca-emodeng-m0-ascii-u-foo-ca-islamicc-x-private",
      ),
    ).toBe(true);
    expect(canonicalizeUnicodeLocaleIdentifier("qaa-Latn-001", localeData)).toBe("qaa-Latn-001");
    expect(canonicalizeUnicodeLocaleIdentifier("qaa-Latn-001-fonipa", localeData)).toBe("qaa-Latn-001-fonipa");
  });

  it("canonicalizes aliases, extension order, u attributes, and t fields from injected metadata", () => {
    expect(
      canonicalizeUnicodeLocaleIdentifier(
        "OLD-zz-SCOUSE-heploc-u-zoo-foo-foo-ca-islamicc-kk-true-t-old-m0-names-k0-QWERTZ-a-FOOBAR-x-PRIVATE",
        localeData,
      ),
    ).toBe(
      "neo-Latn-BB-alalc97-scouse-a-foobar-t-neo-latn-k0-qwertz-m0-prprname-u-foo-zoo-ca-islamic-civil-kk-x-private",
    );
  });

  it("accepts ECMA-402-permitted duplicate extension fields and canonicalizes them generically", () => {
    expect(isWellFormedUnicodeBcp47LocaleIdentifier("en-u-ca-buddhist-ca-islamic")).toBe(true);
    expect(canonicalizeUnicodeLocaleIdentifier("en-u-ca-buddhist-ca-islamic", localeData)).toBe("en-u-ca-buddhist");

    expect(isWellFormedUnicodeBcp47LocaleIdentifier("en-t-m0-ungegn-m0-names")).toBe(true);
    expect(canonicalizeUnicodeLocaleIdentifier("en-t-m0-ungegn-m0-names", localeData)).toBe(
      "en-t-m0-prprname-m0-ungegn",
    );
  });

  it("uses the generic whole-base alias route and does not hard-code a locale spelling", () => {
    expect(canonicalizeUnicodeLocaleIdentifier("ART-lojban", localeData)).toBe("jbo");
    expect(canonicalizeUnicodeLocaleIdentifier("qaa-QAAI", localeData)).toBe("qaa-Zinh");
  });

  it("rejects invalid Unicode BCP 47 forms before canonicalization", () => {
    const invalid = [
      "",
      "root",
      "Latn-US",
      "zh-cmn-Hans",
      "en_US",
      "en--US",
      "en-t-d0",
      "en-t-ar-aao",
      "en-x",
      "x-private",
    ];

    for (const locale of invalid) {
      expect(isWellFormedUnicodeBcp47LocaleIdentifier(locale)).toBe(false);
      expect(() => parseUnicodeBcp47LocaleIdentifier(locale)).toThrow(IntlLocaleSyntaxError);
      expect(() => canonicalizeUnicodeLocaleIdentifier(locale, localeData)).toThrow(IntlLocaleSyntaxError);
    }
  });

  it("fails closed for a wrong schema, malformed extension table, and data alias cycle", () => {
    const wrongSchema = copyData() as unknown as { schemaVersion: number };
    wrongSchema.schemaVersion = 2;
    expect(() => validateIntlLocaleCanonicalizationData(wrongSchema as IntlLocaleCanonicalizationData)).toThrow(
      IntlLocaleDataError,
    );

    const malformedExtension = copyData() as unknown as {
      unicodeExtension: { keys: { ca: { typeAliases: unknown } } };
    };
    malformedExtension.unicodeExtension.keys.ca.typeAliases = null;
    expect(() => validateIntlLocaleCanonicalizationData(malformedExtension as IntlLocaleCanonicalizationData)).toThrow(
      IntlLocaleDataError,
    );

    const cycle = copyData() as unknown as {
      localeAliases: { language: Record<string, { replacement: string }> };
    };
    cycle.localeAliases.language = {
      aa: { replacement: "bb" },
      bb: { replacement: "aa" },
    };
    expect(() => validateIntlLocaleCanonicalizationData(cycle as IntlLocaleCanonicalizationData)).toThrow(
      IntlLocaleDataError,
    );
  });
});
