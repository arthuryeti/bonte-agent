/**
 * Platform adapter registry — inspired by Hermes Agent's platform_registry.py.
 *
 * Maps platform names to adapter factories so the Gateway can instantiate
 * adapters without hard-coded switch statements.
 */

import type { BasePlatformAdapter } from "./platforms/base.js";
import type { Platform } from "./types.js";

export type AdapterFactory = (config: Record<string, unknown>) => BasePlatformAdapter;

export interface RegistryEntry {
  name: Platform;
  label: string;
  factory: AdapterFactory;
  requiredEnv: string[];
}

export class PlatformRegistry {
  private entries = new Map<Platform, RegistryEntry>();

  register(entry: RegistryEntry): void {
    this.entries.set(entry.name, entry);
  }

  get(name: Platform): RegistryEntry | undefined {
    return this.entries.get(name);
  }

  all(): RegistryEntry[] {
    return Array.from(this.entries.values());
  }
}

export const platformRegistry = new PlatformRegistry();
