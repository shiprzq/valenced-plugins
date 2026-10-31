#!/usr/bin/env node
/**
 * Packages every built plugin into `dist/<plugin-id>.zip`.
 *
 * ZIP layout (matches what the loader expects and what `build.gradle.kts` produces):
 *
 *   manifest.json          the plugin's manifest, byte-identical to plugins/<dir>/manifest.json
 *   <dist.script>          the bundle, copied from plugins/<dir>/build/js/index.js
 *   <dist.android.path>    optional prebuilt DEXed JAR (native plugins)
 *   assets/**              optional, when plugins/<dir>/assets exists
 *
 * Usage:
 *   node scripts/zip-plugins.mjs            # all plugins
 *   node scripts/zip-plugins.mjs redpen     # one plugin directory
 *
 * Requires `npm run build` first. Archives are deterministic: the same sources produce a
 * byte-identical ZIP and therefore a stable SHA-256 across machines and runs.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZip } from './lib/zip.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = join(ROOT, 'plugins')
const DIST_DIR = join(ROOT, 'dist')

async function pathExists(path) {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

async function collectAssets(pluginDir) {
	const assetsDir = join(pluginDir, 'assets')
	if (!(await pathExists(assetsDir))) return []

	const files = []
	const walk = async directory => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			if (entry.isDirectory()) {
				await walk(path)
				continue
			}
			if (!entry.isFile()) continue
			files.push({
				name: `assets/${relative(assetsDir, path).split('\\').join('/')}`,
				data: await readFile(path),
			})
		}
	}

	await walk(assetsDir)
	files.sort((a, b) => a.name.localeCompare(b.name))
	return files
}

async function packagePlugin(dirName) {
	const pluginDir = join(PLUGINS_DIR, dirName)
	const manifestPath = join(pluginDir, 'manifest.json')
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

	if (typeof manifest?.id !== 'string' || manifest.id.length === 0) {
		throw new Error(`plugins/${dirName}/manifest.json has no id`)
	}

	const scriptPath = manifest?.dist?.script
	if (typeof scriptPath !== 'string' || scriptPath.length === 0) {
		throw new Error(`plugins/${dirName}/manifest.json has no dist.script`)
	}

	const bundlePath = join(pluginDir, 'build', 'js', 'index.js')
	if (!(await pathExists(bundlePath))) {
		throw new Error(
			`plugins/${dirName}: missing ${relative(ROOT, bundlePath)}. Run \`npm run build\` first.`,
		)
	}

	const entries = [
		{ name: 'manifest.json', data: await readFile(manifestPath) },
		{ name: scriptPath, data: await readFile(bundlePath) },
	]

	const android = manifest?.dist?.android
	if (android && typeof android === 'object') {
		const jarPath = join(pluginDir, 'build', 'android', String(android.path))
		if (!(await pathExists(jarPath))) {
			throw new Error(
				`plugins/${dirName}: manifest declares dist.android but ${relative(ROOT, jarPath)} does not exist`,
			)
		}
		entries.push({ name: String(android.path), data: await readFile(jarPath) })
	}

	entries.push(...(await collectAssets(pluginDir)))

	const zip = createZip(entries)
	const outputPath = join(DIST_DIR, `${manifest.id}.zip`)
	await mkdir(DIST_DIR, { recursive: true })
	await mkdir(dirname(outputPath), { recursive: true })
	await rm(outputPath, { force: true })
	await import('node:fs/promises').then(fs => fs.writeFile(outputPath, zip))

	return {
		id: manifest.id,
		version: manifest.version,
		path: outputPath,
		size: zip.length,
		sha256: createHash('sha256').update(zip).digest('hex'),
		entries: entries.map(entry => entry.name),
	}
}

async function main(argv) {
	const requested = argv.slice(2).filter(arg => !arg.startsWith('-'))

	const directories = (await readdir(PLUGINS_DIR, { withFileTypes: true }))
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.filter(name => !name.startsWith('.'))
		.sort()

	const selected = requested.length > 0 ? directories.filter(name => requested.includes(name)) : directories

	if (selected.length === 0) {
		process.stderr.write('Error: no plugins found under plugins/.\n')
		return 1
	}

	const results = []
	for (const dirName of selected) {
		const result = await packagePlugin(dirName)
		results.push(result)
		process.stdout.write(
			`Packaged ${result.id}@${result.version} -> ${relative(ROOT, result.path)} ` +
				`(${result.size} bytes, sha256 ${result.sha256})\n` +
				`  entries: ${result.entries.join(', ')}\n`,
		)
	}

	process.stdout.write(`\n${results.length} archive(s) written to ${relative(ROOT, DIST_DIR)}/\n`)
	return 0
}

main(process.argv)
	.then(code => {
		process.exitCode = code
	})
	.catch(error => {
		process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
		process.exitCode = 1
	})
