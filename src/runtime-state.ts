import { buildRoutingSnapshot } from './config.js';
import { RoutingSnapshot } from './types.js';

interface RuntimeStateOptions {
    projectRoot: string;
    pollIntervalMs?: number;
}

export interface RuntimeStateManager {
    getSnapshot(): RoutingSnapshot;
    reloadNow(reason?: string): Promise<RoutingSnapshot>;
    stop(): void;
}

function startPolling(
    options: RuntimeStateOptions,
    loadSnapshot: () => void
): NodeJS.Timeout | null {
    if (!options.pollIntervalMs || options.pollIntervalMs < 1) {
        return null;
    }

    return setInterval(loadSnapshot, options.pollIntervalMs);
}

export function createRuntimeStateManager(
    options: RuntimeStateOptions
): RuntimeStateManager {
    let snapshot = buildRoutingSnapshot(options.projectRoot);

    const loadSnapshot = (): void => {
        const nextSnapshot = buildRoutingSnapshot(options.projectRoot);
        snapshot = nextSnapshot;
    };

    let timer = startPolling(options, () => {
        try {
            loadSnapshot();
        } catch {
            // Keep serving the last known-good snapshot.
        }
    });

    return {
        getSnapshot(): RoutingSnapshot {
            return snapshot;
        },
        async reloadNow(): Promise<RoutingSnapshot> {
            loadSnapshot();
            return snapshot;
        },
        stop(): void {
            if (!timer) return;
            clearInterval(timer);
            timer = null;
        },
    };
}