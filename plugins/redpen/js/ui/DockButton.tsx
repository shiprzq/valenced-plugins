import { Design } from '@valenced/discord/design'
import { Pressable, StyleSheet } from 'react-native'
import type { GestureResponderEvent } from 'react-native'
import { useCallback, useSyncExternalStore } from 'react'
import { isChannelOpen, openRedpen, subscribeToOpenState } from '../state'
import type { ChannelLike } from '../types'

export interface DockButtonProps {
	channelId: string
	channelName: string
}

/**
 * The Redpen button that sits in the message dock, next to the gift, emoji and
 * microphone buttons.
 *
 * Sized like Discord's own dock icons (32×32 hit box, 24×24 visual), muted until pressed,
 * and dimmed while a Redpen surface for the channel is already open. It never submits,
 * never focuses the composer and never touches the draft.
 */
export default function DockButton({ channelId, channelName }: DockButtonProps) {
	const isOpen = useSyncExternalStore(
		subscribeToOpenState,
		() => isChannelOpen(channelId),
		() => false,
	)

	const onPress = useCallback(
		(event?: GestureResponderEvent) => {
			event?.stopPropagation?.()
			if (isChannelOpen(channelId)) return

			const channel: ChannelLike = { id: channelId, name: channelName }
			openRedpen(channel)
		},
		[channelId, channelName],
	)

	const onPressIn = useCallback((event: GestureResponderEvent) => {
		event?.stopPropagation?.()
	}, [])

	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={`Redpen: clean up a message in ${channelName}`}
			accessibilityState={{ disabled: isOpen }}
			android_ripple={null}
			disabled={isOpen}
			hitSlop={6}
			onPress={onPress}
			onPressIn={onPressIn}
			style={[styles.button, isOpen ? styles.disabled : null]}
		>
			<Design.Text variant="text-sm/medium" color="text-muted" style={styles.glyph}>
				Aa
			</Design.Text>
		</Pressable>
	)
}

const styles = StyleSheet.create({
	button: {
		width: 32,
		height: 32,
		alignItems: 'center',
		justifyContent: 'center',
		opacity: 0.85,
	},
	disabled: {
		opacity: 0.3,
	},
	glyph: {
		fontSize: 15,
		lineHeight: 18,
		fontWeight: '600',
	},
})
