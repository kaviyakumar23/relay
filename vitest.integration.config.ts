import { defineConfig } from 'vitest/config';

// Integration tests hit real Postgres/Redis from docker-compose.
// Each file guards with describe.skipIf(!process.env.DATABASE_URL) so the
// suite is always safe to run without infra.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});
