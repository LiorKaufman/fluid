//! Real, attributed retail records with a separate, mutable review workflow.
//! Both the order table and action feed read these same invoices.
use crate::{diagnostics::storage_error as storage, input};
use fluid_protocol::{Result, RpcError};
use rusqlite::{Connection, OptionalExtension, params, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommerceSource {
    pub title: String,
    pub creator: String,
    pub citation: String,
    pub url: String,
    pub download_url: String,
    pub doi: String,
    pub license: String,
    pub license_url: String,
    pub archive_sha256: String,
    pub workbook_sha256: String,
    pub full_line_count: u32,
    pub sample_line_count: u32,
    pub sample_invoice_count: u32,
    pub selection: String,
    pub period_start: String,
    pub period_end: String,
    pub currency: String,
    pub money_method: String,
    pub notice: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceLine {
    row: u32,
    invoice_no: String,
    stock_code: String,
    description: String,
    quantity: i64,
    invoice_date: String,
    unit_price_micros: i64,
    customer_id: Option<String>,
    country: String,
}
#[derive(Deserialize)]
struct Extract {
    source: CommerceSource,
    lines: Vec<SourceLine>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrderItem {
    pub source_row: u32,
    pub stock_code: String,
    pub description: String,
    #[ts(type = "number")]
    pub quantity: i64,
    #[ts(type = "number")]
    pub unit_price_micros: i64,
    #[ts(type = "number")]
    pub line_pence: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReviewReason {
    pub code: String,
    pub title: String,
    pub detail: String,
    pub priority: u8,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OrderReview {
    pub status: String,
    pub version: u32,
    pub note: String,
    pub updated_at: Option<String>,
    pub last_actor: Option<String>,
}
impl Default for OrderReview {
    fn default() -> Self {
        Self {
            status: "open".into(),
            version: 0,
            note: String::new(),
            updated_at: None,
            last_actor: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RetailOrder {
    pub id: String,
    pub date: String,
    pub country: String,
    pub customer_id: Option<String>,
    pub kind: String,
    pub line_count: u32,
    #[ts(type = "number")]
    pub units: i64,
    #[ts(type = "number")]
    pub net_pence: i64,
    pub preview: String,
    pub reasons: Vec<ReviewReason>,
    pub review: OrderReview,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RetailOrderDetail {
    pub order: RetailOrder,
    pub items: Vec<OrderItem>,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RetailOrderPage {
    pub orders: Vec<RetailOrder>,
    pub total: u32,
    pub offset: u32,
    pub limit: u32,
}
#[derive(Deserialize)]
struct Pagination {
    #[serde(default = "default_page_size")]
    limit: u32,
    #[serde(default)]
    offset: u32,
}
fn default_page_size() -> u32 {
    30
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewUpdate {
    id: String,
    status: String,
    note: Option<String>,
    expected_version: u32,
}
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommerceSummary {
    pub source: CommerceSource,
    pub orders: u32,
    pub line_items: u32,
    #[ts(type = "number")]
    pub sales_pence: i64,
    #[ts(type = "number")]
    pub cancellations_pence: i64,
    #[ts(type = "number")]
    pub net_pence: i64,
    pub needs_review: u32,
    pub open_reviews: u32,
    pub in_progress_reviews: u32,
    pub resolved_reviews: u32,
    pub countries: Vec<String>,
    pub rules: Vec<ReviewReason>,
}

pub fn rules() -> Vec<ReviewReason> {
    [
        ("cancellation", "Reconcile a cancellation", "Invoice number begins with C, or a line has negative quantity. Verify the recorded credit; this is not a new refund request.", 0),
        ("pricing", "Check a pricing exception", "At least one source line has a zero or negative unit price. Review the source record before interpreting it as revenue.", 1),
        ("missing-customer", "Check the customer reference", "The source invoice has no customer ID. A missing identifier does not mean a customer needs to be contacted.", 2),
        ("large-order", "Review a large order", "A non-cancellation invoice has a recorded value of at least £1,000. This threshold is a demo review policy, not a source fact.", 3),
    ].into_iter().map(|(code,title,detail,priority)| ReviewReason { code:code.into(), title:title.into(), detail:detail.into(), priority }).collect()
}
fn pence(micros: i128) -> Result<i64> {
    let amount = ((micros.abs() + 5_000) / 10_000) * micros.signum();
    i64::try_from(amount).map_err(|_| {
        RpcError::new(
            "INVALID_DATASET",
            "A source amount exceeds the supported range.",
        )
    })
}
fn aggregate(lines: Vec<SourceLine>) -> Result<Vec<(RetailOrder, Vec<OrderItem>)>> {
    let mut groups = BTreeMap::<String, Vec<SourceLine>>::new();
    for line in lines {
        groups
            .entry(line.invoice_no.clone())
            .or_default()
            .push(line);
    }
    let all_rules = rules();
    groups
        .into_iter()
        .map(|(id, lines)| {
            let first = &lines[0];
            let mut order = RetailOrder {
                id: id.clone(),
                date: first.invoice_date.clone(),
                country: first.country.clone(),
                customer_id: first.customer_id.clone(),
                kind: if id.to_uppercase().starts_with('C') || lines.iter().any(|l| l.quantity < 0)
                {
                    "cancellation"
                } else {
                    "sale"
                }
                .into(),
                line_count: lines.len() as u32,
                units: 0,
                net_pence: 0,
                preview: lines
                    .iter()
                    .find(|l| !l.description.is_empty())
                    .map_or("Unlabelled source item", |l| l.description.as_str())
                    .into(),
                reasons: Vec::new(),
                review: OrderReview::default(),
            };
            let items = lines
                .iter()
                .map(|line| {
                    let value =
                        pence(i128::from(line.unit_price_micros) * i128::from(line.quantity))?;
                    order.net_pence = order.net_pence.checked_add(value).ok_or_else(|| {
                        RpcError::new("INVALID_DATASET", "Invoice value overflow.")
                    })?;
                    order.units = order.units.checked_add(line.quantity).ok_or_else(|| {
                        RpcError::new("INVALID_DATASET", "Invoice quantity overflow.")
                    })?;
                    Ok(OrderItem {
                        source_row: line.row,
                        stock_code: line.stock_code.clone(),
                        description: line.description.clone(),
                        quantity: line.quantity,
                        unit_price_micros: line.unit_price_micros,
                        line_pence: value,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            for rule in &all_rules {
                let applies = match rule.code.as_str() {
                    "cancellation" => order.kind == "cancellation",
                    "pricing" => lines.iter().any(|l| l.unit_price_micros <= 0),
                    "missing-customer" => lines.iter().any(|l| l.customer_id.is_none()),
                    "large-order" => order.kind == "sale" && order.net_pence >= 100_000,
                    _ => false,
                };
                if applies {
                    order.reasons.push(rule.clone());
                }
            }
            Ok((order, items))
        })
        .collect()
}

pub fn schema(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS commerce_orders(id TEXT PRIMARY KEY,ordered_at TEXT NOT NULL,country TEXT NOT NULL,kind TEXT NOT NULL,net_pence INTEGER NOT NULL,reasons_count INTEGER NOT NULL,priority INTEGER NOT NULL,search_text TEXT NOT NULL,record TEXT NOT NULL,items TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS commerce_date ON commerce_orders(ordered_at);
        CREATE INDEX IF NOT EXISTS commerce_priority ON commerce_orders(priority,ordered_at);
        CREATE INDEX IF NOT EXISTS commerce_country ON commerce_orders(country);
        CREATE TABLE IF NOT EXISTS commerce_reviews(order_id TEXT PRIMARY KEY REFERENCES commerce_orders(id),status TEXT NOT NULL CHECK(status IN ('open','in-progress','resolved')),version INTEGER NOT NULL,note TEXT NOT NULL,updated_at TEXT NOT NULL,last_actor TEXT NOT NULL);").map_err(storage)
}
/// One immutable imported snapshot; user review state is in a separate table.
fn ensure(db: &Connection) -> Result<()> {
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM metadata WHERE key='commerce.source')",
            [],
            |r| r.get(0),
        )
        .map_err(storage)?;
    if exists {
        return Ok(());
    }
    let extract: Extract =
        serde_json::from_str(include_str!("../../../src/commerce/data/retail.json"))
            .map_err(storage)?;
    let orders = aggregate(extract.lines)?;
    if orders.len() != extract.source.sample_invoice_count as usize {
        return Err(RpcError::new(
            "INVALID_DATASET",
            "Source invoice count does not match its provenance.",
        ));
    }
    let tx = db.unchecked_transaction().map_err(storage)?;
    // A second process may have initialized this database while we decoded the snapshot.
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM metadata WHERE key='commerce.source')",
            [],
            |r| r.get(0),
        )
        .map_err(storage)?;
    if !exists {
        let mut insert = tx
            .prepare_cached("INSERT INTO commerce_orders VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)")
            .map_err(storage)?;
        for (order, items) in orders {
            let searchable = format!(
                "{} {} {} {}",
                order.id,
                order.country,
                order.customer_id.as_deref().unwrap_or(""),
                items
                    .iter()
                    .map(|i| i.description.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            )
            .to_lowercase();
            insert
                .execute(params![
                    order.id,
                    order.date,
                    order.country,
                    order.kind,
                    order.net_pence,
                    order.reasons.len() as i64,
                    order.reasons.first().map_or(9, |r| r.priority),
                    searchable,
                    serde_json::to_string(&order).map_err(storage)?,
                    serde_json::to_string(&items).map_err(storage)?
                ])
                .map_err(storage)?;
        }
        tx.execute(
            "INSERT INTO metadata(key,value) VALUES('commerce.source',?1)",
            [serde_json::to_string(&extract.source).map_err(storage)?],
        )
        .map_err(storage)?;
    }
    tx.commit().map_err(storage)
}
const SELECT: &str = "SELECT o.record,COALESCE(r.status,'open'),COALESCE(r.version,0),COALESCE(r.note,''),r.updated_at,r.last_actor FROM commerce_orders o LEFT JOIN commerce_reviews r ON r.order_id=o.id";
fn read_order(row: &rusqlite::Row<'_>) -> rusqlite::Result<RetailOrder> {
    let record: String = row.get(0)?;
    let mut order: RetailOrder = serde_json::from_str(&record).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    order.review = OrderReview {
        status: row.get(1)?,
        version: row.get(2)?,
        note: row.get(3)?,
        updated_at: row.get(4)?,
        last_actor: row.get(5)?,
    };
    Ok(order)
}
pub fn list(db: &Connection, input: &Value) -> Result<RetailOrderPage> {
    let pagination: Pagination = input::parse(input.clone())?;
    ensure(db)?;
    let mut conditions = String::from(" WHERE 1=1");
    let mut values = Vec::<SqlValue>::new();
    for (key, field) in [("country", "o.country"), ("kind", "o.kind")] {
        if let Some(value) = input[key].as_str() {
            conditions.push_str(&format!(" AND {field}=?"));
            values.push(value.to_owned().into());
        }
    }
    if input["needsReview"] == true {
        conditions.push_str(" AND o.reasons_count>0");
    }
    if let Some(search) = input["search"].as_str().filter(|s| !s.is_empty()) {
        conditions.push_str(" AND instr(o.search_text,?)>0");
        values.push(search.to_lowercase().into());
    }
    match input["reviewStatus"].as_str() {
        Some("active") => {
            conditions.push_str(" AND o.reasons_count>0 AND COALESCE(r.status,'open')<>'resolved'")
        }
        Some(status @ ("open" | "in-progress" | "resolved")) => {
            conditions.push_str(" AND o.reasons_count>0 AND COALESCE(r.status,'open')=?");
            values.push(status.to_owned().into());
        }
        _ => {}
    }
    let from = " FROM commerce_orders o LEFT JOIN commerce_reviews r ON r.order_id=o.id";
    let total = db
        .query_row(
            &format!("SELECT COUNT(*){from}{conditions}"),
            rusqlite::params_from_iter(values.iter()),
            |r| r.get(0),
        )
        .map_err(storage)?;
    let sort = match input["sort"].as_str() {
        Some("value") => "ABS(o.net_pence) DESC,o.id",
        Some("priority") => "o.priority,o.ordered_at DESC,o.id",
        _ => "o.ordered_at DESC,o.id",
    };
    let limit = pagination.limit;
    let offset = pagination.offset;
    values.push(i64::from(limit).into());
    values.push(i64::from(offset).into());
    let orders = db
        .prepare_cached(&format!(
            "{SELECT}{conditions} ORDER BY {sort} LIMIT ? OFFSET ?"
        ))
        .map_err(storage)?
        .query_map(rusqlite::params_from_iter(values.iter()), read_order)
        .map_err(storage)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(storage)?;
    Ok(RetailOrderPage {
        orders,
        total,
        limit,
        offset,
    })
}
pub fn get(db: &Connection, id: &str) -> Result<RetailOrderDetail> {
    ensure(db)?;
    let order = db
        .query_row(&format!("{SELECT} WHERE o.id=?1"), [id], read_order)
        .optional()
        .map_err(storage)?
        .ok_or_else(|| RpcError::new("NOT_FOUND", "This source invoice does not exist."))?;
    let items: String = db
        .query_row("SELECT items FROM commerce_orders WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .map_err(storage)?;
    Ok(RetailOrderDetail {
        order,
        items: serde_json::from_str(&items).map_err(storage)?,
    })
}
pub fn summary(db: &Connection) -> Result<CommerceSummary> {
    ensure(db)?;
    let source: String = db
        .query_row(
            "SELECT value FROM metadata WHERE key='commerce.source'",
            [],
            |r| r.get(0),
        )
        .map_err(storage)?;
    let (orders,sales,cancellations,net,needed)=db.query_row("SELECT COUNT(*),COALESCE(SUM(CASE WHEN kind='sale' THEN net_pence ELSE 0 END),0),COALESCE(SUM(CASE WHEN kind='cancellation' THEN net_pence ELSE 0 END),0),COALESCE(SUM(net_pence),0),SUM(CASE WHEN reasons_count>0 THEN 1 ELSE 0 END) FROM commerce_orders",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(storage)?;
    let in_progress = db
        .query_row(
            "SELECT COUNT(*) FROM commerce_reviews WHERE status='in-progress'",
            [],
            |r| r.get::<_, u32>(0),
        )
        .map_err(storage)?;
    let resolved = db
        .query_row(
            "SELECT COUNT(*) FROM commerce_reviews WHERE status='resolved'",
            [],
            |r| r.get::<_, u32>(0),
        )
        .map_err(storage)?;
    let countries = db
        .prepare_cached("SELECT DISTINCT country FROM commerce_orders ORDER BY country")
        .map_err(storage)?
        .query_map([], |r| r.get(0))
        .map_err(storage)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(storage)?;
    let source: CommerceSource = serde_json::from_str(&source).map_err(storage)?;
    Ok(CommerceSummary {
        line_items: source.sample_line_count,
        source,
        orders,
        sales_pence: sales,
        cancellations_pence: cancellations,
        net_pence: net,
        needs_review: needed,
        open_reviews: needed - in_progress - resolved,
        in_progress_reviews: in_progress,
        resolved_reviews: resolved,
        countries,
        rules: rules(),
    })
}
/// Called inside the host's data + audit + revision transaction.
pub fn update_review(
    db: &Connection,
    input: &Value,
    label: &str,
    now: &str,
) -> Result<OrderReview> {
    let update: ReviewUpdate = input::parse(input.clone())?;
    let id = &update.id;
    let order = get(db, id)?.order;
    if order.reasons.is_empty() {
        return Err(RpcError::new(
            "INVALID_INPUT",
            "This invoice has no suggested review. Historical source data cannot be edited.",
        ));
    }
    let current = order.review;
    if update.expected_version != current.version {
        return Err(RpcError::new(
            "VERSION_CONFLICT",
            "Another client updated this review. Refresh the order before saving.",
        ));
    }
    let version = current
        .version
        .checked_add(1)
        .ok_or_else(|| RpcError::new("VERSION_CONFLICT", "Review version limit reached."))?;
    let status = &update.status;
    let note = update.note.as_deref().unwrap_or(&current.note);
    db.execute("INSERT INTO commerce_reviews(order_id,status,version,note,updated_at,last_actor) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(order_id) DO UPDATE SET status=excluded.status,version=excluded.version,note=excluded.note,updated_at=excluded.updated_at,last_actor=excluded.last_actor",params![id,status,version,note,now,label]).map_err(storage)?;
    Ok(OrderReview {
        status: status.into(),
        version,
        note: note.into(),
        updated_at: Some(now.into()),
        last_actor: Some(label.into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_math_preserves_credits_and_rounds_signed_half_pennies() {
        assert_eq!(pence(5_000).unwrap(), 1);
        assert_eq!(pence(-5_000).unwrap(), -1);
        let line = SourceLine {
            row: 2,
            invoice_no: "C1".into(),
            stock_code: "SKU".into(),
            description: "Real source item".into(),
            quantity: -2,
            invoice_date: "2010-12-01T08:00:00".into(),
            unit_price_micros: 2_550_000,
            customer_id: None,
            country: "UK".into(),
        };
        let (order, items) = aggregate(vec![line]).unwrap().remove(0);
        assert_eq!(order.net_pence, -510);
        assert_eq!(order.units, -2);
        assert_eq!(items[0].source_row, 2);
        assert_eq!(
            order
                .reasons
                .iter()
                .map(|r| r.code.as_str())
                .collect::<Vec<_>>(),
            vec!["cancellation", "missing-customer"]
        );
    }
}
