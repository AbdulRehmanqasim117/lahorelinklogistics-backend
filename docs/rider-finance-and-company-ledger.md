# Rider Settlements & Company Finance – Finance Logic

This document explains how rider earnings, settlements, and company-level finance views are computed and how the **Rider Settlements** and **Company Finance** modules stay in sync.

## Order-Level Fields (Source of Truth)

- **Order.riderEarning**
  - Primary per-order rider earning.
  - Set when the financial transaction is created (`createFinancialTransaction`).
  - Backfill script `scripts/backfillRiderEarnings.js` can be run once to populate historical orders (falls back to `FinancialTransaction.riderCommission` and rider commission config).

- **Order.riderSettlementStatus**
  - Enum: `PAID`, `UNPAID`, or `null`.
  - Toggled via `PATCH /api/orders/:id/rider-settlement`.
  - Mirrored into the matching `FinancialTransaction.settlementStatus` by `applyRiderSettlement`.

- **FinancialTransaction.riderCommission**
  - Fallback source for rider earning when `order.riderEarning` is `0` or missing.

- **Timestamps (Order)**
  - `deliveredAt`: when order was delivered.
  - `updatedAt`: last modification time (used as a proxy for returned/failed timestamps).
  - `createdAt`: order creation time.

## Effective Order Date (used for all finance ranges)

For **both** Rider Settlements (admin view) and Company Finance (summary + ledger) the effective order date is:

```text
if status == 'DELIVERED':
  effectiveDate = deliveredAt || updatedAt
else:
  effectiveDate = updatedAt || createdAt
```

All date filters (Today / 7 days / 15 / 30 / custom) ultimately compare the selected range to this `effectiveDate`.

## Rider Earning per Order

For server-side aggregations (summary + ledger), rider earning is computed as:

```text
effectiveRiderEarning =
  if order.riderEarning > 0:
    order.riderEarning
  else:
    tx.riderCommission || 0
```

- New orders get `order.riderEarning` from commission rules at transaction creation time.
- Historical orders should be normalized by running `node scripts/backfillRiderEarnings.js` so all final orders have a non-zero `riderEarning` when commission exists.

> Note: Rider Settlements (admin view) additionally has a **JS fallback** to recompute earnings from `RiderCommissionConfig` when both `order.riderEarning` and `tx.riderCommission` are zero. This ensures no valid commission silently shows as zero in that screen.

## Settlement Normalization (Paid vs Unpaid)

All finance views normalize rider settlement status the same way:

```text
orderStatus = UPPER(order.riderSettlementStatus || '')

if orderStatus in ['PAID', 'UNPAID']:
  effectiveSettlementStatus = orderStatus
else:
  txStatus = UPPER(tx.settlementStatus || 'UNPAID')
  if txStatus in ['PAID', 'SETTLED']:
    effectiveSettlementStatus = 'PAID'
  else:
    effectiveSettlementStatus = 'UNPAID'
```

This logic is used in:

- `riderFinanceController.getRiderSettlementsAdmin`
- `financeController.getCompanySummary` (unpaid rider balances)
- `financeController.getCompanyLedger` (Rider Payout + unpaid balances)

## Company Finance – Summary (`GET /api/finance/company-summary`)

- **Date range**
  - Query params: `range` (`today`, `7days`, `30days`, `all`) and optional `from`/`to`.
  - Backend computes `start` and `end` as local start-of-day / end-of-day and then applies them to:
    - Delivered orders via `deliveredAt`.
    - Returned orders via `updatedAt`.
    - Unpaid rider balances via the **effectiveDate** described above.

- **Key outputs**
  - `orders`: Count of created orders in the range (`createdAt`).
  - `deliveredOrders`: Count of `DELIVERED` orders in the range.
  - `returnedOrders`: Count of `RETURNED` orders in the range.
  - `totalCod`: Sum of COD collected for delivered orders in the range.
  - `totalServiceCharges`: Sum of `serviceCharges` for delivered orders.
  - `companyEarnings`: `totalServiceCharges + companyCommission` (from `FinancialTransaction.companyCommission`).
  - `totalAmount`: `totalCod + totalServiceCharges`.
  - `unpaidRiderServiceCharges`:
    - Sum of `effectiveRiderEarning` where `effectiveSettlementStatus in ['UNPAID', 'PENDING']` and order status in `['DELIVERED', 'RETURNED', 'FAILED']`.
    - Date-filtered by `effectiveDate`.
  - `riderPayout` (added via the same unpaid pipeline):
    - Sum of `effectiveRiderEarning` where `effectiveSettlementStatus in ['PAID', 'SETTLED']`.

This means:

- **Unpaid rider balances** in the summary card = `unpaidRiderServiceCharges`.
- **Rider Payout** in the summary = `riderPayout` (sum of earnings for paid orders in the range).

