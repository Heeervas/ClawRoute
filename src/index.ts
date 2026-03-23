/**
 * ClawRoute Entry Point
 *
 * Initializes configuration, database, and starts the server.
 */

import 'dotenv/config';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { logAuthWarning } from './auth.js';
import { initDb, pruneOldEntries, closeDb } from './logger.js';
import { createApp } from './server.js';
// import { isProEnabled } from './router.js'; // Removed in v1.1
import { getStartupSummary } from './stats.js';
import { TaskTier } from './types.js';

/**
 * Print the startup banner.
 */
function printBanner(config: ReturnType<typeof loadConfig>): void {
    const mode = config.dryRun ? 'DRY-RUN' : 'LIVE';
    const auth = config.authToken ? 'token required' : 'open (localhost only)';
    const planLabel = '❤️  Donationware';

    console.log(`
╔═══════════════════════════════════════════════════════╗
║  ClawRoute v1.1                                       ║
║  Intelligent Model Router for OpenClaw                ║
║                                                       ║
║  Proxy:     http://${config.proxyHost}:${config.proxyPort}                    ║
║  Dashboard: http://${config.proxyHost}:${config.proxyPort}/dashboard         ║
║  Mode:      ${mode.padEnd(8)}                                 ║
║  Plan:      ${planLabel.padEnd(8)}                                 ║
║  Auth:      ${auth.padEnd(24)}             ║
║                                                       ║
║  Tier Model Mappings:                                 ║
║    Heartbeat → ${(config.models[TaskTier.HEARTBEAT]?.primary ?? 'N/A').padEnd(30)}    ║
║    Simple    → ${(config.models[TaskTier.SIMPLE]?.primary ?? 'N/A').padEnd(30)}    ║
║    Moderate  → ${(config.models[TaskTier.MODERATE]?.primary ?? 'N/A').padEnd(30)}    ║
║    Complex   → ${(config.models[TaskTier.COMPLEX]?.primary ?? 'N/A').padEnd(30)}    ║
║    Frontier  → ${(config.models[TaskTier.FRONTIER_SONNET]?.primary ?? 'N/A').padEnd(30)} (Sonnet) ║
║               ${(config.models[TaskTier.FRONTIER_OPUS]?.primary   ?? 'N/A').padEnd(30)} (Opus)   ║
╚═══════════════════════════════════════════════════════╝
`);
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
    try {
        console.log('🚀 Starting ClawRoute...\n');

        // Load configuration
        const config = loadConfig();

        // Log auth warning if needed
        logAuthWarning(config);

        // Initialize database (async for sql.js)
        console.log('📦 Initializing database...');
        await initDb(config);

        // Prune old entries
        const pruned = pruneOldEntries(config.logging.retentionDays);
        if (pruned > 0) {
            console.log(`🧹 Pruned ${pruned} old log entries`);
        }

        // Print startup summary
        const summary = getStartupSummary(config);
        if (summary) {
            console.log(`📊 ${summary}\n`);
        }

        // Create app
        const app = createApp(config);

        // Print banner
        printBanner(config);

        // Start server
        serve({
            fetch: app.fetch,
            hostname: config.proxyHost,
            port: config.proxyPort,
        });

        console.log(`\n✅ ClawRoute is running on http://${config.proxyHost}:${config.proxyPort}`);
        console.log('   Press Ctrl+C to stop\n');

        // Graceful shutdown handlers
        const shutdown = (signal: string) => {
            console.log(`\n\n🛑 Received ${signal}, shutting down...`);
            closeDb();
            console.log('👋 ClawRoute stopped. Goodbye!');
            process.exit(0);
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));

        // Handle uncaught errors
        process.on('uncaughtException', (error) => {
            console.error('❌ Uncaught exception:', error);
            closeDb();
            process.exit(1);
        });

        process.on('unhandledRejection', (reason) => {
            console.error('❌ Unhandled rejection:', reason);
        });
    } catch (error) {
        console.error('❌ Failed to start ClawRoute:', error);
        process.exit(1);
    }
}

// Run
main();
