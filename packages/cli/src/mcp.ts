import { runMcpServer } from "@brna/mcp";

export async function runMcp(rest: string[]): Promise<void> {
  await runMcpServer(rest, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
