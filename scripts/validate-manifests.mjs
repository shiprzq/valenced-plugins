#!/usr/bin/env node
/**
 * Validates every `plugins/<dir>/manifest.json` against the rules the Valenced loader
 * enforces when it installs an external plugin, plus the repository-specific rules this
 * project relies on.
 *
 * Usage:
 *   node scripts/validate-manifests.mjs                       # validate every plugin
 *   node scripts/validate-manifests.mjs --version 1.0.0       # also require this version
 *   node scripts/validate-manifests.mjs redpen                # validate one plugin
 *
 * Exit codes: 0 all good (warnings allowed), 1 one or more errors.
 *
 * Zero dependencies. Reused by `build-index.mjs` so a manifest can never be indexed
 * without passing the same gate.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isValidVersion, parseVersion } from './lib/semver.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = join(ROOT, 'plugins')

const MANIFEST_FORMAT = 1
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9.-]+$/
/** Dependencies the loader requires on every external plugin. */
const RESERVED_DEPENDENCY_IDS = ['valenced.api', 'discord']
const RANGE_OPERATORS = ['>=', '<=', '==', '=', '>', '<']

/**
 * @typedef {{ plugin: string, field: string, message: string }} Problem
 */

/**
 * Validates one parsed manifest.
 *
 * @param {unknown} manifest
 * @param {{ dir?: string, expectedVersion?: string }} [options]
 * @returns {{ errors: Problem[], warnings: Problem[] }}
 */
export function validateManifest(manifest, options = {}) {
	const errors = []
	const warnings = []
	const plugin = options.dir ?? '(unknown)'

	/** @param {string} field @param {string} message */
	const fail = (field, message) => errors.push({ plugin, field, message })
	/** @param {string} field @param {string} message */
	const warn = (field, message) => warnings.push({ plugin, field, message })

	if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
		fail('manifest', 'must be a JSON object')
		return { errors, warnings }
	}

	// format -----------------------------------------------------------------
	if (manifest.format !== MANIFEST_FORMAT) {
		fail('format', `must be the number ${MANIFEST_FORMAT}, got ${JSON.stringify(manifest.format)}`)
	}

	// id ---------------------------------------------------------------------
	const id = manifest.id
	if (typeof id !== 'string' || id.length === 0) {
		fail('id', 'must be a non-empty string')
	} else if (!PLUGIN_ID_PATTERN.test(id)) {
		fail('id', `must match ${PLUGIN_ID_PATTERN}, got '${id}'`)
	} else if (id.includes('..')) {
		fail('id', `must not contain '..', got '${id}'`)
	} else if (id.startsWith('.')) {
		fail('id', `must not start with '.', got '${id}'`)
	}

	// name / description / author -------------------------------------------
	if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
		fail('name', 'must be a non-empty string')
	}
	if (typeof manifest.description !== 'string' || manifest.description.trim().length === 0) {
		fail('description', 'must be a non-empty string')
	}
	if (manifest.author !== undefined && typeof manifest.author !== 'string') {
		fail('author', 'must be a string when present')
	} else if (typeof manifest.author === 'string' && manifest.author.trim().length === 0) {
		warn('author', 'is empty; the repository index will show no author')
	}

	// version ----------------------------------------------------------------
	if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
		fail('version', 'must be a non-empty string')
	} else if (!isValidVersion(manifest.version)) {
		fail('version', `must match <n>[.<n>]*(-<label>)? with a [a-z0-9]+ label, got '${manifest.version}'`)
	} else if (
		options.expectedVersion !== undefined &&
		compareParsed(manifest.version, options.expectedVersion) !== 0
	) {
		fail(
			'version',
			`is '${manifest.version}' but the release tag says '${options.expectedVersion}'; bump the manifest or the tag`,
		)
	}

	// dist -------------------------------------------------------------------
	const dist = manifest.dist
	if (dist === null || typeof dist !== 'object' || Array.isArray(dist)) {
		fail('dist', 'must be an object with a `script` string for JS plugins')
	} else {
		if (typeof dist.script !== 'string' || dist.script.trim().length === 0) {
			fail('dist.script', 'must be a non-empty string (the bundle path inside the ZIP)')
		} else if (dist.script.startsWith('/') || dist.script.split('/').includes('..')) {
			fail('dist.script', `must be a relative path inside the ZIP, got '${dist.script}'`)
		}
		if (dist.android !== undefined) {
			const android = dist.android
			if (android === null || typeof android !== 'object') {
				fail('dist.android', 'must be an object when present')
			} else {
				if (typeof android.path !== 'string' || android.path.trim().length === 0) {
					fail('dist.android.path', 'must be a non-empty string')
				}
				if (typeof android.class !== 'string' || android.class.trim().length === 0) {
					fail('dist.android.class', 'must be a non-empty string')
				}
			}
		}
	}

	// dependencies -----------------------------------------------------------
	const dependencies = manifest.dependencies
	if (dependencies === undefined) {
		fail('dependencies', `must declare ${RESERVED_DEPENDENCY_IDS.map(id => `'${id}'`).join(' and ')}`)
	} else if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
		fail('dependencies', 'must be an object keyed by plugin id')
	} else {
		for (const reservedId of RESERVED_DEPENDENCY_IDS) {
			if (!(reservedId in dependencies)) {
				fail('dependencies', `is missing the mandatory '${reservedId}' dependency`)
			}
		}

		for (const [dependencyId, constraint] of Object.entries(dependencies)) {
			const field = `dependencies['${dependencyId}']`
			if (typeof dependencyId !== 'string' || !PLUGIN_ID_PATTERN.test(dependencyId)) {
				fail(field, `invalid dependency id '${dependencyId}'`)
				continue
			}
			if (constraint === null || typeof constraint !== 'object' || Array.isArray(constraint)) {
				fail(field, 'must be an object such as { "version": ">=1 <2" }')
				continue
			}
			if (constraint.version !== undefined) {
				if (typeof constraint.version !== 'string') {
					fail(`${field}.version`, 'must be a string range')
				} else if (!isValidRange(constraint.version)) {
					fail(`${field}.version`, `invalid version range '${constraint.version}'`)
				}
			}
			if (constraint.optional !== undefined && typeof constraint.optional !== 'boolean') {
				fail(`${field}.optional`, 'must be a boolean')
			}
			if (constraint.optional === true && RESERVED_DEPENDENCY_IDS.includes(dependencyId)) {
				fail(`${field}.optional`, `'${dependencyId}' cannot be optional`)
			}
			for (const unknownKey of Object.keys(constraint)) {
				if (unknownKey !== 'version' && unknownKey !== 'optional') {
					warn(`${field}.${unknownKey}`, 'is not part of the manifest schema and will be ignored')
				}
			}
		}
	}

	return { errors, warnings }
}

