import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createChatGPT, ChatGPTError } from '@siwc/local';
import type { ChatGPTClient, CredentialEncryption, SignInOptions } from '@siwc/local';
import { publicError } from './errors.js';

// Secrets travel only through anonymous stdin/stdout pipes, never command arguments,
// shell interpolation, environment variables, log lines or temporary files.
const dpapiScript = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$operation=[Console]::ReadLine()
$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$entropy=[Text.Encoding]::UTF8.GetBytes('mvp-baseline-builder:credentials:v1')
if ($operation -eq 'encrypt') {
  $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
} elseif ($operation -eq 'decrypt') {
  $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
} else { throw 'Invalid operation' }
[Console]::Write([Convert]::ToBase64String($result))
`;
function dpapi(operation: 'encrypt' | 'decrypt', bytes: Uint8Array): Promise<Buffer> {
  if (process.platform !== 'win32') return Promise.reject(new ChatGPTError('encryption_unavailable', 'Windows DPAPI is required.'));
  return new Promise((resolve, reject) => {
    const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', dpapiScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => { child.kill(); reject(new ChatGPTError('encryption_unavailable', 'OS credential encryption timed out.')); }, 15000);
    child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timeout); reject(new ChatGPTError('encryption_unavailable', 'OS credential encryption unavailable.')); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new ChatGPTError('encryption_unavailable', 'OS credential encryption unavailable.'));
      const result = Buffer.concat(chunks).toString('utf8').trim();
      if (!result || !/^[A-Za-z0-9+/=\r\n]+$/.test(result)) return reject(new ChatGPTError('encryption_unavailable', 'Invalid encryption response.'));
      resolve(Buffer.from(result, 'base64'));
    });
    child.stdin.end(`${operation}\n${Buffer.from(bytes).toString('base64')}`);
  });
}
export const windowsCredentialEncryption: CredentialEncryption = {
  id: 'windows-dpapi-current-user-v1',
  isAvailable: () => process.platform === 'win32',
  encrypt: plaintext => dpapi('encrypt', Buffer.from(plaintext, 'utf8')),
  decrypt: async ciphertext => (await dpapi('decrypt', ciphertext)).toString('utf8'),
};
export function openBrowser(url: string): Promise<void> {
  if (!url.startsWith('https://auth.openai.com/')) throw new ChatGPTError('invalid_config', 'Unexpected authorization origin.');
  return new Promise((resolve, reject) => {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new ChatGPTError('browser_unavailable', 'Could not open the authorization browser.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
export interface Auth {
  client: ChatGPTClient;
  status(): Promise<Record<string, unknown>>;
  signIn(options: SignInOptions): void;
  cancel(): void;
  disconnect(): Promise<void>;
  select(id: string): Promise<void>;
}
export function createAuth(storageDir: string): Auth {
  const client = createChatGPT({ appName: 'MVP Baseline Builder', appId: 'mvp-baseline-builder',
    redirectPort: 0, storageDir, credentialEncryption: windowsCredentialEncryption, sendHostId: true, openBrowser });
  let signingIn = false;
  let lastError: ReturnType<typeof publicError> | null = null;
  return {
    client,
    async status() {
      const session = await client.getSession();
      const { error: sdkError, ...safe } = session;
      let profiles: unknown[] = [];
      try { profiles = await client.listProfiles(); } catch (error) { lastError = publicError(error); }
      const sessionError = sdkError ? publicError(new ChatGPTError(sdkError.code, '', sdkError.retryable)) : null;
      return { ...safe, signingIn, profiles, error: lastError ?? sessionError };
    },
    signIn(options) {
      if (signingIn) throw new ChatGPTError('connection_busy', 'Another sign-in is pending.');
      signingIn = true; lastError = null;
      void client.signIn(options).catch(error => { lastError = publicError(error); }).finally(() => { signingIn = false; });
    },
    cancel() { client.cancelSignIn(); },
    async disconnect() { lastError = null; try { await client.disconnect(); } catch (error) { lastError = publicError(error); throw error; } },
    async select(id) { lastError = null; await client.selectProfile(id); },
  };
}
