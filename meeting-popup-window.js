#!/usr/bin/env node
'use strict';

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const launcher = require('./platform-launcher');

// Parse meeting data from command line args
// Usage: electron meeting-popup-window.js <base64-encoded-json>
const meetingDataB64 = process.argv.find(a => !a.startsWith('-') && a !== '.' && !a.includes('electron') && !a.includes('meeting-popup'));
let meetingData;

try {
  meetingData = JSON.parse(Buffer.from(meetingDataB64 || '', 'base64').toString('utf8'));
} catch (e) {
  // Also try reading from stdin or direct JSON arg
  try {
    meetingData = JSON.parse(process.argv[process.argv.length - 1]);
  } catch (e2) {
    console.error('No meeting data provided');
    process.exit(1);
  }
}

const SOUNDS = {
  fiveMin: '/System/Library/Sounds/Blow.aiff',
  oneMin: '/System/Library/Sounds/Sosumi.aiff',
  start: '/System/Library/Sounds/Hero.aiff'
};

const COLLAPSED_WIDTH = 80;
const COLLAPSED_HEIGHT = 44;

let mainWindow = null;
let reexpandTimeout = null;
let isCollapsed = false;
let expandedSize = null; // { width, height } — saved when collapsing

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth } = display.workAreaSize;

  const windowWidth = 300;
  const windowHeight = 100 + (meetingData.meetings.length * 150);

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: Math.min(windowHeight, 500),
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
  });

  // Play initial sound based on alert level
  if (meetingData.alertLevel === 'fiveMin') {
    playSound(SOUNDS.fiveMin);
  } else if (meetingData.alertLevel === 'start') {
    playSound(SOUNDS.start);
  }
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

  // Schedule re-expand based on alert level
  const delay = meetingData.alertLevel === 'start' ? 5000 : 30000;
  if (reexpandTimeout) clearTimeout(reexpandTimeout);
  reexpandTimeout = setTimeout(() => {
    expandWindow();
  }, delay);
}

function expandWindow() {
  if (!mainWindow || !isCollapsed) return;

  isCollapsed = false;
  if (reexpandTimeout) clearTimeout(reexpandTimeout);

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

function playSound(soundPath) {
  execFile('afplay', [soundPath], (error) => {
    if (error) console.error('Sound play failed:', error.message);
  });
}

// IPC: Join meeting
ipcMain.on('join-meeting', (event, data) => {
  console.log(JSON.stringify({ action: 'join', ...data }));
  launcher.launchMeeting(data.platform, data.url);
});

// IPC: Dismiss (collapse for fiveMin, quit for tenMin)
ipcMain.on('dismiss', (event, data) => {
  if (data.alertLevel === 'start') {
    // Cannot dismiss at start time
    return;
  }

  if (data.alertLevel === 'fiveMin') {
    collapseWindow();
  } else {
    // tenMin - fully dismiss
    console.log(JSON.stringify({ action: 'dismiss' }));
    if (reexpandTimeout) clearTimeout(reexpandTimeout);
    app.quit();
  }
});

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
  if (reexpandTimeout) clearTimeout(reexpandTimeout);
  app.quit();
});
