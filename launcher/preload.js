const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('scrcpy', {
  checkEnv:      ()               => ipcRenderer.invoke('check-env'),
  brewInstall:   (target)         => ipcRenderer.invoke('brew-install', target),
  launch:        (args, serial)   => ipcRenderer.invoke('launch', args, serial),
  listDevices:   ()               => ipcRenderer.invoke('list-devices'),
  deviceState:   (serial)         => ipcRenderer.invoke('device-state', serial),
  installApk:    (serial)         => ipcRenderer.invoke('install-apk', serial),
  pushFiles:     (target, serial) => ipcRenderer.invoke('push-files', target, serial),
  onInstallLog:  (cb)             => ipcRenderer.on('install-log', (_e, line) => cb(line)),
  onTransferLog: (cb)             => ipcRenderer.on('transfer-log', (_e, line) => cb(line)),
})
