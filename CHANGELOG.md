## 3.0.0 (2026-06-26)

* chore: prettier ([adff8e4](https://github.com/loash-industries/keyspace/commit/adff8e4))
* Merge pull request #5 from loash-industries/feat/versioned-state-updates ([335e012](https://github.com/loash-industries/keyspace/commit/335e012)), closes [#5](https://github.com/loash-industries/keyspace/issues/5)
* feat: added docs on schema migrations ([3fa216e](https://github.com/loash-industries/keyspace/commit/3fa216e))
* feat: added versioned state migrations and updates ([2b25c96](https://github.com/loash-industries/keyspace/commit/2b25c96))
* feat!: empty commit for ver tag ([db8e0ff](https://github.com/loash-industries/keyspace/commit/db8e0ff))
* fix: requested changes ([9349d6c](https://github.com/loash-industries/keyspace/commit/9349d6c))

### BREAKING CHANGE

* empty commit for ver tag

## 2.3.0 (2026-06-23)

* Merge pull request #4 from loash-industries/feat/shared-signed-message ([0beccea](https://github.com/loash-industries/keyspace/commit/0beccea)), closes [#4](https://github.com/loash-industries/keyspace/issues/4)
* feat: added shared signed message to reduce race conditions ([b5bfcb2](https://github.com/loash-industries/keyspace/commit/b5bfcb2))
* feat: shared signed message for deudupe ([7d759d2](https://github.com/loash-industries/keyspace/commit/7d759d2))

## <small>2.2.1 (2026-06-21)</small>

* fix:  bug with tx creation ([6f2737f](https://github.com/loash-industries/keyspace/commit/6f2737f))

## 2.2.0 (2026-06-21)

* fix: lint ([a619bc5](https://github.com/loash-industries/keyspace/commit/a619bc5))
* fix: lint ([1551182](https://github.com/loash-industries/keyspace/commit/1551182))
* test: add coverage for createAclForDao, editDescription, rotateAllStaleEntries, and parsePrincipal ([0fd1fb4](https://github.com/loash-industries/keyspace/commit/0fd1fb4))
* feat: add createAclForDao for DAO-linked keyspace creation ([8f34498](https://github.com/loash-industries/keyspace/commit/8f34498))

## 2.1.0 (2026-06-18)

* feat: added structure types to location data ([aa53326](https://github.com/loash-industries/keyspace/commit/aa53326))

## 2.0.0 (2026-06-18)

* feat!: added in-line major release trigger ([fc37cfd](https://github.com/loash-industries/keyspace/commit/fc37cfd))

### BREAKING CHANGE

* added in-line major release trigger

## 1.2.0 (2026-06-18)

* feat: allow for big version bumps ([9e21e8f](https://github.com/loash-industries/keyspace/commit/9e21e8f))
* feat!: empty ([39bcc62](https://github.com/loash-industries/keyspace/commit/39bcc62))

# [1.1.0](https://github.com/loash-industries/keyspace/compare/v1.0.2...v1.1.0) (2026-06-18)


### Bug Fixes

* patches ([2b69d11](https://github.com/loash-industries/keyspace/commit/2b69d112826b709e41a69554bfe676af8839ce9f))
* prettier ([05f9e05](https://github.com/loash-industries/keyspace/commit/05f9e057031e15cbcd898e61419ea15939d348ea))
* tscheck ([625155f](https://github.com/loash-industries/keyspace/commit/625155f1ca24e6760a622acdd7d3d45a0489d968))


### Features

* migrated acl to new keyspace contract design utilizing armature orgs ([3d2706e](https://github.com/loash-industries/keyspace/commit/3d2706e62e482e342719a61671af91b14a7bb8ef))
* remove contracts ([bfa91a8](https://github.com/loash-industries/keyspace/commit/bfa91a8985f70eba0e3360fbd7456d81291fda23))

## [1.0.2](https://github.com/loash-industries/keyspace/compare/v1.0.1...v1.0.2) (2026-05-03)


### Bug Fixes

* issue with imports and module build type  mismatches ([c6046ed](https://github.com/loash-industries/keyspace/commit/c6046edfe8b142938c10ac797e4d4319fe112f3e))

## [1.0.1](https://github.com/loash-industries/keyspace/compare/v1.0.0...v1.0.1) (2026-05-02)


### Bug Fixes

* trigger initial semantic-release ([b1ae0bd](https://github.com/loash-industries/keyspace/commit/b1ae0bdd5583c51040c3cc93f6aff9bdf333fc2d))

# 1.0.0 (2026-05-02)


### Bug Fixes

* ci ([4987029](https://github.com/loash-industries/keyspace/commit/4987029b1ec8b336e2fd844403cafedcad15c382))
* ci ([320dff6](https://github.com/loash-industries/keyspace/commit/320dff67cdfef7444131e4422d9340fbce8d3811))
* prettier ([279bde4](https://github.com/loash-industries/keyspace/commit/279bde4de7e5e0cc6abfddb3a5549db17da19ee9))
* update lockfile ([6a6551a](https://github.com/loash-industries/keyspace/commit/6a6551a0945a5aa2c5a15840db595c3916d8bac1))
* use semantic release in publish workflow ([e597859](https://github.com/loash-industries/keyspace/commit/e59785988f413eca6bd59310885020b0114022ab))


### Features

* initial design for access control list && e2e encrypted shared data ([aa3b8d7](https://github.com/loash-industries/keyspace/commit/aa3b8d7b4d82f8d8859455eb58fe0af384353d4a))
