#!/usr/bin/env node
/**
 * Generates `index.json` for the Valenced repository from GitHub Release assets.
 *
 *   index.json  (deployed artifact)  ->  https://<OWNER>.github.io/<REPO>/index.json
 *
 * What it does:
 * 1. Lists every release of the current repository (REST API, paginated).
 * 2. Maps `<plugin-id>.zip` release assets onto `plugins/<dir>/manifest.json`.
 * 3. Downloads each asset, verifies its SHA-256 and CRC, and proves the ZIP's internal
 *    `manifest.json` is byte-identical to the checked-in one and that the version matches
 *    the release tag.
 * 4. Emits the repository index in the schema the Valenced loader parses
 *    (`RepoIndex` → `Map<pluginId, RepoPlugin>` → `Map<version, RepoVersion>`), plus a
 *    `generated` timestamp for cache detection (the loader ignores unknown keys).
 *
 * Fail-loud rules (the whole point of generating the index instead of hand-editing it):
 * - an asset without a matching `plugins/<dir>/manifest.json` → error
 * - a plugin without any release asset → error (override: ALLOW_UNRELEASED=1)
 * - tag/version or ZIP/manifest mismatch → error
 * - two releases publishing the same plugin version → error
 *
 * Environment:
 *   GITHUB_REPOSITORY      owner/repo                      (required)
 *   GITHUB_TOKEN           token for the REST API          (optional on public repos)
 *   GITHUB_API_URL         API base                        (default https://api.github.com)
 *   INDEX_NAME             repository display name         (default: repo.config.json name)
 *   INDEX_DESCRIPTION      repository description          (default: repo.config.json description)
 *   ALLOW_UNRELEASED       "1" downgrades plugins-without-asset to a warning
 *   MAX_ASSET_BYTES        hard limit for downloads        (default 67108864)
 *
 * Usage:
 *   node scripts/build-index.mjs              # -> ./index.json (deployed by pages.yml)
 *   node scripts/build-index.mjs --out /tmp/x.json
 *
 * Zero external dependencies. Node 20+ (`fetch`, `node:fs/promises`, `node:path`).
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, isPrerelease, parseVersion } from './lib/semver.mjs'
import { readZipEntries } from './lib/zip.mjs'
import { isValidRange, validateAll } from './validate-manifests.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_API_URL = 'https://api.github.com'
const INDEX_FORMAT = 1
const DEFAULT_MAX_ASSET_BYTES = 64 * 1024 * 1024
const SHA256_PATTERN = /^[0-9a-f]{64}$/

class IndexError extends Error {}

/* -------------------------------------------------------------------------- */
/* GitHub API                                                                 */
/* -------------------------------------------------------------------------- */

function createClient({ apiUrl, repository, token }) {
	const headers = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'valenced-repo-index-builder',
	}
	if (token) headers.Authorization = `Bearer ${token}`

	/** Fetches a JSON document, following `Link: rel="next"` pagination. */
	async function listAll(path) {
		const results = []
		let url = `${apiUrl}${path}${path.includes('?') ? '&' : '?'}per_page=100`

		while (url) {
			const response = await fetch(url, { headers })
			if (!response.ok) {
				throw new IndexError(
					`GitHub API ${response.status} ${response.statusText} for ${url}` +
						(response.status === 404 ? ` — is '${repository}' correct and public?` : ''),
				)
			}
			const page = await response.json()
			if (!Array.isArray(page)) throw new IndexError(`Expected an array from ${url}`)
			results.push(...page)

			const link = response.headers.get('link')
			const next = link?.split(',').find(part => part.includes('rel="next"'))
			url = next ? next.slice(next.indexOf('<') + 1, next.indexOf('>')) : null
		}

		return results
	}

	return { listReleases: () => listAll(`/repos/${repository}/releases`) }
}

/* -------------------------------------------------------------------------- */
/* Release → plugin mapping                                                   */
/* -------------------------------------------------------------------------- */

function tagToVersion(tag) {
	if (typeof tag !== 'string' || !tag.startsWith('v')) return null
	try {
		parseVersion(tag.slice(1))
		return tag.slice(1)
	} catch {
		return null
	}
}

/**
 * Collects every released artifact, keyed by plugin id then version.
 *
 * @returns {Map<string, Map<string, { version: string, tag: string, release: string, asset: any }>>}
 */
