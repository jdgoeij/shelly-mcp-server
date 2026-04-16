import type { ShellyDevice } from "./config.js";
import { callShellyRpc } from "./shelly-client.js";

export interface DiscoverOptions {
  cidrs?: string[];
  timeoutMs: number;
  maxHosts: number;
  concurrency: number;
}

interface ParsedCidr {
  cidr: string;
  network: number;
  prefix: number;
}

export interface DiscoveredShelly {
  ip: string;
  baseUrl: string;
  id?: string;
  mac?: string;
  model?: string;
  gen?: number;
  app?: string;
  ver?: string;
  friendlyName?: string;
  configuredName?: string;
  room?: string;
  componentNames?: Record<string, string>;
  primaryComponentName?: string;
  authRequired?: boolean;
  componentIds?: {
    switch: number[];
    cover: number[];
    light: number[];
    input: number[];
  };
  capabilities?: {
    supportsSwitch: boolean;
    supportsCover: boolean;
    supportsLight: boolean;
    supportsInput: boolean;
    supportsPowerMetering: boolean;
  };
  suggestedActions?: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function extractNameAndRoomAndComponents(configRaw: unknown): {
  friendlyName?: string;
  configuredName?: string;
  room?: string;
  componentNames?: Record<string, string>;
  primaryComponentName?: string;
} {
  const root = asRecord(configRaw);
  if (!root) {
    return {};
  }

  const sys = asRecord(root.sys);
  const device = asRecord(sys?.device);
  const location = asRecord(sys?.location);
  const uiData = asRecord(sys?.ui_data);

  const friendlyName = getString(device?.name);

  const componentNames: Record<string, string> = {};
  for (const [key, value] of Object.entries(root)) {
    if (!/^[a-z_]+:\d+$/i.test(key)) {
      continue;
    }

    const componentConfig = asRecord(value);
    const name = getString(componentConfig?.name);
    if (name) {
      componentNames[key] = name;
    }
  }

  const priorityPrefixes = ["switch", "light", "cover", "input"];
  const namedKeys = Object.keys(componentNames).sort((a, b) => a.localeCompare(b));
  const primaryKey =
    priorityPrefixes
      .map((prefix) => namedKeys.find((key) => key.startsWith(`${prefix}:`)))
      .find((key): key is string => Boolean(key)) ??
    namedKeys[0];
  const primaryComponentName = primaryKey ? componentNames[primaryKey] : undefined;

  // Room is not always present in Shelly config; read it when available.
  const room =
    getString(device?.room) ??
    getString(location?.room) ??
    getString(uiData?.room) ??
    getString(uiData?.location_name) ??
    getString(root.location_name) ??
    getString(root.room);

  return {
    friendlyName,
    configuredName: friendlyName,
    room,
    componentNames: namedKeys.length > 0 ? componentNames : undefined,
    primaryComponentName,
  };
}

function isLikelyShellyDeviceInfo(value: unknown): value is {
  id: string;
  model: string;
  gen: number;
  app: string;
  ver: string;
  auth_en?: boolean;
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  const info = value as Record<string, unknown>;
  return (
    typeof info.id === "string" &&
    info.id.length > 0 &&
    typeof info.model === "string" &&
    info.model.length > 0 &&
    typeof info.gen === "number" &&
    Number.isFinite(info.gen) &&
    info.gen >= 2 &&
    typeof info.app === "string" &&
    info.app.length > 0 &&
    typeof info.ver === "string" &&
    info.ver.length > 0
  );
}

function isLikelyShellyStatus(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const status = value as Record<string, unknown>;
  const sys = status.sys;
  if (!sys || typeof sys !== "object") {
    return false;
  }

  const sysObj = sys as Record<string, unknown>;
  return (
    typeof sysObj.mac === "string" &&
    typeof sysObj.uptime === "number" &&
    Number.isFinite(sysObj.uptime)
  );
}

function parseComponentIdFromStatusKey(key: string, prefix: string): number | null {
  const expected = `${prefix}:`;
  if (!key.startsWith(expected)) {
    return null;
  }

  const raw = key.slice(expected.length);
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function extractComponentIds(statusRaw: unknown): {
  switch: number[];
  cover: number[];
  light: number[];
  input: number[];
} {
  const root = asRecord(statusRaw);
  if (!root) {
    return { switch: [], cover: [], light: [], input: [] };
  }

  const out = {
    switch: [] as number[],
    cover: [] as number[],
    light: [] as number[],
    input: [] as number[],
  };

  for (const key of Object.keys(root)) {
    const switchId = parseComponentIdFromStatusKey(key, "switch");
    if (switchId !== null) {
      out.switch.push(switchId);
      continue;
    }

    const coverId = parseComponentIdFromStatusKey(key, "cover");
    if (coverId !== null) {
      out.cover.push(coverId);
      continue;
    }

    const lightId = parseComponentIdFromStatusKey(key, "light");
    if (lightId !== null) {
      out.light.push(lightId);
      continue;
    }

    const inputId = parseComponentIdFromStatusKey(key, "input");
    if (inputId !== null) {
      out.input.push(inputId);
    }
  }

  out.switch.sort((a, b) => a - b);
  out.cover.sort((a, b) => a - b);
  out.light.sort((a, b) => a - b);
  out.input.sort((a, b) => a - b);

  return out;
}

function statusIndicatesPowerMetering(statusRaw: unknown): boolean {
  const root = asRecord(statusRaw);
  if (!root) {
    return false;
  }

  for (const value of Object.values(root)) {
    const comp = asRecord(value);
    if (!comp) {
      continue;
    }

    const hasPower = typeof comp.apower === "number";
    const hasEnergy =
      typeof comp.aenergy_total === "number" ||
      typeof comp.aenergy_by_minute === "object" ||
      typeof comp.energy === "number";

    if (hasPower || hasEnergy) {
      return true;
    }
  }

  return false;
}

function extractMacFromStatus(statusRaw: unknown): string | undefined {
  const root = asRecord(statusRaw);
  const sys = asRecord(root?.sys);
  return getString(sys?.mac);
}

function ipToInt(ip: string): number {
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function intToIp(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join(".");
}

function parseCidr(raw: string): ParsedCidr {
  const parts = raw.trim().split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid CIDR format: ${raw}`);
  }

  const ip = parts[0];
  const prefix = Number(parts[1]);
  if (!Number.isInteger(prefix) || prefix < 16 || prefix > 30) {
    throw new Error(`CIDR prefix must be between /16 and /30: ${raw}`);
  }

  const ipInt = ipToInt(ip);
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  const network = ipInt & mask;

  return { cidr: `${intToIp(network)}/${prefix}`, network, prefix };
}

function hostCount(prefix: number): number {
  return Math.max(0, (1 << (32 - prefix)) - 2);
}

function hostIps(cidr: ParsedCidr): string[] {
  const totalHosts = hostCount(cidr.prefix);
  const start = cidr.network + 1;

  const ips: string[] = [];
  for (let i = 0; i < totalHosts; i += 1) {
    ips.push(intToIp(start + i));
  }
  return ips;
}

function inferCidrsFromConfiguredDevices(devices: ShellyDevice[]): string[] {
  const set = new Set<string>();

  for (const device of devices) {
    const host = new URL(device.baseUrl).hostname;
    const parts = host.split(".");
    if (parts.length !== 4 || parts.some((x) => !/^\d+$/.test(x))) {
      continue;
    }

    set.add(`${parts[0]}.${parts[1]}.${parts[2]}.0/24`);
  }

  return [...set];
}

async function probeIp(ip: string, timeoutMs: number): Promise<DiscoveredShelly | null> {
  const baseUrl = `http://${ip}`;
  const probeDevice: ShellyDevice = { name: ip, baseUrl };

  try {
    const infoRaw = await callShellyRpc(
      probeDevice,
      "Shelly.GetDeviceInfo",
      {},
      { timeoutMs, requestStyle: "query" }
    );

    // Require the expected Shelly.GetDeviceInfo shape to avoid false positives.
    if (!isLikelyShellyDeviceInfo(infoRaw)) {
      return null;
    }

    const statusRaw = await callShellyRpc(
      probeDevice,
      "Shelly.GetStatus",
      {},
      { timeoutMs, requestStyle: "query" }
    );

    // Require the expected Shelly.GetStatus shape to confirm this is a Shelly device.
    if (!isLikelyShellyStatus(statusRaw)) {
      return null;
    }

    let friendlyName: string | undefined;
    let configuredName: string | undefined;
    let room: string | undefined;
    let componentNames: Record<string, string> | undefined;
    let primaryComponentName: string | undefined;
    const componentIds = extractComponentIds(statusRaw);
    const supportsPowerMetering = statusIndicatesPowerMetering(statusRaw);
    const mac = extractMacFromStatus(statusRaw);

    const capabilities = {
      supportsSwitch: componentIds.switch.length > 0,
      supportsCover: componentIds.cover.length > 0,
      supportsLight: componentIds.light.length > 0,
      supportsInput: componentIds.input.length > 0,
      supportsPowerMetering,
    };

    const suggestedActions: string[] = ["get_status", "get_device_info"];
    if (capabilities.supportsSwitch) {
      suggestedActions.push("switch_on", "switch_off");
    }
    if (capabilities.supportsCover) {
      suggestedActions.push("cover_open", "cover_close", "cover_stop", "cover_set_position");
    }
    if (capabilities.supportsLight) {
      suggestedActions.push("light_on", "light_off");
    }
    try {
      const configRaw = await callShellyRpc(
        probeDevice,
        "Shelly.GetConfig",
        {},
        { timeoutMs, requestStyle: "query" }
      );

      const extracted = extractNameAndRoomAndComponents(configRaw);
      componentNames = extracted.componentNames;
      primaryComponentName = extracted.primaryComponentName;

      const resolvedFriendlyName = extracted.friendlyName ?? extracted.primaryComponentName;
      friendlyName = resolvedFriendlyName;
      configuredName = resolvedFriendlyName;
      room = extracted.room;
    } catch {
      // Keep discovery resilient if Shelly.GetConfig is unavailable on a specific model.
    }

    return {
      ip,
      baseUrl,
      id: infoRaw.id,
      mac,
      model: infoRaw.model,
      gen: infoRaw.gen,
      app: infoRaw.app,
      ver: infoRaw.ver,
      friendlyName,
      configuredName,
      room,
      componentNames,
      primaryComponentName,
      authRequired: typeof infoRaw.auth_en === "boolean" ? infoRaw.auth_en : undefined,
      componentIds,
      capabilities,
      suggestedActions,
    };
  } catch (error) {
    // Any probe failure is treated as not-discovered; this keeps results Shelly-only.
    return null;
  }
}

export async function discoverShellyDevices(
  configuredDevices: ShellyDevice[],
  options: DiscoverOptions
): Promise<{ scannedHosts: number; usedCidrs: string[]; devices: DiscoveredShelly[] }> {
  const candidateCidrs = options.cidrs && options.cidrs.length > 0
    ? options.cidrs
    : inferCidrsFromConfiguredDevices(configuredDevices);

  if (candidateCidrs.length === 0) {
    throw new Error(
      "No CIDRs provided and none can be inferred from configured devices. Pass cidr/cidrs to shelly_discover_devices."
    );
  }

  const parsed = candidateCidrs.map(parseCidr);
  const targets: string[] = [];

  for (const item of parsed) {
    for (const ip of hostIps(item)) {
      targets.push(ip);
      if (targets.length >= options.maxHosts) {
        break;
      }
    }
    if (targets.length >= options.maxHosts) {
      break;
    }
  }

  const found: DiscoveredShelly[] = [];
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, options.concurrency) }, async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= targets.length) {
        return;
      }

      const result = await probeIp(targets[i], options.timeoutMs);
      if (result) {
        found.push(result);
      }
    }
  });

  await Promise.all(workers);

  const deduped = new Map<string, DiscoveredShelly>();
  for (const item of found) {
    const key = item.id ?? item.ip;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }

  return {
    scannedHosts: targets.length,
    usedCidrs: parsed.map((x) => x.cidr),
    devices: [...deduped.values()].sort((a, b) => a.baseUrl.localeCompare(b.baseUrl)),
  };
}
