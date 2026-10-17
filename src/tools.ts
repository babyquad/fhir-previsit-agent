/**
 * The agent's tool surface, defined once and shared by the Claude agent loop
 * (src/agent.ts) and the MCP server (mcp/server.ts).
 *
 * Every tool is READ-ONLY. The agent can look things up and build a worklist;
 * it cannot write to the EHR or contact anyone. Inputs are validated with zod
 * before a tool runs, because model output is untrusted.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { FhirClient } from "./fhir";
import { buildWorklist, findPatients, getCoverage, listAppointments } from "./previsit";

const patientId = z
  .string()
  .regex(/^[A-Za-z0-9\-.]{1,64}$/, "FHIR logical ids are 1-64 chars of letters, digits, '-' and '.'")
  .describe("The FHIR Patient id returned by find_patient.");
const days = z.number().int().min(1).max(90).describe("How many days ahead to look. Use 14 if the user did not say.");

export const shapes = {
  find_patient: { name: z.string().min(2).max(100).describe("Full or partial patient name.") },
  list_appointments: { patient_id: patientId, days },
  get_coverage: { patient_id: patientId },
  build_previsit_worklist: { days },
};

type ToolName = keyof typeof shapes;

export type ToolDef = {
  name: ToolName;
  title: string;
  description: string;
  run: (fhir: FhirClient, input: unknown) => Promise<unknown>;
};

function def<N extends ToolName>(
  name: N,
  title: string,
  description: string,
  run: (fhir: FhirClient, input: z.infer<z.ZodObject<(typeof shapes)[N]>>) => Promise<unknown>,
): ToolDef {
  const schema = z.object(shapes[name]).strict();
  // async, so a validation failure is a rejected promise like any other tool error.
  return { name, title, description, run: async (fhir, input) => run(fhir, schema.parse(input) as never) };
}

export const TOOLS: ToolDef[] = [
  def(
    "find_patient",
    "Find a patient",
    "Look up patients by name. Returns id, name and birth year only. Use this first to get the patient_id the other tools need. If several patients match, ask the user which one rather than guessing.",
    (fhir, { name }) => findPatients(fhir, name),
  ),
  def(
    "list_appointments",
    "List a patient's upcoming appointments",
    "Upcoming (proposed, pending or booked) appointments for one patient within the next N days, soonest first.",
    (fhir, { patient_id, days }) => listAppointments(fhir, patient_id, days),
  ),
  def(
    "get_coverage",
    "Get a patient's insurance on file",
    "Insurance coverage on file for one patient: status, payer, plan, coverage period and the last 4 of the member id. This is what the EHR has on file, not a live check with the payer.",
    (fhir, { patient_id }) => getCoverage(fhir, patient_id),
  ),
  def(
    "build_previsit_worklist",
    "Build the pre-visit coverage worklist",
    "Check every upcoming visit in the next N days against the coverage on file and return a worklist. Visits that need staff action (no coverage, coverage not active, coverage ending before the visit) come first, each with a recommended action. Use this for any question about the whole schedule.",
    (fhir, { days }) => buildWorklist(fhir, days),
  ),
];

export const toolByName = new Map(TOOLS.map((t) => [t.name as string, t]));

/** JSON Schema for the Claude API, written out because zod 3 has no built-in exporter. */
const JSON_SCHEMAS: Record<ToolName, Anthropic.Beta.BetaTool.InputSchema> = {
  find_patient: {
    type: "object",
    properties: { name: { type: "string", description: "Full or partial patient name." } },
    required: ["name"],
    additionalProperties: false,
  },
  list_appointments: {
    type: "object",
    properties: {
      patient_id: { type: "string", description: "The FHIR Patient id returned by find_patient." },
      days: { type: "integer", description: "How many days ahead to look (1-90). Use 14 if the user did not say." },
    },
    required: ["patient_id", "days"],
    additionalProperties: false,
  },
  get_coverage: {
    type: "object",
    properties: { patient_id: { type: "string", description: "The FHIR Patient id returned by find_patient." } },
    required: ["patient_id"],
    additionalProperties: false,
  },
  build_previsit_worklist: {
    type: "object",
    properties: {
      days: { type: "integer", description: "How many days ahead to look (1-90). Use 14 if the user did not say." },
    },
    required: ["days"],
    additionalProperties: false,
  },
};

export const CLAUDE_TOOLS: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: JSON_SCHEMAS[t.name],
  strict: true,
}));
