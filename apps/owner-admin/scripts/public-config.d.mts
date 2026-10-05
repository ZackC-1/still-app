export declare const ALLOWED_ENV: readonly string[];
export declare function jwtPayload(token: string): Record<string, unknown> | null;
export declare function refuseKey(key: unknown): string | null;
export declare function projectOrigin(url: string): string | null;
export declare function resolvePublicConfig(env: Record<string, string | undefined>): {
  url: string;
  anonKey: string;
  origin: string | null;
};
