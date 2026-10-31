import { Design, FormSwitch } from '@valenced/discord/design'
import Page from '@valenced/components/Page'
import { ScrollView, View, StyleSheet } from 'react-native'
import { RULE_LABELS } from '../corrector'
import { correctorVersionLabel, useRedpenSettings, writeRedpenSettings } from '../settings'
import { describeInjection, describeInjectionSamples } from '../inject'
import { describeSendAction } from '../send'
import type { RedpenApi } from '../types'

export interface SettingsScreenProps {
	api: RedpenApi
}

const { Stack, TableRow, TableRowGroup, Text } = Design

/**
 * Redpen's plugin settings page.
 *
 * Reads through `useRedpenSettings()` (backed by `api.jsonStorage.use()`), so the
 * switches re-render as soon as storage changes and every change applies on the next
 * send without a reload.
 */
export default function SettingsScreen(_props: SettingsScreenProps) {
	const settings = useRedpenSettings()

	return (
		<Page>
			<ScrollView>
				<Stack spacing={24}>
					<TableRowGroup title="Buttons">
						<TableRow
							label="Show the button in the message dock"
							trailing={
								<FormSwitch
									value={settings.showDockButton}
									onValueChange={(value: boolean) => {
										void writeRedpenSettings({ showDockButton: value })
									}}
								/>
							}
							subLabel={
								<Text variant="text-xs/medium" color="text-muted">
									Next to the gift, emoji and microphone buttons in the chat bar.
								</Text>
							}
						/>
					</TableRowGroup>

					<TableRowGroup title="Sending">
						<TableRow
							label="Show preview before sending"
							trailing={
								<FormSwitch
									value={settings.previewMode}
									onValueChange={(value: boolean) => {
										void writeRedpenSettings({ previewMode: value })
									}}
								/>
							}
							subLabel={
								<Text variant="text-xs/medium" color="text-muted">
									Turn off to send corrected messages automatically.
								</Text>
							}
						/>
						<TableRow
							label="Show the Redpen button in the channel list"
							trailing={
								<FormSwitch
									value={settings.showSidebarButton}
									onValueChange={(value: boolean) => {
										void writeRedpenSettings({ showSidebarButton: value })
									}}
								/>
							}
							subLabel={
								<Text variant="text-xs/medium" color="text-muted">
									Adds a small button to every text channel, DM and thread row.
								</Text>
							}
						/>
					</TableRowGroup>

					<TableRowGroup title="Corrections">
						<TableRow
							label="Correct messages as you send them"
							trailing={
								<FormSwitch
									value={settings.autoCorrectOutgoing}
									onValueChange={(value: boolean) => {
										void writeRedpenSettings({ autoCorrectOutgoing: value })
									}}
								/>
							}
							subLabel={
								<Text variant="text-xs/medium" color="text-muted">
									Fixes the text of every message you send, even without opening Redpen.
								</Text>
							}
						/>
					</TableRowGroup>

					<TableRowGroup title="Rules">
						{RULE_LABELS.map(rule => (
							<TableRow
								key={rule.id}
								label={rule.label}
								trailing={
									<FormSwitch
										value={!settings.disabledRules.includes(rule.id)}
										onValueChange={(enabled: boolean) => {
											const next = new Set(settings.disabledRules)
											if (enabled) next.delete(rule.id)
											else next.add(rule.id)
											void writeRedpenSettings({ disabledRules: [...next] })
										}}
									/>
								}
								subLabel={
									<Text variant="text-xs/medium" color="text-muted">
										{rule.description}
									</Text>
								}
							/>
						))}
					</TableRowGroup>

					<TableRowGroup title="Reset">
						<TableRow
							label="Reset corrections"
							arrow
							onPress={resetCorrections}
							subLabel={
								<Text variant="text-xs/medium" color="text-muted">
									Clears the user dictionary. Built-in rules are never changed.
								</Text>
							}
						/>
						<TableRow
							label="Corrector version"
							trailing={
								<Text variant="text-sm/medium" color="text-muted">
									{correctorVersionLabel}
								</Text>
							}
						/>
					</TableRowGroup>

					<TableRowGroup title="Diagnostics">
						<TableRow
							label="UI injection"
							trailing={
								<Text variant="text-sm/medium" color="text-muted">
									{describeInjection()}
								</Text>
							}
							subLabel={
								<Text variant="text-xs/medium" color="text-muted">
									Dock button and channel-row buttons, matched structurally.
								</Text>
							}
						/>
						<TableRow
							label="Elements matched"
							trailing={
								<Text variant="text-xs/medium" color="text-muted">
									{describeInjectionSamples()}
								</Text>
							}
						/>
						<TableRow
							label="Send action"
							trailing={
								<Text variant="text-sm/medium" color="text-muted">
									{describeSendAction()}
								</Text>
							}
						/>
					</TableRowGroup>

					<View style={styles.footer}>
						<Text variant="text-xs/medium" color="text-muted">
							Redpen corrects locally. Nothing is uploaded, and nothing is sent until you
							approve it unless preview is turned off.
						</Text>
					</View>
				</Stack>
			</ScrollView>
		</Page>
	)
}

function resetCorrections(): void {
	void writeRedpenSettings({ userDictionary: {} })
}

const styles = StyleSheet.create({
	footer: {
		paddingHorizontal: 16,
	},
})
