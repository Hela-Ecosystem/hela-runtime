#!/usr/bin/env node
import { HelaRuntime } from './daemon.js';
async function main() {
    const rt = new HelaRuntime();
    const shutdown = async () => {
        console.error('[hela-runtime] shutting down...');
        await rt.shutdown();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    try {
        await rt.boot();
        await rt.serveStdio();
    }
    catch (e) {
        console.error('[hela-runtime] fatal:', e);
        process.exit(1);
    }
}
main();
