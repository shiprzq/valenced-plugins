#!/usr/bin/env node
/**
 * End-to-end check of the release pipeline, with no GitHub and no network:
 * build the ZIP in memory → stand up a mock of the GitHub REST API → run
 * `build-index.mjs` against it → assert the generated `index.json` describes the exact
 * bytes a client would download.
 *
 *   node scripts/test-pipeline.mjs
 *
 * Covers: deterministic ZIP output, CRC/tamper rejection, Valenced version ordering,
 * manifest validation, index schema, sha256/size correctness, and the fail-loud paths
 * (orphan asset, plugin without a release).
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createZip, readZipEntries } from './lib/zip.mjs'
import { compareVersions, isValidVersion } from './lib/semver.mjs'
import { validateManifest } from './validate-manifests.mjs'

const run = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
let checks = 0

function check(label, condition, detail) {
	checks++
	if (condition) {
		process.stdout.write(`  ok   ${label}\n`)
	} else {
		failures++
		process.stdout.write(`  FAIL ${label}${detail ? ` — ${detail}` : ''}\n`)
	}
}

async function section(title, body) {
	process.stdout.write(`\n${title}\n`)
	await body()
}

/* -------------------------------------------------------------------------- */

await section('ZIP writer/reader', async () => {
	const entries = [
		{ name: 'manifest.json', data: Buffer.from('{"format":1}\n') },
		{ name: 'index.js', data: Buffer.from('export default 1\n') },
	]
	const first = createZip(entries)
	const second = createZip(entries)

	check('is deterministic', first.equals(second), 'two runs produced different bytes')
	check('round-trips entries', readZipEntries(first).get('manifest.json')?.toString() === '{"format":1}\n')
	check('keeps path order', [...readZipEntries(first).keys()].join(',') === 'manifest.json,index.js')

	// Flip one byte inside the stored payload: the CRC must catch it.
	const payloadOffset = 30 + Buffer.byteLength('manifest.json') + 2
	const tampered = Buffer.from(first)
	tampered[payloadOffset] ^= 0xff
	let crcRejected = false
	try {
		readZipEntries(tampered)
	} catch {
		crcRejected = true
	}
	check('rejects a corrupted payload byte', crcRejected)

	// Truncation and garbage must not be mistaken for an archive.
	let truncatedRejected = false
	try {
		readZipEntries(first.subarray(0, first.length - 10))
	} catch {
		truncatedRejected = true
	}
	check('rejects a truncated archive', truncatedRejected)

	// The reference archive produced by the official CLI must be readable by the same reader.
	const reference = await readFile(join(ROOT, 'dist', 'com.redpen.plugin.zip')).catch(() => null)
	if (reference) {
		const parsed = readZipEntries(reference)
		check('reads the built release archive', parsed.has('manifest.json') && parsed.has('index.js'))
	}
})

await section('Valenced version ordering', async () => {
	const ordered = ['1.0.0-alpha', '1.0.0-alpha2', '1.0.0-beta', '1.0.0', '1.0.1', '1.10.0', '2.0.0']
	for (let index = 1; index < ordered.length; index++) {
		check(
			`${ordered[index - 1]} < ${ordered[index]}`,
			compareVersions(ordered[index - 1], ordered[index]) < 0,
		)
	}
	check('1.2 == 1.2.0', compareVersions('1.2', '1.2.0') === 0)
	check('rejects 1.0.0-ALPHA', !isValidVersion('1.0.0-ALPHA'))
	check('rejects 1.0.0.0.0-', !isValidVersion('1.0.0.0.0-'))
})

await section('Manifest validation', async () => {
	const good = JSON.parse(await readFile(join(ROOT, 'plugins', 'redpen', 'manifest.json'), 'utf8'))
	const clean = validateManifest(good, { dir: 'redpen' })
	check('checked-in manifest passes', clean.errors.length === 0, JSON.stringify(clean.errors))

	const missingDiscord = structuredClone(good)
	delete missingDiscord.dependencies.discord
	check(
		'missing discord dependency fails',
		validateManifest(missingDiscord, { dir: 'redpen' }).errors.some(problem =>
			problem.field.includes('dependencies'),
		),
	)

	const optionalApi = structuredClone(good)
	optionalApi.dependencies['valenced.api'].optional = true
	check(
		'optional valenced.api fails',
		validateManifest(optionalApi, { dir: 'redpen' }).errors.some(problem =>
			problem.field.endsWith('.optional'),
		),
	)

	const badVersion = structuredClone(good)
	badVersion.version = 'v1.0.0'
	check('bad version fails', validateManifest(badVersion, { dir: 'redpen' }).errors.length > 0)

	const wrongFormat = structuredClone(good)
	wrongFormat.format = 2
	check('wrong format fails', validateManifest(wrongFormat, { dir: 'redpen' }).errors.length > 0)

	const escape = structuredClone(good)
	escape.dist.script = '../index.js'
	check('escaping dist.script fails', validateManifest(escape, { dir: 'redpen' }).errors.length > 0)
})

