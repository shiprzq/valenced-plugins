import type { ChannelLike } from './types'

/**
 * Module-level runtime state.
 *
 * Kept out of the lifecycle file so the sidebar button and the sheets can read it
 * without importing `index.ts` (which would be a cycle).
 *
 * `resetState()` is called from `stop()` — the open set is cleared there.
 */

/** Channels with a Redpen surface currently open. */
const openChannels = new Set<string>()

/** Current step of the single open surface. */
type SurfaceStep = 'input' | 'preview'
let openStep: SurfaceStep | undefined

/** Channels with a send in flight. */
const inFlight = new Set<string>()

const listeners = new Set<() => void>()

/** Set once the input sheet reports that it mounted. */
let surfaceMounted = false

/** Set when the sidebar rows could not be patched in this Discord build. */
let degraded = false

/** Set by `index.ts`; the button calls it to open the input surface. */
let opener: ((channel: ChannelLike) => void) | undefined

/** Set by `index.ts`; lets settings re-install the UI hooks after a suspension. */
let injectionRestarter: (() => void) | undefined

function emit(): void {
	for (const listener of listeners) {
		try {
			listener()
		} catch {
			// A listener throwing must never take down the row it lives in.
		}
	}
}

export function subscribeToOpenState(listener: () => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

export function isChannelOpen(channelId: string): boolean {
	return openChannels.has(channelId)
}

export function isSurfaceOpen(): boolean {
	return openStep !== undefined
}

export function getOpenStep(): SurfaceStep | undefined {
	return openStep
}

export function markSurfaceOpen(channelId: string, step: SurfaceStep): void {
	openChannels.add(channelId)
	openStep = step
	surfaceMounted = false
	emit()
}

/** Called by the sheets on mount, so the opener's watchdog can stand down. */
export function markSurfaceMounted(): void {
	surfaceMounted = true
}

export function isSurfaceMounted(): boolean {
	return surfaceMounted
}

export function markSurfaceStep(channelId: string, step: SurfaceStep): void {
	if (!openChannels.has(channelId)) {
		markSurfaceOpen(channelId, step)
		return
	}
	if (openStep !== step) surfaceMounted = false
	openStep = step
	emit()
}

export function markSurfaceClosed(): void {
	openChannels.clear()
	openStep = undefined
	surfaceMounted = false
	emit()
}

export function isInFlight(channelId: string): boolean {
	return inFlight.has(channelId)
}

/** Returns `false` when a send for this channel is already running. */
export function beginSend(channelId: string): boolean {
	if (inFlight.has(channelId)) return false
	inFlight.add(channelId)
	return true
}

export function endSend(channelId: string): void {
	inFlight.delete(channelId)
}

export function setSheetOpener(fn: ((channel: ChannelLike) => void) | undefined): void {
	opener = fn
}

export function openRedpen(channel: ChannelLike): void {
	opener?.(channel)
}

export function setInjectionRestarter(fn: (() => void) | undefined): void {
	injectionRestarter = fn
}

/** Re-installs the UI hooks after the user clears a suspension. */
export function restartInjection(): void {
	injectionRestarter?.()
}

export function markDegraded(): void {
	degraded = true
	emit()
}

export function isDegraded(): boolean {
	return degraded
}

/** Clears everything. Called from `stop()`. */
export function resetState(): void {
	opener = undefined
	injectionRestarter = undefined
	openChannels.clear()
	inFlight.clear()
	openStep = undefined
	surfaceMounted = false
	degraded = false
	emit()
	listeners.clear()
}
