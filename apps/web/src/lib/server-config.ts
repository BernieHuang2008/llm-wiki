// Server-only helpers that wrap @llm-wiki/core's config + secrets. Keep API
// routes thin; this file owns the policy around redaction and error shape.

import {
  deleteApiKey as coreDelete,
  getApiKey as coreGet,
  isKeyProvider,
  isKeychainAvailable,
  KEY_PROVIDERS,
  loadGlobalConfig,
  setApiKey as coreSet,
  type ApiKeyResult,
  type GlobalConfig,
  type KeyProvider,
} from "@llm-wiki/core";

export type ApiKeyStatus = {
  provider: KeyProvider;
  configured: boolean;
  source: ApiKeyResult["source"];
  keychainAvailable: boolean;
  /** Last 4 chars only, for "key ending in …abcd" UI text. Never the full key. */
  hint: string | null;
};

/** All providers' status at once, so the API tab renders without N requests. */
export type ApiKeyStatusMap = Record<KeyProvider, ApiKeyStatus>;

function keyHint(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 4) return key;
  return key.slice(-4);
}

async function statusFor(provider: KeyProvider): Promise<ApiKeyStatus> {
  const r = await coreGet(provider);
  return {
    provider,
    configured: r.key !== null,
    source: r.source,
    keychainAvailable: r.keychainAvailable,
    hint: keyHint(r.key),
  };
}

export async function getApiKeyStatus(
  provider: KeyProvider = "openrouter",
): Promise<ApiKeyStatus> {
  return statusFor(provider);
}

export async function getApiKeyStatuses(): Promise<ApiKeyStatusMap> {
  const entries = await Promise.all(KEY_PROVIDERS.map((p) => statusFor(p)));
  const out = {} as ApiKeyStatusMap;
  for (const entry of entries) out[entry.provider] = entry;
  return out;
}

export async function setApiKey(
  key: string,
  provider: KeyProvider = "openrouter",
): Promise<ApiKeyStatus> {
  await coreSet(key.trim(), provider);
  return statusFor(provider);
}

export async function deleteApiKey(
  provider: KeyProvider = "openrouter",
): Promise<ApiKeyStatus> {
  await coreDelete(provider);
  return statusFor(provider);
}

export async function loadConfig(): Promise<GlobalConfig> {
  return loadGlobalConfig();
}

/** Narrow an untrusted request value to a key-bearing provider id. */
export function asKeyProvider(value: unknown): KeyProvider {
  if (isKeyProvider(value)) return value;
  throw new Error(`未知的 API key 提供方：${String(value)}`);
}

export { isKeychainAvailable };
