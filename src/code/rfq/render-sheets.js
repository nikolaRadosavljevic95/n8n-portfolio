const q = $input.first().json.quote ?? $input.first().json;
const cur = q.currency || 'EUR';
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Europe/Belgrade' });

const REASONS = {
  CODE_DESCRIPTION_CONFLICT: (l) => `Code ${l.customer_code} points to ${l.sku} (${l.product_name}), but the description asks for something else.`,
  NO_MATCH: () => 'No product in the catalogue matches this description.',
  LOW_CONFIDENCE: () => 'The closest product is only a weak match.',
  AMBIGUOUS: () => 'Several products fit almost equally well.',
  UNIT_MISMATCH: (l) => `Unit "${l.unit_requested}" cannot be converted to the unit the product is sold in.`,
  NO_PRICE: () => 'The product has no valid price for this customer.',
  INVALID_QTY: () => 'Quantity is missing or not a positive number.',
};
const ACTIONS = {
  CODE_DESCRIPTION_CONFLICT: 'Ask the customer which rating they need',
  NO_MATCH: 'Source it elsewhere or decline the line',
  LOW_CONFIDENCE: 'Pick the right product or decline',
  AMBIGUOUS: 'Pick the right candidate',
  UNIT_MISMATCH: 'Confirm the quantity in the sales unit',
  NO_PRICE: 'Add a price or ask purchasing',
  INVALID_QTY: 'Confirm the quantity with the customer',
};

const ok = q.lines.filter((l) => l.status === 'OK');
const review = q.lines.filter((l) => l.status === 'REVIEW');
const statusText = q.status === 'READY'
  ? 'Ready to send'
  : q.status === 'NEEDS_MANUAL_ENTRY'
    ? 'No line items could be read automatically, enter them manually'
    : `Draft, ${review.length} line${review.length === 1 ? '' : 's'} need a decision (see Review sheet)`;

const quoteRows = [
  [{ v: `Quotation ${q.quote_no}`, s: 'title' }],
  ['Customer', { v: q.customer.name, s: 'bold' }],
  ['Date', fmtDate(q.created_at)],
  ['Status', { v: statusText, s: 'bold' }],
  ['Source', `${q.source_name} (parser: ${q.parser})`],
  [],
  ['Line', 'Customer code', 'SKU', 'Product', 'Qty', 'Unit', `Unit price (${cur})`, `Line total (${cur})`, 'Notes']
    .map((v) => ({ v, s: 'header' })),
];
const headerRow = quoteRows.length;
for (const l of ok) {
  quoteRows.push([
    { v: l.line_no, s: 'cell' },
    { v: l.customer_code || '', s: 'cell' },
    { v: l.sku, s: 'cell' },
    { v: l.product_name, s: 'wrap' },
    { v: num(l.qty_quoted), s: 'cell' },
    { v: l.sales_unit, s: 'cell' },
    { v: num(l.unit_price), s: 'money' },
    { v: num(l.line_total), s: 'money' },
    { v: (l.notes || []).join('; '), s: 'wrap' },
  ]);
}
const lastDataRow = quoteRows.length;
quoteRows.push([]);
quoteRows.push([null, null, null, null, null, null, { v: 'Net total', s: 'bold' }, { v: num(q.net_total), s: 'moneyBold' }]);
quoteRows.push([null, null, null, null, null, null, { v: 'VAT', s: 'bold' }, { v: num(q.vat_total), s: 'moneyBold' }]);
quoteRows.push([null, null, null, null, null, null, { v: 'Total incl. VAT', s: 'bold' }, { v: num(q.gross_total), s: 'moneyBold' }]);
quoteRows.push([]);
quoteRows.push([{ v: 'Prices come only from the approved price list. Lines on the Review sheet are not priced and not included in the totals.', s: 'muted' }]);

const reviewRows = [
  [{ v: `Lines that need a decision (${review.length})`, s: 'title' }],
  [{ v: 'Nothing on this sheet is priced. Resolve a line with POST /webhook/rfq/review/resolve { quote_no, line_no, sku, remember }.', s: 'muted' }],
  [],
  ['Line', 'Customer code', 'Requested', 'Qty', 'Unit', 'Why', 'Best candidates', 'Suggested action']
    .map((v) => ({ v, s: 'header' })),
];
for (const l of review) {
  const reasons = l.reasons || [];
  reviewRows.push([
    { v: l.line_no, s: 'review' },
    { v: l.customer_code || '', s: 'review' },
    { v: l.description, s: 'reviewWrap' },
    { v: num(l.qty_requested), s: 'review' },
    { v: l.unit_requested || '', s: 'review' },
    { v: reasons.map((r) => (REASONS[r] ? REASONS[r](l) : r)).join('\n'), s: 'reviewWrap' },
    { v: (l.candidates || []).map((c) => `${c.sku}  ${c.name}  (${Number(c.score).toFixed(2)})`).join('\n') || 'none', s: 'reviewWrap' },
    { v: [...new Set(reasons.map((r) => ACTIONS[r]).filter(Boolean))].join('; '), s: 'reviewWrap' },
  ]);
}
if (review.length === 0) reviewRows.push([{ v: 'No lines need review.', s: 'muted' }]);

return [{
  json: {
    quote: q,
    fileName: `${q.quote_no}.xlsx`,
    sheets: [
      {
        name: 'Quote',
        colWidths: [10, 20, 22, 48, 8, 8, 16, 18, 42],
        freezeRows: headerRow,
        autoFilter: { fromRow: headerRow, toRow: lastDataRow, cols: 9 },
        rows: quoteRows,
      },
      {
        name: 'Review',
        colWidths: [8, 16, 36, 8, 8, 46, 62, 34],
        freezeRows: 4,
        autoFilter: { fromRow: 4, toRow: 4 + review.length, cols: 8 },
        rows: reviewRows,
      },
    ],
  },
}];