## Company Finance – Ledger (`GET /api/finance/company/ledger`)

- Filters:
  - `periodId`, `from`, `to`, `shipperId`, `riderId`, `status`, `search`.
  - Only final statuses are considered: `DELIVERED`, `RETURNED`, `FAILED`.

- Date filter:
  - Uses the same `effectiveDate` as above within the selected period or custom `from` / `to`.

- Per-row computed fields:

```text
effectiveCod = status == 'DELIVERED' ? (amountCollected || codAmount) : 0
serviceChargesSafe = serviceCharges || 0

effectiveRiderEarning = as defined above

riderPayoutPaidComponent =
  effectiveSettlementStatus in ['PAID', 'SETTLED'] and effectiveRiderEarning > 0
    ? effectiveRiderEarning
    : 0

riderPayoutUnpaidComponent =
  effectiveSettlementStatus in ['UNPAID', 'PENDING'] and effectiveRiderEarning > 0
    ? effectiveRiderEarning
    : 0

// What you see in the ledger row:
Rider Payout (row) = riderPayoutPaidComponent

// Company profit always treats full rider earning as cost:
companyProfit = serviceChargesSafe - effectiveRiderEarning
```

- Totals facet:

```text
totalRiderPayoutPaid   = sum(riderPayoutPaidComponent)
totalRiderPayoutUnpaid = sum(riderPayoutUnpaidComponent)
totalRiderPayout       = totalRiderPayoutPaid + totalRiderPayoutUnpaid
```

The **Company Finance** UI uses:

- `totalRiderPayoutPaid` for **Rider Payout (Paid)**.
- `totalRiderPayoutUnpaid` for **Unpaid Rider Balance** (filtered, in the ledger sidebar).

## Rider Settlements – Admin (`GET /api/riders/:id/settlements`)

- Filters:
  - `from`, `to`, `status` (delivered/returned/failed/all), `settlement` (paid/unpaid/all), `shipperId`, `search`, `sortOrder`.

- Status filter:
  - Only final statuses: `DELIVERED`, `RETURNED`, `FAILED`.

- Date filter:
  - Uses the same `effectiveDate` expression as the Company Ledger via `$expr`:

    ```js
    effectiveDate = status === 'DELIVERED'
      ? (deliveredAt || updatedAt || createdAt)
      : (updatedAt || createdAt);
    ```

- Rider earning:
  - Starts from `order.riderEarning` or `tx.riderCommission`.
  - If both are zero and a `RiderCommissionConfig` exists, recomputes earnings from commission rules for that rider.

- Settlement status:
  - Same normalization as described above (`effectiveSettlementStatus`).

- Summary fields:
  - `deliveredCount`, `returnedCount`, `failedCount`.
  - `codCollected` (for delivered COD orders).
  - `serviceChargesTotal`.
  - `riderEarnings` (all earnings in range).
  - `riderEarningsPaid` (where settlement is paid).
  - `riderEarningsUnpaid` (where settlement is unpaid).
  - `unpaidBalance = riderEarningsUnpaid`.

These are the values shown in the Rider Settlements header cards.

## Frontend Date Range Behaviour

- **Company Finance** (`CompanyFinance.jsx`)
  - Summary `range` tabs (`Today`, `7 Days`, `30 Days`, `All Time`) map directly to `range` query.
  - Ledger quick ranges (`Today / 7 / 15 / 30 / Current Month / All Time`) use `computeLedgerRange`, which:
    - Computes local start-of-day / end-of-day in the browser.
    - Sends `from` / `to` as local `YYYY-MM-DD` strings (no `toISOString()`), avoiding timezone shifts.

- **Rider Settlements** (`CeoRiderSettlements.jsx`)
  - Quick range buttons (`Today`, `7 / 15 / 30 days`) use `applyQuickRange`, which:
    - Computes the same local date windows as the ledger.
    - Sends `from` / `to` as local `YYYY-MM-DD` strings.

Because both pages now:

1. Derive the same calendar ranges in the browser, and
2. Use the same `effectiveDate` logic on the backend,

**the set of orders included for a given rider + date range is consistent between Rider Settlements and Company Finance.**

## Diagnostic Script

A helper script is available to inspect rider finance for a given rider and date window:

```bash
cd server
node scripts/inspectRiderFinanceWindow.js <riderId> [fromYYYY-MM-DD] [toYYYY-MM-DD]
```

It prints:

- Total orders, delivered/returned/failed counts.
- Total COD and service charges.
- Total rider earnings, split into paid vs unpaid, using the same earning/settlement rules as the Company Ledger.

Use this script to cross-check what you see in the **Rider Settlements** screen vs the **Company Finance** ledger and summary for a specific rider and date range.
