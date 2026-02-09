const core = require('@actions/core');
const exec = require('@actions/exec');
const tc = require('@actions/tool-cache');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Store timestamps file path
const timestampFile = path.join(process.env.RUNNER_TEMP || '/tmp', 'parca-agent-timestamps.json');

// Comment marker for identification
const COMMENT_MARKER = '<!-- polar-signals-profiling-comment -->';

// Maximum number of history entries to keep
const MAX_HISTORY_ENTRIES = 10;

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

/**
 * Parse existing comment body to extract history entries
 * Returns array of run entries with status
 */
function parseCommentHistory(body) {
  const entries = [];

  // Match table rows with Attempt column and markdown links:
  // | 🟡 In Progress | `sha` | job-name | 1 | [Explore Profiling Data](url) |
  const tableRowRegex = /\| (🟡 In Progress|🟢 Done) \| `([a-f0-9]{7})` \| (.*?) \| (\d+) \| \[Explore Profiling Data\]\((.+?)\) \|/g;

  let match;
  while ((match = tableRowRegex.exec(body)) !== null) {
    entries.push({
      status: match[1] === '🟡 In Progress' ? 'in_progress' : 'done',
      shortSha: match[2],
      jobName: match[3]?.trim() || '',
      runAttempt: match[4],
      profilingUrl: match[5]
    });
  }

  return entries;
}

/**
 * Generate the comment body with latest entries (same SHA) and history entries (different SHAs)
 * @param {Array} latestEntries - Array of entries for the current commit (same SHA)
 * @param {Array} historyEntries - Array of entries from previous commits (different SHAs)
 */
function generateCommentBody(latestEntries, historyEntries) {
  let body = `${COMMENT_MARKER}
## Polar Signals Profiling Results

### Latest Run

| Status | Commit | Job | Attempt | Link |
|--------|--------|-----|---------|------|
`;

  for (const entry of latestEntries) {
    const statusText = entry.status === 'in_progress' ? '🟡 In Progress' : '🟢 Done';
    const jobCell = entry.jobName || '';
    body += `| ${statusText} | \`${entry.shortSha}\` | ${jobCell} | ${entry.runAttempt || '1'} | [Explore Profiling Data](${entry.profilingUrl}) |\n`;
  }

  if (historyEntries.length > 0) {
    body += `
<details>
<summary><strong>Previous Runs (${historyEntries.length})</strong></summary>

| Status | Commit | Job | Attempt | Link |
|--------|--------|-----|---------|------|
`;
    for (const entry of historyEntries) {
      const entryStatusText = entry.status === 'in_progress' ? '🟡 In Progress' : '🟢 Done';
      const entryJobCell = entry.jobName || '';
      body += `| ${entryStatusText} | \`${entry.shortSha}\` | ${entryJobCell} | ${entry.runAttempt || '1'} | [Explore Profiling Data](${entry.profilingUrl}) |\n`;
    }
    body += `
</details>
`;
  }

  body += `
---
*Powered by [Polar Signals Cloud](https://www.polarsignals.com/)*`;

  return body;
}

/**
 * Build query URL for Polar Signals Cloud
 * @param {string} cloudHostname - The cloud hostname
 * @param {string} projectUuid - The project UUID
 * @param {object} labels - Parsed labels object
 * @param {string} labelsString - Original labels string
 * @param {number} startTimestamp - Start timestamp in milliseconds
 * @param {number} endTimestamp - End timestamp in milliseconds (optional for in-progress)
 * @param {boolean} isInProgress - Whether this is an in-progress run
 */
function buildQueryUrl(cloudHostname, projectUuid, labels, labelsString, startTimestamp, endTimestamp, isInProgress) {
  let queryUrl = `https://${cloudHostname}/`;

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

  if (isInProgress) {
    // For in-progress: use relative time selection (last 15 minutes)
    const fifteenMinutesMs = 15 * 60 * 1000;
    const fromTime = startTimestamp;
    const toTime = startTimestamp + fifteenMinutesMs;
    const stepCount = 50;

    queryUrl += `query_browser_mode=simple`;
    queryUrl += `&step_count=${stepCount}`;
    queryUrl += `&expression_a=${encodedExpression}`;
    queryUrl += `&from_a=${fromTime}`;
    queryUrl += `&to_a=${toTime}`;
    queryUrl += `&time_selection_a=relative:minute%7C15`;
    queryUrl += `&sum_by_a=comm`;
    queryUrl += `&merge_from_a=${fromTime * 1000000}`;
    queryUrl += `&merge_to_a=${toTime * 1000000}`;
    queryUrl += `&selection_a=${encodedExpression}`;
  } else {
    // For done: use absolute time selection with actual timestamps
    const durationSeconds = Math.floor((endTimestamp - startTimestamp) / 1000);
    const stepCount = Math.min(Math.max(Math.floor(durationSeconds / 10), 50), 500);

    queryUrl += `query_browser_mode=simple`;
    queryUrl += `&step_count=${stepCount}`;
    queryUrl += `&expression_a=${encodedExpression}`;
    queryUrl += `&from_a=${startTimestamp}`;
    queryUrl += `&to_a=${endTimestamp}`;
    queryUrl += `&time_selection_a=absolute:${startTimestamp}-${endTimestamp}`;
    queryUrl += `&sum_by_a=comm`;
    queryUrl += `&merge_from_a=${startTimestamp * 1000000}`;
    queryUrl += `&merge_to_a=${endTimestamp * 1000000}`;
    queryUrl += `&selection_a=${encodedExpression}`;
  }

  return queryUrl;
}

