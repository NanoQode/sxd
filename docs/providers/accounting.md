# Accounting treatment — ledger, postings and controls

Implementation: `packages/domain/src/ledger/` (chart of accounts, journal drafts, posting builders, allocation planning). Database: `packages/db/src/schema/finance.ts` (`journals`, `journal_lines`, `ledger_accounts`, `allocations`, `tax_treatments`, …) with a deferred trigger that rejects any journal that does not balance, has fewer than two lines or mixes currencies, and append-only protection on journals and lines. This document is the one the **business accountant reviews**; the code follows it.

## 1. Principles

- **Integer kobo.** All ledger money is `bigint` kobo. Naira is presentation only.
- **Balanced, immutable journals.** Every business event posts one journal whose debits equal its credits. Posted journals are never edited or deleted: corrections are reversing journals (`reverse(journal, ref, reason)`) that mirror every line and reference the original (`reversal_of_journal_id`).
- **Unique business-event references.** Each journal carries `business_event_ref` such as `payment_attempt:<id>:settled` or `refund:<id>:approved`. The unique index makes double-posting impossible even under replayed webhooks or retried jobs.
- **Separate accounts** for customer receivables, service revenue, gateway clearing, gateway fees, refunds, rent liabilities and owner distributions; rent collected for owners is a liability, never revenue.
- **Nothing settles on a promise.** A redirect, an uploaded bank-transfer receipt, a submitted refund or a proposed payout moves no money in the ledger until the confirming event happens.

## 2. Chart of accounts (seeded)

| Code | Name                                            | Type      | Normal balance | Used for                                                                                                                |
| ---- | ----------------------------------------------- | --------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1000 | Bank - operating                                | asset     | debit          | Cash in the operating bank account                                                                                      |
| 1100 | Gateway clearing - Paystack                     | asset     | debit          | Verified gateway payments not yet settled to bank; refunds and chargebacks leave from here                              |
| 1200 | Customer receivables                            | asset     | debit          | Issued service invoices                                                                                                 |
| 1300 | Rent receivable (collected on behalf of owners) | asset     | debit          | Issued rent / service-charge invoices collected for owners                                                              |
| 1400 | Bank transfers pending confirmation             | asset     | debit          | Reserved for manual statement-matching journals by finance; **no automatic postings** (a declared receipt is not money) |
| 2000 | Customer deposits and unearned revenue          | liability | credit         | Deposits, on-delivery invoices, overpayments                                                                            |
| 2100 | Rent collected - payable to owners              | liability | credit         | Owner's money held in trust                                                                                             |
| 2200 | Refunds payable                                 | liability | credit         | Approved refunds not yet processed                                                                                      |
| 2300 | Tax and withholding payable                     | liability | credit         | VAT charged, withholding credits, tax remittances                                                                       |
| 2400 | Partner and supplier payables                   | liability | credit         | Owner distributions, contractor and partner fees awaiting payment                                                       |
| 2500 | Chargebacks pending                             | liability | credit         | Disputed amounts withheld by the gateway (carries a **debit** balance while disputes are open — see §5.3)               |
| 3000 | Retained earnings                               | equity    | credit         | Year-end close (manual)                                                                                                 |
| 4000 | Service revenue                                 | revenue   | credit         | Diligence, inspections, reports, project services                                                                       |
| 4100 | Management fee revenue                          | revenue   | credit         | Agreed fees on rent collected                                                                                           |
| 4200 | Tender and procurement fee revenue              | revenue   | credit         | Tender / procurement fees                                                                                               |
| 4300 | Referral and placement revenue                  | revenue   | credit         | Referral and placement fees                                                                                             |
| 5000 | Gateway fees                                    | expense   | debit          | Paystack fees                                                                                                           |
| 5100 | Refund and chargeback losses                    | expense   | debit          | Lost disputes                                                                                                           |
| 5200 | Maintenance and estate expenses (recoverable)   | expense   | debit          | Contractor work later recovered from owners                                                                             |
| 5300 | Partner professional fees                       | expense   | debit          | Cost of partner-delivered services                                                                                      |

