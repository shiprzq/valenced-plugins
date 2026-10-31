# Valenced plugin repository

A complete, ready-to-fork GitHub repository that hosts Valenced plugins as **release assets**,
generates the repository `index.json` from those releases, and serves it over **GitHub Pages**.
Tag a commit and the whole thing republishes itself; nobody edits `index.json` by hand.

```
git push origin v1.0.0
   └─ build.yml   npm ci → build → zip → validate → GitHub Release with dist/<plugin-id>.zip
        └─ pages.yml   read releases from the REST API → hash the artifacts → write index.json
             └─ GitHub Pages   https://shiprzq.github.io/valenced-plugins/index.json
                  └─ Valenced   Repository URL → Add repository → install / update
```

Two rules make the pipeline trustworthy:

1. **`sha256` and `size` are computed from the bytes GitHub actually serves**, not from a local
   file and not from the manifest. The client verifies the downloaded ZIP against them.
2. **The generator fails the deploy** when anything is ambiguous (an asset with no source, a
   source with no asset, a tag that disagrees with the manifest, a ZIP whose internal
   `manifest.json` differs from the checked-in one). A broken index is never published.

---

## The index schema (format 1)

The Valenced client does not read a list of plugins. It reads a `Map<pluginId, RepoPlugin>` and
drops anything structurally wrong **with a warning**, silently: a version without a valid
`sha256` or a positive `size`, a relative URL, a bad version key, a channel pointing at a missing
version, a plugin with no remaining versions. An index that "looks right" but uses the wrong
shape installs nothing at all. This repository emits exactly this:

```json
{
	"format": 1,
	"name": "Valenced Plugins",
	"description": "Plugin repository served over GitHub Pages.",
	"generated": "2026-10-31T07:12:44.512Z",
	"plugins": {
		"com.redpen.plugin": {
			"name": "Redpen",
			"description": "Grammar, spelling and punctuation cleanup for outgoing messages…",
			"author": "Redpen Maintainers",
			"channels": {
				"latest": "1.0.0"
			},
			"versions": {
				"1.0.0": {
					"url": "https://github.com/shiprzq/valenced-plugins/releases/download/v1.0.0/com.redpen.plugin.zip",
					"sha256": "43fee112dfa31a676b082d389d0d5e3f78bc13426ad26dd0910a23455afd1fc1",
					"size": 11637,
					"dependencies": {
						"discord": { "version": "*" },
						"valenced.api": { "version": ">=1 <2" },
						"valenced.settings.plugins": { "version": "*" }
					}
				}
			}
		}
	}
}
```

Field notes, all of them enforced by the client:

| Field | Rule |
| --- | --- |
| `format` | Must be `1`. Anything else is rejected outright. |
| `plugins` | **Object keyed by plugin id**, not an array. |
| plugin id | `[A-Za-z0-9.-]+`, no `..`, no leading `.`. Permanent: never rename one, it is the install identity. |
| `channels` | Channel name → version key that exists in `versions`. `latest` is what plain installs and update checks use. |
| `versions` | Object keyed by the exact version string. |
| `versions[].url` | Absolute `https://` (or `http://`) URL. Relative paths are dropped. |
| `versions[].sha256` | 64 lowercase hex characters of the ZIP. |
| `versions[].size` | Byte length of the ZIP, `> 0`. |
| `versions[].dependencies` | The version's dependency map **as it appears in that version's manifest**. The client resolves before download and aborts the install on a mismatch. |
| `generated` | ISO-8601 timestamp. Unknown to the client (it ignores unknown keys), used here to tell deploys apart and to defeat stale caches. |
| `icon` | Optional. Discord asset name or `data:` URL; any other URL scheme is stripped by the client. |

Versions are **not** strict semver: the scheme is `<n>[.<n>]*(-<label>)?` where `label` is
`[a-z0-9]+`, segments compare numerically, and a bare version outranks a labelled one
(`1.0.0` > `1.0.0-rc`). Ranges are `*` or whitespace-separated operator tokens with **unlabelled**
bounds (`>=1 <2`). `scripts/lib/semver.mjs` is a port of the loader's own comparison, so CI orders
versions the same way the client does.

The ZIP itself has one more contract: `manifest.json` at the archive root, bundle path matching
`dist.script`, no entry escaping the install directory. `scripts/zip-plugins.mjs` produces exactly
that, deterministically — same sources in, byte-identical ZIP out.

---

## Repository layout

