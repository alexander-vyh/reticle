'use strict';

const pino = require('pino');
const path = require('path');
const fs = require('fs');

const LOG_DIR = path.join(process.env.HOME, '.openclaw', 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Create a named logger that writes JSON to file and pretty output to stdout.
 *
 * @param {string} name - Logger name (used as filename and in log lines)
 * @param {object} [opts] - Options
 * @param {string} [opts.correlationId] - Cross-process correlation ID
 * @returns {import('pino').Logger}
 */
module.exports = function createLogger(name, opts = {}) {
  const level = process.env.LOG_LEVEL || 'info';
  const logFile = path.join(LOG_DIR, `${name}.log`);

  const base = { name };
  if (opts.correlationId) {
    base.correlationId = opts.correlationId;
  }

  const targets = [
    {
      target: 'pino-roll',
      options: {
        file: logFile,
        size: '10m',
        mkdir: true,
        symlink: true,
        limit: { count: 7 }
      },
      level
    },
    {
      target: 'pino-pretty',
      options: {
        destination: 1,
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname'
      },
      level
    }
  ];

  const transport = pino.transport({ targets });

  return pino({ level, base }, transport);
};
