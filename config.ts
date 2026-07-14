import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getIntercomDir } from "./profile.js";

export type IntercomSurface = "full" | "bridge" | "off";

export interface IntercomConfig {
  /** Broker command used to spawn the broker process (e.g. "npx" or "bun") */
  brokerCommand: string;

  /** Arguments passed to the broker command before the broker script path */
  brokerArgs: string[];

  /** Require confirmation before non-reply sends from interactive sessions */
  confirmSend: boolean;

  /** Optional custom status suffix shown after automatic lifecycle status */
  status?: string;

  /** Enable/disable intercom (default: true) */
  enabled: boolean;

  /** Intercom tool surface to expose (default: full) */
  surface: IntercomSurface;

  /** Show reply hint in incoming messages (default: true) */
  replyHint: boolean;

  /** Render inbound message boxes in the TUI (default: true) */
  showIncomingMessages: boolean;
}

function getConfigPath(): string {
  return join(getIntercomDir(), "config.json");
}

const INTERCOM_SURFACES = ["full", "bridge", "off"] as const;

const defaults: IntercomConfig = {
  brokerCommand: "npx",
  brokerArgs: ["--no-install", "tsx"],
  confirmSend: false,
  enabled: true,
  surface: "full",
  replyHint: true,
  showIncomingMessages: true,
};

function parseSurface(value: unknown, source: string): IntercomSurface | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    console.warn(`Ignoring invalid intercom surface from ${source}: expected one of ${INTERCOM_SURFACES.join("|")}.`);
    return undefined;
  }

  if ((INTERCOM_SURFACES as readonly string[]).includes(value)) {
    return value as IntercomSurface;
  }

  console.warn(`Ignoring invalid intercom surface from ${source}: ${JSON.stringify(value)}. Expected one of ${INTERCOM_SURFACES.join("|")}.`);
  return undefined;
}

export function loadConfig(): IntercomConfig {
  const configPath = getConfigPath();
  const envSurfaceValue = process.env.PI_INTERCOM_SURFACE;
  const envSurface = parseSurface(envSurfaceValue, "PI_INTERCOM_SURFACE");
  const envSurfaceOverride = envSurfaceValue === undefined ? undefined : envSurface ?? "full";
  if (!existsSync(configPath)) {
    return envSurfaceOverride === undefined ? { ...defaults } : { ...defaults, surface: envSurfaceOverride };
  }
  
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object");
    }

    const parsedConfig = parsed as Record<string, unknown>;
    const config: IntercomConfig = { ...defaults };

    if (Object.hasOwn(parsedConfig, "brokerCommand")) {
      if (typeof parsedConfig.brokerCommand !== "string") {
        throw new Error(`"brokerCommand" must be a string`);
      }
      const brokerCommand = parsedConfig.brokerCommand.trim();
      if (!brokerCommand) {
        throw new Error(`"brokerCommand" must not be empty`);
      }
      config.brokerCommand = brokerCommand;
    }

    if (Object.hasOwn(parsedConfig, "brokerArgs")) {
      if (!Array.isArray(parsedConfig.brokerArgs)) {
        throw new Error(`"brokerArgs" must be an array`);
      }
      const brokerArgs: string[] = [];
      for (const arg of parsedConfig.brokerArgs) {
        if (typeof arg !== "string") {
          throw new Error(`"brokerArgs" items must be strings`);
        }
        brokerArgs.push(arg);
      }
      config.brokerArgs = brokerArgs;
    }

    if (Object.hasOwn(parsedConfig, "confirmSend")) {
      if (typeof parsedConfig.confirmSend !== "boolean") {
        throw new Error(`"confirmSend" must be a boolean`);
      }
      config.confirmSend = parsedConfig.confirmSend;
    }

    if (Object.hasOwn(parsedConfig, "enabled")) {
      if (typeof parsedConfig.enabled !== "boolean") {
        throw new Error(`"enabled" must be a boolean`);
      }
      config.enabled = parsedConfig.enabled;
    }

    if (Object.hasOwn(parsedConfig, "surface")) {
      const surface = parseSurface(parsedConfig.surface, `${configPath}#surface`);
      if (surface !== undefined) {
        config.surface = surface;
      }
    }

    if (Object.hasOwn(parsedConfig, "replyHint")) {
      if (typeof parsedConfig.replyHint !== "boolean") {
        throw new Error(`"replyHint" must be a boolean`);
      }
      config.replyHint = parsedConfig.replyHint;
    }

    if (Object.hasOwn(parsedConfig, "showIncomingMessages")) {
      if (typeof parsedConfig.showIncomingMessages !== "boolean") {
        throw new Error(`"showIncomingMessages" must be a boolean`);
      }
      config.showIncomingMessages = parsedConfig.showIncomingMessages;
    }

    if (Object.hasOwn(parsedConfig, "status")) {
      if (typeof parsedConfig.status !== "string") {
        throw new Error(`"status" must be a string`);
      }
      config.status = parsedConfig.status;
    }

    if (envSurfaceOverride !== undefined) {
      config.surface = envSurfaceOverride;
    }

    return config;
  } catch (error) {
    console.error(`Failed to load intercom config at ${configPath}:`, error);
    return envSurfaceOverride === undefined ? { ...defaults } : { ...defaults, surface: envSurfaceOverride };
  }
}