```
.
├── .github/workflows/build.yml        tag → build → zip → validate → release
├── .github/workflows/pages.yml        release (or workflow_run) → index.json → Pages
├── plugins/
│   └── redpen/
│       ├── manifest.json              id, version, dependencies, dist.script
│       ├── tsconfig.json              editor-only; the CLI does the bundling
│       └── js/                        index.ts, corrector.ts, send.ts, sidebar.ts,
│                                      state.ts, settings.ts, tree.ts, types.ts, ui/*.tsx
├── scripts/
│   ├── build-index.mjs                GitHub Releases → index.json (zero dependencies)
│   ├── validate-manifests.mjs         the manifest gate, also imported by the generator
│   ├── zip-plugins.mjs                plugins/*/build/js/index.js → dist/<id>.zip
│   ├── test-pipeline.mjs              offline end-to-end check, mock GitHub API included
│   └── lib/{zip.mjs,semver.mjs}       dependency-free ZIP writer/reader, version ordering
├── types/assets.d.ts                  image imports
├── tsconfig.base.json                 shared compiler options
├── repo.config.json                   index name/description, optional channel overrides
├── index.json                         committed bootstrap stub, regenerated on every deploy
├── package.json / package-lock.json
└── .gitignore                         node_modules/, dist/, build/, .DS_Store, *.log
```

---

## Prerequisites

- Node.js **20** or newer and npm (CI uses 20; anything ≥ 20.11 works locally).
- Git, and a GitHub account that can push to the repository you create in step 1.
- `npm ci` prints `EBADENGINE … @valenced/plugin-cli requires node >=22.18` on Node 20. It is a
  warning, not an error: the CLI builds plugins correctly on Node 20, which is what CI uses.

---

## Steps 1–5 in one command (optional)

`scripts/setup-github.sh` does everything in steps 1–5 through the API: create the public
repository, set the Pages source to GitHub Actions, grant the workflow token write access, push
`main`, tag the manifest version, and wait for the release and deploy to finish.

```bash
GH_TOKEN=<token> ./scripts/setup-github.sh shiprzq valenced-plugins          # e.g. someuser valenced-plugins
DRY_RUN=1 ./scripts/setup-github.sh shiprzq valenced-plugins                 # print the plan, change nothing
```

Token permissions on that repository: **Contents: write**, **Administration: write** (repo
creation + Pages), **Workflows: write** (pushing `.github/workflows`), **Pages: write**. A classic
PAT needs `repo` and `workflow` scopes. The token is read from `GH_TOKEN` and never written to
disk. Revoke it when the script finishes.

The script aborts before touching GitHub if the tag version does not match
`plugins/redpen/manifest.json`, if the working tree is dirty, or if Pages is deployed from a
branch. `scripts/gh-watch.mjs` is the watcher it calls; run it alone to re-check a deploy:

```bash
GH_TOKEN=<token> node scripts/gh-watch.mjs shiprzq valenced-plugins v1.0.0
# exit 0 deployed, 1 workflow failed, 2 timed out, 3 API/auth problem
```

The manual equivalent follows.

## Step 1 — create the repository

Create an empty **public** repository on GitHub (for example `valenced-plugins`) and push this
tree to its default branch. Public matters: the client downloads release assets without
credentials, so asset URLs from a private repository will not resolve.

```bash
git init
git add -A
git commit -m "Initial commit: plugin repository"
git branch -M main
git remote add origin https://github.com/shiprzq/valenced-plugins.git
git push -u origin main
```

`scripts/build-index.mjs` derives the owner and repository name from `GITHUB_REPOSITORY`, so no
URL is hardcoded anywhere in the pipeline. The two placeholders below only affect documentation
and npm metadata.

---

## Step 2 — replace the placeholders

`shiprzq` and `valenced-plugins` appear literally in exactly two files:

| File | Where |
| --- | --- |
| `README.md` | every example URL in this document |
| `package.json` | `repository.url` and `homepage` |

Replace them (or leave the README examples as `<PLACEHOLDER>`-style text if you prefer), then
confirm nothing is left behind:

```bash
grep -rn --exclude-dir=node_modules --exclude-dir=.git -e 'shiprzq' -e 'valenced-plugins' .
```

---

## Step 3 — turn on Pages with the Actions source

Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.

Do not select "Deploy from a branch", and do not create a `gh-pages` branch. `pages.yml` uploads
an artifact and calls `deploy-pages`, which only works with the Actions source.

