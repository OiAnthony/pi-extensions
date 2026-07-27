# Development Guide

This guide covers how to add and maintain an independently published Pi package in this repository. Read [Release Process](releasing.md) for the release automation and security model.

## Workspace Rules

- Keep all publishable packages under `packages/<package-name>/`.
- Install dependencies only from the repository root with `bun install`.
- Keep the root `bun.lock` as the workspace lockfile.
- Make each package self-contained: its manifest, README, tests, shipped files, and license must describe the package without relying on repository-only documentation.
- Use the npm scope `@oipsanthony` for public packages.

## Create a Package

Start with this layout for an extension package:

```text
packages/pi-example/
  extensions/
    index.ts
    index.test.ts
  .npmignore
  README.md
  LICENSE
  package.json
  tsconfig.json
```

Use a package manifest that declares only the files and runtime peers required by the package:

```json
{
  "name": "@oipsanthony/pi-example",
  "version": "0.1.0",
  "description": "One sentence describing the Pi package.",
  "type": "module",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/OiAnthony/pi-packages.git",
    "directory": "packages/pi-example"
  },
  "bugs": {
    "url": "https://github.com/OiAnthony/pi-packages/issues"
  },
  "homepage": "https://github.com/OiAnthony/pi-packages/tree/main/packages/pi-example#readme",
  "license": "MIT",
  "files": [
    "extensions",
    "LICENSE",
    "package.json",
    "README.md"
  ],
  "scripts": {
    "test": "bun test extensions",
    "typecheck": "tsc --noEmit --project tsconfig.json"
  },
  "publishConfig": {
    "access": "public"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": [
      "extensions/index.ts"
    ]
  }
}
```

Add peer dependencies only for Pi packages imported by the package. For example, add `@mariozechner/pi-tui` only when the extension imports its public API. Keep `files` narrow and inspect the tarball. When a shipped resource directory also contains tests, exclude them with `.npmignore`, for example `extensions/**/*.test.ts`.

The `pi` field is the package interface used by Pi. Change it to declare the resources the package ships, such as extensions, skills, prompts, or themes. Keep resource paths relative to the package directory.

Use this `tsconfig.json` for TypeScript resources unless the resource has a documented exception:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": [
    "extensions/**/*"
  ],
  "exclude": [
    "node_modules",
    "dist"
  ]
}
```

## Local Development

Run the repository-wide checks before opening a pull request:

```bash
bun install
bun run typecheck
bun run test
bun run pack:check
```

Use `bun run pack:check` as the final package boundary check. It runs `npm pack --dry-run` for every public workspace package and prints the exact tarball contents.

For a focused loop, run the package scripts directly:

```bash
bun run --filter @oipsanthony/pi-example typecheck
bun run --filter @oipsanthony/pi-example test
```

Install the package in Pi from npm only after it has been published. During local development, test the resource from its workspace path or through the package-specific test suite.

## Prepare a Change

Create a branch and implement the package change with its tests and README update. Any user-visible package change also needs a Changeset:

```bash
bun run changeset
```

Select every package affected by the change and choose the SemVer bump:

- `patch`: compatible fix or documentation correction that changes the package release
- `minor`: compatible feature or configuration addition
- `major`: incompatible behavior, removed configuration, or changed public contract

Commit the generated `.changeset/*.md` file with the code. Do not edit package versions manually. Do not run `npm version`, `npm publish`, or create tags for routine releases.

Open a pull request. The `verify` check must pass before it can be squash merged into `main`.

## What Happens After Merge

A merged package change with a Changeset causes GitHub Actions to create or update a `Version Packages` pull request. Review its versions and changelog entries. When that PR is squash merged, GitHub Actions publishes each new package version through npm OIDC, then creates package tags and GitHub Releases.

A normal feature pull request never publishes npm directly. The version pull request is the review gate for the release.

## Bootstrap a New Public Package

A new npm package needs one manual bootstrap because npm requires the package to exist before a Trusted Publisher can be configured.

After the initial package pull request is approved but before it is merged:

1. Run the repository checks and inspect the tarball.
2. Publish the initial version from the package branch with an authenticated npm maintainer account:

   ```bash
   npm publish --workspace=@oipsanthony/pi-example --access public
   ```

3. Complete npm two-factor authentication.
4. Bind the package to the release workflow:

   ```bash
   npm trust github @oipsanthony/pi-example \
     --repo OiAnthony/pi-packages \
     --file release.yml \
     --allow-publish
   ```

5. In the npm package settings, select `Require 2FA and disallow tokens`.
6. Merge the initial package pull request.

The merge is safe after bootstrap because npm already contains the initial version. Every later version follows the standard Changeset and Version Packages pull request flow.

## Release Recovery

Do not retry a release by manually changing a version or creating a tag. First inspect the failed GitHub Actions run, confirm whether npm accepted the version, and read [Release Process](releasing.md#recovery).

A manual release run is available for recovery:

```bash
gh workflow run Release --repo OiAnthony/pi-packages
```

It is state-based and can create a version pull request or publish a pending version. Use it only after understanding the current npm and Changeset state.
