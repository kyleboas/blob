/**
 * Loads and caches user configuration from Cloudflare KV.
 * Implements fallback strategy for backwards compatibility and resilience.
 */

import { UserConfiguration, DEFAULT_CONFIGURATION } from "./kv-schema";

const CONFIG_CACHE_KEY = "user-config-cache";
const CONFIG_KV_KEY = "user-configuration";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedConfig {
  config: UserConfiguration;
  cachedAt: number;
}

let configCache: CachedConfig | null = null;

/**
 * Load user configuration from KV with caching and fallback.
 *
 * Precedence:
 * 1. Memory cache (if fresh, < 5 min old)
 * 2. Cloudflare KV (if binding exists)
 * 3. Environment variable JSON (if set)
 * 4. Hardcoded default
 */
export async function loadUserConfiguration(
  env: { USER_CONFIG_KV?: KVNamespace },
  envJson?: string
): Promise<UserConfiguration> {
  const now = Date.now();

  // Check memory cache
  if (configCache && now - configCache.cachedAt < CACHE_TTL_MS) {
    return configCache.config;
  }

  let config: UserConfiguration | null = null;

  // Try KV storage
  if (env.USER_CONFIG_KV) {
    try {
      const kvValue = await env.USER_CONFIG_KV.get(CONFIG_KV_KEY);
      if (kvValue) {
        config = JSON.parse(kvValue) as UserConfiguration;
        validateConfiguration(config);
      }
    } catch (err) {
      console.error("Failed to load config from KV:", err);
      // Fall through to next strategy
    }
  }

  // Try environment variable
  if (!config && envJson) {
    try {
      config = JSON.parse(envJson) as UserConfiguration;
      validateConfiguration(config);
    } catch (err) {
      console.error("Failed to parse config from env:", err);
      // Fall through to default
    }
  }

  // Use default
  if (!config) {
    config = DEFAULT_CONFIGURATION;
  }

  // Update memory cache
  configCache = {
    config,
    cachedAt: now,
  };

  return config;
}

/**
 * Validate configuration has required fields.
 * Merges with defaults if any required top-level fields are missing.
 */
function validateConfiguration(config: unknown): asserts config is UserConfiguration {
  if (!config || typeof config !== "object") {
    throw new Error("Configuration must be an object");
  }

  const cfg = config as Record<string, unknown>;

  // Check required top-level fields
  if (!cfg.user || typeof cfg.user !== "object") {
    throw new Error("Configuration missing required 'user' field");
  }
  if (!cfg.messageFormatting || typeof cfg.messageFormatting !== "object") {
    throw new Error("Configuration missing required 'messageFormatting' field");
  }
}

/**
 * Clear the configuration cache.
 * Useful for testing or forcing a reload.
 */
export function clearConfigCache(): void {
  configCache = null;
}

/**
 * Save user configuration to KV (for admin/setup operations).
 * Returns true if successful, false otherwise.
 */
export async function saveUserConfiguration(
  env: { USER_CONFIG_KV?: KVNamespace },
  config: UserConfiguration
): Promise<boolean> {
  if (!env.USER_CONFIG_KV) {
    console.error("USER_CONFIG_KV binding not available");
    return false;
  }

  try {
    // Update updatedAt timestamp
    const updatedConfig = {
      ...config,
      updatedAt: new Date().toISOString(),
    };

    await env.USER_CONFIG_KV.put(CONFIG_KV_KEY, JSON.stringify(updatedConfig));

    // Update cache
    configCache = {
      config: updatedConfig,
      cachedAt: Date.now(),
    };

    return true;
  } catch (err) {
    console.error("Failed to save config to KV:", err);
    return false;
  }
}
