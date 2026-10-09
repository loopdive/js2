# Session A IR coordination handoff — 2026-10-07

The goal is complete IR coverage, verified native behavior and artifacts, with generic semantics and analyses separated from backend representation. Legacy remains until full tested equality. Current local results do not establish parity, retirement readiness or performance improvement.

## Where Session B can find this handoff

Documentation branch: `codex/ir-session-a-coordination-20261007` on [ttraenkler/js2](https://github.com/ttraenkler/js2). Document: `plan/log/ir-coordination-session-a.md`. **Authoring snapshot:** at the time this prose was written, the checkpoint was prepared for review and its immutable publication commit and PR were pending. After push, use the actual published commit/link supplied with the handoff; this sentence records the authoring state, not a continuing claim of remote absence. A branch name alone does not mean it has been pushed. Publication must be confirmed with the actual commit/link after normal signed hooks and root review.

The documentation branch starts at canonical main `e7760d1c2af4636ede6a352154d193b234af5fc4`. Session A's active integration branch is `codex/6865-delivered-public-maps-20261007`, HEAD `fab22c35ff9bc7dc8cfbdacd2ef86993d8a090d8`, in `/private/tmp/js2-ir-public-source-map-20261007`. Its 45 prepared paths below are mixed staged, unstaged and untracked, **uncommitted and unpushed**. Canonical main is newer than that test epoch; no main refresh or equivalence is inferred.

Read the [coordination issue and approved plan](../issues/6889-ir-session-a-coordination-and-architecture.md), [architecture contract](../../docs/architecture/target-architecture.md), [full IR coverage goal](../goals/ir-full-coverage.md) and [backend independence goal](../goals/backend-agnostic-ir.md). “IR source maps: complete unmapped interval recording and safe VLQ rendering” (#6865) is a local unpublished issue at directory `plan/issues/`, filename `6865-ir-unmapped-source-map-emission.md`; this document deliberately supplies its facts without a broken remote link.

## Delivery and publication boundaries

- **Delivered on main:** [PR #6554](https://github.com/loopdive/js2/pull/6554), the bounded remainder/whole-program stage-1 checkpoint. Published head `815a5f0df5c0090365c06f6ead3173f19c1d6590`, tree `77ad8f59320babc3a9e795748e718263bf04cc28`; protected merge group `4df421d262239c5b5379382754f2f1d777e30225` on base `e24d1117050c87ba8d7d73cc95249e99601e98e9`, verified in main ancestry. This is not full IR completion.
- **Published, separate work:** the recorded open-PR snapshot includes [#5942, independent pipeline strategy spike (experimental HOLD)](https://github.com/loopdive/js2/pull/5942), head `eae9ca7498ec1ae0c6d92125a12e5e17c1d5237c`, and [#5883, observable intrinsic combinator protocol](https://github.com/loopdive/js2/pull/5883), head `b9bb743c0b3cbc0370807b2f85a9a6bff4d21b33`. Refresh their actual state and file/function overlap before writing; this snapshot does not transfer ownership.
- **Frozen local:** the coherent source capture/lowering packet qualified 51 cases at `fab22c35ff`; its exact source pins appear below. Qualification is local, not source publication.
- **Active local:** public source-map repairs, GC attribution and Linear telemetry. No source-map feature PR exists at this checkpoint. This documentation branch publishes coordination only.

The complete paginated open-PR/file snapshot recorded on 2026-10-07 additionally identifies concrete shared-file overlaps. These are observed heads, not current merge state, ownership transfers or permissions to edit:

| PR | Observed head | Shared paths |
| --- | --- | --- |
| [#6468: feat(deno): checkpoint Context-owned Script lexical cells](https://github.com/loopdive/js2/pull/6468) | `b19e6d6b1dd98f82f847b52b1474a6e7804aeef6` | `src/codegen/index.ts`, `src/compiler.ts`, `src/index.ts`, `src/ir/integration.ts` |
| [#5784: feat(deno): checkpoint native Deno core integration and handoff](https://github.com/loopdive/js2/pull/5784) | `5aa3d8f85743bbedad1c6872b9dfd1918f97dacd` | `src/codegen/index.ts`, `src/compiler.ts`, `src/index.ts` |
| [#5753: feat(typescript): advance standalone compiler coverage with IR closure support](https://github.com/loopdive/js2/pull/5753) | `11b39957841119c75b9703b8bad0cdcecf80f226` | `src/codegen/index.ts`, `src/codegen/peephole.ts`, `src/ir/integration.ts` |
| [#5748: fix(compiler): preserve JavaScript behavior and diagnose unsupported flows](https://github.com/loopdive/js2/pull/5748) | `95bbf08f924e7b76548586cbe70f99ee99254917` | `src/codegen/index.ts`, `src/compiler.ts` |

## Active responsibilities and collision checks

Canonical upstream assignment snapshot `3bfd8f46a42cf9d2a4f9257d968b798d8e58552f` records these eight current-day slices as `in-progress`. The literal “delivered” in a branch/slice name is not a delivery assertion. Earlier source-map packets used canonical `20297ba9ae3537b5bd36f618d77205265f5220ad`; capture/lowering composition, GC attribution and current public measurement use `fab22c35ff`. Root retains the integration HEAD above. Claims identify responsibility, not necessarily a pushed branch HEAD.

| Canonical slice | Owner | Branch | Concrete scope / next action |
| --- | --- | --- | --- |
| `3525:native-source-closure-measurement-20261007` | `ttraenkler/codex-ir-source-closure-20261007` | `codex/3525-native-source-closure-20261007` | Execution only: `tests/issue-3518-native-source-closure-consumer.test.ts`; real native/replay/source-free receipts. No production repair. |
| `6865:delivered-public-map-integration-20261007` | `ttraenkler/codex-ir-public-map-integration-20261007` | `codex/6865-delivered-public-maps-20261007` | Root integration: `src/compiler.ts` (`finalizePipelineModule`), `src/codegen/index.ts` finalization seams, contexts, GC/Linear integration, physical emitters and prepared proof inputs. Sole composition/publication owner. |
| `6865:discarded-for-clause-semantics-20261007` | `ttraenkler/codex-ir-for-clause-semantics-20261007` | `codex/6865-for-clause-semantics-20261007` | `src/ir/select.ts`: `isPhase1DiscardedForClauseExpr`; `src/ir/from-ast.ts`: `lowerDiscardedForClause`, `lowerDiscardedExpression`. Preserve evaluation order/effects; console initializer remains red. |
| `6865:for-head-stage-capture-20261007` | `ttraenkler/codex-ir-for-head-capture-20261007` | `codex/6865-for-head-capture-20261007` | `src/ir/program-source.ts`: `createSourceMapProjector`, `currentSnapshot`, `normalizationZero`, `projectForHead`; `src/position-map.ts` immutable source/stage captures. Coordinate overlapping capture functions with normalization scope. |
| `6865:gc-final-body-attribution-20261007` | `ttraenkler/codex-ir-gc-final-body-attribution-20261007` | `codex/6865-gc-final-body-attribution-20261007` | New passive `tests/issue-6865-gc-final-body-attribution.test.ts` only, in its isolated worktree. REAL context/dead-layout/repair/peephole observations; no production changes. Later transition not yet attributed. |
| `6865:linear-final-publication-20261007` | `ttraenkler/codex-ir-linear-finalizer-20261007` | `codex/6865-linear-finalizer-20261007` | `src/codegen-linear/index.ts`: private module-keyed owner/finalizer, `getLinearSourceMapFinalizer`; new public-finalization controls. Shared compiler finalization belongs to root. |
| `6865:linear-public-emission-telemetry-20261007` | `ttraenkler/codex-ir-linear-public-telemetry-20261007` | `codex/6865-linear-public-emission-telemetry-20261007` | `src/codegen-linear/index.ts`: `getLinearIrCompiledFuncs` and private per-module receipt; `src/compiler.ts`: result wiring; `src/index.ts`: field documentation; new telemetry test. This scope does not edit `src/ir/backend/linear-integration.ts`. Current public L lacks counts in the recorded public38 epoch; later telemetry measurements do not substitute for that full public population. |
| `6865:normalization-source-scopes-20261007` | `ttraenkler/codex-ir-normalization-source-scopes-20261007` | `codex/6865-normalization-source-scopes-20261007` | `src/shared/contracts/ir-unit-inventory.ts`, `src/ir/program-source.ts`, `src/ir/program/validation.ts`, `src/ir/program/source-map-position.ts`, new source-scopes test. Closed type-only origin/projection, genuine captured AST authority, detached DATA validation/reader. Required from-AST consumer belongs to discarded-clause writer. |

Observed local branch HEADs (working deltas are not included in these commits):

| Branch | Local HEAD |
| --- | --- |
| `codex/6865-for-clause-semantics-20261007` | `fab22c35ff9bc7dc8cfbdacd2ef86993d8a090d8` |
| `codex/6865-for-head-capture-20261007` | `20297ba9ae3537b5bd36f618d77205265f5220ad` |
| `codex/6865-gc-final-body-attribution-20261007` | `fab22c35ff9bc7dc8cfbdacd2ef86993d8a090d8` |
| `codex/6865-linear-finalizer-20261007` | `20297ba9ae3537b5bd36f618d77205265f5220ad` |
| `codex/6865-linear-public-emission-telemetry-20261007` | `fab22c35ff9bc7dc8cfbdacd2ef86993d8a090d8` |
| `codex/3525-native-source-closure-20261007` | `20297ba9ae3537b5bd36f618d77205265f5220ad` |
| `codex/6865-normalization-source-scopes-20261007` | `fab22c35ff9bc7dc8cfbdacd2ef86993d8a090d8` |
| `codex/6865-delivered-public-maps-20261007` | `fab22c35ff9bc7dc8cfbdacd2ef86993d8a090d8` |

All shared `src/compiler.ts`, GC/Linear entry points, context types, proof metadata and current prepared paths remain with Session A/root until explicit file **and function** agreement. In particular, stage capture and normalization both concern `program-source.ts`; stage-origin projection is not permission to change semantics or owner grants. Detached readers must retain source-free DATA checks; callbacks or caller certificates cannot replace captured authority.

The same snapshot contains eight older held claims, also `in-progress`, rather than silently completed or released:

| Older slice (issue 6865) | Owner | Branch |
| --- | --- | --- |
| `allocation-owner-source-position-20261006` | `ttraenkler/codex-ir-source-map-allocation-owner-20261006` | `codex/6865-public-emitter-substrate-20261006` |
| `linear-numeric-module-binding-20261006` | `ttraenkler/codex-ir-linear-numeric-module-binding-20261006` | `codex/6865-source-position-lowering-20261006` |
| `linear-source-map-batch-20261006` | `ttraenkler/codex-ir-source-map-linear-batch-20261006` | `codex/6865-source-position-lowering-20261006` |
| `public-emitter-substrate-20261006` | `ttraenkler/codex-ir-source-map-emitter-20261006` | `codex/6865-public-emitter-substrate-20261006` |
| `public-source-handoff-20261006` | `ttraenkler/codex-ir-source-map-handoff-20261006` | `codex/6865-public-source-handoff-20261006` |
| `public-source-map-composition-20261006` | `ttraenkler/codex-ir-source-map-composition-20261006` | `codex/6865-public-source-map-integration-20261006` |
| `public-source-map-proof-20261006` | `ttraenkler/codex-ir-source-map-public-proof-20261006` | `codex/6865-public-source-map-proof-20261006` |
| `source-position-lowering-20261006` | `ttraenkler/codex-ir-source-map-lowering-20261006` | `codex/6865-source-position-lowering-20261006` |

Thus the verified bundle records **16** in-progress `codex-ir` scopes, plus coordination issue **6889**, owner `ttraenkler/codex-ir-session-a-20261007`. Use `CLAIM_ASSIGN_REMOTE=upstream` for the canonical claim workflow, reread the actual ledger before acquiring scope, and compare changed paths and function seams with the integration owner. Do not infer availability from local worktree names or a failed network read.

Foreign observed slice `6888:linear-plan-20261007` has owner `ttraenkler/codex-linear-b-astra-plan-20261007`, branch `codex/6888-linear-spec-20261007`, status `in-progress`; bare `6888` is separately reserved. Root observed no matching upstream/fork ref at its checkpoint. This proves neither identity with Session B nor abandonment. No cross-session scope agreement has been made. Session B should identify its actual branch/head and proposed files/functions, then obtain explicit partition agreement before touching shared integration or prepared inputs.

## Actual measurements and remaining failures

These are separate populations and epochs; do not add their pass counts into a current whole-suite claim. Full case identities, raw channels, diagnostic IPC and input custody are retained locally; `.tmp` paths are **not remotely available**.

| Population / epoch | Actual result | Evidence / next boundary |
| --- | --- | --- |
| Source scopes 41 + context DATA 10, coherent `fab22c35ff` | **51/51**, zero skipped/pending; strict project and test-inclusive TS7, lint and format passed | Receipt SHA256 `b5e4ca80045e520cc9a0ddab3c6a28e1778df35c8f664db1feaa4993af6a28d8`. Genuine raw capture has normalization origins; ordinary DCE removes them in the final program. Native child returns 7/1, with 878 modules, zero TS/frontend loads and codec equality. This does not credit an eliminated-origin child branch. |
| Unchanged public for-head source-map capture 38, coherent `fab22c35ff` | **34 pass / 4 fail**, zero skipped/pending, exit 1 | Receipt SHA256 `63ec28ae206e4679dff959ce33a5333cbb2f75747bb39e49366f4bc697ce740c`. Four positive requirements remain below. |
| GC final-body attribution 2, `fab22c35ff`, isolated diagnostic | **1 pass / 1 fail**, zero skipped/pending, exit 1 | Receipt SHA256 `58ce2d4e72cb3b4e33da8094a1444d0d2dfc3f448f981d52b02db3cd300b336c`. New test SHA256 `198cb7aad98db573a6638f73e5d3d0064625abb0e1296a5e826da2d951e7a119`, not part of root's 45. Real dead-layout, struct repair and peephole finalizers all healthy before/after; owner count 1, identity/slot/DATA unchanged; peephole removal count 0. Native no-map 7/1 passed. Failure occurs later; no production repair attributed yet. |
| Pure discarded-clause semantics 27, earlier `20297ba9` packet | **26 pass / 1 fail** | Linear `console.log` initializer remains a positive failure. Original 77 clause regressions passed separately. This is not a final coherent-epoch rerun. |
| Earlier retained leaf populations, `20297ba9` | Native closure 5/5; Linear finalizer 17/17; numeric 37 + batch 23 + GC binding 15 = 75/75; original public 48/48 | Historical bounded evidence only. Original retained 60-case red result 57/3 remains preserved. No new final-epoch aggregate credit. |

The four current public failures are: **GC L** loses final installed function/body association after genuine owner emission (IR owner 1, direct 0); **Linear L** reaches core/presentation but lacks public emission counts; **GC A** still uses direct fallback; **Linear A** still refuses the mapped route. These original requirements and names stay positive tests. Neither unsupported-refusal expectations nor altered fixtures can stand in for native/artifact success.

A later-GC passive diagnostic scope is planned/unpublished, with only a new test and observer helper; its new claim/packet is not included in this snapshot. Next GC work requires a finite approved extension to observe the later real finalization seams; the first three observed passes and peephole are ruled out for the exact L fixture. Next Linear work must bind actual per-module emission reporting to public result construction without refreshing owner snapshots from mutants. Source/donor/span indexing should use immutable source text and explicit captured joins; static complexity reasoning is not measured performance. Broader A coverage and console effects remain open.

## Prepared input custody (local checkpoint, not a commit)

Verified-input bundle SHA256 `b21e63a608c1c03abea7e080cecb8b3eb54a88d59613477eed6a30a014ef829f` records the 45 root working files and claim snapshot. The local issue 6865 subsequently gained the approved indexing plan; only its issue-file pin changed, so the table below rereads that file. Source/test pins remain those verified inputs. It records working bytes, not index bytes or a published tree.

| Root-relative path | UTF-8 bytes | SHA256 |
| --- | ---: | --- |
| `src/codegen-linear/index.ts` | 235029 | `7d582e80ddc7f49474ce1bbeffe3c6545da9b3a1867056fd18e57335663de48f` |
| `src/codegen/context/create-context.ts` | 29603 | `cdc4a5a7d2a7b7d75847117c7dc34d66ad54d65c0dfdd2c06d239423731fc69c` |
| `src/codegen/context/types.ts` | 275227 | `35b0bd0bcbd7bf73f654e753a9a003d0a692a9c681dd3806c360e367ada45369` |
| `src/codegen/index.ts` | 774591 | `7b5c13fe4ed8d234ff55f61f0b969f20ed912e72e313830d963fa39b0003ebff` |
| `src/codegen/ir-inline.ts` | 65772 | `deec5ad3b8ae17d6269f775050ecbb4794b8b40b13f322c197e21c804ddeb1b0` |
| `src/compiler.ts` | 111309 | `cea2bbfb78fa5368da7a8826f439660d30b109a22018f6abbb68242c2d1868a9` |
| `src/emit/binary.ts` | 72498 | `ebb6426cce4ebf44bdbad43c65510e11014d904f9c94a16ee679c941831917f5` |
| `src/emit/sourcemap.ts` | 9070 | `44b6abbf959eb7062ce67acd95624641af4821f8ff0e5c6db06acc89b69c288b` |
| `src/ir/backend/emitter.ts` | 24265 | `33c32ffc5873bdb5fd0c85a62dbaea66b96862f2274377933b3c3997da04d06b` |
| `src/ir/backend/frozen-body-consumer.ts` | 13269 | `2c88f71da7b6ec14e07c60fd0b2cc33a871a39e3ec738e29fad6600b498f94f0` |
| `src/ir/backend/linear-emitter.ts` | 23702 | `02621ed234d1fd473554596efb874523f40afbed2d2785fbeb211ddf1068f622` |
| `src/ir/backend/linear-integration.ts` | 113493 | `1a0b4f26b0f10d20af2cf06b91f5cb4df628bdd0ffbf299610cf939b288dc8de` |
| `src/ir/backend/lower-contracts.ts` | 15171 | `ceab1dc1030d3e5ffca8aa0663bc2a97cb25ca7bf2eb4d01de21b2a4f2f84492` |
| `src/ir/backend/wasm-lowering.ts` | 3356 | `cedf1a3a1bea10820f92cd52b07af7bd1fd378d8463b5d780f9e41a29422fd42` |
| `src/ir/backend/wasmgc-emitter.ts` | 23889 | `f44c7fc343ef5c6a323ecdc456f10fc151b01858d3b4b7892106764b61ea1b48` |
| `src/ir/from-ast.ts` | 798452 | `7fb8f9c832495453bf5e983916dc85ca4846e059ecfabd2027dbaac9e7cf8983` |
| `src/ir/frozen-body-batch.ts` | 28152 | `703a43955af122201408c6609086d8f953c669588b31c8d70cc81ac670da87fb` |
| `src/ir/integration.ts` | 477661 | `3b1cf867dfbde18f71e48b2a920870195767628d8656f3bd143d3c1ad6d3b62a` |
| `src/ir/lower-generic.ts` | 210047 | `18b55699ba63be213937a6c3fc451407e0c27ec3c7f042289ffbf13d1704ba9e` |
| `src/ir/program-source.ts` | 102272 | `6473d022d91230c74481b039c84b2cc729a1d0be29661a3e8b242b6877793d05` |
| `src/ir/program/source-map-position.ts` | 21452 | `35b96764471082ad90fdbcbd954107a00ba75ca9535952113202dda09f8dc7d3` |
| `src/ir/program/validation.ts` | 51034 | `cfe3a9f57c308409c94f6d583c14775f8677817dbf7f57b35775a202fa2815e6` |
| `src/ir/select.ts` | 530901 | `6d1de8411f5869a596ea00da18851b3df80efeb6b2faf58cabc4cbbc6c96635d` |
| `src/position-map.ts` | 8676 | `313f3762e8419253660cd7064ddc058f03b197eeff7015f74fe9540d42a730ca` |
| `src/shared/contracts/ir-unit-inventory.ts` | 9295 | `41c221f862172c03240785cdc08e87b229d9bd446be1f975c54b8d48addbbe4a` |
| `src/wasm/model/instructions.ts` | 15142 | `7d9e1184f1c3db9461989a370ed6a53ce109a58dbe7eef870c6bebe4e2f5c62e` |
| `src/wasm/physical/allocation-owner.ts` | 9612 | `8e1b335b7f15a70be289bcdf19ecd23fcbdd64d050e2cdd11c1b77c7300d5c7a` |
| `tests/ir-backend-emitter.test.ts` | 12950 | `28c0a191a8475a3e2e11b74cd57722c4ab82f9b54f211e78b32dab0a4728ba53` |
| `tests/sourcemap.test.ts` | 11427 | `4ea0334f18834f05a801aa79803f8caa66f530c469a74c5db685545f52d3afab` |
| directory `plan/issues/`, filename `6865-ir-unmapped-source-map-emission.md` | 362032 | `39a847a9d39ba8be2a732f8a1491c4868e564679dcb114045276121f4e306a5b` |
| `tests/issue-6865-allocation-owner-source-position.test.ts` | 12333 | `02e06817cdb96e3e834c1a8d5ed565e0e1c5e3ae1a131348017f5c844d2ae088` |
| `tests/issue-6865-for-clause-effects.test.ts` | 10817 | `4e47f885a8e21cb935e8bafbc1dddaf17e34d62e6d911ed67107f1f60ea049ba` |
| `tests/issue-6865-for-head-context-data.test.ts` | 8414 | `d943a4dae596ada1cad858df9b6a18c1702edbf2edae376c0935075e44441d54` |
| `tests/issue-6865-for-head-source-map-capture.test.ts` | 23352 | `45b1347aae6a79058d80d8f6cf899ed35f5e5ad1f1aff31ef124bae1faa777d5` |
| `tests/issue-6865-for-head-source-scopes.test.ts` | 28021 | `db33aa50748afa7a9f75066dd47f64125ba3d502960ad86c047f5749fce9dbaf` |
| `tests/issue-6865-inline-source-position.test.ts` | 2358 | `d3cdc7723f007620e33e997132534d52684fcd0d42adbfbaf46c643c979b1210` |
| `tests/issue-6865-linear-numeric-module-binding.test.ts` | 14586 | `b085bdb5a6dfc885aa88ca53e52bb04f87911c900add59e91e51e3826cade0ec` |
| `tests/issue-6865-linear-source-map-batch.test.ts` | 24411 | `357cf04dbae7d781aaf45ad0e7b1ad9c9f3ce47fdf6c67992456d40742f33c14` |
| `tests/issue-6865-public-linear-source-map-finalization.test.ts` | 11459 | `9f188dc2b384bd02fffe01091fbc784ec003e53abc6400924453bf3fb855fd49` |
| `tests/issue-6865-public-source-handoff.test.ts` | 18372 | `23d309016f2821affb2d2209f3b4ff2c71f8e96c444bbceb68e61631097eca4e` |
| `tests/issue-6865-public-source-map-binding.test.ts` | 11859 | `5af410b72db22c9e9c83d6cd7e4df15ae623dfd5b491b0d4e47bb6ae439e0b66` |
| `tests/issue-6865-public-source-map-producer.test.ts` | 14965 | `d14ea60ee1ef6c90d89afce4d6bb8440a66852ae06eb807248a9f02bff596cfd` |
| `tests/issue-6865-source-position-emitter.test.ts` | 13298 | `80ec4844f84f6a5f90e3e2232b9415b84d46779116dbcca67b54c5a1f360260a` |
| `tests/issue-6865-source-position-lowering.test.ts` | 23461 | `37e718f121e884a6fa88aef1086de17a899f2103d4ff70e4ee31da39cfb25388` |
| `tests/issue-6865-unmapped-source-map-emission.test.ts` | 23945 | `90c5bd314ed1b97b9bc15e5cac3981ed0342a03225ee392c63cb7fc3c86ea2d4` |

Before future qualification or publication, freeze the actual composed source/test/config/toolchain epoch again, compare native results and artifacts under both supported targets, and preserve original failures and restored custody. Session A root alone installs peer packets and publishes compiler changes. This handoff authorizes no source refresh, mass rename, proof reseal, new target implementation or legacy retirement.


## Session A source handoff — 2026-10-09

This append preserves the earlier Session A handoff. The tested **SOURCE_HEAD** is `d413734a7d189c6d3eb6d93403a32fbee0a93e21`, on `codex/6920-allocation-evidence-checker-20261009` in fork `ttraenkler/js2`; its canonical donor base is `8452732f0b88c14c5c7634ece58f83240970ea4c`. Signed source checkpoint `b1a60eab2158dafa62af87dd39db808c8b2ba0f2` and signed site-reuse follow-up `d413734a7d189c6d3eb6d93403a32fbee0a93e21` were published through normal hooks, and actual remote readback matched. [PR 6599, “feat(ir): verify allocation evidence with preserved provenance”](https://github.com/loopdive/js2/pull/6599) is ready and on HOLD for independent review and the annotation guard described below. It has not delivered this source to main.

This handoff and the issue publication append are metadata only. Their later signed publication commit necessarily has a different head; confirm that metadata head through the actual fork/PR record and root publication readback. Do not call that later hash the tested source epoch, infer a circular self-HEAD from this text, or credit hook execution as whole-program equivalence. The source, test, fixture, policy and proof bytes from SOURCE_HEAD remain frozen during this documentation task.

### Live assignments and exact boundaries

The canonical assignment registry was effect-read before this append. All rows below are in progress on the checker branch; neither this document nor publication transfers or releases a claim.

| Slice | Owner | Actual write ID |
| --- | --- | --- |
| `6920:session-a-source-handoff-20261009` | `ttraenkler/codex-sol-session-a-source-handoff-20261009` | `89995-6v69lqr6` |
| `6920:allocation-evidence-checker-20261009` | `ttraenkler/codex-sol-allocation-evidence-checker-20261009` | `19199-2n2yketq` |
| `6920:allocation-provenance-context-20261009` | `ttraenkler/codex-sol-allocation-provenance-context-20261009` | `37849-iyihfm2v` |
| `6920:allocation-provenance-preservation-20261009` | `ttraenkler/codex-sol-provenance-preservation-20261009` | `47027-8ym7mzqp` |
| `6920:allocation-evidence-boundaries-20261009` | `ttraenkler/codex-ir-evidence-boundaries-20261009` | `41777-d2f5erfl` |
| `6920:allocation-evidence-tests-20261009` | `ttraenkler/codex-sol-allocation-evidence-tests-20261009` | `24554-og1ofvb0` |
| `6920:allocation-provenance-tests-20261009` | `ttraenkler/codex-sol-allocation-provenance-tests-20261009` | `40461-imkn9xrm` |
| `6920:allocation-provenance-preservation-tests-20261009` | `ttraenkler/codex-sol-provenance-preservation-tests-20261009` | `50964-2glprsoz` |
| `6920:allocation-evidence-site-reuse-tests-20261009` | `ttraenkler/codex-sol-allocation-evidence-site-reuse-tests-20261009` | `71072-eptamrwm` |

- Checker source19199 owns `src/ir/analysis/allocation-evidence/{contracts,effect-rules,census,metadata,verify}.ts`: closed report/namespace/census types; `allocationEvidenceEffect` and finite function/instruction/operand screening; `captureAllocationEvidenceCensus` including lexical/occurrence/root checks; `indexRegistryEvidence`/`compareRegistryEvidence`; actual `verifyAllocationEvidence(IrModule, AllocRegistrySnapshot)`. It does not own canonical validation, native admission, geometry, allocator or solver changes.
- J1 source37849 owns only structural `AllocProvenanceLookup` in `src/ir/analysis/contracts/allocations.ts`, four parameter/import-type edits in `src/ir/analysis/alloc-verification.ts`, new `src/ir/program/allocation-body-validation.ts::assertPreparedIrFunctionAllocationTypesAndStates`, and its actual post-`analyze(fn)` call in `src/ir/program/allocations.ts::assertPreparedIrProgramAllocations`. Existing provenance algorithms, analyses, order, messages and error identity are retained; this is not a no-analysis consumer join.
- Policy41777 owns the six-module inventory registration hunk in `scripts/compiler-boundaries.json`. Source proof47027 owns new `tests/helpers/ir-allocation-provenance-lookup-successor.{ts,json}` and only the named-import/filesystem-read transport in `tests/helpers/ir-validation-analysis-relocation.ts`. The successor authenticates four complete current files, three exact845 preimages and reciprocal four-file replay; six explicit reader dependencies include the unchanged old Phase-B JSON. Original 135 transfers and assertions remain unchanged.
- Test24554 owns `tests/issue-6920-allocation-evidence.test.ts` and authentic `tests/fixtures/issue-6920-allocation-evidence-core.v8`; test40461 owns `tests/issue-6920-allocation-provenance-lookup.test.ts`; test50964 owns `tests/issue-6920-allocation-provenance-preservation.test.ts`; test71072 owns `tests/issue-6920-allocation-evidence-site-reuse.test.ts`. These are separate 22, eight, sixteen and five-control denominators, not substitutes for the deferred original cases.
- The metadata claim89995 owns only this append and the issue6920 publication append. Root owns integration, further source release, PR/HOLD review and protected queue actions.

C's independently effect-read claim `6920:c-shared-linear-geometry-source-20261009`, owner `ttraenkler/claude-session-c-geometry-20261009`, write `4237-ijwd2prx`, is in progress on `claude/6920-shared-linear-geometry-c`. Exactly four geometry paths/hunks belong to C: new `src/shared/contracts/linear-memory-layout.ts`; geometry declaration/import/identity reexports in `src/ir/analysis/contracts/linear-memory-layout.ts`; agreed geometry constants/helpers/adapters/compatibility imports and reexports in `src/ir/analysis/linear-memory-plan.ts`; `tests/issue-6865-linear-layout-contract.test.ts`. C excludes allocation analysis/facts/policy/verifier bodies, A2 hunks, boundary inventory, historical proof/readers, registry, public integration and queue. No whole-file replacement of shared memory-plan is authorized. A's old `6920:shared-linear-geometry-20261009` claim, owner `ttraenkler/codex-ir-shared-linear-geometry-20261009`, is actually released under `60707-95hx19zl` at `2026-10-09T00:45:41Z`; its local packet remains preserved. B branches/provider/runtime work and every foreign claim remain untouched. A2 claims16740/46615 and its fifteen-file private proposal were not transferred into this checker lane.

### Executed evidence, failures and dependencies

Standalone leaf22/22 passed. J1 canonical845/candidate extraction controls passed8/8 each, followed by candidate leaf22/22 regression with17,387 frozen operands unchanged. The later preservation window passed326/326: sixteen new controls plus canonical/candidate historical relocation116/116 each and verifier39/39 each, exact paired occurrence/status/error rows and17,391 unchanged operands. Reuse correction passed new5/5 plus original22/22 with9,051 unchanged operands, genuine contextual and full legacy allocation-contract positives, and independent malformed/per-site metadata controls. Those positives establish function/allocation-contract validity, not complete prepared population/ABI/support/projection equality or native admission.

Both signed source commits passed full normal commit hooks. The first checkpoint's signing attempt failed to unlock the SSH key after passing hooks; the authorized existing agent resolved signing without loading keys or bypassing hooks. The first fork push used ambient Node24.4.1: numeric-local parity13/18 passed, five WebAssembly exception-reference failures, and no remote branch was created. All failures remain recorded. Explicit Node25.9 preflights for both `node` and `pnpm exec node` then preceded a full normal push: parity18/18, typing/lint, changed-file formatting, oracle/coercion ratchets and issue integrity passed. No force/skip/HUSKY bypass was used.

Selected TS7 no-emit, formatting/lint, source/function budgets, layering, cycle and boundary inventory checks passed. Complete boundary checks still fail with the same canonical845 unknown-boundary debt; godfile checks have the byte-identical canonical845 48-failure diagnostic. No architecture-complete or full-CI-green claim follows. Retained raw qualification receipts are cited in [issue6920, “Native Linear numeric-vector shared source handoff and integration plan”](../issues/6920-native-linear-shared-source-handoff.md); the old111,545-byte published issue prefix and historical receipts remain preserved.

Dependency [PR 6597, “fix(ir): inspect recursive class cells without invoking getters”](https://github.com/loopdive/js2/pull/6597), exact head `bec8ac003452a63e9a3fa6f8ff57d5f83e69a4af`, first entered the protected queue. It is now merged at `2026-10-09T01:21:16Z`; root verified main `d2beec5ce7952d1271ce6188422eb8a533845656`, exact-head ancestry (ahead1/behind0, merge base equal to that head), and equality of all three delivered DATA/test/issue blobs. The protected group had102 actual successful shards and a real regression gate with0 regressions across48,735 tests; its cached base `088046348f71f3fc7a2301dbcff6444fe2967bbc` was distance1, not exact845. Required quality and equivalence/diff checks succeeded. Overall CI was cancelled after merge and eight nonrequired issue shards were cancelled: do not call the full run green or claim a fresh main14-test execution. This DATA dependency delivery does not deliver PR6599 or refresh the checker branch's historical base.

### Remaining release gates

Astra's independent exact-d413 architecture/source/proof review found that an extra allocation annotation on a primitive constant can fall outside the finite profile yet be misclassified or falsely verified by this unjoined leaf. PR6599 remains HOLD pending an exact root-adopted guard and genuine canonical regressions. This documentation worker has no source release. Preserve original invalid/not-covered errors and strict target facts while the next plan is reviewed.

J2/J3 composition, actual descriptor/contextual SSA/type/provenance/support/codec joins, shared effect rules, the deferred eighteen ROOT cases/full forty matrix, general allocation witness, allocating support, native resources and public standalone/WASI behavior remain unfinished. Required-native behavior and ordinary generic fallback must be integrated at real callers. Legacy remains until full equality and retirement prerequisites are met; no native throughput, standalone `run(1.5, -2.25) === 1.25`, full IR completion or checker main delivery is claimed here.

## Session A integrated source checkpoint — 2026-10-09

The current tested SOURCE_HEAD is signed `1d9a6c8a16de6b393f8c78e0055f52388ab2b6af` on `codex/6920-allocation-evidence-checker-20261009`. Its two parents are reviewed carrier-fix source `e734e6331bd4cbdb1d8f9e5abb9b462957ac94de` and freshly revalidated canonical main `e610189829ad1554b813d6ca224515666b0e2d28`. The normal merge preserves all21 candidate path pins and reproduces all14 canonical dependency files exactly. Earlier d413/4c9 handoff epochs remain historical records; the later metadata publication hash will be confirmed externally, not inferred from this prose.

F1's one-line defined-allocation carrier exclusion and five genuine canonical controls close Astra's identified finite-profile defect. Root accepted the independent exact-e734 delta review, SHA256 `ec35adf5b604c7f22c673c66879ee1ed4d8abae802212edf72a038b0b70801d6`, with no new blocker. The closed carrier window passed5+22+5=32/32; the signed source commit's full normal hooks passed56/56 and the integrated merge's full normal hooks passed70/70 (actual14+5+5+22+8+16). Original22/reuse5/J1 eight/preservation sixteen, fixed historical receipts and the earlier paired116/39 proof results are retained, not replaced or broadened. Thomas signing, normal Node25 hooks and zero pin drift are recorded in the merge receipt.

This is a bounded generic finite evidence leaf and pure provenance extraction. It does not complete B's memory/resource contracts, native/public admission, J2/J3, the deferred ROOT/full40 cases, a general witness, full equality or legacy retirement. PR6599 remains under root HOLD/CI/queue control until the exact current publication is reviewed. Existing baseline architecture failures and original failed attempts remain recorded. No protected main delivery of this checker is claimed.



## Session A B CI contract publication — 2026-10-09

ROOT delegates this docs-only publication to slice `6920:b-ci-contract-publication-20261009`, actual upstream/issue-assignments owner `ttraenkler/codex-sol-b-ci-contract-publication-20261009`, write `94594-m2o7o4g1`. Authoring HEAD/base is freshly verified canonical `616da017ca11cefa61f3f8d71a1c7ac18773491c`, branch `codex/6920-b-ci-contract-release-20261009`. Scope is only the new full contract log and appended issue6920/Session A log sections; no production functions or foreign claims are owned.

The [complete adopted contract](6920-b-ci-contract-release-20261009.md) preserves the full 26,593-byte Astra High spec (SHA-256 `d6f6f6d4d6962dadc24be72059b10fa6ae3747740c60027cca49c20c51fff88c`) and [ROOT's normative release](https://github.com/loopdive/js2/pull/6583#issuecomment-6076669715). Part A is exactly two inserted uploader steps; existing advisory80796 and shard10279 regions are excluded. Part B is only the named finite runner functions/controls, historical953f74 plus fixed2a8c200c bound to canonical616da; `PINS`, `APPROVAL_COMMIT` and baseline stay immutable. B needs fresh named claims and complete adoption in issue6915, “Linear owned-ASCII append: optimize the existing copy kernel”. B parent reviews exact patch/freeze before authorizing one serialized qualification; 36 complete observation graphs plus completion must equal the old baseline within38 envelopes and full custody. Difference/refusal stops; no auto-retry/repin/filtering.

PR6600, “refactor(linear): publish shared Linear memory geometry contract (6920 A-G)”, exact `e8f56680589752d67c83ce80cbb43b1bebf1f056`, is queued position1 in actual group `2d0c31a3e2dbe0a4a46d123226fa1d62f7d4c7aa`, awaiting102 conformance shards/required gates, not delivered. PR6593, “fix(ci): preserve trusted Linear append regression custody”, exact `2f8ae6bde384d9f182981c11b94f7230988caa42`, remains blocked on source approval/full-witness qualification. Failed/missing historical evidence stays failed/missing. No future trees, import rewiring, native admission, HOLD removal or queue authority are released; ROOT retains integration/queue. This docs publication runs normal hooks, not the qualification or runner self-test.

ROOT authorizes a fourth docs artifact, `plan/log/6920-b-ci-contract-release-20261009.spec.txt`, under the same docs claim. It preserves the exact normative26593-byte specification/SHA above. The full readable Markdown display substitutes only the absent B-owned6915 issue pathname with its title and existing PR6593 authority; normal link checks remain enabled. Original signed checkpoint `c890a55c10fceb48149d9116a1ad44c0f89869b5` stays historical, unpushed; follow-up publication identity is confirmed externally. No B issue copy or gate changes are authorized.


## Publication refresh after verified C geometry delivery — 2026-10-09

ROOT records PR6600, “refactor(linear): publish shared Linear memory geometry contract (6920 A-G)”, delivered at `2026-10-09T07:57:57Z` as canonical merge `2d0c31a3e2dbe0a4a46d123226fa1d62f7d4c7aa`, exact reviewed head `e8f56680589752d67c83ce80cbb43b1bebf1f056` and reviewed tree prefix `e9fdf1f42`. ROOT verified six required group gates and all102 actual conformance jobs successful. This replaces the earlier queued status for C; original queued-state records above remain historical.

This docs branch refresh merges freshly API/fetch-verified main `b47c6e4b9d64ce848407a80a03a063fb102ffe8b`, whose parent is delivered2d0. Publication head is reported externally after the signed merge/push. Claim94594-m2o7o4g1 remains effect-read in-progress with owner `ttraenkler/codex-sol-b-ci-contract-publication-20261009`; ROOT delegates only the two new contract artifacts and issue6920/Session A log appendices. Both canonical C append and this lane's prior release append remain intact. All non-doc paths match refreshed main exactly.

The adopted tested contract base616da and finite historical953f74/current2a8c200c targets remain historical and unchanged. Newly delivered geometry changes complete `src` identity; neither this main merge nor C delivery automatically approves a new B source tree. B PR6593's existing source-approval/full-witness limits, fresh claims, one serialized parent-authorized qualification and stop-on-difference/refusal remain. Original PINS/APPROVAL_COMMIT/baseline and exact normative26593-byte specification/SHA remain immutable. No B source/runner/workflow/claims, native admission, HOLD or queue authority change is performed by this docs refresh; ROOT retains integration and protected queue decisions.


## Session A B geometry-source contract release — 2026-10-09

ROOT adopts the [full reviewed third-source contract](6920-b-geometry-source-release-20261009.md) and exact normative31,726-byte companion (SHA256 `aa04bdb08792e0dc6db4007462bf982456335068b9dcb75e5f668402af511c58`), following [ROOT's full-text release](https://github.com/loopdive/js2/pull/6583#issuecomment-6077817777), published at `2026-10-09T09:02:24Z`. This append preserves the exact canonical Session A handoff prefix. Publication claim `6920:b-geometry-contract-publication-20261009`, owner `ttraenkler/codex-sol-b-geometry-contract-publication-20261009`, was effect-read on upstream/issue-assignments as in-progress / `48581-uq40ialx`; authoring base is fresh API-verified canonical `cffb28679df96764e295fd2064e0a4ceec643efe`, source `171606514a3cf6733e82eb11549a659856d68c1a`. Signed publication head is reported externally after normal hooks and remote readback.

Private implementation only: B's runner literal/predicate/corresponding embedded controls may add the fixed geometry tree1716 anchored to delivered2d0. Original approval/PINS/successor/baselines/all128 controls and full source/config custody stay fixed. Existing runner owner62837 must acknowledge, serialize and effect-read a fresh same-owner continuation; no competing writer or foreign claim release. B parent adopts the full plan before editing, reviews exact patch and independent committed-input freeze, then separately authorizes ONE trial requiring strict exits, complete custody,38 envelopes and all36 full ordered observation graphs plus completion equal to the retained baseline. No runtime release, future-tree approval, rebaseline or filtering; stop on any difference/refusal and preserve it.

Fresh B PR6593, “fix(ci): preserve trusted Linear append regression custody”, is `75a018957cd83b8c727adc73136ed0f2bf780fad` with HOLD; initializer PR6577, “refactor(linear): extract initializer and preserve Prepared evidence”, is `80c93a3e1fd6ab47e6deec6db59878cb26e1f721` with HOLD. Initializer writer is unavailable and claim4467 is not transferred. Existing zero-child CI failures remain archived. ROOT verified geometry PR6600 delivered at `2d0c31a3e2dbe0a4a46d123226fa1d62f7d4c7aa` with102 actual conformance jobs passed, and docs PR6602 delivered at `bb58c562545e4bd08310ab2bfc41bbd88679d958` with docs-only skips. No new runtime measurement follows from this publication.

ROOT's A integration owner60335 retains its separate head7928/pendingb932 and dirty unpublished proof work untouched. C1's old DATA-pin failure remains preserved; private bridge authoring is pending, without native-equality/retirement credit. All B HOLDs and ROOT's final integration/queue authority remain. Only the two new contract artifacts and these two appendices are owned; no B issue copy, source, runner, workflow, gate, foreign claim, HOLD or queue mutation is included.
