/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const base = process.env.BASE_URL ?? '/meteo-night/';

export default defineConfig({
  plugins: [react()],
  base,
  test: {
    globals: true,
    environment: 'node',
  },
});