function collectArtifacts(releases, knownPluginIds) {
	const artifacts = new Map()
	const orphans = []
	const duplicateVersions = []
	const badTags = new Set()

	for (const release of releases) {
		if (release?.draft === true) continue

		const version = tagToVersion(release?.tag_name)
		const assets = Array.isArray(release?.assets) ? release.assets : []

		for (const asset of assets) {
			const name = typeof asset?.name === 'string' ? asset.name : ''
			if (!name.toLowerCase().endsWith('.zip')) continue

			const pluginId = name.slice(0, -'.zip'.length)

			if (!knownPluginIds.has(pluginId)) {
				orphans.push({ asset: name, tag: release?.tag_name, release: release?.name ?? release?.tag_name })
				continue
			}
			if (version === null) {
				badTags.add(`${release?.tag_name} (asset ${name})`)
				continue
			}
			if (asset?.state !== undefined && asset.state !== 'uploaded') continue

			if (!artifacts.has(pluginId)) artifacts.set(pluginId, new Map())
			const versions = artifacts.get(pluginId)
			if (versions.has(version)) {
				duplicateVersions.push({ pluginId, version, tag: release?.tag_name })
				continue
			}

			versions.set(version, {
				version,
				tag: release.tag_name,
				release: release.tag_name,
				asset,
			})
		}
	}

	return { artifacts, orphans, duplicateVersions, badTags }
}

/* -------------------------------------------------------------------------- */
/* Artifact verification                                                      */
/* -------------------------------------------------------------------------- */

async function downloadAsset(asset, maxBytes) {
	if (typeof asset?.browser_download_url !== 'string') {
		throw new IndexError(`Asset '${asset?.name}' has no browser_download_url`)
	}

	const response = await fetch(asset.browser_download_url, {
		headers: { 'User-Agent': 'valenced-repo-index-builder' },
		redirect: 'follow',
	})
	if (!response.ok) {
		throw new IndexError(
			`Download failed for '${asset.name}': ${response.status} ${response.statusText}. ` +
				'Release assets must be public and uploaded (draft releases are skipped).',
		)
	}

	const declaredLength = Number(response.headers.get('content-length') ?? 0)
	if (declaredLength > maxBytes) {
		throw new IndexError(`Asset '${asset.name}' is too large (${declaredLength} bytes)`)
	}

	const bytes = Buffer.from(await response.arrayBuffer())
	if (bytes.length === 0) throw new IndexError(`Asset '${asset.name}' is empty`)
	if (bytes.length > maxBytes) {
		throw new IndexError(`Asset '${asset.name}' is larger than MAX_ASSET_BYTES`)
	}

	return bytes
}

/**
 * Downloads one release asset and proves it is a well-formed, self-consistent plugin ZIP.
 *
 * @returns {Promise<{ sha256: string, size: number, manifest: any }>}
 */
