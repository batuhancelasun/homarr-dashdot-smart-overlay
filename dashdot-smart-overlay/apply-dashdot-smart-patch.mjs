import { writeFileSync } from "node:fs";

const dynamicStorageFile = "/src/apps/server/src/data/storage/dynamic.ts";
const serverIndexFile = "/src/apps/server/src/index.ts";

const dynamicStorageContent = `import { exec as execChild } from 'node:child_process';
import { promisify } from 'node:util';
import { type StorageInfo, type StorageLoad, sumUp } from '@dashdot/common';
import * as si from 'systeminformation';
import { CONFIG } from '../../config';
import { getStaticServerInfo } from '../../static-info';
import { fromHost, PLATFORM_IS_WINDOWS } from '../../utils';

type Block = si.Systeminformation.BlockDevicesData;
type Size = si.Systeminformation.FsSizeData;

type StorageLoadExtendedEntry = {
  load: number;
  temperature?: number;
  overallStatus?: string;
  healthy?: boolean;
};

type SmartData = {
  temperature?: number;
  overallStatus?: string;
  healthy?: boolean;
};

const execAsync = promisify(execChild);
const SMART_CACHE_DURATION_MS = 60_000;
const SMART_SATA_DEVICE_REGEX = /^\\/dev\\/sd[a-z]+$/i;
const smartDataCache = new Map<string, SmartData & { timestamp: number }>();

const normalizeDevicePath = (device: string) =>
  device.startsWith('/dev/') ? device : \`/dev/\${device}\`;

const parseSmartTemperature = (stdout: string): number | undefined => {
  for (const line of stdout.split('\\n')) {
    if (/^\\s*194\\s+/.test(line) && /Temperature_Celsius|Temperature_Internal/.test(line)) {
      const cols = line.trim().split(/\\s+/);
      const rawValue = cols[9];
      if (rawValue) {
        const temperature = Number.parseInt(rawValue, 10);
        if (!Number.isNaN(temperature)) {
          return temperature;
        }
      }
    }
  }

  return undefined;
};

const parseSmartHealth = (
  stdout: string,
): { overallStatus?: string; healthy?: boolean } => {
  const healthMatch = stdout.match(
    /SMART overall-health self-assessment test result:\\s*([A-Z_]+)/i,
  );

  if (!healthMatch) {
    return {};
  }

  const status = healthMatch[1]?.toUpperCase();

  if (!status) {
    return {};
  }

  if (status === 'PASSED') {
    return { overallStatus: 'PASSED', healthy: true };
  }

  if (status === 'FAILED') {
    return { overallStatus: 'FAILED', healthy: false };
  }

  return { overallStatus: status, healthy: false };
};

const getSmartData = async (devicePath: string): Promise<SmartData> => {
  const now = Date.now();
  const cached = smartDataCache.get(devicePath);

  if (cached && now - cached.timestamp < SMART_CACHE_DURATION_MS) {
    return {
      temperature: cached.temperature,
      overallStatus: cached.overallStatus,
      healthy: cached.healthy,
    };
  }

  try {
    const [attributesResult, healthResult] = await Promise.all([
      execAsync(\`smartctl -A \${devicePath}\`),
      execAsync(\`smartctl -H \${devicePath}\`),
    ]);

    const temperature = parseSmartTemperature(attributesResult.stdout);
    const healthData = parseSmartHealth(healthResult.stdout);

    const value = {
      temperature,
      overallStatus: healthData.overallStatus,
      healthy: healthData.healthy,
      timestamp: now,
    };

    smartDataCache.set(devicePath, value);

    return {
      temperature,
      overallStatus: healthData.overallStatus,
      healthy: healthData.healthy,
    };
  } catch (_error) {
    smartDataCache.set(devicePath, { timestamp: now });
    return {};
  }
};

export class DynamicStorageMapper {
  private validSizes: Size[];

  constructor(
    private hostWin32: boolean,
    private layout: StorageInfo,
    private blocks: Block[],
    private sizes: Size[],
  ) {
    this.validSizes = this.getValidSizes();
  }

  private getValidSizes() {
    return this.sizes.filter(
      ({ mount, type }) =>
        (this.hostWin32 || mount.startsWith(fromHost('/'))) &&
        !CONFIG.fs_type_filter.includes(type),
    );
  }

  private getBlocksForDisks(disks: StorageInfo[number]['disks']) {
    return this.blocks.filter(({ name, device }) =>
      disks.some((d) =>
        this.hostWin32 ? d.device === device : name.startsWith(d.device),
      ),
    );
  }

  private getBlocksForRaid(raidLabel?: string, raidName?: string) {
    return this.blocks.filter(
      ({ label, name }) =>
        (raidLabel && label.startsWith(raidLabel)) ||
        (raidName && name.startsWith(raidName)),
    );
  }

  private getBlocksForXfs(parts: Block[]) {
    return this.blocks.filter(
      ({ uuid, type, fsType }) =>
        type === 'md' &&
        fsType === 'xfs' &&
        parts.some((part) => part.uuid === uuid),
    );
  }

  private isRootMount(mount: string) {
    return (
      !this.hostWin32 &&
      (mount === fromHost('/') || mount.startsWith(fromHost('/boot')))
    );
  }

  private getSizeForBlocks(
    deviceBlocks: Block[],
    diskSize: number,
    isHost: boolean,
  ) {
    const sizes = this.validSizes.filter((size) =>
      deviceBlocks.some((block) => {
        const matchedByMount =
          size.mount &&
          (block.mount === size.mount ||
            size.mount.endsWith(\`dev-disk-by-uuid-\${block.uuid}\`));
        const matchedByDevice =
          block.device && size.fs.startsWith(block.device);
        const matchedByHost = isHost && this.isRootMount(size.mount);

        return matchedByMount || matchedByDevice || matchedByHost;
      }),
    );

    if (sizes.length === 0) {
      return -1;
    }

    const calculatedSize = sumUp(sizes, 'used');
    const isLvm = deviceBlocks.some(({ fsType }) => fsType === 'LVM2_member');

    if (isLvm) {
      return calculatedSize;
    }

    const totalAvailable = sumUp(sizes, 'size');
    const preAllocated = Math.max(0, diskSize - totalAvailable);

    return calculatedSize + preAllocated;
  }

  public async getMappedLayout(): Promise<StorageLoadExtendedEntry[]> {
    return Promise.all(
      this.layout.map(async ({ size, disks, virtual, raidLabel, raidName }) => {
        let temperature: number | undefined;
        let overallStatus: string | undefined;
        let healthy: boolean | undefined;

        if (CONFIG.enable_smart_temps && disks.length > 0) {
          const smartCandidates = [
            ...new Set(disks.map((d) => normalizeDevicePath(d.device))),
          ].filter((d) => SMART_SATA_DEVICE_REGEX.test(d));

          if (smartCandidates.length > 0) {
            const smartData = await Promise.all(
              smartCandidates.map((devicePath) => getSmartData(devicePath)),
            );

            const availableTemps = smartData
              .map((entry) => entry.temperature)
              .filter((temp): temp is number => temp != null);

            if (availableTemps.length > 0) {
              temperature = Math.max(...availableTemps);
            }

            if (smartData.some((entry) => entry.overallStatus === 'FAILED')) {
              overallStatus = 'FAILED';
              healthy = false;
            } else if (
              smartData.some((entry) => entry.overallStatus === 'PASSED')
            ) {
              overallStatus = 'PASSED';
              healthy = true;
            }
          }
        }

        if (virtual) {
          const virtualSize = this.sizes.find((s) => s.fs === disks[0]?.device);
          return {
            load: virtualSize?.used ?? 0,
            temperature,
            overallStatus,
            healthy,
          };
        }

        const deviceParts = this.getBlocksForDisks(disks);
        const deviceBlocks = deviceParts
          .concat(this.getBlocksForRaid(raidLabel, raidName))
          .concat(this.getBlocksForXfs(deviceParts));

        const isHost = deviceBlocks.some(({ mount }) => this.isRootMount(mount));

        return {
          load: this.getSizeForBlocks(deviceBlocks, size, isHost),
          temperature,
          overallStatus,
          healthy,
        };
      }),
    );
  }
}

export default async (): Promise<StorageLoad> => {
  const svInfo = getStaticServerInfo();
  const [sizes, blocks] = await Promise.all([si.fsSize(), si.blockDevices()]);

  const extendedLoad = await new DynamicStorageMapper(
    PLATFORM_IS_WINDOWS,
    svInfo.storage,
    blocks,
    sizes,
  ).getMappedLayout();

  return extendedLoad as unknown as StorageLoad;
};
`;

