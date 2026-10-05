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

// How long this wrapper waits for a run, in milliseconds. The run itself keeps
// the actor's own default timeout; past this wait the call returns the run id
// and console link instead of an error that hides a run still billing.
const WRAPPER_WAIT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = Number(process.env.MAMBA_POLL_INTERVAL_MS) || 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it while
// the run goes on and keeps billing. Starting the run, polling it to a terminal
// status and then reading the dataset waits as long as the actor needs.
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

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success, so a crashed run never reads as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

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
      "Push enriched lead rows into an existing Instantly, Smartlead, or HeyReach campaign. Maps common Clay column names onto each sequencer's own field names, optionally drops leads below a minimum ICP score, optionally deduplicates against the leads already in the destination campaign, and sends the rest in batches. Returns one flat summary row: how many leads were received, dropped for having no usable email, dropped by the ICP gate, dropped as duplicates, eligible, actually created by the sequencer, skipped by the sequencer, and failed, plus the vendor's own error message per failed address. The campaign must already exist; this does not create campaigns or write sequence copy. Set dry_run true to get back the exact request payload that would be sent without creating a single lead and without being charged, which is the safe way to check a mapping against a new campaign. Billing is per lead the sequencer confirms it created, so gated, duplicate, skipped, failed and dry-run leads are all free. Instantly uses API v2 and needs a v2 key; Smartlead uses API v1. Requires an APIFY_TOKEN and consumes Apify credits. This WRITES to your sequencer campaign unless dry_run is true.",
    annotations: {
      title: "Push Leads to Sequencer",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      sequencer: z
        .enum(["instantly", "smartlead", "heyreach"])
        .describe("Which sequencer to push to. Instantly uses API v2, Smartlead uses API v1, HeyReach uses its public API. HeyReach is LinkedIn native: it keys a lead on linkedin_person_url rather than on email, so a HeyReach run drops rows with no LinkedIn profile URL and keeps rows with no email at all."),
      api_key: z
        .string()
        .optional()
        .describe("Your Instantly v2 API key, your Smartlead API key or your HeyReach API key. An Instantly v1 key will not work: v1 was deprecated on January 19, 2026. Required for any run that calls the sequencer. A dry run with deduplicate false makes no calls and needs no key."),
      campaign_id: z
        .string()
        .describe("The target campaign in the sequencer. It must already exist. Instantly campaign IDs are UUIDs; Smartlead and HeyReach campaign IDs are numeric."),
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
