// scripts/prepare-dev-electron.mjs の型（単体テストから読むため）
export declare const DEV_APP_NAME: string
export declare const DEV_BUNDLE_ID: string
export declare function devHelperName(helperBundleName: string): string
export declare function devPlistPatches(): Array<{ key: string; value: string }>
export declare function prepareDevElectron(): string | null
