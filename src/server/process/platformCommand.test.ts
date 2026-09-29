import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWindowsShellCommand, defaultPythonCommand, prepareCommand, venvPythonPath } from "./platformCommand";

let binDir: string;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "meeting-platform-command-"));
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
});

describe("prepareCommand", () => {
  it("leaves commands untouched outside Windows", () => {
    expect(prepareCommand("codex", ["exec", "-"], "darwin")).toEqual({ command: "codex", args: ["exec", "-"], shell: false });
  });

  it("runs npm-style .cmd shims through cmd.exe on Windows", () => {
    writeFileSync(join(binDir, "codex.cmd"), "");
    const prepared = prepareCommand("codex", ["exec", "--json", "-"], "win32", { PATH: binDir, PATHEXT: ".exe;.cmd" });

    expect(prepared.shell).toBe(true);
    expect(prepared.args).toEqual([]);
    expect(prepared.command).toBe(`${join(binDir, "codex.cmd")} exec --json -`);
  });

  it("starts real .exe files directly on Windows so arguments are passed verbatim", () => {
    writeFileSync(join(binDir, "python.exe"), "");
    const prepared = prepareCommand("python", ["-c", "import funasr"], "win32", { PATH: binDir, PATHEXT: ".exe;.cmd" });

    expect(prepared).toEqual({ command: join(binDir, "python.exe"), args: ["-c", "import funasr"], shell: false });
  });
});

describe("buildWindowsShellCommand", () => {
  it("quotes a CLI path that contains spaces", () => {
    expect(buildWindowsShellCommand("C:\\Program Files\\nodejs\\npm.cmd", ["--version"])).toBe(
      '"C:\\Program Files\\nodejs\\npm.cmd" --version'
    );
  });

  it("refuses arguments that cmd.exe could reinterpret", () => {
    expect(() => buildWindowsShellCommand("codex.cmd", ["hello world"])).toThrow("不安全字符");
    expect(() => buildWindowsShellCommand("codex.cmd", ["a&calc"])).toThrow("不安全字符");
    expect(() => buildWindowsShellCommand("codex.cmd", ["%PATH%"])).toThrow("不安全字符");
  });
});

describe("python helpers", () => {
  it("uses the platform-specific default command and venv layout", () => {
    expect(defaultPythonCommand("darwin")).toBe("python3");
    expect(defaultPythonCommand("win32")).toBe("python");
    expect(venvPythonPath("venv", "darwin")).toBe(join("venv", "bin", "python"));
    expect(venvPythonPath("venv", "win32")).toBe(join("venv", "Scripts", "python.exe"));
  });
});
