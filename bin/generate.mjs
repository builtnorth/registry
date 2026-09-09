#!/usr/bin/env node

/**
 * Build a Composer repository (packages.json) from GitHub Releases.
 *
 * Plugins: dist is the packaged zip (includes vendor/). No require, no source,
 * no autoload — the zip boots itself.
 *
 * Libraries: dist is the source zip (no vendor/). Keep require + autoload so
 * Composer builds vendor/ in the consumer package (theme, custom plugin).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORG = "builtnorth";
const INCLUDE_PRERELEASE = process.argv.includes("--prerelease");
const RELEASED_PLUGIN = process.env.RELEASED_PLUGIN || "";
const RELEASED_VERSION = process.env.RELEASED_VERSION || "";

function ghJson(args) {
	const stdout = execFileSync("gh", args, {
		encoding: "utf8",
		maxBuffer: 20 * 1024 * 1024,
	});
	return JSON.parse(stdout);
}

function normalizeVersion(tag) {
	return String(tag).replace(/^v/, "");
}

function versionNormalized(version) {
	const parts = String(version).split(".");
	while (parts.length < 4) {
		parts.push("0");
	}
	return parts.slice(0, 4).join(".");
}

function listReleases(repo) {
	const releases = ghJson([
		"api",
		`repos/${ORG}/${repo}/releases`,
		"--paginate",
	]);
	return (Array.isArray(releases) ? releases : []).filter((release) => {
		if (release.draft) {
			return false;
		}
		if (release.prerelease && !INCLUDE_PRERELEASE) {
			return false;
		}
		return true;
	});
}

function pickZipAsset(release, expectedNames) {
	const assets = Array.isArray(release.assets) ? release.assets : [];
	const usable = (asset) => Number.isInteger(Number(asset?.id)) && Number(asset.id) > 0;
	const names = new Set(expectedNames.filter(Boolean));
	const exact = assets.find((asset) => names.has(asset.name) && usable(asset));
	if (exact) {
		return exact;
	}
	return assets.find(
		(asset) =>
			typeof asset.name === "string" &&
			asset.name.endsWith(".zip") &&
			!asset.name.toLowerCase().includes("source") &&
			usable(asset),
	);
}

/**
 * Direct plugin release download URL.
 *
 * GitHub release download URLs (github.com/releases/download/...) are served
 * as plain redirects and work with http-basic auth on private repos. No
 * Accept header workaround needed, and no mirroring into this repo.
 * Each plugin release uploads a zip named {repo}.zip.
 */
function resolvePluginDistUrl(repo, _version, _asset, tag) {
	return `https://github.com/${ORG}/${repo}/releases/download/${tag}/${repo}.zip`;
}

function composerZipballUrl(repo, tag) {
	// Composer natively downloads api.github.com zipball/tarball URLs with
	// github-oauth. Release asset URLs return JSON unless Accept is
	// application/octet-stream, which Composer does not send.
	return `https://api.github.com/repos/${ORG}/${repo}/zipball/${tag}`;
}

function readComposerJsonAtRef(repo, ref) {
	try {
		const payload = ghJson([
			"api",
			`repos/${ORG}/${repo}/contents/composer.json?ref=${encodeURIComponent(ref)}`,
		]);
		if (!payload?.content) {
			return null;
		}
		const decoded = Buffer.from(payload.content, "base64").toString("utf8");
		return JSON.parse(decoded);
	} catch {
		return null;
	}
}

const plugins = JSON.parse(
	fs.readFileSync(path.join(ROOT, "plugins.json"), "utf8"),
);
const libraries = JSON.parse(
	fs.readFileSync(path.join(ROOT, "libraries.json"), "utf8"),
);

const packages = {};
const skipped = [];

for (const plugin of plugins) {
	const versions = {};

	for (const release of listReleases(plugin.repo)) {
		const version = normalizeVersion(release.tag_name);
		if (!/^\d+\.\d+\.\d+/.test(version)) {
			skipped.push(`${plugin.repo}@${release.tag_name} (non-semver)`);
			continue;
		}

		const asset = pickZipAsset(release, [plugin.zip]);
		if (!asset) {
			skipped.push(`${plugin.repo}@${release.tag_name} (no zip asset)`);
			continue;
		}

		const distUrl = resolvePluginDistUrl(plugin.repo, version, asset, release.tag_name);
		if (!distUrl) {
			skipped.push(`${plugin.repo}@${release.tag_name} (no dist URL)`);
			continue;
		}

		versions[version] = {
			name: plugin.name,
			version,
			version_normalized: versionNormalized(version),
			type: "wordpress-plugin",
			dist: {
				type: "zip",
				url: distUrl,
			},
		};
	}

	if (Object.keys(versions).length === 0) {
		skipped.push(`${plugin.repo} (no usable plugin releases)`);
		continue;
	}

	packages[plugin.name] = versions;
}

for (const library of libraries) {
	const versions = {};

	for (const release of listReleases(library.repo)) {
		const version = normalizeVersion(release.tag_name);
		if (!/^\d+\.\d+\.\d+/.test(version)) {
			skipped.push(`${library.repo}@${release.tag_name} (non-semver)`);
			continue;
		}

		const composerJson = readComposerJsonAtRef(library.repo, release.tag_name);
		if (!composerJson) {
			skipped.push(`${library.repo}@${release.tag_name} (no composer.json)`);
			continue;
		}

		const distUrl = composerZipballUrl(library.repo, release.tag_name);

		const require = composerJson.require && typeof composerJson.require === "object"
			? composerJson.require
			: {};
		const autoload = composerJson.autoload && typeof composerJson.autoload === "object"
			? composerJson.autoload
			: undefined;

		const entry = {
			name: library.name,
			version,
			version_normalized: versionNormalized(version),
			type: composerJson.type || "library",
			require,
			dist: {
				type: "zip",
				url: distUrl,
				reference: release.tag_name,
			},
		};

		if (autoload) {
			entry.autoload = autoload;
		}

		versions[version] = entry;
	}

	if (Object.keys(versions).length === 0) {
		skipped.push(`${library.repo} (no usable library releases)`);
		continue;
	}

	packages[library.name] = versions;
}

const output = {
	packages,
};

const outPath = path.join(ROOT, "packages.json");
fs.writeFileSync(outPath, `${JSON.stringify(output, null, "\t")}\n`);

const packageCount = Object.keys(packages).length;
const versionCount = Object.values(packages).reduce(
	(sum, versions) => sum + Object.keys(versions).length,
	0,
);

console.log(
	`Wrote ${outPath} (${packageCount} packages, ${versionCount} versions)`,
);
if (skipped.length > 0) {
	console.log("Skipped:");
	for (const line of skipped) {
		console.log(`  ${line}`);
	}
}
