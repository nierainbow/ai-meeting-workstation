import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database";

describe("utterances 声纹列迁移 (T2.5)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "aimw-db-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("新库直接带 cluster_id / identify_status / confirmed_by", () => {
    const db = openDatabase(join(dir, "app.db"));
    const cols = (db.prepare("PRAGMA table_info(utterances)").all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain("cluster_id");
    expect(cols).toContain("identify_status");
    expect(cols).toContain("confirmed_by");
    db.close();
  });

  it("旧库重开幂等迁移，不重复加列不报错", () => {
    const p = join(dir, "app.db");
    openDatabase(p).close();
    const db = openDatabase(p); // 第二次打开重跑 migrate
    const cols = (db.prepare("PRAGMA table_info(utterances)").all() as Array<{ name: string }>).map(c => c.name);
    expect(cols.filter(c => c === "cluster_id")).toHaveLength(1);
    db.close();
  });
});
