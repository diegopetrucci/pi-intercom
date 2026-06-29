# Publish checklist — v0.6.1

## Release scope

- [x] publish the tlh-maintained fork as the scoped npm package `@diegopetrucci/pi-intercom@0.6.1`
- [x] preserve the existing `pi.extensions` and `pi.skills` package manifests
- [x] update install guidance to use the scoped package and recommend a pinned `0.6.1` install for tlh automation
- [x] add `0.6.1` changelog and release docs for the scoped npm release

## Preflight and release docs

- [x] verify `@diegopetrucci/pi-intercom@0.6.1` is not already published on npm
- [x] create release docs
  - [x] `docs/release-notes-v0.6.1.md`
  - [x] `docs/github-release-v0.6.1.md`
  - [x] `docs/publish-checklist-v0.6.1.md`
- [x] run local validation before any tag or publish step

## Validation

- [x] npm registry availability checked: `npm view @diegopetrucci/pi-intercom@0.6.1 version --json` returned the expected not-yet-published 404
- [x] `npm test`

```bash
npm view @diegopetrucci/pi-intercom@0.6.1 version --json
npm test
```

## Package dry-run

- [x] inspect the publish tarball metadata and included files
- [x] package dry-run inspected: `npm pack --dry-run --json` produced `diegopetrucci-pi-intercom-0.6.1.tgz` with 19 files in the dry-run manifest

```bash
npm pack --dry-run --json
```

## Commit, tag, and GitHub release

- [ ] commit release changes on a non-main branch
- [ ] push the release branch
- [ ] open or update the PR targeting `main`
- [ ] after PR merge, tag `tlh-v0.6.1` on `main`
- [ ] push tag `tlh-v0.6.1`
- [ ] create the GitHub release for tag `tlh-v0.6.1` using `docs/github-release-v0.6.1.md`

## Stop before npm publish

> Human-only: npm publishing depends on the authenticated npm session.

- [ ] human publishes `@diegopetrucci/pi-intercom`

```bash
npm publish --access public
```

## Post-publish validation

- [ ] wait for npm propagation before validation (for example, 5 minutes after publish completes)
- [ ] verify the npm registry/package page shows `@diegopetrucci/pi-intercom@0.6.1`
- [ ] verify package metadata after propagation
- [ ] run an install check after propagation

```bash
npm view @diegopetrucci/pi-intercom@0.6.1 name version dist.tarball --json
pi install npm:@diegopetrucci/pi-intercom@0.6.1
```
