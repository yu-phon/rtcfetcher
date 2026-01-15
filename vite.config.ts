import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    root: 'examples/browser',
    server: {
        port: 3000,
        open: true
    },
    resolve: {
        alias: {
            '@yuphon/rtcfetcher': resolve(__dirname, './src/index.ts')
        }
    }
});