## 3. Postings

Notation: `Dr` debit, `Cr` credit. Amounts in kobo. Each heading names the builder in `postings.ts` and its `business_event_ref`.

### 3.1 `invoiceIssued` — `invoice:<id>:issued`

Service invoice, subtotal 1,000,000, VAT 75,000, total 1,075,000, policy `on_issue`:

```
Dr 1200 Customer receivables         1,075,000
    Cr 4000 Service revenue                     1,000,000
    Cr 2300 Tax and withholding payable            75,000
```

Policy `on_delivery` (and every `deposit` invoice regardless of policy) credits 2000 instead of revenue:

```
Dr 1200 Customer receivables         1,075,000
    Cr 2000 Unearned revenue                    1,000,000
    Cr 2300 Tax and withholding payable            75,000
```

Rent invoice collected on behalf of an owner, 2,400,000 (never revenue):

```
Dr 1300 Rent receivable (owners)     2,400,000
    Cr 2100 Rent payable to owners              2,400,000
```

Revenue account by invoice kind: `management_fee` → 4100; `tender_fee`, `procurement` → 4200; everything else → 4000; referral revenue passes `revenueAccount: '4300'`. The builder enforces `total = subtotal + tax`.

### 3.2 `revenueRecognized` — `invoice:<id>:recognized[:<milestone>]`

Delivery of a deposit / on-delivery invoice:

```
Dr 2000 Unearned revenue             1,000,000
    Cr 4000 Service revenue                     1,000,000
```

### 3.3 `gatewayPaymentSettled` — `payment_attempt:<id>:settled`

Posted only after `matchVerification` returned `settle` (provider `success`, reference, amount and currency all equal). Payment 1,100,000 against a 1,075,000 balance, fees 16,500 reported by verify:

```
Dr 1100 Gateway clearing             1,100,000
    Cr 1200 Customer receivables                1,075,000   (allocated, from planAllocation)
    Cr 2000 Customer deposits                      25,000   (overpayment)
Dr 5000 Gateway fees                    16,500
    Cr 1100 Gateway clearing                       16,500
```

Rent invoices credit 1300 instead of 1200. Fee lines are omitted when the provider did not report fees; they are then expensed at settlement (§3.4).

T-accounts after the invoice and the payment:

```
        1200 Receivables                    1100 Gateway clearing
   ---------------------------          ---------------------------
   1,075,000 | 1,075,000                1,100,000 |    16,500
   ---------------------------          ---------------------------
   balance 0                            balance 1,083,500
```

### 3.4 `gatewaySettlementToBank` — `gateway_settlement:<id>:received`

Paystack pays the balance to the bank (fees not already expensed may be passed):

```
Dr 1000 Bank                         1,083,500
    Cr 1100 Gateway clearing                    1,083,500
```

### 3.5 `bankTransferConfirmed` — `bank_transfer_receipt:<id>:confirmed`

A customer-declared transfer posts **nothing**. When finance confirms the credit on the bank statement (receipt status `confirmed`, confirmed amount, not the declared amount):

```
Dr 1000 Bank                         1,075,000
    Cr 1200 Customer receivables                1,075,000
```

The builder throws for `submitted`, `under_review` or `rejected` receipts.

### 3.6 `refundApproved` — `refund:<id>:approved`

After step-up authentication and a second approver. The debit reduces wherever the money was recognised (`source`): revenue account, 2000 unearned, or 2100 rent payable.

```
Dr 4000 Service revenue                100,000
    Cr 2200 Refunds payable                       100,000
```

### 3.7 `refundSettled` — `refund:<id>:settled`

Only when the provider reports `processed` (webhook or `GET /refund/:id`); a submitted or pending refund never settles. Refund status must be `submitted` or `pending`.

