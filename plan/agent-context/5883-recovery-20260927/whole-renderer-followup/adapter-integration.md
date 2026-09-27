# R adapter integration: source checkpoint, not acceptance

## Measured follow-up

Parent session72881 terminated exit0: six files, **83/83 passed** on first run
(55 adapter, 8 original constructor, 4 delegation, 4 real constructor cleanup,
6 fresh-match controls, 6 real-shift controls). JSON SHA256
`8bf579605ecc317033f39187de6b70c4d5bd96377d75beefc0fd18eacc98cc58`,
at `.tmp/R-adapter-baseline-B-first.json`; full log remains adjacent.

Source plus these six files typecheck first failed (session46802 exit1) only
because the newly authored shift test passed unsupported `target: "gc"` to
CodegenOptions. Retained the first diagnostic log, SHA256
`de1116371ff6d3920ae387d6aaaaee9cb55267f3cdaa4b6a608dc9b8f2adfe5a`.
Replaced that ignored option with supported explicit `standalone: false,
wasi: false`, keeping native strings and the host-assisted assertion. No
production source, original fixture, test expectation or acceptance gate changed.
Typecheck after correction: session9688 exit0. The six affected shift cases
reran unchanged otherwise: session37451 exit0, **6/6 pass**, report SHA256
`ae20eb7a722fd92c68f0087f16b964aa5b14b24f87b5318ad005c96fe7828ae1`.
Current shift-test SHA256
`2a4f1e5c1bf224f44e92a0be5d39e674d34b188aa0d5bae7a4c6c452a5c66166`.

Huygens returned the compiler slot after both original176 runs and completeness
checks. Main154/176, candidate38/176; 129 losses and13 gains remain. Parent owns
the slot while publishing those complete receipts to existing held PR5753.
Earlier source-only/unrun notes below describe the chronological checkpoint;
this section supersedes those statuses only for the explicitly measured suites.
Whole-renderer A/B/C correspondence and unchanged136 are still unrun here.

2026-09-27. Owned integration tree: `/private/tmp/js2-5883-main-6eac-20260927`.
The source below is integrated locally and not yet published or tested together.
The whole-renderer route is NOT activated by this checkpoint.

## Baseline B source integration (still untested)

Parent and Hume reviewed and approved Curie's exact captured-only fresh-match
delta, then applied it locally. Before applying, saved exact original A files
under `.tmp/R-three-arm-A/`; their SHA256 values remain drive
`4533f252a35fbebaa4feb9582d29cdd84a289040b33cd179dda64a5b6ab011f7`
and observable
`cd9f65ea77c9418874bdd69f9666e27c25259ed93f35656b41f2ad3357afa8ac`.
Current B source matches the reviewed patch: drive
`3947caa71cd1596971f8f1854d172f58f4a4300be012077413e123f4a843b6a2`,
observable
`df689ab42016063cff886421d406fcd92f88661c5d15d7fda001c0784fcfe87b`.
Six additive structural cases (0/1/3 roots, all/race) are UNRUN. Legacy default
callers and shared classifier remain unchanged. Original fixtures and receipts
are intact. B/C co-integration is requested from Curie; do not claim B/C equality.

## Exact integrated source

- Corrected `staging-bindings.ts`: SHA256
  `a956217f8a9910919137a211362262b8e94f7f22ef58b04227217204c269bc08`.
- Adapter tests: SHA256
  `d7748545dcaa262fc93f9c673cbe050917e795dcfd214334a9e45212cbc4d676`.
  Original 38 cases unchanged; 17 additive controls, total 55 UNRUN here.
- Constructor region helper: SHA256
  `99253578d5687537bce6f82ed644f2a9fcb90ff6d3b4c314218dfae78f5aa2ef`.
  Byte-identical to Mendel's reviewed after-snapshot; existing immediate builder
  remains the single constructor implementation.
- Constructor delegation tests: SHA256
  `40eafc6549c61098050a07636056881010a8c2c732c93d3adca2dd66a5d41bde`.
- Real-adapter constructor failure controls: SHA256
  `cac2dd6a8dcc85fac3d927407f0d204050157b322b51f24a36def6e1dc92d647`.
  Four UNRUN cases: borrowed/unborrowed seed error, invalid-local finish error,
  and lost-root finish error. Assert original error identity and actual cleanup.

The four adapter review findings are corrected and source-reviewed: structured
operand snapshots, NaN/signed-zero equality, descendant revocation, and cursor
restoration after empty-stack abort. First-version 38/38 and its typecheck pass
are preserved evidence for the ORIGINAL source, not these corrections.

Registered the new adapter as explicitly unmigrated mixed-layer debt in the
boundary inventory. No graph-completeness, provider-readiness or retirement
claim. Diff whitespace passes and boundary JSON parses; full gates remain due.

## Independent acceptance pair owns the compiler slot

Huygens owns the exclusive slot for main4418 versus candidatea10b, exact original
176 Test262 paths at corpus b363f29. Its detached checkouts are separate and
untouched by this integration. Parent observed main Vitest PIDs16050/16054 live;
no restart or cancellation. Require terminal reports and explicit slot return
before local compiler/tests/builds, commit hooks or push hooks.

## Next actions and remaining holds

1. Run the 55 adapter cases, existing eight immediate-constructor cases, four
   delegation cases and four real-adapter cases; preserve first results/errors.
   Scoped source/test typecheck and boundary/size checks follow.
2. Review Curie's v2 removal of the new extraction-only ABI rejection. Preserve
   historical call operands; move diagnostic evidence to the observer rather
   than changing supported-source admission or failure outcomes.
3. Review the separately proposed captured-only baseline repair for two shared
   callability-match leaves. A stays original; B is original plus only that
   narrow repair; C is the whole renderer. Preserve A failures/fixtures and the
   original identity-sensitive observer. Require exact B/C correspondence;
   no normalization, dropped rows or blanket alias waiver.
4. Real import/shift controls, constructor correspondence, six-route snapshots
   and the unchanged 136-case runtime suite remain due before acceptance.
5. Publish source/evidence through the existing held recovery PR5883 once the
   compiler slot permits verification and normal hooks. This local checkpoint
   does not claim source landed on main.

PR5753 remains held pending fresh acceptance results. The old compiler remains
until the new IR path is fully implemented and equivalent.
