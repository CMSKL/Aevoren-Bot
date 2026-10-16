export const parserName: string;
export const parserVersion: string;
export const parserAssetComponents: { name: string; version: string; license: string; source: string; licensePaths: string[] }[];
export function sha256(bytes: Uint8Array): string;
export function selectedParserLicense(name: string, version: string, declared: string): string;
export function parserAssets(): { source: string; path: string }[];
