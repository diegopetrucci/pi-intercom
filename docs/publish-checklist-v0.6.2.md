# Publish checklist — v0.6.2

## Release scope

- [x] bump `package.json` version to `0.6.2`
- [x] add a dated `0.6.2` changelog entry for the foreground grouped subagent result card suppression change
- [x] update README pinned install guidance to `@diegopetrucci/pi-intercom@0.6.2`
- [x] create release docs for tag `tlh-v0.6.2`
- [x] keep the release-prep/docs change limited to metadata/docs; no runtime behavior changes are introduced here

## Release docs

- [x] `docs/release-notes-v0.6.2.md`
- [x] `docs/github-release-v0.6.2.md`
- [x] `docs/publish-checklist-v0.6.2.md`

## Validation

- [x] npm registry availability checked: `npm view @diegopetrucci/pi-intercom@0.6.2 version --json` returned the expected not-yet-published 404
- [x] `npm test`

```bash
npm view @diegopetrucci/pi-intercom@0.6.2 version --json
npm test
```

## Package dry-run

- [x] inspect the publish tarball metadata and included files
- [x] package dry-run inspected: `npm pack --dry-run --json` produced `diegopetrucci-pi-intercom-0.6.2.tgz` with 19 files in the dry-run manifest

```bash
npm pack --dry-run --json
```

## Commit, tag, and GitHub release

- [ ] commit release changes on a non-main branch
- [ ] push the release branch
- [ ] open or update the PR targeting `main`
- [ ] after PR merge, tag `tlh-v0.6.2` on `main`
- [ ] push tag `tlh-v0.6.2`
- [ ] create the GitHub release for tag `tlh-v0.6.2` using `docs/github-release-v0.6.2.md`

## Stop before npm publish

> Human-only: npm publishing depends on the authenticated npm session.

- [ ] human publishes `@diegopetrucci/pi-intercom`

```bash
npm publish --access public
```

## Post-publish validation

- [ ] wait for npm propagation before validation (for example, 5 minutes after publish completes)
- [ ] verify the npm registry/package page shows `@diegopetrucci/pi-intercom@0.6.2`
- [ ] verify package metadata after propagation
- [ ] run an install check after propagation

```bash
npm view @diegopetrucci/pi-intercom@0.6.2 name version dist.tarball --json
pi install npm:@diegopetrucci/pi-intercom@0.6.2
```
