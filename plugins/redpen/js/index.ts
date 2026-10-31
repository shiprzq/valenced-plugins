/// <reference types="@valenced/types/plugins/settings.plugins" />

import { ActionSheetActionCreators, ToastActionCreators } from '@valenced/discord/actions'
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
import { installDock } from './dock'
import { CORRECTOR_VERSION, correctText } from './corrector'
import { correctorOptions } from './settings'
import { installSidebar } from './sidebar'
import {
	isChannelOpen,
	isSurfaceMounted,
	isSurfaceOpen,
	markSurfaceClosed,
	markSurfaceOpen,
	resetState,
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

		/* ---------------------------------------------------------------- dock */
		cleanup(
			installDock({
				logger,
				isEnabled: () => readRedpenSettings().showDockButton,
				onError: error => plugin.reportError(error),
				onDegrade: () => {
					ToastActionCreators.open('REDPEN_DOCK_UNAVAILABLE', {
						text: 'Redpen: message dock button unavailable in this build.',
						variant: 'critical',
						duration: 4000,
					})
				},
			}).dispose,
		)

		/* ------------------------------------------- correct outgoing messages */
		installOutgoingRewrite(cleanup, () => readRedpenSettings().autoCorrectOutgoing)

		/* ------------------------------------------------------------- sidebar */
		cleanup(
			installSidebar({
				logger,
				isEnabled: () => readRedpenSettings().showSidebarButton,
				onError: error => plugin.reportError(error),
				onDegrade: () => {
					ToastActionCreators.open('REDPEN_SIDEBAR_UNAVAILABLE', {
						text: 'Redpen: channel rows unavailable in this build.',
						variant: 'critical',
						duration: 4000,
					})
				},
			}),
		)

		/* ------------------------------------------------------------ settings */
		registerRedpenSettings(api, cleanup)

		/* ---------------------------------------------------------- the sheet */
		setSheetOpener(channel => openInputSurface(channel, plugin))

		cleanup(() => {
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
