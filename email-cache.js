/**
 * Claudia Email Cache
 * Disk-based cache for email content to speed up "View" button
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Cache directory in standard macOS location
const CACHE_DIR = path.join(os.homedir(), 'Library', 'Caches', 'claudia', 'email-cache');

// Maximum age for cache files (24 hours in milliseconds)
const MAX_CACHE_AGE = 24 * 60 * 60 * 1000;

/**
 * Ensure cache directory exists
 */
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Get cache file path for an email ID
 */
function getCacheFilePath(emailId) {
  return path.join(CACHE_DIR, `${emailId}.json`);
}

/**
 * Cache an email
 */
function cacheEmail(emailId, emailData) {
  try {
    ensureCacheDir();
    const cacheData = {
      id: emailId,
      from: emailData.from,
      to: emailData.to || '',
      cc: emailData.cc || '',
      subject: emailData.subject,
      date: emailData.date,
      body: emailData.body,
      cachedAt: Date.now()
    };
    const filePath = getCacheFilePath(emailId);
    fs.writeFileSync(filePath, JSON.stringify(cacheData, null, 2));
    return true;
  } catch (error) {
    console.error(`  ✗ Failed to cache email ${emailId}:`, error.message);
    return false;
  }
}

/**
 * Get cached email (returns null if not found or expired)
 */
function getCachedEmail(emailId) {
  try {
    const filePath = getCacheFilePath(emailId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const cacheData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // Check if cache is expired
    const age = Date.now() - cacheData.cachedAt;
    if (age > MAX_CACHE_AGE) {
      // Delete expired cache file
      fs.unlinkSync(filePath);
      return null;
    }

    return cacheData;
  } catch (error) {
    console.error(`  ✗ Failed to read cache for ${emailId}:`, error.message);
    return null;
  }
}

/**
 * Clean up old cache files (older than MAX_CACHE_AGE)
 */
function cleanOldCache() {
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CACHE_DIR);
    let cleaned = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(CACHE_DIR, file);
      const stats = fs.statSync(filePath);
      const age = Date.now() - stats.mtimeMs;

      if (age > MAX_CACHE_AGE) {
        fs.unlinkSync(filePath);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`  🧹 Cleaned ${cleaned} expired cache file(s)`);
    }

    return cleaned;
  } catch (error) {
    console.error(`  ✗ Failed to clean cache:`, error.message);
    return 0;
  }
}

/**
 * Get cache statistics
 */
function getCacheStats() {
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));

    let totalSize = 0;
    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);
      const stats = fs.statSync(filePath);
      totalSize += stats.size;
    }

    return {
      count: files.length,
      totalSizeBytes: totalSize,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(2)
    };
  } catch (error) {
    return { count: 0, totalSizeBytes: 0, totalSizeMB: '0.00' };
  }
}

module.exports = {
  cacheEmail,
  getCachedEmail,
  cleanOldCache,
  getCacheStats,
  CACHE_DIR
};
