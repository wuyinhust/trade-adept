# Tradept Core 0.2.0

Tradept is the foreign-trade workbench for an ERPNext/Frappe site. Each tenant
uses an independent Frappe site and database. The browser and gateway do not
maintain a business database, password database, sync queue or ERP document
mirror. Every mutation uses the site's native database transaction.

## Authoritative records

| Business information | Authoritative record |
| --- | --- |
| Account, password, session, configured role, company grant | Frappe User / Role / User Permission |
| Legal entity | ERPNext Company |
| Customer, supplier, contact | ERPNext Customer / Supplier / Contact |
| Company-specific current FX | ERPNext Currency Exchange, with company custom link |
| Order inquiry before real production items are known | Trade Order Brief, typed operational fields and child rows |
| Historical Excel-era order without SKU/payment evidence | Trade Legacy Order, explicitly non-accounting reference |
| Complete new order, purchasing, receipts | Native Sales Order / Purchase Order / Payment Entry |
| Foreign-trade milestones and CI/PL | Trade Shipment / Trade Document (CI/PL do not invent accounting invoices) |
| Revision, restore archive, audit, source hash | Trade Workspace / Trade Snapshot / Trade Audit / Trade Import Receipt |

Unknown extension fields are retained on their individual record. A single
live tenant JSON aggregate is never used. Snapshot JSON is an historical
restore/archive artifact, not the current business authority. Missing imported
owners/dates/rate timestamps remain unknown. Historical soft deletion and
cross-entity references are preserved; ordinary accounts cannot acquire access
through a missing company or creator.

Grandware's `grandware-v40` calculation remains an explicit company policy.
Generic entities use `generic-native`: sales minus purchases and actual expense
inputs in the settlement currency. After conversion, the DTO reads native
amounts, receipts, items and statuses; it does not copy those balances back to
the brief. Native order FX comes from the frozen Sales Order conversion rate,
so a later current-rate edit cannot restate existing order profit.

## Installation

Copy this folder as `apps/tradept_core` in a bench whose official ERPNext app is
already installed. Install the package in the bench virtual environment, add
`tradept_core` to `sites/apps.txt`, then run:

```sh
bench --site <isolated-site> install-app tradept_core
bench --site <isolated-site> migrate
```

Installation creates dynamic custom DocTypes and native custom fields
idempotently. It does not create a business workspace, demo products, receipts
or ledger postings. `required_apps` is ERPNext. Run bench migrations after
updating the package and restart the web workers to reload Python modules.

## Reviewed import and existing native fixtures

Run imports as the native site `Administrator`. Supply private absolute regular
files to `bench execute` using its structured `--kwargs` JSON; never put passwords
in shell arguments or checked-in source:

```text
tradept_core.migration.import_workspace(
    configuration=<one-tenant JSON file>,
    source=<original business export file>,
    credentials=<private array file>,
    expected_import_hash=<reviewed SHA256>,
    expected_version=0,
    source_snapshot_meta=<optional historical source manifest metadata>
)
```

Configuration accepts a tenant object or `{tenants: [one tenant]}`. It includes
companies, teams, role policies and configured user profiles. Credentials are
an array of `{tenantId,id,username,password}`. Native emails are derived from
stable user/tenant IDs; `User.username` retains the familiar login username.
Passwords are stored by Frappe's native authentication implementation and never
returned by the importer. Users omitted from a later configuration are disabled.
Native Role and Company User Permission edits take effect on the next API call.
User-profile metadata only stores stable IDs and the foreign-trade team mapping.
Native signup is disabled by default; trusted configuration may explicitly
enable `allowNativeSignup`, but a newly registered account still has no Tradept
membership, role or company grants until provisioned by an administrator.

The original source bytes are SHA256 checked. Import is allowed only into an
empty workspace and verifies every typed record against its original fields
before returning `lossless: true`. Source metadata is audited separately from
the new database's concurrency revision. A persistent workspace UUID identifies
the storage instance; the browser must include `backendIdentity` in its draft
namespace so drafts from the former SQLite version cannot be replayed silently.

The previous isolated Example site may already have legitimate submitted native
documents. Set the company's reviewed `nativeCompanyName` before import. Exact
old tenant-bound external IDs reuse the Customer/Supplier masters. Then run:

```text
tradept_core.migration.attach_existing_native(
    order_id=<saved order ID>,
    sales_order=<reviewed submitted Sales Order>,
    purchase_orders=[<reviewed submitted Purchase Orders>],
    delivery_notes=[<reviewed Delivery Note>],
    payment_entries=[<reviewed receipt Payment Entry>],
    expected_version=<current new database revision>
)
```

This checks company/customer/currency, exact source line IDs and explicit SKU,
quantity, rate and supplier relationships. It updates provenance links only,
creates no accounting/stock documents, and derives the order's paid amount from
the already posted native receipt. The earlier source balance stays in the
import snapshot for audit. Do not run the retired connector concurrently.

## API contract

`tradept_core.api.dispatch(action,payload=None)` is authenticated. Frappe's native
HTTP response contains `message: {result: <DTO>, csrfToken: <native CSRF token>}`.
The same native `sid` session is used for login, reads and writes. The facade
unwraps `message.result`; it must send the native CSRF token with POST requests.

