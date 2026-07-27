# Release Process

This repository publishes public npm packages from a Bun workspace. Packages use independent semantic versions. A release is driven by a Changeset and a reviewed version pull request, not by a manually created Git tag.

## Overview

```text
Feature pull request with a Changeset
  -> merge to main
  -> Version Packages pull request
  -> merge the version pull request
  -> npm publish through GitHub Actions OIDC
  -> Git tag and GitHub Release
```

The `package.json` version is the source of truth for a published package. Git tags and GitHub Releases are created after npm accepts the package version, so they are release records rather than release triggers.

## Contributor Flow

For any change that should publish a package, create a Changeset in the same pull request:

```bash
bun run changeset
```

Select every affected package and choose its SemVer bump:

- `patch` for compatible bug fixes
- `minor` for compatible features
- `major` for breaking changes

Commit the generated `.changeset/*.md` file with the implementation. Do not edit a package version, run `npm version`, publish to npm, or create a release tag in a feature pull request.

The `CI` workflow runs on every pull request and on every push to `main`. It installs the locked dependencies, type-checks every package, runs every package test script, and verifies the npm tarball with `npm pack --dry-run`.

## Release Flow

When a pull request containing a Changeset is merged into `main`, the `Release` workflow creates or updates a `Version Packages` pull request. That pull request applies the selected versions and updates package changelogs.

Review the generated versions and changelog entries, then squash merge the `Version Packages` pull request. Its merge triggers the release workflow again. With no remaining Changesets, it publishes versions that do not already exist in npm.

After a successful publish, Changesets creates the package version tags and GitHub Releases. A push to `main` with no pending Changesets and no unpublished versions is a no-op. `workflow_dispatch` runs the same state-based workflow and can create a version pull request or publish a pending version. It is not a dry run.

## Security

Each public npm package has its own npm Trusted Publisher configuration for `.github/workflows/release.yml` in `OiAnthony/pi-packages`. The workflow runs on a GitHub-hosted runner and has `id-token: write`, so npm exchanges its GitHub Actions OIDC token for a short-lived publishing credential.

Do not add `NPM_TOKEN` to GitHub secrets. On npm, set each package to require two-factor authentication and disallow token publishing after its Trusted Publisher is configured. This keeps routine releases bound to the reviewed GitHub workflow.

The `main` branch is protected by a GitHub ruleset. Changes must arrive through a pull request, use squash merge, pass the `verify` check, resolve review conversations, and cannot force-push or delete the branch.

## Bootstrapping a New Package

npm requires a package to exist before it can receive a Trusted Publisher configuration. For a newly added public package:

1. Prepare and review the package pull request, including its scoped name, public `publishConfig`, repository metadata, tests, and package files.
2. Before merging that pull request, publish its initial version from an authenticated maintainer terminal and complete npm two-factor authentication.
3. Configure the package's Trusted Publisher for `OiAnthony/pi-packages` and `release.yml` with the `npm trust github` command.
4. Enable the npm package setting that requires two-factor authentication and disallows token publishing.
5. Merge the initial package pull request. All later releases use the normal Changeset flow.

A package must receive this bootstrap once. Every later version is published only by the release workflow.

## Recovery

Use a manual release run only to recover a failed or interrupted release:

```bash
gh workflow run Release --repo OiAnthony/pi-packages
```

Check the package version on npm and the corresponding GitHub Release before retrying. npm versions are immutable, so a failed publish must be diagnosed before creating another version.
