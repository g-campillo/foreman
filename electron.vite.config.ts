import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// The Agent SDK spawns a CLI subprocess and node-pty is a native module — neither
// survives bundling, so both stay external and get asarUnpack'd at package time.
export default defineConfig({
  // Two entries, not one: `host` is the detached agent process, spawned with
  // ELECTRON_RUN_AS_NODE so it runs under Electron's bundled Node with no
  // second runtime to ship. It lands at out/main/host.js, inside app.asar —
  // which is fine, because `require` is asar-aware and only `spawn` is not.
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          host: resolve(__dirname, 'src/host/index.ts'),
        },
      },
    },
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } },
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
})
