'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'app:boot', 'settings:set', 'incident:share', 'incident:decline', 'incident:openFolder', 'incident:delete',
  'app:openExternal', 'app:openCaptures', 'app:capturesBytes', 'app:pickFivemPath', 'app:probeEndpoint', 'window:hide',
  'update:check', 'update:download', 'update:install', 'device:reset',
]);
const EVENTS = new Set(['module:state', 'incident:new', 'incident:update', 'upload:progress', 'events', 'update:state']);

contextBridge.exposeInMainWorld('nn', {
  invoke(channel, payload) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error('blocked channel ' + channel));
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, cb) {
    if (!EVENTS.has(channel)) return () => {};
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
