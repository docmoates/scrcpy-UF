const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { spawn, execSync, exec, execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

// Directories GUI apps commonly miss because their PATH is stripped.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

function augmentedPath() {
  const current = (process.env.PATH || '').split(':')
  return [...new Set([...EXTRA_PATH, ...current])].join(':')
}

function findOnPath(name) {
  for (const dir of augmentedPath().split(':')) {
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

function findScrcpy() {
  const projectRoot = path.resolve(__dirname, '..')
  const buildCandidates = [
    path.join(projectRoot, 'build', 'app', 'scrcpy'),
    path.join(projectRoot, 'build-release', 'app', 'scrcpy'),
    path.join(projectRoot, 'builddir', 'app', 'scrcpy'),
  ]
  for (const c of buildCandidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {}
  }
  return findOnPath('scrcpy')
}

function findAdb() {
  // scrcpy honors the ADB env var as a full path override
  if (process.env.ADB) {
    try { fs.accessSync(process.env.ADB, fs.constants.X_OK); return process.env.ADB } catch {}
  }
  return findOnPath('adb')
}

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 620,
    minWidth: 760,
    minHeight: 520,
    resizable: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1117',
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  if (process.env.SCRCPY_DEBUG) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer] ${message}  (${sourceId}:${line})`)
    })
    mainWindow.webContents.on('preload-error', (_e, p, err) => {
      console.log(`[preload-error] ${p}: ${err}`)
    })
  }
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('check-env', () => ({
  scrcpy: findScrcpy(),
  adb: findAdb(),
}))

// Run a brew (or brew cask) install, streaming output to the renderer.
ipcMain.handle('brew-install', (_event, target) => {
  return new Promise((resolve) => {
    let brew
    try { brew = execSync('which brew', { encoding: 'utf8', env: { ...process.env, PATH: augmentedPath() } }).trim() } catch {}
    if (!brew) return resolve({ ok: false, error: 'Homebrew not found. Install it from https://brew.sh first.' })

    const cmd = target === 'adb'
      ? `${brew} install --cask android-platform-tools`
      : `${brew} install scrcpy`

    const proc = exec(cmd, { env: { ...process.env, PATH: augmentedPath() } })

    proc.stdout.on('data', d => mainWindow?.webContents.send('install-log', d.toString()))
    proc.stderr.on('data', d => mainWindow?.webContents.send('install-log', d.toString()))

    proc.on('close', code => {
      const found = target === 'adb' ? findAdb() : findScrcpy()
      if (code === 0 && found) resolve({ ok: true, path: found })
      else resolve({ ok: false, error: `brew exited ${code}. Check the log above.` })
    })
    proc.on('error', err => resolve({ ok: false, error: err.message }))
  })
})

ipcMain.handle('launch', (_event, args, serial) => {
  return new Promise((resolve) => {
    const scrcpy = findScrcpy()
    if (!scrcpy) {
      return resolve({ ok: false, error: 'scrcpy not found. Install it via Homebrew above.' })
    }
    const adb = findAdb()
    if (!adb) {
      return resolve({ ok: false, error: 'adb not found — scrcpy needs it to connect. Install Android Platform Tools above.' })
    }

    const env = { ...process.env, PATH: augmentedPath(), ADB: adb }
    if (serial) args = ['-s', serial, ...args]
    const cmd = `${path.basename(scrcpy)} ${args.join(' ')}`

    let proc
    try {
      proc = spawn(scrcpy, args, { stdio: ['ignore', 'ignore', 'pipe'], env })
    } catch (err) {
      return resolve({ ok: false, error: err.message })
    }

    let stderr = ''
    let settled = false
    proc.stderr.on('data', d => { stderr += d.toString() })

    // If scrcpy dies within 2.5s, it failed (no device, adb error, bad flag).
    // Otherwise the mirror window is up — report success and detach.
    proc.on('exit', code => {
      if (settled) return
      settled = true
      const firstError = stderr.split('\n').find(l => l.startsWith('ERROR:')) || stderr.trim()
      resolve({ ok: false, error: firstError || `scrcpy exited (code ${code}).`, cmd })
    })

    setTimeout(() => {
      if (settled) return
      settled = true
      proc.unref()
      resolve({ ok: true, pid: proc.pid, cmd })
    }, 2500)
  })
})

// ── File / APK transfer ───────────────────────────────────────────────────────

function runAdb(adb, args) {
  return new Promise((resolve) => {
    execFile(adb, args, { env: { ...process.env, PATH: augmentedPath() }, maxBuffer: 1024 * 1024 * 16 },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        out: `${stdout || ''}${stderr || ''}`.trim(),
      }))
  })
}

function withSerial(args, serial) {
  return serial ? ['-s', serial, ...args] : args
}

ipcMain.handle('list-devices', async () => {
  const adb = findAdb()
  if (!adb) return { devices: [] }
  const r = await runAdb(adb, ['devices', '-l'])
  const devices = r.out.split('\n').slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [serial, state, ...rest] = line.split(/\s+/)
      const model = rest.join(' ').match(/model:(\S+)/)
      return { serial, state, model: model ? model[1].replace(/_/g, ' ') : null }
    })
  return { devices }
})

ipcMain.handle('device-state', async (_e, serial) => {
  const adb = findAdb()
  if (!adb) return { connected: false, state: 'adb not found' }
  const r = await runAdb(adb, withSerial(['get-state'], serial))
  return { connected: r.out === 'device', state: r.out || 'no device' }
})

ipcMain.handle('install-apk', async (_e, serial) => {
  const adb = findAdb()
  if (!adb) return { ok: false, error: 'adb not found.' }

  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select APK file(s) to install',
    buttonLabel: 'Install',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Android Package', extensions: ['apk'] }],
  })
  if (res.canceled || !res.filePaths.length) return { canceled: true }

  const results = []
  for (const f of res.filePaths) {
    mainWindow?.webContents.send('transfer-log', `Installing ${path.basename(f)}…\n`)
    const r = await runAdb(adb, withSerial(['install', '-r', f], serial))
    mainWindow?.webContents.send('transfer-log', r.out + '\n\n')
    results.push({ file: path.basename(f), ok: r.code === 0 && /Success/i.test(r.out) })
  }
  const done = results.filter(r => r.ok).length
  return { ok: done === results.length, summary: `${done}/${results.length} APK(s) installed`, results }
})

ipcMain.handle('push-files', async (_e, target, serial) => {
  const adb = findAdb()
  if (!adb) return { ok: false, error: 'adb not found.' }

  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select file(s) to push to device',
    buttonLabel: 'Push',
    properties: ['openFile', 'multiSelections'],
  })
  if (res.canceled || !res.filePaths.length) return { canceled: true }

  const dest = (target && target.trim()) || '/sdcard/Download/'
  const results = []
  for (const f of res.filePaths) {
    mainWindow?.webContents.send('transfer-log', `Pushing ${path.basename(f)} → ${dest}\n`)
    const r = await runAdb(adb, withSerial(['push', f, dest], serial))
    mainWindow?.webContents.send('transfer-log', r.out + '\n\n')
    results.push({ file: path.basename(f), ok: r.code === 0 })
  }
  const done = results.filter(r => r.ok).length
  return { ok: done === results.length, summary: `${done}/${results.length} file(s) pushed to ${dest}`, results }
})
