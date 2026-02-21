# Patch Overlays (DashDot + Homarr)

This repository contains only patch overlays and the GHCR workflow.

## Contents

- `dashdot-smart-overlay/`
  - Clones upstream DashDot during build and applies the patch.
  - Adds `/load/storage-extended` plus SMART temperature/health data.
- `homarr-smart-overlay/`
  - Clones upstream Homarr during build and applies the DashDot integration patch.
- `.github/workflows/ghcr-images.yml`
  - Builds and pushes both images to GHCR on every push to `main`.

## GHCR Images

- `ghcr.io/batuhancelasun/dashdot-smart:latest`
- `ghcr.io/batuhancelasun/homarr-smart:latest`

Pull example:

```bash
docker pull ghcr.io/batuhancelasun/dashdot-smart:latest
docker pull ghcr.io/batuhancelasun/homarr-smart:latest
```

## Quick Start (Both Together)

Run both services together with one stack.

### 1) Create an encryption key

Set `SECRET_ENCRYPTION_KEY` directly in the compose file (example below).

### 2) Use this compose file

```yaml
services:
  dashdot:
    image: ghcr.io/batuhancelasun/dashdot-smart:latest
    container_name: dashdot
    restart: unless-stopped
    privileged: true
    ports:
      - "3001:3001"
    environment:
      DASHDOT_ENABLE_CPU_TEMPS: "true"
      DASHDOT_ENABLE_SMART_TEMPS: "true"
      DASHDOT_RUNNING_IN_DOCKER: "true"
    volumes:
      - /:/mnt/host:ro
      - /dev:/dev

  homarr:
    image: ghcr.io/batuhancelasun/homarr-smart:latest
    container_name: homarr
    restart: unless-stopped
    ports:
      - "7575:7575"
    environment:
      SECRET_ENCRYPTION_KEY: "changeme" # use: openssl rand -hex 32
      AUTH_PROVIDERS: credentials
      DB_DIALECT: sqlite
      DB_DRIVER: better-sqlite3
      DB_URL: /appdata/db/db.sqlite
      REDIS_IS_EXTERNAL: "false"
    volumes:
      - /homarr:/appdata
```

### 3) Start

```bash
docker compose up -d
```

If you prefer, you can also use the included [docker-compose.stack.yml](docker-compose.stack.yml).

Default ports:

- DashDot: `http://<host>:3001`
- Homarr: `http://<host>:7575`

## What The Patches Do

### DashDot Patch

- Adds a new integration endpoint: `/load/storage-extended`.
- Keeps `/load/storage` backward-compatible by returning legacy numeric values.
- Extends storage runtime payload with SMART fields per disk:
  - `temperature`
  - `overallStatus` (`PASSED` / `FAILED` when available)
  - `healthy` (`true` / `false` when available)
- Reads SMART data via `smartctl` and caches results briefly to reduce command overhead.

### What You Get In Practice

- Homarr no longer fails when parsing DashDot storage data.
- You can see disk temperature directly in Homarr SMART cards (when available).
- You can see disk health status (`PASSED` / `FAILED`) instead of a generic `N/A`.
- Legacy DashDot consumers still work because `/load/storage` stays compatible.

### Current SMART Limitations

- SMART collection currently targets SATA-style device paths (`/dev/sdX`).
- NVMe disks (`/dev/nvme*`) may still appear as disks, but SMART fields can remain empty in Homarr.
- If `smartctl` cannot read a device, values are intentionally left unset instead of returning incorrect data.

### Runtime Requirements

- Container should run with host device access (for example `privileged: true` and `/dev:/dev`).
- `smartmontools` / `smartctl` must be available in the DashDot runtime image.
- SMART support also depends on host hardware/controller permissions.

### Homarr Patch

- Makes the DashDot integration prefer `/load/storage-extended` when available.
- Falls back to legacy `/load/storage` automatically if extended data is unavailable.
- Maps SMART fields from DashDot into Homarr storage SMART view:
  - temperature
  - overall status
  - healthy flag
- Preserves compatibility with upstream Homarr behavior for non-extended responses.

## Local Test

DashDot:

```bash
cd dashdot-smart-overlay
docker compose -f docker-compose.dashdot-smart.yml build
docker compose -f docker-compose.dashdot-smart.yml up -d
```

Homarr:

```bash
cd homarr-smart-overlay
docker compose -f docker-compose.homarr-smart.yml build
docker compose -f docker-compose.homarr-smart.yml up -d
```

## Build Args

- DashDot: `DASHDOT_REF` (default: `main`)
- Homarr: `HOMARR_REF` (default: `main`)
