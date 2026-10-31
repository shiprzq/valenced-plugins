import { Design } from '@valenced/discord/design'
import { Pressable, StyleSheet } from 'react-native'
import type { GestureResponderEvent } from 'react-native'
import { useCallback, useSyncExternalStore } from 'react'
import { isChannelOpen, openRedpen, subscribeToOpenState } from '../state'
import type { ChannelLike } from '../types'

export interface SidebarButtonProps {
	channelId: string
	channelName: string
}

/**
 * The per-channel Redpen button injected into a channel list row.
 *
 * - 20px box, `opacity: 0.6`, `hitSlop` 8, fixed width so the row keeps its height
 *   and `FlashList` measurement stays intact.
 * - Its own `Pressable`; both `onPressIn` and `onPress` stop propagation so tapping the
 *   button never navigates. Tapping anywhere else on the row still navigates.
 * - Disabled (and dimmed) while a Redpen surface for the channel is open.
 */
export default function SidebarButton({ channelId, channelName }: SidebarButtonProps) {
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
			accessibilityLabel={`Redpen: clean up a message for ${channelName}`}
			accessibilityState={{ disabled: isOpen }}
			android_ripple={null}
			disabled={isOpen}
			hitSlop={8}
			onPress={onPress}
			onPressIn={onPressIn}
			style={[styles.button, isOpen ? styles.disabled : null]}
		>
			<Design.Text variant="text-sm/medium" color="text-muted" style={styles.glyph}>
				✎
			</Design.Text>
		</Pressable>
	)
}

const styles = StyleSheet.create({
	button: {
		width: 20,
		height: 20,
		marginRight: 4,
		alignItems: 'center',
		justifyContent: 'center',
		opacity: 0.6,
	},
	disabled: {
		opacity: 0.25,
	},
	glyph: {
		fontSize: 14,
		lineHeight: 18,
	},
})
