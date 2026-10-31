import { Design, FormSwitch } from '@valenced/discord/design'
import Page from '@valenced/components/Page'
import { ScrollView, View, StyleSheet } from 'react-native'
import { correctorVersionLabel, useRedpenSettings, writeRedpenSettings } from '../settings'
import { describeSidebarInjection } from '../sidebar'
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
							label="Sidebar injection"
							trailing={
								<Text variant="text-sm/medium" color="text-muted">
									{describeSidebarInjection()}
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
