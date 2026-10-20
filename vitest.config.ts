import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // src：产品代码与前端状态机；scripts：发布/更新通道的上游逻辑
    // （scripts/update-upstream.test.mjs 验 manifest 路由与静态服务器，避免发版脚本裸奔）。
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"]
  }
});