/* -------------------------------------------------------------------------- */
/* Mock GitHub API + build-index                                             */
/* -------------------------------------------------------------------------- */

const scenario = {
	// replaced per case: [{ tag, assets: [{ name, bytes }] }]
	releases: [],
}
let port = 0

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)

	if (url.pathname === '/repos/OWNER/REPO/releases') {
		const body = scenario.releases.map((release, index) => ({
			id: 1000 + index,
			tag_name: release.tag,
			name: release.tag,
			draft: release.draft === true,
			prerelease: release.prerelease === true,
			assets: release.assets.map((asset, assetIndex) => ({
				id: 5000 + index * 10 + assetIndex,
				name: asset.name,
				size: asset.bytes.length,
				draft: false,
				state: 'uploaded',
				digest: `sha256:${createHash('sha256').update(asset.bytes).digest('hex')}`,
				browser_download_url: `http://127.0.0.1:${port}/download/${release.tag}/${asset.name}`,
			})),
		}))
		response.writeHead(200, { 'content-type': 'application/json' })
		response.end(JSON.stringify(body))
		return
	}

	const download = /^\/download\/([^/]+)\/(.+)$/.exec(url.pathname)
	if (download) {
		const release = scenario.releases.find(candidate => candidate.tag === download[1])
		const asset = release?.assets.find(candidate => candidate.name === decodeURIComponent(download[2]))
		if (!asset) {
			response.writeHead(404, { 'content-type': 'text/plain' })
			response.end('not found')
			return
		}
		response.writeHead(200, { 'content-type': 'application/zip', 'content-length': asset.bytes.length })
		response.end(asset.bytes)
		return
	}

	response.writeHead(404, { 'content-type': 'application/json' })
	response.end('{"message":"Not Found"}')
})

await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
port = server.address().port

const workDir = await mkdtemp(join(tmpdir(), 'valenced-index-'))
const zipBytes = await readFile(join(ROOT, 'dist', 'com.redpen.plugin.zip'))
const manifestBytes = await readFile(join(ROOT, 'plugins', 'redpen', 'manifest.json'))
/** The version currently checked in; release tags in the fixture are built from it. */
const VERSION = JSON.parse(manifestBytes.toString('utf8')).version
const TAG = `v${VERSION}`
/** A version that sorts above the checked-in one, for the multi-release case. */
const NEXT_VERSION = `${VERSION.replace(/(-.*)$/, '').split('.').slice(0, -1).join('.')}.${Number(VERSION.replace(/(-.*)$/, '').split('.').pop()) + 1}-beta1`

/** Runs build-index.mjs against the mock API. Never throws. */
async function buildIndex(extraEnv = {}, outPath = join(workDir, 'index.json')) {
	const env = {
		...process.env,
		GITHUB_REPOSITORY: 'OWNER/REPO',
		GITHUB_API_URL: `http://127.0.0.1:${port}`,
		GITHUB_TOKEN: '',
		ALLOW_UNRELEASED: '',
		...(extraEnv ?? {}),
	}
	try {
		const { stdout, stderr } = await run(
			process.execPath,
			[join(ROOT, 'scripts', 'build-index.mjs'), '--out', outPath],
			{ cwd: ROOT, env, maxBuffer: 16 * 1024 * 1024 },
		)
		return { code: 0, stdout, stderr }
	} catch (error) {
		return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
	}
}

