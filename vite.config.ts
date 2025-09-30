import { defineConfig } from 'vite'

export default defineConfig({
  root: 'public',
  server: {
    port: 3000,
    host: true
  },
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        client: 'public/client.html',
        server: 'public/server.html'
      }
    }
  },
  publicDir: false
})