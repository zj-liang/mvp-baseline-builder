import { mkdir, readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import type { CredentialEncryption } from '@siwc/local';
import { connectionIdSchema, inferenceOptionsSchema } from '../shared/inference.js';
import type { AIState, ConnectionId, InferenceOptions, ConnectionState } from '../shared/inference.js';
import { AppError } from './errors.js';

const apiIds = ['openai', 'deepseek', 'glm'] as const;
const recordSchema = z.strictObject({ key: z.string().trim().min(1).max(4096), status: z.enum(['configured', 'verified', 'failed']), testedModel: z.string().optional(), error: z.string().optional() });
const dataSchema = z.strictObject({ version: z.literal(1), activeConnectionId: connectionIdSchema,
  keys: z.partialRecord(z.enum(apiIds), recordSchema), preferences: z.record(z.string(), inferenceOptionsSchema) });
type Data = z.infer<typeof dataSchema>;
const empty = (): Data => ({ version: 1, activeConnectionId: 'chatgpt', keys: {}, preferences: {} });

export class AIConnections {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly filename: string;
  constructor(private directory: string, private encryption: CredentialEncryption) { this.filename = join(directory, 'model-api-keys.json'); }
  private async safeFile(path: string) {
    try { const info = await lstat(path); if (info.isSymbolicLink()) throw new AppError('ai_storage_unsafe', '连接存储不能使用符号链接。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private access<T>(run: (data: Data) => Promise<T>, save = false): Promise<T> {
    const work = this.tail.then(async () => {
      await mkdir(this.directory, { recursive: true }); await this.safeFile(this.directory); await this.safeFile(this.filename);
      let compromised = false;
      let release: (() => Promise<void>) | undefined;
      // proper-lockfile tracks ownership by target, not lockfilePath. The ChatGPT
      // store locks this directory, so API credentials must use their own target.
      // realpath:false also supports the first save before this file exists.
      try { release = await lockfile.lock(this.filename, { realpath: false, lockfilePath: this.filename + '.lock', retries: 0, onCompromised: () => { compromised = true; } }); }
      catch { throw new AppError('ai_storage_busy', '连接配置正被其他应用更新，请稍后重试。', 409); }
      try {
        let data = empty();
        let raw: string | undefined;
        try { raw = await readFile(this.filename, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('ai_storage_failed', '无法读取连接配置，已有凭据保留。'); }
        if (raw) {
          try {
            const envelope = z.strictObject({ version: z.literal(1), provider: z.literal(this.encryption.id), ciphertext: z.string().min(1).max(1048576).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).parse(JSON.parse(raw));
            if (!await this.encryption.isAvailable()) throw new Error();
            data = dataSchema.parse(JSON.parse(await this.encryption.decrypt(Buffer.from(envelope.ciphertext, 'base64'))));
          } catch { throw new AppError('ai_storage_failed', '无法解密连接配置，请检查原 Windows 用户环境。已有凭据保留。'); }
        }
        const result = await run(data);
        if (save) {
          let ciphertext: Uint8Array;
          try { if (!await this.encryption.isAvailable()) throw new Error(); ciphertext = await this.encryption.encrypt(JSON.stringify(data)); if (!ciphertext.length) throw new Error(); }
          catch { throw new AppError('ai_storage_failed', '连接加密失败，原有配置保留。'); }
          const temporary = this.filename + '.' + randomUUID() + '.tmp';
          try {
            if (compromised) throw new Error();
            await writeFile(temporary, JSON.stringify({ version: 1, provider: this.encryption.id, ciphertext: Buffer.from(ciphertext).toString('base64') }), { flag: 'wx', mode: 0o600 });
            // Windows can briefly deny atomic replacement while another OS
            // process has the ciphertext open. Retry only this local rename,
            // within 250 ms; never repeat encryption or a provider request.
            for (let attempt = 0; ; attempt++) {
              if (compromised) throw new Error('Credential lock lost');
              try { await rename(temporary, this.filename); break; }
              catch (error) {
                if (process.platform !== 'win32' || attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
                await delay(25 * (attempt + 1));
              }
            }
          } catch (error) { const failure = new AppError('ai_storage_failed', '无法保存连接配置，原有配置保留。'); failure.cause = error; throw failure; }
          finally { await unlink(temporary).catch(() => {}); }
        }
        return result;
      } finally { await release(); }
    });
    this.tail = work.catch(() => {}); return work;
  }
  state(): Promise<AIState> {
    return this.access(async data => ({ activeConnectionId: data.activeConnectionId, preferences: data.preferences,
      connections: [{ id: 'chatgpt', configured: false, status: 'unconfigured' }, ...apiIds.map(id => {
        const value = data.keys[id]; return { id, configured: Boolean(value), status: value?.status ?? 'unconfigured', ...(value?.testedModel ? { testedModel: value.testedModel } : {}), ...(value?.error ? { error: value.error } : {}) } as ConnectionState;
      })] }));
  }
  saveKey(id: ConnectionId, key: string) {
    if (id === 'chatgpt') throw new AppError('invalid_connection', 'ChatGPT 账号请使用官方登录。');
    const value = z.string().trim().min(1).max(4096).refine(s => !/[\r\n\x00-\x1f\x7f]/.test(s)).parse(key);
    return this.access(async data => { data.keys[id] = { key: value, status: 'configured' }; }, true);
  }
  removeKey(id: ConnectionId) {
    if (id === 'chatgpt') throw new AppError('invalid_connection', 'ChatGPT 账号请使用退出连接。');
    return this.access(async data => { delete data.keys[id]; }, true);
  }
  key(id: Exclude<ConnectionId, 'chatgpt'>): Promise<string> {
    return this.access(async data => { const key = data.keys[id]?.key; if (!key) throw new AppError('api_key_required', '请先保存此厂商的 API Key。', 409); return key; });
  }
  preferences(id: ConnectionId, preferenceKey: string, value: InferenceOptions) {
    return this.access(async data => { data.activeConnectionId = id; data.preferences[preferenceKey] = { ...value, connectionId: id }; }, true);
  }
  select(id: ConnectionId) { return this.access(async data => { data.activeConnectionId = id; }, true); }
  testResult(id: Exclude<ConnectionId, 'chatgpt'>, model: string, error?: string) {
    return this.access(async data => { const entry = data.keys[id]; if (entry) { entry.status = error ? 'failed' : 'verified'; entry.testedModel = model; entry.error = error; } }, true);
  }
}
