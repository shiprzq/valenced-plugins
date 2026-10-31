import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { after } from '@valenced/patcher'
import { afterJSX } from '@valenced/react/jsx-runtime'
import { getStore } from '@valenced/discord/flux'
import { createElement } from 'react'
import type { ComponentType, ReactElement, ReactNode } from 'react'
import { View } from 'react-native'
import SidebarButton from './ui/SidebarButton'
import { propsOf, mapElements, walkElements } from './tree'
import {
	channelLabel,
	isTextChannel,
	type ChannelLike,
	type ChannelListModule,
	type ChannelRowProps,
	type RedpenLogger,
} from './types'
import { markDegraded } from './state'

/**
 * Sidebar injection.
 *
 * Chain, in order:
 *
 * 1. Find the channel-list item renderer with a property filter on
 *    `renderChannelListItem` (`modules/channel_list_v2/native/renderRedesignChannelListItem`).
 * 2. `after`-hook that function to capture the *element types* it renders for rows,
 *    without touching its output — this is how the row's own `channel` prop is read.
 * 3. Register `afterJSX` on each captured row type and wrap the row element in a
 *    horizontal flex container with the Redpen button as a fixed-size sibling.
 *
 * `afterJSX` composes with other plugins: the original element is preserved and nested,
 * never replaced. Nothing patches a component render function.
 */

export interface SidebarOptions {
	logger: RedpenLogger
	isEnabled(): boolean
	onError(error: unknown): void
	/** Called once when no row type was captured in time. */
	onDegrade(): void
}

/** How long to wait for the channel list module before degrading. */
const LOCATE_TIMEOUT_MS = 15000

const ROW_WRAPPER_STYLE = { flexDirection: 'row' as const, alignItems: 'center' as const }
const ROW_SLOT_STYLE = { flex: 1 as const, minWidth: 0 as const }

interface ChannelStoreLike {
	getChannel?(channelId: string): unknown
}

const patchedTypes = new Set<unknown>()
const rowPatches: (() => void)[] = []
/** Row element instances already wrapped, so the hook and the tree pass never stack. */
let wrappedRows = new WeakSet<object>()

let channelStore: ChannelStoreLike | undefined
let sawRowType = false
let degraded = false

function resolveChannel(channelId: string): ChannelLike | undefined {
	const channel = channelStore?.getChannel?.(channelId)
	return isTextChannel(channel) ? channel : undefined
}

/**
 * Channel row shapes. `isSuggestedSection` is present on the redesign channel rows;
 * DM and announcement rows may only carry `selected` / `muted`, so both are accepted as
 * long as the row owns a text-capable `channel` prop of its own.
 */
function isTextRow(element: ReactElement<Record<string, unknown>>): boolean {
	const props = propsOf(element) as ChannelRowProps
	if (typeof element.type === 'string') return false
	if (props.channel == null) return false
	if ('threadId' in props) return false

	return 'isSuggestedSection' in props || props.selected !== undefined || props.muted !== undefined
}

function isThreadRow(element: ReactElement<Record<string, unknown>>): boolean {
	const props = propsOf(element) as ChannelRowProps
	return (
		'threadId' in props &&
		typeof props.threadId === 'string' &&
		!('channel' in props) &&
		typeof element.type !== 'string'
	)
}

/** Wraps the row element, keeping it exactly as Discord rendered it. */
function wrapRow(
	element: ReactElement<Record<string, unknown>>,
	options: SidebarOptions,
): ReactNode {
	if (wrappedRows.has(element)) return element

	const props = propsOf(element) as ChannelRowProps

	const channel = isTextChannel(props.channel)
		? props.channel
		: typeof props.threadId === 'string'
			? resolveChannel(props.threadId)
			: undefined

	if (!channel) return element
	if (!options.isEnabled()) return element

	wrappedRows.add(element)

	return createElement(
		View,
		{ style: ROW_WRAPPER_STYLE, collapsable: false },
		createElement(View, { style: ROW_SLOT_STYLE }, element),
		createElement(SidebarButton, {
			key: 'redpen',
			channelId: channel.id,
			channelName: channelLabel(channel),
		}),
	)
}

