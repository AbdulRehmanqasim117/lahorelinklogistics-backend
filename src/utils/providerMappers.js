const pick = (obj, path, def) => {
  try {
    return path.split(".").reduce((o, k) => (o ? o[k] : undefined), obj) ?? def;
  } catch {
    return def;
  }
};

exports.mapShopify = (payload) => {
  const address1 =
    pick(payload, "shipping_address.address1", "") ||
    pick(payload, "shipping_address.address2", "") ||
    "";
  const city =
    pick(payload, "shipping_address.city", "") ||
    pick(payload, "shipping_address.province", "") ||
    "";
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];

  // Calculate total weight from line items (assuming weight is in grams, convert to kg)
  const totalWeight = lineItems.reduce((sum, item) => {
    const itemWeight = Number(item.grams || item.weight || 0) / 1000; // Convert grams to kg
    const quantity = Number(item.quantity || 1);
    return sum + itemWeight * quantity;
  }, 0);

  return {
    externalOrderId: String(payload.id || payload.order_number || ""),
    consigneeName: pick(payload, "shipping_address.name", ""),
    consigneePhone: pick(payload, "shipping_address.phone", ""),
    consigneeAddress: [address1, city].filter(Boolean).join(", "),
    destinationCity: city,
    codAmount: Number(payload.total_price || 0),
    productDescription: lineItems
      .map((i) => i.title)
      .filter(Boolean)
      .join(","),
    pieces: lineItems.length || 1,
    fragile: false,
    weightKg: Math.max(totalWeight, 0.1), // Minimum 0.1kg
    remarks: "Imported via Shopify",
  };
};

exports.mapWoo = (payload) => {
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];

  // Calculate total weight from line items
  const totalWeight = lineItems.reduce((sum, item) => {
    const itemWeight = Number(item.weight || 0); // WooCommerce usually stores weight in kg
    const quantity = Number(item.quantity || 1);
    return sum + itemWeight * quantity;
  }, 0);

  return {
    externalOrderId: String(pick(payload, "order.id", payload.id || "")),
    consigneeName: pick(payload, "billing.name", ""),
    consigneePhone: pick(payload, "billing.phone", ""),
    consigneeAddress: [
      pick(payload, "shipping.address_1", ""),
      pick(payload, "shipping.city", ""),
    ]
      .filter(Boolean)
      .join(", "),
    destinationCity: pick(payload, "shipping.city", ""),
    codAmount: Number(payload.total || 0),
    productDescription: lineItems
      .map((i) => i.name)
      .filter(Boolean)
      .join(","),
    pieces: lineItems.length || 1,
    fragile: false,
    weightKg: Math.max(totalWeight, 0.1), // Minimum 0.1kg
    remarks: "Imported via WooCommerce",
  };
};

exports.mapCustom = (payload) => ({
  externalOrderId: String(payload.externalOrderId || ""),
  consigneeName: payload.consigneeName || "",
  consigneePhone: payload.consigneePhone || "",
  consigneeAddress: payload.consigneeAddress || "",
  destinationCity: payload.destinationCity || "",
  codAmount: Number(payload.codAmount || 0),
  productDescription: payload.productDescription || "",
  pieces: Number(payload.pieces || 1),
  fragile: Boolean(payload.fragile || false),
  weightKg: Number(payload.weightKg || payload.weight || 0.1), // Support both weightKg and weight fields
  remarks: payload.remarks || "Imported via Custom",
});
