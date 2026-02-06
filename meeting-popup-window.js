#!/usr/bin/env node
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const launcher = require('./platform-launcher');

// Parse meeting data from command line args
// Usage: electron meeting-popup-window.js <base64-encoded-json>
const meetingDataB64 = process.argv.find(a => !a.startsWith('-') && a !== '.' && !a.includes('electron') && !a.includes('meeting-popup'));
let meetingData;

try {
  meetingData = JSON.parse(Buffer.from(meetingDataB64 || '', 'base64').toString('utf8'));
} catch (e) {
  // Also try direct JSON arg
  try {
    meetingData = JSON.parse(process.argv[process.argv.length - 1]);
  } catch (e2) {
    console.error('No meeting data provided');
    process.exit(1);
  }
}

const COLLAPSED_WIDTH = 80;
const COLLAPSED_HEIGHT = 44;

let mainWindow = null;
let isCollapsed = false;
let expandedSize = null; // { width, height } — saved when collapsing

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth } = display.workAreaSize;

  const startAsPill = meetingData.alertLevel === 'tenMin';
  const windowWidth = startAsPill ? COLLAPSED_WIDTH : 300;
  const windowHeight = startAsPill ? COLLAPSED_HEIGHT : Math.min(100 + (meetingData.meetings.length * 150), 500);

  // Save expanded size for later expand from pill
  if (startAsPill) {
    expandedSize = { width: 300, height: Math.min(100 + (meetingData.meetings.length * 150), 500) };
    isCollapsed = true;
  }

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: screenWidth - windowWidth - 20,
    y: 20,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // macOS-specific: float above everything including fullscreen
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.loadFile(path.join(__dirname, 'meeting-popup.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('meeting-data', meetingData);
    if (startAsPill) {
      mainWindow.webContents.send('start-collapsed');
    }
  });

  // Start listening for escalations from the monitor via stdin
  listenForEscalations();

  // Auto-close 5 minutes after meeting start
  scheduleAutoClose();
}

function collapseWindow() {
  if (!mainWindow || isCollapsed) return;

  const bounds = mainWindow.getBounds();
  expandedSize = { width: bounds.width, height: bounds.height };
  isCollapsed = true;

  // Resize to small pill, anchored to top-right corner
  const x = bounds.x + bounds.width - COLLAPSED_WIDTH;
  const y = bounds.y;
  mainWindow.setBounds({ x, y, width: COLLAPSED_WIDTH, height: COLLAPSED_HEIGHT });

  // Tell renderer to show collapsed view
  mainWindow.webContents.send('collapse');
  // No re-expand timer — collapse means "acknowledged until next threshold via stdin"
}

function expandWindow() {
  if (!mainWindow || !isCollapsed) return;

  isCollapsed = false;

  // Expand from current pill position, anchoring to right edge
  const pillBounds = mainWindow.getBounds();
  const w = expandedSize ? expandedSize.width : 300;
  const h = expandedSize ? expandedSize.height : 250;
  const x = pillBounds.x + pillBounds.width - w;
  const y = pillBounds.y;

  mainWindow.setBounds({ x, y, width: w, height: h });

  // Tell renderer to show expanded view
  mainWindow.webContents.send('expand');
  mainWindow.showInactive();
}

/**
 * Listen for newline-delimited JSON escalation messages from the monitor via stdin.
 */
function listenForEscalations() {
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'escalate') {
          handleEscalation(msg);
        }
      } catch (e) {
        // Not JSON, ignore
      }
    }
  });

  process.stdin.on('end', () => {
    // Monitor disconnected — keep running (user may still want the popup)
  });
}

function handleEscalation(msg) {
  meetingData.alertLevel = msg.alertLevel;
  if (msg.meetings) {
    meetingData.meetings = msg.meetings;
    // Recalculate expanded size in case meeting count changed
    expandedSize = { width: 300, height: Math.min(100 + (msg.meetings.length * 150), 500) };
  }

  // Forward to renderer
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('alert-level-update', {
      alertLevel: msg.alertLevel,
      meetings: msg.meetings
    });
  }

  // If collapsed, expand for the new threshold
  if (isCollapsed) {
    expandWindow();
  }
}

// IPC: Join meeting
ipcMain.on('join-meeting', (event, data) => {
  console.log(JSON.stringify({ action: 'join', ...data }));
  launcher.launchMeeting(data.platform, data.url);
});

// IPC: Dismiss — all non-start levels collapse to pill
ipcMain.on('dismiss', (event, data) => {
  if (data.alertLevel === 'start') {
    return;
  }
  collapseWindow();
});

// Auto-close 5 minutes after meeting start time
function scheduleAutoClose() {
  if (!meetingData.meetings || meetingData.meetings.length === 0) return;
  const earliest = meetingData.meetings
    .map(m => new Date(m.startTime).getTime())
    .reduce((a, b) => Math.min(a, b));
  const autoCloseAt = earliest + 5 * 60 * 1000;
  const delay = autoCloseAt - Date.now();
  if (delay <= 0) {
    // Already past auto-close time — close now
    app.quit();
  } else {
    setTimeout(() => app.quit(), delay);
  }
}

// IPC: Expand from collapsed pill
ipcMain.on('expand', () => {
  expandWindow();
});

// IPC: Move window by delta (for custom pill dragging)
ipcMain.on('move-window', (event, { deltaX, deltaY }) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + deltaX, y + deltaY);
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
