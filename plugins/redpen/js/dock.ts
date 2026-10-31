import { Stores } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withName } from '@valenced/modules/finders/filters'
import { onAnyModuleInitialized } from '@valenced/modules/metro'
import { afterJSX } from '@valenced/react/jsx-runtime'
import { cloneElement, createElement, isValidElement } from 'react'
import type { ComponentType, ReactElement, ReactNode } from 'react'
import DockButton from './ui/DockButton'
import { channelLabel, isTextChannel, type ChannelLike, type RedpenLogger } from './types'

/**
 * Injects the Redpen button into the message dock — the row that holds “Message #channel”
 * next to the gift, emoji and microphone buttons.
 *
 * Discord renders that row from a component whose name varies between builds, so the
 * component is discovered in two ways, both guarded:
 *
 * 1. by name through the finders (`ChatInputButtons`, `ChatInputActionButtons`, …);
 * 2. by scanning every module that initialises for a component whose name looks like an
 *    input-button row.
 *
 * The hook is `afterJSX`: Discord's element is cloned and our button is appended to its
 * children, so the original row keeps its layout and nothing is replaced. If no component
 * is found, the sidebar button stays as the only entry point and the settings page says so.
 */

export interface DockOptions {
	logger: RedpenLogger
	isEnabled(): boolean
	onError(error: unknown): void
	onDegrade(): void
}

/** How long to look for the dock component before reporting it as unavailable. */
const LOCATE_TIMEOUT_MS = 20000

/**
 * Component names seen in Discord builds for the dock's button row. Matching is
 * case-insensitive; `looksLikeDockName` below also accepts near misses.
 */
const KNOWN_NAMES = [
	'ChatInputButtons',
	'ChatInputActionButtons',
	'ChatInputActionBar',
	'ChatInputButtonRow',
	'ChannelTextAreaButtons',
	'TextAreaButtons',
	'ComposerButtons',
	'InputButtons',
]

function looksLikeDockName(name: string): boolean {
	const lower = name.toLowerCase()
	if (!lower.includes('input') && !lower.includes('textarea') && !lower.includes('composer')) {
		return false
	}
	return lower.includes('button') || lower.includes('actionbar') || lower.includes('toolbar')
}

const DOCK_MARKER = 'redpen-dock'

const patchedTypes = new Set<unknown>()
const patches: (() => void)[] = []
const foundNames = new Set<string>()

let degraded = false
let everInjected = false
let activeHandle: DockHandle | undefined

interface SelectedChannelStoreLike {
	getChannelId?(): string | null
	getLastSelectedChannelId?(): string | null
}

interface ChannelStoreLike {
	getChannel?(channelId: string): unknown
}

function readStore<T>(name: string): T | undefined {
	try {
		const store = (Stores as Record<string, unknown>)[name]
		return (store ?? undefined) as T | undefined
	} catch {
		return undefined
	}
}

function currentChannelId(): string | undefined {
	const selected = readStore<SelectedChannelStoreLike>('SelectedChannelStore')
	const id = selected?.getChannelId?.() ?? selected?.getLastSelectedChannelId?.() ?? undefined
	return typeof id === 'string' && id.length > 0 ? id : undefined
}

function resolveChannel(channelId: string): ChannelLike | undefined {
	const store = readStore<ChannelStoreLike>('ChannelStore')
	const channel = store?.getChannel?.(channelId)
	if (isTextChannel(channel)) return channel
	// Unknown shape: keep the id, it is all the sheet needs.
	return channelId ? { id: channelId } : undefined
}

function childrenOf(props: Record<string, unknown>): ReactNode[] {
	const children = props.children
	if (children === undefined || children === null) return []
	return Array.isArray(children) ? children : [children as ReactNode]
}

function alreadyInjected(children: ReactNode[]): boolean {
	return children.some(
		child => isValidElement(child) && (child as ReactElement<{ key?: string }>).key === DOCK_MARKER,
	)
}

