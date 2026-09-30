'use strict';

// 重剪视频区间时码重排
//
// 排练视频重剪后，编辑在修订分支或合并分支上选择连续的原稿来源序号区间
// [source_start, source_end]，并填写该区间在新版视频中的起止时码
// (new_start_ms, new_end_ms)：
//   - 区间内完整片段（拆分出的同来源片段自然一起）按原有相对位置等比重排；
//   - 区间之后的片段按（新区间终点 - 原区间终点）整体平移；
//   - 区间之前的片段不动；
//   - 跨越选择边界的合并片段（一个分支片段同时挂区间内与区间外来源）拒绝；
//   - 提交须整体成功或不改动；无效区间、非正时长、负时码、片段重叠或
//     换算后片段时长为零一律给出原因并拒绝。
//
// 预览只做计算不写库，返回受影响片段的新旧时码与时间线问题及一次性预览令牌
// （绑定分支状态指纹）；预览后分支被编辑、拆分、合并或重置，提交因指纹不符
// 被拒绝，要求重新预览。
//
// 质检联动：仅时码真正发生变化的片段推进 rev（其旧豁免随之失效），
// 时码未变的片段 rev 不动（不被误判为改动）；分支状态指纹变化后旧质检
// 报告自动标记失效；质检导出闸门始终按当前状态实时核验。

const crypto = require('crypto');
const { validateTimeline, msToSrt, parseTimecode } = require('./srt');
const { branchStateHash } = require('./qc');

class RemapError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.statusCode = status;
    Object.assign(this, extra || {});
  }
}

// ---------------- 输入解析 ----------------

function readInt(body, key, label) {
  const raw = body[key];
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) throw new RemapError(400, `${label}必须为整数毫秒`);
    return raw;
  }
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  throw new RemapError(400, `${label}必须为整数毫秒或 HH:MM:SS,mmm 时码`);
}

// 解析端点入参：非负整数毫秒，或 HH:MM:SS,mmm（亦接受点号分隔）；负时码拒绝。
function readEndpoint(body, key, label) {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === '') {
    throw new RemapError(400, `缺少${label}`);
  }
  let ms;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) throw new RemapError(400, `${label}必须为整数毫秒或 HH:MM:SS,mmm 时码`);
    ms = raw;
  } else if (typeof raw === 'string') {
    if (/^-?\d+$/.test(raw.trim())) {
      ms = Number(raw.trim());
    } else {
      ms = parseTimecode(raw);
      if (ms == null) {
        throw new RemapError(400, `${label}时码格式错误：「${raw.slice(0, 40)}」，应为 HH:MM:SS,mmm`);
      }
    }
  } else {
    throw new RemapError(400, `${label}必须为整数毫秒或 HH:MM:SS,mmm 时码`);
  }
  if (ms < 0) throw new RemapError(400, `${label}不能为负时码（${raw}）`);
  return ms;
}

function readRange(body, sourceCount) {
  const lo = readInt(body, 'source_start', '来源起始序号');
  const hi = readInt(body, 'source_end', '来源结束序号');
  if (lo < 1 || hi < 1) throw new RemapError(400, '来源序号必须为不小于 1 的正整数');
  if (lo > hi) throw new RemapError(400, `无效区间：起始序号 ${lo} 大于结束序号 ${hi}`);
  if (sourceCount === 0) throw new RemapError(400, '该分支没有任何来源片段，无法按来源序号选择区间');
  if (hi > sourceCount) {
    throw new RemapError(400, `无效区间：来源序号 ${hi} 超出原稿范围（原稿共 ${sourceCount} 条）`);
  }
  return { lo, hi };
}

// ---------------- 数据装配 ----------------

