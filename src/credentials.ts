/**
 * Portable credential storage for Shelly Cloud auth_key.
 *
 * Stores credentials in ~/.shelly-mcp/credentials.json — works in any
 * MCP client (VS Code, Claude Desktop, Claude Code, Cursor, Codex, etc.)
 * without client-specific configuration.
 *
 * Resolution order for the auth key:
 *   1. Explicit parameter (tool argument)
 *   2. SHELLY_CLOUD_AUTH_KEY environment variable
 *   3. ~/.shelly-mcp/credentials.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".shelly-mcp");
const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials.json");

interface StoredCredentials {
  cloud_auth_key?: string;
  cloud_server?: string;
  updated_at?: string;
}

function readCredentialsFile(): StoredCredentials {
  if (!existsSync(CREDENTIALS_FILE)) {
    return {};
  }

  try {
    const raw = readFileSync(CREDENTIALS_FILE, "utf-8").trim();
    if (raw.length === 0) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as StoredCredentials;
    return {};
  } catch {
    return {};
  }
}

export function getStoredAuthKey(): string | undefined {
  const creds = readCredentialsFile();
  return typeof creds.cloud_auth_key === "string" && creds.cloud_auth_key.length > 0
    ? creds.cloud_auth_key
    : undefined;
}

export function getStoredServer(): string | undefined {
  const creds = readCredentialsFile();
  return typeof creds.cloud_server === "string" && creds.cloud_server.length > 0
    ? creds.cloud_server
    : undefined;
}

export function saveCredentials(authKey: string, server: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });

  const updated: StoredCredentials = {
    cloud_auth_key: authKey,
    cloud_server: server,
    updated_at: new Date().toISOString(),
  };

  writeFileSync(CREDENTIALS_FILE, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}

/**
 * Resolve the Shelly Cloud auth key from all available sources.
 * Priority: explicit param > env var > credential file.
 */
export function resolveAuthKey(explicit?: string): string | undefined {
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const fromEnv = process.env.SHELLY_CLOUD_AUTH_KEY?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }

  return getStoredAuthKey();
}

/**
 * Resolve the Shelly Cloud server from all available sources.
 * Priority: explicit param > env var > credential file.
 */
export function resolveServer(explicit?: string): string | undefined {
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const fromEnv = process.env.SHELLY_CLOUD_SERVER?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }

  return getStoredServer();
}

export function getCredentialsPath(): string {
  return CREDENTIALS_FILE;
}
