#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require(require.resolve('ws', { paths: [path.resolve(__dirname, '..')] }));

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '../..');
const EVIDENCE_ROOT = path.join(APP_ROOT, 'evidence');
const TARGET_LIST_URL = 'http://localhost:8085/json/list';
const TARGET_PORT = '8085';
const WEBSOCKET_ORIGIN = 'http://127.0.0.1:8085';
const CDP_TIMEOUT_MS = 20_000;
const PROCESS_TIMEOUT_MS = 30_000;
const OPERATION_DEADLINE_MS = 27_000;
const CAPTURE_POLL_INTERVAL_MS = 50;
const SINK_CLEANUP_TIMEOUT_MS = 1_000;
const MAX_RUNTIME_EVIDENCE_BYTES = 64 * 1024;
const MAX_TARGETS_BYTES = 1_000_000;

let activeRequest = null;
let activeSocket = null;
let cancellation = null;
let nextCdpCommandId = 0;

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function cancel(error) {
  if (cancellation) return;
  cancellation = error;
  if (activeRequest) activeRequest.destroy(error);
  if (activeSocket && (activeSocket.readyState === 0 || activeSocket.readyState === 1)) {
    try { activeSocket.close(); } catch {}
  }
}

function failIfCancelled() {
  if (cancellation) throw cancellation;
}

function parseArgs(argv) {
  if (argv.length !== 2) throw new Error('usage: node scripts/capture-native-frames.cjs "<deviceName>" <output.frames.json>');
  const [deviceName, outputArg] = argv;
  if (!['iPhone 17', 'iPhone 17 Pro Max'].includes(deviceName)) throw new Error('deviceName must be exactly "iPhone 17" or "iPhone 17 Pro Max"');
  if (!outputArg || !outputArg.endsWith('.frames.json')) throw new Error('output must end in .frames.json');
  let outputPath;
  if (path.isAbsolute(outputArg)) outputPath = path.resolve(outputArg);
  else if (outputArg.replaceAll('\\', '/').startsWith('apps/form2-gallery/evidence/')) outputPath = path.resolve(REPO_ROOT, outputArg);
  else if (outputArg.replaceAll('\\', '/').startsWith('evidence/')) outputPath = path.resolve(APP_ROOT, outputArg);
  else outputPath = path.resolve(REPO_ROOT, outputArg);
  if (!within(EVIDENCE_ROOT, outputPath) || outputPath === EVIDENCE_ROOT) throw new Error('output must stay under apps/form2-gallery/evidence');
  return { deviceName, outputPath };
}

async function assertOutputPath(outputPath) {
  const evidenceInfo = await fsp.lstat(EVIDENCE_ROOT);
  if (evidenceInfo.isSymbolicLink() || !evidenceInfo.isDirectory() || await fsp.realpath(EVIDENCE_ROOT) !== path.resolve(EVIDENCE_ROOT)) {
    throw new Error('evidence root must be a real directory');
  }
  const relativeParent = path.relative(EVIDENCE_ROOT, path.dirname(outputPath));
  let current = EVIDENCE_ROOT;
  for (const part of relativeParent ? relativeParent.split(path.sep) : []) {
    current = path.join(current, part);
    const info = await fsp.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`output parent is not a real directory: ${path.relative(REPO_ROOT, current)}`);
  }
  try {
    const info = await fsp.lstat(outputPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('existing frame output must be a regular file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readRegularFileNoFollow(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('frame output must be a regular file');
    return await handle.readFile();
  } finally {
    if (handle) await handle.close();
  }
}

function discoverTargets(deadline) {
  failIfCancelled();
  const remaining = Math.min(5_000, deadline - Date.now());
  if (remaining <= 0) return Promise.reject(new Error('capture process deadline reached before Metro discovery'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let totalBytes = 0;
    const chunks = [];
    let request;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeRequest === request) activeRequest = null;
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => request.destroy(new Error('Metro target discovery timed out')), remaining);
    request = http.get(TARGET_LIST_URL, { headers: { accept: 'application/json' } }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(new Error(`Metro target discovery returned HTTP ${response.statusCode}`));
        return;
      }
      response.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_TARGETS_BYTES) {
          request.destroy(new Error('Metro target list exceeded its size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!Array.isArray(parsed)) throw new Error('target list must be a JSON array');
          finish(null, parsed);
        } catch (error) {
          finish(new Error(`Metro target list is invalid: ${error.message}`));
        }
      });
      response.on('error', error => finish(error));
    });
    activeRequest = request;
    request.on('error', error => finish(error));
  });
}

