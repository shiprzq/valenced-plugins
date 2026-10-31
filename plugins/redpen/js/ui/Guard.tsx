import { Component, type ReactNode } from 'react'

export interface GuardProps {
	/** Provided by `createElement` as a child, so it is optional in the props type. */
	children?: ReactNode
	onError?: (error: unknown) => void | Promise<void>
}

interface GuardState {
	failed: boolean
}

/**
 * Error boundary around every injected subtree.
 *
 * Redpen adds its own views to Discord's element trees. If one of them ever throws, the
 * failure must stop at the button: an uncaught render error would otherwise replace the
 * screen — or the whole app — with a crash. On the first error the subtree renders nothing
 * and the error is reported once.
 */
export default class Guard extends Component<GuardProps, GuardState> {
	state: GuardState = { failed: false }

	static getDerivedStateFromError(): GuardState {
		return { failed: true }
	}

	componentDidCatch(error: unknown): void {
		try {
			this.props.onError?.(error)
		} catch {
			// Reporting must never throw out of the boundary.
		}
	}

	render(): ReactNode {
		if (this.state.failed) return null
		return this.props.children
	}
}
