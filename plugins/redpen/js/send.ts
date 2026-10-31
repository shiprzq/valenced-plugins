import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { beginSend, endSend } from './state'
import type { MessageActionsLikeModule, RedpenLogger } from './types'

/**
 * Discord's message actions.
 *
 * The exported `sendMessage` is called as
 * `sendMessage(channelId, message, clearDraft, options?)` on current builds. The exact
 * arity is checked before every call — Redpen never calls a guessed signature.
 */
export interface MessageActionsLike {
	sendMessage: (...args: unknown[]) => unknown
}

export interface OutgoingMessage {
	content: string
	ttl: number
	invalidEmojis: unknown[]
	validNonShortcutEmojis: unknown[]
}

interface ResolvedAction {
	sendMessage: (...args: unknown[]) => unknown
	moduleId: number
	arity: number
}

let action: ResolvedAction | undefined
let logger: RedpenLogger | undefined

/** Arity values Redpen knows how to call. */
const SUPPORTED_ARITIES = new Set([2, 3, 4])

/** Records the plugin logger so send failures are visible in the plugin's error list. */
export function setSendLogger(value: RedpenLogger): void {
	logger = value
}

/**
 * Validates and caches the message action module.
 *
 * @returns `true` when the module is usable.
 */
export function registerMessageActions(
	candidate: unknown,
	moduleId: number,
	log: RedpenLogger,
): boolean {
	if (!candidate || typeof candidate !== 'object') {
		log.warn(`[send] module ${moduleId} with sendMessage is not an object; ignoring`)
		return false
	}

	const sendMessage = (candidate as Partial<MessageActionsLike>).sendMessage
	if (typeof sendMessage !== 'function') {
		log.warn(`[send] module ${moduleId} has no callable sendMessage; ignoring`)
		return false
	}

	const arity = sendMessage.length
	const signature = `sendMessage/${arity} args`

	if (!SUPPORTED_ARITIES.has(arity)) {
		log.error(
			`[send] unsupported sendMessage signature (${signature}, module ${moduleId}). ` +
				'Redpen will not send until the signature is recognised.',
		)
		return false
	}

	action = { sendMessage: sendMessage as (...args: unknown[]) => unknown, moduleId, arity }
	logger = log
	log.log(`[send] resolved message actions at module ${moduleId} (${signature})`)
	return true
}

/** Describes the resolved action for settings/debug output. */
export function describeSendAction(): string {
	if (!action) return 'not found'
	return `module ${action.moduleId}, arity ${action.arity}`
}

export function hasSendAction(): boolean {
	return action !== undefined
}

/**
 * Last-chance lookup when the module initialized after `start`.
 * Uses the same property filter as the subscription in `index.ts`.
 */
function resolveOnDemand(): ResolvedAction | undefined {
	if (action) return action

	const [candidate, moduleId] = lookupModule(
		withProps<MessageActionsLikeModule>('sendMessage', 'receiveMessage'),
	)
	if (moduleId === undefined) return undefined

	if (registerMessageActions(candidate, moduleId, logger ?? SILENT_LOGGER)) return action
	return undefined
}

const SILENT_LOGGER: RedpenLogger = {
	log: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
}

/**
 * Sends `content` to `channelId`.
 *
 * Throws an `Error` with a user-facing message when the send cannot be performed, so
 * the sheet can show it and offer Retry. The draft is never cleared implicitly.
 */
export async function sendToChannel(channelId: string, content: string): Promise<void> {
	const resolved = resolveOnDemand()
	if (!resolved) {
		throw new Error('Redpen could not find the send-message action in this Discord build.')
	}

	if (!SUPPORTED_ARITIES.has(resolved.arity)) {
		throw new Error(`Unsupported send-message signature (arity ${resolved.arity}).`)
	}

	if (!beginSend(channelId)) {
		throw new Error('A message is already being sent for this channel.')
	}

	const message: OutgoingMessage = {
		content,
		ttl: 0,
		invalidEmojis: [],
		validNonShortcutEmojis: [],
	}

	try {
		// `clearDraft` is `false`: Redpen's text never lived in the composer, so the
		// user's own draft must survive.
		let result: unknown
		switch (resolved.arity) {
			case 2:
				result = resolved.sendMessage(channelId, message)
				break
			case 3:
				result = resolved.sendMessage(channelId, message, false)
				break
			default:
				result = resolved.sendMessage(channelId, message, false, {})
				break
		}

		if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
			await (result as PromiseLike<unknown>)
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		logger?.error(`[send] sendMessage failed for ${channelId}: ${detail}`)
		throw new Error(`Send failed: ${detail}`)
	} finally {
		endSend(channelId)
	}
}
