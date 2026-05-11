import { homedir } from "os";
import { join, resolve } from "path";

function defaultAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

export function expandTildePath(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

export function getPiAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return defaultAgentDir();
  return resolve(expandTildePath(configured));
}

export function getIntercomDir(agentDir: string = getPiAgentDir()): string {
  return join(agentDir, "intercom");
}
