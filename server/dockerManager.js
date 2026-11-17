import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let portOffset = 0;

function setting(name, fallback) {
  return process.env[name] || fallback;
}

function positiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function defaultRedroidImage() {
  return process.arch === 'arm64'
    ? 'redroid/redroid:15.0.0_64only-latest'
    : 'redroid/redroid:14.0.0-latest';
}

/** Allocate non-overlapping host ports per session for the MVP. */
export function allocatePorts() {
  const index = portOffset++;
  return {
    adbPort: positiveInt('ADB_PORT_BASE', 5555) + index,
    streamPort: positiveInt('STREAM_PORT_BASE', 8000) + index,
  };
}

/**
 * Build (but do not run) the Docker command templates for a session.
 * The ws-scrcpy env flags are a template: adapt them to your chosen image.
 */
export function buildDockerPlan(session) {
  const prefix = setting('CONTAINER_PREFIX', 'caer');
  const name = `${prefix}-${session.id}`;
  const androidName = `${name}-android`;
  const scrcpyName = `${name}-scrcpy`;
  const hostEnv = setting('WS_SCRCPY_ADB_HOST_ENV', 'ADB_HOST');
  const portEnv = setting('WS_SCRCPY_ADB_PORT_ENV', 'ADB_PORT');

  const containers = [
    {
      name: androidName,
      command: 'docker',
      args: [
        'run', '-d', '--privileged', '--name', androidName,
        '-p', `${session.adbPort}:5555`,
        setting('REDROID_IMAGE', defaultRedroidImage()),
        'androidboot.redroid_width=720',
        'androidboot.redroid_height=1280',
        'androidboot.redroid_dpi=320',
      ],
    },
    {
      name: scrcpyName,
      command: 'docker',
      args: [
        'run', '-d', '--name', scrcpyName,
        '-p', `${session.streamPort}:8000`,
        '--add-host=host.docker.internal:host-gateway',
        '-e', `${hostEnv}=host.docker.internal`,
        '-e', `${portEnv}=${session.adbPort}`,
        setting('WS_SCRCPY_IMAGE', 'remoteview/ws-scrcpy:latest'),
      ],
    },
  ];

  const publicHost = setting('PUBLIC_HOST', 'localhost');
  const configuredUrl = setting('STREAM_BASE_URL', '');
  const streamUrl = configuredUrl
    ? configuredUrl.replace(/\/+$/, '')
    : `http://${publicHost}:${session.streamPort}/`;

  return { containers, streamUrl };
}

/** Only called from the server when ENABLE_DOCKER=true. */
export async function executeDockerPlan(plan) {
  for (const container of plan.containers) {
    await execFileAsync(container.command, container.args, { timeout: 120_000 });
  }
  return plan.containers.map((container) => container.name);
}

/** Best-effort cleanup; a failed removal must not block session deletion. */
export async function removeContainers(names) {
  for (const name of names) {
    try {
      await execFileAsync('docker', ['rm', '-f', name], { timeout: 30_000 });
    } catch (error) {
      console.warn(`Could not remove container ${name}: ${error.message}`);
    }
  }
}

/**
 * Non-fatal preflight when Docker execution is enabled.
 * Redroid needs binder + ashmem kernel modules on the host, not KVM.
 */
export function checkHostPrerequisites() {
  const warnings = [];

  try {
    const modules = readFileSync('/proc/modules', 'utf8');
    if (!/binder/.test(modules)) warnings.push('binder kernel module is not loaded');
    if (!/ashmem/.test(modules)) warnings.push('ashmem kernel module is not loaded');
  } catch {
    warnings.push('cannot read /proc/modules (non-Linux host?)');
  }

  return warnings;
}
