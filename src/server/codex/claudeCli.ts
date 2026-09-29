import { buildDiscussionTurnPrompt, type CodexProvider, type CodexTurnInput, type CreateCodexThreadInput } from "./provider";
import { spawnCommand, stopProcessTree } from "../process/platformCommand";

type ClaudeCliConfig = {
  cliPath: string;
  model: string;
  fallbackModel?: string;
  timeoutMs: number;
};

export class ClaudeCliProvider implements CodexProvider {
  constructor(private readonly config: ClaudeCliConfig) {}

  async createThread(input: CreateCodexThreadInput): Promise<string> {
    return `claude-cli-${slugify(input.discussion.title)}-${Date.now()}`;
  }

  buildPrompt(input: CodexTurnInput): string {
    return buildDiscussionTurnPrompt(input.discussion, input.utterances, input.memoryContext, input.guidance);
  }

  async respond(input: CodexTurnInput): Promise<string> {
    return this.completePrompt({ prompt: this.buildPrompt(input), cwd: input.discussion.projectPath });
  }

  async completePrompt(input: { prompt: string; cwd?: string }): Promise<string> {
    const args = ["-p", "--model", this.config.model, "--no-session-persistence"];
    if (this.config.fallbackModel) args.push("--fallback-model", this.config.fallbackModel);
    // 提示词走 stdin：避免命令行长度上限，Windows 经 cmd.exe 启动时也不会被转义规则破坏。
    return runCli(this.config.cliPath, args, input.prompt, this.config.timeoutMs, "Claude CLI");
  }
}

function runCli(command: string, args: string[], stdin: string, timeoutMs: number, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      stopProcessTree(child);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === "ENOENT") {
        reject(new Error(`${label} 不存在，请在设置中检查路径：${command}`));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${label} 超时，已超过 ${timeoutMs}ms。`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${label} 执行失败（exit ${code}）：${summarizeFailure(stderr || stdout)}`));
        return;
      }
      const text = stdout.trim();
      if (!text) {
        reject(new Error(`${label} 返回为空。`));
        return;
      }
      resolve(text);
    });

    child.stdin?.end(stdin);
  });
}

function summarizeFailure(output: string): string {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "没有错误输出。"
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}