Reads: `session`, `context`, `data`, `meta`, `snapshots`, `backend_status`.
Writes: `changes`, `restore`, `convert_order`, `submit_order`, `receive_payment`,
`cancel_order`.
Writes require POST, an integer `expectedVersion`, and a current configured
account. `SELECT ... FOR UPDATE` locks the workspace revision before checking
CAS. Standard Frappe request commit/rollback owns the transaction; these modules
do not issue an internal commit, make HTTP calls or enqueue a second-system job.
An API failure returns `{error,code,latestVersion?}` with its real HTTP status.
Native deadlock or snapshot-conflict errors restart the entire action after
rollback, up to three attempts. Each attempt rechecks authorization, current
CAS and native idempotency; exhausted contention returns `503 DATABASE_BUSY`.
The four native document operations use a temporary service permission identity
only after validating the configured actor, financial permission, record scope
and every linked document's company. The real SID, session data, CSRF and form
remain intact; request permission caches and user identity restore on every
exit. Native document owner/operator stamps and Trade Audit retain the actual
actor. This delegation is unavailable through direct native REST or RPC.
After a successful native operation, attribution also covers its child rows,
voucher-linked GL, Payment Ledger and Advance Payment Ledger rows and native parent updates that bypass
document hooks. Only newly inserted creators and this operation's modifiers
are stamped; existing creators and all posting/financial values are retained.

`changes` uses `{expectedVersion,changes:[{collection,id,value|deleted}],
exchangeRates?,rateMetas?}`. Collection DTOs remain compatible with the existing
workbench (`customers`, `factories`, `orders`, `shipments`, `invoices`). Financial
fields are recursively redacted for ordinary roles; every write checks company,
self/team/tenant scope, related records and embedded financial fields.

An explicitly reviewed Excel history batch may add
`importPurpose: "historical-reference"`. The whole batch contains only order
reference create/update operations, requires financial write/create/edit and
entity grants, and is committed under the same CAS transaction. New rows become
non-accounting Trade Legacy Orders; existing briefs/native orders cannot be
reclassified. The supplied historical amounts/profit are finite reference
values, not new receipts or GL entries. Missing historical creators/dates/FX
remain missing; `importedBy` / `importedAt` record the current import separately.
Repeated unchanged company/customer columns preserve existing historical
cross-entity references. New links still require known authorized master data.
Ordinary new-order import remains the brief workflow and cannot fabricate paid
balances. Selecting an import purpose never trusts a client DocType or stage.

Native mutations use `{expectedVersion,orderId,idempotencyKey}`. Conversion reads
explicit saved `erpItems` (`id,itemCode,factoryId,quantity,saleRate,purchaseRate`,
optional `purchaseCurrency,uom`) and creates real native drafts. It never invents
an Item code. Submit uses the standard native document submit workflow. Payment
adds `amountUSD` and optional `bankAccount,referenceNo,referenceDate`; the standard
Payment Entry helper receives party and bank amounts in their actual account
currencies. A successful receipt retry is acknowledged before stale CAS only
after current authorization and an exact posted receipt fingerprint check.

Legacy history is not convertible into fake ledger documents. Briefs cannot
record paid balances or supplier prepayments before native receipts exist.
Converted order amounts/items/receipts are immutable through generic PATCH;
operational details and permitted expense inputs remain editable extensions.
Production planning retains product category, inspection date, and forecast
shipping date by stable supplier ID; native purchase quantities, costs, and
advances remain authoritative. Customer identity, customer PO, commercial
dates, and actual shipment departure derive from native documents. Arrival
and receipt milestones extend the native shipment without replacing it.
Standard supplier Payment Entries are discovered by their native purchase
order references, including entries created directly in ERPNext.

`backend_status` returns `backend: "erpnext"`, `singleSystem: true`, the native
site, per-order `stage` (`legacy`, `brief`, `native`), and real native document
names/docstatus. It has no synchronization states. The native DTO includes
`exchangeRateUsed`, `settlementCurrency`, `profitPolicy` and financial-role-only
document references.

Configured workbench accounts have no unrestricted ERP business roles. Native
REST/Desk permission and query hooks additionally deny access even if a standard
ERP role is accidentally granted. Trusted site Administrator remains the native
configuration/account/ledger operator. Public endpoints cannot select a site,
DocType, administrator token or arbitrary URL.

The native request hook additionally blocks business RPC helpers, Desk reports
and exports, and API v1/v2 resource/document routes for restricted accounts.
Only the scoped workbench dispatch and an explicit native authentication method
allowlist are exposed. Native login/logout, signup/password-reset policy and
HTML/assets remain available. API-key authentication is resolved before this
classification because Frappe's request hook precedes its normal token check.

Trusted native Desk and native data-import changes to tracked masters/documents
also lock the workspace and register a single `before_commit` revision, audit
and snapshot in their original transaction. A workbench draft with the former
revision therefore receives HTTP 409 after a native Customer or accounting
change. Managed workbench actions/imports suppress this hook's extra bump. This
does not turn arbitrary administrator SQL writes into a supported import API;
use normal native document saves/imports so their validation and events run.

Snapshot restore is blocked with HTTP 409 once native order documents are linked,
including drafts; posted financial and stock documents must be reconciled or
amended through their native workflow, never overwritten by an old reference
archive.

## Verification

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s integrations/frappe_app/tests -v
```

These domain/contract tests verify scopes, recursive finance protection,
Grandware and generic calculations, typed historic preservation, native master
authority, frozen native FX, CAS, transaction rollback, direct-native permission
guards and lost-response receipt retry. They are separate from required real
Frappe installation, authenticated role/tenant/CSRF checks, simultaneous saves,
real standard-document posting, ledger verification and service restart
persistence acceptance.
