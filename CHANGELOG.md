# 18.9.0 — 2026-10-03

Fixes the remount-on-notification defect that discarded open carts. View components now have stable identities. Small drafts persist locally and pending orders remain durable until checkout commits. Checkout, revisions and inventory changes use a recoverable local write-ahead journal, with validation and duplicate-draft protection. Existing salon_* storage keys are preserved; no automatic migration or cloud upload runs on first load.

Corrects Taiwan business-date filtering, staff advances, item-level stylist changes, return inventory and premature customer totals. New orders snapshot commission settings. Historical orders without snapshots continue using current commission settings; audit them before final payroll. Legacy service costs greater than 100 are treated as fixed currency amounts; new/edit forms expose explicit fixed/percentage units. The summary previously called net profit is now labelled cash inflow/outflow balance. Full base salary is shown only for monthly estimates.

Cloud backup is explicit/opt-in, runs separately from checkout, validates the server-returned content, uses update-time preconditions and stops on conflicting remote updates. It still uses the existing salonpos-system destination and rules; no rules or credentials were changed. Actual production cloud access requires the store's configured browser. Existing automatic JSON-download preference is preserved; cloud auto-backup is a separate checkbox. Backups include pending orders and draft, and restore retains a downloadable pre-restore snapshot. Oversized legacy single-document backups fail visibly rather than claiming success.

Adds larger controls, visible editing actions, mobile quick navigation, selectable appearance/text size/density/motion and category colour palettes. React, JSX and styles are prebuilt and hosted with the site; there is no browser-side Babel/Tailwind compilation.

Validation: runtime tests cover atomic persistence, interrupted-write recovery, duplicate checkout, stock rejection, linked customer totals, pending orders, dates/costs, backup validation and mock cloud conflicts. DOM component tests cover stylist changes, navigation, pending restoration, double tap, member selection, salary advance and cost forms. Existing bridge regressions remain intact. Production customer records and real-device iOS/Android performance were not modified or measured by these tests.

Build: npm ci && npm run build && npm test (Node compatible with Babel 8).
Rollback: restore the prior Git commit a95ec0594aa9ea79c8af7b51eb8cdbc7eb2200da. Take a current JSON backup before any rollback; do not reset or clear browser storage.
