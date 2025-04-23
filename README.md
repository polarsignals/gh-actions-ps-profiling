# GitHub Action for Continuous Profiling

GitHub Action for Continuous Profiling which you can run to profile your workloads in CI/CD manner. It uses [Parca](https://www.parca.dev/) and Polar Signals cloud.

## How to use

You will need access to Polar Signals cloud or another way to send Parca profiles to remote store. 

This project is also a demo of how to use this action, view the [.github/workflows](.github/workflows) directory to view the example usage.

If you are using Polar Signals cloud, the only thing required to configure is the `polarsignals_cloud_token` which is the API token for Polar Signals cloud, where it sends the profiling data. You can view the docs on that [here](https://www.polarsignals.com/docs/generating-tokens).

Profiling data from one CI run looks [like this](https://pprof.me/475d1cc/).

## Deployment Links

This action can automatically create GitHub deployments with links to your profiling data, making it easy to access the results directly from your GitHub repository. For this feature to work, the following parameters must be configured:

- `project_uuid`: Your Polar Signals Cloud project UUID
- `github_token`: A GitHub token with the necessary permissions to create deployments to create the link to the profiling data on a Pull Request or commit.

If any of the required parameters are missing, the deployment creation will be skipped without failing the workflow, and log messages will indicate the reason.

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
          labels: ref_name=${{ github.ref_name }};workflow=${{ github.workflow }};gh_run_id=${{ github.run_id }}
          github_token: "${{ github.token }}"
```