async function verifyArtifact({ pluginId, version, artifact, currentManifestPath, maxBytes }) {
	const bytes = await downloadAsset(artifact.asset, maxBytes)
	const sha256 = createHash('sha256').update(bytes).digest('hex')

	// Cross-check with the digest GitHub reports for the upload, when it provides one.
	const declaredDigest = typeof artifact.asset.digest === 'string' ? artifact.asset.digest.trim() : ''
	if (declaredDigest.startsWith('sha256:')) {
		const expected = declaredDigest.slice('sha256:'.length).toLowerCase()
		if (SHA256_PATTERN.test(expected) && expected !== sha256) {
			throw new IndexError(
				`${pluginId}@${version}: GitHub digest ${expected} does not match the downloaded bytes ${sha256}`,
			)
		}
	}
	if (typeof artifact.asset.size === 'number' && artifact.asset.size > 0 && artifact.asset.size !== bytes.length) {
		throw new IndexError(
			`${pluginId}@${version}: asset size ${artifact.asset.size} does not match the downloaded ${bytes.length} bytes`,
		)
	}

	let entries
	try {
		entries = readZipEntries(bytes)
	} catch (error) {
		throw new IndexError(`${pluginId}@${version}: not a readable ZIP (${error.message})`)
	}

	const manifestEntry = entries.get('manifest.json')
	if (!manifestEntry) {
		throw new IndexError(`${pluginId}@${version}: ZIP has no manifest.json at its root`)
	}

	let manifest
	try {
		manifest = JSON.parse(manifestEntry.toString('utf8'))
	} catch (error) {
		throw new IndexError(`${pluginId}@${version}: ZIP manifest.json is not valid JSON`)
	}

	if (manifest?.id !== pluginId) {
		throw new IndexError(
			`${pluginId}@${version}: ZIP manifest id is '${manifest?.id}', expected '${pluginId}'`,
		)
	}
	if (manifest?.version !== version) {
		throw new IndexError(
			`${pluginId}@${version}: ZIP manifest version is '${manifest?.version}', ` +
				`but the release tag says '${version}'`,
		)
	}

	const scriptEntry = entries.get(manifest?.dist?.script)
	if (!scriptEntry) {
		throw new IndexError(
			`${pluginId}@${version}: ZIP is missing dist.script '${manifest?.dist?.script}'`,
		)
	}

	// For the version that is checked in, the artifact manifest must be byte-identical to
	// the repository copy: that is the contract `plugins[]` and the ZIP must share.
	if (currentManifestPath !== undefined) {
		const sourceManifest = (await readFile(currentManifestPath, 'utf8')).trim()
		if (manifestEntry.toString('utf8').trim() !== sourceManifest) {
			throw new IndexError(
				`${pluginId}@${version}: ZIP manifest.json differs from plugins/*/manifest.json. ` +
					'Commit the manifest, then re-tag.',
			)
		}
	}

	return { sha256, size: bytes.length, manifest }
}

/**
 * Copies a manifest dependency map into the index verbatim ("the version's dependencies as
 * they appear in its manifest"), with sorted keys so the output is stable across runs.
 */
function copyDependencies(dependencies) {
	const entries = Object.entries(dependencies ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return Object.fromEntries(
		entries.map(([id, constraint]) => {
			const copy = {}
			if (constraint?.version !== undefined && constraint.version !== null) copy.version = constraint.version
			if (constraint?.optional === true) copy.optional = true
			return [id, copy]
		}),
	)
}

/**
 * Comparison key for dependency maps: `optional: false` and an absent `version` are the
 * defaults, so `{}` and `{"version": null}` must compare equal.
 */
function dependencyKey(dependencies) {
	return JSON.stringify(
		Object.entries(dependencies ?? {})
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([id, constraint]) => [
				id,
				constraint?.version ?? null,
				constraint?.optional === true,
			]),
	)
}

/* -------------------------------------------------------------------------- */
/* Icon handling (mirrors the loader's validatedPluginIcon)                    */
/* -------------------------------------------------------------------------- */

function validatedIcon(icon) {
	if (typeof icon !== 'string' || icon.length === 0) return undefined
	if (icon.startsWith('data:')) return icon
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(icon)) return undefined
	return icon
}

/* -------------------------------------------------------------------------- */
/* Channel assignment                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `latest` is the highest stable version (falling back to the highest version overall);
 * `beta` is added when a higher prerelease exists. Explicit overrides from
 * `repo.config.json` (`channels[pluginId][channel] = version`) win.
 */
function channelsFor(versions, overrides) {
	const keys = Object.keys(versions)
	const stable = keys.filter(key => !isPrerelease(key)).sort(compareVersions)
	const all = [...keys].sort(compareVersions)

	const channels = {}
	if (stable.length > 0) channels.latest = stable[stable.length - 1]
	else if (all.length > 0) channels.latest = all[all.length - 1]

	const highestPrerelease = [...keys].filter(key => isPrerelease(key)).sort(compareVersions).pop()
	if (highestPrerelease !== undefined && channels.latest !== undefined) {
		if (compareVersions(highestPrerelease, channels.latest) > 0) channels.beta = highestPrerelease
	}

	for (const [channel, target] of Object.entries(overrides ?? {})) {
		if (typeof target === 'string' && target in versions) channels[channel] = target
	}

	return channels
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function readRepoConfig() {
	try {
		const raw = await readFile(join(ROOT, 'repo.config.json'), 'utf8')
		const config = JSON.parse(raw)
		return config && typeof config === 'object' ? config : {}
	} catch {
		return {}
	}
}

function parseArgs(argv) {
	const options = { out: 'index.json' }
	const args = argv.slice(2)
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]
		if (arg === '--out') options.out = args[++index]
		else if (arg === '--help' || arg === '-h') options.help = true
		else throw new IndexError(`Unknown argument '${arg}'`)
	}
	return options
}

