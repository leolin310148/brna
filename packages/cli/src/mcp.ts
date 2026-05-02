import { runMcpServer } from "@brna/mcp";

export async function runMcp(rest: string[]): Promise<void> {
  await runMcpServer(rest);
}