function selectTarget(targets, deviceName) {
  const matches = targets.filter(target => target && target.deviceName === deviceName);
  if (matches.length === 0) throw new Error(`no Metro target has exact deviceName ${JSON.stringify(deviceName)}`);
  if (matches.length !== 1) throw new Error(`multiple Metro targets have exact deviceName ${JSON.stringify(deviceName)}`);
  const target = matches[0];
  if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error('selected Metro target has no WebSocket debugger URL');
  const url = new URL(target.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.port !== TARGET_PORT || url.username || url.password || url.hash) {
    throw new Error('selected Metro WebSocket URL is outside loopback port 8085');
  }
  return target;
}

function safeDiagnosticText(value, limit = 400) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return String(value).replace(/[\u0000-\u001f]+/g, ' ').slice(0, limit);
}

function describeFailure(error, depth = 0) {
  if (!error || depth > 2) return undefined;
  const detail = {};
  for (const key of ['name', 'message', 'code', 'status', 'statusCode', 'syscall', 'address', 'port']) {
    const value = safeDiagnosticText(error[key]);
    if (value !== undefined) detail[key] = value;
  }
  if (error.cause && depth < 2) detail.cause = describeFailure(error.cause, depth + 1);
  return Object.keys(detail).length ? detail : undefined;
}

function describeWebSocketEvent(event) {
  const detail = { type: safeDiagnosticText(event?.type, 80) };
  const error = describeFailure(event?.error);
  if (error) detail.error = error;
  for (const key of ['message', 'reason', 'code', 'status', 'statusCode']) {
    const value = safeDiagnosticText(event?.[key]);
    if (value !== undefined) detail[key] = value;
  }
  return detail;
}

function connectTarget(target, deadline) {
  if (typeof WebSocket !== 'function') return Promise.reject(new Error('installed ws WebSocket client is unavailable'));
  failIfCancelled();
  const remaining = Math.min(5_000, deadline - Date.now());
  if (remaining <= 0) return Promise.reject(new Error('capture process deadline reached before WebSocket connection'));
  const socket = new WebSocket(target.webSocketDebuggerUrl, {
    origin: WEBSOCKET_ORIGIN,
    handshakeTimeout: remaining,
  });
  activeSocket = socket;
  return new Promise((resolve, reject) => {
    let settled = false;
    let failureEvent = null;
    let failureGraceTimer = null;
    const failure = () => {
      const error = new Error('Metro WebSocket connection failed');
      error.webSocketFailure = {
        errorEvent: failureEvent,
        readyState: socket.readyState,
      };
      return error;
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(failureGraceTimer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed);
      socket.removeEventListener('close', closed);
      if (error) reject(error);
      else resolve(socket);
    };
    const timer = setTimeout(() => {
      try { socket.close(); } catch {}
      finish(new Error('Metro WebSocket connection timed out'));
    }, remaining);
    const opened = () => finish(null);
    const failed = event => {
      failureEvent = describeWebSocketEvent(event);
      if (!failureGraceTimer) failureGraceTimer = setTimeout(() => finish(failure()), 100);
    };
    const closed = event => {
      const error = failureEvent ? failure() : new Error('Metro WebSocket closed before connecting');
      error.webSocketFailure = {
        ...(error.webSocketFailure || {}),
        closeEvent: describeWebSocketEvent(event),
        readyState: socket.readyState,
      };
      finish(error);
    };
    socket.addEventListener('open', opened, { once: true });
    socket.addEventListener('error', failed, { once: true });
    socket.addEventListener('close', closed, { once: true });
  });
}

function cdpCommand(socket, deadline, expression, operation) {
  failIfCancelled();
  const remaining = Math.min(CDP_TIMEOUT_MS, deadline - Date.now());
  if (remaining <= 0) return Promise.reject(new Error(`capture process deadline reached before ${operation}`));
  const id = ++nextCdpCommandId;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener('message', message);
      socket.removeEventListener('close', closed);
      socket.removeEventListener('error', failed);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`${operation} exceeded its 20 second command limit`)), remaining);
    const message = event => {
      let response;
      try { response = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')); }
      catch { return; }
      if (response.id !== id) return;
      if (response.error) finish(new Error(`${operation} failed: ${response.error.message || 'CDP protocol error'}`));
      else finish(null, response.result);
    };
    const closed = () => finish(new Error('Metro WebSocket closed before Runtime.evaluate returned'));
    const failed = () => finish(new Error('Metro WebSocket failed during Runtime.evaluate'));
    socket.addEventListener('message', message);
    socket.addEventListener('close', closed, { once: true });
    socket.addEventListener('error', failed, { once: true });
    try {
      socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: false,
          returnByValue: true,
          userGesture: false,
        },
      }));
    } catch (error) {
      finish(new Error(`${operation} could not be sent: ${error.message}`));
    }
  });
}