async function main(argv) {
	const options = parseArgs(argv)
	if (options.help) {
		process.stdout.write(
			'Usage: node scripts/build-index.mjs [--out <path>]\n' +
				'Env: GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_API_URL, ALLOW_UNRELEASED, MAX_ASSET_BYTES\n',
		)
		return 0
	}

	const repository = process.env.GITHUB_REPOSITORY?.trim()
	if (!repository || !repository.includes('/')) {
		throw new IndexError('GITHUB_REPOSITORY must be set to owner/repo (Actions sets it for you)')
	}

	const apiUrl = (process.env.GITHUB_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, '')
	const allowUnreleased = process.env.ALLOW_UNRELEASED === '1'
	const maxBytes = Number.parseInt(process.env.MAX_ASSET_BYTES ?? '', 10) || DEFAULT_MAX_ASSET_BYTES

	const repoConfig = await readRepoConfig()

	// 1. Manifests: the same gate the validator uses.
	const { errors, warnings, plugins } = await validateAll()
	if (warnings.length > 0) {
		process.stdout.write(
			`Manifest warnings:\n${warnings
				.map(problem => `  - plugins/${problem.plugin}: ${problem.field}: ${problem.message}`)
				.join('\n')}\n`,
		)
	}
	if (errors.length > 0) {
		throw new IndexError(
			`manifest validation failed:\n${errors
				.map(problem => `  - plugins/${problem.plugin}: ${problem.field}: ${problem.message}`)
				.join('\n')}`,
		)
	}
	if (plugins.length === 0) {
		process.stdout.write('No plugin directories under plugins/; writing an empty index.\n')
	}

	// 2. Releases → artifacts.
	const client = createClient({
		apiUrl,
		repository,
		token: process.env.GITHUB_TOKEN?.trim() || '',
	})

	const releases = await client.listReleases()
	process.stdout.write(`Found ${releases.length} release(s) in ${repository}.\n`)

	const knownPluginIds = new Set(plugins.map(plugin => plugin.id))
	const { artifacts, orphans, duplicateVersions, badTags } = collectArtifacts(releases, knownPluginIds)

	if (orphans.length > 0) {
		throw new IndexError(
			`release assets without a matching plugins/<dir>/manifest.json:\n${orphans
				.map(orphan => `  - ${orphan.asset} (release ${orphan.tag})`)
				.join('\n')}\nDelete the asset, or add the plugin source and re-release.`,
		)
	}
	if (duplicateVersions.length > 0) {
		throw new IndexError(
			`the same plugin version is published by more than one release:\n${duplicateVersions
				.map(duplicate => `  - ${duplicate.pluginId}@${duplicate.version} (tag ${duplicate.tag})`)
				.join('\n')}\nDelete the stale release asset; the index must be unambiguous.`,
		)
	}
	if (badTags.size > 0) {
		throw new IndexError(
			`releases carry plugin assets but their tags are not 'v<version>':\n${[...badTags]
				.map(tag => `  - ${tag}`)
				.join('\n')}\nTag releases as v1.2.3 (the tag is the published version).`,
		)
	}

	const missingAssets = plugins.filter(plugin => !artifacts.has(plugin.id))
	if (missingAssets.length > 0) {
		const message =
			`plugins with no release asset:\n${missingAssets
				.map(plugin => `  - ${plugin.id} (plugins/${plugin.dir})`)
				.join('\n')}\nPush a v* tag so build.yml publishes them, or set ALLOW_UNRELEASED=1 to skip them.`
		if (!allowUnreleased) throw new IndexError(message)
		process.stdout.write(`Warning: ${message}\n`)
	}

	// 3. Verify artifacts and assemble entries.
	const indexPlugins = {}

	for (const plugin of plugins) {
		const versions = artifacts.get(plugin.id)
		if (!versions || versions.size === 0) continue

		const entries = {}
		const sortedVersions = [...versions.keys()].sort(compareVersions)

		for (const version of sortedVersions) {
			const artifact = versions.get(version)

			const { sha256, size, manifest } = await verifyArtifact({
				pluginId: plugin.id,
				version,
				artifact,
				currentManifestPath: version === plugin.manifest.version ? plugin.manifestPath : undefined,
				maxBytes,
			})

			entries[version] = {
				url: artifact.asset.browser_download_url,
				sha256,
				size,
				// Must equal the artifact's manifest: the loader aborts an install on mismatch.
				dependencies: copyDependencies(manifest.dependencies),
			}

			process.stdout.write(
				`Verified ${plugin.id}@${version}: ${size} bytes, sha256 ${sha256.slice(0, 12)}…\n`,
			)
		}

		const current = plugin.manifest
		const icon = validatedIcon(current.icon)
		indexPlugins[plugin.id] = {
			name: current.name,
			description: current.description ?? '',
			author: current.author ?? '',
			...(icon === undefined ? {} : { icon }),
			channels: channelsFor(entries, repoConfig?.channels?.[plugin.id]),
			versions: entries,
		}
	}

	// 4. Emit.
	const index = {
		format: INDEX_FORMAT,
		name:
			process.env.INDEX_NAME?.trim() ||
			(typeof repoConfig?.name === 'string' && repoConfig.name.trim()) ||
			`${repository.split('/')[1]} plugins`,
		description:
			process.env.INDEX_DESCRIPTION?.trim() ||
			(typeof repoConfig?.description === 'string' ? repoConfig.description : ''),
		plugins: Object.fromEntries(
			Object.entries(indexPlugins).sort(([, a], [, b]) => a.name.localeCompare(b.name)),
		),
		generated: new Date().toISOString(),
	}

	selfCheck(index)

	const outputPath = resolve(ROOT, options.out)
	await mkdir(dirname(outputPath), { recursive: true })
	await writeFile(outputPath, `${JSON.stringify(index, null, '\t')}\n`, 'utf8')
	const versionCount = Object.values(index.plugins).reduce(
		(total, plugin) => total + Object.keys(plugin.versions).length,
		0,
	)
	process.stdout.write(
		`Wrote ${options.out}: ${Object.keys(index.plugins).length} plugin(s), ${versionCount} version(s).\n`,
	)

	return 0
}

