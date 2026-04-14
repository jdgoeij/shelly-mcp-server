#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { saveCredentials, getCredentialsPath } from "./credentials.js";

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

async function validateCredentials(authKey: string, server: string): Promise<{ deviceCount: number }> {
  const url = `https://${server}/interface/device/list?auth_key=${encodeURIComponent(authKey)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} — check your auth_key and server.`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (body.isok !== true) {
    throw new Error(`API error: ${JSON.stringify(body.errors ?? body)}`);
  }
  const data = body.data as Record<string, unknown> | undefined;
  const devices = Array.isArray(data?.devices) ? data.devices : [];
  return { deviceCount: devices.length };
}

async function main(): Promise<void> {
  console.log("\n  Shelly Cloud Setup\n  ==================\n");
  console.log("  You need your auth_key and cloud server hostname.");
  console.log("  Find these at: https://my.shelly.cloud/ → User Settings\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const authKey = await prompt(rl, "  auth_key: ");
    if (!authKey) {
      console.error("  ✗ No auth_key provided.");
      process.exit(1);
    }

    const server = await prompt(rl, "  Cloud server (e.g. shelly-205-eu.shelly.cloud): ");
    if (!server) {
      console.error("  ✗ No server provided.");
      process.exit(1);
    }

    console.log("\n  → Validating...");
    const { deviceCount } = await validateCredentials(authKey, server);

    saveCredentials(authKey, server);

    const credsPath = getCredentialsPath();
    console.log(`  ✓ Connected! Found ${deviceCount} device(s) on ${server}`);
    console.log(`  ✓ Saved to ${credsPath}\n`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`\n  ✗ ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});