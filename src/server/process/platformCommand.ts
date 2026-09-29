import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

// Windows 上 npm 安装的 CLI（codex、claude、npm 本身）是 .cmd 包装脚本，Node 不经过 shell 无法直接启动。
// 只有这类脚本才走 cmd.exe，并且参数必须是不含空格、引号和 cmd 特殊字符的简单值；长文本一律走 stdin。
const WINDOWS_SHELL_SAFE_ARG = /^[0-9A-Za-z_@+=:,./\\-]+$/;

export type PreparedCommand = {
  command: string;
  args: string[];
  shell: boolean;
};

export function defaultPythonCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "python" : "python3";
}

export function venvPythonPath(venvRoot: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? join(venvRoot, "Scripts", "python.exe") : join(venvRoot, "bin", "python");
}

export function prepareCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): PreparedCommand {
  if (platform !== "win32") return { command, args, shell: false };

  const resolved = resolveWindowsExecutable(command, env) ?? command;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args, shell: false };
  return { command: buildWindowsShellCommand(resolved, args), args: [], shell: true };
}

export function buildWindowsShellCommand(command: string, args: string[]): string {
  for (const arg of args) {
    if (!WINDOWS_SHELL_SAFE_ARG.test(arg)) {
      throw new Error(`Windows 下调用 ${command} 时参数含有不安全字符：${arg}`);
    }
  }
  const quoted = /[\s&()^|<>]/.test(command) ? `"${command.replace(/"/g, "")}"` : command;
  return [quoted, ...args].join(" ");
}

export function spawnCommand(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const prepared = prepareCommand(command, args);
  return spawn(prepared.command, prepared.args, { ...options, shell: prepared.shell, windowsHide: true });
}

export function commandSucceeds(command: string, args: string[]): boolean {
  try {
    const prepared = prepareCommand(command, args);
    const result = spawnSync(prepared.command, prepared.args, { stdio: "ignore", shell: prepared.shell, windowsHide: true });
    return result.status === 0;
  } catch {
    return false;
  }
}

// Windows 下经 cmd.exe 启动的进程，只杀外层 shell 会留下真正干活的子进程，所以要连进程树一起结束。
export function stopProcessTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {
      child.kill();
    });
    return;
  }
  child.kill("SIGTERM");
}

function resolveWindowsExecutable(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const extensions = (env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  const candidatesFor = (base: string) => (extname(base) ? [base] : extensions.map((ext) => `${base}${ext}`));

  if (command.includes("/") || command.includes("\\")) {
    return candidatesFor(command).find((candidate) => existsSync(candidate));
  }

  const searchPath = env.PATH ?? env.Path ?? "";
  for (const dir of searchPath.split(";").filter(Boolean)) {
    const found = candidatesFor(join(dir, command)).find((candidate) => existsSync(candidate));
    if (found) return found;
  }
  return undefined;
}