function remoteValue(remoteResult, operation) {
  if (!remoteResult || remoteResult.exceptionDetails) {
    const detail = remoteResult?.exceptionDetails?.exception?.description || remoteResult?.exceptionDetails?.text || 'unknown JavaScript exception';
    throw new Error(`${operation} raised: ${String(detail).replace(/[\u0000-\u001f]+/g, ' ').slice(0, 800)}`);
  }
  if (!remoteResult.result || !Object.prototype.hasOwnProperty.call(remoteResult.result, 'value')) {
    const type = remoteResult?.result?.type || 'unknown';
    throw new Error(`${operation} returned no by-value result (RemoteObject type ${type})`);
  }
  return remoteResult.result.value;
}

function boundedRuntimeEvidence(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    return { omitted: true, reason: `runtime evidence was not JSON serializable: ${safeDiagnosticText(error?.message, 200) || 'unknown error'}` };
  }
  if (encoded === undefined) return { omitted: true, reason: 'runtime evidence had no JSON representation' };
  const byteLength = Buffer.byteLength(encoded);
  if (byteLength <= MAX_RUNTIME_EVIDENCE_BYTES) return JSON.parse(encoded);
  return { truncated: true, byteLength, preview: encoded.slice(0, 2_048) };
}

function captureInvocationExpression(sinkKey, owner) {
  const key = JSON.stringify(sinkKey);
  const token = JSON.stringify(owner);
  return `(()=>{const k=${key};const o=${token};if(Object.prototype.hasOwnProperty.call(globalThis,k))return {started:false,reason:"sink-collision"};globalThis[k]={owner:o,state:"pending"};const fail=e=>{const s=globalThis[k];if(!s||s.owner!==o)return;let m;try{m=String(e&&e.message!==undefined?e.message:e)}catch{m="capture hook rejected"}globalThis[k]={owner:o,state:"rejected",error:m.slice(0,1200)}};try{const h=globalThis.__FORM2_CAPTURE_FRAMES__;if(typeof h!=="function")throw new Error("capture hook is unavailable");Promise.resolve(h()).then(value=>{const s=globalThis[k];if(s&&s.owner===o)globalThis[k]={owner:o,state:"fulfilled",value}},fail)}catch(e){fail(e)}return {started:true}})()`;
}

function capturePollExpression(sinkKey, owner) {
  const key = JSON.stringify(sinkKey);
  const token = JSON.stringify(owner);
  return `(()=>{const k=${key};const o=${token};if(!Object.prototype.hasOwnProperty.call(globalThis,k))return {owner:o,state:"missing"};return globalThis[k]})()`;
}

function captureCleanupExpression(sinkKey, owner) {
  const key = JSON.stringify(sinkKey);
  const token = JSON.stringify(owner);
  return `(()=>{const k=${key};const o=${token};if(!Object.prototype.hasOwnProperty.call(globalThis,k))return {absent:true,deleted:false,reason:"already-absent"};const s=globalThis[k];if(!s||s.owner!==o)return {absent:false,deleted:false,reason:"owner-mismatch"};const deleted=delete globalThis[k];return {absent:!Object.prototype.hasOwnProperty.call(globalThis,k),deleted}})()`;
}

