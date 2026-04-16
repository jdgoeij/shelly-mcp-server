import type { DiscoveredShelly } from "./discovery.js";

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

export interface CloudClientOptions {
  authKey: string;
  server: string;
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CloudDevice {
  id: string;
  name?: string;
  room?: string;
  online?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function normalizeMac(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  return compact.length === 12 ? compact : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toCloudDeviceId(value: string): string {
  return value.toLowerCase();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function extractCloudDeviceIdCandidate(device: DiscoveredShelly): string | undefined {
  const fromSaved = normalizeMac(device.cloudDeviceId);
  if (fromSaved) return toCloudDeviceId(fromSaved);

  const fromMac = normalizeMac(device.mac);
  if (fromMac) return toCloudDeviceId(fromMac);

  const trailingHex = device.id?.match(/([a-fA-F0-9]{12})$/)?.[1];
  if (trailingHex) return toCloudDeviceId(trailingHex);

  return undefined;
}

function extractCloudRoom(settings: Record<string, unknown> | null): string | undefined {
  if (!settings) return undefined;

  const device = asRecord(settings.device);
  const deviceInfo = asRecord(settings.DeviceInfo);
  const sys = asRecord(settings.sys);

  return (
    getString(device?.room) ??
    getString(device?.location_name) ??
    getString(deviceInfo?.room) ??
    getString(deviceInfo?.location_name) ??
    getString(sys?.room) ??
    getString(sys?.location_name) ??
    getString(settings.room) ??
    getString(settings.location_name)
  );
}

// ---------------------------------------------------------------------------
// Auth-key API calls
// ---------------------------------------------------------------------------

async function cloudPost(server: string, path: string, authKey: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const url = `https://${server}/${path}?auth_key=${encodeURIComponent(authKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Shelly Cloud HTTP ${response.status} for ${path}: ${text}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Fetch device states in v2 batches (up to 10 ids / request, 1 request / second)
// ---------------------------------------------------------------------------

async function fetchDeviceStatesBatched(deviceIds: string[], options: CloudClientOptions): Promise<CloudDevice[]> {
  const uniqueIds = [...new Set(deviceIds)];
  if (uniqueIds.length === 0) return [];

  const results: CloudDevice[] = [];
  const batches = chunk(uniqueIds, 10);

  for (let index = 0; index < batches.length; index += 1) {
    if (index > 0) {
      await delay(1000);
    }

    const ids = batches[index];
    const raw = await cloudPost(
      options.server,
      "v2/devices/api/get",
      options.authKey,
      {
        ids,
        select: ["settings"],
        pick: {
          settings: ["DeviceInfo", "device", "sys", "room", "location_name"],
        },
      },
      options.timeoutMs
    );

    const states = Array.isArray(raw) ? raw : [raw];
    for (const entry of states) {
      const obj = asRecord(entry);
      if (!obj) continue;

      const id = getString(obj.id);
      if (!id) continue;

      const settings = asRecord(obj.settings);
      const deviceInfo = asRecord(settings?.DeviceInfo);
      results.push({
        id,
        name: getString(deviceInfo?.name),
        room: extractCloudRoom(settings),
        online: obj.online === true || obj.online === 1,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Enrich discovered devices with cloud names + rooms
// ---------------------------------------------------------------------------

export async function enrichDiscoveredDevicesWithCloud(
  devices: DiscoveredShelly[],
  options: CloudClientOptions
): Promise<DiscoveredShelly[]> {
  if (devices.length === 0) return devices;

  const cloudIds = devices
    .map((device) => extractCloudDeviceIdCandidate(device))
    .filter((value): value is string => Boolean(value));

  const cloudDevices = await fetchDeviceStatesBatched(cloudIds, options).catch((e) => {
    console.error(`[shelly-mcp] Cloud v2 device fetch failed: ${e instanceof Error ? e.message : e}`);
    return [] as CloudDevice[];
  });

  if (cloudDevices.length === 0) return devices;

  const byId = new Map<string, CloudDevice>();
  for (const d of cloudDevices) {
    const cloudId = normalizeMac(d.id);
    if (cloudId) byId.set(toCloudDeviceId(cloudId), d);
  }

  return devices.map((device) => {
    const requestId = extractCloudDeviceIdCandidate(device);
    const match = requestId ? byId.get(requestId) : undefined;
    if (!match) return device;

    return {
      ...device,
      cloudDeviceId: match.id,
      cloudName: match.name,
      cloudRoom: match.room,
      cloudMatchedBy: "id" as const,
    };
  });
}
