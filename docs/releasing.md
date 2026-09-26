# Releasing @litzrsh/umio

The package is published to npm as [`@litzrsh/umio`](https://www.npmjs.com/package/@litzrsh/umio).
The unscoped name `umio` belongs to an unrelated package. The command it installs is still `umio`.

Releases are published by [`.github/workflows/release.yml`](../.github/workflows/release.yml) when a version tag is pushed. It uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers): the workflow authenticates with a short-lived OIDC token, so no npm token is stored in GitHub, and npm attaches a [provenance](https://docs.npmjs.com/generating-provenance-statements) statement linking the package to the commit and workflow run.

## What the workflows do

- [`ci.yml`](../.github/workflows/ci.yml) runs on every push to `main` and every pull request:
  - typecheck, lint and `schema:check` (the committed JSON Schema must be current);
  - the build and package checks (`publint --strict`, `attw`);
  - the test suite on Node 20, 22 and 24;
  - the PostgreSQL store suite against a real `postgres:17-alpine` service.
- [`release.yml`](../.github/workflows/release.yml) runs on tags `v*.*.*`:
  1. Checks that the tag equals `v` + `package.json` `version`.
  2. Runs `npm run release:check` and the PostgreSQL suite.
  3. Runs `npm publish`. The `prepack` script builds `dist/` fresh. A tag with a hyphen (`v1.2.0-rc.1`) publishes to the `next` dist-tag instead of `latest`.
  4. Creates a GitHub release with generated notes.

## One-time setup

1. **npm account.** Sign in to [npmjs.com](https://www.npmjs.com) as `litzrsh`, with two-factor authentication enabled. The `@litzrsh` scope is yours automatically; `publishConfig.access: "public"` makes the scoped package public.
2. **GitHub environment.** In the repository settings, go to Environments and create `npm`. Optionally require a reviewer, so every publish needs an approval.
3. **First publish.** npm lets you add a trusted publisher only to a package that already exists. Choose one way to create it:
   - **From your machine** (simplest). A local publish cannot produce provenance, so turn it off for this one release:
     ```bash
     npm login
     npm run release:check
     npm publish --provenance=false
     ```
     Then tag the published commit so later tags follow on from it:
     ```bash
     git tag v0.1.0 && git push origin v0.1.0
     ```
     The release workflow will then fail at `npm publish` because the version already exists; that is expected for this bootstrap tag.
   - **From the workflow.** Create a granular access token on npmjs.com (read and write, limited to publishing) and add it as the repository secret `NPM_TOKEN`. Push the tag `v0.1.0`; the workflow publishes with provenance. Delete the secret and revoke the token after step 4.
4. **Trusted publisher.** On npmjs.com, open the package's Settings, then Trusted publishing, and add GitHub Actions:
   - organization or user: `litzrsh`
   - repository: `umio`
   - workflow filename: `release.yml`
   - environment: `npm`

   Then, in the same settings, set publishing access to require two-factor authentication and **disallow tokens**, so only the workflow can publish.

## Every release

1. Make sure `main` is green in CI and your working tree is clean.
2. Update [`CHANGELOG.md`](../CHANGELOG.md): move the entries under "Unreleased" to a new version heading.
3. Bump the version, which commits and tags:
   ```bash
   npm version patch   # or minor, major, prerelease --preid rc
   git push --follow-tags
   ```
4. Watch the Release workflow. When it finishes, the version is on npm with provenance, and a GitHub release exists for the tag.

To check what would be published without publishing:

```bash
npm run release:check     # typecheck, lint, schema check, tests, package checks
npm pack --dry-run        # the exact file list (dist, schema, README, LICENSE)
```

## If something goes wrong

- **The tag does not match the version.** The workflow stops before publishing. Delete the tag (`git push --delete origin vX.Y.Z` and `git tag -d vX.Y.Z`), fix `package.json`, and tag again.
- **Checks fail.** Nothing was published. Fix the problem, delete and recreate the tag, or release the next patch version.
- **A bad version was published.** npm versions are immutable. Publish a fixed version, and deprecate the bad one with `npm deprecate @litzrsh/umio@X.Y.Z "reason"`. `npm unpublish` is possible only within 72 hours and blocks that version number forever.
