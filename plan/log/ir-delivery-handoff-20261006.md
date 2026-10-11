# IR delivery handoff — 2026-10-06

Complete IR migration remains the active goal. Keep the public/legacy compiler until IR behavior, artifacts and performance are tested and equal. Issues live in plan/issues; claims use upstream/issue-assignments. Astra High specifies hard work, Sol6.1 Medium implements/tests, root integrates. No force-push, hook/protection bypass, weakened guards or fixture deletion.

## Verified main delivery

Fresh authenticated upstream main is bba74cfa80aac38a3d29ba6b331d70f6bb0f9cb1. PR6521, `fix(ir): fork nested specialization allocations and preserve clone origins`, merged as9c7817882e5370127da96679c61014f5b642e50f at2026-10-06T10:33:34Z. Exacthead28fe57eddc496e2c63fddfa9ab6bd64f1b449ddb is an ancestor; source, regressiontest and entire issue/spec blobs match freshmain. Its three finite specialization source/test/planning claims are effect-verified DONE. Broader physicalSourceMaps/ownership work stays open.

PR6503, `test(ir): verify prepared whole-program optimization controls`, and PR6501, `feat(ir): prepare zero-suspension async null rejection`, are also ancestry/content-verified delivered. Do not duplicate6503. Controls test23778/b90d9b04… remains consume-only; allocation performance stays inconclusive.

## Source-position publication checkpoint

Issue6866, `IR source maps: project authenticated source-point data to physical UTF-16 positions`, is publication-ready on isolated branch/worktree codex-6866-current-main-finally-composition-20261006, based on exactbba74cfa…. Officialclaim6866 sameowner ttraenkler/codex-ir-source-map-position-projection-20261006 names thisbranch. All1841 deliveredmain source blobs remain exact; only the new pureprojector source is added. IncomingIRspecialization, finallyprivate-local and StringLike fixes/regressiontests are retained.

Currentpolicy1840rows/589117bytes/SHA58ae19c3c96ecbb3ebe43ec81cfb1d244a0c15e80c7da6000becb58d44834857 retains the fixed ownsource-position successor, class-fields successor and separateexact318-bytefinally successor. Historicalhelpers/receipts/operands remain exact. CurrentC1manifest409047bytes/SHA7866e5631d0c18a1226dec77fce73733a0140253f3ee959fca45289ae6c93d00 is independentlyreviewed andinstalled withonlyfourreaderrecipe extensions andboundedanchor/externalscalar changes.

Evidence epochs stay distinct: oldcdc actual2935/2935 complete21-filebody and13 boundedgates; freshbba actual236/236 acrosseightcompiler/source/IRsuites plusTS7/productionbuild; freshfinally proof436/436 (39new,31class,23own,343C1); targeted originalreaders84/84, plusseparately2/2 application cases closing a discoveredselectiongap. All2434reader identities and54oldproof identities retained;2350unselected readercases are not newlyexecuted. Nofull2935/353repeat. Actual24-site coverage follows staticoriginalcallpaths andselectedcaseidentities, not inventedruntime counters.

Postbody64748inputfiles,53933resolvedpinnedcorpusfiles/linkidentity,installedruntime,1842sourcefiles,22ownedformattedfiles andthreeC1pins are exact. Twelve normalfresh boundedgatespass; completearchitecture correctlyremainsopen withinventory-valid-architecture-incomplete,errors[],graphCompletefalse. Independent sourcecontrolWT has7715repo/31654dependency entriesexact and223 normalignoredbuildartifacts preserved.

Evidence: currentWT .tmp/finally-main-composition, .tmp/6866-finally-phase-a, .tmp/finally-main-c1 and .tmp/6866-finally-phase-b; independentWT codex-6866-fresh-main-source-controls-20261006 .tmp/fresh-main-source-controls. Old source-position worktrees are preserved. Normal signedcommit, forkpush, readyPR, exactprotectedadmission andactualmain verification remain required; do notcount PRopening/queueadmission asdelivery. Publicationdescription/state receipts live in currentWT .tmp/6866-publish.

## Existing Deno PR6341