function loadBranchView(db, branchId) {
  const branch = db.prepare('SELECT id, script_id, name, kind FROM branches WHERE id = ?').get(branchId);
  if (!branch) throw new RemapError(404, '分支不存在');

  const segRows = db.prepare(`
    SELECT bs.id, bs.ord, bs.start_ms, bs.end_ms, bs.text, bs.rev,
           GROUP_CONCAT(ss.source_id) AS source_ids
    FROM branch_segments bs
    LEFT JOIN segment_sources ss ON ss.branch_segment_id = bs.id
    WHERE bs.branch_id = ?
    GROUP BY bs.id
    ORDER BY bs.ord
  `).all(branchId);

  const srcRows = db.prepare(
    'SELECT id, seq FROM source_segments WHERE script_id = ?'
  ).all(branch.script_id);
  const seqById = new Map(srcRows.map((r) => [r.id, r.seq]));

  const segments = segRows.map((row) => ({
    id: row.id,
    ord: row.ord,
    start_ms: row.start_ms,
    end_ms: row.end_ms,
    text: row.text,
    rev: row.rev,
    source_ids: row.source_ids ? row.source_ids.split(',').map(Number) : [],
    source_seqs: Array.from(new Set(
      (row.source_ids ? row.source_ids.split(',').map(Number) : [])
        .map((sid) => seqById.get(sid))
        .filter((s) => s != null)
    )).sort((a, b) => a - b)
  }));

  return { branch, segments, sourceCount: srcRows.length };
}

// ---------------- 核心计算 ----------------

/**
 * 计算重排方案（不落库）。
 * @returns {object} 预览数据（含受影响片段新旧时码、时间线问题、令牌）
 */
