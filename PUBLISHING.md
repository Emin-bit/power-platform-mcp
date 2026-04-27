# Publishing power-platform-mcp

End-to-end guide for distributing this MCP server publicly via npm + GitHub.

> Audience: project maintainer (publisher). End-user install instructions are in [README.md](README.md).

---

## One-time setup

### 1. npm account

```bash
# Make an account at https://www.npmjs.com/signup (free)
# Then login locally:
npm login
```

Verify: `npm whoami` should print your username.

### 2. Verify the package name is available

```bash
npm view @emin-bit/power-platform-mcp 2>&1 | head -5
```

If you see `npm error 404`, the name is free. If you see metadata or `403 Package name too similar`, the name is taken — switch to a scoped package (e.g., `@yourname/power-platform-mcp`) which is always available under your npm username scope.

This package is currently published as `@emin-bit/power-platform-mcp`. To fork under your own scope, edit `package.json`:
```json
"name": "@yourname/power-platform-mcp",
```
And the GitHub URLs accordingly. First publish of a scoped package needs `--access=public` (npm defaults scoped to private):
```bash
npm publish --access=public
```
Subsequent publishes don't need the flag.

### 3. GitHub repo

```bash
cd "/Users/eminmujabasic/Desktop/MCP za PowerPlatform"

# Initialize if not already
git init
git add .
git commit -m "Initial commit — v1.0.3"

# Create the repo on GitHub (via gh CLI or manually at github.com/new)
gh repo create Emin-bit/power-platform-mcp --public --source=. --remote=origin --push
```

Update `package.json` repository/homepage/bugs URLs to match the actual repo location.

---

## Publishing a new version

### Standard release flow

```bash
# 1. Update CHANGELOG.md with a new [X.Y.Z] entry summarizing changes
# 2. Bump version (this auto-tags + commits)
npm version patch       # 1.0.3 → 1.0.4 (bugfix)
npm version minor       # 1.0.3 → 1.1.0 (feature)
npm version major       # 1.0.3 → 2.0.0 (breaking change)

# 3. Push the version commit and tag to GitHub
git push && git push --tags

# 4. Publish to npm (prepublishOnly runs clean + build + smoke test automatically)
npm publish
```

The `prepublishOnly` script in `package.json` ensures you cannot publish if:
- TypeScript build fails
- Smoke test fails (any of the 9 assertions in `smoke-test.mjs`)

### Dry-run before publishing

```bash
# See what would be published without actually pushing
npm publish --dry-run

# See exact tarball contents
npm pack --dry-run
```

### Publishing pre-releases

```bash
# Mark as pre-release (e.g. for 1.1.0-beta.1)
npm version prerelease --preid=beta
npm publish --tag beta

# End users opt in by adding @beta:
# "args": ["-y", "@emin-bit/power-platform-mcp@beta"]
```

The default `latest` tag stays on the last stable release.

---

## Post-publish verification

```bash
# 1. View the published package
npm view @emin-bit/power-platform-mcp

# 2. Test install on a clean directory
mkdir -p /tmp/test-install && cd /tmp/test-install
npx -y @emin-bit/power-platform-mcp <<EOF
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}
EOF
# Should print initialize response with server instructions

# 3. Sanity-check on another machine (or VM)
# Add to Claude Desktop config, restart, verify all 101 tools show up
```

---

## Updating end users

End users running with `npx -y @emin-bit/power-platform-mcp` automatically get the latest version on next Claude Desktop start (npx fetches if cache is stale). No action required from them.

End users who pinned a specific version (`@emin-bit/power-platform-mcp@1.0.5`) need to update their config manually.

---

## Optional: list on MCP registries

These are third-party MCP marketplaces. Listing increases discoverability.

- **Smithery.ai**: <https://smithery.ai/server/new> — submit by GitHub repo URL
- **Glama.ai**: <https://glama.ai/mcp/servers> — submit similarly
- **Anthropic's MCP server directory**: see <https://modelcontextprotocol.io/examples> — community-curated

Each registry has its own submission flow but all want a public GitHub repo + npm package as inputs.

---

## Optional: distribute as a Cowork plugin (Anthropic-specific)

If your audience is on Claude Cowork inside an org, you can package this MCP + any companion skills into a `.plugin` file using the `cowork-plugin-management:create-cowork-plugin` skill in your Claude session. Plugins are easier to share inside an org than asking everyone to edit JSON config files.

This is complementary to npm — same MCP, different distribution channel.

---

## Optional: private distribution (org-only)

If you don't want public distribution:

- **GitHub Packages**: free, scoped to your GitHub org. Use `@yourorg/power-platform-mcp` name and add a `.npmrc` with `@yourorg:registry=https://npm.pkg.github.com`. Users authenticate with a GitHub PAT.
- **Private npm registry**: Verdaccio (self-hosted) or npm's paid private registry.
- **Direct GitHub install**: users do `npx -y github:yourorg/power-platform-mcp` — no npm publish needed, but slower and requires git on the user's machine.

---

## Maintenance checklist

- [ ] CHANGELOG entry for every published version
- [ ] Run `npm test` locally before pushing
- [ ] Tag every published version on GitHub (`npm version` does this automatically)
- [ ] Watch for new pac/pacx releases — they may add commands worth wrapping or change flags worth re-verifying. Quick check: `pac --version` vs the version pinned in last verified release.
- [ ] Watch GitHub issues for user-reported bugs
- [ ] Periodically refresh prerequisites in README (Node version, .NET version, pac/pacx versions verified against)
