import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Port 5180, never ../map's 5173: the same origin would share its browser storage (projects and background images).
const server = { host: '127.0.0.1', port: 5180, strictPort: true };
export default defineConfig({ plugins: [react()], server, preview: server, build: { target: 'es2022' } });
