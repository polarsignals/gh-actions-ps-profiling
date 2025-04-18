module.exports = {
  name: 'Polar Signals Continuous Profiling',
  description: 'Installs Parca to continuously profile your CI/CD pipeline.',
  inputs: {
    polarsignals_cloud_token: {
      description: 'Polar Signals cloud token.',
      required: true
    },
    store_address: {
      description: 'gRPC address to send data to. Defaults to Polar Signals Cloud endpoint.',
      required: false,
      default: 'grpc.polarsignals.com:443'
    },
    parca_agent_version: {
      description: 'Parca agent version.',
      required: false,
      default: '0.35.3'
    },
    profiling_frequency: {
      description: 'The frequency at which profiling data is collected. Parca Agent defaults to 19, but to gather more data in CI we recommend a higher frequency.',
      required: false,
      default: 99
    },
    profiling_duration: {
      description: 'The agent profiling duration to use, cycle to send profiling data.',
      required: false,
      default: '3s'
    },
    labels: {
      description: 'Add labels, for example branch name, branch=main',
      required: false
    },
    extra_args: {
      description: 'Add any further arguments to the execution of the agent.',
      required: false
    }
  }
};
