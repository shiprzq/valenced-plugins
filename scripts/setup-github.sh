#!/usr/bin/env bash
# Creates the public GitHub repository, enables Pages (Actions source), grants the workflow
# token write permission, pushes main, publishes the first release tag, then waits for the
# deploy and prints the index URL.
#
#   GH_TOKEN=<pat> ./scripts/setup-github.sh <OWNER> <REPO> [VERSION]
#   DRY_RUN=1 ./scripts/setup-github.sh <OWNER> <REPO> [VERSION]     # print the plan only
#
# Token permissions on that repository: Contents (write), Administration (write, to create the
# repository and enable Pages), Workflows (write, to push .github/workflows), Pages (write).
# A classic PAT needs the `repo` and `workflow` scopes instead.
#
# The token is read from the environment and never written to disk.

set -euo pipefail

OWNER="${1:-}"
REPO="${2:-}"
VERSION="${3:-1.0.0}"
DRY_RUN="${DRY_RUN:-0}"
TAG="v${VERSION}"
API="https://api.github.com"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_MANIFEST="plugins/redpen/manifest.json"

if [[ -z "$OWNER" || -z "$REPO" ]]; then
	printf 'usage: GH_TOKEN=<pat> %s <OWNER> <REPO> [VERSION]\n' "$0" >&2
	exit 2
fi
if [[ "$DRY_RUN" != "1" && -z "${GH_TOKEN:-}" ]]; then
	printf 'error: GH_TOKEN is not set\n' >&2
	exit 2
fi

say() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

api() {
	local method="$1"
	shift
	curl -sS -X "$method" \
		-H "Authorization: Bearer ${GH_TOKEN:-}" \
		-H 'Accept: application/vnd.github+json' \
		-H 'X-GitHub-Api-Version: 2022-11-28' \
		"$@"
}

api_status() {
	local method="$1"
	shift
	curl -sS -o /dev/null -w '%{http_code}' -X "$method" \
		-H "Authorization: Bearer ${GH_TOKEN:-}" \
		-H 'Accept: application/vnd.github+json' \
		-H 'X-GitHub-Api-Version: 2022-11-28' \
		"$@"
}

# Prints one top-level string field of a JSON document read from stdin.
json_field() {
	node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];process.stdout.write(v==null?"":String(v))}catch{}})=' "$1"
}

run() {
	if [[ "$DRY_RUN" == "1" ]]; then
		printf '    [dry-run] %s\n' "$*"
	else
		"$@"
	fi
}

cd "$ROOT"

# The manifest version and the tag must agree, or build.yml fails on purpose.
MANIFEST_VERSION="$(
	node -e 'const j=require("node:fs").readFileSync(process.argv[1],"utf8");process.stdout.write(String(JSON.parse(j).version))' "$PLUGIN_MANIFEST"
)"
if [[ "$VERSION" != "$MANIFEST_VERSION" ]]; then
	printf 'error: %s does not match %s.\n' "$TAG" "$PLUGIN_MANIFEST ($MANIFEST_VERSION)" >&2
	printf '       bump the manifest, commit, then tag again.\n' >&2
	exit 2
fi

if [[ -n "$(git status --porcelain)" ]]; then
	printf 'error: the working tree has uncommitted changes; commit them first.\n' >&2
	git status --short >&2
	exit 2
fi

# ---------------------------------------------------------------- 1. repository
say "1/5 Repository ${OWNER}/${REPO}"
EXISTS="$(api_status GET "${API}/repos/${OWNER}/${REPO}")"
if [[ "$EXISTS" == "200" ]]; then
	note "already exists"
elif [[ "$EXISTS" == "404" ]]; then
	if [[ "$DRY_RUN" == "1" ]]; then
		printf '    [dry-run] create public repository %s/%s\n' "$OWNER" "$REPO"
	else
		AUTHENTICATED_LOGIN="$(api GET "${API}/user" | json_field login)"
		if [[ "$OWNER" == "$AUTHENTICATED_LOGIN" ]]; then
			note "creating under ${OWNER}"
			api POST "${API}/user/repos" -o /dev/null \
				-d "{\"name\":\"${REPO}\",\"private\":false,\"has_wiki\":false,\"description\":\"Valenced plugin repository: release assets plus a generated index.json served over GitHub Pages.\"}"
		else
			note "creating under organisation ${OWNER}"
			api POST "${API}/orgs/${OWNER}/repos" -o /dev/null \
				-d "{\"name\":\"${REPO}\",\"private\":false,\"has_wiki\":false,\"description\":\"Valenced plugin repository: release assets plus a generated index.json served over GitHub Pages.\"}"
		fi
		note "created"
	fi
