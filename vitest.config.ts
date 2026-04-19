import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // 默认不把 obsidian 当成要解析的包——测试的都是纯函数，应该避免引入它
    environment: 'node',
  },
});
