// Electron is exposed as a native CommonJS module in the desktop process, but
// interop layers may wrap the same module under `default`. Resolve it lazily so
// this boundary can also be unit-tested without starting an Electron process.
function resolveIpcMain() {
  const electron = require('electron');
  return electron?.ipcMain || electron?.default?.ipcMain;
}

function normalizeIpcError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

function logIpcError(channel, err) {
  const traceId = Math.random().toString(16).slice(2, 10);
  console.error(`[IPC][${channel}][${traceId}] ${err?.message || err}`, err);
  return traceId;
}

/**
 * Strict IPC handler wrapper.
 * Preserves invoke/handle semantics: successful handlers resolve their value,
 * unexpected handler errors are logged and rejected back to the renderer.
 */
function createIpcWrappers(ipcMain = resolveIpcMain()) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') {
    throw new Error('Electron ipcMain is unavailable');
  }

  function wrapIpcHandler(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await handler(event, ...args);
      } catch (err) {
        logIpcError(channel, err);
        throw normalizeIpcError(err);
      }
    });
  }

  function wrapIpcBestEffortHandler(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await handler(event, ...args);
      } catch (err) {
        logIpcError(channel, err);
        return undefined;
      }
    });
  }

  function wrapIpcOn(channel, handler) {
    ipcMain.on(channel, (event, ...args) => {
      try {
        const result = handler(event, ...args);
        if (result && typeof result.catch === 'function') {
          result.catch((err) => {
            console.error(`[IPC][${channel}] async: ${err?.message || err}`);
          });
        }
      } catch (err) {
        console.error(`[IPC][${channel}] ${err?.message || err}`);
      }
    });
  }

  return { wrapIpcHandler, wrapIpcBestEffortHandler, wrapIpcOn };
}

function wrapIpcHandler(channel, handler) {
  return createIpcWrappers().wrapIpcHandler(channel, handler);
}

function wrapIpcBestEffortHandler(channel, handler) {
  return createIpcWrappers().wrapIpcBestEffortHandler(channel, handler);
}

function wrapIpcOn(channel, handler) {
  return createIpcWrappers().wrapIpcOn(channel, handler);
}

/*
 * The factory is intentionally exported for non-Electron contract tests. The
 * desktop entry point continues using the three default wrappers above.
 */
module.exports = { wrapIpcHandler, wrapIpcBestEffortHandler, wrapIpcOn, createIpcWrappers };
