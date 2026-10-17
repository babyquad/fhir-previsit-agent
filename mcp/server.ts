/**
 * The same read-only FHIR tools, exposed as an MCP server.
 *
 * Any MCP client (Claude Code, Claude Desktop, another team's agent) gets the
 * pre-visit coverage tools without reimplementing the FHIR client, the field
 * minimization, or the audit log.
 *
 *   bun mcp/server.ts        (stdio transport)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FhirClient, FhirError } from "../src/fhir";
import { shapes, TOOLS } from "../src/tools";

const fhir = new FhirClient();
const server = new McpServer({ name: "fhir-previsit", version: "0.1.0" });

for (const tool of TOOLS) {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: shapes[tool.name], annotations: { readOnlyHint: true } },
    async (input: unknown) => {
      try {
        const out = await tool.run(fhir, input);
        return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
      } catch (err) {
        const text = err instanceof FhirError ? `${err.message}${err.diagnostics ? `: ${err.diagnostics}` : ""}` : (err as Error).message;
        return { content: [{ type: "text" as const, text }], isError: true };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
