# GitHub Action for Continuous Profiling

GitHub Action for Continuous Profiling which you can run to profile your workloads in CI/CD. It uses [Polar Signals Cloud](https://www.polarsignals.com/) (or any other [Parca](https://www.parca.dev/) compatible API).

## How to use

You will need access to Polar Signals Cloud or another way to send Parca profiles to remote store. 

This project is also a demo of how to use this action, view the [.github/workflows](.github/workflows) directory to view the example usage.

If you are using Polar Signals Cloud, the only thing required to configure is the `polarsignals_cloud_token` which is the API token for Polar Signals Cloud, where it sends the profiling data. You can find the docs on how to obtain a token [here](https://www.polarsignals.com/docs/generating-tokens).

## Deployment Links

This action can automatically create GitHub deployments with links to your profiling data, making it easy to access the results directly from your GitHub repository. For this feature to work, the `project_uuid`, your Polar Signals Cloud project UUID is required. This UUID is not sensitive and can be provided directly in the workflow file, not as a secret, it ends up in the URL either way so there's no point in using a secret.

If any of the required parameters are missing or the defaults don't work, the deployment creation will be skipped without failing the workflow, and log messages will indicate the reason.

### Required Permissions

For the deployment creation to work, your workflow needs the following permissions:

```yaml
permissions:
  deployments: write
```

### Example Configuration

```yaml
name: Profiling Workflow
on: [push]

permissions:
  deployments: write
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