function patchRowType(type: unknown, options: SidebarOptions): void {
	if (!type || patchedTypes.has(type)) return
	patchedTypes.add(type)

	try {
		const unpatch = afterJSX(type as ComponentType<Record<string, unknown>>, element => {
			try {
				return wrapRow(
					element as ReactElement<Record<string, unknown>>,
					options,
				) as unknown as ReactElement
			} catch (error) {
				// Never break the row: fall back to what Discord produced.
				options.onError(error)
				return element
			}
		})

		rowPatches.push(unpatch)
		sawRowType = true
		options.logger.log('[sidebar] row component patched via afterJSX')
	} catch (error) {
		options.onError(error)
	}
}

function isRowElement(element: ReactElement<Record<string, unknown>>): boolean {
	return isTextRow(element) || isThreadRow(element)
}

/** Captures row element types from the tree the list renderer returned. */
function captureRowTypes(tree: unknown, options: SidebarOptions): void {
	try {
		walkElements(tree as ReactNode, element => {
			if (isTextRow(element)) patchRowType(element.type, options)
			else if (isThreadRow(element)) patchRowType(element.type, options)
		})
	} catch (error) {
		options.onError(error)
	}
}

/**
 * Installs the sidebar button.
 *
 * @returns A teardown function (unpatch everything, clear timers).
 */
export function installSidebar(options: SidebarOptions): () => void {
	let disposed = false

	// Re-installing after a stop/start cycle starts from a clean slate.
	sawRowType = false
	degraded = false
	wrappedRows = new WeakSet<object>()

	const cleanups: (() => void)[] = []

	const degrade = () => {
		if (degraded || sawRowType || disposed) return
		degraded = true
		markDegraded()
		options.logger.error(
			'[sidebar] channel row component not found in this Discord build. ' +
				'The per-channel Redpen button is unavailable until the row renderer is patched. ' +
				'No reload was forced.',
		)
		options.onDegrade()
	}

	const timer = setTimeout(degrade, LOCATE_TIMEOUT_MS)
	cleanups.push(() => clearTimeout(timer))

	// Thread rows only carry `threadId`; the channel record comes from the store.
	cleanups.push(
		getStore('ChannelStore', store => {
			channelStore = store as unknown as ChannelStoreLike
			options.logger.log('[sidebar] ChannelStore resolved for thread rows')
		}),
	)

	const rowModuleId = getModules(
		withProps<ChannelListModule>('renderChannelListItem'),
		(module, id) => {
			if (disposed) return

			try {
				options.logger.log(`[sidebar] channel list renderer resolved at module ${id}`)

				cleanups.push(
					after(module, 'renderChannelListItem', tree => {
						if (disposed) return tree

						// Register the row element types for future renders …
						captureRowTypes(tree, options)

						// … and wrap the rows already present in this tree, so the button
						// appears on the first render instead of the next re-render.
						try {
							return mapElements(tree as ReactNode, isRowElement, element =>
								wrapRow(element as ReactElement<Record<string, unknown>>, options),
							)
						} catch (error) {
							options.onError(error)
							return tree
						}
					}),
				)
			} catch (error) {
				// Exceptions thrown here are swallowed by `getModules`; report them ourselves.
				options.onError(error)
			}
		},
		{ max: 1 },
	)

	cleanups.push(rowModuleId)

	return () => {
		disposed = true
		clearTimeout(timer)
		for (const unpatch of rowPatches.splice(0).reverse()) {
			try {
				unpatch()
			} catch (error) {
				options.onError(error)
			}
		}
		patchedTypes.clear()
		for (const cleanup of cleanups.splice(0).reverse()) {
			try {
				cleanup()
			} catch (error) {
				options.onError(error)
			}
		}
	}
}

/** Diagnostics for the settings screen. */
export function describeSidebarInjection(): string {
	if (degraded) return 'unavailable (channel row not found)'
	if (!sawRowType) return 'waiting for the channel list'
	return 'active'
}
