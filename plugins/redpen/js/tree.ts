import { cloneElement, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'

/** An element with unknown props. */
export type AnyElement = ReactElement<Record<string, unknown>>

/** Rows nest shallowly; the cap keeps a pathological tree from stalling a render. */
const MAX_DEPTH = 24

export function isElement(node: ReactNode): node is AnyElement {
	return isValidElement(node)
}

/**
 * Depth-first walk over an element tree. Children are visited in order and the walk
 * never mutates the tree — callers must clone if they need to change anything.
 */
export function walkElements(
	tree: ReactNode,
	visit: (element: AnyElement) => void,
	depth = 0,
): void {
	if (depth > MAX_DEPTH) return

	if (Array.isArray(tree)) {
		for (const child of tree) walkElements(child as ReactNode, visit, depth)
		return
	}

	if (!isElement(tree)) return

	visit(tree)

	const children = (tree.props as { children?: ReactNode }).children
	if (children === undefined || children === null) return
	walkElements(children, visit, depth + 1)
}

/** First element matching `predicate`, or `undefined`. */
export function findElement<P>(
	tree: ReactNode,
	predicate: (element: AnyElement) => boolean,
): ReactElement<P> | undefined {
	if (Array.isArray(tree)) {
		for (const child of tree) {
			const found = findElement<P>(child as ReactNode, predicate)
			if (found) return found
		}
		return undefined
	}

	if (!isElement(tree)) return undefined
	if (predicate(tree)) return tree as unknown as ReactElement<P>

	const children = (tree.props as { children?: ReactNode }).children
	if (children === undefined || children === null) return undefined
	return findElement<P>(children, predicate)
}

/** Props of an element, or an empty object. */
export function propsOf(element: AnyElement): Record<string, unknown> {
	return element.props as Record<string, unknown>
}

/**
 * Replaces every element matching `predicate` with `mapper`'s output.
 *
 * Matched elements are not descended into, so a single pass can never wrap the same
 * node twice. Untouched subtrees are returned by identity, so unchanged branches keep
 * their referential equality.
 */
export function mapElements(
	tree: ReactNode,
	predicate: (element: AnyElement) => boolean,
	mapper: (element: AnyElement) => ReactNode,
): ReactNode {
	if (Array.isArray(tree)) {
		let changed = false
		const next = tree.map(child => {
			const mapped = mapElements(child as ReactNode, predicate, mapper)
			if (mapped !== child) changed = true
			return mapped
		})
		return changed ? next : tree
	}

	if (!isElement(tree)) return tree
	if (predicate(tree)) return mapper(tree)

	const props = tree.props as { children?: ReactNode }
	const children = props.children
	if (children === undefined || children === null) return tree

	const mappedChildren = mapElements(children, predicate, mapper)
	if (mappedChildren === children) return tree

	return cloneElement(tree as AnyElement, { children: mappedChildren })
}
