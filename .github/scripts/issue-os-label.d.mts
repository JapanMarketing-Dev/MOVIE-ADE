export declare const OS_LABELS: Readonly<{ macos: 'os:macos'; windows: 'os:windows'; linux: 'os:linux' }>
export declare function osLabelFor(body: string | null | undefined): 'os:macos' | 'os:windows' | 'os:linux' | null
export declare function applyOsLabel(args: { github: unknown; context: unknown; core: unknown }): Promise<void>