Issue4376, `Spike v8x as a rusty_v8-compatible js2wasm backend for a compiler-free Deno runtime`, remains existingPR6341; never open a duplicate. CurrentpreparedWT codex-6341-current-main-composition-20261006 retainsoriginalhead60f99e83450ea7eac7d6fe21a5ec2d4436cce6c5 anduncommittedMERGE_HEADcdc0255882d45181072342d9fd57f291aca93092. Existingclaim4376:6341-main-composition-20261006 owner ttraenkler/codex-ir6341-main-composition-20261006 isintact. Denoauthor explicitlyreleased scopedintegration; separate6772claim untouched.

Freshclass composition native565/565 andbuild/type/format/lintpass. Original20-file2841body terminated2838PASS/3semanticfixtureFAIL, fullypreserved; all7755input/1858sourcepins exact. The authorizedone-file208-module/988-edge fixture repair then passedoriginal3/3 andfull353/353 withallidentities/11-span inverse-replay retained. Onlythattestdiffersfromold2841epoch; allsource/policy/helpers/C1unchanged. Finalevidence is2488unchanged-file passes plus353corrected-file passes covering2841uniqueidentities, not a secondwholebody. Evidence .tmp/pr6341-current-main-full-validation and .tmp/pr6341-three-runtime-closure-implementation. Indexconflicts remainuntilrootexplicitstaging.

Deliver source-position first, then compose Deno onto its actuallydelivered row andfreshmain. Preserve incomingfinally/IR/string fixes, including any exceptions.ts overlap. Refresh onlythe newlyaffectedfinite metadata/C1 proof; do noteraseoldfailure/nativeevidence or repeatallunrelatedsuites automatically. Push existingupstreamPRbranch codex/4376-deno-callback-construction-20260930 withoutforce onlyafterapplicablechecks/normalhooks. NoDeno commit/push/queue yet.

## Other prepared IR work

Existingissue6837, `Modular IR analysis and optimization pipeline with measured performance parity`, hasisolated codex-6837-main-allocation-composition-20261006 atcdc; officialboundedclaim6837:current-main-allocation-composition-20261006 ttraenkler/codex-ir-allocation-main-composition-20261006 verified. Fourfrozen source/proof files passactual60/60 orderedcases, sourceTS7/strictallocationfocus/lint/format; stricttypedfocus retains twoexactpre-existing replayhelperdiagnostics. Frozenreceipt c266365b… andcomplete source/test reciprocalproofs retained. Deliveredissueprefix preserved. Astra appendedfinitecurrentpolicy plan; metadataimplementation waits actualsource-position→Deno delivery andnewrecensus. No genericpluginregistry/scheduler/cache/parallelIRmutation.

Performanceattempt4 remains143/240pairs,4/8reports,INCONCLUSIVE. No stitching/retry/threshold/heap/timefloor change. Rootmayrelease an unchangedfresh exclusiveCPUwindow onlyafterallproof/source lanes finish andinput custody/control review completes; stageparity isnotfullcompiler/legacyparity orretirement.

Existingissue6865, `IR source maps: complete unmapped interval recording and safe VLQ rendering`, remains codex-3525-source-map-unmapped-emission-20261006 at6128dd8244 withthreefrozenrenderer sources and645oldproofpasses. Actual97/102 (public13/18) remainsfive missing-mappingfailures:fourpersistbaseline; fifth exposespreviouslyvacuouslinecoverage. Originalmissing-importfixtureerror separatelycorrected withrealresult.importObject. Preserveallreports/assertions. Astra boundedrepair spec110348/af66aca7… requiresactual6866delivery/freshcomposition, realsource/bodyauthority before receiptconstruction andexistingcurrentness recheck; noimplementationrelease orpublicmappingcoverageclaimed. No guessed issuer/caller callback/selfhash authority orprivateguardlift.

## Preserved state and watcher limitation

Dirtyprimary codex/4376-deno-lexical-checkpoint-20261004 stays untouched, including unrelatedlower-contracts/acorn/exampleartifacts. Alloldpreparedworktrees/failurefixtures preserved. Sharednode_modules linked,neverinstalled. Cleanindependenttest262 at/private/tmp/js2-test262-ir6341-20261006 is pinnedb363f29d3c43c626dc852744ad64a0b48a003693. Newemptygitlinkplaceholder preservedbefore linking corpus; no fixture deletion.

No recurringGitHubpolling/cron/heartbeat isarmed. PassivePRsubscription tool isunavailable; an action or userstatusrequest canjustify a freshone-shot read. Do not invent notifications or conclude main deliveryfromcached queue metadata. Root owns exacthead/main verification and claimcompletion.
