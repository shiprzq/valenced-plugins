import {
	addSettingsItemToSection,
	onSettingsModulesLoaded,
	refreshSettings,
	registerSettingsItems,
	registerSettingsSection,
} from '@valenced/discord/modules/settings'
import type { JsonStorage } from '@valenced/json-storage'
import type { SettingsItem } from '@valenced/discord/modules/settings'
import { CORRECTOR_VERSION, type CorrectorOptions, type RuleId } from './corrector'
import { DEFAULT_SETTINGS, type RedpenApi, type RedpenSettings, type RedpenStorage } from './types'

/* -------------------------------------------------------------------------- */
/* Storage access                                                             */
/* -------------------------------------------------------------------------- */

let storage: JsonStorage<RedpenStorage> | undefined

/** Called once from `start`. */
export function initSettings(value: JsonStorage<RedpenStorage>): void {
	storage = value
}

export function initSettingsEmpty(): void {
	storage = undefined
}

/**
 * Reactive read for components. Uses `jsonStorage.use()`, so every toggle re-renders
 * without a reload. `storage` is assigned in `start`, before any of our components can
 * mount, so the hook order is stable.
 */
export function useRedpenSettings(): RedpenSettings {
	const stored = storage ? (storage.use() as RedpenStorage | undefined) : undefined
	return { ...DEFAULT_SETTINGS, ...(stored?.settings ?? {}) }
}

/** Imperative read for event handlers — always sees the latest persisted value. */
export function readRedpenSettings(): RedpenSettings {
	if (!storage) return DEFAULT_SETTINGS
	const stored = storage.cache as RedpenStorage | undefined
	return { ...DEFAULT_SETTINGS, ...(stored?.settings ?? {}) }
}

/**
 * Options for `correct()` built from the current settings.
 *
 * Read at call time, so a rule toggled in settings applies to the next message without a
 * reload or a restart.
 */
export function correctorOptions(): CorrectorOptions {
	const settings = readRedpenSettings()
	return {
		skip: (settings.disabledRules ?? []) as RuleId[],
		dictionary: settings.userDictionary ?? {},
	}
}

/** Convenience for UI: is a rule group on? */
export function isRuleEnabled(id: RuleId): boolean {
	return !(readRedpenSettings().disabledRules ?? []).includes(id)
}

/** Persists a partial update, merged into the `settings` key. */
export async function writeRedpenSettings(patch: Partial<RedpenSettings>): Promise<void> {
	if (!storage) return
	await storage.set({ settings: patch })
}

/* -------------------------------------------------------------------------- */
/* Settings entries                                                           */
/* -------------------------------------------------------------------------- */

export const PREVIEW_TOGGLE_KEY = 'RedpenPreviewMode'
export const DOCK_TOGGLE_KEY = 'RedpenDockButton'
export const AUTO_CORRECT_TOGGLE_KEY = 'RedpenAutoCorrect'
export const SETTINGS_ITEM_KEY = 'RedpenSettingsPage'
export const SETTINGS_SECTION_KEY = 'REDPEN'
/** Section the Valenced settings live in. */
const VALENCED_SECTION = 'VALENCED'

function previewToggleItem(): SettingsItem {
	return {
		parent: null,
		type: 'toggle',
		useTitle: () => 'Show preview before sending',
		useDescription: () => 'Turn off to send corrected messages automatically.',
		useValue: () => useRedpenSettings().previewMode,
		onValueChange: (value: boolean) => {
			void writeRedpenSettings({ previewMode: value })
		},
	}
}

function dockToggleItem(): SettingsItem {
	return {
		parent: null,
		type: 'toggle',
		useTitle: () => 'Show the button in the message dock',
		useDescription: () => 'Adds the Redpen button next to the gift, emoji and microphone buttons.',
		useValue: () => useRedpenSettings().showDockButton,
		onValueChange: (value: boolean) => {
			void writeRedpenSettings({ showDockButton: value })
		},
	}
}

function autoCorrectItem(): SettingsItem {
	return {
		parent: null,
		type: 'toggle',
		useTitle: () => 'Correct messages as you send them',
		useDescription: () => 'Fixes the text of any message you send, without opening Redpen.',
		useValue: () => useRedpenSettings().autoCorrectOutgoing,
		onValueChange: (value: boolean) => {
			void writeRedpenSettings({ autoCorrectOutgoing: value })
		},
	}
}

function settingsPageItem(api: RedpenApi): SettingsItem {
	return {
		parent: null,
		type: 'pressable',
		withArrow: true,
		useTitle: () => 'Redpen',
		useDescription: () => 'Sidebar button, preview mode and corrector details.',
		onPress: () => {
			api.pluginSettings.openPluginSettings(api.plugin.manifest.id)
		},
	}
}

/**
 * Registers Redpen under Valenced's plugin settings.
 *
 * Must run inside `onSettingsModulesLoaded`. Every unregister function returned by the
 * settings module is passed to `cleanup`.
 */
export function registerRedpenSettings(api: RedpenApi, cleanup: (...fns: (() => void)[]) => void): void {
	let disposed = false
	const removers: (() => void)[] = []

	cleanup(() => {
		disposed = true
		for (const remove of removers.splice(0).reverse()) {
			try {
				remove()
			} catch {
				// Unregistering twice must not throw during teardown.
			}
		}
		refreshSettings()
	})

	cleanup(
		onSettingsModulesLoaded(() => {
			if (disposed) return

			removers.push(
				registerSettingsItems({
					[PREVIEW_TOGGLE_KEY]: previewToggleItem(),
					[DOCK_TOGGLE_KEY]: dockToggleItem(),
					[AUTO_CORRECT_TOGGLE_KEY]: autoCorrectItem(),
					[SETTINGS_ITEM_KEY]: settingsPageItem(api),
				}),
			)

			let placed = false
			try {
				removers.push(addSettingsItemToSection(VALENCED_SECTION, PREVIEW_TOGGLE_KEY))
				removers.push(addSettingsItemToSection(VALENCED_SECTION, DOCK_TOGGLE_KEY))
				removers.push(addSettingsItemToSection(VALENCED_SECTION, AUTO_CORRECT_TOGGLE_KEY))
				removers.push(addSettingsItemToSection(VALENCED_SECTION, SETTINGS_ITEM_KEY))
				placed = true
			} catch {
				placed = false
			}

			if (!placed) {
				// Fallback: give Redpen its own section rather than losing the controls.
				removers.push(
					registerSettingsSection(SETTINGS_SECTION_KEY, {
						label: 'Redpen',
						settings: [
							PREVIEW_TOGGLE_KEY,
							DOCK_TOGGLE_KEY,
							AUTO_CORRECT_TOGGLE_KEY,
							SETTINGS_ITEM_KEY,
						],
					}),
				)
			}

			refreshSettings()
		}),
	)
}

/** Read-only corrector version shown in the settings screen. */
export const correctorVersionLabel = `Corrector ${CORRECTOR_VERSION}`
