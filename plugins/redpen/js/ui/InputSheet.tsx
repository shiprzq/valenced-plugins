import { ActionSheetActionCreators, ToastActionCreators } from '@valenced/discord/actions'
import { Design } from '@valenced/discord/design'
import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native'
import { correct } from '../corrector'
import { correctorOptions } from '../settings'
import { sendToChannel } from '../send'
import { readRedpenSettings } from '../settings'
import {
	isSurfaceMounted,
	markSurfaceClosed,
	markSurfaceMounted,
	markSurfaceStep,
} from '../state'
import { INPUT_SHEET_KEY, PREVIEW_SHEET_KEY, type CorrectionChange } from '../types'
import PreviewSheet from './PreviewSheet'

export interface InputSheetProps {
	channelId: string
	channelName: string
}

/** Discord's maximum message length. */
const MAX_LENGTH = 2000

/**
 * The text-entry surface, scoped to one channel.
 *
 * Presented through Discord's action sheet layer (`openLazy`), so it inherits the
 * client's backdrop, drag gestures, back handling and keyboard layer.
 */
export default function InputSheet({ channelId, channelName }: InputSheetProps) {
	const [draft, setDraft] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	/** Set while handing the surface over to the preview sheet. */
	const handoff = useRef(false)

	useEffect(() => {
		// Step first: changing step clears the mounted flag for the handoff watchdog.
		markSurfaceStep(channelId, 'input')
		markSurfaceMounted()
		return () => {
			if (!handoff.current) markSurfaceClosed()
		}
	}, [channelId])

	const close = useCallback(() => {
		ActionSheetActionCreators.hideActionSheet(INPUT_SHEET_KEY)
		markSurfaceClosed()
	}, [])

	const dismiss = useCallback(() => {
		if (handoff.current) return
		markSurfaceClosed()
	}, [])

	const openPreview = useCallback(
		(corrected: string, changes: CorrectionChange[]) => {
			handoff.current = true
			markSurfaceStep(channelId, 'preview')
			ActionSheetActionCreators.hideActionSheet(INPUT_SHEET_KEY)

			ActionSheetActionCreators.openLazy(
				Promise.resolve({ default: PreviewSheet }),
				PREVIEW_SHEET_KEY,
				{ channelId, channelName, corrected, changes },
				'replaceTopSheet',
			)

			// If the preview never mounts, release the surface instead of locking the row.
			setTimeout(() => {
				if (!isSurfaceMounted()) markSurfaceClosed()
			}, 2500)
		},
		[channelId, channelName],
	)

	const send = useCallback(
		async (content: string) => {
			setBusy(true)
			setError(null)

			try {
				await sendToChannel(channelId, content)
				ToastActionCreators.open('REDPEN_SENT', {
					text: 'Sent.',
					variant: 'success',
					duration: 2000,
				})
				close()
			} catch (sendError) {
				// The text stays in state; the sheet never drops it.
				setError(sendError instanceof Error ? sendError.message : String(sendError))
			} finally {
				setBusy(false)
			}
		},
		[channelId, close],
	)

	const onCleanAndSend = useCallback(() => {
		if (!draft.trim() || busy) return

		// Read settings at action time so toggles apply to the next send, no reload.
		const settings = readRedpenSettings()
		const result = correct(draft, correctorOptions())

		if (settings.previewMode) {
			openPreview(result.corrected, result.changes)
			return
		}

		void send(result.corrected)
	}, [busy, draft, openPreview, send])

	const canSend = draft.trim().length > 0 && !busy

	return (
		<Design.ActionSheet
			onDismiss={dismiss}
			startExpanded
			scrollable
			header={<Design.BottomSheetTitleHeader title="Redpen" subtitle={channelName} />}
		>
			<KeyboardAvoidingView
				behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
				keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
			>
				<Design.Stack spacing={12}>
					<View style={styles.inputWell}>
						<TextInput
							autoFocus
							multiline
							maxLength={MAX_LENGTH}
							onChangeText={setDraft}
							placeholder="Type your text…"
							placeholderTextColor="rgba(255, 255, 255, 0.45)"
							style={styles.input}
							textAlignVertical="top"
							value={draft}
						/>
					</View>

					<View style={styles.metaRow}>
						<Design.Text variant="text-xs/medium" color="text-muted">
							{draft.length}/{MAX_LENGTH}
						</Design.Text>
						<Design.Text variant="text-xs/medium" color="text-muted">
							{error ? 'Not sent' : 'Runs locally, no network'}
						</Design.Text>
					</View>

					{error ? (
						<View style={styles.errorBox}>
							<Design.Text variant="text-sm/medium" color="text-feedback-critical">
								{error}
							</Design.Text>
							<Design.Button
								text="Retry"
								size="sm"
								variant="secondary"
								onPress={() => void send(draft)}
								style={styles.fixedButton}
							/>
						</View>
					) : null}

					<Design.Stack direction="horizontal" spacing={8}>
						<Design.Button
							text="Cancel"
							variant="secondary"
							onPress={close}
							style={styles.fixedButton}
						/>
						<Design.Button
							text="Clean & Send"
							variant="primary"
							disabled={!canSend}
							loading={busy}
							grow
							onPress={onCleanAndSend}
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
		maxHeight: 180,
		minHeight: 88,
		padding: 0,
	},
	metaRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
	},
	errorBox: {
		alignItems: 'flex-start',
		gap: 8,
	},
	fixedButton: {
		width: 'auto',
	},
})
