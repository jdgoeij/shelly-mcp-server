#!/usr/bin/env node
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { enrichDiscoveredDevicesWithCloud } from "./cloud.js";
import { findDevice, loadConfig, type ShellyDevice } from "./config.js";
import { resolveAuthKey, resolveServer, getCredentialsPath } from "./credentials.js";
import { discoverShellyDevices } from "./discovery.js";
import { callShellyRpc, type RpcRequestStyle } from "./shelly-client.js";

const config = loadConfig();

const RpcCallArgs = z.object({
  device: z.string().min(1),
  method: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  requestStyle: z.enum(["query", "json"]).optional(),
});

const DeviceStatusArgs = z.object({
  device: z.string().min(1),
});

const SwitchSetArgs = z.object({
  device: z.string().min(1),
  id: z.number().int().nonnegative(),
  on: z.boolean(),
  toggle_after: z.number().positive().optional(),
});

const CoverControlArgs = z.object({
  device: z.string().min(1),
  id: z.number().int().nonnegative(),
  action: z.enum(["open", "close", "stop", "goto"]),
  position: z.number().int().min(0).max(100).optional(),
});

const DiscoverArgs = z.object({
  cidr: z.string().optional(),
  cidrs: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  concurrency: z.number().int().min(1).max(128).optional(),
  maxHosts: z.number().int().min(1).max(4096).optional(),
  enrichCloud: z.boolean().optional(),
  cloudAuthKey: z.string().min(1).optional(),
  cloudServer: z.string().min(1).optional(),
  cloudTimeoutMs: z.number().int().positive().optional(),
});

const DiscoverAndSaveArgs = DiscoverArgs.extend({
  outputFile: z.string().min(1).optional(),
  merge: z.boolean().optional(),
  enrichNames: z.boolean().optional(),
  enrichRoom: z.boolean().optional(),
});

const DiscoverSaveAndValidateArgs = DiscoverAndSaveArgs.extend({
  validateTimeoutMs: z.number().int().positive().optional(),
});

type DiscoveryDefaults = Partial<z.infer<typeof DiscoverSaveAndValidateArgs>>;

function loadDiscoveryDefaults(): DiscoveryDefaults {
  const configFile = path.resolve(process.env.SHELLY_DISCOVERY_CONFIG_FILE ?? "./discovery.config.json");
  if (!existsSync(configFile)) {
    return {};
  }

  const raw = readFileSync(configFile, "utf-8").trim();
  if (raw.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const validated = DiscoverSaveAndValidateArgs.partial().parse(parsed);
    return validated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid discovery config in ${configFile}: ${message}`);
  }
}

const UpdateCredentialsArgs = z.object({
  inputFile: z.string().min(1).optional(),
  outputFile: z.string().min(1).optional(),
  names: z.array(z.string().min(1)).optional(),
  ips: z.array(z.string().min(1)).optional(),
  modelContains: z.string().min(1).optional(),
  username: z.string().min(1),
  password: z.string().min(1),
  validate: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const discoveryDefaults = loadDiscoveryDefaults();

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let counter = 2;
  while (true) {
    const candidate = `${base}_${counter}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    counter += 1;
  }
}

function isGeneratedFallbackName(currentName: string, fallback: string): boolean {
  return currentName === fallback || currentName.startsWith(`${fallback}_`);
}

