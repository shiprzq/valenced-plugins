/// <reference types="@valenced/types/plugins/settings.plugins" />

import { ActionSheetActionCreators } from '@valenced/discord/actions'
import { AppState } from 'react-native'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import InputSheet from './ui/InputSheet'
import SettingsScreen from './ui/SettingsScreen'
import {
	initSettings,
	initSettingsEmpty,
	readRedpenSettings,
	registerRedpenSettings,
} from './settings'
import {
	describeSendAction,
	getMessageActionsModule,
	installOutgoingCorrection,
	registerMessageActions,
	resetSendState,
	setSendLogger,
} from './send'
import { CORRECTOR_VERSION, correctText } from './corrector'
import { correctorOptions } from './settings'
import { installInjection, resetInjection, type InjectionHandle } from './inject'
import {
	isChannelOpen,
	isSurfaceMounted,
	isSurfaceOpen,
	markSurfaceClosed,
	markSurfaceOpen,
	resetState,
	setInjectionRestarter,
	setSheetOpener,
} from './state'
import {
	channelLabel,
	DEFAULT_STORAGE,
	INPUT_SHEET_KEY,
	type ChannelLike,
	type MessageActionsLikeModule,
	type RedpenApi,
	type RedpenStorage,
} from './types'

/** How long to wait for Discord's sheet layer to mount our component. */
const SHEET_MOUNT_TIMEOUT_MS = 2500

/**
 * How long injection must survive before the boot is considered clean.
 *
 * The marker is written before the hooks go in and cleared on this timer, on `stop`, or as
 * soon as the app is backgrounded. If a session ends with the marker still set, the app
 * almost certainly died while Redpen's views were live, so the next boot leaves them out
 * and says so in Diagnostics instead of risking the same crash.
 */
const BOOT_MARKER = 'injecting'
const BOOT_CLEAN_AFTER_MS = 30_000

/**
 * Injection defaults change once per safety revision.
 *
 * 1.2.1 turns the channel-row buttons off for anyone upgrading, because that is the
 * high-volume injection and the most likely cause of the crash seen on 1.2.0. The dock
 * button stays on. The row toggle in settings turns them back on immediately.
 */
const SAFETY_VERSION = '2'

/** Only one `sendMessage` rewrite may be installed at a time. */
let outgoingPatch: (() => void) | undefined

/**
 * Installs the "correct what I actually send" rewrite.
 *
 * Idempotent: it is attempted when the message-actions module is found and again on the
 * first dock press, and only the first successful attempt keeps a patch.
 */
function installOutgoingRewrite(
	cleanup: (fn: () => void) => void,
	isEnabled: () => boolean,
): void {
	if (outgoingPatch) return

	const module = getMessageActionsModule()
	if (!module) return

	try {
		const unpatch = installOutgoingCorrection(
			module,
			content => correctText(content, correctorOptions()),
			isEnabled,
		)
		outgoingPatch = unpatch
		cleanup(() => {
			outgoingPatch = undefined
			unpatch()
		})
	} catch {
		// A failed patch must never stop the plugin from loading.
	}
}

/**
 * Redpen — spelling, punctuation and grammar cleanup for outgoing messages.
 *
 * Lifecycle: everything happens in `start` (full runtime API). Nothing touches React,
 * design, actions or settings in `preInit` — and no `preInit` is registered at all.
 *
 * Teardown is synchronous: every patch, subscription, finder and listener is passed to
 * `api.cleanup`, and `stop` only clears module-level state. No reload is required.
 */
/**
 * Clears the boot marker once the app has been usable for a while, or as soon as it is
 * backgrounded. Both mean the session did not die on Redpen's views.
 */
function armBootCleanup(cleanup: (...fns: (() => void)[]) => void, api: RedpenApi): void {
	let cleared = false

	const clear = (): void => {
		if (cleared) return
		cleared = true
		void api.jsonStorage.set({ settings: { bootMarker: '' } })
	}

	const timer = setTimeout(clear, BOOT_CLEAN_AFTER_MS)
	cleanup(() => {
		clearTimeout(timer)
		clear()
	})

	try {
		const subscription = AppState.addEventListener('change', state => {
			if (state !== 'active') clear()
		})
		cleanup(() => subscription.remove())
	} catch (error) {
		api.plugin.reportError(error)
	}
}

