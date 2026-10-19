import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "../config/serverConfig";

export type StoragePaths = {
  dataDir: string;
  databasePath: string;
  discussionsDir: string;
  /** 始终由 ensureStoragePaths 提供；测试可能构造不含该字段的部分 StoragePaths，故声明为可选。 */
  logsDir?: string;
};

export function ensureStoragePaths(config: ServerConfig): StoragePaths {
  const paths = {
    dataDir: config.dataDir,
    databasePath: join(config.dataDir, "app.db"),
    discussionsDir: join(config.dataDir, "discussions"),
    logsDir: join(config.dataDir, "logs")
  };

  mkdirSync(paths.discussionsDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  return paths;
}