```
Dr 2200 Refunds payable                100,000
    Cr 1100 Gateway clearing                      100,000
```

A failed refund keeps the liability in 2200 until it is retried or reversed with `reverse(refundApproved(...))`.

### 3.8 `creditNoteIssued` — `credit_note:<id>:issued`

Reduces the receivable (1200, or 1300 for rent) against the original recognition; never creates a refund by itself.

```
Dr 4000 Service revenue                 25,000
    Cr 1200 Customer receivables                   25,000
```

### 3.9 Chargebacks

`chargebackOpened` — `chargeback:<id>:opened` (dispute received; gateway withholds the amount; original payment history untouched):

```
Dr 2500 Chargebacks pending             10,000
    Cr 1100 Gateway clearing                       10,000
```

`chargebackLost` — `chargeback:<id>:lost`:

```
Dr 5100 Refund and chargeback losses    10,000
    Cr 2500 Chargebacks pending                    10,000
```

`chargebackWon` — `chargeback:<id>:won` is the exact reversal of the opening entry (`Dr 1100 / Cr 2500`). If the invoice must be reopened after a lost dispute, finance reverses the settlement journal (`reverse(gatewayPaymentSettled(...))`) or issues a credit note per policy.

### 3.10 Tax

`taxWithheld` — `invoice:<id>:withholding` — the customer withholds tax at source (e.g. WHT) and remits it for us; the receivable falls and the withholding credit offsets tax payable:

```
Dr 2300 Tax and withholding payable     50,000
    Cr 1200 Customer receivables                   50,000
```

The application also applies the withheld amount to the invoice via `planCreditNoteApplication` so the balance closes. `taxRemitted` — `tax_remittance:<id>:paid`:

```
Dr 2300 Tax and withholding payable     75,000
    Cr 1000 Bank                                   75,000
```

### 3.11 Owners, management fees and payouts

`managementFeeFromCollectedRent` — `owner_statement:<id>:management_fee` — fee = `bpsOf(collectedRent, feeBps)` (half-up rounding), optional tax on the fee:

```
Dr 2100 Rent payable to owners         258,000
    Cr 4100 Management fee revenue                240,000   (1000 bps of 2,400,000)
    Cr 2300 Tax and withholding payable            18,000   (750 bps of the fee)
```

`ownerDistributionApproved` — `payout:<id>:approved` — requires payout status `approved` (two different approvers) **and** a `balanced`/`closed` reconciliation:

```
Dr 2100 Rent payable to owners       1,000,000
    Cr 2400 Partner and supplier payables       1,000,000
```

`ownerPayoutSettled` — `payout:<id>:settled` — finance confirms the transfer on the bank statement (settlement reference required). The same builder discharges contractor and partner payables.

```
Dr 2400 Partner and supplier payables 1,000,000
    Cr 1000 Bank                                1,000,000
```

`maintenanceExpenseRecoverable` — `work_order:<id>:expense` (`Dr 5200 / Cr 2400`) and `maintenanceExpenseRecovered` — `work_order:<id>:recovered` (`Dr 2100 / Cr 5200`) net a recoverable repair against the owner's rent balance. `partnerFeeAccrued` — `partner_fee:<id>:accrued` (`Dr 5300 / Cr 2400`).

`partnerInvoiceAccepted` — `payout:<id>:accepted` — finance accepts a partner invoice (a `payouts` row of kind `partner_invoice`, status `first_approved`). The payable is recognised at acceptance, not at submission: `Dr 5200` for materials billed on a purchase order (a recoverable project cost, re-invoiced to the customer under the `procurement` invoice kind) or `Dr 5300` for work billed on an assignment, `Cr 2400` tagged with the partner's organisation. The second approval posts nothing; settlement discharges the payable through `ownerPayoutSettled`. `partnerInvoiceAcceptanceReversed` — `payout:<id>:accepted:reversed` — reverses the accrual when finance rejects an invoice it had accepted. **Confirm** the 5200/5300 split for materials versus services (see §5.5).

