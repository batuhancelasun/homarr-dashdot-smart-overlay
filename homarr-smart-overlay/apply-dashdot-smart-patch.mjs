import { readFileSync, writeFileSync } from "node:fs";

const filePath = "/src/packages/integrations/src/dashdot/dashdot-integration.ts";
let content = readFileSync(filePath, "utf8");

const replaceOrThrow = (search, replacement, label) => {
  if (!content.includes(search)) {
    throw new Error(`Patch failed: could not find block for ${label}`);
  }
  content = content.replace(search, replacement);
};

replaceOrThrow(
  "    const storageLoad = await this.getCurrentStorageLoadAsync();\n    const networkLoad = await this.getCurrentNetworkLoadAsync();",
  "    const storageLoad = await this.getCurrentStorageLoadAsync();\n    const storageLoadValues = storageLoad.map((item) => item.load);\n    const networkLoad = await this.getCurrentNetworkLoadAsync();",
  "storage load values",
);

replaceOrThrow(
  "      fileSystem: info.storage\n        .filter((_, index) => storageLoad[index] !== -1) // filter out undermoutned drives, they display as -1 in the load API\n        .map((storage, index) => ({\n          deviceName: `Storage ${index + 1}: (${storage.disks.map((disk) => disk.device).join(\", \")})`,\n          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion\n          used: humanFileSize(storageLoad[index]!),\n          available: storageLoad[index] ? `${storage.size - storageLoad[index]}` : `${storage.size}`,\n          percentage: storageLoad[index] ? (storageLoad[index] / storage.size) * 100 : 0,\n        })),",
  "      fileSystem: info.storage\n        .filter((_, index) => storageLoadValues[index] !== -1) // filter out undermoutned drives, they display as -1 in the load API\n        .map((storage, index) => ({\n          deviceName: `Storage ${index + 1}: (${storage.disks.map((disk) => disk.device).join(\", \")})`,\n          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion\n          used: humanFileSize(storageLoadValues[index]!),\n          available: storageLoadValues[index] ? `${storage.size - storageLoadValues[index]}` : `${storage.size}`,\n          percentage: storageLoadValues[index] ? (storageLoadValues[index] / storage.size) * 100 : 0,\n        })),",
  "filesystem load usage",
);

replaceOrThrow(
  "      smart: [], // API endpoint does not provide S.M.A.R.T data.",
  "      smart: info.storage.map((storage, index) => ({\n        deviceName: `Storage ${index + 1}: (${storage.disks.map((disk) => disk.device).join(\", \")})`,\n        temperature: storageLoad[index]?.temperature ?? null,\n        overallStatus: storageLoad[index]?.overallStatus ?? \"N/A\",\n        healthy: storageLoad[index]?.healthy ?? false,\n      })),",
  "smart mapping",
);

replaceOrThrow(
  `  private async getCurrentStorageLoadAsync() {
    const storageLoad = await fetchWithTrustedCertificatesAsync(this.url("/load/storage"));
    // we convert it to text as the response is either valid json or empty if storage widget is disabled.
    const result = await storageLoad.text();
    if (result.length === 0) {
      return [];
    }

    return JSON.parse(result) as number[];
  }`,
  `  private async getCurrentStorageLoadAsync() {
    const storageLoadExtended = await fetchWithTrustedCertificatesAsync(this.url("/load/storage-extended"));
    const extendedResult = await storageLoadExtended.text();

    // Prefer extended payload when available
    if (extendedResult.length > 0) {
      const extendedData = JSON.parse(extendedResult) as StorageLoadExtendedApi;
      if (
        Array.isArray(extendedData) &&
        extendedData.every(
          (item) =>
            item &&
            typeof item === "object" &&
            typeof item.load === "number",
        )
      ) {
        return extendedData;
      }
    }

    const storageLoad = await fetchWithTrustedCertificatesAsync(this.url("/load/storage"));
    const result = await storageLoad.text();
    if (result.length === 0) {
      return [];
    }

    return (JSON.parse(result) as number[]).map((load) => ({ load }));
  }`,
  "getCurrentStorageLoadAsync",
);

replaceOrThrow(
  "const networkLoadApi = z.object({\n  up: z.number().min(0),\n  down: z.number().min(0),\n});",
  "const networkLoadApi = z.object({\n  up: z.number().min(0),\n  down: z.number().min(0),\n});\n\ntype StorageLoadEntry = {\n  load: number;\n  temperature?: number;\n};\n\ntype StorageLoadExtendedApi = StorageLoadEntry[];",
  "storage load types",
);

writeFileSync(filePath, content, "utf8");
console.log("Applied DashDot SMART patch to Homarr integration");
