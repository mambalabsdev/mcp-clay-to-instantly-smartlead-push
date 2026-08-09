#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }

    let message: string;
    switch (response.status) {
      case 401:
        message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
        break;
      case 402:
        message =
          "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
        break;
      case 408:
        message = `The ${actorLabel} run timed out after 300 seconds. Push fewer leads per call, or run the actor on Apify directly for larger jobs.`;
        break;
      default:
        message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  const items = await response.json();
  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-clay-to-instantly-smartlead-push",
  version: pkg.version,
});

// Sequencer Lead Push (immutable actor ID 0Jv27VeWM5tSZQs9x)
server.registerTool(
  "push_leads_to_sequencer",
  {
    title: "Push Leads to Sequencer",
    description:
      "Push enriched lead rows into an existing Instantly or Smartlead campaign. Maps common Clay column names onto each sequencer's own field names, optionally drops leads below a minimum ICP score, optionally deduplicates against the leads already in the destination campaign, and sends the rest in batches. Returns one flat summary row: how many leads were received, dropped for having no usable email, dropped by the ICP gate, dropped as duplicates, eligible, actually created by the sequencer, skipped by the sequencer, and failed, plus the vendor's own error message per failed address. The campaign must already exist; this does not create campaigns or write sequence copy. Set dry_run true to get back the exact request payload that would be sent without creating a single lead and without being charged, which is the safe way to check a mapping against a new campaign. Billing is per lead the sequencer confirms it created, so gated, duplicate, skipped, failed and dry-run leads are all free. Instantly uses API v2 and needs a v2 key; Smartlead uses API v1. Requires an APIFY_TOKEN and consumes Apify credits. This WRITES to your sequencer campaign unless dry_run is true.",
    annotations: {
      title: "Push Leads to Sequencer",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      sequencer: z
        .enum(["instantly", "smartlead"])
        .describe("Which sequencer to push to. Instantly uses API v2, Smartlead uses API v1."),
      api_key: z
        .string()
        .optional()
        .describe("Your Instantly v2 API key or your Smartlead API key. An Instantly v1 key will not work: v1 was deprecated on January 19, 2026. Required for any run that calls the sequencer. A dry run with deduplicate false makes no calls and needs no key."),
      campaign_id: z
        .string()
        .describe("The target campaign in the sequencer. It must already exist. Instantly campaign IDs are UUIDs; Smartlead campaign IDs are numeric."),
      leads: z
        .array(z.record(z.unknown()))
        .optional()
        .describe("Lead rows to push. Each row needs an email at minimum. Takes precedence over dataset_id when both are set."),
      dataset_id: z
        .string()
        .optional()
        .describe("An Apify dataset ID from an upstream run, for example the output of the ICP Fit Scorer. Used only when leads is empty."),
      min_icp_score: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Drop leads whose icp_score is below this number. Default 0, which pushes everything. Rows with no icp_score are always kept."),
      deduplicate: z
        .boolean()
        .optional()
        .describe("Read the campaign's existing leads first and drop any email already there. Default true. This is a read, so it needs an API key even on a dry run."),
      dry_run: z
        .boolean()
        .optional()
        .describe("Run every step, return the exact payload that would be sent, and make zero write calls. Creates no leads and charges nothing. Default false."),
      field_mapping: z
        .record(z.string())
        .optional()
        .describe("Override the default Clay column to sequencer field map. Keys are your column names, values are the sequencer field names. Set a value to an empty string to drop that column. A target the sequencer does not have is sent as a custom variable rather than rejected."),
      custom_variables: z
        .array(z.string())
        .optional()
        .describe("Extra column names to pass through as custom variables under their own name. Columns that are neither mapped nor listed here are dropped."),
    },
  },
  async ({ sequencer, api_key, campaign_id, leads, dataset_id, min_icp_score, deduplicate, dry_run, field_mapping, custom_variables }) => {
    const hasLeads = Array.isArray(leads) && leads.length > 0;
    const hasDataset = dataset_id !== undefined && dataset_id !== "";
    if (!hasLeads && !hasDataset) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide either leads (an array of lead rows) or dataset_id (an Apify dataset from an upstream run)." }],
      };
    }
    return runActor(
      "0Jv27VeWM5tSZQs9x",
      "Sequencer Lead Push",
      compact({
        sequencer,
        api_key,
        campaign_id,
        leads: hasLeads ? leads : undefined,
        dataset_id: hasLeads ? undefined : dataset_id,
        min_icp_score,
        deduplicate,
        dry_run,
        field_mapping,
        custom_variables,
      }),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
