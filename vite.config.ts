import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const proxy = {
  '/bitget': {
    target: 'https://api.bitget.com',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/bitget/, ''),
    proxyTimeout: 8000,
    timeout: 10000,
  },
}
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 2029, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 2029, strictPort: true, proxy },
})
