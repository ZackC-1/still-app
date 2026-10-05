export declare const ALLOWED_ENV: readonly string[];
export declare function jwtPayload(token: string): Record<string, unknown> | null;
export declare function refuseKey(key: unknown, url?: string): string | null;
export declare function isPlaceholderHost(url: string): boolean;
export declare function projectOrigin(url: string): string | null;
export declare function resolvePublicConfig(env: Record<string, string | undefined>): {
  url: string;
  anonKey: string;
  origin: string | null;
};
