import { Stores } from '@valenced/discord/flux'
import { ReactJSXRuntime } from '@valenced/react'
import { before } from '@valenced/patcher'
import { cloneElement, createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Text, TextInput, View } from 'react-native'
import DockButton from './ui/DockButton'
import Guard from './ui/Guard'
import SidebarButton from './ui/SidebarButton'
import { channelLabel, isTextChannel, type ChannelLike, type RedpenLogger } from './types'

/**
 * UI injection without guessing component names.
 *
 * This build minifies component names — `type.name` is not preserved, which is why
 * name-based discovery (`ChatInputButtons`, `renderChannelListItem`, …) found nothing and
 * the button never appeared. Valenced's own built-in plugins match *structurally* for the
 * same reason.
 *
 * So Redpen hooks the JSX runtime itself and inspects what Discord is about to render:
 *
 * - **Message dock**: the composer row is the element whose children include the text
 *   input carrying the `Message #channel` placeholder. The `Aa` button is appended to that
 *   row's children.
 * - **Channel rows**: any element whose children include a row element holding a
 *   text-capable `channel` prop is wrapped in a horizontal container with the Redpen
 *   button next to it.
 *
 * Both are pure `props.children` edits on freshly created elements: nothing is patched in
 * place, nothing is replaced, and the work is skipped entirely when the matching setting
 * is off. The hook is removed on `stop`.
 */

export interface InjectionOptions {
	logger: RedpenLogger
	isDockEnabled(): boolean
	isRowButtonEnabled(): boolean
	onError(error: unknown): void
}

export interface InjectionHandle {
	dispose(): void
}

/* -------------------------------------------------------------------------- */
/* State (read by the settings screen)                                        */
/* -------------------------------------------------------------------------- */

interface InjectionStats {
	installed: boolean
	reason: string
	elementsSeen: number
	dockInjected: number
	rowsInjected: number
	composerSample: string
	rowSample: string
}

const stats: InjectionStats = {
	installed: false,
	reason: 'not started',
	elementsSeen: 0,
	dockInjected: 0,
	rowsInjected: 0,
	composerSample: '',
	rowSample: '',
}

/** One-line state for Settings → Diagnostics. */
export function describeInjection(): string {
	if (!stats.installed) return stats.reason
	const dock = stats.dockInjected > 0 ? 'dock ✓' : 'dock …'
	const rows = stats.rowsInjected > 0 ? 'rows ✓' : 'rows …'
	return `${dock}, ${rows}`
}

