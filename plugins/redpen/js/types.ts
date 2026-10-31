import type { PluginApi } from '@valenced/plugins/types'
import { CORRECTOR_VERSION, type CorrectionChange } from './corrector'

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export interface RedpenSettings {
	/** Show the preview/approve step before sending. Default `true`. */
	previewMode: boolean
	/** Render the per-channel button in the channel list. Default `true`. */
	showSidebarButton: boolean
	/** Render the Redpen button in the message dock. Default `true`. */
	showDockButton: boolean
	/** Correct outgoing messages in place, before Discord sends them. Default `true`. */
	autoCorrectOutgoing: boolean
	/** Rule groups the user turned off in settings. Empty means every rule runs. */
	disabledRules: string[]
	/** Read-only, mirrored from `corrector.ts`. */
	correctorVersion: string
	/**
	 * Reserved for a future user dictionary. Written by the “Reset corrections”
	 * action; consumed by `correct(input, { dictionary })`.
	 */
	userDictionary?: Record<string, string>
	/**
	 * Set to `injecting` while the UI hooks are live and cleared once the app is running
	 * normally. A marker left behind means the last session ended while injection was
	 * active — a crash — so the next boot stays safe.
	 */
	bootMarker?: string
	/** Set after a boot that did not survive injection; injection stays off until cleared. */
	injectionSuspended?: boolean
	/** Bumped when a release changes injection defaults; drives the one-time migration. */
	safetyVersion?: string
}

/** Shape of `storage.json`: everything lives under a single top-level `settings` key. */
export interface RedpenStorage {
	settings: RedpenSettings
}

export const DEFAULT_SETTINGS: RedpenSettings = {
	previewMode: true,
	showSidebarButton: true,
	showDockButton: true,
	autoCorrectOutgoing: true,
	disabledRules: [],
	correctorVersion: CORRECTOR_VERSION,
	userDictionary: {},
	bootMarker: '',
	injectionSuspended: false,
	safetyVersion: '',
}

export const DEFAULT_STORAGE: RedpenStorage = { settings: DEFAULT_SETTINGS }

/** Scoped API type used across the plugin. */
export type RedpenApi = PluginApi<{ jsonStorage: RedpenStorage }>

/** Structural subset of `api.logger` used by Redpen's helpers. */
export interface RedpenLogger {
	log(...args: unknown[]): void
	info(...args: unknown[]): void
	warn(...args: unknown[]): void
	error(...args: unknown[]): void
}

export type { CorrectionChange }

/* -------------------------------------------------------------------------- */
/* Channels                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Channel type constants used by Discord. Declared here because Valenced does not
 * re-export Discord's own `ChannelTypes` map.
 */
export const ChannelTypes = {
	GUILD_TEXT: 0,
	DM: 1,
	GUILD_VOICE: 2,
	GROUP_DM: 3,
	GUILD_CATEGORY: 4,
	GUILD_ANNOUNCEMENT: 5,
	ANNOUNCEMENT_THREAD: 10,
	PUBLIC_THREAD: 11,
	PRIVATE_THREAD: 12,
	GUILD_STAGE_VOICE: 13,
	GUILD_DIRECTORY: 14,
	GUILD_FORUM: 15,
	GUILD_MEDIA: 16,
} as const

/**
 * Text-capable channel types Redpen accepts.
 *
 * GUILD_TEXT, GUILD_ANNOUNCEMENT, DM, GROUP_DM, and the three thread types.
 * Voice, stage voice, category headers, directories, forums and media channels are
 * rejected — a Redpen button on those rows would have nowhere to send.
 */
const TEXT_CHANNEL_TYPES: ReadonlySet<number> = new Set<number>([
	ChannelTypes.GUILD_TEXT,
	ChannelTypes.GUILD_ANNOUNCEMENT,
	ChannelTypes.DM,
	ChannelTypes.GROUP_DM,
	ChannelTypes.ANNOUNCEMENT_THREAD,
	ChannelTypes.PUBLIC_THREAD,
	ChannelTypes.PRIVATE_THREAD,
])

export interface ChannelLike {
	id: string
	name?: string | null
	type?: number
	guild_id?: string | null
	parent_id?: string | null
}

/**
 * Single source of truth for “can Redpen target this channel”.
 *
 * Explicitly filters out voice channels (`GUILD_VOICE`, `GUILD_STAGE_VOICE`), category
 * headers (`GUILD_CATEGORY`), the guild rail entries and anything without a known type.
 */
export function isTextChannel(channel: unknown): channel is ChannelLike {
	if (!channel || typeof channel !== 'object') return false

	const candidate = channel as ChannelLike
	if (typeof candidate.id !== 'string' || candidate.id.length === 0) return false
	if (typeof candidate.type !== 'number') return false

	return TEXT_CHANNEL_TYPES.has(candidate.type)
}

/** Display name for a channel, without touching Discord's stores. */
export function channelLabel(channel: ChannelLike): string {
	const name = typeof channel.name === 'string' ? channel.name.trim() : ''
	if (name) return name
	if (channel.type === ChannelTypes.DM) return 'Direct message'
	if (channel.type === ChannelTypes.GROUP_DM) return 'Group'
	return 'Channel'
}

/* -------------------------------------------------------------------------- */
/* Sidebar row props                                                          */
/* -------------------------------------------------------------------------- */

/** Props seen on the channel list row components (see `sidebar.ts`). */
export interface ChannelRowProps {
	channel?: unknown
	threadId?: string
	threadIndex?: number
	threadCount?: number
	selected?: boolean
	muted?: boolean
	isSuggestedSection?: boolean
}

/** Discord's message-actions module, matched by property filter. */
export interface MessageActionsLikeModule {
	sendMessage: (...args: unknown[]) => unknown
	receiveMessage: unknown
}

/** Action sheet keys used by Redpen's two surfaces. */
export const INPUT_SHEET_KEY = 'REDPEN_INPUT_SHEET'
export const PREVIEW_SHEET_KEY = 'REDPEN_PREVIEW_SHEET'

/** Module that renders one row of the channel list. */
export interface ChannelListModule {
	renderChannelListItem(...args: unknown[]): unknown
}