/**
 * Find existing comment from this action on a PR
 * Returns comment object or null
 */
async function findExistingComment(client, owner, repo, prNumber) {
  try {
    const comments = await client.paginate(client.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100
    });

    for (const comment of comments) {
      if (comment.body && comment.body.includes(COMMENT_MARKER)) {
        return comment;
      }
    }

    return null;
  } catch (error) {
    core.warning(`Failed to list PR comments: ${error.message}`);
    return null;
  }
}

/**
 * Create or update PR comment with profiling results for initial "in progress" state
 * Returns the comment ID for later update
 * Includes retry logic to handle race conditions with concurrent matrix jobs
 */
async function createInitialPRComment(client, owner, repo, prNumber, currentRun, retryCount = 0) {
  const MAX_RETRIES = 3;
  const existingComment = await findExistingComment(client, owner, repo, prNumber);

  let latestEntries = [currentRun];
  let historyEntries = [];

  if (existingComment) {
    // Parse all entries from existing comment
    const allEntries = parseCommentHistory(existingComment.body);

    // Separate entries: same SHA + same run attempt goes to latest, otherwise history
    for (const entry of allEntries) {
      // Skip if this is the same job + same attempt (will be replaced by currentRun)
      if (entry.shortSha === currentRun.shortSha && entry.jobName === currentRun.jobName && entry.runAttempt === currentRun.runAttempt) {
        continue;
      }

      if (entry.shortSha === currentRun.shortSha && entry.runAttempt === currentRun.runAttempt) {
        // Same commit, same attempt, different job - keep in latest section
        latestEntries.push(entry);
      } else {
        // Different commit or older attempt - move to history
        historyEntries.push(entry);
      }
    }

    // Limit history entries
    historyEntries = historyEntries.slice(0, MAX_HISTORY_ENTRIES);
  }

  const body = generateCommentBody(latestEntries, historyEntries);
  let commentId;

  if (existingComment) {
    core.info(`Updating existing PR comment (ID: ${existingComment.id})`);
    await client.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body
    });
    core.info(`PR comment updated successfully`);
    commentId = existingComment.id;
  } else {
    core.info(`Creating new PR comment on PR #${prNumber}`);
    const response = await client.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body
    });
    core.info(`PR comment created successfully (ID: ${response.data.id})`);
    commentId = response.data.id;
  }

  // Verify our entry was saved (handle race conditions)
  if (retryCount < MAX_RETRIES) {
    // Small delay to allow GitHub to propagate the update
    await new Promise(resolve => setTimeout(resolve, 1000));

    const verifyComment = await findExistingComment(client, owner, repo, prNumber);
    if (verifyComment) {
      const verifyEntries = parseCommentHistory(verifyComment.body);
      const ourEntryExists = verifyEntries.some(
        e => e.shortSha === currentRun.shortSha && e.jobName === currentRun.jobName && e.runAttempt === currentRun.runAttempt
      );

      if (!ourEntryExists) {
        core.info(`Race condition detected: our entry was overwritten, retrying (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        return createInitialPRComment(client, owner, repo, prNumber, currentRun, retryCount + 1);
      }
    }
  }

  return commentId;
}

/**
 * Update PR comment to "done" status for a specific SHA and job name
 * Finds the entry by SHA and jobName (composite key) and updates only that entry
 * Includes retry logic to handle race conditions with concurrent matrix jobs
 */
async function updatePRCommentToDone(client, owner, repo, prNumber, shortSha, finalUrl, jobName = '', runAttempt = '1', retryCount = 0) {
  const MAX_RETRIES = 3;
  const existingComment = await findExistingComment(client, owner, repo, prNumber);

  if (!existingComment) {
    // Fallback: create new comment if not found
    core.info('No existing comment found, creating new one');
    const currentRun = {
      shortSha,
      profilingUrl: finalUrl,
      status: 'done',
      jobName,
      runAttempt
    };
    await createInitialPRComment(client, owner, repo, prNumber, currentRun);
    return;
  }

  // Parse all entries from the comment
  const allEntries = parseCommentHistory(existingComment.body);

  if (allEntries.length === 0) {
    // No entries found, create new one
    core.info('No entries found in comment, adding new completed entry');
    const body = generateCommentBody([{
      shortSha,
      profilingUrl: finalUrl,
      status: 'done',
      jobName,
      runAttempt
    }], []);
    await client.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body
    });
    return;
  }

  // Find the entry matching this SHA, jobName, and runAttempt (composite key) and update it
  let foundEntry = false;
  for (const entry of allEntries) {
    if (entry.shortSha === shortSha && entry.jobName === jobName && entry.runAttempt === runAttempt) {
      entry.status = 'done';
      entry.profilingUrl = finalUrl;
      foundEntry = true;
      break;
    }
  }

  if (!foundEntry) {
    // SHA+jobName+runAttempt not found in comment (race condition), add as new completed entry
    core.info(`SHA ${shortSha} with job "${jobName}" (attempt ${runAttempt}) not found in comment, adding as new entry`);
    allEntries.unshift({
      shortSha,
      profilingUrl: finalUrl,
      status: 'done',
      jobName,
      runAttempt
    });
  }

  // Separate entries: same SHA + same run attempt goes to latest, otherwise history
  const latestEntries = [];
  const historyEntries = [];

  for (const entry of allEntries) {
    if (entry.shortSha === shortSha && entry.runAttempt === runAttempt) {
      latestEntries.push(entry);
    } else {
      historyEntries.push(entry);
    }
  }

  const body = generateCommentBody(latestEntries, historyEntries.slice(0, MAX_HISTORY_ENTRIES));

  core.info(`Updating PR comment to mark ${shortSha} (job: "${jobName}", attempt: ${runAttempt}) as done`);
  await client.issues.updateComment({
    owner,
    repo,
    comment_id: existingComment.id,
    body
  });

  // Verify our entry was saved correctly (handle race conditions)
  if (retryCount < MAX_RETRIES) {
    // Small delay to allow GitHub to propagate the update
    await new Promise(resolve => setTimeout(resolve, 1000));

    const verifyComment = await findExistingComment(client, owner, repo, prNumber);
    if (verifyComment) {
      const verifyEntries = parseCommentHistory(verifyComment.body);
      const ourEntry = verifyEntries.find(
        e => e.shortSha === shortSha && e.jobName === jobName && e.runAttempt === runAttempt
      );

      if (!ourEntry || ourEntry.status !== 'done') {
        core.info(`Race condition detected: our entry was overwritten or not marked done, retrying (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        return updatePRCommentToDone(client, owner, repo, prNumber, shortSha, finalUrl, jobName, runAttempt, retryCount + 1);
      }
    }
  }

  core.info(`PR comment updated successfully`);
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
    const projectUuid = core.getInput('project_uuid', { required: true });
    const cloudHostname = core.getInput('cloud_hostname') || 'cloud.polarsignals.com';
    const jobName = core.getInput('job_name') || '';
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';

    // Parse labels
    const labels = parseLabels(labelsString);
    
    // Save start timestamp and configuration to file
    fs.writeFileSync(timestampFile, JSON.stringify({
      startTimestamp,
      projectUuid,
      cloudHostname,
      labels,
      labelsString,
      jobName,
      runAttempt
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
      `--remote-store-bearer-token-file=${tokenFile}`,
      `--remote-store-grpc-headers=projectID=${projectUuid}`
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

    // Create initial PR comment with "in progress" status
    if (process.env.GITHUB_ACTIONS) {
      try {
        const github_token = core.getInput('github_token');
        const repository = process.env.GITHUB_REPOSITORY;
        const [owner, repo] = (repository || '').split('/');

        // Extract the correct SHA and PR number
        let sha = process.env.GITHUB_SHA;
        let prNumber = null;

        // For pull requests, get the SHA and PR number
        if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_EVENT_PATH) {
          try {
            const eventData = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
            if (eventData.pull_request) {
              prNumber = eventData.pull_request.number;
              if (eventData.pull_request.head && eventData.pull_request.head.sha) {
                sha = eventData.pull_request.head.sha;
                core.info(`Using PR head SHA: ${sha}`);
              }
            }
          } catch (eventError) {
            core.warning(`Failed to parse event data: ${eventError.message}`);
          }
        }

        // Only create PR comments for pull_request events
        if (prNumber && github_token && owner && repo && sha) {
          const octokit = require('@octokit/rest');
          const { Octokit } = octokit;
          const client = new Octokit({
            auth: github_token
          });

          // Build "in progress" URL
          const inProgressUrl = buildQueryUrl(
            cloudHostname,
            projectUuid,
            labels,
            labelsString,
            startTimestamp,
            null,
            true // isInProgress
          );

          const shortSha = sha.substring(0, 7);
          const currentRun = {
            shortSha,
            profilingUrl: inProgressUrl,
            status: 'in_progress',
            jobName,
            runAttempt
          };

          core.info(`Creating/updating PR comment for PR #${prNumber} with in-progress status`);
          try {
            const commentId = await createInitialPRComment(client, owner, repo, prNumber, currentRun);

            // Update timestamps file with additional data for post()
            const updatedData = {
              startTimestamp,
              projectUuid,
              cloudHostname,
              labels,
              labelsString,
              shortSha,
              prNumber,
              commentId,
              jobName,
              runAttempt
            };
            fs.writeFileSync(timestampFile, JSON.stringify(updatedData));
            core.info(`Saved PR comment info (comment ID: ${commentId}, SHA: ${shortSha})`);
          } catch (commentError) {
            if (commentError.status === 403) {
              core.warning('Failed to create PR comment: Missing pull-requests:write permission. ' +
                           'Add "pull-requests: write" to your workflow permissions.');
            } else {
              core.warning(`Failed to create PR comment: ${commentError.message}`);
            }
          }
        } else {
          if (!prNumber) {
            core.info(`Not a PR event (event: ${process.env.GITHUB_EVENT_NAME}), skipping initial PR comment`);
          } else {
            core.info('Skipping initial PR comment due to missing required parameters');
          }
        }
      } catch (error) {
        core.warning(`Failed to create initial PR comment: ${error.message}`);
      }
    }

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
    const { startTimestamp, projectUuid, cloudHostname, labels, labelsString, shortSha, prNumber, jobName, runAttempt } = data;

    // Build final URL with complete time range
    const queryUrl = buildQueryUrl(
      cloudHostname,
      projectUuid,
      labels,
      labelsString,
      startTimestamp,
      endTimestamp,
      false // not in progress
    );

    core.info('Polar Signals Cloud Query Information:');
    core.info(`- Start time: ${new Date(startTimestamp).toISOString()} (${startTimestamp}ms)`);
    core.info(`- End time: ${new Date(endTimestamp).toISOString()} (${endTimestamp}ms)`);
    core.info(`- Duration: ${Math.round((endTimestamp - startTimestamp) / 1000)} seconds`);
    core.info(`- Query URL: ${queryUrl}`);

    // Set output for the action
    core.setOutput('profiling_url', queryUrl);

    // Update PR comment to "done" status if running in GitHub Actions
    if (process.env.GITHUB_ACTIONS) {
      try {
        const github_token = core.getInput('github_token');
        const repository = process.env.GITHUB_REPOSITORY;
        const [owner, repo] = (repository || '').split('/');

        // Get SHA and PR number - prefer saved values from run(), fallback to environment
        let sha = shortSha;
        let currentPrNumber = prNumber;

        // If not saved, try to get from environment
        if (!sha || !currentPrNumber) {
          sha = process.env.GITHUB_SHA;
          if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_EVENT_PATH) {
            try {
              const eventData = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
              if (eventData.pull_request) {
                currentPrNumber = eventData.pull_request.number;
                if (eventData.pull_request.head && eventData.pull_request.head.sha) {
                  sha = eventData.pull_request.head.sha.substring(0, 7);
                  core.info(`Using PR head SHA: ${sha}`);
                }
              }
            } catch (eventError) {
              core.warning(`Failed to parse event data: ${eventError.message}`);
            }
          }
          if (sha && sha.length > 7) {
            sha = sha.substring(0, 7);
          }
        }

        // Check if all required parameters are available
        if (!github_token || !owner || !repo || !sha || !queryUrl) {
          core.info('Skipping GitHub integration due to missing required parameters:');
          if (!github_token) core.info('- Missing github_token');
          if (!owner || !repo) core.info(`- Missing repository information: ${repository}`);
          if (!sha) core.info('- Missing SHA information');
          if (!queryUrl) core.info('- Missing queryUrl');
          return;
        }

        const octokit = require('@octokit/rest');
        const { Octokit } = octokit;
        const client = new Octokit({
          auth: github_token
        });

        // Only update PR comments for pull_request events
        if (currentPrNumber) {
          core.info(`Updating PR comment for PR #${currentPrNumber} to done status`);
          try {
            await updatePRCommentToDone(client, owner, repo, currentPrNumber, sha, queryUrl, jobName || '', runAttempt || '1');
          } catch (commentError) {
            if (commentError.status === 403) {
              core.warning('Failed to update PR comment: Missing pull-requests:write permission. ' +
                           'Add "pull-requests: write" to your workflow permissions.');
            } else {
              core.warning(`Failed to update PR comment: ${commentError.message}`);
            }
          }
        } else {
          core.info(`Not a PR event (event: ${process.env.GITHUB_EVENT_NAME}), skipping PR comment update`);
        }
      } catch (error) {
        core.warning(`Failed to update GitHub integration: ${error.message}`);
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