await section('build-index.mjs against a mock GitHub API', async () => {
	scenario.releases = [{ tag: TAG, assets: [{ name: 'com.redpen.plugin.zip', bytes: zipBytes }] }]

	const outPath = join(workDir, 'index.json')
	const result = await buildIndex({}, outPath)
	check('exits 0 on a healthy release', result.code === 0, result.stderr.trim())

	const index = JSON.parse(await readFile(outPath, 'utf8'))
	check('format is 1', index.format === 1)
	check('plugins is an object keyed by id', !Array.isArray(index.plugins) && 'com.redpen.plugin' in index.plugins)
	check('has an ISO-8601 generated timestamp', !Number.isNaN(Date.parse(index.generated)))

	const plugin = index.plugins['com.redpen.plugin']
	check('plugin name matches the manifest', plugin.name === JSON.parse(manifestBytes).name)
	check(`channels.latest points at ${VERSION}`, plugin.channels.latest === VERSION, JSON.stringify(plugin.channels))
	check('no manifest echo inside the index', !('manifest' in plugin) && !('download' in plugin))

	const version = plugin.versions[VERSION]
	check('version url is absolute', /^https?:\/\//.test(version.url), version.url)
	check(
		'sha256 matches the actual ZIP bytes',
		version.sha256 === createHash('sha256').update(zipBytes).digest('hex'),
		version.sha256,
	)
	check('size matches the actual ZIP bytes', version.size === zipBytes.length, String(version.size))
	const stableJson = value =>
		JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))))
	check(
		'dependencies mirror the artifact manifest',
		stableJson(version.dependencies) === stableJson(JSON.parse(manifestBytes).dependencies),
		JSON.stringify(version.dependencies),
	)

	// Determinism of the artifact: re-zipping the same inputs must reproduce the same hash.
	const repacked = createZip([
		{ name: 'manifest.json', data: manifestBytes },
		{ name: 'index.js', data: readZipEntries(zipBytes).get('index.js') },
	])
	check('re-zip is byte-identical', repacked.equals(zipBytes))

	// Fail loud: an asset with no matching plugins/<dir>.
	scenario.releases = [{
		tag: TAG,
		assets: [
			{ name: 'com.redpen.plugin.zip', bytes: zipBytes },
			{ name: 'com.ghost.plugin.zip', bytes: zipBytes },
		],
	}]
	const orphan = await buildIndex()
	check('fails on an orphan release asset', orphan.code !== 0)
	check('names the orphan asset', /com\.ghost\.plugin\.zip/.test(orphan.stderr), orphan.stderr.trim())

	// Fail loud: plugin source with no release at all.
	scenario.releases = []
	const missing = await buildIndex()
	check('fails when a plugin has no release', missing.code !== 0)
	check('names the missing plugin', /com\.redpen\.plugin/.test(missing.stderr), missing.stderr.trim())

	// Escape hatch for the bootstrap commit, where nothing is released yet.
	const allowed = await buildIndex({ ALLOW_UNRELEASED: '1' }, join(workDir, 'empty.json'))
	check('ALLOW_UNRELEASED=1 succeeds', allowed.code === 0, allowed.stderr.trim())
	const emptyIndex = JSON.parse(await readFile(join(workDir, 'empty.json'), 'utf8'))
	check('emits an empty plugins map', Object.keys(emptyIndex.plugins).length === 0)

	// Fail loud: tag/manifest version mismatch.
	const tamperedZip = createZip([
		{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...JSON.parse(manifestBytes), version: '9.9.9' }, null, '\t') + '\n') },
		{ name: 'index.js', data: readZipEntries(zipBytes).get('index.js') },
	])
	scenario.releases = [{ tag: TAG, assets: [{ name: 'com.redpen.plugin.zip', bytes: tamperedZip }] }]
	const mismatch = await buildIndex()
	check('fails when the artifact manifest disagrees with the tag', mismatch.code !== 0)
	check('explains the mismatch', /version/i.test(mismatch.stderr), mismatch.stderr.trim())

	// Prereleases and multi-release history.
	scenario.releases = [
		{ tag: TAG, assets: [{ name: 'com.redpen.plugin.zip', bytes: zipBytes }] },
		{ tag: `v${NEXT_VERSION}`, assets: [{ name: 'com.redpen.plugin.zip', bytes: createZip([
			{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ ...JSON.parse(manifestBytes), version: NEXT_VERSION }, null, '\t') + '\n') },
			{ name: 'index.js', data: Buffer.from('// beta build\n') },
		]) }] },
	]
	const multi = await buildIndex()
	check('accepts several releases', multi.code === 0, multi.stderr.trim())
	const multiIndex = JSON.parse(await readFile(outPath, 'utf8'))
	const multiPlugin = multiIndex.plugins['com.redpen.plugin']
	check('keeps every version', Object.keys(multiPlugin.versions).join(',') === `${VERSION},${NEXT_VERSION}`, Object.keys(multiPlugin.versions).join(','))
	check('latest stays on the highest stable', multiPlugin.channels.latest === VERSION, multiPlugin.channels.latest)
	check('beta tracks the prerelease', multiPlugin.channels.beta === NEXT_VERSION, multiPlugin.channels.beta)
})

await new Promise(resolveClosed => server.close(resolveClosed))
await rm(workDir, { recursive: true, force: true })

process.stdout.write(
	`\n${checks - failures}/${checks} checks passed${failures > 0 ? `, ${failures} FAILED` : ''}\n`,
)
process.exitCode = failures > 0 ? 1 : 0