/** Clones the dock row and appends the Redpen button. */
function injectButton(
	element: ReactElement<Record<string, unknown>>,
	options: DockOptions,
): ReactElement<Record<string, unknown>> {
	if (!options.isEnabled()) return element

	const props = element.props ?? {}
	const channelId =
		(isTextChannel(props.channel) ? props.channel.id : undefined) ??
		(typeof props.channelId === 'string' ? props.channelId : undefined) ??
		currentChannelId()

	if (!channelId) return element

	const children = childrenOf(props)
	if (alreadyInjected(children)) return element

	everInjected = true

	return cloneElement(
		element,
		undefined,
		...children,
		createElement(DockButton, {
			key: DOCK_MARKER,
			channelId,
			channelName: channelLabel(resolveChannel(channelId) ?? { id: channelId }),
		}),
	)
}

function patchCandidate(type: unknown, options: DockOptions): void {
	if (typeof type !== 'function') return
	if (patchedTypes.has(type)) return
	patchedTypes.add(type)

	const name = (type as { name?: string }).name ?? '(anonymous)'
	foundNames.add(name)
	options.logger.log(`[redpen] dock component: ${name}`)

	try {
		const unpatch = afterJSX(type as ComponentType<Record<string, unknown>>, element => {
			try {
				return injectButton(
					element as ReactElement<Record<string, unknown>>,
					options,
				) as unknown as ReactElement
			} catch (error) {
				options.onError(error)
				return element
			}
		})
		patches.push(unpatch)
	} catch (error) {
		options.onError(error)
	}
}

/** Reads a component name from a module's exports, default export first. */
function exportedComponent(exports: Record<string, unknown> | undefined): unknown {
	if (!exports) return undefined
	const candidate = (exports.default ?? exports) as unknown
	return typeof candidate === 'function' ? candidate : undefined
}

export interface DockHandle {
	/** Unpatches every hook and clears module state. */
	dispose(): void
	/** Human-readable state for the settings page. */
	describe(): string
}

/**
 * Starts looking for the dock row and patches it when found.
 *
 * Everything registered here is returned through `dispose`, which the caller passes to
 * `api.cleanup`.
 */
export function installDock(options: DockOptions): DockHandle {
	const unsubscribers: (() => void)[] = []

	// 1. Name-based lookup through the finders.
	for (const name of KNOWN_NAMES) {
		try {
			unsubscribers.push(
				getModules(
					withName<Record<string, unknown>>(name),
					(exports: unknown, id: number) => {
						options.logger.log(`[redpen] dock candidate ${name} → module ${id}`)
						patchCandidate(exportedComponent(exports as Record<string, unknown>), options)
					},
					{ max: 1 },
				),
			)
		} catch (error) {
			options.onError(error)
		}
	}

	// 2. Scan every module that initialises, in case the build renamed the component.
	try {
		unsubscribers.push(
			onAnyModuleInitialized((_id, exports) => {
				const component = exportedComponent(exports as Record<string, unknown>)
				if (typeof component !== 'function') return
				const name = (component as { name?: string }).name ?? ''
				if (!name || !looksLikeDockName(name)) return
				patchCandidate(component, options)
			}),
		)
	} catch (error) {
		// Metro helpers are optional: the name lookup above still works without them.
		options.logger.warn('[redpen] module scan unavailable; relying on name lookup')
	}

	// 3. Give up gracefully if nothing showed up.
	const timer = setTimeout(() => {
		if (patchedTypes.size > 0) return
		degraded = true
		options.onDegrade()
	}, LOCATE_TIMEOUT_MS)

	const handle: DockHandle = {
		dispose() {
			if (activeHandle === handle) activeHandle = undefined
			clearTimeout(timer)
			for (const unsubscribe of unsubscribers.splice(0).reverse()) {
				try {
					unsubscribe()
				} catch {
					// Already gone.
				}
			}
			for (const unpatch of patches.splice(0).reverse()) {
				try {
					unpatch()
				} catch {
					// Already unpatched.
				}
			}
			patchedTypes.clear()
			foundNames.clear()
			degraded = false
			everInjected = false
		},
		describe(): string {
			if (foundNames.size === 0) {
				return degraded ? 'not found in this build' : 'searching…'
			}
			const names = [...foundNames].join(', ')
			return everInjected ? `active (${names})` : `patched but idle (${names})`
		},
	}

	activeHandle = handle
	return handle
}

/** State of the dock injection, for the settings page. */
export function describeDockInjection(): string {
	return activeHandle?.describe() ?? 'not started'
}
