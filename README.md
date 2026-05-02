# template-common-private-package
A template repo for private npm packages

### To Use
1. Find and replace `<<PACKAGE_NAME>>` with the new package name (i.e - if it will be `@loash-industries/observability` make the name `observability`)
2. Add `GH_AUTH_TOKEN` secret in repo settings. Secret can be found in 1Password named "[github] github package registry rw"
3. Add `DEPLOY_KEY` secret in repo settings. This is used for getting/using internal workflows. Secret can be found in 1Password named "[github] github-managed-workflow-001 token"

