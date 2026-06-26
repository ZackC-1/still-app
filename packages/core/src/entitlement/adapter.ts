import type { EntitlementAdapter } from "./cache.js";

export class InMemoryEntitlementAdapter implements EntitlementAdapter {
  private value: boolean | null;
  private readonly listeners = new Set<(entitled: boolean) => void>();

  constructor(initial: boolean | null = null) {
    this.value = initial;
  }

  async get(): Promise<boolean | null> {
    return this.value;
  }

  async set(entitled: boolean): Promise<void> {
    this.value = entitled;
    this.emit(entitled);
  }

  subscribe(listener: (entitled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitExternal(entitled: boolean): void {
    this.value = entitled;
    this.emit(entitled);
  }

  private emit(entitled: boolean): void {
    for (const listener of [...this.listeners]) listener(entitled);
  }
}

