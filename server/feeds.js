// Live course listings from a provider's public catalogue, looked up by skill and kept for a day.
// Connector: Coursera's catalogue (api.coursera.org/api/courses.v1). It is read-only and sends nothing about students:
// only the skill name. If the provider is unreachable or answers in an unexpected shape, the feed reports that
// and students simply see the checked courses and search links instead.
const DAY = 24 * 60 * 60 * 1000;
const enabled = (env = process.env) => (env.COURSE_FEED ?? 'coursera') === 'coursera';

async function searchCoursera(skill) {
  const url = 'https://api.coursera.org/api/courses.v1?q=search&query=' + encodeURIComponent(skill) + '&limit=6&fields=name,slug';
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Coursera answered ' + r.status);
  const j = await r.json();
  if (!j || !Array.isArray(j.elements)) throw new Error('Coursera answered in an unexpected format');
  return j.elements
    .filter((e) => e && typeof e.name === 'string' && typeof e.slug === 'string' && /^[a-z0-9-]+$/i.test(e.slug))
    .slice(0, 4)
    .map((e) => ({ title: e.name.slice(0, 200), provider: 'Coursera', url: 'https://www.coursera.org/learn/' + e.slug }));
}

function makeFeeds(h) {
  const busy = new Set();
  const setStatus = (ok, message) => h.run("INSERT INTO feed_status (name, ok, message, checked_at) VALUES ('coursera', ?, ?, ?) ON CONFLICT(name) DO UPDATE SET ok = excluded.ok, message = excluded.message, checked_at = excluded.checked_at", ok ? 1 : 0, message, Date.now());
  async function refresh(skill) {
    if (busy.has(skill)) return null;
    busy.add(skill);
    try {
      const rows = await searchCoursera(skill);
      h.tx(() => {
        h.run('DELETE FROM live_courses WHERE skill = ?', skill);
        for (const c of rows) h.run('INSERT INTO live_courses (skill, title, provider, url, fetched_at) VALUES (?, ?, ?, ?, ?)', skill, c.title, c.provider, c.url, Date.now());
        // Remember that we looked, even when nothing matched, so we do not ask again all day.
        if (!rows.length) h.run("INSERT INTO live_courses (skill, title, provider, url, fetched_at) VALUES (?, '', '', '', ?)", skill, Date.now());
      });
      setStatus(true, rows.length + ' courses for "' + skill + '"');
      return rows;
    } catch (e) { setStatus(false, String(e.message || e).slice(0, 200)); throw e; } finally { busy.delete(skill); }
  }
  // Never makes a student wait: returns what is stored and refreshes in the background when it is a day old.
  function forSkill(skill) {
    if (!enabled()) return { courses: [], checkedAt: null };
    const rows = h.all('SELECT title, provider, url, fetched_at FROM live_courses WHERE skill = ? ORDER BY rowid', skill);
    const checkedAt = rows.length ? rows[0].fetched_at : null;
    if (!checkedAt || Date.now() - checkedAt > DAY) refresh(skill).catch(() => {});
    return { courses: rows.filter((r) => r.url).map(({ title, provider, url }) => ({ title, provider, url })), checkedAt };
  }
  const status = () => ({ enabled: enabled(), ...(h.get("SELECT ok, message, checked_at FROM feed_status WHERE name = 'coursera'") || { ok: null, message: 'Not tried yet', checked_at: null }) });
  return { forSkill, refresh, status };
}

module.exports = { makeFeeds, searchCoursera, enabled };
