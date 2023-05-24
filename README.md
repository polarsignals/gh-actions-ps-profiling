# GitHub Action for Continuous Profiling

GitHub Action for Continuous Profiling which you can run to profile your workloads in CI/CD manner. It uses [Parca](https://www.parca.dev/) and Polar Signals cloud.

## How to use

You will need access to Polar Signals cloud or another way to send Parca profiles to remote store. 

This project is also a demo of how to use this action, view the [.github/workflows](.github/workflows) directory to view the example usage.

If you are using Polar Signals cloud, the only thing required to configure is the `polarsignals_cloud_token` which is the API token for Polar Signals cloud, where it sends the profiling data. You can view the docs on that [here](https://www.polarsignals.com/docs/generating-tokens).

Profiling data from one CI run looks [like this](https://pprof.me/475d1cc/).

