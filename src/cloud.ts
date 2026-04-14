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
  roomId?: number;
  online?: boolean;
}

interface CloudRoom {
  id: number;
  name: string;
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

// ---------------------------------------------------------------------------
// Auth-key API calls
// ---------------------------------------------------------------------------

async function cloudGet(server: string, path: string, authKey: string, timeoutMs: number): Promise<unknown> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://${server}/${path}${sep}auth_key=${encodeURIComponent(authKey)}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Shelly Cloud HTTP ${response.status} for ${path}: ${text}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Fetch device list (returns cloud names + room_ids)
// ---------------------------------------------------------------------------

async function fetchDeviceList(options: CloudClientOptions): Promise<CloudDevice[]> {
  const raw = await cloudGet(options.server, "interface/device/list", options.authKey, options.timeoutMs);
  const root = asRecord(raw);
  if (root?.isok !== true) {
    const errors = root?.errors ? JSON.stringify(root.errors) : "unknown";
    throw new Error(`Shelly Cloud interface/device/list error: ${errors}`);
  }

  const data = asRecord(root.data);
  const devicesArr = data?.devices;
  if (!Array.isArray(devicesArr)) return [];

  const result: CloudDevice[] = [];
  for (const entry of devicesArr) {
    const obj = asRecord(entry);
    if (!obj) continue;
    const id = typeof obj.id === "string" ? obj.id : undefined;
    if (!id) continue;
    result.push({
      id,
      name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : undefined,
      roomId: typeof obj.room_id === "number" ? obj.room_id : undefined,
      online: obj.online === true || obj.online === 1,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fetch room list (returns room id → name mapping)
// ---------------------------------------------------------------------------

async function fetchRoomList(options: CloudClientOptions): Promise<Map<number, string>> {
  const raw = await cloudGet(options.server, "interface/room/list", options.authKey, options.timeoutMs);
  const root = asRecord(raw);
  if (root?.isok !== true) return new Map();

  const data = asRecord(root.data);
  const rooms = asRecord(data?.rooms);
  if (!rooms) return new Map();

  const result = new Map<number, string>();
  for (const [idStr, roomValue] of Object.entries(rooms)) {
    const roomObj = asRecord(roomValue);
    if (!roomObj) continue;
    const name = typeof roomObj.name === "string" ? roomObj.name.trim() : undefined;
    if (name) result.set(Number(idStr), name);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Enrich discovered devices with cloud names + rooms
// ---------------------------------------------------------------------------

export async function enrichDiscoveredDevicesWithCloud(
  devices: DiscoveredShelly[],
  options: CloudClientOptions
): Promise<DiscoveredShelly[]> {
  if (devices.length === 0) return devices;

  // Fetch both in parallel; treat failures as non-fatal (e.g. rate limits)
  const [cloudDevices, roomMap] = await Promise.all([
    fetchDeviceList(options).catch((e) => {
      console.error(`[shelly-mcp] Cloud device list failed: ${e instanceof Error ? e.message : e}`);
      return [] as CloudDevice[];
    }),
    fetchRoomList(options).catch((e) => {
      console.error(`[shelly-mcp] Cloud room list failed: ${e instanceof Error ? e.message : e}`);
      return new Map<number, string>();
    }),
  ]);

  if (cloudDevices.length === 0) return devices;

  // Build lookup by normalized MAC (cloud device id is a hex MAC)
  const byMac = new Map<string, CloudDevice>();
  for (const d of cloudDevices) {
    const mac = normalizeMac(d.id);
    if (mac) byMac.set(mac, d);
  }

  return devices.map((device) => {
    const deviceMac = normalizeMac(device.mac) ?? normalizeMac(device.id);
    const match = deviceMac ? byMac.get(deviceMac) : undefined;
    if (!match) return device;

    const roomName = match.roomId != null ? roomMap.get(match.roomId) : undefined;

    return {
      ...device,
      cloudDeviceId: match.id,
      cloudName: match.name,
      cloudRoom: roomName,
      cloudMatchedBy: "mac" as const,
    };
  });
}
