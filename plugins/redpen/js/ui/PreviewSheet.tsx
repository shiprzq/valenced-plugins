import { ActionSheetActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	BackHandler,
	KeyboardAvoidingView,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	TextInput,
	View,
} from 'react-native'
import { sendToChannel } from '../send'
import { markSurfaceClosed, markSurfaceMounted, markSurfaceStep } from '../state'
import { PREVIEW_SHEET_KEY, type CorrectionChange } from '../types'

export interface PreviewSheetProps {
	channelId: string
	channelName: string
	corrected: string
	changes: CorrectionChange[]
}

const MAX_LENGTH = 2000
/** Keep the expanded change list from crowding out the buttons. */
const MAX_LISTED_CHANGES = 25

/**
 * The preview/approve surface.
 *
 * Dismissal — back gesture, hardware back, backdrop tap, drag down — is always a
 * Decline. Sending only ever happens from the Send button.
 */
export default function PreviewSheet({
	channelId,
	channelName,
	corrected,
	changes,
}: PreviewSheetProps) {
	const [text, setText] = useState(corrected)
	const [expanded, setExpanded] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	/** Guards against handling a dismissal that follows a programmatic close. */
	const settled = useRef(false)

	useEffect(() => {
		// Step first: changing step clears the mounted flag for the handoff watchdog.
		markSurfaceStep(channelId, 'preview')
		markSurfaceMounted()
		return () => {
			if (!settled.current) markSurfaceClosed()
		}
	}, [channelId])

	const decline = useCallback(() => {
		if (settled.current) return
		settled.current = true
		ActionSheetActionCreators.hideActionSheet(PREVIEW_SHEET_KEY)
		markSurfaceClosed()
	}, [])

	// Hardware back on Android is a Decline, never a send.
	useEffect(() => {
		const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
			if (settled.current) return false
			decline()
			return true
		})
		return () => subscription.remove()
	}, [decline])

	const send = useCallback(async () => {
		if (busy) return
		if (!text.trim()) return

		setBusy(true)
		setError(null)

		try {
			await sendToChannel(channelId, text)
			settled.current = true
			ActionSheetActionCreators.hideActionSheet(PREVIEW_SHEET_KEY)
			ToastActionCreators.open('REDPEN_SENT', {
				text: 'Sent.',
				variant: 'success',
				duration: 2000,
			})
			markSurfaceClosed()
		} catch (sendError) {
			setError(sendError instanceof Error ? sendError.message : String(sendError))
		} finally {
			setBusy(false)
		}
	}, [busy, channelId, text])

	const summary =
		changes.length === 0
			? 'Nothing to fix.'
			: `${changes.length} ${changes.length === 1 ? 'change' : 'changes'}`

	return (
		<Design.ActionSheet
			onDismiss={decline}
			startExpanded
			scrollable
			header={<Design.BottomSheetTitleHeader title="Preview" subtitle={channelName} />}
		>
			<KeyboardAvoidingView
				behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
				keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
			>
				<Design.Stack spacing={12}>
					<View style={styles.inputWell}>
						<TextInput
							multiline
							maxLength={MAX_LENGTH}
							onChangeText={setText}
							placeholder="Type your text…"
							placeholderTextColor="rgba(255, 255, 255, 0.45)"
							style={styles.input}
							textAlignVertical="top"
							value={text}
						/>
					</View>

					<Pressable
						accessibilityRole="button"
						disabled={changes.length === 0}
						onPress={() => setExpanded(value => !value)}
						style={styles.summaryRow}
					>
						<Design.Text variant="text-xs/medium" color="text-muted">
							{summary}
							{changes.length > 0 ? (expanded ? '  ▾' : '  ▸') : ''}
						</Design.Text>
						<Design.Text variant="text-xs/medium" color="text-muted">
							{text.length}/{MAX_LENGTH}
						</Design.Text>
					</Pressable>

					{expanded && changes.length > 0 ? (
						<ScrollView style={styles.changeList} nestedScrollEnabled>
							{changes.slice(0, MAX_LISTED_CHANGES).map((change, index) => (
								<Design.Text
									key={`${change.rule}-${index}`}
									variant="text-xs/medium"
									color="text-muted"
									style={styles.changeRow}
								>
									{`${change.from} → ${change.to}`}
								</Design.Text>
							))}
							{changes.length > MAX_LISTED_CHANGES ? (
								<Design.Text variant="text-xs/medium" color="text-muted">
									{`…and ${changes.length - MAX_LISTED_CHANGES} more`}
								</Design.Text>
							) : null}
						</ScrollView>
					) : null}

					{error ? (
						<View style={styles.errorBox}>
							<Design.Text variant="text-sm/medium" color="text-feedback-critical">
								{error}
							</Design.Text>
							<Design.Button
								text="Retry"
								size="sm"
								variant="secondary"
								onPress={() => void send()}
								style={styles.fixedButton}
							/>
						</View>
					) : null}

					<Design.Stack direction="horizontal" spacing={8}>
						<Design.Button
							text="Decline"
							variant="secondary"
							onPress={decline}
							style={styles.fixedButton}
						/>
						<Design.Button
							text="Send"
							variant="primary"
							disabled={busy || !text.trim()}
							loading={busy}
							grow
							onPress={() => void send()}
						/>
					</Design.Stack>
				</Design.Stack>
			</KeyboardAvoidingView>
		</Design.ActionSheet>
	)
}

const styles = StyleSheet.create({
	inputWell: {
		backgroundColor: 'rgba(0, 0, 0, 0.35)',
		borderRadius: 8,
		paddingHorizontal: 12,
		paddingVertical: 10,
	},
	input: {
		color: '#ffffff',
		fontSize: 16,
		lineHeight: 22,
		maxHeight: 160,
		minHeight: 72,
		padding: 0,
	},
	summaryRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
	},
	changeList: {
		maxHeight: 140,
	},
	changeRow: {
		paddingVertical: 2,
	},
	errorBox: {
		alignItems: 'flex-start',
		gap: 8,
	},
	fixedButton: {
		width: 'auto',
	},
})
