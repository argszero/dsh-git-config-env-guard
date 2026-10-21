/** The shape Git's command-line-configuration channel is in. */
export type ChannelShape = 'absent' | 'inert' | 'intact' | 'orphaned' | 'malformed'

/** The result of judging one resolved child environment. */
export interface ChannelVerdict {
  shape: ChannelShape
  count: number | null
  missing: readonly string[]
  trailing: readonly string[]
  reason?: string
}

/** Whether a name belongs to Git's command-line-configuration channel. */
export declare function isFamilyName(name: string): boolean

/** The channel members present in an environment, sorted. */
export declare function familyNames(env: Record<string, string | undefined> | undefined | null): string[]

/** Judge the channel inside one already-resolved environment. */
export declare function classify(env: Record<string, string | undefined>): ChannelVerdict

/** Tombstones that remove the whole channel; `GIT_CONFIG_PARAMETERS` is left alone. */
export declare function tombstones(env: Record<string, string | undefined>): Record<string, undefined>

/** Largest counter this plugin will walk. */
export declare const MAX_COUNT: number

/** One channel member name. */
export declare const FAMILY_NAME: RegExp
