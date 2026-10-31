#!/usr/bin/env node
/**
 * Waits for the release + deploy workflows of this repository to finish, then reports.
 *
 *   GH_TOKEN=<pat> node scripts/gh-watch.mjs <OWNER> <REPO> [TAG] [TIMEOUT_SECONDS]
 *
 * Exit codes: 0 deployed, 1 a workflow failed, 2 timed out, 3 API/auth problem.
 * Zero dependencies. Token is read from the environment only.
 */

const [owner, repo, tag = '', timeoutSeconds = '600'] = process.argv.slice(2)
if (!owner || !repo) {
	process.statusCode = 2
	console.error('usage: node scripts/gh-watch.mjs <OWNER> <REPO> [TAG] [TIMEOUT_SECONDS]')
	process.exit(2)
}

const token = (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '').trim()
const api = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '')
const headers = {
	Accept: 'application/vnd.github+json',
	'X-GitHub-Api-Version': '2022-11-28',
	'User-Agent': 'valenced-repo-setup',
	...(token ? { Authorization: `Bearer ${token}` } : {}),
}

const BUILD = 'Build and release'
const PAGES = 'Deploy repository index'
const deadline = Date.now() + Number(timeoutSeconds) * 1000

let lastLine = ''

async function poll() {
	const response = await fetch(`${api}/repos/${owner}/${repo}/actions/runs?per_page=30`, { headers })
	if (!response.ok) {
		throw new Error(`GitHub API ${response.status} ${response.statusText} listing workflow runs`)
	}
	const { workflow_runs: runs = [] } = await response.json()

	const relevant = runs.filter(run => {
		if (run.name === PAGES) return ['release', 'workflow_run', 'workflow_dispatch'].includes(run.event) || run.head_branch === tag
		if (run.name === BUILD) return run.head_branch === tag || run.event === 'push'
		return false
	})

	const latest = name => relevant.filter(run => run.name === name).sort((a, b) => b.run_number - a.run_number)[0]
	const describe = run => (run ? `${run.status}/${run.conclusion ?? '-'}` : 'missing')

	const build = latest(BUILD)
	const pages = latest(PAGES)
	return { build: describe(build), pages: describe(pages), buildUrl: build?.html_url, pagesUrl: pages?.html_url }
}

for (;;) {
	let state
	try {
		state = await poll()
	} catch (error) {
		console.error(`error: ${error.message}`)
		process.exit(3)
	}

	const line = `build: ${state.build.padEnd(20)} pages: ${state.pages}`
	if (line !== lastLine) {
		console.log(`  ${line}`)
		lastLine = line
	}

	if (state.build.endsWith('/failure') || state.pages.endsWith('/failure')) {
		console.error(`\nerror: a workflow failed.\n  ${state.buildUrl ?? ''}\n  ${state.pagesUrl ?? ''}`)
		process.exit(1)
	}
	if (state.pages.endsWith('/success')) {
		process.exit(0)
	}
	if (Date.now() > deadline) {
		console.error('\nerror: timed out waiting for the deploy; check the Actions tab.')
		process.exit(2)
	}

	await new Promise(resolve => setTimeout(resolve, 10000))
}
