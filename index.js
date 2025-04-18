const core = require('@actions/core');
const exec = require('@actions/exec');
const tc = require('@actions/tool-cache');
const os = require('os');
const path = require('path');
const fs = require('fs');

async function run() {
  try {
    // Get inputs
    const polarsignalsCloudToken = core.getInput('polarsignals_cloud_token', { required: true });
    const storeAddress = core.getInput('store_address') || 'grpc.polarsignals.com:443';
    const parcaAgentVersion = core.getInput('parca_agent_version') || '0.35.3';
    const profilingFrequency = core.getInput('profiling_frequency') || '99';
    const profilingDuration = core.getInput('profiling_duration') || '3s';
    const labels = core.getInput('labels') || '';
    const extraArgs = core.getInput('extra_args') || '';

    // Determine platform specifics
    const platform = os.platform();
    const arch = os.arch();
    
    // Map NodeJS arch to Parca arch format
    let parcaArch = arch;
    if (arch === 'x64') parcaArch = 'x86_64';
    if (arch === 'arm64') parcaArch = 'aarch64';
    
    // Map NodeJS platform to Parca platform format
    let parcaPlatform = platform;
    if (platform === 'win32') parcaPlatform = 'Windows';
    if (platform === 'darwin') parcaPlatform = 'Darwin';
    if (platform === 'linux') parcaPlatform = 'Linux';

    // Download URL
    const downloadUrl = `https://github.com/parca-dev/parca-agent/releases/download/v${parcaAgentVersion}/parca-agent_${parcaAgentVersion}_${parcaPlatform}_${parcaArch}`;
    
    core.info(`Downloading Parca Agent from ${downloadUrl}...`);
    
    // Download the Parca Agent
    const agentPath = await tc.downloadTool(downloadUrl);
    
    // Make it executable
    await exec.exec('chmod', ['+x', agentPath]);
    
    // Run the Parca agent in the background
    const tempLogFile = path.join(process.env.RUNNER_TEMP || '/tmp', 'parca-agent.log');
    
    const args = [
      `--metadata-external-labels='${labels}'`,
      `--profiling-duration=${profilingDuration}`,
      `--profiling-cpu-sampling-frequency=${profilingFrequency}`,
      '--node=github',
      `--remote-store-address=${storeAddress}`,
      `--remote-store-bearer-token=${polarsignalsCloudToken}`
    ];
    
    if (extraArgs) {
      args.push(extraArgs);
    }
    
    core.info('Starting Parca Agent in the background...');
    
    // Use spawn to run in background
    const { spawn } = require('child_process');
    const sudoPrefix = platform === 'linux' ? ['sudo'] : [];
    const command = sudoPrefix.concat([agentPath, ...args]);
    
    const parcaProcess = spawn(command[0], command.slice(1), {
      detached: true,
      stdio: ['ignore', 
        fs.openSync(tempLogFile, 'a'),
        fs.openSync(tempLogFile, 'a')
      ]
    });
    
    // Detach the process
    parcaProcess.unref();
    
    core.info(`Parca Agent started with PID ${parcaProcess.pid}`);
    core.info(`Logs available at: ${tempLogFile}`);
    
  } catch (error) {
    core.setFailed(`Action failed with error: ${error.message}`);
  }
}

run();
