# 18.9 restore capacity and overwrite guard — 2026-10-04 / 1004.2

Large local records, restore snapshots and write-ahead journals now use a versioned lossless gzip codec. Plain JSON remains readable and JSON exports remain plain. Restore compacts only this POS's keys, includes its pre-restore snapshot in the same journal, and checks peak write capacity before changing data. Unrelated applications sharing the origin are not cleared. The shared recovery reader supports compressed journals and values. All active POS tabs must be refreshed before using this version; older code cannot read compressed local values. Do not roll back storage readers without first exporting JSON.

Requested cloud overwrite guard applies to manual and automatic uploads: transactions, customers, expenses, inventory logs, services/products and staff cannot decrease in count or omit previously saved record IDs. Equal complete datasets may update and complete supersets may grow. Pending orders and drafts are transient and exempt. Consequently intentional deletions of protected records also block upload; there is no bypass button. Existing remote revision preconditions still protect against races. Successful cloud restore records the downloaded revision, disables background uploads on the receiving device, and retains the selected destination.

Tests reproduce the previous quota failure with a nearly full localStorage mock, then verify a complete 8,000-record restore with original snapshot, pending/draft and reload. Insufficient capacity rejects before data writes; interrupted compressed commits recover. New-device, equal-count/different-ID, automatic upload, complete growth, restore baseline and concurrent-device protections pass. Existing checkout/UI/bridge tests remain passing. The user's actual iPhone storage and cloud contents have not been accessed; verify restore on that device after deployment.

# 18.9 cloud backup hotfix — 2026-10-04 / 1004.1

Fixes the misleading 900 KB guard that blocked large backups before any upload. Backups larger than that threshold are gzip-compressed into a versioned JSON envelope using native CompressionStream where available and bundled fflate 0.8.2 otherwise. Compressed content must still fit the conservative single-document limit. No Firestore paths, rules, account quotas or shop records are changed.

SHA-256 and a local round trip validate compressed payloads. A separate uncached GET verifies the saved cloud document before reporting success. Failed verification keeps a write receipt for safe manual retry but cannot enable background backup. Small/legacy JSON backups remain readable; local downloads stay uncompressed. Refresh all devices before restoring compressed cloud backups; old app versions cannot read the new format. Genuine oversized compressed backups show their size and require a future storage migration, rather than claiming the entire cloud account is full.

Tests: >1 MiB / 8,000 multilingual order round trip, native/fallback gzip interoperability, integrity failure, independent readback failure, incompressible overflow without writes; existing checkout/UI/bridge regressions pass. Cloud requests are mocked; the actual shop payload, Firebase rules and production upload remain unverified until tested from the shop device.

# 18.9.0 — 2026-10-03

Fixes the remount-on-notification defect that discarded open carts. View components now have stable identities. Small drafts persist locally and pending orders remain durable until checkout commits. Checkout, revisions and inventory changes use a recoverable local write-ahead journal, with validation and duplicate-draft protection. Existing salon_* storage keys are preserved; no automatic migration or cloud upload runs on first load.

Corrects Taiwan business-date filtering, staff advances, item-level stylist changes, return inventory and premature customer totals. New orders snapshot commission settings. Historical orders without snapshots continue using current commission settings; audit them before final payroll. Legacy service costs greater than 100 are treated as fixed currency amounts; new/edit forms expose explicit fixed/percentage units. The summary previously called net profit is now labelled cash inflow/outflow balance. Full base salary is shown only for monthly estimates.

Cloud backup is explicit/opt-in, runs separately from checkout, validates the server-returned content, uses update-time preconditions and stops on conflicting remote updates. It still uses the existing salonpos-system destination and rules; no rules or credentials were changed. Actual production cloud access requires the store's configured browser. Existing automatic JSON-download preference is preserved; cloud auto-backup is a separate checkbox. Backups include pending orders and draft, and restore retains a downloadable pre-restore snapshot. Oversized legacy single-document backups fail visibly rather than claiming success.

Adds larger controls, visible editing actions, mobile quick navigation, selectable appearance/text size/density/motion and category colour palettes. React, JSX and styles are prebuilt and hosted with the site; there is no browser-side Babel/Tailwind compilation.

Validation: runtime tests cover atomic persistence, interrupted-write recovery, duplicate checkout, stock rejection, linked customer totals, pending orders, dates/costs, backup validation and mock cloud conflicts. DOM component tests cover stylist changes, navigation, pending restoration, double tap, member selection, salary advance and cost forms. Existing bridge regressions remain intact. Production customer records and real-device iOS/Android performance were not modified or measured by these tests.

Build: npm ci && npm run build && npm test (Node compatible with Babel 8).
Rollback: restore the prior Git commit a95ec0594aa9ea79c8af7b51eb8cdbc7eb2200da. Take a current JSON backup before any rollback; do not reset or clear browser storage.
