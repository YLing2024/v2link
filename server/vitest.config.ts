import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    // 每个测试文件独立模块注册表, 便于注入 DB_PATH 等临时目录 env
    isolate: true,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
})
