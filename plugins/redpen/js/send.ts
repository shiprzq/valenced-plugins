import { lookupModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { before } from '@valenced/patcher'
import { beginSend, endSend } from './state'
import type { MessageActionsLikeModule, RedpenLogger } from './types'

/**
 * Discord's message-actions module and the several call shapes its `sendMessage` has had
 * across builds.
 *
 * The module is found by property (`sendMessage` + `receiveMessage`), but the signature is
 * *not* known in advance: some builds take `(channelId, message)`, others
 * `(channelId, message, nonce)`, others `(channelId, message, nonce, options)`, and some
 * read the nonce off the message object instead. Guessing one shape is what produced
 * `Cannot read property 'nonce' of undefined`.
 *
 * Redpen therefore:
 *
 * 1. builds a message object that already carries a Discord-style `nonce`, so every shape
 *    has one available somewhere;
 * 2. tries the call shapes in order, from most to least likely for the module's arity;
 * 3. treats a **synchronous** throw as "wrong shape, try the next one" and an
 *    **asynchronous** rejection as "it dispatched and failed" — no retry, because a second
 *    call could post the message twice;
 * 4. remembers the shape that worked and uses it first from then on.
 */

export interface MessageActionsLike {
	sendMessage: (...args: unknown[]) => unknown
}

/** The payload Discord's `sendMessage` expects for a plain text message. */
export interface OutgoingMessage {
	content: string
	tts: boolean
	nonce: string
	invalidEmojis: unknown[]
	validNonShortcutEmojis: unknown[]
}

interface Candidate {
	sendMessage: (...args: unknown[]) => unknown
	module: Record<string, unknown>
	moduleId: number
	arity: number
}

interface Strategy {
	id: string
	label: string
	/** Number of arguments this shape passes. */
	arity: number
	build(channelId: string, message: OutgoingMessage, nonce: string): unknown[]
}

const STRATEGIES: Strategy[] = [
	{
		id: 'nonce+options',
		label: 'sendMessage(channel, message, nonce, options)',
		arity: 4,
		build: (channelId, message, nonce) => [channelId, message, nonce, {}],
	},
	{
		id: 'nonce',
		label: 'sendMessage(channel, message, nonce)',
		arity: 3,
		build: (channelId, message, nonce) => [channelId, message, nonce],
	},
	{
		id: 'options-nonce',
		label: 'sendMessage(channel, message, { nonce })',
		arity: 3,
		build: (channelId, message, nonce) => [channelId, message, { nonce }],
	},
	{
		id: 'message+nonce',
		label: 'sendMessage(channel, { ...message, nonce })',
		arity: 2,
		build: (channelId, message) => [channelId, message],
	},
	{
		id: 'legacy-clearDraft',
		label: 'sendMessage(channel, message, false)',
		arity: 3,
		build: (channelId, message) => [channelId, message, false],
	},
	{
		id: 'single-object',
		label: 'sendMessage({ channelId, ...message })',
		arity: 1,
		build: (channelId, message) => [{ channelId, ...message }],
	},
]

const DEFAULT_STRATEGY = 'nonce'

let candidates: Candidate[] = []
let preferredStrategy: string | undefined
let logger: RedpenLogger | undefined

const SILENT_LOGGER: RedpenLogger = {
	log: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
}

/** Records the plugin logger so send failures are visible in the plugin's error list. */
export function setSendLogger(value: RedpenLogger): void {
	logger = value
}

/**
 * Discord finds messages it just sent by nonce. The value only has to be unique and
 * snowflake-shaped, so it is derived from the clock with a random suffix.
 */
export function createNonce(): string {
	const snowflake = BigInt(Date.now() - 1420070400000) * 4194304n
	const jitter = BigInt(Math.floor(Math.random() * 4194304))
	return (snowflake + jitter).toString()
}

/** Builds the payload once per send so retries reuse the same nonce. */
function buildMessage(content: string, nonce: string): OutgoingMessage {
	return {
		content,
		tts: false,
		nonce,
		invalidEmojis: [],
		validNonShortcutEmojis: [],
	}
}

/**
 * Validates and caches a message-actions module.
 *
 * Any arity is accepted: the strategy ladder covers 1–4 arguments and the rest is decided
 * at call time. A candidate replaces a previous one only when it is more complete.
 */
export function registerMessageActions(
	candidate: unknown,
	moduleId: number,
	log: RedpenLogger,
): boolean {
	logger = log

	if (!candidate || typeof candidate !== 'object') return false

	const module = candidate as Record<string, unknown>
	const sendMessage = module.sendMessage
	if (typeof sendMessage !== 'function') return false

	if (candidates.some(existing => existing.module === module)) return true

	candidates = [
		...candidates,
		{
			sendMessage: sendMessage as (...args: unknown[]) => unknown,
			module,
			moduleId,
			arity: (sendMessage as (...args: unknown[]) => unknown).length,
		},
	].sort((a, b) => strategyScore(b) - strategyScore(a))

	log.log(
		`[send] candidate module ${moduleId} (sendMessage/${candidates[0].arity} args, ` +
			`${typeof sendMessage})`,
	)

	return true
}

/**
 * Prefers modules that look like the full action module: the send action lives next to
 * `receiveMessage`, `deleteMessage` and friends, so more known properties = better odds.
 */
function strategyScore(candidate: Candidate): number {
	const keys = ['receiveMessage', 'deleteMessage', 'editMessage', 'fetchMessages', 'sendBotMessage']
	let score = 0
	for (const key of keys) {
		if (typeof candidate.module[key] === 'function') score += 1
	}
	// A recognisable arity beats an opaque rest-parameter function (arity 0).
	if (candidate.arity >= 2 && candidate.arity <= 4) score += 2
	return score
}

/** Last-chance lookup when the module initialised after `start`. */
function resolveOnDemand(): Candidate | undefined {
	if (candidates.length > 0) return candidates[0]

	try {
		for (const [candidate, moduleId] of lookupModules(
			withProps<MessageActionsLikeModule>('sendMessage'),
		)) {
			if (registerMessageActions(candidate, moduleId, logger ?? SILENT_LOGGER)) break
		}
	} catch {
		// A failing scan must not break the send path; the caller reports the error.
	}

	return candidates[0]
}

/** Shapes ordered for the module's arity, with the last known-good one first. */
function orderedStrategies(candidate: Candidate): Strategy[] {
	const ordered = [...STRATEGIES].sort((a, b) => {
		if (preferredStrategy) {
			if (a.id === preferredStrategy) return -1
			if (b.id === preferredStrategy) return 1
		}
		const distanceA = Math.abs(a.arity - candidate.arity)
		const distanceB = Math.abs(b.arity - candidate.arity)
		if (distanceA !== distanceB) return distanceA - distanceB
		// Same arity: the nonce-carrying shape is the safer default.
		return a.id === DEFAULT_STRATEGY ? -1 : b.id === DEFAULT_STRATEGY ? 1 : 0
	})
	return ordered
}

/** Describes the resolved send path for settings/diagnostics. */
export function describeSendAction(): string {
	if (candidates.length === 0) return 'not found'
	const [candidate] = candidates
	const strategy = preferredStrategy ?? DEFAULT_STRATEGY
	const label = STRATEGIES.find(entry => entry.id === strategy)?.label ?? strategy
	return `module ${candidate.moduleId}, sendMessage/${candidate.arity} → ${label}`
}

export function hasSendAction(): boolean {
	return candidates.length > 0
}

/** True when the message went out on a shape other than the default one. */
export function describeSendFallback(): string {
	return preferredStrategy ?? 'default'
}

/** Drops every cached candidate; called from `stop`. */
export function resetSendState(): void {
	candidates = []
	preferredStrategy = undefined
}

class SendError extends Error {}

/**
 * Sends `content` to `channelId`.
 *
 * Throws an `Error` with a user-facing message when no shape works, so the sheet can show
 * it and offer Retry. The user's own draft is never touched.
 */
export async function sendToChannel(channelId: string, content: string): Promise<void> {
	const trimmed = content.trim()
	if (trimmed.length === 0) throw new SendError('Nothing to send.')

	const candidate = resolveOnDemand()
	if (!candidate) {
		throw new SendError(
			'Redpen could not find the send-message action in this Discord build. ' +
				'The message was not sent.',
		)
	}

	if (!beginSend(channelId)) {
		throw new SendError('A message is already being sent for this channel.')
	}

	const nonce = createNonce()
	const message = buildMessage(trimmed, nonce)
	const failures: string[] = []

	try {
		for (const strategy of orderedStrategies(candidate)) {
			let pending: unknown

			try {
				pending = candidate.sendMessage(...strategy.build(channelId, message, nonce))
			} catch (error) {
				// Synchronous: the call never dispatched, so another shape is safe to try.
				failures.push(`${strategy.id}: ${describeError(error)}`)
				continue
			}

			try {
				if (pending && typeof (pending as PromiseLike<unknown>).then === 'function') {
					await (pending as PromiseLike<unknown>)
				}
			} catch (error) {
				// Asynchronous: something was dispatched. Never retry — it may already be posted.
				const detail = describeError(error)
				logger?.error(`[send] ${strategy.id} rejected for ${channelId}: ${detail}`)
				throw new SendError(`Send failed: ${detail}`)
			}

			preferredStrategy = strategy.id
			logger?.log(`[send] sent to ${channelId} via ${strategy.label}`)
			return
		}

		const detail = failures.join(' | ')
		logger?.error(`[send] every shape failed for ${channelId}: ${detail}`)
		throw new SendError(
			`Send failed: none of the ${STRATEGIES.length} known send shapes worked ` +
				`(${detail}). The message was not sent.`,
		)
	} finally {
		endSend(channelId)
	}
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

/**
 * Rewrites outgoing message content before Discord sends it.
 *
 * Wired to `api.cleanup`, so turning the setting off (or stopping the plugin) restores the
 * original function. Only string `content` on the message argument is touched: attachments,
 * replies and non-text sends are left exactly as Discord built them.
 *
 * @param candidate The module namespace that owns `sendMessage`.
 * @param fix Called with the outgoing text; returns the corrected text.
 * @returns Unpatch function.
 */
export function installOutgoingCorrection(
	candidate: Record<string, unknown>,
	fix: (content: string) => string,
	isEnabled: () => boolean,
): () => void {
	const sendMessage = candidate.sendMessage
	if (typeof sendMessage !== 'function') return () => {}

	return before(candidate as Record<'sendMessage', (...args: unknown[]) => unknown>, 'sendMessage', args => {
		if (!isEnabled()) return args

		try {
			for (const arg of args) {
				if (!arg || typeof arg !== 'object') continue
				const message = arg as { content?: unknown }
				if (typeof message.content !== 'string' || message.content.length === 0) continue

				const corrected = fix(message.content)
				if (corrected !== message.content) message.content = corrected
			}
		} catch {
			// Never block a send because a correction failed.
		}

		return args
	})
}

/** The module namespace of the best candidate, for patching. */
export function getMessageActionsModule(): Record<string, unknown> | undefined {
	return resolveOnDemand()?.module
}