async function captureHookResult(socket, deadline, sinkKey, owner, recordEvidence) {
  const settlementDeadline = Math.min(Date.now() + CDP_TIMEOUT_MS, deadline - SINK_CLEANUP_TIMEOUT_MS - 500);
  const invocation = await cdpCommand(socket, settlementDeadline, captureInvocationExpression(sinkKey, owner), 'frame hook invocation');
  const invocationValue = remoteValue(invocation, 'frame hook invocation');
  recordEvidence({ source: '__FORM2_CAPTURE_FRAMES__', phase: 'invoked', invocation: invocationValue });
  if (!invocationValue || invocationValue.started !== true) throw new Error('frame hook could not start its task-owned result sink');

  while (Date.now() < settlementDeadline) {
    failIfCancelled();
    const response = await cdpCommand(socket, settlementDeadline, capturePollExpression(sinkKey, owner), 'frame hook result poll');
    const value = remoteValue(response, 'frame hook result poll');
    if (!value || value.owner !== owner) {
      recordEvidence({ source: '__FORM2_CAPTURE_FRAMES__', phase: 'sink-ownership-mismatch', sinkState: value?.state || 'invalid' });
      throw new Error('frame hook result sink did not match this capture request');
    }
    if (value.state === 'pending') {
      recordEvidence({ source: '__FORM2_CAPTURE_FRAMES__', phase: 'pending' });
      await new Promise(resolve => setTimeout(resolve, Math.min(CAPTURE_POLL_INTERVAL_MS, Math.max(1, settlementDeadline - Date.now()))));
      continue;
    }
    if (value.state === 'fulfilled') {
      recordEvidence({ source: '__FORM2_CAPTURE_FRAMES__', phase: 'fulfilled', value: value.value });
      return value.value;
    }
    if (value.state === 'rejected') {
      recordEvidence({ source: '__FORM2_CAPTURE_FRAMES__', phase: 'rejected', error: value.error });
      throw new Error(`frame hook rejected: ${String(value.error || 'unknown rejection').replace(/[\u0000-\u001f]+/g, ' ').slice(0, 800)}`);
    }
    recordEvidence({ source: '__FORM2_CAPTURE_FRAMES__', phase: 'unexpected-sink-state', sinkState: value.state || 'missing' });
    throw new Error(`frame hook result sink entered an unexpected state: ${String(value.state || 'missing').slice(0, 80)}`);
  }
  recordEvidence({ source: '__FORM2_CAPTURE_FRAMES__', phase: 'settlement-timeout' });
  throw new Error('frame hook did not settle within its 20 second capture limit');
}

async function cleanupCaptureSink(socket, sinkKey, owner, deadline) {
  if (!socket || socket.readyState !== 1) return { attempted: false, absent: false, reason: 'websocket-not-open' };
  try {
    const cleanupDeadline = Math.min(Date.now() + SINK_CLEANUP_TIMEOUT_MS, deadline);
    const response = await cdpCommand(socket, cleanupDeadline, captureCleanupExpression(sinkKey, owner), 'frame hook sink cleanup');
    const value = remoteValue(response, 'frame hook sink cleanup');
    return {
      attempted: true,
      absent: value?.absent === true,
      deleted: value?.deleted === true,
      ...(value?.reason ? { reason: String(value.reason).slice(0, 100) } : {}),
    };
  } catch (error) {
    return { attempted: true, absent: false, error: String(error.message || error).replace(/[\u0000-\u001f]+/g, ' ').slice(0, 300) };
  }
}

function validateFrames(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.elements) || value.elements.length === 0) {
    throw new Error('native frame result must contain a nonempty elements array');
  }
  for (let index = 0; index < value.elements.length; index += 1) {
    const element = value.elements[index];
    if (!element || typeof element !== 'object' || typeof element.a11y_id !== 'string' || !element.a11y_id.length || !Array.isArray(element.frame_pt) || element.frame_pt.length !== 4 || !element.frame_pt.every(Number.isFinite)) {
      throw new Error(`native frame element ${index + 1} has an invalid a11y_id or frame_pt`);
    }
  }
  return value;
}

