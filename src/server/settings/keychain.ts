import { spawnSync } from "node:child_process";

// settings.local.json 里只写引用，真实 Key 放系统钥匙串：
//   macOS   -> security CLI（login keychain，generic password）
//   Windows -> DPAPI / wincred（当前为占位实现，未接原生模块）
// 引用形如 `keychain:aimw/<account>`；解析时若读不到就退回空串，
// 让上层按「未配置」处理，绝不在磁盘上留下任何可还原的明文。
export const KEYCHAIN_SERVICE = "aimw";
export const KEYCHAIN_REF_PREFIX = "keychain:";

export type SecretStore = {
  readonly backend: "keychain" | "dpapi" | "file";
  readonly available: boolean;
  get(account: string): string;
  set(account: string, value: string): void;
  remove(account: string): void;
};

export function keychainRef(account: string): string {
  return `${KEYCHAIN_REF_PREFIX}${KEYCHAIN_SERVICE}/${account}`;
}

export function isKeychainRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(KEYCHAIN_REF_PREFIX);
}

function macosKeychainStore(): SecretStore {
  const run = (args: string[], input?: string) =>
    spawnSync("security", args, {
      input,
      encoding: "utf8",
      stdio: input === undefined ? ["ignore", "pipe", "ignore"] : ["pipe", "pipe", "ignore"]
    });

  return {
    backend: "keychain",
    // security 在 macOS 一定存在；真正不可用（无 login keychain / 被沙箱拦住）
    // 会在 set/get 时报错，由上层捕获后回退到内存态，不会写明文。
    available: true,
    get(account) {
      const result = run(["-w", "-s", KEYCHAIN_SERVICE, "-a", account]);
      if (result.status !== 0 || typeof result.stdout !== "string") return "";
      return result.stdout.replace(/\n$/, "");
    },
    set(account, value) {
      // -U 覆盖同名项；密钥本身不作为 argv 传入，走 stdin，避免出现在进程表里。
      const result = run(
        ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", "-", "-U"],
        value
      );
      if (result.status !== 0) {
        throw new Error(`无法写入 macOS 钥匙串（${String(result.error?.message ?? "unknown")}），请检查登录钥匙串权限。`);
      }
    },
    remove(account) {
      run(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]);
    }
  };
}

function dpapiStubStore(): SecretStore {
  // Windows 真机验收（T0.4）前不接原生模块：先明确报不可用，
  // 让 localSettings 保持把 Key 留在原文件并提示，而不是假装安全。
  return {
    backend: "dpapi",
    available: false,
    get() {
      return "";
    },
    set() {
      throw new Error("Windows DPAPI 密钥存储尚未实现（等待 T0.4 真机验收后接入）。");
    },
    remove() {}
  };
}

export function createSecretStore(platform: NodeJS.Platform = process.platform): SecretStore {
  return platform === "win32" ? dpapiStubStore() : macosKeychainStore();
}
