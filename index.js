const core = require('@actions/core');
const exec = require('@actions/exec');
const tc = require('@actions/tool-cache');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Store timestamps file path
const timestampFile = path.join(process.env.RUNNER_TEMP || '/tmp', 'parca-agent-timestamps.json');

// Parse labels string into an object
function parseLabels(labelsString) {
  if (!labelsString) return {};
  
  const result = {};
  labelsString.split(';').forEach(label => {
    const [key, value] = label.trim().split('=');
    if (key && value !== undefined) {
      result[key.trim()] = value.trim();
    }
  });
  
  return result;
}

async function run() {
  try {
    // Save start timestamp
    const startTimestamp = Date.now();
    
    // Get inputs
    const polarsignalsCloudToken = core.getInput('polarsignals_cloud_token', { required: true });
    const storeAddress = core.getInput('store_address') || 'grpc.polarsignals.com:443';
    const parcaAgentVersion = core.getInput('parca_agent_version') || '0.38.0';
    const profilingFrequency = core.getInput('profiling_frequency') || '99';
    const profilingDuration = core.getInput('profiling_duration') || '3s';
    const labelsString = core.getInput('labels') || '';
    const extraArgs = core.getInput('extra_args') || '';
    const config = core.getInput('config') || '';
    const projectUuid = core.getInput('project_uuid') || '';
    const cloudHostname = core.getInput('cloud_hostname') || 'cloud.polarsignals.com';
    
    // Parse labels
    const labels = parseLabels(labelsString);
    
    // Save start timestamp and configuration to file
    fs.writeFileSync(timestampFile, JSON.stringify({ 
      startTimestamp,
      projectUuid,
      cloudHostname,
      labels,
      labelsString
    }));
    
    core.info(`Saved start timestamp: ${startTimestamp}`);

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
    
    // Write bearer token to a temporary file
    const tokenFile = path.join(process.env.RUNNER_TEMP || '/tmp', 'parca-agent-token');
    fs.writeFileSync(tokenFile, polarsignalsCloudToken);
    
    const args = [
      `--metadata-external-labels=${labelsString}`,
      `--profiling-duration=${profilingDuration}`,
      `--profiling-cpu-sampling-frequency=${profilingFrequency}`,
      '--node=github',
      `--remote-store-address=${storeAddress}`,
      `--remote-store-bearer-token-file=${tokenFile}`
    ];
    
    // Handle config file if provided
    if (config) {
      const configFile = path.join(process.env.RUNNER_TEMP || '/tmp', 'parca-agent-config.yaml');
      fs.writeFileSync(configFile, config);
      args.push(`--config-path=${configFile}`);
      core.info(`Config file written to: ${configFile}`);
    }

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

async function post() {
  try {
    // Get ending timestamp
    const endTimestamp = Date.now();
    
    // Read start timestamp from file
    if (!fs.existsSync(timestampFile)) {
      core.warning('Start timestamp file not found. Cannot create Polar Signals Cloud query.');
      return;
    }
    
    const data = JSON.parse(fs.readFileSync(timestampFile, 'utf8'));
    const { startTimestamp, projectUuid, cloudHostname, labels, labelsString } = data;
    
    // Build the URL with the proper format
    let queryUrl = `https://${cloudHostname}/`;
    
    // Append project UUID if provided
    if (projectUuid) {
      queryUrl += `projects/${projectUuid}?`;
    }
    
    // Build label selector string
    let labelSelector = '';
    if (labelsString && Object.keys(labels).length > 0) {
      const labelSelectors = [];
      
      for (const [key, value] of Object.entries(labels)) {
        labelSelectors.push(`${key}="${value}"`);
      }
      
      if (labelSelectors.length > 0) {
        labelSelector = '{' + labelSelectors.join(',') + '}';
      }
    }
    
    // Define parameters for the URL
    const baseMetric = 'parca_agent:samples:count:cpu:nanoseconds:delta';
    const expression = labelSelector ? `${baseMetric}${labelSelector}` : baseMetric;
    const encodedExpression = encodeURIComponent(expression);
    
    // Calculate a reasonable step count
    const durationSeconds = Math.floor((endTimestamp - startTimestamp) / 1000);
    const stepCount = Math.min(Math.max(Math.floor(durationSeconds / 10), 50), 500); // Between 50 and 500 steps
    
    // Add the query parameters with the complex format
    queryUrl += `query_browser_mode=simple`;
    queryUrl += `&step_count=${stepCount}`;
    queryUrl += `&expression_a=${encodedExpression}`;
    queryUrl += `&from_a=${startTimestamp}`;
    queryUrl += `&to_a=${endTimestamp}`;
    queryUrl += `&time_selection_a=absolute:${startTimestamp}-${endTimestamp}`;
    queryUrl += `&sum_by_a=comm`;
    queryUrl += `&merge_from_a=${startTimestamp}`;
    queryUrl += `&merge_to_a=${endTimestamp}`;
    queryUrl += `&selection_a=${encodedExpression}`;
    
    core.info('Polar Signals Cloud Query Information:');
    core.info(`- Start time: ${new Date(startTimestamp).toISOString()} (${startTimestamp}ms)`);
    core.info(`- End time: ${new Date(endTimestamp).toISOString()} (${endTimestamp}ms)`);
    core.info(`- Duration: ${Math.round((endTimestamp - startTimestamp) / 1000)} seconds`);
    core.info(`- Query URL: ${queryUrl}`);
    
    // Set output for the action
    core.setOutput('profiling_url', queryUrl);

    // Create a GitHub deployment if running in GitHub Actions and all required parameters are available
    if (process.env.GITHUB_ACTIONS) {
      try {
        const github_token = core.getInput('github_token');
        const repository = process.env.GITHUB_REPOSITORY;
        const [owner, repo] = (repository || '').split('/');
        
        // Extract the correct SHA
        let sha = process.env.GITHUB_SHA;
        // For pull requests, get the SHA from the head of the PR
        if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_EVENT_PATH) {
          try {
            const eventData = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
            if (eventData.pull_request && eventData.pull_request.head && eventData.pull_request.head.sha) {
              sha = eventData.pull_request.head.sha;
              core.info(`Using PR head SHA: ${sha} instead of merged SHA`);
            }
          } catch (eventError) {
            core.warning(`Failed to parse event data: ${eventError.message}`);
          }
        }
        
        // Check if all required parameters are available for deployment
        if (github_token && owner && repo && sha && projectUuid && queryUrl) {
          core.info(`Creating deployment for ${owner}/${repo} at ${sha}`);
          
          const octokit = require('@octokit/rest');
          const { Octokit } = octokit;
          const client = new Octokit({
            auth: github_token
          });
          
          try {
            core.info('Creating deployment...');
            const deployment = await client.repos.createDeployment({
              owner,
              repo,
              ref: sha,
              environment: 'polar-signals-cloud',
              required_contexts: [],
              auto_merge: false,
              description: 'Polar Signals Profiling Results',
              transient_environment: false,
              production_environment: false
            });
            
            // Create a deployment status
            if (deployment.data.id) {
              const deploymentId = deployment.data.id;
              core.info(`Deployment created with ID: ${deploymentId}. Creating deployment status...`);
              
              try {
                await client.repos.createDeploymentStatus({
                  owner,
                  repo,
                  deployment_id: deploymentId,
                  state: 'success',
                  description: 'Profiling data is available',
                  environment_url: queryUrl,
                  log_url: queryUrl,
                  auto_inactive: false
                });
                
                core.info(`Deployment status created successfully for ID: ${deploymentId}`);
              } catch (statusError) {
                core.error(`Failed to create deployment status: ${statusError.message}`);
                core.error(`Status error details: ${JSON.stringify(statusError)}`);
              }
            } else {
              core.warning('Deployment was created but no deployment ID was returned');
            }
          } catch (createError) {
            core.error(`Failed to create deployment: ${createError.message}`);
            core.error(`Create error details: ${JSON.stringify(createError)}`);
          }
        } else {
          core.info('Skipping GitHub deployment creation due to missing required parameters:');
          if (!github_token) core.info('- Missing github_token');
          if (!owner || !repo) core.info(`- Missing repository information: ${repository}`);
          if (!sha) core.info('- Missing SHA information');
          if (!projectUuid) core.info('- Missing project_uuid');
          if (!queryUrl) core.info('- Missing queryUrl');
        }
      } catch (deployError) {
        core.warning(`Failed to create GitHub deployment: ${deployError.message}`);
      }
    }
    
    // Clean up timestamp file
    fs.unlinkSync(timestampFile);
    
    // Clean up token file if it exists
    const tokenFile = path.join(process.env.RUNNER_TEMP || '/tmp', 'parca-agent-token');
    if (fs.existsSync(tokenFile)) {
      fs.unlinkSync(tokenFile);
    }
    
  } catch (error) {
    core.warning(`Post action failed with error: ${error.message}`);
  }
}

// Determine whether to run the main action or post action
const isPost = !!process.env.STATE_isPost;
if (isPost) {
  post();
} else {
  run();
  // Save state to indicate post action should run
  core.saveState('isPost', 'true');
}