function buildPlan(db, branchId, body) {
  const { branch, segments, sourceCount } = loadBranchView(db, branchId);
  const { lo, hi } = readRange(body || {}, sourceCount);
  const newStart = readEndpoint(body || {}, 'new_start_ms', '新区间起点');
  const newEnd = readEndpoint(body || {}, 'new_end_ms', '新区间终点');
  if (!(newEnd > newStart)) {
    throw new RemapError(400, `新区间时长非正：起点 ${msToSrt(newStart)} 必须严格早于终点 ${msToSrt(newEnd)}`);
  }

  const errors = [];

  // 1) 结构校验：ord 连续、每个片段都能识别来源；按来源把片段分为
  //    before / range / after / crossing 四类。
  segments.forEach((seg, idx) => {
    if (seg.ord !== idx + 1) {
      errors.push(`片段数据异常：第 ${idx + 1} 行的分支内序号为 ${seg.ord}，请联系管理员`);
    }
    if (!seg.source_seqs.length) {
      errors.push(`片段 #${seg.ord} 没有关联任何原稿来源，无法按来源序号区间处理`);
    }
  });

  const before = [];
  const range = [];
  const after = [];
  const crossing = [];
  for (const seg of segments) {
    if (!seg.source_seqs.length) continue;
    const sLo = seg.source_seqs[0];
    const sHi = seg.source_seqs[seg.source_seqs.length - 1];
    if (sHi < lo) before.push(seg);
    else if (sLo > hi) after.push(seg);
    else if (sLo >= lo && sHi <= hi) range.push(seg);
    else crossing.push({ seg, sLo, sHi });
  }

  // 跨越选择边界的合并片段：无法只重排其一部分，必须先在分支上拆开
  for (const c of crossing) {
    errors.push(
      `片段 #${c.seg.ord} 是跨来源 #${c.sLo}–#${c.sHi} 的合并片段，跨越所选区间边界 ` +
      `#${lo}–#${hi}，请先在分支上拆分该片段后再重排（已拒绝，未改动任何数据）`
    );
  }

  // 选择区间内的每个来源序号都必须在本分支上有片段覆盖（拆分/合并结构异常时给出原因）
  const covered = new Set();
  for (const seg of range) seg.source_seqs.forEach((s) => covered.add(s));
  const gaps = [];
  for (let s = lo; s <= hi; s++) if (!covered.has(s)) gaps.push(s);
  if (gaps.length) {
    errors.push(`所选来源区间 #${lo}–#${hi} 内的来源 ${gaps.join('、')} 在本分支上没有对应片段，无法整体重排`);
  }

  // ord 顺序必须与来源划分一致（理论上来源有序即成立，这里做防御性校验）
  const ordBad =
    (before.length && range.length && before[before.length - 1].ord > range[0].ord) ||
    (range.length && after.length && range[range.length - 1].ord > after[0].ord) ||
    (before.length && after.length && before[before.length - 1].ord > after[0].ord);
  if (ordBad) errors.push('片段顺序与来源序号不一致，无法安全重排');

  if (errors.length) {
    throw new RemapError(400, `区间重排校验失败，共 ${errors.length} 处问题，已拒绝（不改动任何数据）`, {
      remap_errors: errors.map((message) => ({ message }))
    });
  }

  // 2) 原区间外边界：取区间内片段在当前分支时间线上的最小起点 / 最大终点
  const oldStart = range.reduce((m, s) => Math.min(m, s.start_ms), Infinity);
  const oldEnd = range.reduce((m, s) => Math.max(m, s.end_ms), -Infinity);
  if (!(oldEnd > oldStart)) {
    throw new RemapError(400, `区间原时长非正：来源 #${lo}–#${hi} 的当前时码外边界为 ${msToSrt(oldStart)} --> ${msToSrt(oldEnd)}，请先修正该区间片段时间`);
  }
  if (oldStart < 0) throw new RemapError(400, '区间起点为负时码，请先修正时间线');

  const scale = (newEnd - newStart) / (oldEnd - oldStart);
  const delta = newEnd - oldEnd;

  const mapRange = (ms) => newStart + Math.round((ms - oldStart) * scale);

  // 3) 逐条给出新时码。区间首尾端点强制贴齐输入，中间按等比换算；
  //    区间后整体平移；区间前不动。
  const proposedById = new Map();
  const affected = [];
  for (const seg of range) {
    const ns = seg.ord === range[0].ord ? newStart : mapRange(seg.start_ms);
    const ne = seg.ord === range[range.length - 1].ord ? newEnd : mapRange(seg.end_ms);
    proposedById.set(seg.id, { start_ms: ns, end_ms: ne });
    affected.push({
      id: seg.id, ord: seg.ord, group: 'range', source_seqs: seg.source_seqs,
      old_start_ms: seg.start_ms, old_end_ms: seg.end_ms,
      new_start_ms: ns, new_end_ms: ne,
      old_timecode: tcPair(seg.start_ms, seg.end_ms),
      new_timecode: tcPair(ns, ne),
      delta_start_ms: ns - seg.start_ms, delta_end_ms: ne - seg.end_ms,
      changed: ns !== seg.start_ms || ne !== seg.end_ms,
      text: seg.text
    });
  }
  for (const seg of after) {
    const ns = seg.start_ms + delta;
    const ne = seg.end_ms + delta;
    proposedById.set(seg.id, { start_ms: ns, end_ms: ne });
    affected.push({
      id: seg.id, ord: seg.ord, group: 'after', source_seqs: seg.source_seqs,
      old_start_ms: seg.start_ms, old_end_ms: seg.end_ms,
      new_start_ms: ns, new_end_ms: ne,
      old_timecode: tcPair(seg.start_ms, seg.end_ms),
      new_timecode: tcPair(ns, ne),
      delta_start_ms: delta, delta_end_ms: delta,
      changed: delta !== 0,
      text: seg.text
    });
  }
  for (const seg of before) {
    proposedById.set(seg.id, { start_ms: seg.start_ms, end_ms: seg.end_ms });
  }

  // 4) 对换算后的整条时间线做校验，标注问题归属与原因
  const ordToGroup = new Map();
  before.forEach((s) => ordToGroup.set(s.ord, 'before'));
  range.forEach((s) => ordToGroup.set(s.ord, 'range'));
  after.forEach((s) => ordToGroup.set(s.ord, 'after'));
  const proposed = segments.map((s) => ({
    ord: s.ord,
    start_ms: proposedById.get(s.id).start_ms,
    end_ms: proposedById.get(s.id).end_ms
  }));
  const rawIssues = validateTimeline(proposed);
  const issues = rawIssues.map((it) =>
    decorateIssue(it, ordToGroup.get(it.ord) || 'unknown', lo, hi, oldStart, oldEnd, newStart, newEnd, delta));

  // 5) 状态指纹与预览令牌
  const state_hash = branchStateHash(segments);
  const token = makeToken({
    branchId, state_hash, lo, hi, newStart, newEnd
  });

  return {
    branch: { id: branch.id, name: branch.name, kind: branch.kind },
    source_start: lo,
    source_end: hi,
    old_start_ms: oldStart,
    old_end_ms: oldEnd,
    new_start_ms: newStart,
    new_end_ms: newEnd,
    old_timecode: tcPair(oldStart, oldEnd),
    new_timecode: tcPair(newStart, newEnd),
    shift_after_ms: delta,
    scale: Number(scale.toFixed(6)),
    counts: {
      before: before.length,
      range: range.length,
      after: after.length,
      affected: affected.length,
      changed: affected.filter((a) => a.changed).length
    },
    affected,
    issues,
    can_commit: issues.length === 0,
    state_hash,
    preview_token: token
  };
}