else
	printf 'error: cannot read %s/%s (HTTP %s). Check the token scope and the owner name.\n' \
		"$OWNER" "$REPO" "$EXISTS" >&2
	exit 1
fi

# ---------------------------------------------------------------- 2. pages source
say "2/5 Pages source = GitHub Actions"
PAGES_STATUS="$(api_status GET "${API}/repos/${OWNER}/${REPO}/pages")"
if [[ "$PAGES_STATUS" == "200" ]]; then
	BUILD_TYPE="$(api GET "${API}/repos/${OWNER}/${REPO}/pages" | json_field build_type)"
	note "Pages already enabled (build_type=${BUILD_TYPE:-unknown})"
	if [[ -n "${BUILD_TYPE:-}" && "$BUILD_TYPE" != "workflow" ]]; then
		printf 'error: Pages is deployed from a branch (%s).\n' "$BUILD_TYPE" >&2
		printf '       Settings -> Pages -> Source: GitHub Actions, then re-run.\n' >&2
		exit 1
	fi
else
	if [[ "$DRY_RUN" == "1" ]]; then
		printf '    [dry-run] POST %s/repos/%s/%s/pages {"build_type":"workflow"}\n' "$API" "$OWNER" "$REPO"
	else
		api POST "${API}/repos/${OWNER}/${REPO}/pages" -d '{"build_type":"workflow"}' -o /dev/null
		note "enabled with build_type=workflow"
	fi
fi

# ---------------------------------------------------------------- 3. workflow permissions
say "3/5 Workflow token permissions = read/write"
run api PUT "${API}/repos/${OWNER}/${REPO}/actions/permissions/workflow" -o /dev/null \
	-f default_workflow_permissions=write -F can_approve_pull_request_reviews=true
note "GITHUB_TOKEN can create the release"

# ---------------------------------------------------------------- 4. push main
say "4/5 Push main"
if git remote get-url origin >/dev/null 2>&1; then
	run git remote set-url origin "https://github.com/${OWNER}/${REPO}.git"
else
	run git remote add origin "https://github.com/${OWNER}/${REPO}.git"
fi
if [[ "$DRY_RUN" == "1" ]]; then
	printf '    [dry-run] git push -u origin main  (authenticated with GH_TOKEN)\n'
else
	git -c http.extraheader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')" \
		push -u origin main
fi

# ---------------------------------------------------------------- 5. first release tag
say "5/5 Publish ${TAG}"
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
	note "tag already exists locally"
else
	run git tag -a "$TAG" -m "Release ${VERSION}"
fi
if [[ "$DRY_RUN" == "1" ]]; then
	printf '    [dry-run] git push origin %s  (authenticated with GH_TOKEN)\n' "$TAG"
else
	git -c http.extraheader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')" \
		push origin "$TAG"
fi

INDEX_URL="https://${OWNER}.github.io/${REPO}/index.json"

if [[ "$DRY_RUN" == "1" ]]; then
	printf '\nDry run complete. Nothing was created or pushed.\n'
	note "index URL would be: ${INDEX_URL}"
	exit 0
fi

# ---------------------------------------------------------------- 6. watch
say "Watching the release and deploy workflows (about two minutes)"
WATCH_EXIT=0
node scripts/gh-watch.mjs "$OWNER" "$REPO" "$TAG" 900 || WATCH_EXIT=$?

printf '\n'
if [[ "$WATCH_EXIT" == "0" ]]; then
	say "Deployed"
else
	say "Not confirmed — open the Actions tab: https://github.com/${OWNER}/${REPO}/actions"
fi
note "Repository URL for Valenced: ${INDEX_URL}"
note "Release:                      https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}"
note "Verify:                       curl -s ${INDEX_URL} | head -30"
printf '\nPaste the Repository URL into Valenced -> Plugins -> Repository URL -> Add repository.\n'
printf 'Then revoke the token you used here: https://github.com/settings/tokens\n'

exit "$WATCH_EXIT"
