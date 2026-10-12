import db from './db.js';

export async function addDependency(predecessorId, successorId) {
  if (!predecessorId || !successorId) throw new Error('Missing predecessor or successor ID');
  if (predecessorId === successorId) throw new Error('Self-dependencies are not allowed');

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const itemsRes = await client.query('SELECT id, project_id FROM pm_work_items WHERE id IN ($1, $2)', [predecessorId, successorId]);
    if (itemsRes.rows.length !== 2) {
      throw new Error('One or both work items do not exist');
    }

    if (itemsRes.rows[0].project_id !== itemsRes.rows[1].project_id) {
      throw new Error('Work items must belong to the same project');
    }

    const projectId = itemsRes.rows[0].project_id;

    await client.query(
      `INSERT INTO pm_work_item_dependencies (predecessor_id, successor_id, dependency_type)
       VALUES ($1, $2, 'FS')`,
      [predecessorId, successorId]
    );

    // Cycle detection
    const depsRes = await client.query(`
      SELECT d.predecessor_id, d.successor_id
      FROM pm_work_item_dependencies d
      JOIN pm_work_items w ON w.id = d.predecessor_id
      WHERE w.project_id = $1
    `, [projectId]);

    const inDegree = new Map();
    const adj = new Map();
    const allNodes = new Set();

    for (const d of depsRes.rows) {
      allNodes.add(d.predecessor_id);
      allNodes.add(d.successor_id);
      if (!adj.has(d.predecessor_id)) adj.set(d.predecessor_id, []);
      if (!adj.has(d.successor_id)) adj.set(d.successor_id, []);
      if (!inDegree.has(d.predecessor_id)) inDegree.set(d.predecessor_id, 0);
      if (!inDegree.has(d.successor_id)) inDegree.set(d.successor_id, 0);

      adj.get(d.predecessor_id).push(d.successor_id);
      inDegree.set(d.successor_id, inDegree.get(d.successor_id) + 1);
    }

    let visited = 0;
    const queue = [];
    for (const [node, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(node);
    }
    while (queue.length > 0) {
      const u = queue.shift();
      visited++;
      for (const v of adj.get(u)) {
        inDegree.set(v, inDegree.get(v) - 1);
        if (inDegree.get(v) === 0) queue.push(v);
      }
    }

    if (visited !== allNodes.size) {
      throw new Error('Circular dependency detected');
    }

    await client.query('COMMIT');
    return { predecessorId, successorId, type: 'FS' };
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    if (err.code === '23505') return null; // Already exists
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Calculates Critical Path Method (CPM).
 * Throws if a cycle is detected.
 */
export async function calculateSchedule(projectId, isBaseline = false) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const itemsRes = await client.query('SELECT id, estimated_duration FROM pm_work_items WHERE project_id = $1', [projectId]);
    const depsRes = await client.query(`
      SELECT d.predecessor_id, d.successor_id
      FROM pm_work_item_dependencies d
      JOIN pm_work_items w ON w.id = d.predecessor_id
      WHERE w.project_id = $1
    `, [projectId]);

    const items = itemsRes.rows;
    const dependencies = depsRes.rows;

    if (items.length === 0) {
      await client.query('COMMIT');
      return null;
    }

    const adj = new Map();
    const revAdj = new Map();
    const durations = new Map();
    const inDegree = new Map();

    for (const item of items) {
      adj.set(item.id, []);
      revAdj.set(item.id, []);

      if (item.estimated_duration === null || item.estimated_duration === undefined) {
        throw new Error(`Missing duration estimate for work item ${item.id}`);
      }

      const dur = Number(item.estimated_duration);
      if (!Number.isInteger(dur) || dur < 0) {
        throw new Error(`Invalid duration estimate for work item ${item.id}: must be a non-negative integer`);
      }

      durations.set(item.id, dur);
      inDegree.set(item.id, 0);
    }

    for (const dep of dependencies) {
      if (adj.has(dep.predecessor_id) && adj.has(dep.successor_id)) {
        adj.get(dep.predecessor_id).push(dep.successor_id);
        revAdj.get(dep.successor_id).push(dep.predecessor_id);
        inDegree.set(dep.successor_id, inDegree.get(dep.successor_id) + 1);
      }
    }

    // Topological sort (Kahn's algorithm) to detect cycles and get order
    const queue = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }

    const order = [];
    while (queue.length > 0) {
      const u = queue.shift();
      order.push(u);
      for (const v of adj.get(u)) {
        inDegree.set(v, inDegree.get(v) - 1);
        if (inDegree.get(v) === 0) queue.push(v);
      }
    }

    if (order.length !== items.length) {
      throw new Error('Circular dependency detected');
    }

    // Forward Pass (Calculate ES and EF)
    const es = new Map();
    const ef = new Map();
    let maxProjectEF = 0;

    for (const id of order) {
      let maxES = 0;
      for (const pred of revAdj.get(id)) {
        if (ef.get(pred) > maxES) {
          maxES = ef.get(pred);
        }
      }
      es.set(id, maxES);
      const finish = maxES + durations.get(id);
      ef.set(id, finish);
      if (finish > maxProjectEF) {
        maxProjectEF = finish;
      }
    }

    // Backward Pass (Calculate LS and LF)
    const ls = new Map();
    const lf = new Map();

    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      let minLF = maxProjectEF;
      for (const succ of adj.get(id)) {
        if (ls.has(succ) && ls.get(succ) < minLF) {
          minLF = ls.get(succ);
        }
      }
      lf.set(id, minLF);
      ls.set(id, minLF - durations.get(id));
    }

    // Calculate Slack and Critical Path
    const scheduleItems = [];
    for (const id of items.map(i => i.id)) {
      const slack = ls.get(id) - es.get(id);
      const isCritical = slack === 0;
      scheduleItems.push({
        work_item_id: id,
        early_start: es.get(id),
        early_finish: ef.get(id),
        late_start: ls.get(id),
        late_finish: lf.get(id),
        slack,
        is_critical: isCritical
      });
    }

    // Determine version
    const versionRes = await client.query('SELECT COALESCE(MAX(version), 0) + 1 AS next_ver FROM pm_schedules WHERE project_id = $1', [projectId]);
    const version = isBaseline ? versionRes.rows[0].next_ver : 0; // 0 for floating dynamic

    // Delete existing dynamic schedule if not baseline
    if (!isBaseline) {
      await client.query('DELETE FROM pm_schedules WHERE project_id = $1 AND is_baseline = false', [projectId]);
    }

    const schedRes = await client.query(
      'INSERT INTO pm_schedules (project_id, is_baseline, version) VALUES ($1, $2, $3) RETURNING id',
      [projectId, isBaseline, version]
    );
    const scheduleId = schedRes.rows[0].id;

    for (const s of scheduleItems) {
      await client.query(
        `INSERT INTO pm_schedule_items (schedule_id, work_item_id, early_start, early_finish, late_start, late_finish, slack, is_critical)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [scheduleId, s.work_item_id, s.early_start, s.early_finish, s.late_start, s.late_finish, s.slack, s.is_critical]
      );
    }

    await client.query('COMMIT');
    return { scheduleId, scheduleItems };

  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    throw err;
  } finally {
    client.release();
  }
}

export async function getSchedule(projectId) {
  const res = await db.query(`
    SELECT s.id as schedule_id, s.is_baseline, s.version, i.*, w.item_id, w.title
    FROM pm_schedules s
    JOIN pm_schedule_items i ON i.schedule_id = s.id
    JOIN pm_work_items w ON w.id = i.work_item_id
    WHERE s.project_id = $1 AND s.is_baseline = false
  `, [projectId]);
  return res.rows;
}

export default { addDependency, calculateSchedule, getSchedule };
