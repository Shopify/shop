# Transactions and account data

## Edit a cart or checkout

1. Read the resource with `get_cart` or `get_checkout`. Copy only the returned `cart` or `checkout` object, not the response envelope.
2. Find the intended line by its top-level `id`, not its variant `item.id`.
3. Exclude the response-only root `next`; remove fetched `signals` and `attribution`.
4. Change only the requested fields. Do not recalculate totals. Preserve unrelated fields and unknown extensions, including empty objects and arrays such as `payment.instruments`.
5. Call `update_cart` or `update_checkout` with `shop`, `id`, and the edited `cart` or `checkout`.
6. Verify returned items, quantities, prices, messages, and status.

The server removes schema-declared response-only fields. Do not reduce the document to changed fields.

Mutations accept `meta:{"idempotency-key":uuid}`. Reuse the UUID only for the same intended operation.

## Complete a checkout

1. Inspect the latest checkout returned by `create_checkout`, `update_checkout`, or `get_checkout`, including status, items, totals, messages, and `payment.instruments`. If it may be stale, call `get_checkout` first.
2. Treat checkout status as authoritative. Resolve `incomplete` messages. For `requires_escalation`, give the user its `continue_url`. Proceed only from `ready_for_complete`; do not recreate Checkout's eligibility decision from `get_account` budget data.
3. Present the offered instruments and have the user confirm one exact instrument with the current merchant, items, quantities, and total. Copy that full object exactly as returned, preserving every field and extension; never choose a default, resolve by id/handler/display, or invent a credential or token.
4. Send `complete_checkout` exactly once; never repeat it, even with the same idempotency key. Pass the exact object to the CLI, which adds only root `selected:true`; other bindings set that one root member before sending:

```text
{shop,id,checkout:{payment:{instruments:[exact_confirmed_instrument_with_selected_true]}}}
```

The merchant remains authoritative for freshness, readiness, and whether the instrument is still offered. A budget shown by `get_account` explains the user's delegated wallet settings; checkout status is the completion decision. No separate spend request is needed for `create_checkout` or `complete_checkout`, even when buyer review opens in a browser. API failure or escalation is not permission to switch to a spend request. Report every returned message and disclosure. Only a `completed` checkout with an order confirms purchase.

## Approve a purchase for browser checkout

Choose the purchase path before requesting approval. Shop search results already provide `seller.domain`; use Shop's structured checkout directly.

For a purchase URL, inspect its HTTP headers and HTML. A `powered-by` header naming Shopify, or `rel="buy"` with `dev.shopify.shop_pay` among its payment handlers, identifies a Shop checkout path: use Shop tools with that store. If neither appears on the page, inspect the checkout page before requesting approval.

Use a spend request when API checkout is unavailable and the agent needs to enter a payment credential into a website's checkout form using a browser. Do not use this as a fallback because API checkout failed or requires user escalation.

The buyer approves the payee, purchase terms, saved card and spending limit in Shop before the agent receives the credential.

Use `update_spend_request` with `{id,spend_request:{…},meta?}` to change the shipping address, items, totals, or spending limit. Omitted fields stay unchanged. Supplied arrays replace their previous values, and Wallet deep-merges address fields, unlike full-document cart/checkout updates. Wallet decides whether the request's current state allows the update; do not assume that buyer approval makes it editable.

1. Observe the actual payee and purchase terms.
2. Call `create_spend_request` once with `spend_request` containing the required payee `business{name,url,country}`, `currency`, total, and `approval_limit` in currency minor units. Omit `instrument_id` to use the account's preferred card; name one only when the user chose a different saved card (ids from `get_account.selectable_instruments[]`, shown by `display.funding_instrument.description` when present, otherwise brand and last digits). Include actual line items, shipping address, and `context.intent` when available. Never invent missing terms. The preferred card is not checkout `selected`, an eligibility guarantee, a credential, or purchase authorization; the user still approves the payee, terms, card, and ceiling in Shop.
3. Share the returned `continue_url` unchanged. If absent, say the spend request is waiting in Shop; never construct a review link.
4. With the CLI, run `shop spend-request get '<spend-request-id>' --wait 90`; with another binding, call `get_spend_request` again only after a successful `pending` result. After buyer approval, get returns the payment credential. This is not a read-only operation. Do not run checks concurrently. When a credential is delivered, the response includes `consumed` terms and an `instrument`.
5. Enter the issued `instrument`'s credential only into the reviewed website's checkout form. Use it exactly as returned and only for the approved purchase. Its `display` describes that issued card. Never repeat its number, expiry, CVV, or name in chat, logs, diagnostics, plans, or error text. `display.funding_instrument` is the user's saved card that pays: name that card to the user, and if the business needs to find the payment, offer the issued card's `display.last_digits`. Present either card's `description`, when present, as is; otherwise use its brand and last digits.
6. After the purchase attempt, call `complete_spend_request` with the observed `success` or `error`. Report success only from transaction evidence and include order details only if known. For an error, send the observed `failure_code` and optional `message`, preserving any unknown charge outcome. Never include a payment credential. This records your report, not payment confirmation. Follow the recovery section if report acceptance is uncertain.