async function persistFrames(outputPath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  try {
    const existing = await readRegularFileNoFollow(outputPath);
    if (existing.equals(bytes)) return { state: 'no_change', digest, count: value.elements.length };
    throw new Error(`refusing to overwrite different frame evidence: ${path.relative(REPO_ROOT, outputPath)}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let handle;
  let created = false;
  try {
    handle = await fsp.open(outputPath, 'wx', 0o644);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    const readback = await readRegularFileNoFollow(outputPath);
    if (!readback.equals(bytes)) throw Object.assign(new Error('frame output readback differed from the captured value'), { outputUncertain: true });
    return { state: 'complete', digest, count: value.elements.length };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error.code === 'EEXIST') {
      const raced = await readRegularFileNoFollow(outputPath);
      if (raced.equals(bytes)) return { state: 'no_change', digest, count: value.elements.length };
      throw new Error(`refusing to overwrite different frame evidence: ${path.relative(REPO_ROOT, outputPath)}`);
    }
    if (created) error.outputUncertain = true;
    throw error;
  }
}

async function closeOwnSocket(socket) {
  if (!socket || socket.readyState === 3) return true;
  return new Promise(resolve => {
    let done = false;
    const finish = closed => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeEventListener('close', onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(socket.readyState === 3), 1_000);
    socket.addEventListener('close', onClose, { once: true });
    try {
      if (socket.readyState === 0 || socket.readyState === 1) socket.close(1000, 'capture complete');
      else if (socket.readyState !== 2) finish(false);
    } catch {
      finish(socket.readyState === 3);
    }
  });
}

async function main() {
  const { deviceName, outputPath } = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + OPERATION_DEADLINE_MS;
  let status = 'rejected';
  let result;
  let framesToPersist;
  let errorText;
  let connectionMetadata;
  let connectionError;
  let cleanupClosed = true;
  let runtimeResult;
  let sinkCleanup = null;
  let sinkKey = null;
  let sinkOwner = null;
  let sinkMayExist = false;
  const hardStop = setTimeout(() => process.exit(1), PROCESS_TIMEOUT_MS - 500);
  const watchdog = setTimeout(() => cancel(new Error('native frame capture reached its 27 second operation limit')), OPERATION_DEADLINE_MS);
  const signalHandler = signal => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    cancel(new Error(`capture cancelled by ${signal}`));
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);
  try {
    await assertOutputPath(outputPath);
    const targets = await discoverTargets(deadline);
    failIfCancelled();
    const target = selectTarget(targets, deviceName);
    connectionMetadata = {
      client: 'ws',
      returnedWebSocketURL: target.webSocketDebuggerUrl,
      transportWebSocketURL: target.webSocketDebuggerUrl,
      origin: WEBSOCKET_ORIGIN,
    };
    const socket = await connectTarget(target, deadline);
    sinkOwner = crypto.randomBytes(16).toString('hex');
    sinkKey = `__FORM2_CAPTURE_FRAMES_${sinkOwner}`;
    sinkMayExist = true;
    const capturedValue = await captureHookResult(socket, deadline, sinkKey, sinkOwner, evidence => {
      runtimeResult = boundedRuntimeEvidence(evidence);
    });
    const frames = validateFrames(capturedValue);
    failIfCancelled();
    framesToPersist = frames;
  } catch (error) {
    status = error.outputUncertain ? 'unknown' : 'rejected';
    errorText = String(error.message || error).replace(/[\u0000-\u001f]+/g, ' ').slice(0, 1200);
    connectionError = error.webSocketFailure;
  } finally {
    if (activeRequest) {
      activeRequest.destroy();
      activeRequest = null;
    }
    if (sinkMayExist) sinkCleanup = await cleanupCaptureSink(activeSocket, sinkKey, sinkOwner, deadline);
    cleanupClosed = await closeOwnSocket(activeSocket);
    activeSocket = null;
    clearTimeout(watchdog);
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    clearTimeout(hardStop);
  }
  if (sinkMayExist && sinkCleanup?.absent !== true && status === 'rejected') status = 'unknown';
  if (framesToPersist) {
    if (!cleanupClosed || sinkCleanup?.absent !== true) {
      status = 'unknown';
      errorText = errorText || 'captured frames were not persisted because transient cleanup was unproved';
    } else {
      try {
        result = await persistFrames(outputPath, framesToPersist);
        status = result.state;
      } catch (error) {
        status = error.outputUncertain ? 'unknown' : 'rejected';
        errorText = String(error.message || error).replace(/[\u0000-\u001f]+/g, ' ').slice(0, 1200);
      }
    }
  }
  const summary = {
    status,
    deviceName,
    output: path.relative(REPO_ROOT, outputPath),
    cleanup: { websocketClosed: cleanupClosed, frameSink: sinkCleanup },
  };
  if (connectionMetadata) summary.connection = connectionMetadata;
  if (connectionError) summary.connectionError = connectionError;
  if (result) Object.assign(summary, { elementCount: result.count, sha256: result.digest });
  if (errorText) summary.error = errorText;
  if (runtimeResult && status !== 'complete' && status !== 'no_change') summary.runtimeResult = runtimeResult;
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (status !== 'complete' && status !== 'no_change') process.exitCode = process.exitCode || 1;
}

main().catch(error => {
  process.stderr.write(`${String(error.message || error).replace(/[\u0000-\u001f]+/g, ' ').slice(0, 1200)}\n`);
  process.exitCode = process.exitCode || 1;
});