/** `*` or whitespace-separated operator tokens with unlabeled versions. */
export function isValidRange(range) {
	const value = range.trim()
	if (value === '*') return true
	if (value.length === 0) return false

	return value.split(/\s+/).every(token => {
		const operator = RANGE_OPERATORS.find(candidate => token.startsWith(candidate))
		if (!operator) return false
		const bound = token.slice(operator.length)
		if (!isValidVersion(bound)) return false
		return parseVersion(bound).label === null
	})
}

/** `--version` and `RELEASE_VERSION` may be a tag (`v1.2.3`) or a bare version. */
function stripTagPrefix(value) {
	return value.replace(/^v(?=\d)/, '')
}

function compareParsed(a, b) {
	const left = parseVersion(a).nums
	const right = parseVersion(b).nums
	const length = Math.max(left.length, right.length)
	for (let index = 0; index < length; index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0)
		if (diff !== 0) return diff
	}
	return 0
}

/**
 * Reads and validates every `plugins/<dir>/manifest.json`.
 *
 * @param {{ version?: string, only?: string[] }} [options]
 */
export async function validateAll(options = {}) {
	const entries = await readdir(PLUGINS_DIR, { withFileTypes: true })
	const pluginDirs = entries
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort()

	if (pluginDirs.length === 0) {
		return { errors: [], warnings: [], plugins: [], missingDirs: [] }
	}

	const errors = []
	const warnings = []
	const plugins = []
	const missingDirs = []

	for (const dir of pluginDirs) {
		if (options.only && options.only.length > 0 && !options.only.includes(dir)) continue

		const manifestPath = join(PLUGINS_DIR, dir, 'manifest.json')
		let manifest
		try {
			await stat(manifestPath)
		} catch {
			missingDirs.push(manifestPath)
			continue
		}

		try {
			manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
		} catch (error) {
			errors.push({
				plugin: dir,
				field: 'manifest',
				message: `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			})
			continue
		}

		const result = validateManifest(manifest, {
			dir,
			expectedVersion: options.version,
		})
		errors.push(...result.errors)
		warnings.push(...result.warnings)

		if (result.errors.length === 0) {
			plugins.push({ dir, id: manifest.id, manifest, manifestPath })
		}
	}

	return { errors, warnings, plugins, missingDirs }
}

async function main(argv) {
	const args = argv.slice(2)
	let version = stripTagPrefix(process.env.RELEASE_VERSION?.trim() ?? '') || undefined
	const only = []

	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === '--version') {
			version = stripTagPrefix(args[++index] ?? '')
		} else if (arg === '--help' || arg === '-h') {
			process.stdout.write(
				'Usage: node scripts/validate-manifests.mjs [--version <v>] [plugin-dir...]\n',
			)
			return 0
		} else {
			only.push(arg)
		}
	}

	const { errors, warnings, plugins, missingDirs } = await validateAll({
		version,
		only: only.length > 0 ? only : undefined,
	})

	if (warnings.length > 0) {
		process.stdout.write(`Warnings:\n${warnings
			.map(problem => `  - plugins/${problem.plugin}: ${problem.field}: ${problem.message}`)
			.join('\n')}\n`)
	}

	if (missingDirs.length > 0) {
		process.stderr.write(
			`Error: plugin directories without a manifest.json:\n${missingDirs
				.map(dir => `  - ${dir}`)
				.join('\n')}\n`,
		)
		return 1
	}

	if (errors.length > 0) {
		process.stderr.write(
			`Error: ${errors.length} manifest problem(s) found:\n${errors
				.map(problem => `  - plugins/${problem.plugin}: ${problem.field}: ${problem.message}`)
				.join('\n')}\n`,
		)
		return 1
	}

	if (plugins.length === 0) {
		process.stdout.write('No plugins to validate.\n')
		return 0
	}

	process.stdout.write(
		`Validated ${plugins.length} manifest(s): ${plugins
			.map(plugin => `${plugin.id}@${plugin.manifest.version}`)
			.join(', ')}\n`,
	)
	return 0
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
	main(process.argv)
		.then(code => {
			process.exitCode = code
		})
		.catch(error => {
			process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
			process.exitCode = 1
		})
}
