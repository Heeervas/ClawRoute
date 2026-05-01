import { ClawRouteConfig, ModelEntry, ProviderType } from './types.js';
import { getAllModels, getApiBaseUrl, getAuthHeader, getModelEntry } from './models.js';

const REQUIRED_FIELDS = [
    'maxContext',
    'toolCapable',
    'multimodal',
    'enabled',
    'inputCostPer1M',
    'outputCostPer1M',
] as const;

type RequiredField = typeof REQUIRED_FIELDS[number];

export interface DiscoveredModelCandidate {
    id: string;
    provider: ProviderType;
    discoveryOnly: boolean;
    missingFields: RequiredField[];
    maxContext?: number;
    toolCapable?: boolean;
    multimodal?: boolean;
    enabled?: boolean;
    inputCostPer1M?: number;
    outputCostPer1M?: number;
}

type DiscoveryResponse = {
    data?: Array<{ id?: string }>;
};

function normalizeModelId(provider: ProviderType, rawId: string): string {
    return rawId.includes('/') ? rawId : `${provider}/${rawId}`;
}

function getMissingFields(entry: Partial<ModelEntry>): RequiredField[] {
    return REQUIRED_FIELDS.filter((field) => entry[field] === undefined);
}

function toCandidate(provider: ProviderType, rawId: string): DiscoveredModelCandidate {
    const id = normalizeModelId(provider, rawId);
    const entry = getModelEntry(id);
    if (!entry) {
        return {
            id,
            provider,
            discoveryOnly: true,
            missingFields: [...REQUIRED_FIELDS],
        };
    }

    const missingFields = getMissingFields(entry);
    return {
        id: entry.id,
        provider: entry.provider,
        discoveryOnly: missingFields.length > 0,
        missingFields,
        maxContext: entry.maxContext,
        toolCapable: entry.toolCapable,
        multimodal: entry.multimodal,
        enabled: entry.enabled,
        inputCostPer1M: entry.inputCostPer1M,
        outputCostPer1M: entry.outputCostPer1M,
    };
}

async function fetchProviderModels(
    provider: ProviderType,
    config: ClawRouteConfig
): Promise<string[]> {
    if (provider === 'codex') {
        return getAllModels()
            .filter((model) => model.provider === 'codex')
            .map((model) => model.id);
    }

    const apiKey = config.apiKeys[provider];
    const response = await fetch(`${getApiBaseUrl(provider)}/models`, {
        method: 'GET',
        headers: {
            ...getAuthHeader(provider, apiKey),
        },
    });

    if (!response.ok) {
        throw new Error(`Provider discovery failed: HTTP ${response.status}`);
    }

    const body = await response.json() as DiscoveryResponse;
    return (body.data ?? [])
        .map((entry) => entry.id)
        .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

export function getCandidateMissingFields(
    model: Partial<ModelEntry>
): RequiredField[] {
    return getMissingFields(model);
}

export async function discoverProviderModels(
    provider: ProviderType,
    config: ClawRouteConfig
): Promise<DiscoveredModelCandidate[]> {
    const ids = await fetchProviderModels(provider, config);
    return ids.map((id) => toCandidate(provider, id));
}