/**
 * Re-applies the loader's structural rules to the document we just wrote, so a broken
 * index can never be deployed: absolute URL, 64-char lowercase sha256, positive size,
 * `latest` channel pointing at an existing version.
 */
function selfCheck(index) {
	const problems = []
	if (index.format !== INDEX_FORMAT) problems.push(`format must be ${INDEX_FORMAT}`)

	for (const [id, plugin] of Object.entries(index.plugins)) {
		if (Object.keys(plugin.versions).length === 0) problems.push(`${id}: no versions`)
		for (const [version, entry] of Object.entries(plugin.versions)) {
			if (!/^https?:\/\//.test(entry.url)) problems.push(`${id}@${version}: url must be absolute`)
			if (!SHA256_PATTERN.test(entry.sha256)) problems.push(`${id}@${version}: malformed sha256`)
			if (!(typeof entry.size === 'number' && entry.size > 0)) problems.push(`${id}@${version}: bad size`)
			for (const [depId, constraint] of Object.entries(entry.dependencies ?? {})) {
				if (!/^[A-Za-z0-9.-]+$/.test(depId) || depId.includes('..') || depId.startsWith('.')) {
					problems.push(`${id}@${version}: invalid dependency id '${depId}'`)
				}
				if (constraint?.version != null && !isValidRange(constraint.version)) {
					problems.push(`${id}@${version}: invalid range for '${depId}'`)
				}
			}
		}
		for (const [channel, target] of Object.entries(plugin.channels)) {
			if (!(target in plugin.versions)) problems.push(`${id}: channel '${channel}' targets missing version`)
		}
	}

	if (problems.length > 0) {
		throw new IndexError(`generated index failed self-check:\n${problems.map(p => `  - ${p}`).join('\n')}`)
	}
}

main(process.argv)
	.then(code => {
		process.exitCode = code
	})
	.catch(error => {
		const message = error instanceof Error ? error.message : String(error)
		process.stderr.write(`${error instanceof IndexError ? 'Error' : 'Unexpected error'}: ${message}\n`)
		process.exitCode = 1
	})