function decorateIssue(it, group, lo, hi, oldStart, oldEnd, newStart, newEnd, delta) {
  // validateTimeline 对重叠问题给出的 ord 是“后一条”的序号；时间码已在文案里。
  let message = it.message;
  if (/时间不能为负/.test(message)) {
    message = `${message}；负时码由本次重排产生，已拒绝`;
  } else if (/起点必须早于终点/.test(message)) {
    if (group === 'range') {
      message = `${message}；该片段在等比重排后时长为零或反转（新区间 ${msToSrt(newStart)} --> ${msToSrt(newEnd)}，原区间 ${msToSrt(oldStart)} --> ${msToSrt(oldEnd)}），已拒绝`;
    } else if (group === 'after') {
      message = `${message}；该片段随区间后片段整体平移 ${delta} 毫秒后仍为非正时长，已拒绝`;
    } else {
      message = `${message}；该问题位于所选区间之外，本次重排不会修改它，但仍会阻止提交，请先修复`;
    }
  } else if (/时间重叠|没有可导出的片段/.test(message)) {
    message = group === 'range'
      ? `${message}；重叠由本次区间重排产生，已拒绝`
      : group === 'after'
        ? `${message}；该片段整体平移 ${delta} 毫秒后与相邻片段重叠，已拒绝`
        : `${message}；该问题位于所选区间之外，本次重排不会修改它，但仍会阻止提交，请先修复`;
  }
  return { ...it, message, segment_group: group, source_start: lo, source_end: hi };
}

function tcPair(a, b) {
  return `${msToSrt(a)} --> ${msToSrt(b)}`;
}

// ---------------- 预览令牌 ----------------

function tokenPayload({ branchId, state_hash, lo, hi, newStart, newEnd }) {
  return [branchId, state_hash, lo, hi, newStart, newEnd].join('|');
}

function makeToken(payload) {
  return crypto.createHash('sha256').update(`remap:${tokenPayload(payload)}`).digest('hex');
}

function timingEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------------- 提交 ----------------

/**
 * 按预览令牌提交重排。预览后分支被编辑、拆分、合并或重置（状态指纹变化），
 * 或请求参数与预览不一致，一律 409 拒绝并要求重新预览。
 */
function commitRemap(db, branchId, body) {
  const token = body && body.preview_token;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    throw new RemapError(400, '缺少有效的 preview_token，请先调用预览接口');
  }

  // 先计算当前状态下的方案：输入非法仍返回 400
  const plan = buildPlan(db, branchId, body);

  const expected = makeToken({
    branchId,
    state_hash: plan.state_hash,
    lo: plan.source_start,
    hi: plan.source_end,
    newStart: plan.new_start_ms,
    newEnd: plan.new_end_ms
  });
  if (!timingEqual(token, expected)) {
    // 令牌不匹配只有两种可能：提交参数与预览不一致，或预览后分支发生了变化
    // （编辑/拆分/合并/重置都会改变状态指纹）。无论哪种都要求重新预览。
    throw new RemapError(409, '预览已失效：预览后分支已被编辑、拆分、合并或重置，或提交参数与预览不一致，请重新预览后再提交', {
      preview_stale: true
    });
  }

  if (plan.issues.length) {
    throw new RemapError(409, `时间线校验未通过，共 ${plan.issues.length} 处问题，本次重排未提交（分支未做任何改动）`, {
      issues: plan.issues
    });
  }

  const changed = plan.affected.filter((a) => a.changed);

  db.transaction(() => {
    const upd = db.prepare(
      'UPDATE branch_segments SET start_ms = ?, end_ms = ?, rev = rev + 1 WHERE id = ? AND branch_id = ?'
    );
    for (const a of changed) upd.run(a.new_start_ms, a.new_end_ms, a.id, branchId);
  })();

  return {
    ok: true,
    branch_id: branchId,
    source_start: plan.source_start,
    source_end: plan.source_end,
    affected_count: plan.affected.length,
    changed_count: changed.length,
    shift_after_ms: plan.shift_after_ms,
    new_timecode: plan.new_timecode
  };
}

module.exports = { buildPlan, commitRemap, RemapError };