function loadDeviceFile(deviceFile: string): ShellyDevice[] {
  if (!existsSync(deviceFile)) {
    return [];
  }

  const raw = readFileSync(deviceFile, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array in ${deviceFile}`);
  }

  return parsed as ShellyDevice[];
}

function getDefaultDeviceFilePath(): string {
  return path.resolve(process.env.SHELLY_DEVICES_FILE ?? "./devices.local.json");
}

function ipFromBaseUrl(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).hostname;
    const parts = host.split(".");
    if (parts.length !== 4 || parts.some((x) => !/^\d+$/.test(x))) {
      return null;
    }
    return host;
  } catch {
    return null;
  }
}

function saveDiscoveredDevices(
  discovery: Awaited<ReturnType<typeof discoverShellyDevices>>,
  options: {
    outputFile?: string;
    merge?: boolean;
    enrichNames?: boolean;
    enrichRoom?: boolean;
  }
): {
  outputFile: string;
  merge: boolean;
  savedDevices: ShellyDevice[];
  added: number;
  updated: number;
} {
  const outputFile = path.resolve(options.outputFile ?? process.env.SHELLY_DEVICES_FILE ?? "./devices.local.json");
  const merge = options.merge ?? true;
  const enrichNames = options.enrichNames ?? true;
  const enrichRoom = options.enrichRoom ?? true;

  const existing = merge ? loadDeviceFile(outputFile) : [];
  const existingByUrl = new Map(existing.map((d) => [d.baseUrl, d]));
  const usedNames = new Set(existing.map((d) => d.name));

  let added = 0;
  let updated = 0;

  const nowIso = new Date().toISOString();

  for (const discovered of discovery.devices) {
    const modelSlug = discovered.model ? slugify(discovered.model) : "shelly";
    const ipSuffix = discovered.ip.split(".").slice(-2).join("_");
    const fallback = slugify(`${modelSlug}_${ipSuffix}`) || `shelly_${ipSuffix}`;
    const preferredFriendlyName =
      discovered.cloudName?.trim() ||
      discovered.friendlyName?.trim() ||
      discovered.configuredName?.trim();
    const suggested = enrichNames
      ? preferredFriendlyName || fallback
      : fallback;

    const existingEntry = existingByUrl.get(discovered.baseUrl);
    if (existingEntry) {
      if (enrichNames && preferredFriendlyName) {
        usedNames.delete(existingEntry.name);
        existingEntry.name = uniqueName(preferredFriendlyName, usedNames);
      } else if (
        enrichNames &&
        discovered.configuredName &&
        isGeneratedFallbackName(existingEntry.name, fallback)
      ) {
        usedNames.delete(existingEntry.name);
        existingEntry.name = uniqueName(discovered.configuredName.trim(), usedNames);
      }

      if (enrichRoom && (discovered.cloudRoom || discovered.room)) {
        existingEntry.room = discovered.cloudRoom ?? discovered.room;
      }

      existingEntry.cloudName = discovered.cloudName;
      existingEntry.cloudRoom = discovered.cloudRoom;
      existingEntry.cloudDeviceId = discovered.cloudDeviceId;
      existingEntry.cloudMatchedBy = discovered.cloudMatchedBy;
      existingEntry.friendlyName = discovered.friendlyName;
      existingEntry.primaryComponentName = discovered.primaryComponentName;
      existingEntry.componentNames = discovered.componentNames;

      existingEntry.ip = discovered.ip;
      existingEntry.deviceId = discovered.id;
      existingEntry.mac = discovered.mac;
      existingEntry.model = discovered.model;
      existingEntry.gen = discovered.gen;
      existingEntry.app = discovered.app;
      existingEntry.firmwareVersion = discovered.ver;
      existingEntry.authRequired = discovered.authRequired;
      existingEntry.componentIds = discovered.componentIds;
      existingEntry.capabilities = discovered.capabilities;
      existingEntry.suggestedActions = discovered.suggestedActions;
      existingEntry.enrichedAt = nowIso;

      updated += 1;
      continue;
    }

    const name = uniqueName(suggested, usedNames);
    const newEntry: ShellyDevice = {
      name,
      baseUrl: discovered.baseUrl,
      room: enrichRoom ? (discovered.cloudRoom ?? discovered.room) : undefined,
      cloudName: discovered.cloudName,
      cloudRoom: discovered.cloudRoom,
      cloudDeviceId: discovered.cloudDeviceId,
      cloudMatchedBy: discovered.cloudMatchedBy,
      friendlyName: discovered.friendlyName,
      primaryComponentName: discovered.primaryComponentName,
      componentNames: discovered.componentNames,
      ip: discovered.ip,
      deviceId: discovered.id,
      mac: discovered.mac,
      model: discovered.model,
      gen: discovered.gen,
      app: discovered.app,
      firmwareVersion: discovered.ver,
      authRequired: discovered.authRequired,
      componentIds: discovered.componentIds,
      capabilities: discovered.capabilities,
      suggestedActions: discovered.suggestedActions,
      enrichedAt: nowIso,
    };
    existing.push(newEntry);
    existingByUrl.set(newEntry.baseUrl, newEntry);
    added += 1;
  }

  writeFileSync(outputFile, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");

  const savedDevices: ShellyDevice[] = [];
  for (const discovered of discovery.devices) {
    const match = existingByUrl.get(discovered.baseUrl);
    if (match) {
      savedDevices.push(match);
    }
  }

  return {
    outputFile,
    merge,
    savedDevices,
    added,
    updated,
  };
}

function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function maybeCloudEnrichDiscovery(
  discovery: Awaited<ReturnType<typeof discoverShellyDevices>>,
  options: {
    enrichCloud?: boolean;
    cloudAuthKey?: string;
    cloudServer?: string;
    cloudTimeoutMs?: number;
  }
): Promise<Awaited<ReturnType<typeof discoverShellyDevices>>> {
  const enrichCloud = options.enrichCloud ?? false;
  if (!enrichCloud) {
    return discovery;
  }

  const authKey = resolveAuthKey(options.cloudAuthKey);
  if (!authKey) {
    throw new Error(
      "Shelly Cloud enrichment requested but no auth_key found. " +
      "Run 'npm run setup-cloud' in the shelly-mcp-server directory, " +
      "or set SHELLY_CLOUD_AUTH_KEY env var."
    );
  }

  const server = resolveServer(options.cloudServer);
  if (!server) {
    throw new Error(
      "Shelly Cloud enrichment requested but no cloud server found. " +
      "Run 'npm run setup-cloud' in the shelly-mcp-server directory, " +
      "or set SHELLY_CLOUD_SERVER env var."
    );
  }

  const timeoutMs = options.cloudTimeoutMs ?? Number(process.env.SHELLY_CLOUD_TIMEOUT_MS ?? "10000");

  const devices = await enrichDiscoveredDevicesWithCloud(discovery.devices, {
    authKey,
    server,
    timeoutMs,
  });

  return {
    ...discovery,
    devices,
  };
}

async function runTool(request: CallToolRequest): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === "shelly_list_devices") {
      return {
        content: [
          {
            type: "text",
            text: asText(
              config.devices.map((device) => ({
                name: device.name,
                baseUrl: device.baseUrl,
                room: device.room,
                cloudName: device.cloudName,
                cloudRoom: device.cloudRoom,
                cloudDeviceId: device.cloudDeviceId,
                cloudMatchedBy: device.cloudMatchedBy,
                model: device.model,
                generation: device.gen,
                app: device.app,
                firmwareVersion: device.firmwareVersion,
                deviceId: device.deviceId,
                mac: device.mac,
                capabilities: device.capabilities,
                suggestedActions: device.suggestedActions,
                authConfigured: Boolean(device.username && device.password),
              }))
            ),
          },
        ],
      };
    }

    if (name === "shelly_get_status") {
      const parsed = DeviceStatusArgs.parse(args);
      const device = findDevice(config.devices, parsed.device);
      const result = await callShellyRpc(device, "Shelly.GetStatus", {}, { timeoutMs: config.timeoutMs });
      return { content: [{ type: "text", text: asText(result) }] };
    }

    if (name === "shelly_get_device_info") {
      const parsed = DeviceStatusArgs.parse(args);
      const device = findDevice(config.devices, parsed.device);
      const result = await callShellyRpc(device, "Shelly.GetDeviceInfo", {}, { timeoutMs: config.timeoutMs });
      return { content: [{ type: "text", text: asText(result) }] };
    }

    if (name === "shelly_switch_set") {
      const parsed = SwitchSetArgs.parse(args);
      const device = findDevice(config.devices, parsed.device);
      const result = await callShellyRpc(
        device,
        "Switch.Set",
        {
          id: parsed.id,
          on: parsed.on,
          toggle_after: parsed.toggle_after,
        },
        { timeoutMs: config.timeoutMs }
      );
      return { content: [{ type: "text", text: asText(result) }] };
    }

    if (name === "shelly_cover_control") {
      const parsed = CoverControlArgs.parse(args);
      const device = findDevice(config.devices, parsed.device);

      if (parsed.action === "goto") {
        if (parsed.position === undefined) {
          throw new Error("position is required when action is 'goto'.");
        }

        const result = await callShellyRpc(
          device,
          "Cover.GoToPosition",
          { id: parsed.id, pos: parsed.position },
          { timeoutMs: config.timeoutMs }
        );
        return { content: [{ type: "text", text: asText(result) }] };
      }

      const methodMap: Record<"open" | "close" | "stop", string> = {
        open: "Cover.Open",
        close: "Cover.Close",
        stop: "Cover.Stop",
      };

      const method = methodMap[parsed.action as "open" | "close" | "stop"];
      const result = await callShellyRpc(device, method, { id: parsed.id }, { timeoutMs: config.timeoutMs });
      return { content: [{ type: "text", text: asText(result) }] };
    }

    if (name === "shelly_rpc_call") {
      const parsed = RpcCallArgs.parse(args);
      const device = findDevice(config.devices, parsed.device);
      const result = await callShellyRpc(
        device,
        parsed.method,
        parsed.params ?? {},
        {
          timeoutMs: config.timeoutMs,
          requestStyle: parsed.requestStyle as RpcRequestStyle | undefined,
        }
      );
      return { content: [{ type: "text", text: asText(result) }] };
    }

    if (name === "shelly_discover_and_save_devices") {
      const parsed = DiscoverAndSaveArgs.parse(args);
      const effective = { ...discoveryDefaults, ...parsed };
      const cidrList = [
        ...(effective.cidr ? [effective.cidr] : []),
        ...(effective.cidrs ?? []),
      ];

      const localDiscovery = await discoverShellyDevices(config.devices, {
        cidrs: cidrList.length > 0 ? cidrList : undefined,
        timeoutMs: effective.timeoutMs ?? Math.min(config.timeoutMs, 1500),
        concurrency: effective.concurrency ?? 32,
        maxHosts: effective.maxHosts ?? 512,
      });

      const discovery = await maybeCloudEnrichDiscovery(localDiscovery, effective);

      const saved = saveDiscoveredDevices(discovery, {
        outputFile: effective.outputFile,
        merge: effective.merge,
        enrichNames: effective.enrichNames,
        enrichRoom: effective.enrichRoom,
      });

      return {
        content: [
          {
            type: "text",
            text: asText({
              outputFile: saved.outputFile,
              merge: saved.merge,
              scannedHosts: discovery.scannedHosts,
              discovered: discovery.devices.length,
              added: saved.added,
              updated: saved.updated,
              devices: discovery.devices,
            }),
          },
        ],
      };
    }

    if (name === "shelly_discover_save_and_validate") {
      const parsed = DiscoverSaveAndValidateArgs.parse(args);
      const effective = { ...discoveryDefaults, ...parsed };
      const cidrList = [
        ...(effective.cidr ? [effective.cidr] : []),
        ...(effective.cidrs ?? []),
      ];

      const localDiscovery = await discoverShellyDevices(config.devices, {
        cidrs: cidrList.length > 0 ? cidrList : undefined,
        timeoutMs: effective.timeoutMs ?? Math.min(config.timeoutMs, 1500),
        concurrency: effective.concurrency ?? 32,
        maxHosts: effective.maxHosts ?? 512,
      });

      const discovery = await maybeCloudEnrichDiscovery(localDiscovery, effective);

      const saved = saveDiscoveredDevices(discovery, {
        outputFile: effective.outputFile,
        merge: effective.merge,
        enrichNames: effective.enrichNames,
        enrichRoom: effective.enrichRoom,
      });

      const validateTimeoutMs = effective.validateTimeoutMs ?? config.timeoutMs;
      const validations = await Promise.all(
        saved.savedDevices.map(async (device) => {
          try {
            await callShellyRpc(
              {
                name: device.name,
                baseUrl: device.baseUrl,
                username: device.username,
                password: device.password,
              },
              "Shelly.GetStatus",
              {},
              { timeoutMs: validateTimeoutMs }
            );

            return {
              name: device.name,
              baseUrl: device.baseUrl,
              ok: true,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              name: device.name,
              baseUrl: device.baseUrl,
              ok: false,
              authRequired: message.includes("401") || message.includes("403"),
              error: message,
            };
          }
        })
      );

      const okCount = validations.filter((v) => v.ok).length;

      return {
        content: [
          {
            type: "text",
            text: asText({
              outputFile: saved.outputFile,
              merge: saved.merge,
              scannedHosts: discovery.scannedHosts,
              discovered: discovery.devices.length,
              added: saved.added,
              updated: saved.updated,
              validated: validations.length,
              reachable: okCount,
              unreachable: validations.length - okCount,
              validations,
            }),
          },
        ],
      };
    }

    if (name === "shelly_update_device_credentials") {
      const parsed = UpdateCredentialsArgs.parse(args);
      const inputFile = path.resolve(parsed.inputFile ?? getDefaultDeviceFilePath());
      const outputFile = path.resolve(parsed.outputFile ?? inputFile);
      const timeoutMs = parsed.timeoutMs ?? config.timeoutMs;

      const devices = loadDeviceFile(inputFile);
      if (devices.length === 0) {
        throw new Error(`No devices found in ${inputFile}`);
      }

      const nameSet = new Set((parsed.names ?? []).map((x) => x.toLowerCase()));
      const ipSet = new Set(parsed.ips ?? []);

      const updated: string[] = [];
      const skipped: Array<{ name: string; reason: string }> = [];

      for (const device of devices) {
        if (nameSet.size > 0 && !nameSet.has(device.name.toLowerCase())) {
          continue;
        }

        const ip = ipFromBaseUrl(device.baseUrl);
        if (ipSet.size > 0 && (!ip || !ipSet.has(ip))) {
          continue;
        }

        if (parsed.modelContains) {
          try {
            const info = (await callShellyRpc(
              {
                name: device.name,
                baseUrl: device.baseUrl,
                username: parsed.username,
                password: parsed.password,
              },
              "Shelly.GetDeviceInfo",
              {},
              { timeoutMs }
            )) as Record<string, unknown>;

            const model = typeof info.model === "string" ? info.model : "";
            if (!model.toLowerCase().includes(parsed.modelContains.toLowerCase())) {
              skipped.push({
                name: device.name,
                reason: `model '${model}' does not match '${parsed.modelContains}'`,
              });
              continue;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            skipped.push({
              name: device.name,
              reason: `could not evaluate model filter: ${message}`,
            });
            continue;
          }
        }

        device.username = parsed.username;
        device.password = parsed.password;
        updated.push(device.name);
      }

      writeFileSync(outputFile, `${JSON.stringify(devices, null, 2)}\n`, "utf-8");

      let validations: Array<{ name: string; baseUrl: string; ok: boolean; error?: string }> = [];
      if (parsed.validate ?? true) {
        const updatedSet = new Set(updated);
        validations = await Promise.all(
          devices
            .filter((d) => updatedSet.has(d.name))
            .map(async (device) => {
              try {
                await callShellyRpc(
                  {
                    name: device.name,
                    baseUrl: device.baseUrl,
                    username: device.username,
                    password: device.password,
                  },
                  "Shelly.GetStatus",
                  {},
                  { timeoutMs }
                );

                return {
                  name: device.name,
                  baseUrl: device.baseUrl,
                  ok: true,
                };
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                  name: device.name,
                  baseUrl: device.baseUrl,
                  ok: false,
                  error: message,
                };
              }
            })
        );
      }

      return {
        content: [
          {
            type: "text",
            text: asText({
              inputFile,
              outputFile,
              updatedCount: updated.length,
              updated,
              skipped,
              validated: validations.length,
              validationOk: validations.filter((v) => v.ok).length,
              validations,
            }),
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}

const server = new Server(
  {
    name: "shelly-local-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "shelly_list_devices",
      description: "List configured Shelly devices available to this MCP server.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "shelly_get_status",
      description: "Get full status for a Shelly device using Shelly.GetStatus.",
      inputSchema: {
        type: "object",
        properties: {
          device: { type: "string", description: "Configured device name" },
        },
        required: ["device"],
        additionalProperties: false,
      },
    },
    {
      name: "shelly_get_device_info",
      description: "Get model and firmware info via Shelly.GetDeviceInfo.",
      inputSchema: {
        type: "object",
        properties: {
          device: { type: "string", description: "Configured device name" },
        },
        required: ["device"],
        additionalProperties: false,
      },
    },
    {
      name: "shelly_switch_set",
      description: "Turn a relay switch on/off using Switch.Set.",
      inputSchema: {
        type: "object",
        properties: {
          device: { type: "string", description: "Configured device name" },
          id: { type: "integer", minimum: 0, description: "Switch component id" },
          on: { type: "boolean", description: "true to switch on, false to switch off" },
          toggle_after: { type: "number", minimum: 0.001, description: "Optional auto-toggle timer in seconds" },
        },
        required: ["device", "id", "on"],
        additionalProperties: false,
      },
    },
    {
      name: "shelly_cover_control",
      description: "Control cover components (open/close/stop/goto).",
      inputSchema: {
        type: "object",
        properties: {
          device: { type: "string", description: "Configured device name" },
          id: { type: "integer", minimum: 0, description: "Cover component id" },
          action: { type: "string", enum: ["open", "close", "stop", "goto"] },
          position: { type: "integer", minimum: 0, maximum: 100, description: "Required for action=goto" },
        },
        required: ["device", "id", "action"],
        additionalProperties: false,
      },
    },
    {
      name: "shelly_rpc_call",
      description: "Call any Shelly RPC method for advanced scenarios.",
      inputSchema: {
        type: "object",
        properties: {
          device: { type: "string", description: "Configured device name" },
          method: { type: "string", description: "RPC method name (e.g. Switch.GetStatus)" },
          params: { type: "object", description: "Method parameters as key/value object" },
          requestStyle: {
            type: "string",
            enum: ["query", "json"],
            description: "Use query (default) or json POST body",
          },
        },
        required: ["device", "method"],
        additionalProperties: false,
      },
    },
    {
      name: "shelly_discover_and_save_devices",
      description: "Discover Shelly devices and write them into a device config JSON file.",
      inputSchema: {
        type: "object",
        properties: {
          cidr: {
            type: "string",
            description: "Optional CIDR to scan (example: 192.168.1.0/24).",
          },
          cidrs: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of CIDRs to scan.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            description: "Timeout per host probe in milliseconds.",
          },
          concurrency: {
            type: "integer",
            minimum: 1,
            maximum: 128,
            description: "Parallel probe workers.",
          },
          maxHosts: {
            type: "integer",
            minimum: 1,
            maximum: 4096,
            description: "Limit total scanned hosts across all CIDRs.",
          },
          outputFile: {
            type: "string",
            description: "Output JSON file path. Defaults to SHELLY_DEVICES_FILE or ./devices.local.json",
          },
          merge: {
            type: "boolean",
            description: "When true, merge with existing file content by baseUrl. Default true.",
          },
          enrichNames: {
            type: "boolean",
            description: "When true, prefer configured Shelly names from Sys.GetConfig when saving. Default true.",
          },
          enrichRoom: {
            type: "boolean",
            description: "When true, include room metadata from Sys.GetConfig when available. Default true.",
          },
          enrichCloud: {
            type: "boolean",
            description: "When true, enrich discovered devices with Shelly Cloud names and rooms via auth_key. Requires prior 'npm run setup-cloud' or SHELLY_CLOUD_AUTH_KEY + SHELLY_CLOUD_SERVER env vars.",
          },
          cloudAuthKey: {
            type: "string",
            description: "Shelly Cloud auth_key. Usually auto-resolved from ~/.shelly-mcp/credentials.json or SHELLY_CLOUD_AUTH_KEY env.",
          },
          cloudServer: {
            type: "string",
            description: "Shelly Cloud server hostname (e.g. shelly-205-eu.shelly.cloud). Usually auto-resolved from ~/.shelly-mcp/credentials.json or SHELLY_CLOUD_SERVER env.",
          },
          cloudTimeoutMs: {
            type: "integer",
            minimum: 1,
            description: "Timeout for Shelly Cloud API requests in milliseconds.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "shelly_discover_save_and_validate",
      description: "Discover devices, save them to JSON, then validate connectivity using Shelly.GetStatus.",
      inputSchema: {
        type: "object",
        properties: {
          cidr: {
            type: "string",
            description: "Optional CIDR to scan (example: 192.168.1.0/24).",
          },
          cidrs: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of CIDRs to scan.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            description: "Timeout per host probe in milliseconds.",
          },
          concurrency: {
            type: "integer",
            minimum: 1,
            maximum: 128,
            description: "Parallel probe workers.",
          },
          maxHosts: {
            type: "integer",
            minimum: 1,
            maximum: 4096,
            description: "Limit total scanned hosts across all CIDRs.",
          },
          outputFile: {
            type: "string",
            description: "Output JSON file path. Defaults to SHELLY_DEVICES_FILE or ./devices.local.json",
          },
          merge: {
            type: "boolean",
            description: "When true, merge with existing file content by baseUrl. Default true.",
          },
          enrichNames: {
            type: "boolean",
            description: "When true, prefer configured Shelly names from Sys.GetConfig when saving. Default true.",
          },
          enrichRoom: {
            type: "boolean",
            description: "When true, include room metadata from Sys.GetConfig when available. Default true.",
          },
          enrichCloud: {
            type: "boolean",
            description: "When true, enrich discovered devices with Shelly Cloud names and rooms via auth_key. Requires prior 'npm run setup-cloud' or SHELLY_CLOUD_AUTH_KEY + SHELLY_CLOUD_SERVER env vars.",
          },
          cloudAuthKey: {
            type: "string",
            description: "Shelly Cloud auth_key. Usually auto-resolved from ~/.shelly-mcp/credentials.json or SHELLY_CLOUD_AUTH_KEY env.",
          },
          cloudServer: {
            type: "string",
            description: "Shelly Cloud server hostname (e.g. shelly-205-eu.shelly.cloud). Usually auto-resolved from ~/.shelly-mcp/credentials.json or SHELLY_CLOUD_SERVER env.",
          },
          cloudTimeoutMs: {
            type: "integer",
            minimum: 1,
            description: "Timeout for Shelly Cloud API requests in milliseconds.",
          },
          validateTimeoutMs: {
            type: "integer",
            minimum: 1,
            description: "Timeout for each post-save Shelly.GetStatus validation call in milliseconds.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "shelly_update_device_credentials",
      description: "Batch-apply credentials to saved devices by name/IP/model filters and optionally validate.",
      inputSchema: {
        type: "object",
        properties: {
          inputFile: {
            type: "string",
            description: "Input device JSON file path. Defaults to SHELLY_DEVICES_FILE or ./devices.local.json",
          },
          outputFile: {
            type: "string",
            description: "Output device JSON file path. Defaults to inputFile.",
          },
          names: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of device names to target.",
          },
          ips: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of device IPv4 addresses to target.",
          },
          modelContains: {
            type: "string",
            description: "Optional model substring filter (validated via Shelly.GetDeviceInfo using provided credentials).",
          },
          username: {
            type: "string",
            description: "Username to set on matching devices.",
          },
          password: {
            type: "string",
            description: "Password to set on matching devices.",
          },
          validate: {
            type: "boolean",
            description: "Whether to validate with Shelly.GetStatus after update. Default true.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            description: "Timeout per validation call in milliseconds.",
          },
        },
        required: ["username", "password"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, runTool);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