/** What the hook saw, so a screenshot is enough to tune the selectors. */
export function describeInjectionSamples(): string {
	const parts: string[] = []
	if (stats.composerSample) parts.push(`composer: ${stats.composerSample}`)
	if (stats.rowSample) parts.push(`row: ${stats.rowSample}`)
	if (parts.length === 0) return `${stats.elementsSeen} elements scanned`
	return parts.join(' · ')
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const DOCK_MARKER = 'redpen-dock'
/** Props that identify the message composer's text field. */
const COMPOSER_PLACEHOLDER = /^(?:message|nachricht|mensaje|messaggio|message…)\b/i

interface SelectedChannelStoreLike {
	getChannelId?(): string | null
	getLastSelectedChannelId?(): string | null
}

interface ChannelStoreLike {
	getChannel?(channelId: string): unknown
}

function readStore<T>(name: string): T | undefined {
	try {
		return ((Stores as Record<string, unknown>)[name] ?? undefined) as T | undefined
	} catch {
		return undefined
	}
}

function currentChannelId(): string | undefined {
	const selected = readStore<SelectedChannelStoreLike>('SelectedChannelStore')
	const id = selected?.getChannelId?.() ?? selected?.getLastSelectedChannelId?.() ?? undefined
	return typeof id === 'string' && id.length > 0 ? id : undefined
}

function resolveChannel(channelId: string): ChannelLike {
	const store = readStore<ChannelStoreLike>('ChannelStore')
	const channel = store?.getChannel?.(channelId)
	return isTextChannel(channel) ? channel : { id: channelId }
}

function toArray(children: ReactNode): ReactNode[] | undefined {
	if (children === undefined || children === null) return undefined
	return Array.isArray(children) ? children : [children]
}

function propsOf(element: ReactNode): Record<string, unknown> | undefined {
	if (!isValidElement(element)) return undefined
	const props = (element as ReactElement<Record<string, unknown>>).props
	return props && typeof props === 'object' ? props : undefined
}

/** The channel-qualified text input inside the composer row. */
function isComposerInput(element: ReactNode): boolean {
	const props = propsOf(element)
	if (!props) return false
	if (typeof props.placeholder === 'string' && COMPOSER_PLACEHOLDER.test(props.placeholder)) {
		return true
	}
	// Fallback signal: a controlled text field inside the composer.
	return (
		typeof props.onChangeText === 'function' &&
		(props.textValue !== undefined || props.value !== undefined) &&
		typeof props.channel === 'object' &&
		props.channel !== null
	)
}

/** A channel-list row: an element owning a text-capable `channel` prop. */
function rowChannel(element: ReactNode): ChannelLike | undefined {
	const props = propsOf(element)
	if (!props) return undefined
	if (typeof element === 'object' && element !== null && typeof (element as ReactElement).type === 'string') {
		return undefined
	}

	const channel = props.channel
	if (!isTextChannel(channel)) return undefined

	const looksLikeRow =
		'isSuggestedSection' in props ||
		'selected' in props ||
		'muted' in props ||
		'threadId' in props ||
		'hasUnread' in props ||
		typeof props.onPress === 'function' ||
		typeof props.onLongPress === 'function'

	return looksLikeRow ? channel : undefined
}

/**
 * Text subtrees are off limits. A `View` inside a `Text` is a fatal render error on Android,
 * and channel mentions — which carry a `channel` prop and a press handler — are exactly the
 * shape that would otherwise be mistaken for a sidebar row.
 */
function isTextLike(type: unknown): boolean {
	if (type === Text || type === TextInput) return true
	// Host components are strings in React Native; keep text hosts out of the scan too.
	return typeof type === 'string' && /text|label|paragraph/i.test(type)
}

function describeKeys(props: Record<string, unknown>): string {
	return Object.keys(props).slice(0, 8).join(',')
}

/* -------------------------------------------------------------------------- */
/* Injection                                                                  */
/* -------------------------------------------------------------------------- */

interface ChildrenEdit {
	children: ReactNode[]
	changed: boolean
}

function isDockElement(child: ReactNode): boolean {
	return isValidElement(child) && (child as { key?: string | null }).key === DOCK_MARKER
}

/** True when a channel row already carries our button, so a reused element is not doubled. */
function hasRowButton(row: ReactNode): boolean {
	const props = propsOf(row)
	if (!props) return false
	const children = toArray(props.children as ReactNode) ?? []
	return children.some(
		child =>
			isValidElement(child) &&
			(child as { key?: string | null }).key === 'redpen-row-button',
	)
}

/** Keeps the composer input from being covered by the button next to it. */
const COMPOSER_INPUT_STYLE = { width: undefined, flexGrow: 1, flexShrink: 1, minWidth: 0 }

/**
 * Appends what Redpen needs to one children array. Runs for every element the app renders,
 * so it stays read-only until something actually matches: the array is only copied once a
 * button is about to be added.
 */
function editChildren(
	children: ReactNode[],
	props: Record<string, unknown>,
	options: InjectionOptions,
): ChildrenEdit {
	let next: ReactNode[] | undefined
	const writable = (): ReactNode[] => (next ??= [...children])

	const dockEnabled = options.isDockEnabled()
	const rowsEnabled = options.isRowButtonEnabled()

	for (let index = 0; index < children.length; index++) {
		const child = children[index]

		// Conditionals put their children in their own array; treat it as another level.
		if (Array.isArray(child)) {
			const nested = editChildren(child, props, options)
			if (nested.changed) writable()[index] = nested.children
			continue
		}

		/* ------------------------------------------------------------- dock */
		if (dockEnabled && isComposerInput(child)) {
			const composerProps = propsOf(child) ?? {}
			if (!stats.composerSample) {
				stats.composerSample = `placeholder=${JSON.stringify(composerProps.placeholder ?? '')} props=${describeKeys(composerProps)}`
			}

			if (!children.some(isDockElement)) {
				const channel =
					(isTextChannel(composerProps.channel) ? composerProps.channel : undefined) ??
					(isTextChannel(props.channel) ? props.channel : undefined)
				const channelId = channel?.id ?? currentChannelId()

				if (channelId) {
					// Let the input give up width instead of being covered by the button.
					writable()[index] = cloneElement(child as ReactElement, {
						style: [composerProps.style, COMPOSER_INPUT_STYLE],
					})

					writable().push(
						createElement(
							Guard,
							{ key: DOCK_MARKER, onError: options.onError },
							createElement(DockButton, {
								key: 'redpen-dock-button',
								channelId,
								channelName: channelLabel(channel ?? resolveChannel(channelId)),
							}),
						),
					)
					stats.dockInjected += 1
				}
			}
			continue
		}

		/* ------------------------------------------------------------- rows */
		if (!rowsEnabled) continue

		const channel = rowChannel(child)
		if (!channel || hasRowButton(child)) continue

		if (!stats.rowSample) {
			stats.rowSample = `props=${describeKeys(propsOf(child) ?? {})}`
		}

		// Add the button inside the row instead of wrapping it: a new wrapper changes the
		// row's width and every text inside it, which is what broke the channel list.
		const rowChildren = toArray((propsOf(child) ?? {}).children as ReactNode) ?? []
		writable()[index] = cloneElement(child as ReactElement<{ children?: ReactNode }>, {
			children: [
				...rowChildren,
				createElement(
					Guard,
					{ key: 'redpen-row-guard', onError: options.onError },
					createElement(SidebarButton, {
						key: 'redpen-row-button',
						channelId: channel.id,
						channelName: channelLabel(channel),
					}),
				),
			],
		})
		stats.rowsInjected += 1
	}

	return next ? { children: next, changed: true } : { children, changed: false }
}

function injectIntoProps(
	props: Record<string, unknown>,
	options: InjectionOptions,
): Record<string, unknown> | undefined {
	const children = toArray(props.children as ReactNode)
	if (!children) return undefined

	const edit = editChildren(children, props, options)
	if (!edit.changed) return undefined
	return { ...props, children: edit.children }
}

/** Unpatch functions of the currently installed hook. */
let activeUnpatchers: (() => void)[] = []

/**
 * The object every element is created through.
 *
 * Discord and Valenced compile to the automatic JSX runtime, so `ReactJSXRuntime` is the
 * hot path and the only thing patched. `React.createElement` is deliberately left alone:
 * React internals and third-party helpers call it with children as varargs, and rewriting
 * those arguments couples Redpen to far more of the app than a button is worth.
 */
function resolveRuntime(): Record<string, unknown> | undefined {
	try {
		const direct = ReactJSXRuntime as unknown as Record<string, unknown>
		if (direct && typeof direct.jsx === 'function') return direct
	} catch {
		// Fall through to the global.
	}

	try {
		const globalCandidate = (globalThis as Record<string, unknown>).valenced as
			| { react?: { ReactJSXRuntime?: Record<string, unknown> } }
			| undefined
		const runtime = globalCandidate?.react?.ReactJSXRuntime
		if (runtime && typeof runtime.jsx === 'function') return runtime
	} catch {
		// Not reachable.
	}

	return undefined
}

/**
 * Runaway protection.
 *
 * If the matcher ever starts injecting on every render of every element, the app would keep
 * growing trees until it is killed. The breaker counts injections per second; past the
 * limit the hook unpatches itself and leaves a reason in Diagnostics.
 */
const BREAKER_LIMIT = 2000
const BREAKER_WINDOW_MS = 1000
let windowStartedAt = 0
let windowCount = 0
let breakerTripped = false

function breakerAllows(): boolean {
	if (breakerTripped) return false

	const now = Date.now()
	if (now - windowStartedAt > BREAKER_WINDOW_MS) {
		windowStartedAt = now
		windowCount = 0
	}
	windowCount += 1

	if (windowCount > BREAKER_LIMIT) {
		breakerTripped = true
		stats.reason = 'disabled after runaway injection'
		return false
	}
	return true
}

/**
 * Installs the structural injection hook.
 *
 * Idempotent: installing twice returns the first handle.
 */
export function installInjection(options: InjectionOptions): InjectionHandle {
	if (stats.installed && activeUnpatchers.length > 0) return { dispose: () => uninstall() }

	const runtime = resolveRuntime()
	if (!runtime) {
		stats.reason = 'jsx runtime not reachable'
		options.logger.warn('[redpen] cannot reach the JSX runtime; UI buttons disabled')
		return { dispose: () => {} }
	}

	breakerTripped = false
	windowCount = 0
	windowStartedAt = Date.now()

	const unpatchers: (() => void)[] = []

	const report = (error: unknown): void => {
		try {
			options.onError(error)
		} catch {
			// Nothing else to do.
		}
	}

	const safeInject = (
		type: unknown,
		props: Record<string, unknown>,
	): Record<string, unknown> | undefined => {
		try {
			if (isTextLike(type)) return undefined
			if (!breakerAllows()) return undefined
			return injectIntoProps(props, options)
		} catch (error) {
			// A throw inside a jsx hook would break Discord's render; swallow and pass through.
			report(error)
			return undefined
		}
	}

	/** `jsx(type, props, key)` / `jsxs(type, props, key)`. */
	const jsxHook = (args: unknown[]): unknown[] => {
		stats.elementsSeen += 1
		const [type, rawProps, key] = args
		if (!rawProps || typeof rawProps !== 'object') return args

		const props = rawProps as Record<string, unknown>
		if (props.children === undefined) return args

		const patched = safeInject(type, props)
		return patched ? [type, patched, key] : args
	}

	for (const name of ['jsx', 'jsxs'] as const) {
		if (typeof runtime[name] !== 'function') continue
		try {
			unpatchers.push(
				before(runtime as Record<typeof name, (...args: unknown[]) => unknown>, name, jsxHook as never),
			)
		} catch (error) {
			report(error)
		}
	}

	activeUnpatchers = unpatchers
	stats.installed = unpatchers.length > 0
	stats.reason = stats.installed ? 'active' : 'could not patch the jsx runtime'
	options.logger.log(`[redpen] structural UI injection installed (${unpatchers.length} hook(s))`)

	return { dispose: () => uninstall() }
}

function uninstall(): void {
	for (const unpatch of activeUnpatchers.splice(0).reverse()) {
		try {
			unpatch()
		} catch {
			// Already gone.
		}
	}
	stats.installed = false
	stats.reason = 'stopped'
}

/** Drops counters and unpatches; called from `stop`. */
export function resetInjection(): void {
	uninstall()
	stats.installed = false
	stats.reason = 'not started'
	stats.elementsSeen = 0
	stats.dockInjected = 0
	stats.rowsInjected = 0
	stats.composerSample = ''
	stats.rowSample = ''
}
