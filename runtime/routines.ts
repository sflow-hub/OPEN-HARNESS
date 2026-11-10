import type { DatabaseSync } from 'node:sqlite';

export const ROUTINES_PER_AGENT = 50;
export type Routine = { id: string; agent_id: string; name: string; prompt: string; interval_minutes: number; timezone: string; schedule_kind: 'interval' | 'cron'; cron_expression: string | null; next_run_at: string };
type Input = Record<string, unknown>;
export function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}
export function parseCron(expression: string) {
  const fields = expression.trim().split(/\s+/), bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  if (fields.length !== 5) throw new Error('Enter a valid five-field cron expression.');
  return fields.map((field, index) => {
    const values = new Set<number>(), [min, max] = bounds[index];
    for (const part of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match) throw new Error('Invalid cron field.');
      const step = Number(match[2] ?? 1), range = match[1].split('-').map(Number);
      const start = match[1] === '*' ? min : range[0], end = match[1] === '*' ? max : range[1] ?? (match[2] ? max : start);
      if (step < 1 || step > max + 1 || start < min || end > max || start > end) throw new Error('Cron field is out of range.');
      for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return { values, wildcard: field === '*' || field.startsWith('*/') };
  });
}

// Resolve a wall-clock slot to its first instant. Gaps map to the first valid
// minute after the gap; folds always select the first copy, even after it passed.
export function nextCron(expression: string, timezone: string, now: Date): Date {
  const fields = parseCron(expression);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const local = (time: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  };
  const start = new Date(local(now.getTime())); start.setUTCHours(0, 0, 0, 0);
  for (let day = start.getTime(); day < start.getTime() + 366 * 8 * 86400000; day += 86400000) {
    const date = new Date(day), dom = fields[2].values.has(date.getUTCDate()), dow = fields[4].values.has(date.getUTCDay());
    const matchesDay = fields[2].wildcard ? dow : fields[4].wildcard ? dom : dom || dow;
    if (!fields[3].values.has(date.getUTCMonth() + 1) || !matchesDay) continue;
    const offsets = [...new Set([-36, -12, 12, 36].map(hour => { const time = day + hour * 3600000; return local(time) - time; }))];
    let earliest = Infinity;
    for (const hour of fields[1].values) for (const minute of fields[0].values) {
      const wall = day + (hour * 60 + minute) * 60000;
      const copies = offsets.map(offset => wall - offset).filter(time => local(time) === wall);
      let instant = copies.length ? Math.min(...copies) : Infinity;
      if (!copies.length) {
        const guesses = offsets.map(offset => wall - offset);
        for (let time = Math.min(...guesses); time <= Math.max(...guesses); time += 60000) {
          const clock = local(time);
          if (clock >= wall && clock < day + 86400000) { instant = time; break; }
        }
      }
      if (instant > now.getTime()) earliest = Math.min(earliest, instant);
    }
    if (Number.isFinite(earliest)) return new Date(earliest);
  }
  throw new Error('Cron expression has no occurrence in the next eight years.');
}
export function nextRoutine(routine: Pick<Routine, 'schedule_kind' | 'cron_expression' | 'timezone' | 'interval_minutes'>, now: Date) {
  return routine.schedule_kind === 'cron' ? nextCron(routine.cron_expression!, routine.timezone, now) : new Date(now.getTime() + routine.interval_minutes * 60000);
}

