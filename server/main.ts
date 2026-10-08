import { resolve } from 'node:path';
import { Store } from './store.js';
import { createAuth, windowsCredentialEncryption } from './auth.js';
import { AIConnections } from './ai-connections.js';
import { AIProvider } from './ai-provider.js';
import { ChatGPTProvider } from './provider.js';
import { buildApp } from './app.js';

const dataDir = resolve(process.env.BASELINE_DATA_DIR ?? 'data');
const store = new Store(resolve(dataDir, 'baseline.sqlite'));
const auth = createAuth(resolve(dataDir, 'auth'));
const connections = new AIConnections(resolve(dataDir, 'auth'), windowsCredentialEncryption);
const app = await buildApp({ store, auth, connections, provider: new AIProvider(new ChatGPTProvider(auth.client), connections), privateRoots: [dataDir], dev: process.env.NODE_ENV !== 'production' && process.argv.includes('--dev') });
const port = Number(process.env.PORT ?? 3000);
try {
  await app.listen({ host: '127.0.0.1', port });
  console.log(`MVP Baseline Builder → http://127.0.0.1:${port}`);
} catch { store.close(); console.error('本地服务未能启动，请检查端口或先执行 pnpm build。'); process.exit(1); }
let closing = false;
async function stop() { if (closing) return; closing = true; await app.close(); store.close(); process.exit(0); }
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
