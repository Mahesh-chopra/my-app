import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Android keycodes used by the on-screen controls. */
const KEYEVENTS = Object.freeze({
  home: 3,
  back: 4,
  recent: 187,
  volumeUp: 24,
  volumeDown: 25,
  power: 26,
});

export const SUPPORTED_ACTIONS = Object.freeze(Object.keys(KEYEVENTS));

export function isSupportedAction(action) {
  return typeof action === 'string' && Object.hasOwn(KEYEVENTS, action);
}

export function buildAdbCommand(session, action) {
  if (!isSupportedAction(action)) {
    throw new Error(`Unsupported action: ${action}`);
  }

  const host = process.env.ADB_HOST || '127.0.0.1';
  const target = `${host}:${session.adbPort}`;

  return {
    command: 'adb',
    args: ['-s', target, 'shell', 'input', 'keyevent', String(KEYEVENTS[action])],
    keycode: KEYEVENTS[action],
  };
}

export function buildInstallCommand(session, apkPath = session.apkPath) {
  const host = process.env.ADB_HOST || '127.0.0.1';
  return {
    command: 'adb',
    args: ['-s', `${host}:${session.adbPort}`, 'install', '-r', apkPath],
  };
}

export function formatCommand({ command, args }) {
  return [command, ...args].join(' ');
}

/** Only called from the server when ENABLE_DOCKER=true. */
export async function runAdbCommand({ command, args }, timeout = 10_000) {
  const { stdout } = await execFileAsync(command, args, { timeout });
  return stdout.trim();
}
