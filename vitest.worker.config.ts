import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { bindings: {
    ONLINE_ENABLED:'true', DEV_BYPASS:'true', ALLOWED_ORIGIN:'http://localhost',
    HMAC_SECRET:'local-testing-secret-32-characters-minimum', ADMIN_SECRET:'local-admin-secret-32-characters-minimum'
  } } })],
  test: { include: ['src/worker/**/*.integration.test.ts','tests/**/*.integration.test.ts'], testTimeout: 20000 }
});