const indexContent = `import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { urlJoin } from '@dashdot/common';
import compression from 'compression';
import cors from 'cors';
import cronParser from 'cronstrue';
import express from 'express';
import { lookup as mimeLookup } from 'mime-types';
import cron from 'node-cron';
import {
  debounceTime,
  lastValueFrom,
  type Observable,
  type Subscription,
  take,
  timeout,
} from 'rxjs';
import { Server } from 'socket.io';
import { CONFIG } from './config';
import getNetworkInfo from './data/network';
import { getDynamicServerInfo } from './dynamic-info';
import {
  setupHostSpecific,
  setupNetworking,
  setupOsVersion,
  tearDownHostSpecific,
} from './setup';
import {
  getStaticServerInfo,
  getStaticServerInfoObs,
  loadInfo,
  loadStaticServerInfo,
} from './static-info';

type LegacyStorageLoadItem = number | { load: number };

const toLegacyStorageLoad = (storage: LegacyStorageLoadItem[]) =>
  storage.map((item) => (typeof item === 'number' ? item : item.load));

const app = express();
const router = express.Router();
const server = http.createServer(app);
const io = new Server(server, {
  cors: CONFIG.disable_integrations
    ? {}
    : {
        origin: '*',
      },
  path: \`/\${urlJoin(CONFIG.routing_path, '/socket')}\`,
});

if (!CONFIG.disable_integrations) {
  app.use(cors());
}

app.use(compression());
app.use(CONFIG.routing_path, router);

if (process.env.NODE_ENV === 'production') {
  router.use(
    express.static(path.join(__dirname, '../../view/dist'), {
      maxAge: '1y',
      setHeaders: (res, path) => {
        if (mimeLookup(path) === 'text/html') {
          res.setHeader('Cache-Control', 'public, max-age=0');
        }
      },
    }),
  );
}

if (!CONFIG.disable_integrations) {
  const getVersionFile = () => {
    try {
      return JSON.parse(
        readFileSync(path.join(__dirname, '../../../version.json'), 'utf-8'),
      );
    } catch (_e) {
      console.warn(
        'Version file not found. This is normal on from-source builds.',
      );
      return {};
    }
  };

  const versionFile = getVersionFile();
  router.get('/config', (_, res) => {
    res.send({
      config: {
        ...CONFIG,
        overrides: undefined,
      },
      version: versionFile.version,
      buildhash: versionFile.buildhash,
    });
  });

  router.get('/info', (_, res) => {
    res.send({ ...getStaticServerInfo(), config: undefined });
  });
}

server.listen(CONFIG.port, async () => {
  console.log(\`listening on *:\${CONFIG.port}\`);

  await setupHostSpecific();
  await setupNetworking();
  await setupOsVersion();
  await loadStaticServerInfo();
  const obs = getDynamicServerInfo();

  if (!CONFIG.disable_integrations) {
    const getCurrentValue = async <T>(
      subj: Observable<T>,
    ): Promise<T | undefined> => {
      try {
        return await lastValueFrom(
          subj.pipe(debounceTime(0), timeout(20), take(1)),
        );
      } catch (_e) {
        return undefined;
      }
    };

    router.get('/load/cpu', async (_, res) => {
      res.send(await getCurrentValue(obs.cpu));
    });
    router.get('/load/ram', async (_, res) => {
      res.send({ load: await getCurrentValue(obs.ram) });
    });
    router.get('/load/storage', async (_, res) => {
      const storage = await getCurrentValue(obs.storage);
      res.send(
        storage
          ? toLegacyStorageLoad(storage as unknown as LegacyStorageLoadItem[])
          : storage,
      );
    });
    router.get('/load/storage-extended', async (_, res) => {
      res.send(await getCurrentValue(obs.storage));
    });
    router.get('/load/network', async (_, res) => {
      res.send(await getCurrentValue(obs.network));
    });
    router.get('/load/gpu', async (_, res) => {
      res.send(await getCurrentValue(obs.gpu));
    });
  }

  io.on('connection', (socket) => {
    const subscriptions: Subscription[] = [];

    subscriptions.push(
      getStaticServerInfoObs().subscribe((staticInfo) => {
        socket.emit('static-info', staticInfo);
      }),
    );

    subscriptions.push(
      obs.cpu.subscribe((cpu) => {
        socket.emit('cpu-load', cpu);
      }),
    );

    subscriptions.push(
      obs.ram.subscribe((ram) => {
        socket.emit('ram-load', ram);
      }),
    );

    subscriptions.push(
      obs.storage.subscribe(async (storage) => {
        socket.emit(
          'storage-load',
          toLegacyStorageLoad(storage as unknown as LegacyStorageLoadItem[]),
        );
        socket.emit('storage-load-extended', storage);
      }),
    );

    subscriptions.push(
      obs.network.subscribe(async (network) => {
        socket.emit('network-load', network);
      }),
    );

    subscriptions.push(
      obs.gpu.subscribe(async (gpu) => {
        socket.emit('gpu-load', gpu);
      }),
    );

    socket.on('disconnect', () => {
      subscriptions.forEach((sub) => {
        sub.unsubscribe();
      });
    });
  });

  if (CONFIG.widget_list.includes('network')) {
    try {
      console.log('Running speed-test (this may take a few minutes)...');

      if (CONFIG.speed_test_interval_cron) {
        if (cron.validate(CONFIG.speed_test_interval_cron)) {
          console.log(
            \`Speed-test interval cron expression: \${
              CONFIG.speed_test_interval_cron
            } (\${cronParser.toString(CONFIG.speed_test_interval_cron)})\`,
          );
        } else {
          console.warn(
            \`Invalid cron expression: \${CONFIG.speed_test_interval_cron}\`,
          );
        }
      }

      await loadInfo('network', () => getNetworkInfo.speedTest(true), true);
    } catch (e) {
      console.warn(e);
    }

    obs.speedTest.subscribe({
      error: (e) => console.warn(e),
    });
  }
});

server.on('error', console.error);

process.on('uncaughtException', (e) => {
  console.error(e);
  tearDownHostSpecific();
  process.exit(1);
});

process.on('unhandledRejection', (e) => {
  console.error(e);
  tearDownHostSpecific();
  process.exit(1);
});

process.on('SIGINT', () => {
  console.info('SIGINT signal received.');
  process.exit(0);
});
`;

writeFileSync(dynamicStorageFile, dynamicStorageContent, 'utf8');
writeFileSync(serverIndexFile, indexContent, 'utf8');

console.log('Applied DashDot SMART overlay patch');