export function normalizeRoutine(db: DatabaseSync, input: Input, previous?: Routine, internal = false) {
  const agent_id = String(input.agentId ?? previous?.agent_id ?? '');
  if (!db.prepare('SELECT 1 FROM agents WHERE id=?').get(agent_id)) throw new Error('That agent no longer exists.');
  const rawName = input.name === undefined ? previous?.name : input.name, rawPrompt = input.prompt === undefined ? previous?.prompt : input.prompt;
  const name = typeof rawName === 'string' ? rawName.trim().slice(0, 200) : '', prompt = typeof rawPrompt === 'string' ? rawPrompt.trim().slice(0, 20_000) : '';
  if (!name || !prompt) throw new Error('A routine needs a name and a task.');
  const raw = Number(input.intervalMinutes ?? previous?.interval_minutes ?? 60);
  if (!Number.isFinite(raw)) throw new Error('Enter how often this should run, in minutes.');
  // Preserve PUT's integer rounding and inclusive 1..525600 minute clamp.
  const interval_minutes = Math.max(1, Math.min(525600, Math.round(raw)));
  let timezone = input.timezone ?? previous?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!validTimezone(timezone)) {
    if (!internal) throw new Error('Enter a valid IANA timezone.');
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  const schedule_kind = input.scheduleKind ?? previous?.schedule_kind ?? 'interval';
  if (schedule_kind !== 'interval' && schedule_kind !== 'cron') throw new Error('Choose interval or cron scheduling.');
  const cron_expression = schedule_kind === 'cron' ? String(input.cronExpression ?? previous?.cron_expression ?? '') : null;
  if (cron_expression !== null) parseCron(cron_expression);
  if (!previous || previous.agent_id !== agent_id) {
    const count = db.prepare('SELECT COUNT(*) AS count FROM schedules WHERE agent_id=?').get(agent_id) as { count: number };
    if (count.count >= ROUTINES_PER_AGENT) throw new Error(`An agent can have at most ${ROUTINES_PER_AGENT} routines.`);
  }
  return { agent_id, name, prompt, interval_minutes, timezone: timezone as string, schedule_kind: schedule_kind as Routine['schedule_kind'], cron_expression };
}
export function saveRoutine(db: DatabaseSync, input: Input, now: Date, previous?: Routine, internal = false) {
  const value = normalizeRoutine(db, input, previous, internal), id = previous?.id ?? crypto.randomUUID(), stamp = now.toISOString(), next = nextRoutine(value, now).toISOString();
  if (previous) db.prepare('UPDATE schedules SET agent_id=?,name=?,prompt=?,interval_minutes=?,timezone=?,schedule_kind=?,cron_expression=?,next_run_at=?,updated_at=? WHERE id=?').run(value.agent_id, value.name, value.prompt, value.interval_minutes, value.timezone, value.schedule_kind, value.cron_expression, next, stamp, id);
  else db.prepare('INSERT INTO schedules(id,agent_id,name,prompt,interval_minutes,timezone,schedule_kind,cron_expression,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, value.agent_id, value.name, value.prompt, value.interval_minutes, value.timezone, value.schedule_kind, value.cron_expression, next, stamp, stamp);
  return { ...previous, ...value, id, next_run_at: next, updated_at: stamp, nextRunAt: next };
}

// Catch up once using the originally due slot, then rebase to a future slot.
// Failed dispatches advance next_run_at but must not claim a successful last_run_at.
export function tickRoutines(db: DatabaseSync, now: Date, dispatch: (routine: Routine) => { id: string }, failed: (routine: Routine, error: unknown) => void = () => {}) {
  const stamp = now.toISOString();
  const due = db.prepare('SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=?').all(stamp) as Routine[];
  for (const routine of due) {
    try {
      const next = nextRoutine(routine, now).toISOString();
      if (!db.prepare('SELECT 1 FROM schedule_runs WHERE schedule_id=? AND scheduled_for=?').get(routine.id, routine.next_run_at)) {
        try {
          const run = dispatch(routine);
          db.prepare('INSERT INTO schedule_runs(schedule_id,run_id,scheduled_for) VALUES(?,?,?)').run(routine.id, run.id, routine.next_run_at);
          db.prepare('UPDATE schedules SET last_run_at=? WHERE id=?').run(stamp, routine.id);
        } catch (error) { failed(routine, error); }
      }
      db.prepare('UPDATE schedules SET next_run_at=?,updated_at=? WHERE id=?').run(next, stamp, routine.id);
    } catch (error) { failed(routine, error); }
  }
}