The first deploy happens after the **first published release**, not after the first push: until a
release exists there is nothing to index, so `build-index.mjs` refuses to invent one. A 404 on
`https://shiprzq.github.io/valenced-plugins/index.json` before step 5 is expected.

---

## Step 4 — let the workflows write

**Settings → Actions → General → Workflow permissions:**

- select **Read and write permissions** — `build.yml` creates the release with `GITHUB_TOKEN`;
- tick **Allow GitHub Actions to create and approve pull requests** — the standard pairing for
  this setting, and what GitHub's own UI expects for release-generating workflows.

No personal access token, no repository secret. `GITHUB_TOKEN` is sufficient; nothing in this
repository needs a secret, and nothing here should ever contain one.

---

## Step 5 — tag a version and push

```bash
git tag v1.0.0
git push origin v1.0.0
```

The tag is the published version, so it must match `version` in the plugin manifests —
`validate-manifests.mjs` compares every manifest against `GITHUB_REF_NAME` and fails the job on a
mismatch instead of publishing a version that lies.

What runs, in order:

1. `npm ci`
2. `npm run build` → `valenced-plugin build --plugins-dir plugins` → `plugins/*/build/js/index.js`
3. `npm run zip` → `dist/<plugin-id>.zip` (manifest + bundle, deterministic)
4. `node scripts/validate-manifests.mjs` → format, id, version, name/description, `dist.script`,
   `valenced.api` **and** `discord` dependencies, ranges
5. `softprops/action-gh-release@v2` → release `v1.0.0` with `dist/*.zip` attached

Then `pages.yml` regenerates `index.json` and deploys it.

To publish a fix: bump every manifest, commit, `git tag v1.0.1`, push the tag. Re-tagging a version
that already has an asset is refused on purpose.

---

## Step 6 — verify the published index

```bash
curl -s https://shiprzq.github.io/valenced-plugins/index.json | head -40
```

Check that `format` is `1`, that `plugins` contains your id, and that the version entry's `url`
points at the release asset. Confirm the hash the client will enforce:

```bash
URL=$(curl -s https://shiprzq.github.io/valenced-plugins/index.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).plugins['com.redpen.plugin'].versions['1.0.0'].url))")
curl -sL "$URL" -o /tmp/plugin.zip
sha256sum /tmp/plugin.zip     # must equal the index's sha256
stat -c%s /tmp/plugin.zip     # must equal the index's size
```

---

## Step 7 — add the repository in Valenced

Open Valenced → **Plugins → Repository URL** (Add repository), paste

```
https://shiprzq.github.io/valenced-plugins/index.json
```

and add it. The plugin list appears immediately; install from the `latest` channel. Installed
plugins get update checks against this repository, which is exactly why the `generated` timestamp
and the artifact hashes exist.

---

## Adding another plugin

1. Create `plugins/<name>/manifest.json`:

   ```json
   {
   	"format": 1,
   	"id": "com.example.plugin",
   	"name": "Example",
   	"description": "One sentence that shows up in the repository listing.",
   	"author": "You",
   	"version": "1.0.0",
   	"dependencies": {
   		"valenced.api": { "version": ">=1 <2" },
   		"discord": { "version": "*" }
   	},
   	"dist": { "script": "index.js" }
   }
   ```

   `dist.script` is the bundle path inside the ZIP (`index.js` by default) and must not escape it.
   `valenced.api` and `discord` are reserved dependencies: both are mandatory and neither may be
   marked `optional`.

2. Add the entry point at `plugins/<name>/js/index.ts` with `export default plugin({ ... })`.

3. `npm run build && npm run zip` locally, then commit, tag `v1.1.0`, push.

The version in the manifest and the tag must agree. `dist/<plugin-id>.zip` is named after the
manifest id, so the asset name — not a file name you choose — is what the generator matches.

### Channels

`build-index.mjs` derives channels automatically: `latest` is the highest **stable** version
(falling back to the highest version overall), and `beta` appears when a higher prerelease exists.
Override per plugin in `repo.config.json`:

```json
{
	"name": "Valenced Plugins",
	"description": "Plugin repository served over GitHub Pages.",
	"channels": { "com.redpen.plugin": { "latest": "1.0.0", "canary": "1.1.0-beta1" } }
}
```

An override naming a version that does not exist is ignored; the emitted channel map is checked
again against `versions` before anything is written.

---

## Local verification

```bash
npm ci
npm run build          # bundles every plugin with the official CLI
npm run zip            # dist/<plugin-id>.zip, deterministic
npm run validate       # manifest gate, exit 1 with the offending field
npm test               # scripts/test-pipeline.mjs: 45 offline checks
```

