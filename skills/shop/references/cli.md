# CLI workflows

Use command help for shorthand. Do not mix shorthand with `--arguments`. For an offline plan, use supplied terms and IDs with `--dry-run`; defer live account/merchant preflight and sign-in until execution is authorized. Local validation does not establish merchant availability, card eligibility, or payment acceptance.

## Image search

Use `shop search --like-image photo.jpg`, optionally with a text query. Files and inline MIME/base64 accept JPEG, PNG, WebP, AVIF, or HEIC, not GIF or SVG. This is format-declaration checking, not image decoding.

The complete request must fit 4 MiB after base64 and JSON framing; a usable file is therefore smaller than 3 MiB, depending on other arguments and metadata. If a local `invalid_input` names the framing limit, resize the image or reduce other arguments before submitting again. No request was sent for that refusal.

## Cart to checkout

Create checkout from a returned cart:

```sh
shop checkout create --shop '<seller.domain>' --cart '<cart-id>'
```

The cart id stays exact; do not combine this form with item or buyer-country shorthand.

## Guarded edits

`cart update` and `checkout update` with `--patch` read, apply guarded RFC 6902, then send a full update. Each positional line edit needs a preceding `test` on the returned `/line_items/N/id`, not its variant `item.id`.

```sh
shop checkout update '<checkout-id>' --shop '<seller.domain>' --patch '[{"op":"test","path":"/line_items/0/id","value":"<line-id>"},{"op":"replace","path":"/line_items/0/quantity","value":2}]'
```

Replace placeholders with returned values. The guard checks local assumptions, not concurrent merchant edits.

## Complete a Shop checkout

Inspect the latest checkout returned by `checkout create`, `checkout update`, or `checkout get`, including its status, items, totals, messages, and `payment.instruments`. If it may be stale, call `checkout get` first. `ready_for_complete` is the authoritative signal that the current checkout may be completed through the API; `requires_escalation` means give the user its `continue_url`. Present the offered instruments to the user, confirm one exact instrument with the current purchase terms, then pass that complete instrument object exactly as returned:

```sh
shop checkout complete '<checkout-id>' --shop '<seller.domain>' --instrument @instrument.json
# Or pipe the exact JSON object on stdin and pass: --instrument -
```

Use `@FILE` or stdin for an object that contains a credential or other secret so it does not enter argv or shell history. Use inline JSON only when the complete instrument is demonstrably non-secret. The CLI preserves every instrument field and extension, sets only root `selected:true`, and sends exactly one `complete_checkout`; it does not fetch, preflight readiness, look up an id/handler/display value, choose a default, or accept multiple instruments. The merchant remains authoritative for freshness, readiness, and whether the instrument is still offered. Do not independently infer completion authority from the account's budget. Only a returned `completed` checkout with an order confirms the purchase. No separate spend request is needed for this checkout, even when buyer review opens in a browser. Never switch to a spend request after an API failure, timeout, decline, or escalation.

## Approve a purchase for browser checkout

Follow the spend-request flow in [transactions.md](transactions.md). Use command help for shorthand or exact argument mode.

Create the spend request with the purchase terms, selected saved card and spending limit, then share the returned `continue_url` unchanged for review and approval. After approval, run `shop spend-request get '<spend-request-id>' --wait 90` to get the payment credential. Use it unchanged in the website's checkout form. After the purchase attempt, use `shop spend-request complete` to report `success` or `error`, with order details when available or failure information for an error. On `auth_required`, follow the entrypoint's sign-in flow.

For file-based credential handoff, add `--output-file <path>` to get. The new file contains `{spend_request_id,instrument}` with the complete issued instrument. Stdout retains status and approved terms, replacing the instrument with `credential_output_file`. Give the file directly to the consuming program; do not print its contents into chat. Existing files are refused and the caller owns cleanup. POSIX files are created mode `0600`; on Windows, choose a directory with private ACLs. Browser-hosted Shop cannot export files. `--dry-run` creates nothing.
