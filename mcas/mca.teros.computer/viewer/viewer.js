// Live view of an agent's computer. Served by the computer itself and reached
// through the Teros backend proxy (/computer/<ticket>/…), so every URL here is
// relative to the page.
import RFB from './novnc/core/rfb.js';

const $ = (id) => document.getElementById(id);
const screenEl = $('screen');
const statusEl = $('status');
const hintEl = $('hint');
const takeBtn = $('take');
const releaseBtn = $('release');
const overlay = $('overlay');

let rfb = null;
let control = { holder: 'agent' };
let retry = 0;

function showOverlay(text) {
  overlay.textContent = text;
  overlay.hidden = !text;
}

function render() {
  const human = control.holder === 'human';
  statusEl.className = `pill ${rfb ? (human ? 'pill-human' : 'pill-agent') : 'pill-wait'}`;
  statusEl.textContent = !rfb ? 'Connecting…' : human ? 'You are in control' : 'Agent is driving';
  hintEl.textContent = human
    ? 'The agent is paused. Log in or do what you need, then hand back.'
    : 'View only. Take over to use the mouse and keyboard (the agent pauses).';
  takeBtn.hidden = !rfb || human;
  releaseBtn.hidden = !rfb || !human;
  if (rfb) {
    rfb.viewOnly = !human;
    screenEl.classList.toggle('view-only', !human);
    if (human) rfb.focus();
  }
  window.parent?.postMessage({ type: 'teros-computer-control', holder: control.holder }, '*');
}

async function refreshControl() {
  try {
    const res = await fetch('control', { cache: 'no-store' });
    if (res.status === 401 || res.status === 403) {
      showOverlay('This view link expired. Reopening…');
      // The Teros window issues a fresh link; standalone tabs must be reopened.
      window.parent?.postMessage({ type: 'teros-computer-expired' }, '*');
      return;
    }
    if (res.ok) {
      control = await res.json();
      render();
    }
  } catch {
    /* transient: keep polling */
  }
}

async function setControl(action) {
  takeBtn.disabled = releaseBtn.disabled = true;
  try {
    const res = await fetch('control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (res.ok) control = await res.json();
  } finally {
    takeBtn.disabled = releaseBtn.disabled = false;
    render();
  }
}

function connect() {
  const url = new URL('vnc', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  showOverlay('');
  const conn = new RFB(screenEl, url.href, { shared: true });
  conn.scaleViewport = true;
  conn.resizeSession = false;
  conn.viewOnly = true;
  conn.background = '#0b0d12';
  conn.addEventListener('connect', () => {
    retry = 0;
    rfb = conn;
    refreshControl();
  });
  conn.addEventListener('disconnect', () => {
    rfb = null;
    render();
    retry = Math.min(retry + 1, 6);
    const delay = 500 * 2 ** retry;
    showOverlay(`Disconnected from the computer. Reconnecting in ${Math.round(delay / 1000)} s…`);
    setTimeout(connect, delay);
  });
}

takeBtn.addEventListener('click', () => setControl('take'));
releaseBtn.addEventListener('click', () => setControl('release'));
setInterval(refreshControl, 2000);
connect();
render();