`npm test` needs no network and no GitHub: it builds archives in memory, stands up a mock of the
REST API on `127.0.0.1`, runs `build-index.mjs` against it, and asserts that `sha256`/`size` match
the exact ZIP bytes, that dependencies mirror the artifact, that channels resolve, that a
re-zip is byte-identical, and that the fail-loud paths (orphan asset, plugin with no release,
tag/manifest mismatch) all exit non-zero.

To exercise the generator against the real API without deploying:

```bash
GITHUB_REPOSITORY=shiprzq/valenced-plugins GITHUB_TOKEN=$(gh auth token) node scripts/build-index.mjs --out /tmp/index.json
ALLOW_UNRELEASED=1 GITHUB_REPOSITORY=shiprzq/valenced-plugins node scripts/build-index.mjs --out /tmp/empty.json
```

---

## Troubleshooting

**`index.json` is a 404 on the first push.** Expected. Pages is wired to releases; publish a
release (step 5) and wait for the deploy. Check **Actions → Deploy repository index** ran, and that
Settings → Pages → Source is *GitHub Actions* rather than a branch.

**`Resource not accessible by integration` when the release step runs.** The workflow token is
read-only: Settings → Actions → General → Workflow permissions → *Read and write* (step 4). A
`403` on the *release list* call in the Pages job means the repository is private — make it public,
or the client cannot reach the assets either.

**The release exists but has no ZIP.** `npm run build` or `npm run zip` failed earlier in the same
job: read the step log. The usual cause is a manifest whose `dist.script` bundle was never built
(`plugins/<dir>/build/js/index.js` missing), which `zip-plugins.mjs` reports by name.

**The index is stale after a successful deploy.** Pages and its CDN cache for a minute or two;
`generated` changes on every deploy, so compare it before assuming a bug. Hard re-run the deploy
with **Actions → Deploy repository index → Run workflow** (`workflow_dispatch`), which rebuilds the
index from the current releases rather than from a cached artifact.

**A release created by CI does not trigger the Pages workflow.** GitHub suppresses events authored
by `GITHUB_TOKEN`, so `release: published` alone would miss releases created by `build.yml`. That
is why `pages.yml` also listens to `workflow_run` on *Build and release*. Manually published
releases and `workflow_dispatch` are the other two paths, and all three converge on the same
concurrency group.

**The first tag push did nothing.** On a brand-new repository GitHub occasionally drops the
first tag-push event when the tag arrives in the same second as the branch (the workflow files are
being indexed). Re-push the tag — `git push --delete origin v1.0.0 && git push origin v1.0.0` —
which is safe before a release exists. `scripts/setup-github.sh` detects this and retries once.

**The generator refuses to run.** It fails rather than publishes a partial index. The message names
the offending asset or plugin:

- *release assets without a matching `plugins/<dir>/manifest.json`* — delete the stale asset, or
  add the source and re-release;
- *plugins with no release asset* — push a `v*` tag, or set `ALLOW_UNRELEASED=1` to skip them
  (useful for the very first commit, before anything is published);
- *ZIP manifest.json differs from plugins/\*/manifest.json* — commit the manifest, then re-tag;
- *the same plugin version is published by more than one release* — delete the stale asset.

**Valenced says the repository cannot be read.** Fetch the URL in a browser: it must return JSON
starting with `{"format": 1`. HTML means Pages is serving the branch source or a 404 page.

---

## Design notes

- **Zero runtime dependencies in the release tooling.** `build-index.mjs`, `zip-plugins.mjs`,
  `validate-manifests.mjs` and `lib/*` use only `node:` built-ins and native `fetch`. The Pages job
  therefore needs no `npm ci` at all: fewer moving parts on the deploy path.
- **The index is generated, never edited.** `index.json` is committed only as an empty bootstrap
  stub and is overwritten in the Pages artifact on every deploy. It is not in `.gitignore` so a
  fresh clone has something valid to serve.
- **No ZIPs in git.** Archives exist only as release assets, so history stays small and there is a
  single source of truth per version.
- **Deterministic archives.** Fixed DOS timestamps, fixed entry order, deflate level 9 (store when
  deflating does not help). Rebuilding the same sources on any machine yields the same SHA-256,
  which makes the hash in the index reproducible outside CI.
- **`generated` defeats sticky caches.** No Cloudflare `_headers`, no query strings, no CDN
  configuration: the timestamp inside the document changes whenever the document changes.
