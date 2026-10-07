# shop

`shop` lets agents search millions of stores, build carts, check out and pay with the shopper's Shop account, and track orders. When a store has no agent checkout, the shopper can approve a purchase on Shop and the agent gets a card to pay at the merchant's own checkout.

## Contents

- [Install](#install)
- [Search for products](#search-for-products)
- [Sign in for personalization and accelerated checkout](#sign-in-for-personalization-and-accelerated-checkout)
- [Read the shopper's addresses and payment methods](#read-the-shoppers-addresses-and-payment-methods)
- [Create a pre-filled checkout](#create-a-pre-filled-checkout)
- [Complete the checkout](#complete-the-checkout)
- [Track the order](#track-the-order)
- [Approve a browser purchase](#approve-a-browser-purchase)
- [Direct MCP integration](#direct-mcp-integration)
- [Reference](#reference)

## Install

```sh
npm install --global @shopify/shop@latest
```

This installs the `shop` command and its agent skill. Then ask your agent:

> Find three rain jackets under US$100 that ship to the US.

A full purchase, from search to tracking, takes five commands:

```sh
shop search "trail running shoes" --ships-to US --limit 3
shop cart create --shop example-store.com --variant gid://shopify/ProductVariant/1001 --quantity 1
shop checkout create --shop example-store.com --cart gid://shopify/Cart/…
shop checkout complete gid://shopify/Checkout/… --shop example-store.com --instrument '…'
shop order search "trail running shoes"
```

## Search for products

```sh
shop search "trail running shoes" --ships-to US --currency USD --limit 3
```

<details>
<summary>Example output</summary>

```jsonc
{
  "ok": true, "v": 1,
  "data": {
    "products": [
      {
        "id": "gid://shopify/p/7Qk2mN9pR4sT6vW8xY0zA1",
        "title": "Ridgeline Trail Runner",
        "description": { "plain": "Lightweight trail running shoes with a grippy outsole…" },
        "variants": [{
          "id": "gid://shopify/ProductVariant/1001",
          "price": { "amount": 14500, "currency": "USD" },
          "availability": { "available": true },
          "options": [{ "name": "Size", "label": "10" }, { "name": "Color", "label": "Slate" }],
          "rating": { "value": 4.7, "scale_max": 5, "count": 212 },
          "seller": { "name": "Example Store", "url": "https://example-store.com", "domain": "example-store.myshopify.com" },
          "checkout_url": "https://example-store.com/cart/1001:1?…&payment=shop_pay"
        }]
      },
      // …two more products
    ],
    "pagination": { "has_next_page": true, "total_count": 1180 },
    "next": [
      "A featured variant may already answer the user's needs; use get_product only for other options or a concrete missing fact…",
      // …
    ]
  }
}
```

</details>

Prices are integers in the currency's minor units, so `14500` is US$145.00.

Beyond a text query, a search can be shaped three ways:

- Filters such as `--ships-to`, `--price-max` and `--size` are hard constraints.
- `--intent` describes what the shopper needs and steers the ranking.
- `--like-image` and `--like-id` find products similar to an image or to another product.

```sh
shop search --like-image ./jacket.jpg --ships-to US
shop search --like-id gid://shopify/p/7Qk2mN9pR4sT6vW8xY0zA1 --limit 3
shop search "trail shoes" --intent "wide feet, wet Pacific Northwest trails" --price-max 20000 --size 11
```

Every variant also has a `checkout_url`, a buy-now link to the merchant's checkout. A shopper signed in to Shop sees a one-tap review screen there. They can approve the purchase as it is, or change the delivery option, payment method, discounts, and more first.

## Sign in for personalization and accelerated checkout

Sign-in is optional: search, carts, and checkouts work without it. Signing in to Shop adds:

- Search results ranked using the shopper's own history.
- Carts and checkouts that arrive with the shopper's saved address and payment preference filled in.
- The account, checkout completion, order, and spend-request commands in the sections below.

```sh
shop account login --device-name "My Awesome Agent"
```

<details>
<summary>Example output</summary>

```json
{
  "ok": true, "v": 1,
  "data": {
    "signed_in": false,
    "pending": {
      "verification_uri": "https://accounts.shop.app/device",
      "verification_uri_complete": "https://accounts.shop.app/device?user_code=…",
      "user_code": "…",
      "expires_at": "…",
      "interval": 5
    }
  }
}
```

</details>

Signing in takes two runs of the same command:

1. With `--wait 0`, it returns a link and code right away. The agent shows them to the shopper.
2. With `--wait 90`, it waits up to 90 seconds for the shopper to approve on Shop and returns `signed_in: true` as soon as they do. If they haven't approved yet, it returns `signed_in: false` and the agent can run it again.

`--device-name` is the name Shop's approval page shows for the agent. Once the shopper approves, the CLI attaches the credential to every request.

## Read the shopper's addresses and payment methods

```sh
shop account
```

<details>
<summary>Example output</summary>

```jsonc
{
  "ok": true, "v": 1,
  "data": {
    "signed_in": true,
    "buyer": { "email": "ada@example.com" },
    "addresses": [{
      "id": "address-a", "type": "shipping_address",
      "first_name": "Ada", "last_name": "Lovelace",
      "street_address": "1 Example Way", "address_locality": "London", "address_country": "GB", "postal_code": "SW1A 1AA"
    }],
    "preferred_address_id": "address-a",
    "selectable_instruments": [{
      "id": "3f1e2d4c-5b6a-4789-8abc-def012345678",
      "type": "shop_pay",
      "display": { "funding_instrument": { "type": "card", "brand": "visa", "last_digits": "4242" } }
    }],
    "preferred_instrument_id": "3f1e2d4c-5b6a-4789-8abc-def012345678",
    "payment": { "instruments": [{ "type": "shop_pay", "display": { "limit": 10000, "remaining_amount": 8000, "renewal_type": "monthly" } }] }
    // …links, messages
  }
}
```

</details>

The response has the shopper's saved details, each with an `id`:

- `addresses`: saved delivery addresses. `preferred_address_id` is the one the shopper prefers.
- `selectable_instruments`: saved Shop Pay cards. `preferred_instrument_id` is the one the shopper prefers.
- `payment.instruments[].display`: a budget, if the shopper set one on shop.com and delegated it to agents. It shows the limit, how much remains, and how often it renews. Within that limit, the agent can complete purchases without asking for approval each time.

When a checkout needs a destination or a payment instrument, the agent passes one of these `id`s. It never types an address or asks for a card number.

## Create a pre-filled checkout

Create a cart, then turn it into a checkout:

```sh
shop cart create --shop example-store.com --variant gid://shopify/ProductVariant/1001 --quantity 1
shop checkout create --shop example-store.com --cart gid://shopify/Cart/…   # the response below
```

<details>
<summary>Example output</summary>

```jsonc
{
  "ok": true, "v": 1,
  "data": {
    "id": "gid://shopify/Checkout/…",
    "status": "ready_for_complete",
    "buyer": { "email": "ada@example.com", "phone_number": "+1555…" },
    "line_items": [{ "id": "line-a", "item": { "id": "gid://shopify/ProductVariant/1001", "title": "Ridgeline Trail Runner — Size 10, Slate", "price": 14500 }, "quantity": 1 }],
    "fulfillment": { "methods": [{ "type": "shipping", "selected_destination_id": "address-a", "groups": [{ "selected_option_id": "standard", "options": [ /* … */ ] }] }] },
    "totals": [{ "type": "subtotal", "amount": 14500 }, { "type": "fulfillment", "amount": 0 }, { "type": "tax", "amount": 1290 }, { "type": "total", "amount": 15790 }],
    "payment": { "instruments": [{ "id": "instrument-a", "handler_id": "shop_pay", "type": "shop_pay", "display": { "funding_instrument": { "brand": "visa", "last_digits": "4242" } } }] },
    "continue_url": "https://example-store.com/checkouts/…"
  }
}
```

</details>

The checkout's `status` says what happens next:

- `ready_for_complete`: nothing is missing. The contact details, delivery address, and Shop Pay card all came from the shopper's account.
- `requires_escalation`: something is missing. `messages[]` says what, and the shopper finishes at `continue_url`.

`--patch` is the efficient way to change a checkout. You write only the edit, as an RFC 6902 patch, and the CLI:

1. Reads the current checkout.
2. Applies the patch to that copy.
3. Sends the merchant the full updated document.

An edit to a line must first `test` that line's `id`. If the checkout changed after the CLI read it, the edit then fails instead of changing the wrong line:

```sh
shop checkout update gid://shopify/Checkout/… --shop example-store.com \
  --patch '[{"op":"test","path":"/line_items/0/id","value":"line-a"},{"op":"replace","path":"/line_items/0/quantity","value":2}]'
```

## Complete the checkout

Pass one of the instruments the checkout offered in `payment.instruments`. The CLI marks it selected and changes nothing else:

```sh
shop checkout complete gid://shopify/Checkout/… --shop example-store.com \
  --instrument '{"id":"instrument-a","handler_id":"shop_pay","type":"shop_pay","credential":{"type":"shop_token"}}'
```

<details>
<summary>Example output</summary>

```jsonc
{
  "ok": true, "v": 1,
  "data": {
    "status": "completed",
    "order": { "id": "gid://shopify/Order/…", "label": "#1042", "permalink_url": "https://example-store.com/…/orders/…" }
    // …line items, totals, payment as charged
  }
}
```

</details>

## Track the order

```sh
shop order search "trail runner"
```

<details>
<summary>Example output</summary>

```jsonc
{
  "ok": true, "v": 1,
  "data": {
    "orders": [{
      "id": "…", "label": "#1042", "placed_at": "…",
      "seller": { "name": "Example Store", "domain": "example-store.com" },
      "line_items": [{ "item": { "title": "Ridgeline Trail Runner — Size 10, Slate", "price": 14500 }, "quantity": { "original": 1, "fulfilled": 1 } }],
      "fulfillment": { "events": [{ "carrier": "UPS", "tracking_url": "https://…", "occurred_at": "…" }] },
      "permalink_url": "https://…"
    }],
    "shipments": [ /* standalone shipments Shop tracks without an order */ ]
    // …
  }
}
```

</details>

The results cover every order Shop tracks for the shopper, from any store. Leave out the query to get the most recent orders.

## Approve a browser purchase

Some stores have no agent checkout API (UCP); the agent has to enter a payment credential into the site's checkout form in a browser. A spend request covers that case — it is not a fallback for a Shop checkout that failed or needs the shopper:

1. The agent describes the purchase with `shop spend-request create`.
2. The shopper reviews and approves it on Shop.
3. The agent gets a card from `shop spend-request get`, good for up to the `approval_limit` the shopper saw and approved.
4. The agent pays at the merchant's checkout and reports the outcome with `shop spend-request complete`.

`--instrument-id` is one of the cards from `shop account`. Nested values such as line items take JSON, a `@file`, or `-` for stdin:

```sh
shop spend-request create \
  --business-name "Example Bookshop" --business-url https://example-bookshop.com --business-country US \
  --currency USD --approval-limit 1495 --instrument-id 3f1e2d4c-5b6a-4789-8abc-def012345678 \
  --line-item @items.json \
  --total '{"type":"total","amount":1495}'
```

```jsonc
// items.json
{ "item": { "title": "Field Notes, 3-pack", "price": 1495 }, "quantity": 1 }
```

<details>
<summary>Example output</summary>

```json
{
  "ok": true, "v": 1,
  "data": {
    "id": "0198e63b-1234-7abc-8def-123456789abc",
    "status": "pending",
    "approval_limit": 1495,
    "continue_url": "https://accounts.shop.app/…",
    "expires_at": "…"
  }
}
```

</details>

Give the shopper the `continue_url`, then wait for their approval. `--output-file` keeps the card out of the transcript: the issued instrument is written to a new file only you can read, and stdout carries the status and terms:

```sh
shop spend-request get 0198e63b-1234-7abc-8def-123456789abc --wait 90 --output-file ./card.json
```

<details>
<summary>Example output</summary>

```jsonc
{
  "ok": true, "v": 1,
  "data": {
    "status": "consumed",
    "credential_output_file": "./card.json"
    // …terms as approved
  }
}
```

```jsonc
// card.json
{
  "spend_request_id": "0198e63b-1234-7abc-8def-123456789abc",
  "instrument": {
    "type": "card",
    "display": { "last_digits": "…" },
    "credential": { "type": "pan", "number": "5556…", "expiry_month": "…", "expiry_year": "…", "cvv": "…", "name": "Ada Lovelace" },
    "billing_address": { "street_address": "1 Example Way", "address_locality": "London", "address_country": "GB", "postal_code": "SW1A 1AA" }
  }
}
```

</details>

The card arrives when the status is `consumed`. Hand the file to the program that fills the checkout form; without `--output-file`, the instrument is returned inline instead.

After paying at the merchant's checkout, the agent reports the outcome:

```sh
shop spend-request complete 0198e63b-1234-7abc-8def-123456789abc \
  --status success --order '{"id":"EB-20931","total":1495,"currency":"USD"}'
```

<details>
<summary>Example output</summary>

```json
{
  "ok": true, "v": 1,
  "data": { "id": "0198e63b-1234-7abc-8def-123456789abc", "result": { "status": "success", "recorded_at": "…" } }
}
```

</details>

The response only confirms that Shop recorded the report. It is not proof that the payment went through.

## Direct MCP integration

The CLI is a client of Shop's MCP server at `https://mcp.shop.com/`. Apart from sign-in, each command above calls one of its tools:

- Most commands send a single `tools/call`. `--patch` reads the checkout before it writes, and `--wait` polls.
- The CLI adds argument parsing, sign-in, and the JSON envelope.

To see the requests, or to call a tool by its MCP name:

```sh
shop checkout create --shop example-store.com --cart gid://shopify/Cart/… --dry-run    # the exact request, unsent
shop cart get gid://shopify/Cart/… --shop example-store.com --as curl                  # the exact request, as curl
shop call search_catalog --arguments '{"catalog":{"query":"rain jacket","pagination":{"limit":3}}}'   # any tool by MCP name
shop tools                                                                              # every command, its tool, its schema
```

To use the server without the CLI:

- Connect an MCP host to `https://mcp.shop.com/` to access the same tools. Sign-in goes through the host's OAuth flow, against the same Shop account, and the tools behave as they do in the CLI.
- A host that supports the skills extension ([SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension)) finds the server's skill with `skills/list` on the same connection and reads its files with `resources/read`, so there is nothing to install. This package bundles the same skill.

To install the skill from this repository:

```sh
npx skills add Shopify/shop
```

The npm package's install hook runs the same `skills add` on its bundled copy.

## Reference

```sh
shop --help                 # the command tree
shop search --help          # a command's flags and examples
shop search --schema        # its complete input schema
shop tools                  # every command with its MCP tool, usage and schema, as JSON — for agents
shop skill                  # the bundled agent guidance, as prose — what `npx skills add` installs
```

Every command accepts `--arguments <JSON|@FILE|->` with the complete argument object from `--schema`.

| Exit | Meaning |
| --- | --- |
| 0 | ok |
| 1 | no response from the network |
| 2 | usage error |
| 3 | sign-in required |
| 4 | the merchant or Shop answered with an error |

Errors use the same JSON envelope, and their `next` steps say what to do:

```json
{"ok":false,"v":1,"error":{"code":"auth_required","message":"Not signed in on this device","retryable":false,"next":["Run shop account login --wait 0 and show the shopper the verification URL and code","Run shop account login --wait 90 to finish once they approve","Retry this command after signing in"]}}
```

To install the bundled skill again without reinstalling the package, run `npx skills add "$(npm root -g)/@shopify/shop/skills/shop" -g -y`.
