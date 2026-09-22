const item = $input.first();
const customerId = Number(String(item.json.customer || '').split(' ')[0]);
const binaryKey = Object.keys(item.binary || {})[0];
if (!binaryKey) {
  throw new Error('Please attach the RFQ as a PDF');
}

return [{
  json: { customer_id: customerId, source_name: item.binary[binaryKey].fileName },
  binary: { data: item.binary[binaryKey] },
}];