`expires_at` is the spend request's deadline for its next step (`pending`: approve by; `approved`: retrieve the credential by), not the card's expiry. `consumed` without an `instrument` does not establish credential delivery or payment. Never create a replacement spend request merely to recover an uncertain issuance.

For create, a caller `meta.idempotency-key` identifies one exact intent. Without a key, each call is new: if no spend-request ID returned, report the outcome unknown and stop. Update and cancel may reuse their original key after uncertainty. `cancel_spend_request` cancels the spend request; this does not cancel/refund the purchase or revoke an issued credential.

## Recover a write

Trust returned state when it resolves the outcome. After a timeout or ambiguous write, read the resource first. Except for checkout completion and spend-request reporting, repeat only the exact original request with the same idempotency key; never start a new purchase or spend request to recover an uncertain one. If a create returned no ID and had no key, report the outcome unknown and stop. Preserve successful results from other merchants.

`complete_checkout` is excluded from repetition, even with the same key. After an uncertain completion, read `get_checkout`; only `completed` with an `order` confirms the purchase. Report any other state, or a failed read, as not confirmed; give the user a returned `continue_url` and stop. Never complete again or buy a replacement to recover it.

`complete_spend_request` has no idempotency key. If its recording is uncertain, report that uncertainty and stop rather than repeating the report. A later `get_spend_request` does not expose the stored report and cannot confirm that recording; it can also issue or return a credential.

## Use the user's Shop account

`get_account` reads the connected Shop identity and wallet: saved addresses, delegated spending budget, and saved payment methods and preferred card selection. For the card leg, absent `preferred_instrument_id` means no card result was returned; consult messages to distinguish an unavailable or skipped read from absent permission. Null means the list was checked and none was selectable, and a nonempty value names the first Wallet-ordered selectable card. `search_orders` reads the account's Shop-tracked order history. Use these operations to understand the user and complete their task; a successful `get_account` also confirms that Shop is connected.

On `auth_required`, follow the binding's sign-in path, then retry. A missing field means no result was returned; use messages to distinguish a skipped read from an unavailable one. An empty list means the field was checked and nothing was available. Use only returned information. Do not copy `buyer.email` into checkout. Copy a selected `addresses[]` entry unchanged when checkout needs a saved delivery address.

## Search orders

Use `search_orders` for personal orders. Sign-in is required. Do not ask for a merchant order ID first. Use query text for merchant, item, or order number.

| Optional field | Values |
|---|---|
| `activity` | `active` (not yet delivered), `past`, `all` (default). |
| `date_from`, `date_to` | Inclusive placement dates, `YYYY-MM-DD`. |
| `pagination` | `{limit?,cursor?}`; limit 1 to 25, default 10; copy returned cursors unchanged. |

Order prices and totals are integer minor units in the order's `currency`. `XXX` means no known currency; Shop order history uses hundredths, so `1250` represents `12.50` without a currency symbol. Distinguish line totals from a missing order total; never combine amounts with unknown or different currencies into one spending total.

Read returned events, expectations, tracking, and `permalink_url` when present. Even Shopify history can lack `checkout_id` and `permalink_url`; never construct these references or substitute an order ID. Missing data is unknown, not unpaid or undelivered. `quantity.total` is the reported remaining count; missing `quantity.original` does not establish the original checkout count. Use the latest carrier event for shipment status. “Fulfilled” or “label created” does not prove shipment or delivery. Each event's `status` is Shop's raw delivery status; `type` is its coarse, many-to-one UCP mapping. Use the raw status and carrier evidence for detailed shipment state, not `type` alone. Email-derived records can omit prices and tracking. Do not invent purchasable IDs from their line IDs. For a repeat purchase, verify current catalog options, stock, and price. Do not poll or retry throttled order searches. Merchant order lookup, returns, and order cancellation are unsupported.
