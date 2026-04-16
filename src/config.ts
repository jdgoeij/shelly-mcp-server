import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const ShellyDeviceSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  room: z.string().min(1).optional(),
  friendlyName: z.string().min(1).optional(),
  primaryComponentName: z.string().min(1).optional(),
  componentNames: z.record(z.string().min(1)).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  ip: z.string().min(1).optional(),
  deviceId: z.string().min(1).optional(),
  mac: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  gen: z.number().int().positive().optional(),
  app: z.string().min(1).optional(),
  firmwareVersion: z.string().min(1).optional(),
  authRequired: z.boolean().optional(),
  componentIds: z
    .object({
      switch: z.array(z.number().int().nonnegative()).default([]),
      cover: z.array(z.number().int().nonnegative()).default([]),
      light: z.array(z.number().int().nonnegative()).default([]),
      input: z.array(z.number().int().nonnegative()).default([]),
    })
    .optional(),
  capabilities: z
    .object({
      supportsSwitch: z.boolean(),
      supportsCover: z.boolean(),
      supportsLight: z.boolean(),
      supportsInput: z.boolean(),
      supportsPowerMetering: z.boolean(),
    })
    .optional(),
  suggestedActions: z.array(z.string().min(1)).optional(),
  enrichedAt: z.string().min(1).optional(),
});

const ConfigSchema = z.object({
  devices: z.array(ShellyDeviceSchema).default([]),
  timeoutMs: z.number().int().positive().default(5000),
});

export type ShellyDevice = z.infer<typeof ShellyDeviceSchema>;
export type ShellyConfig = z.infer<typeof ConfigSchema>;

function parseDevicesJson(raw: string, source: string): ShellyDevice[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    return z.array(ShellyDeviceSchema).parse(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${source}: ${message}`);
  }
}

export function loadConfig(): ShellyConfig {
  const timeoutMs = Number(process.env.SHELLY_TIMEOUT_MS ?? "5000");

  const devicesRaw = process.env.SHELLY_DEVICES?.trim();
  const devicesFile = process.env.SHELLY_DEVICES_FILE?.trim();

  let devices: ShellyDevice[] = [];
  if (devicesFile) {
    if (!existsSync(devicesFile)) {
      mkdirSync(path.dirname(devicesFile), { recursive: true });
      writeFileSync(devicesFile, "[]\n", "utf-8");
    }

    const fileContents = readFileSync(devicesFile, "utf-8");
    devices = parseDevicesJson(fileContents, `file ${devicesFile}`);
  } else if (devicesRaw) {
    devices = parseDevicesJson(devicesRaw, "SHELLY_DEVICES");
  }

  return ConfigSchema.parse({ devices, timeoutMs });
}

export function findDevice(devices: ShellyDevice[], name: string): ShellyDevice {
  const found = devices.find(
    (device) => device.name.toLowerCase() === name.toLowerCase()
  );

  if (!found) {
    const known = devices.length > 0 ? devices.map((d) => d.name).join(", ") : "(none configured)";
    throw new Error(`Unknown device '${name}'. Known devices: ${known}`);
  }

  return found;
}
