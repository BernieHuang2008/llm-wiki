import { loadGlobalConfig, saveGlobalConfig, globalConfigPath } from "./config";

// OS keychain identifiers. The "service" namespace lets keytar coexist with
// other apps that use the system keychain.
const SERVICE = "llm-wiki";

/**
 * Providers that need a user-supplied key. Ollama runs locally and takes a
 * placeholder, so it is deliberately absent.
 */
export type KeyProvider = "openrouter" | "deepseek";

export const KEY_PROVIDERS: readonly KeyProvider[] = ["openrouter", "deepseek"] as const;

/** Keychain account name per provider. */
function accountFor(provider: KeyProvider): string {
  return provider;
}

/** Config-file field per provider (the keychain-unavailable fallback). */
function configFieldFor(provider: KeyProvider): "openrouterKey" | "deepseekKey" {
  return provider === "deepseek" ? "deepseekKey" : "openrouterKey";
}

export function isKeyProvider(value: unknown): value is KeyProvider {
  return value === "openrouter" || value === "deepseek";
}

export type ApiKeySource = "keychain" | "config" | "none";

export type ApiKeyResult = {
  key: string | null;
  source: ApiKeySource;
  /** True when keytar is unusable on this host. Surface in the UI as a warning. */
  keychainAvailable: boolean;
};

// Lazy-import keytar so a load failure (e.g. Linux without libsecret)
// degrades cleanly to file storage instead of crashing the whole app.
type KeytarModule = typeof import("keytar");
let keytarPromise: Promise<KeytarModule | null> | null = null;

async function loadKeytar(): Promise<KeytarModule | null> {
  if (keytarPromise) return keytarPromise;
  keytarPromise = (async () => {
    try {
      const mod = await import("keytar");
      // Round-trip a probe call: native modules can import but throw on use
      // when the OS service isn't running. Findings:
      //   - macOS Keychain: always available
      //   - Windows Credential Manager: always available
      //   - Linux: requires gnome-keyring or KWallet via libsecret
      await mod.findCredentials(SERVICE);
      return mod;
    } catch {
      return null;
    }
  })();
  return keytarPromise;
}

export async function isKeychainAvailable(): Promise<boolean> {
  return (await loadKeytar()) !== null;
}

export async function getApiKey(provider: KeyProvider = "openrouter"): Promise<ApiKeyResult> {
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      const key = await keytar.getPassword(SERVICE, accountFor(provider));
      if (key) return { key, source: "keychain", keychainAvailable: true };
    } catch {
      // fall through to config-file lookup
    }
  }
  const cfg = await loadGlobalConfig();
  const fromFile = cfg[configFieldFor(provider)];
  if (fromFile) {
    return { key: fromFile, source: "config", keychainAvailable: keytar !== null };
  }
  return { key: null, source: "none", keychainAvailable: keytar !== null };
}

export async function setApiKey(
  key: string,
  provider: KeyProvider = "openrouter",
): Promise<ApiKeyResult> {
  if (!key.trim()) throw new Error("setApiKey: key must be non-empty");
  const field = configFieldFor(provider);
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      await keytar.setPassword(SERVICE, accountFor(provider), key);
      // Successful keychain write — purge any stale copy from config.json so
      // the key never lives in two places.
      const cfg = await loadGlobalConfig();
      if (cfg[field]) {
        const next = { ...cfg };
        delete next[field];
        await saveGlobalConfig({ ...next, version: 1 });
      }
      return { key, source: "keychain", keychainAvailable: true };
    } catch {
      // fall through to config-file storage
    }
  }
  const cfg = await loadGlobalConfig();
  await saveGlobalConfig({ ...cfg, [field]: key });
  return { key, source: "config", keychainAvailable: keytar !== null };
}

export async function deleteApiKey(provider: KeyProvider = "openrouter"): Promise<void> {
  const field = configFieldFor(provider);
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      await keytar.deletePassword(SERVICE, accountFor(provider));
    } catch {
      // ignore — the key may not have been set via keychain
    }
  }
  const cfg = await loadGlobalConfig();
  if (cfg[field]) {
    const next = { ...cfg };
    delete next[field];
    await saveGlobalConfig({ ...next, version: 1 });
  }
}

/**
 * For tests: reset the cached keytar promise so a fresh probe runs. Production
 * code never needs this.
 */
export function _resetKeytarCacheForTests(): void {
  keytarPromise = null;
}

export function fileFallbackPath(): string {
  return globalConfigPath();
}
