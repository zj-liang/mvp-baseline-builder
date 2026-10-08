import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createChatGPT } from '@siwc/local';
import { ConnectionStore } from '../vendor/siwc-local/src/storage.js';
import { windowsCredentialEncryption } from '../server/auth.js';

describe('Real Windows DPAPI storage (synthetic credentials; no account login)', () => {
  it.skipIf(process.platform !== 'win32')('starts the real loopback OAuth listener with PKCE and rejects incorrect state', async () => {
    mkdirSync(resolve('.cache/tests'), { recursive: true }); const dir = mkdtempSync(resolve('.cache/tests/oauth-'));
    let client: ReturnType<typeof createChatGPT> | undefined;
    const originalFetch = globalThis.fetch;
    // Only remote discovery is a fixture; the callback listener and HTTP request are real.
    const mockDiscovery = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (String(url) === 'https://auth.openai.com/.well-known/openid-configuration') return Promise.resolve(Response.json({
        issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
        token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
        revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
      }));
      return originalFetch(url, init);
    });
    try {
      let received!: (url: string) => void;
      const opened = new Promise<string>(done => { received = done; });
      client = createChatGPT({ appName: 'MVP Baseline Builder Test', appId: 'mvp-baseline-builder-test', redirectPort: 0, storageDir: dir,
        credentialEncryption: windowsCredentialEncryption, sendHostId: true, openBrowser: url => { received(url); } });
      const attempt = client.signIn().catch(error => error);
      const url = new URL(await opened);
      expect(url.origin).toBe('https://auth.openai.com');
      expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
      expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBeTruthy(); expect(url.searchParams.get('state')).toBeTruthy(); expect(url.searchParams.get('nonce')).toBeTruthy();
      expect(url.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      expect(callback.hostname).toBe('127.0.0.1'); expect(callback.pathname).toBe('/auth/callback');
      callback.search = '?state=incorrect-state&code=synthetic&client_id=synthetic';
      const response = await fetch(callback);
      expect(response.status).toBeGreaterThanOrEqual(400);
      client.cancelSignIn(); await attempt;
      expect((await client.getSession()).sharing).toBe(false);
    } finally { client?.cancelSignIn(); mockDiscovery.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
  it.skipIf(process.platform !== 'win32')('encrypts at rest, survives a new runtime and exposes only safe session data', async () => {
    mkdirSync(resolve('.cache/tests'), { recursive: true }); const dir = mkdtempSync(resolve('.cache/tests/dpapi-'));
    const synthetic = 'synthetic-credential-for-dpapi-test-only';
    try {
      const store = new ConnectionStore(dir, windowsCredentialEncryption);
      await store.withLock(() => store.write({ version: 2, activeProfileId: 'fixture-profile', pendingRegistrations: [], profiles: [{
        version: 1, id: 'fixture-profile', label: 'Fixture', clientId: 'fixture-client', status: 'connected',
        scopes: ['chatgpt.tokens.use.direct'], savedAt: new Date().toISOString(), identity: { email: 'fixture@example.test' },
        credentials: { accessToken: synthetic, expiresAt: Date.now() + 3600000 },
      }] }));
      const raw = readFileSync(join(dir, 'chatgpt-auth.json'), 'utf8');
      expect(raw).not.toContain(synthetic); expect(raw).not.toContain('fixture@example.test');
      const firstHost = await store.withLock(() => store.getHostId());
      const restored = new ConnectionStore(dir, windowsCredentialEncryption);
      expect(await restored.withLock(() => restored.getHostId())).toBe(firstHost);
      const client = createChatGPT({ appName: 'MVP Baseline Builder Test', appId: 'mvp-baseline-builder-test', redirectPort: 0,
        storageDir: dir, credentialEncryption: windowsCredentialEncryption, sendHostId: true });
      const safe = await client.getSession();
      expect(safe.status).toBe('connected'); expect(safe.sharing).toBe(true);
      expect(JSON.stringify(safe)).not.toContain(synthetic); expect(JSON.stringify(await client.listProfiles())).not.toMatch(/accessToken|refreshToken|credentials/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
});
