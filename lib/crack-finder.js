'use strict';

/**
 * Crack Finder — pure graph queries to surface credibility gaps.
 *
 * Queries the org-memory knowledge graph for patterns that indicate
 * follow-through failure: stale commitments, low resolution rates,
 * and accumulation of open items.
 *
 * No AI at consumption time — all signals are deterministic SQL.
 */

/**
 * Find credibility cracks across entities.
 *
 * @param {Object} db - org-memory database
 * @param {Object} [opts]
 * @param {number} [opts.staleDays=7] - Days after which an open item is stale
 * @param {boolean} [opts.monitoredOnly=false] - Only include monitored entities
 * @param {number} [opts.topN=5] - Max stale items per entity to return
 * @returns {Object[]} Ranked array of cracks, highest severity first
 */
function findCracks(db, { staleDays = 7, monitoredOnly = false, topN = 5 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const staleThreshold = now - staleDays * 86400;

  let entityFilter = "WHERE e.entity_type = 'person' AND e.is_active = 1";
  if (monitoredOnly) entityFilter += ' AND e.monitored = 1';

  const rows = db.prepare(`
    SELECT
      e.id AS entity_id,
      e.canonical_name,
      e.monitored,
      COUNT(CASE WHEN f.resolution = 'open' THEN 1 END) AS open_count,
      COUNT(CASE WHEN f.resolution = 'open' AND f.valid_from < ${staleThreshold} THEN 1 END) AS stale_count,
      COUNT(CASE WHEN f.resolution = 'completed' THEN 1 END) AS resolved_count,
      COUNT(CASE WHEN f.resolution = 'abandoned' THEN 1 END) AS abandoned_count,
      COUNT(*) AS total_count,
      MIN(CASE WHEN f.resolution = 'open' THEN f.valid_from END) AS oldest_open_at
    FROM entities e
    JOIN facts f ON f.entity_id = e.id
      AND f.fact_type = 'event'
      AND f.attribute IN ('committed_to', 'asked_to')
    ${entityFilter}
    GROUP BY e.id
    HAVING open_count > 0
    ORDER BY stale_count DESC, open_count DESC
  `).all();

  return rows.map(r => {
    const oldestDays = r.oldest_open_at ? Math.floor((now - r.oldest_open_at) / 86400) : 0;
    const followThroughRate = r.total_count > 0
      ? r.resolved_count / r.total_count
      : 1;

    // Severity: stale count is primary, follow-through rate is secondary
    let severity;
    if (r.stale_count >= 5 || (r.stale_count >= 2 && oldestDays >= 14)) {
      severity = 'critical';
    } else if (r.stale_count >= 2 || (r.stale_count >= 1 && oldestDays >= 14)) {
      severity = 'high';
    } else if (r.stale_count >= 1) {
      severity = 'medium';
    } else {
      severity = 'low';
    }

    // Fetch top stale items for this entity
    const staleItems = db.prepare(`
      SELECT f.id, f.attribute, f.value, f.valid_from, f.source_message_id
      FROM facts f
      WHERE f.entity_id = ? AND f.fact_type = 'event'
        AND f.attribute IN ('committed_to', 'asked_to')
        AND f.resolution = 'open' AND f.valid_from < ?
      ORDER BY f.valid_from ASC
      LIMIT ?
    `).all(r.entity_id, staleThreshold, topN);

    return {
      entityId: r.entity_id,
      entityName: r.canonical_name,
      monitored: r.monitored === 1,
      severity,
      openCount: r.open_count,
      staleCount: r.stale_count,
      resolvedCount: r.resolved_count,
      abandonedCount: r.abandoned_count,
      totalCount: r.total_count,
      followThroughRate: Math.round(followThroughRate * 100) / 100,
      oldestDays,
      topStaleItems: staleItems.map(f => ({
        id: f.id,
        attribute: f.attribute,
        value: f.value,
        ageDays: Math.floor((now - f.valid_from) / 86400),
        sourceMessageId: f.source_message_id,
      })),
    };
  });
}

module.exports = { findCracks };