## 4. Allocation rules (`allocation.ts`)

- `invoiceBalance = total − paid − credited`, never below zero.
- `planAllocation` applies verified money up to the balance; the excess is an **overpayment** credited to 2000 and shown on the customer's statement — never silently absorbed. Status moves `issued|overdue → partially_paid|paid` per `invoiceMachine`; draft and void invoices cannot receive allocations; money arriving for an already paid invoice is entirely a deposit and needs no receipt.
- Every positive allocation gets a receipt. The allocation row's `dedupe_key` (`payment_attempt:<id>`, `bank_transfer_receipt:<id>`, `credit_note:<id>`) is unique, which is what makes replayed callbacks, webhooks and job retries idempotent.

## 5. Policies the accountant must review

### 5.1 Revenue recognition

`recognitionPolicy` is a per-service setting: `on_issue` (revenue when invoiced) or `on_delivery` (unearned until the deliverable is released, then `revenueRecognized`). Deposits are always unearned. Rent for owners is always a liability. **Decide the default and any per-service exceptions.**

### 5.2 Tax and withholding

Rates live in `tax_treatments` (`rate_bps`, `withholding_bps`, `applies_to`, `reviewed_by`, `reviewed_at`); no single percentage is assumed for every service or rental. Each invoice snapshots the treatment it used (`invoices.tax_treatment_snapshot`). Withholding by customers is recorded as a **debit to 2300** (offset against tax payable) when the customer's withholding evidence is received. **Confirm** the VAT treatment per service kind (including management fees on rent and service charges), whether withholding credits should instead sit in a separate receivable account (add e.g. 1500 if so), and the remittance cadence.

### 5.3 Chargebacks pending (2500)

The seeded chart classifies 2500 as a liability, but the prescribed opening entry debits it, so the account carries a debit balance while disputes are open (it behaves like "amounts withheld by the gateway pending outcome"). **Confirm** whether to keep this presentation or reclassify 2500 as a contra-asset to 1100.

### 5.4 Bank transfers

Declared receipts post nothing. Account 1400 is reserved for finance's manual statement-matching journals (money seen on the statement that is not yet matched to an invoice); the automatic path posts confirmed receipts straight to 1000. **Confirm** the review threshold for who may confirm a receipt.

### 5.5 Payouts

Owner distributions and partner payments require: a balanced reconciliation for the period, first approval, second approval by a different person (`payoutMachine`), then submission and bank confirmation. Ordinary service checkout never authorises a transfer. **Confirm** approval limits and who holds the two approver roles.

Partner invoices (`apps/web/src/server/finance/partner-invoices.ts`) follow the same machine without a period reconciliation: the partner's submission is the proposal, finance's acceptance is the first approval (and the accrual), a different finance approver gives the second, and settlement needs the bank reference. Invoices against a purchase order may never exceed the order total in aggregate. **Confirm** whether materials should hit 5200 (recoverable) or a dedicated cost-of-materials account, and whether partner invoices need a reconciliation gate as owner distributions do.

### 5.6 Gateway fees and settlement

Fees are expensed per payment when Paystack's verify reports them, otherwise at settlement. **Confirm** monthly reconciliation of 1100 against Paystack settlement reports and the treatment of settlement timing differences at period end.

### 5.7 Refund sources

A refund debits the account that received the money (revenue, unearned or rent payable). Refunds of rent reduce the owner's payable; **confirm** the policy when the owner has already been paid out (recovery from the next statement vs. company-borne loss to 5100).

## 6. Reconciliation

The reconciliation record (`reconciliations`) for a period lists: attempts still pending/uncertain, provider events flagged for review (`flag_for_reconciliation`), mismatched verifications, refunds needing attention, open chargebacks, unmatched bank credits and 1100 vs. settlement differences. It closes as `balanced` only when exceptions are resolved or explicitly accepted with a reason; payouts are gated on that state.
