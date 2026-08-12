const deviceSection = document.getElementById('device-section')
const deviceSelect  = document.getElementById('device-select')
const binaryStatus  = document.getElementById('binary-status')
const cmdPreview    = document.getElementById('cmd-preview')
const launchBtn     = document.getElementById('launch-btn')
const statusMsg     = document.getElementById('status-msg')
const installPanel  = document.getElementById('install-panel')
const installTitle  = document.getElementById('install-title')
const installDesc   = document.getElementById('install-desc')
const brewScrcpyBtn = document.getElementById('brew-scrcpy-btn')
const brewAdbBtn    = document.getElementById('brew-adb-btn')
const brewLog       = document.getElementById('brew-log')

// ── Device selection ───────────────────────────────────────────────────────────
let selectedSerial = null

async function refreshDevices() {
  const { devices } = await window.scrcpy.listDevices()

  // Only ask the user to pick when there's genuine ambiguity.
  deviceSection.hidden = devices.length < 2

  const stillPresent = devices.some(d => d.serial === selectedSerial)
  if (!stillPresent) selectedSerial = devices[0]?.serial || null

  deviceSelect.innerHTML = devices.map(d => {
    const label = d.model ? `${d.model} — ${d.serial}` : d.serial
    const tag = d.state !== 'device' ? ` (${d.state})` : ''
    return `<option value="${d.serial}">${label}${tag}</option>`
  }).join('')
  if (selectedSerial) deviceSelect.value = selectedSerial

  updatePreview()
}

deviceSelect.addEventListener('change', () => {
  selectedSerial = deviceSelect.value || null
  updatePreview()
})

// ── Environment check (scrcpy + adb) ──────────────────────────────────────────
let envReady = false

async function refreshEnv() {
  const env = await window.scrcpy.checkEnv()
  const haveScrcpy = !!env.scrcpy
  const haveAdb    = !!env.adb

  brewScrcpyBtn.hidden = haveScrcpy
  brewAdbBtn.hidden    = haveAdb

  envReady = haveScrcpy && haveAdb
  launchBtn.disabled = !envReady

  if (envReady) {
    binaryStatus.textContent = 'Ready'
    binaryStatus.className = 'badge badge--ok'
    installPanel.hidden = true
  } else {
    binaryStatus.textContent = 'Setup needed'
    binaryStatus.className = 'badge badge--missing'
    installPanel.hidden = false
    const missing = []
    if (!haveScrcpy) missing.push('scrcpy')
    if (!haveAdb)    missing.push('adb')
    installTitle.textContent = `Missing: ${missing.join(' + ')}`
    installDesc.textContent  = 'Install via Homebrew — one click each, ~1 min.'
  }

  if (envReady) await refreshDevices()
  updatePreview()
}

refreshEnv()

// ── Homebrew install ──────────────────────────────────────────────────────────
window.scrcpy.onInstallLog(line => {
  brewLog.hidden = false
  brewLog.textContent += line
  brewLog.scrollTop = brewLog.scrollHeight
})

async function runInstall(btn, target, label) {
  btn.disabled = true
  const original = btn.textContent
  btn.textContent = `Installing ${label}…`
  brewLog.hidden = false
  brewLog.textContent = ''

  const result = await window.scrcpy.brewInstall(target)

  if (result.ok) {
    showStatus(`${label} installed successfully!`, 'ok')
    brewLog.hidden = true
    await refreshEnv()
  } else {
    btn.disabled = false
    btn.textContent = `Retry ${label}`
    showStatus(`Install failed: ${result.error}`, 'error')
  }
}

brewScrcpyBtn.addEventListener('click', () => runInstall(brewScrcpyBtn, 'scrcpy', 'scrcpy'))
brewAdbBtn.addEventListener('click',    () => runInstall(brewAdbBtn, 'adb', 'adb'))

// ── Mode show/hide ────────────────────────────────────────────────────────────
document.querySelectorAll('input[name=mode]').forEach(r => {
  r.addEventListener('change', () => {
    document.getElementById('fold-options').hidden    = r.value !== 'fold'
    document.getElementById('desktop-options').hidden = r.value !== 'desktop'
    updatePreview()
  })
})

// ── Fold custom ───────────────────────────────────────────────────────────────
document.querySelectorAll('input[name=fold-res]').forEach(r => {
  r.addEventListener('change', () => {
    document.getElementById('fold-custom').hidden = r.value !== 'custom'
    updatePreview()
  })
})
document.getElementById('fold-custom-val').addEventListener('input', updatePreview)

// ── Desktop custom ────────────────────────────────────────────────────────────
document.querySelectorAll('input[name=desk-res]').forEach(r => {
  r.addEventListener('change', () => {
    document.getElementById('desk-custom').hidden = r.value !== 'custom'
    updatePreview()
  })
})
document.getElementById('desk-custom-val').addEventListener('input', updatePreview)
document.querySelectorAll('input[name=desk-dpi]').forEach(r => {
  r.addEventListener('change', updatePreview)
})

// ── Connection ────────────────────────────────────────────────────────────────
document.querySelectorAll('input[name=conn]').forEach(r => {
  r.addEventListener('change', () => {
    document.getElementById('wifi-input').hidden = r.value !== 'wifi'
    updatePreview()
  })
})
document.getElementById('wifi-ip').addEventListener('input', updatePreview)

