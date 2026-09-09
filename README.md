# Built North Composer repository

Private Composer index (`packages.json`) for Built North **plugins** and **libraries**.

This is not a WordPress plugin.

The development monorepo (`basecamp`) does **not** consume this index. Other projects (Journey, client sites, themes, custom plugins) do.

The full developer playbook (what to release, in what order, what the zip contains, how this index is rebuilt) lives in the [basecamp README — Releasing Polaris to other projects](https://github.com/builtnorth/basecamp#releasing-polaris-to-other-projects). This file is the **consumer** half: `auth.json`, repository URL, and what to `require` where.

## How it ties together

```text
nested package repo  →  GitHub Release zip  →  this repo’s packages.json  →  consumer composer update
         ↑                        ↑                      ↑
   develop in basecamp     reusable workflow        generate.mjs on
                           (plugin or library)      plugin-released /
                                                    package-released
```

1. A developer cuts a release on `builtnorth/polaris-blocks` (or `polaris`, `wp-config`, …) via GitHub Actions.
2. That workflow publishes a GitHub Release **and** dispatches this repo (`plugin-released` or `package-released`).
3. This repo runs `node bin/generate.mjs`, commits `packages.json`, pushes `main`.
4. Consumers already pointing at `https://raw.githubusercontent.com/builtnorth/composer/main` pick it up on the next `composer update`.

`plugins.json` and `libraries.json` in this repo are the allow-lists. A package with no row here never appears in the index.

## Two package kinds

| | WordPress plugins (`polaris-blocks`, …) | Libraries (`polaris`, `wp-baseline`, …) |
|---|---|---|
| `type` | `wordpress-plugin` | `library` (or `wp-cli-package`) |
| `dist` | Mirrored zip on this repo (`raw.githubusercontent.com/.../dist/{repo}-{version}.zip`) | GitHub **zipball** of the tag (`/repos/.../zipball/vX.Y.Z`) |
| `require` | omitted | kept from that tag’s `composer.json` |
| `autoload` | omitted (zip boots itself) | kept so Composer can autoload the package |

Libraries use GitHub **zipball** URLs. Composer downloads those with `github-oauth`.

Plugin release zips are **mirrored into `dist/`** on this repo during rebuild. GitHub’s release-asset API needs `Accept: application/octet-stream`; Composer does not send that header, so API asset URLs in `packages.json` produce JSON files that fail to unzip. Consumers fetch mirrored zips via `http-basic` on `raw.githubusercontent.com` (same `auth.json` as `packages.json`).

## Consumer setup

Every consumer **must** have Composer GitHub auth. Without `auth.json` (or `COMPOSER_AUTH`), Composer cannot read this private index or download zips.

### 1. `auth.json` in the project (required)

Put `auth.json` next to the `composer.json` that will run Composer. **Do not commit it.**

```json
{
  "github-oauth": {
    "github.com": "YOUR_GITHUB_TOKEN"
  },
  "http-basic": {
    "raw.githubusercontent.com": {
      "username": "x-access-token",
      "password": "YOUR_GITHUB_TOKEN"
    }
  }
}
```

The token needs `repo` (or Contents: read on `builtnorth/composer` plus the package repos).

- `http-basic` on `raw.githubusercontent.com` — read `packages.json`
- `github-oauth` on `github.com` — download zipballs (and, later, plugin zips)

A global `~/.composer/auth.json` also works if it includes both blocks.

### 2. One repository URL

```json
{
  "repositories": [
    {
      "type": "composer",
      "url": "https://raw.githubusercontent.com/builtnorth/composer/main"
    },
    {
      "type": "composer",
      "url": "https://wpackagist.org",
      "only": ["wpackagist-plugin/*", "wpackagist-theme/*"]
    }
  ]
}
```

Do **not** add `type: vcs` GitHub URLs for packages this index already lists.

### 3. What to `require` where

**Site root** (Journey, client Bedrock): polaris **plugins** only. Do not `require builtnorth/polaris` here — it is already inside each plugin zip.

```json
"require": {
  "builtnorth/polaris-blocks": "^1.5",
  "builtnorth/wp-config": "*",
  "builtnorth/wp-cli-builtnorth": "*"
}
```

**Theme or custom plugin** that must keep working if polaris-* plugins are off: require the **library**. Composer pulls `polaris` plus `wp-baseline`, `job-dispatcher`, and the rest into **that** package’s `vendor/`.

```json
"require": {
  "php": ">=8.1",
  "builtnorth/polaris": "^2.3"
}
```

`Framework::boot()` still runs only once if a polaris plugin is also active.

### 4. Install

```bash
composer update
```

For plugins, confirm `wp-content/plugins/polaris-blocks/vendor/` exists. If it does not, Composer is still using a VCS git URL.

When switching a site that previously installed plugins via git, delete the old plugin folders first, then `composer update`.

## Rebuild

```bash
node bin/generate.mjs
```

GitHub Actions rebuilds on `workflow_dispatch` and on `repository_dispatch` (`plugin-released` or `package-released`). The reusable plugin/library release workflows fire those events. You can also run **Rebuild Composer repository** on this repo’s Actions tab.

Needs `POLARIS_PLUGIN_GITHUB_TOKEN` (repo-scoped PAT) so `generate.mjs` can list private GitHub Releases.
