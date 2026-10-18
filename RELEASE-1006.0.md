# 1006.0 — 2026-10-18

## Changes
- Foreground automatic synchronization on opening, reconnecting and every 60 seconds; saved changes debounce for 4 seconds. Three-way ID-based merges preserve independent additions, detect competing edits, and preserve immutable version history. Active checkout drafts and editing dialogs defer synchronization.
- Empty devices receive the cloud version before publishing. Sibling versions merge through their common ancestor; ambiguous branches stop for review. Existing Firestore rules and original cloud records are unchanged by this release.
- Responsive customer/order search, tablet checkout layout, icon navigation and compact monthly reporting. Drawer-based glass/liquid themes, shape, opacity, blur, typography, layout, category colors and individual item colors.
- New checkout commission snapshots deduct material and assistant costs before applying service commission. Legacy calculations remain unchanged. Monthly payroll cards distinguish service gross/net performance, commission, fixed pay and advances. Expenses and inventory purchases avoid double-counting in estimated operating profit.
- Immutable prepaid ledger with atomic debit/refund, insufficient balance protection and one designated wallet-writing device. Other devices can view balances. Designating the till is a separate explicit action in settings and was not performed on production data.
- Rapid-save protection for member, staff, item, product and expense forms; configurable low-stock thresholds; Taiwan dates; view-specific CSV exports.

## Validation
- Build and all 58 automated test groups passed. Includes checkout/retry/void, interrupted writes, local quota failures, compressed backup restoration, immutable cloud versions, offline and multi-device merge scenarios, wallet double-spend prevention on the designated device, UI forms and report formulas.
- 10,000 simulated orders produced exact report totals in 25 ms on the test runtime; this is not an iPad performance guarantee.
- Browser visual checks at 390, 768, 1024 and 1280 CSS pixels using isolated simulated data. Preview uses memory-only storage and blocks network access from the app iframe.
- No real customer, transaction, expense or wallet data was added, edited, restored or deleted during validation.

## Operating limits
- Synchronization is foreground polling, not continuous server streaming. A closed/background browser cannot be guaranteed to sync. Same-record or ambiguous branch conflicts pause for review.
- Existing snapshot size limits still apply; this release does not provide unlimited cloud capacity or segmented snapshots.
- Wallet writes require the designated device. Device transfer requires administrator review; there is no automatic takeover. Existing token-based access architecture is unchanged and is not a replacement for server-enforced user authentication.
- No physical iOS 10.3 / iPad 4 compatibility certification. Existing modern JavaScript/browser requirements still apply.
- Fixed salary is included in monthly payroll; non-monthly views identify period-specific treatment. Estimated operating profit is an operational report, not a tax filing statement.

## Reference practices
- https://www.fresha.com/help-center/knowledge-base/reports/357-liability-activity-article-1
- https://www.fresha.com/help-center/knowledge-base/team/98-set-up-commissions-for-team-members
- https://firebase.google.com/docs/firestore/manage-data/transactions
