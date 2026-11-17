import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';

import {
  buildAdbCommand,
  buildInstallCommand,
  formatCommand,
  isSupportedAction,
  runAdbCommand,
  SUPPORTED_ACTIONS,
} from './adb.js';
import {
  allocatePorts,
  buildDockerPlan,
  checkHostPrerequisites,
  executeDockerPlan,
  removeContainers,
} from './dockerManager.js';
import {
  createSession,
  deleteSession,
  findExpiredSessions,
  getSession,
  isExpired,
} from './sessionStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

function positiveInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const PORT = positiveInt('PORT', 3000);
const DURATION_MINUTES = positiveInt('SESSION_DURATION_MINUTES', 15);
const MAX_UPLOAD_MB = positiveInt('MAX_UPLOAD_MB', 100);
const ENABLE_DOCKER = /^true$/i.test(process.env.ENABLE_DOCKER || 'false');
const UPLOAD_DIR = path.join(ROOT, 'uploads');

await fs.mkdir(UPLOAD_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

const CORS_ORIGIN = process.env.CORS_ORIGIN || '';

app.use((req, res, next) => {
  if (!CORS_ORIGIN) return next();

  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
    filename: (req, _file, callback) => callback(null, `${req.sessionId}.apk`),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() !== '.apk') {
      const error = new Error('Only .apk files are allowed.');
      error.code = 'INVALID_FILE_TYPE';
      return callback(error);
    }
    return callback(null, true);
  },
});

function assignSessionId(req, _res, next) {
  req.sessionId = randomUUID();
  next();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireSession(id) {
  const session = getSession(id);
  if (!session) throw httpError(404, 'Session not found.');
  if (isExpired(session)) throw httpError(410, 'Session expired.');
  return session;
}

async function cleanupSession(session) {
  deleteSession(session.id);

  if (session.dockerEnabled && session.containerIds.length > 0) {
    await removeContainers(session.containerIds);
  }

  try {
    await fs.unlink(session.apkPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Could not delete upload ${session.apkPath}: ${error.message}`);
    }
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, dockerEnabled: ENABLE_DOCKER, uptimeSeconds: process.uptime() });
});

app.post('/api/session/start', assignSessionId, upload.single('apk'), async (req, res, next) => {
  let session = null;

  try {
    if (!req.file) {
      throw httpError(400, 'Missing APK upload. Use form field "apk".');
    }

    const ports = allocatePorts();
    const base = {
      id: req.sessionId,
      apkPath: req.file.path,
      originalName: path.basename(req.file.originalname),
      adbPort: ports.adbPort,
      streamPort: ports.streamPort,
      durationMinutes: DURATION_MINUTES,
      dockerEnabled: ENABLE_DOCKER,
    };

    const plan = buildDockerPlan(base);
    const installCommand = buildInstallCommand(base);
    session = createSession({
      ...base,
      streamUrl: ENABLE_DOCKER ? plan.streamUrl : null,
      commands: [...plan.containers.map(formatCommand), formatCommand(installCommand)],
    });

    if (ENABLE_DOCKER) {
      try {
        session.containerIds = await executeDockerPlan(plan);
        session.status = 'running';
        await runAdbCommand(installCommand, 120_000);
      } catch (error) {
        await cleanupSession(session);
        session = null;
        throw httpError(500, `Docker launch failed: ${error.message}`);
      }
    }

    res.status(201).json({
      sessionId: session.id,
      status: session.status,
      streamUrl: session.streamUrl,
      expiresAt: session.expiresAt,
      durationMinutes: session.durationMinutes,
      dockerEnabled: ENABLE_DOCKER,
      preparedCommands: ENABLE_DOCKER ? [] : session.commands,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/session/:id/action', async (req, res, next) => {
  try {
    const session = requireSession(req.params.id);
    const action = req.body?.action;

    if (!isSupportedAction(action)) {
      throw httpError(400, `Unsupported action. Use one of: ${SUPPORTED_ACTIONS.join(', ')}.`);
    }

    const spec = buildAdbCommand(session, action);
    const output = session.dockerEnabled ? await runAdbCommand(spec) : null;

    res.json({
      ok: true,
      action,
      keyevent: spec.keycode,
      command: formatCommand(spec),
      output,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/session/:id/stop', async (req, res, next) => {
  try {
    const session = getSession(req.params.id);
    if (!session) throw httpError(404, 'Session not found.');

    await cleanupSession(session);
    res.json({ ok: true, sessionId: session.id });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(ROOT, 'public')));

app.use((error, _req, res, _next) => {
  let status = error.status;

  if (!status) {
    if (error.code === 'LIMIT_FILE_SIZE') status = 413;
    else if (error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'INVALID_FILE_TYPE') status = 400;
    else status = 500;
  }

  if (status === 500) console.error(error);

  const message = status === 500 && !error.status
    ? 'Internal server error.'
    : error.code === 'LIMIT_FILE_SIZE'
      ? `APK exceeds the ${MAX_UPLOAD_MB} MB limit.`
      : error.message;

  res.status(status).json({ error: message });
});

const pruneTimer = setInterval(async () => {
  for (const session of findExpiredSessions()) {
    try {
      await cleanupSession(session);
      console.log(`Pruned expired session ${session.id}`);
    } catch (error) {
      console.warn(`Could not prune session ${session.id}: ${error.message}`);
    }
  }
}, 60_000);
pruneTimer.unref();

app.listen(PORT, () => {
  console.log(`Cloud Android Emulator Runner listening on http://localhost:${PORT}`);
  console.log(`Docker execution: ${ENABLE_DOCKER ? 'ENABLED' : 'disabled (mock mode)'}`);

  if (ENABLE_DOCKER) {
    const warnings = checkHostPrerequisites();
    if (warnings.length > 0) {
      console.warn(`Host preflight: ${warnings.join('; ')}`);
    } else {
      console.log('Host preflight: binder/ashmem modules detected');
    }
  }
});