export default plugin<{ jsonStorage: RedpenStorage }>({
	jsonStorage: {
		load: true,
		default: DEFAULT_STORAGE,
		file: 'storage.json',
	},

	start(api: RedpenApi) {
		const { cleanup, logger, plugin, jsonStorage } = api

		initSettings(jsonStorage)
		setSendLogger(logger)

		logger.log('[redpen] starting')

		// Keep the read-only version in `storage.json` in sync with the bundled corrector.
		if (readRedpenSettings().correctorVersion !== CORRECTOR_VERSION) {
			void jsonStorage.set({ settings: { correctorVersion: CORRECTOR_VERSION } })
		}

		// One-time safety migration: start from the dock button only.
		if (readRedpenSettings().safetyVersion !== SAFETY_VERSION) {
			logger.warn('[redpen] applying safety defaults: channel-row buttons off, dock button on')
			void jsonStorage.set({
				settings: { safetyVersion: SAFETY_VERSION, showSidebarButton: false },
			})
		}

		/* ---------------------------------------------------------------- send */
		cleanup(
			getModules(
				withProps<MessageActionsLikeModule>('sendMessage', 'receiveMessage'),
				(module, id) => {
					try {
						if (registerMessageActions(module, id, logger)) {
							logger.log(`[redpen] send action ready (${describeSendAction()})`)
							installOutgoingRewrite(cleanup, () => readRedpenSettings().autoCorrectOutgoing)
						}
					} catch (error) {
						// Exceptions inside finder callbacks are swallowed; surface them here.
						plugin.reportError(error)
					}
				},
				{ max: 1 },
			),
		)

		/* --------------------------------------------------------------- UI */
		// Structural injection: one hook over the JSX runtime, no component names.
		const boot = readRedpenSettings()

		// A marker left over from the previous session means the app did not survive
		// injection last time. Stay off this boot and let the user opt back in.
		if (boot.bootMarker === BOOT_MARKER) {
			logger.warn('[redpen] UI injection suspended: the last session ended while it was live')
			void jsonStorage.set({ settings: { bootMarker: '', injectionSuspended: true } })
		}

		const injection = (): InjectionHandle => {
			if (readRedpenSettings().injectionSuspended) {
				logger.warn('[redpen] UI injection is suspended; re-enable it in Redpen settings')
				return { dispose: () => {} }
			}

			void jsonStorage.set({ settings: { bootMarker: BOOT_MARKER } })
			const handle = installInjection({
				logger,
				isDockEnabled: () => readRedpenSettings().showDockButton,
				isRowButtonEnabled: () => readRedpenSettings().showSidebarButton,
				onError: error => plugin.reportError(error),
			})
			armBootCleanup(cleanup, api)
			return handle
		}

		let injectionHandle = injection()
		cleanup(() => injectionHandle.dispose())
		setInjectionRestarter(() => {
			injectionHandle.dispose()
			injectionHandle = injection()
		})

		/* ------------------------------------------- correct outgoing messages */
		installOutgoingRewrite(cleanup, () => readRedpenSettings().autoCorrectOutgoing)

		/* ------------------------------------------------------------ settings */
		registerRedpenSettings(api, cleanup)

		/* ---------------------------------------------------------- the sheet */
		setSheetOpener(channel => openInputSurface(channel, plugin))

		cleanup(() => {
			setInjectionRestarter(undefined)
			setSheetOpener(undefined)
			initSettingsEmpty()
			try {
				ActionSheetActionCreators.hideActionSheet(INPUT_SHEET_KEY)
			} catch {
				// The sheet layer may already be gone during teardown.
			}
		})

		logger.log('[redpen] started')
	},

	stop() {
		// `api.cleanup` callbacks run automatically, in reverse registration order.
		// All that is left is module state: the per-channel open set, in-flight flags and
		// the resolved send candidates.
		outgoingPatch = undefined
		resetSendState()
		resetInjection()
		resetState()
	},

	SettingsComponent: SettingsScreen,
})

/**
 * Opens the input surface for one channel.
 *
 * Only one Redpen surface may exist at a time, tracked per channel id so that row's
 * button renders disabled. A watchdog releases the flag if Discord's sheet layer never
 * mounts the component (a swallowed `openLazy` failure must not lock the button).
 */
function openInputSurface(channel: ChannelLike, plugin: RedpenApi['plugin']): void {
	if (isSurfaceOpen() || isChannelOpen(channel.id)) return

	markSurfaceOpen(channel.id, 'input')

	try {
		ActionSheetActionCreators.openLazy(
			Promise.resolve({ default: InputSheet }),
			INPUT_SHEET_KEY,
			{ channelId: channel.id, channelName: channelLabel(channel) },
			'stack',
		)
	} catch (error) {
		markSurfaceClosed()
		plugin.reportError(error)
		return
	}

	setTimeout(() => {
		if (isSurfaceOpen() && !isSurfaceMounted()) {
			markSurfaceClosed()
			plugin.reportError(
				new Error('Redpen sheet did not mount; the channel button was re-enabled.'),
			)
		}
	}, SHEET_MOUNT_TIMEOUT_MS)
}
