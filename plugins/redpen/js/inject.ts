import { Stores } from '@valenced/discord/flux'
import { React, ReactJSXRuntime } from '@valenced/react'
import { before } from '@valenced/patcher'
import { createElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { View } from 'react-native'
import DockButton from './ui/DockButton'
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
const ROW_WRAPPER = { flexDirection: 'row' as const, alignItems: 'center' as const }
const ROW_SLOT = { flex: 1 as const, minWidth: 0 as const }
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

/**
 * Does this child hold a channel-qualified text input? Nested arrays are searched because
 * conditionals like `{flag && [...]}` put their children inside their own array.
 */
function findComposerInput(children: ReactNode[]): ReactNode | undefined {
	for (const child of children) {
		if (Array.isArray(child)) {
			const nested = findComposerInput(child)
			if (nested) return nested
			continue
		}
		if (isComposerInput(child)) return child
	}
	return undefined
}

function isDockElement(child: ReactNode): boolean {
	return isValidElement(child) && (child as ReactElement<{ key?: string }>).key === DOCK_MARKER
}

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

	/* ---------------------------------------------------------------- dock */
	if (options.isDockEnabled()) {
		const composer = findComposerInput(children)
		if (composer && !children.some(isDockElement)) {
			const composerProps = propsOf(composer) ?? {}
			if (!stats.composerSample) {
				stats.composerSample = `placeholder=${JSON.stringify(composerProps.placeholder ?? '')} props=${describeKeys(composerProps)}`
			}

			const channel =
				(isTextChannel(composerProps.channel) ? composerProps.channel : undefined) ??
				(isTextChannel(props.channel) ? props.channel : undefined)
			const channelId = channel?.id ?? currentChannelId()

			if (channelId) {
				writable().push(
					createElement(DockButton, {
						key: DOCK_MARKER,
						channelId,
						channelName: channelLabel(channel ?? resolveChannel(channelId)),
					}),
				)
				stats.dockInjected += 1
			}
		}
	}

	/* ---------------------------------------------------------------- rows */
	if (options.isRowButtonEnabled()) {
		for (let index = 0; index < children.length; index++) {
			const child = children[index]

			if (Array.isArray(child)) {
				const nested = editChildren(child, props, options)
				if (nested.changed) {
					writable()[index] = nested.children
				}
				continue
			}

			const channel = rowChannel(child)
			if (!channel || isRowWrapped(child)) continue

			if (!stats.rowSample) {
				stats.rowSample = `props=${describeKeys(propsOf(child) ?? {})}`
			}

			writable()[index] = createElement(
				View,
				{ key: `redpen-row-${channel.id}`, style: ROW_WRAPPER, collapsable: false },
				createElement(View, { key: 'redpen-row-slot', style: ROW_SLOT }, child as ReactElement),
				createElement(SidebarButton, {
					key: 'redpen-row-button',
					channelId: channel.id,
					channelName: channelLabel(channel),
				}),
			)
			stats.rowsInjected += 1
		}
	}

	return next ? { children: next, changed: true } : { children, changed: false }
}

/** Guards against wrapping the same row twice if the tree is re-created inside our wrapper. */
function isRowWrapped(element: ReactNode): boolean {
	if (!isValidElement(element)) return false
	const key = (element as ReactElement<{ key?: string }>).key
	return typeof key === 'string' && key.startsWith('redpen-row-')
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
 * The objects every element is created through.
 *
 * Discord and Valenced both compile to the automatic JSX runtime, so `ReactJSXRuntime` is
 * the hot path; `React.createElement` is patched too for any component still on the classic
 * runtime. Both are module namespaces, so their properties are looked up at call time and a
 * late patch still applies.
 */
function resolveRuntimes(): { object: Record<string, unknown>; keys: string[] }[] {
	const runtimes: { object: Record<string, unknown>; keys: string[] }[] = []

	try {
		if (ReactJSXRuntime && typeof (ReactJSXRuntime as { jsx?: unknown }).jsx === 'function') {
			runtimes.push({ object: ReactJSXRuntime as unknown as Record<string, unknown>, keys: ['jsx', 'jsxs'] })
		}
	} catch {
		// Ignore: fall through to the global.
	}

	try {
		const globalCandidate = (globalThis as Record<string, unknown>).valenced as
			| { react?: { ReactJSXRuntime?: Record<string, unknown> } }
			| undefined
		const runtime = globalCandidate?.react?.ReactJSXRuntime
		if (runtime && typeof runtime.jsx === 'function' && !runtimes.some(entry => entry.object === runtime)) {
			runtimes.push({ object: runtime, keys: ['jsx', 'jsxs'] })
		}
	} catch {
		// Ignore.
	}

	try {
		if (React && typeof (React as { createElement?: unknown }).createElement === 'function') {
			runtimes.push({ object: React as unknown as Record<string, unknown>, keys: ['createElement'] })
		}
	} catch {
		// Ignore.
	}

	return runtimes
}

/**
 * Installs the structural injection hook.
 *
 * Idempotent: installing twice returns the first handle.
 */
export function installInjection(options: InjectionOptions): InjectionHandle {
	if (stats.installed && activeUnpatchers.length > 0) return { dispose: () => uninstall() }

	const runtimes = resolveRuntimes()
	if (runtimes.length === 0) {
		stats.reason = 'jsx runtime not reachable'
		options.logger.warn('[redpen] cannot reach the JSX runtime; UI buttons disabled')
		return { dispose: () => {} }
	}

	const unpatchers: (() => void)[] = []

	const safeInject = (props: Record<string, unknown>): Record<string, unknown> | undefined => {
		try {
			return injectIntoProps(props, options)
		} catch (error) {
			// A throw inside a jsx hook would break Discord's render; swallow and pass through.
			try {
				options.onError(error)
			} catch {
				// Nothing else to do.
			}
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

		const patched = safeInject(props)
		return patched ? [type, patched, key] : args
	}

	/** `createElement(type, props, ...children)`. */
	const createElementHook = (args: unknown[]): unknown[] => {
		stats.elementsSeen += 1
		const [type, rawProps, ...children] = args
		const props =
			rawProps && typeof rawProps === 'object' ? (rawProps as Record<string, unknown>) : {}
		if (children.length === 0 && props.children === undefined) return args

		const patched = safeInject({ ...props, children: children.length > 0 ? children : props.children })
		if (!patched) return args

		const { children: patchedChildren, ...rest } = patched
		const forwarded = toArray(patchedChildren as ReactNode) ?? []
		return [type, rest, ...forwarded]
	}

	for (const { object, keys } of runtimes) {
		for (const name of keys) {
			if (typeof object[name] !== 'function') continue
			try {
				unpatchers.push(
					before(
						object as Record<string, (...args: unknown[]) => unknown>,
						name,
						(name === 'createElement' ? createElementHook : jsxHook) as never,
					),
				)
			} catch (error) {
				options.onError(error)
			}
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
