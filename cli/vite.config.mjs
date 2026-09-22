import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

const config = {
  configFile: false,
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: fileURLToPath(new URL('../public', import.meta.url)),
  plugins: [react()],
  logLevel: 'error',
  server: { host: '127.0.0.1', middlewareMode: true, watch: null, fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
};

export default config;
