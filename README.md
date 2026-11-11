# flowgit

**Git version control and dev → prod environments for self-hosted n8n — including the free Community Edition.**

n8n's built-in Git source control and environments are part of the paid Business/Enterprise plans. Backup templates copy JSON into a repo, but they can't tell you *what changed* or safely promote a workflow from dev to prod. flowgit does both, from your terminal or CI.

```console
$ flowgit diff --env prod
~ Inbound leads
    + node Enrich
    ~ node Lookup  parameters.url
    + Webhook → Enrich
    ~ settings: errorWorkflow
+ Enrich lead  (only in git)

1 added, 1 changed, 0 removed, 12 unchanged

$ flowgit push --env prod --activate
  ✓ Enrich lead
  ✓ Inbound leads
Pushed 2 workflow(s) to "prod".
```

## What it does

- **`pull`**: exports workflows as clean, stable, diff-friendly JSON. Volatile fields (`updatedAt`, `versionId`, …) are stripped, keys are sorted, and nodes are ordered by name, so every Git commit shows only real changes.
- **Environment-agnostic files**: credential IDs, sub-workflow IDs and error-workflow IDs are different on every instance. flowgit stores them **by name** and resolves them on the target during `push`.
- **`diff`**: shows a node-level diff between Git and any instance, or between two instances (`--from dev --to prod`). Moved-only nodes are marked as such, so layout tweaks don't hide logic changes.
- **`push`**: creates or updates workflows on the target, links sub-workflows and error workflows, and optionally syncs active/published state. It **never deletes** anything and **checks every reference before writing**. A missing credential on prod aborts the push instead of half-deploying.
- **`lint`**: catches hardcoded API keys/tokens, unauthenticated webhooks, disabled or orphan nodes, plain-HTTP calls and active workflows without an error workflow. Use it as a PR check.

Works with n8n 1.x and 2.x through the public REST API (tested against n8n 2.47). No database access, no n8n plugin, no extra server.

## Quick start

```bash
npm i -g @speedboostco/flowgit     # or: npx @speedboostco/flowgit <command>

mkdir my-n8n && cd my-n8n && git init
flowgit init                        # creates flowgit.json
```

Edit `flowgit.json`:

```json
{
  "dir": "workflows",
  "environments": {
    "dev":  { "url": "http://localhost:5678",   "apiKeyEnv": "N8N_DEV_API_KEY" },
    "prod": { "url": "https://n8n.example.com", "apiKeyEnv": "N8N_PROD_API_KEY" }
  }
}
```

Create an API key in each instance (**Settings → n8n API**) and put them in `.env` (gitignored by `init`):

```bash
N8N_DEV_API_KEY=...
N8N_PROD_API_KEY=...
```

Then:

```bash
flowgit pull --env dev              # dev → Git
git add workflows && git commit -m "Snapshot"
flowgit diff --env prod             # what would change on prod?
flowgit push --env prod --dry-run   # full plan, including unresolved credentials
flowgit push --env prod --activate  # deploy
```

## How references are resolved

| In n8n | In Git | On push |
|---|---|---|
| `credentials.slackApi = { id: "8Kq…", name: "Slack bot" }` | `{ name: "Slack bot" }` | matched by type + name on the target |
| Execute Workflow → `workflowId: "Xy7…"` | `@workflow:Enrich lead` | ID of "Enrich lead" on the target, created first if missing |
| `settings.errorWorkflow: "Ab3…"` | `@workflow:Error handler` | linked after the error workflow is published |

If credential names differ between instances, map them per environment:

```json
"prod": {
  "url": "https://n8n.example.com",
  "apiKeyEnv": "N8N_PROD_API_KEY",
  "credentials": { "slackApi:Slack bot": "<credential id on prod>" }
}
```

To manage only part of an instance, add `"tags": ["prod-managed"]` to `flowgit.json`. Only workflows with one of these tags are pulled, diffed and pushed.

## CI: review and deploy with GitHub Actions

Lint every pull request and show the diff against prod:

```yaml
# .github/workflows/n8n-check.yml
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: speedboostco/flowgit@main
        with:
          command: lint
      - uses: speedboostco/flowgit@main
        with:
          command: diff
          env: prod
        env:
          N8N_PROD_API_KEY: ${{ secrets.N8N_PROD_API_KEY }}
```

Deploy on merge to `main`:

```yaml
# .github/workflows/n8n-deploy.yml
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: speedboostco/flowgit@main
        with:
          command: push
          env: prod
          args: --activate
        env:
          N8N_PROD_API_KEY: ${{ secrets.N8N_PROD_API_KEY }}
```

Nightly backup of prod into Git: run `flowgit pull --env prod` on a schedule and commit the result.

## Commands

```
flowgit init
flowgit pull   [--env <name>]
flowgit diff   [--env <name>] [--from <env|git> --to <env|git>] [--exit-code] [--json]
flowgit push   --env <name> [--dry-run] [--activate] [--force]
flowgit lint   [--strict] [--json]
```

Exit codes: `0` ok · `1` differences (`diff --exit-code`), lint errors or unresolved references · `2` usage or connection error.

## Compared with the alternatives

| | flowgit | Backup templates | n8n Business plan |
|---|---|---|---|
| Works on Community Edition | ✅ | ✅ | ❌ |
| Readable node-level diff | ✅ | ❌ | partial |
| Dev → prod promotion with ID remapping | ✅ | ❌ | ✅ |
| Pre-flight check for missing credentials | ✅ | ❌ | ❌ |
| Lint / PR checks | ✅ | ❌ | ❌ |
| Price | free, MIT | free | from $800/month |

## FAQ

**Does it touch credentials' secrets?** No. Only credential *names* are stored in Git. Secrets stay in each n8n instance.

**Can it delete workflows on prod?** No. Workflows that exist only on the target are reported and left alone.

**Pinned data and static data?** Not exported. They are runtime/test data and would make diffs noisy.

**Does it work with n8n Cloud?** Yes, if your plan exposes the public API.

## Roadmap

- [x] pull / diff / push / lint
- [x] GitHub Action
- [ ] Failed-execution alerts (Slack, Telegram, email)
- [ ] AI-written change summaries in PRs
- [ ] **flowgit Cloud**: hosted sync, history and alerts with no CI setup. ⭐ Star the repo to follow.

## Contributing

Issues and PRs welcome. `npm test` runs the suite against a mock n8n API that enforces the real API schema.

## License

MIT. flowgit is an independent project and is not affiliated with or endorsed by n8n GmbH. "n8n" is a trademark of n8n GmbH.
