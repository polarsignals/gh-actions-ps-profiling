# GitHub Action for Continuous Profiling

GitHub Action for Continuous Profiling which you can run to profile your workloads in CI/CD. It uses [Polar Signals Cloud](https://www.polarsignals.com/) (or any other [Parca](https://www.parca.dev/) compatible API).

## How to use

You will need access to Polar Signals Cloud or another way to send Parca profiles to remote store. 

This project is also a demo of how to use this action, view the [.github/workflows](.github/workflows) directory to view the example usage.

If you are using Polar Signals Cloud, the only thing required to configure is the `polarsignals_cloud_token` which is the API token for Polar Signals Cloud, where it sends the profiling data. You can find the docs on how to obtain a token [here](https://www.polarsignals.com/docs/generating-tokens).

## PR Comments

On pull request events, this action automatically creates or updates a single PR comment with a link to your profiling data. The comment shows the latest run prominently and maintains a history of previous runs in a collapsible section.

For this feature to work, the `project_uuid` (your Polar Signals Cloud project UUID) is required. This UUID is not sensitive and can be provided directly in the workflow file, not as a secret - it ends up in the URL either way.

If any of the required parameters are missing, the PR comment will be skipped without failing the workflow, and log messages will indicate the reason.

### Required Permissions

```yaml
permissions:
  pull-requests: write
  contents: read
```

### Example Configuration

```yaml
name: Profiling Workflow
on: [pull_request]

permissions:
  pull-requests: write
  contents: read

jobs:
  profile:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Run Continuous Profiling
        uses: polarsignals/gh-actions-ps-profiling@main
        with:
          polarsignals_cloud_token: ${{ secrets.POLARSIGNALS_CLOUD_TOKEN }}
          project_uuid: 'your-project-uuid-here' # Don't use a secret for this, it's not sensitive, and otherwise the URL will be partially redacted.
```

### Example Profiling Data

Profiling data from one CI run looks [like this](https://pprof.me/475d1cc/).
