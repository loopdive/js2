# Native scanner integration

Base: a6cc59a2cdfad5141d75faadf1530a9de63bebd7 (PR #5774).
Parent owns string-literal authentication and subsequent scanner/native-value
joins. Hilbert owns flattening, Maxwell owns StringToNumber, Euclid owns the
disjoint ObjVec slice. No full scanner implementation is present here yet.

Added explicit encoding lookup through the existing literal interning keys,
preserving the old text-only API. UTF16 empty lookup must request `wtf16`;
UTF8 test demands use the actual `utf8-guaranteed` contract. Completion
requires an issued owner, exact ledger, successful fill and current physical
ledger validation of all owned types, globals and literal functions.

Initial test setup failed on a nonexistent createEmptyModule export; corrected
to its actual existing ir/types owner. Next run passed4/5 and exposed invalid
test encoding `utf8`; corrected to the real StringEncoding vocabulary. Final
focused5/5 passed. Composed session96731 exited0: TS7 and34/34 tests
(5 completion controls plus29 unchanged string/error cases),10.10s.
No failures were interpreted as implementation success.

High confirmed separate flatten reservation-phase and completion accessors.
Before freeze, authenticate issued owner/transaction/string pack/exact empty
binding without physicalIndex or fill requirements. After freeze, require
canonical fills and current ledger validation. Shared private ownership checks
must prevent the two accessors drifting. No new global completion ledger.

Parent authentication diff still requires independent review. Scanner,
flattening, prepared replay and full-family execution are not certified by
these34 tests. Existing cutover/retirement obligations remain unchanged.

High independently approved source blob eae06050f2c2f31afc90819bb44836180cb3b2b0
and test blob c158bf5bd8e6616630fabbe8c4e03cb42b40a0ff with no concrete findings.
Approval covers string authentication only. Publication awaits the serialized
normal-hook slot; no scanner/full-family completion is inferred.
