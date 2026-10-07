# Additional catalog inputs

Use these fields only when the request needs them. Add them inside `catalog`; keep the outer `{catalog:...}` object. All fields below are optional. The shapes are notation, not JSON.

| Field | Shape and meaning |
|---|---|
| `context.language`, `context.intent` | Language code and buyer intent text. |
| `filters.categories` | `[taxonomy_id]`; category alternatives. |
| `filters.condition` | `["new","secondhand"]`; condition alternatives. |
| `filters.ships_from` | `[{country:"CA"}]`; origin alternatives, not delivery destinations. |
| `filters.price_tier` | Search only: `["low","medium","high"]`; category-relative tiers, not money limits. |
| `filters.rating` | Search only: `{variant:{min?,min_count?}}`; score 0 to 5 and minimum review count. |
| `filters.available` | `false` includes unavailable items; it does not select only unavailable items. |

Rating thresholds require at least one matching variant, not a product-wide average. Category, condition, origin, and price-tier lists use OR. Different filters use AND. Use known taxonomy IDs and condition values. Read messages for unsupported values. Country codes use two uppercase letters. Currency codes use three uppercase letters. Price bounds are inclusive nonnegative integers in the currency's minor units. Destination and `$` do not establish currency; ask before applying a firm cap when currency is unknown. If returned currency differs from the cap, do not convert or claim compliance; report the mismatch. Product price bounds apply per selected unit unless the user states an order-level budget. For identical units, total divided by quantity is a safe discovery ceiling; enforce the merchant-returned checkout total.

## Select options

Use `get_product` with exact option names and labels from the product:

```json
{"catalog":{"id":"gid://shopify/Product/1","selected":[{"name":"Size","label":"M"},{"name":"Color","label":"Black"}],"context":{"address_country":"CA","currency":"CAD"}}}
```

- Replace the illustrative ID with the returned product ID.
- Read the effective selection even when no warning appears; an unavailable combination can lose a requested option.
- If the user permits alternatives, add `preferences:[option_name]` to `get_product`. List option names from most to least important; relaxation starts at the end.
- Never relax a hard requirement. Search has no `preferences` field.
- Use exact-product facts for care, dimensions, compatibility, and pack size.
- Keep each rating's score, scale, count, and source together, and say whether it belongs to the product or variant.
