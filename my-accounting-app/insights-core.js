(function (global) {
  'use strict';
  const BACKUP_KIND = 'my-accounting-app-backup';
  const BACKUP_VERSION = 1;
  const STORAGE_KEYS = Object.freeze([
    'store_profiles', 'active_store_profile_id', 'active_visit_session',
    'accounting_history', 'saved_simulations', 'app_preferences',
    'timer_state', 'simulation_seed', 'monthly_budget'
  ]);
  const JSON_ARRAY_KEYS = new Set(['store_profiles', 'accounting_history', 'saved_simulations']);
  const JSON_OBJECT_KEYS = new Set(['active_visit_session', 'app_preferences', 'timer_state', 'simulation_seed']);

  function money(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 1e12) : 0;
  }

  function normalizeHistory(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(x => x && typeof x === 'object' && Number.isFinite(Number(x.timestamp)) && Number(x.timestamp) > 0)
      .map(x => ({
        id: String(x.id || ''),
        timestamp: Number(x.timestamp),
        store: String(x.storeName || (x.profileSnapshot && x.profileSnapshot.name) || '未設定'),
        sets: Math.max(0, Math.floor(Number(x.sets) || 0)),
        predicted: money(x.predictedTotal ?? x.total),
        actual: money(x.actualTotal ?? x.total),
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  function monthKey(timestamp) {
    const d = new Date(timestamp);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function filterHistory(records, store, months, now) {
    const reference = now == null ? new Date() : new Date(now);
    const start = months === 0 ? -Infinity :
      new Date(reference.getFullYear(), reference.getMonth() - months + 1, 1).getTime();
    return records.filter(r =>
      (store === 'all' || r.store === store) && r.timestamp >= start && r.timestamp <= reference.getTime()
    );
  }

  function summarize(records, store = 'all', months = 6, now) {
    const reference = now == null ? new Date() : new Date(now);
    const filtered = filterHistory(records, store, months, reference);
    const total = filtered.reduce((sum, r) => sum + r.actual, 0);
    const predicted = filtered.reduce((sum, r) => sum + r.predicted, 0);
    const count = filtered.length;
    const stores = [...new Set(records.map(x => x.store))].sort((a,b) => a.localeCompare(b,'ja'));
    const byStore = Object.values(filtered.reduce((obj, r) => {
      if (!Object.prototype.hasOwnProperty.call(obj, r.store)) obj[r.store] = { name: r.store, total: 0, count: 0 };
      obj[r.store].total += r.actual;
      obj[r.store].count += 1;
      return obj;
    }, Object.create(null))).sort((a,b)=>b.total-a.total);
    const bins = [];
    for (let i = 5; i >= 0; i--) {
      const date = new Date(reference.getFullYear(), reference.getMonth() - i, 1);
      const key = monthKey(date.getTime());
      const group = filtered.filter(r => monthKey(r.timestamp) === key);
      bins.push({ key, label: (date.getMonth()+1) + '月', count: group.length, total: group.reduce((s,r)=>s+r.actual,0) });
    }
    const thisMonth = records.filter(r =>
      (store === 'all' || r.store === store) &&
      monthKey(r.timestamp) === monthKey(reference.getTime()) &&
      r.timestamp <= reference.getTime());
    return {
      records: filtered, stores, count, total, predicted,
      average: count ? Math.round(total / count) : 0,
      difference: total - predicted,
      max: count ? Math.max(...filtered.map(r => r.actual)) : 0,
      monthly: bins, byStore,
      thisMonthTotal: thisMonth.reduce((s,r)=>s+r.actual,0),
      thisMonthCount: thisMonth.length,
    };
  }

  function csvSafe(value) {
    const s = String(value ?? '');
    const safe = /^[\s]*[=+\-@]/.test(s) ? "'" + s : s;
    return '"' + safe.replace(/"/g, '""') + '"';
  }

  function toCsv(records) {
    const lines = [['日時','店舗','セット数','予測金額','実請求額','予測差額'].map(csvSafe).join(',')];
    records.forEach(r => {
      const date = new Date(r.timestamp);
      const stamp = Number.isFinite(date.getTime()) ?
        [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('/') +
        ' ' + [date.getHours(),date.getMinutes()].map(v=>String(v).padStart(2,'0')).join(':') : '';
      lines.push([stamp, r.store, r.sets, r.predicted, r.actual, r.actual - r.predicted].map(csvSafe).join(','));
    });
    return '\uFEFF' + lines.join('\r\n');
  }

  function makeBackup(storage) {
    const result = Object.create(null);
    STORAGE_KEYS.forEach(key => { result[key] = storage.getItem(key); });
    return {
      kind: BACKUP_KIND, formatVersion: BACKUP_VERSION,
      exportedAt: new Date().toISOString(), storage: result
    };
  }

  function parseBackup(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        raw.kind !== BACKUP_KIND || raw.formatVersion !== BACKUP_VERSION ||
        !raw.storage || typeof raw.storage !== 'object' || Array.isArray(raw.storage)) {
      throw new Error('このアプリのバックアップ形式ではありません。');
    }
    const obj = raw.storage;
    const supplied = Object.keys(obj);
    if (!supplied.length || !supplied.every(key => STORAGE_KEYS.includes(key))) {
      throw new Error('バックアップに未知の保存項目があります。');
    }
    for (const key of supplied) {
      const value = obj[key];
      if (value === null) continue;
      if (typeof value !== 'string' || value.length > 1500000) {
        throw new Error('保存データの形式またはサイズが不正です。');
      }
      if (JSON_ARRAY_KEYS.has(key) || JSON_OBJECT_KEYS.has(key)) {
        let parsed;
        try { parsed = JSON.parse(value); } catch { throw new Error(key + ' のJSONが不正です。'); }
        if (JSON_ARRAY_KEYS.has(key) && !Array.isArray(parsed)) {
          throw new Error(key + ' は配列である必要があります。');
        }
        if (JSON_OBJECT_KEYS.has(key) && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
          throw new Error(key + ' はオブジェクトである必要があります。');
        }
      }
      if (key === 'monthly_budget' && (!/^\d+$/.test(value) || Number(value) > 100000000)) {
        throw new Error('月間予算が不正です。');
      }
      if (key === 'active_store_profile_id' && value.length > 300) {
        throw new Error('店舗IDが不正です。');
      }
    }
    return {
      keys: supplied,
      historyCount: obj.accounting_history ? JSON.parse(obj.accounting_history).length : null,
      profileCount: obj.store_profiles ? JSON.parse(obj.store_profiles).length : null,
      storage: obj
    };
  }

  function restoreBackup(storage, validated) {
    const before = Object.create(null);
    STORAGE_KEYS.forEach(key => { before[key] = storage.getItem(key); });
    try {
      validated.keys.forEach(key => {
        const value = validated.storage[key];
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
      });
    } catch (e) {
      STORAGE_KEYS.forEach(key => {
        try {
          if (before[key] === null) storage.removeItem(key);
          else storage.setItem(key, before[key]);
        } catch (_) {}
      });
      throw new Error('保存容量などの問題で復元できませんでした。元データの復旧を試みました。');
    }
  }

  global.InsightsCore = Object.freeze({
    STORAGE_KEYS, normalizeHistory, summarize, toCsv, makeBackup, parseBackup, restoreBackup
  });
})(window);
