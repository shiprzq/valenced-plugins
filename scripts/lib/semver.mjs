/**
 * Valenced version handling, ported from the loader's own implementation so CI orders
 * versions exactly the way the client does.
 *
 * Scheme: `<n>[.<n>]*(-<label>)?`
 * - numeric segments: non-negative integers, `1.2` == `1.2.0`
 * - label: `[a-z0-9]+`, every labelled version is a prerelease (`1.0.0` > `1.0.0-rc`)
 * - label ordering: alternating non-digit/digit runs; non-digit runs compare
 *   byte-lexically, digit runs numerically (`beta2` < `beta10`)
 *
 * Reference: `core/src/commonMain/kotlin/app/valenced/plugins/Version.kt`.
 */

const VERSION_PATTERN = /^(\d+(?:\.\d+)*)(?:-([a-z0-9]+))?$/

/**
 * @param {string} value
 * @returns {{ nums: number[], label: string | null, raw: string }}
 */
export function parseVersion(value) {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error('Version string must not be empty')
	}

	const match = VERSION_PATTERN.exec(value)
	if (!match) {
		throw new Error(
			`Invalid version '${value}': expected <n>[.<n>]*(-<label>)? with a [a-z0-9]+ label`,
		)
	}

	const nums = match[1].split('.').map(segment => Number.parseInt(segment, 10))
	if (nums.some(number => !Number.isInteger(number) || number < 0)) {
		throw new Error(`Invalid version '${value}': segments must be non-negative integers`)
	}

	return { nums, label: match[2] ?? null, raw: value }
}

/** True for a string the loader accepts as a version. */
export function isValidVersion(value) {
	try {
		parseVersion(value)
		return true
	} catch {
		return false
	}
}

/**
 * Compares two versions.
 *
 * @returns {number} negative when `a < b`, `0` when equal, positive when `a > b`.
 */
export function compareVersions(a, b) {
	const left = typeof a === 'string' ? parseVersion(a) : a
	const right = typeof b === 'string' ? parseVersion(b) : b

	const length = Math.max(left.nums.length, right.nums.length)
	for (let index = 0; index < length; index++) {
		const l = left.nums[index] ?? 0
		const r = right.nums[index] ?? 0
		if (l !== r) return l - r
	}

	if (left.label === null && right.label === null) return 0
	if (left.label === null) return 1
	if (right.label === null) return -1

	return compareLabels(left.label, right.label)
}

/** True when the version is a labelled (pre)release. */
export function isPrerelease(value) {
	return (typeof value === 'string' ? parseVersion(value) : value).label !== null
}

function compareLabels(a, b) {
	const left = splitRuns(a)
	const right = splitRuns(b)
	const length = Math.min(left.length, right.length)

	for (let index = 0; index < length; index++) {
		const l = left[index]
		const r = right[index]
		if (l === r) continue

		const lIsDigit = /^\d+$/.test(l)
		const rIsDigit = /^\d+$/.test(r)

		if (lIsDigit && rIsDigit) {
			const diff = Number.parseInt(l, 10) - Number.parseInt(r, 10)
			if (diff !== 0) return diff
			continue
		}

		return l < r ? -1 : 1
	}

	return left.length - right.length
}

function splitRuns(value) {
	return value.match(/\d+|\D+/g) ?? []
}

/** Highest version of a list, or `undefined` for an empty list. */
export function highestVersion(versions) {
	let best
	for (const version of versions) {
		if (best === undefined || compareVersions(version, best) > 0) best = version
	}
	return best
}
