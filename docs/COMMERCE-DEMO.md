# Common Goods: one shop, two ways to work

Open **Commerce demo** in Fluid, or visit `http://127.0.0.1:5173/?demo=commerce` while the development server runs.

This is a working commerce example in the Rust reference host. Maya prefers a table of invoices. Leo prefers a feed of suggested reviews. Both interfaces use the same records and the same two grants: `orders:read` and `reviews:write`.

## A one-minute demonstration

1. Start with **Maya → Order desk**. Search for `C537203`: the actual dataset contains a £12.90 cancellation with two source lines.
2. Choose **Side by side**. The right-hand action feed turns that same cancellation into a suggested review, with a direct link to its original record.
3. Open its record in the feed, write a shared note, and choose **Mark reviewed**. The table's review status and counters update. The card leaves the active feed. Open the invoice in the table to see the same note.
4. Change Maya's interface to Action feed, then switch to Leo. Each client's chosen interface is saved independently. The records and review workflow remain shared.

The core idea is that an interface is a personal way into an application. Changing the interface does not copy the data or create another set of business rules.

## The real data pipeline

Source: Chen, D. (2015). _Online Retail_ [Dataset]. UCI Machine Learning Repository. [Dataset and documentation](https://archive.ics.uci.edu/dataset/352/online%2Bretail), [DOI](https://doi.org/10.24432/C5BW33). Dataset license: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

The source workbook has 541,909 transaction lines. The reproducible extract retains the first 500 distinct invoice numbers in workbook order and **every line** for those invoices: 9,735 lines dated 1–5 December 2010, across 14 countries. It does not trim line items in the middle of an invoice.

The importer decodes the original XLSX without external Python libraries. Rust groups its line items by invoice number, computes signed quantities and monetary totals, and retains the source spreadsheet row for each line. Unit prices use integer millionths of a pound; quantity times price is rounded to pence per line, half away from zero, then summed. Negative cancellation values remain negative.

The initial extract reconciles to:

| Measure                         |       Value |
| ------------------------------- | ----------: |
| Recorded non-cancellation sales | £179,660.79 |
| Recorded cancellations          |  −£3,580.58 |
| Net recorded value              | £176,080.21 |
| Invoices matching a review rule |         136 |

These values describe the chosen historical extract, not current retail activity or accounting conclusions.

## From records to suggested work

| Source condition                                       | Suggested review                  |
| ------------------------------------------------------ | --------------------------------- |
| Invoice begins with C, or a line has negative quantity | Reconcile a recorded cancellation |
| A line has a zero or negative price                    | Check a pricing exception         |
| A customer identifier is missing                       | Check the customer reference      |
| A non-cancellation invoice is worth at least £1,000    | Review a large order              |

One invoice can match more than one rule, but remains one shared invoice. The feed prioritizes cancellations, pricing exceptions, missing references, then large orders. Cards are a view over invoices, not duplicated task records.

Review state is a separate SQLite overlay: open, in progress, or resolved, with notes, a revision, and the last frontend/agent to update it. A review never rewrites source values, sends a message, issues a refund, or implies the historical retailer failed to act. Concurrent edits require the current expected version and reject stale writes.

## Public capabilities

- `orders.list`: search, country/type/review filters, sorting, and pagination.
- `orders.get`: the full invoice, source rows, computed reasons, and current shared review.
- `orders.summary`: attribution, rule definitions, totals, counts, and countries.
- `reviews.update`: version-checked status and note changes, with audit and revision in one transaction.

Every iframe and connected agent reaches the same Rust registry and grant checks. The Exposed tools page shows these capabilities. An external MCP client can use them after the user grants commerce access. The helper can also fork the complete frontend source through the existing interface editor.

## Personal interfaces and the current scope

Maya and Leo are **demo client profiles**, with their interface preferences stored separately in the browser. They are not authenticated team accounts. Multiple browser tabs can connect to the same local host; the URL identifies the selected demo client and optional frontend. Changes are shared through the host's revisions. A deployed multi-user product still needs authenticated user identities, server hosting, and user-level access policy.

The order desk and action feed are ordinary editable Fluid frontend artifacts, with no direct database access or bundled records in their JavaScript. `Make this yours` opens a fork in the normal source editor and permission-review flow. The original task workspace and custom interfaces remain available.

## Reproduce the source extract

```sh
python3 scripts/import-commerce.py --download
npm run build
```

The original archive stays in ignored `.fluid/datasets/`. The attributed extract is `src/commerce/data/retail.json`; its small provenance manifest is `source.json`. Both source checksums appear in **About the data**. Existing workspaces retain their imported immutable snapshot and review history; rebuilding does not reset them.

No Python installation is needed to run the packaged app. It contains the compiled Rust host and prepared real-data extract. Source data retains CC BY 4.0; the application code is MIT.

## Verification

Integration tests reconcile a known invoice and credit note to the source, sum all 500 invoices against the summary, verify changes from separate sessions and a standard MCP client, reject stale and unauthorized writes, and reopen persisted review state. The desktop test changes independent interface preferences, completes a review from one iframe, and verifies its status and note in the other.
