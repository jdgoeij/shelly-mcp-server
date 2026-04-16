# Shelly Local MCP Server

[![npm version](https://img.shields.io/npm/v/shelly-mcp-server)](https://www.npmjs.com/package/shelly-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/shelly-mcp-server)](https://www.npmjs.com/package/shelly-mcp-server)
[![license](https://img.shields.io/npm/l/shelly-mcp-server)](LICENSE)
[![github repo](https://img.shields.io/badge/github-jdgoeij%2Fshelly--mcp--server-24292f?logo=github)](https://github.com/jdgoeij/shelly-mcp-server)

MCP server for controlling Shelly Gen2+ devices over your local network.

Features:
- automatic LAN discovery
- optional Shelly Cloud name/room enrichment
- strongly typed tools for status, switches, covers, and raw RPC calls

## Requirements

- Node.js 20+
- npm 10+
- Shelly Gen2+ devices reachable on your LAN

## Install and run

You can run this server in two common ways.

### Option A: standalone clone (recommended while developing)

```bash
git clone https://github.com/jdgoeij/shelly-mcp-server.git
cd shelly-mcp-server
npm install
npm run build
```

MCP client config example:

```json
{
  "mcpServers": {
    "shelly-local": {
      "command": "node",
      "args": ["./dist/index.js"],
      "cwd": "/absolute/path/to/shelly-mcp-server",
      "env": {
        "SHELLY_DEVICES_FILE": "./devices.local.json",
        "SHELLY_DISCOVERY_CONFIG_FILE": "./discovery.config.json",
        "SHELLY_TIMEOUT_MS": "5000"
      }
    }
  }
}
```

### Option B: run from npm with npx

Now that the package is published, users can run it without cloning:

- latest release:

```json
{
  "mcpServers": {
    "shelly-local": {
      "command": "npx",
      "args": ["-y", "shelly-mcp-server"],
      "cwd": "/absolute/path/to/shelly-config",
      "env": {
        "SHELLY_DEVICES_FILE": "./devices.local.json",
        "SHELLY_DISCOVERY_CONFIG_FILE": "./discovery.config.json",
        "SHELLY_TIMEOUT_MS": "5000"
      }
    }
  }
}
```

- pinned version (recommended for reproducible setups):

```json
{
  "mcpServers": {
    "shelly-local": {
      "command": "npx",
      "args": ["-y", "shelly-mcp-server@0.1.0"],
      "cwd": "/absolute/path/to/shelly-config",
      "env": {
        "SHELLY_DEVICES_FILE": "./devices.local.json",
        "SHELLY_DISCOVERY_CONFIG_FILE": "./discovery.config.json",
        "SHELLY_TIMEOUT_MS": "5000"
      }
    }
  }
}
```

Important:
- keep `cwd` pointed at a persistent folder where config/data files live
- the server reads and writes relative paths from that folder

## First-time setup for either option

Create local config files in your chosen `cwd` folder:

`discovery.config.json`
```json
{
  "cidr": "192.168.1.0/24",
  "merge": true,
  "enrichNames": true,
  "enrichRoom": true,
  "enrichCloud": false,
  "timeoutMs": 1500,
  "concurrency": 32,
  "maxHosts": 512,
  "validateTimeoutMs": 5000
}
```

Then ask your MCP client assistant:

> Discover and validate my Shelly devices on 192.168.1.0/24

This creates or updates `devices.local.json`.

## Cloud enrichment (optional)

Cloud enrichment imports cloud-assigned names and rooms during discovery. Device control remains local.
The server uses Shelly Cloud Control v2 `POST /v2/devices/api/get`, batches up to 10 device ids per request, and respects the documented 1 request/second cloud rate limit.

If you are running standalone from clone:

```bash
npm run setup-cloud
```

If you are running via npx, set these env vars in your MCP client config instead:

- `SHELLY_CLOUD_AUTH_KEY`
- `SHELLY_CLOUD_SERVER`
- optional `SHELLY_CLOUD_TIMEOUT_MS`

Find cloud values at https://my.shelly.cloud/ -> User Settings -> Authorization cloud key.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SHELLY_DEVICES_FILE` | `./devices.local.json` | Path to persisted device inventory |
| `SHELLY_DISCOVERY_CONFIG_FILE` | `./discovery.config.json` | Path to discovery defaults |
| `SHELLY_TIMEOUT_MS` | `5000` | RPC timeout in milliseconds |
| `SHELLY_CLOUD_AUTH_KEY` | - | Shelly Cloud auth key |
| `SHELLY_CLOUD_SERVER` | - | Shelly Cloud server hostname |
| `SHELLY_CLOUD_TIMEOUT_MS` | `10000` | Cloud API timeout in milliseconds |

## Available tools

| Tool | Description |
|---|---|
| `shelly_list_devices` | List configured devices |
| `shelly_get_status` | Get full device status |
| `shelly_get_device_info` | Get model and firmware info |
| `shelly_switch_set` | Turn a relay on or off |
| `shelly_cover_control` | Open, close, stop, or set position |
| `shelly_rpc_call` | Call any Shelly RPC method |
| `shelly_discover_and_save_devices` | Discover devices and save to JSON |
| `shelly_discover_save_and_validate` | Discover, save, and validate connectivity |
| `shelly_update_device_credentials` | Batch-apply credentials to saved devices |

- Run this server only on trusted machines.
- Never commit `.env`, `devices.local.json`, or cloud credentials.
- Review MCP client config before sharing screenshots or logs.
