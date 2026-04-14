# Shelly Local MCP Server

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
git clone https://github.com/<your-user>/shelly-mcp-server.git
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

After publishing, users can run your package without cloning:

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

## Publish to npm

Before first publish:

1. Update package metadata in `package.json`:
   - `name` (must be unique on npm)
   - `author`
   - `repository`, `bugs`, `homepage`
2. Ensure your repo is initialized and pushed:
   ```bash
   git init
   git add .
   git commit -m "Initial public release"
   git branch -M main
   git remote add origin https://github.com/<your-user>/shelly-mcp-server.git
   git push -u origin main
   ```
3. Build and verify package contents:
   ```bash
   npm ci
   npm run build
   npm pack --dry-run
   ```

Publish:

```bash
npm login
npm publish --access public
```

For every next release:

```bash
npm version patch
npm publish
```

Use `minor` or `major` instead of `patch` when needed.

## Security notes

- Run this server only on trusted machines.
- Never commit `.env`, `devices.local.json`, or cloud credentials.
- Review MCP client config before sharing screenshots or logs.
