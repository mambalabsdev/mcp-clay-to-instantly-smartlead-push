# Sequencer Lead Push MCP Server

MCP server for the Mamba Labs [Sequencer Lead Push](https://apify.com/mambalabs/clay-to-instantly-smartlead-push) actor on Apify.

Push enriched lead rows into an existing Instantly or Smartlead campaign. ICP score gating and deduplication are built in, and a dry run shows you the exact payload before you send anything.

## Install

```bash
npx -y @mambalabsdev/mcp-clay-to-instantly-smartlead-push
```

### Claude Desktop

```json
{
  "mcpServers": {
    "mamba-clay-to-instantly-smartlead-push": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-clay-to-instantly-smartlead-push"],
      "env": { "APIFY_TOKEN": "your-apify-token" }
    }
  }
}
```

Get an Apify token at [console.apify.com/account/integrations](https://console.apify.com/account/integrations).

## Tool

### `push_leads_to_sequencer`

Maps your column names onto the sequencer's field names, drops leads below your ICP score threshold, drops leads already in the campaign, and sends the rest in batches.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `sequencer` | string | yes | `instantly` or `smartlead` |
| `campaign_id` | string | yes | The target campaign. It must already exist. |
| `api_key` | string | see note | Your Instantly v2 key or Smartlead key |
| `leads` | array | one of | Lead rows. Each needs an `email` at minimum. |
| `dataset_id` | string | one of | An Apify dataset ID from an upstream run |
| `min_icp_score` | number | no | Drop leads scoring below this. Default 0. |
| `deduplicate` | boolean | no | Check the campaign first. Default true. |
| `dry_run` | boolean | no | Preview without sending. Default false. |
| `field_mapping` | object | no | Override the default column map |
| `custom_variables` | array | no | Extra columns to pass through |

`api_key` is required for any run that calls the sequencer. A dry run with `deduplicate` false makes no calls at all and needs no key.

Returns one flat summary row: leads received, dropped for no usable email, dropped by the ICP gate, dropped as duplicates, eligible, created by the sequencer, skipped by the sequencer, and failed, with the vendor's own message per failed address.

## Dry run

`dry_run: true` runs every step, returns the exact request batches that would have been sent, and creates nothing. Nothing is billed.

Use it the first time you point at a new campaign. The payload you see is the real one, and your API key is never included in it.

## Billing

You are charged per lead the sequencer confirms it created. Leads dropped by the gate, dropped as duplicates, with no usable email, skipped or rejected by the vendor, and every lead in a dry run are all free.

Pricing is on the [actor's Apify page](https://apify.com/mambalabs/clay-to-instantly-smartlead-push). Running this server consumes Apify credits.

## Supported sequencers

| Sequencer | API | Notes |
| --- | --- | --- |
| Instantly | v2 | Needs a **v2** key. Keys from v1 do not work: Instantly deprecated v1 on January 19, 2026. |
| Smartlead | v1 | Current. Smartlead has no v2. |

## What this server does and does not do

It is a thin client for the Apify actor. It passes your input through and returns the actor's output. The field mapping, the ICP gate, the deduplication and everything either vendor's API needs all live in the actor, not here.

It writes to your sequencer campaign unless `dry_run` is true. It does not create campaigns and it does not write sequence copy.

## Related

Part of the Mamba Labs GTM actor fleet. The same tool is available alongside fourteen others in [`@mambalabsdev/mcp-gtm-suite`](https://www.npmjs.com/package/@mambalabsdev/mcp-gtm-suite).

Built by [Mamba Labs](https://apify.com/mambalabs)
