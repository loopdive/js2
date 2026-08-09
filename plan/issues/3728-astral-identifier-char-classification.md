---
id: 3728
title: "Astral (surrogate-pair) Unicode identifier characters misclassified in a few edge positions — acorn official suite"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: low
horizon: m
feasibility: hard
reasoning_effort: medium
task_type: bugfix
area: checker, codegen
language_feature: unicode
goal: core-semantics
origin: "tests/dogfood/acorn-official-suite.mjs (#3729) — acorn's own test suite, 4/3518 failures + 1 unrelated oddity"
related: [3729, 1710]
---

# #3728 — astral identifier-char classification edge cases

## Repro

Compile acorn (pinned `acorn@8.16.0`) with js2wasm and run acorn's own
driver against it (`pnpm run dogfood:acorn-official-suite`, #3729). 4 of
acorn's own test cases fail on astral (supplementary-plane, i.e.
surrogate-pair-encoded) identifier characters:

| source | real acorn | compiled acorn |
|---|---|---|
| `let in𝐬𝐭𝐚𝐧𝐜𝐞𝐨𝐟;` | parses OK (one identifier, `in` + bold-math letters is valid `ID_Continue`, not the `instanceof` keyword) | throws `Unexpected token (1:4)` |
| `let 𝐢𝐧;` | parses OK (a plain identifier) | throws `Unexpected token (1:4)` |
| `async function𝐬 f() {}` | throws `Unexpected token (1:17)` (`𝐬` is NOT valid directly after the `function` keyword in this position) | parses successfully (should have thrown) |
| `{ let 𠮷 = foo(); }` | parses OK (`𠮷`, U+20B9F, is a valid `ID_Start` CJK character — a classic Unicode-edge-case test fixture char) | throws `The keyword 'let' is reserved (1:2)` |

Two of the four are "should have rejected, didn't" and two are "should
have accepted, rejected" — not a one-directional bias, consistent with a
classification-table boundary/lookup bug rather than a wholesale
astral-range gap (compiled acorn clearly handles SOME astral identifier
chars correctly, given the other 3,514 passing cases include many
non-ASCII identifiers).

## Scope

- [ ] Isolate whether this is in js2wasm's own identifier-classification
      logic (if compiled code re-implements char classification rather
      than delegating to acorn's own tables/functions) or a surrogate-pair
      /codepoint-decoding boundary issue specific to certain astral
      ranges (mathematical alphanumeric symbols U+1D400–U+1D7FF for the
      bold-letter cases; CJK Extension B U+20000–U+2A6DF for `𠮷`).
  - `let X = foo()` vs `let X;` — the 4th case additionally involves
    `let`'s conditional-keyword-reservation logic (whether `let` is being
    used as a declaration keyword or as a plain identifier depends on what
    follows it), so this may be less about char classification directly
    and more about how that disambiguation reads the following character
    when it's astral-encoded.
- [ ] Minimal repro per case, isolated from acorn's own source.
- [ ] Fix + regression test.

## Unrelated but adjacent finding: CJK string-literal export-binding error text

One additional, extremely narrow, unrelated failure surfaced in the same
run — noted here rather than filed as its own issue given how narrow it
is (1/3518 cases, likely near-zero real-world impact):

```
export { "學而時習之，不亦說乎？", "吾道一以貫之。" as "忠恕。" };
```

Real acorn: `A string literal cannot be used as an exported binding
without \`from\`. (1:9)`. Compiled acorn: `Unexpected keyword 'null'
(1:9)` — same position, completely different (and nonsensical — there is
no `null` keyword anywhere in this source) message, suggesting the CJK
string literal itself gets mis-tokenized into something that later
resolves to a stray `null` reference internally. If whoever picks up the
astral-char classification work above finds a shared root cause, fold this
in; otherwise it's low priority on its own.

## Acceptance criteria

- [ ] The 4 astral-identifier-char repros above all match real acorn's
      accept/reject behavior.
- [ ] `BASELINE_PASSED` in `tests/dogfood/acorn-official-suite.test.ts`
      updated to reflect the improved pass count.
- [ ] (optional, low priority) the CJK export-binding error-message oddity
      resolved if it shares a root cause with the above.