// ── Checkboxes ────────────────────────────────────────────────────────────────
;['opt-top','opt-fullscreen','opt-record','opt-awake','opt-noaudio','opt-nocontrol'].forEach(id => {
  document.getElementById(id).addEventListener('change', updatePreview)
})

// ── Build args ────────────────────────────────────────────────────────────────
function buildArgs() {
  const args = []

  // scrcpy defaults to 8 Mbps H.264, which is visibly soft on a high-res
  // panel. Push bitrate way up and prefer H.265 (better detail per bit).
  args.push('--video-codec=h265')
  args.push('--video-bit-rate=32M')

  const mode = document.querySelector('input[name=mode]:checked').value

  if (mode === 'fold') {
    const res = document.querySelector('input[name=fold-res]:checked').value
    const size = res === 'custom'
      ? document.getElementById('fold-custom-val').value.trim()
      : res
    if (size) {
      args.push(`--new-display=${size}`)
      args.push('--display-orientation=0')
    }
  }

  if (mode === 'desktop') {
    const res = document.querySelector('input[name=desk-res]:checked').value
    const size = res === 'custom'
      ? document.getElementById('desk-custom-val').value.trim()
      : res
    const dpi = document.querySelector('input[name=desk-dpi]:checked').value
    if (size) {
      args.push(`--new-display=${size}/${dpi}`)
      args.push('--display-orientation=0')
    }
  }

  // Connection
  const conn = document.querySelector('input[name=conn]:checked').value
  if (conn === 'wifi') {
    const ip = document.getElementById('wifi-ip').value.trim()
    if (ip) args.push(`--tcpip=${ip}`)
  }

  // Extras
  if (document.getElementById('opt-top').checked)       args.push('--always-on-top')
  if (document.getElementById('opt-fullscreen').checked) args.push('--fullscreen')
  if (document.getElementById('opt-record').checked)    args.push('--record=' + getDesktopPath())
  if (document.getElementById('opt-awake').checked)     args.push('--keep-active')
  if (document.getElementById('opt-noaudio').checked)   args.push('--no-audio')
  if (document.getElementById('opt-nocontrol').checked) args.push('--no-control')

  return args
}

function getDesktopPath() {
  // HOME is available in Node context but not renderer — use a known path
  return `~/Desktop/scrcpy-${Date.now()}.mp4`
}

function updatePreview() {
  const args = buildArgs()
  const prefix = selectedSerial ? `-s ${selectedSerial} ` : ''
  cmdPreview.textContent = `scrcpy ${prefix}` + (args.length ? args.join(' ') : '(no extra flags)')
}

// ── Launch ────────────────────────────────────────────────────────────────────
launchBtn.addEventListener('click', async () => {
  if (!envReady) return

  hideStatus()
  launchBtn.disabled = true
  launchBtn.textContent = 'Launching…'

  const result = await window.scrcpy.launch(buildArgs(), selectedSerial)

  launchBtn.disabled = !envReady
  launchBtn.textContent = 'Launch'

  if (result.ok) {
    showStatus(`Launched ✓  (PID ${result.pid})\n${result.cmd}`, 'ok')
  } else {
    showStatus(`Error: ${result.error}`, 'error')
  }
})

function showStatus(msg, type) {
  statusMsg.textContent = msg
  statusMsg.className = `status-msg ${type}`
  statusMsg.hidden = false
}
function hideStatus() { statusMsg.hidden = true }

// ── Transfer (APK install / file push) ────────────────────────────────────────
const installApkBtn = document.getElementById('install-apk-btn')
const pushFileBtn   = document.getElementById('push-file-btn')
const pushTarget    = document.getElementById('push-target')
const transferLog   = document.getElementById('transfer-log')

window.scrcpy.onTransferLog(line => {
  transferLog.hidden = false
  transferLog.textContent += line
  transferLog.scrollTop = transferLog.scrollHeight
})

async function runTransfer(btn, busyLabel, fn) {
  const state = await window.scrcpy.deviceState(selectedSerial)
  if (!state.connected) {
    showStatus(`No device connected (${state.state}). Plug in over USB or connect via Wi-Fi first.`, 'error')
    return
  }
  hideStatus()
  const original = btn.textContent
  btn.disabled = true
  btn.textContent = busyLabel
  transferLog.hidden = false
  transferLog.textContent = ''

  const result = await fn()

  btn.disabled = false
  btn.textContent = original

  if (result.canceled) { transferLog.hidden = true; return }
  if (result.ok)  showStatus(result.summary, 'ok')
  else            showStatus(result.error || result.summary || 'Transfer failed — see log.', 'error')
}

installApkBtn.addEventListener('click', () =>
  runTransfer(installApkBtn, 'Installing…', () => window.scrcpy.installApk(selectedSerial)))

pushFileBtn.addEventListener('click', () =>
  runTransfer(pushFileBtn, 'Pushing…', () => window.scrcpy.pushFiles(pushTarget.value, selectedSerial)))

// ── Init ──────────────────────────────────────────────────────────────────────
updatePreview()
