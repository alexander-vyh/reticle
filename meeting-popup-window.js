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

let mainWindow = null;
let reexpandInterval = null;

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth } = display.workAreaSize;

  const windowWidth = 300;
  const windowHeight = 60 + (meetingData.meetings.length * 120);

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

  // Set up re-expansion behavior for 5min and start alerts
  setupReexpand(meetingData.alertLevel);

  // Play initial sound based on alert level
  if (meetingData.alertLevel === 'fiveMin') {
    playSound(SOUNDS.fiveMin);
  } else if (meetingData.alertLevel === 'start') {
    playSound(SOUNDS.start);
  }
}

function setupReexpand(alertLevel) {
  if (alertLevel === 'fiveMin') {
    // Re-expand every 30 seconds if minimized
    reexpandInterval = setInterval(() => {
      if (mainWindow && mainWindow.isMinimized()) {
        mainWindow.restore();
        mainWindow.focus();
      }
    }, 30 * 1000);
  } else if (alertLevel === 'start') {
    // Re-expand every 5 seconds - cannot minimize
    reexpandInterval = setInterval(() => {
      if (mainWindow) {
        mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    }, 5 * 1000);
  }
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

// IPC: Dismiss
ipcMain.on('dismiss', (event, data) => {
  if (data.alertLevel === 'start') {
    // Cannot dismiss at start time - re-show
    return;
  }

  if (data.alertLevel === 'fiveMin') {
    // Minimize (will re-expand)
    mainWindow.minimize();
  } else {
    // tenMin - fully dismiss
    console.log(JSON.stringify({ action: 'dismiss' }));
    if (reexpandInterval) clearInterval(reexpandInterval);
    app.quit();
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (reexpandInterval) clearInterval(reexpandInterval);
  app.quit();
});
