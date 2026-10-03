import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

export const SOAK_MODES = Object.freeze({
  soak: Object.freeze({ durationMs: 24 * 60 * 60_000, periodMs: 5 * 60_000, maxGapMs: 10 * 60_000, minimumCycles: 288 }),
  smoke: Object.freeze({ durationMs: 5 * 60_000, periodMs: 30_000, maxGapMs: 5 * 60_000, minimumCycles: 3 }),
});
// Normal clock discipline may step wall time back slightly; more than this is not a trustworthy record.
export const WALL_STEP_BACK_TOLERANCE_MS = 60_000;

export function soakMode(args) {
  const modes = args.filter(arg => arg === '--soak' || arg === '--soak-smoke');
  assert.ok(modes.length <= 1, 'Choose --soak or --soak-smoke, once.');
  assert.ok(!modes.length || !args.includes('--config-only'), 'A soak cannot be config-only.');
  return modes[0] === '--soak' ? 'soak' : modes[0] === '--soak-smoke' ? 'smoke' : null;
}

// Monotonic time and a maximum observation gap prevent a clock adjustment or
// stalled runner from turning a short burst of work into a 24-hour pass. The
// monotonic clock does not advance while the machine or its VM is suspended
// (CLOCK_MONOTONIC on Linux, mach_absolute_time on macOS), so wall time is
// checked alongside it: a suspension shows up only as missing wall time.
export async function runSoakLoop({ mode, cycle, sample, restart, record, now = () => performance.now(), wallNow = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  assert.ok(Object.hasOwn(SOAK_MODES, mode), 'Unknown soak mode.');
  const policy = SOAK_MODES[mode], start = now(), wallStart = wallNow();
  let lastObserved = start, lastWall = wallStart, cycles = 0, restarts = 0, samples = 0;
  const elapsed = () => {
    const current = now(), wall = wallNow();
    assert.ok(Number.isFinite(current) && current >= lastObserved, 'Monotonic soak clock moved backwards.');
    assert.ok(current - lastObserved <= policy.maxGapMs, 'Soak observation gap exceeded the limit; suspended or stalled run cannot pass.');
    assert.ok(Number.isFinite(wall) && wall - lastWall >= -WALL_STEP_BACK_TOLERANCE_MS, 'Wall clock moved backwards; the observation record cannot be trusted.');
    assert.ok(wall - lastWall <= policy.maxGapMs, 'Wall-clock observation gap exceeded the limit; the machine or VM was suspended or paused.');
    assert.ok(Math.abs((wall - wallStart) - (current - start)) <= policy.maxGapMs, 'Wall and monotonic clocks diverged; accumulated suspension cannot count as soak time.');
    lastObserved = current;
    lastWall = wall;
    return current - start;
  };
  const emit = (type, detail = {}) => record({ type, elapsedMs: elapsed(), wallElapsedMs: lastWall - wallStart, ...detail });
  const observe = async () => { const resources = await sample(); samples += 1; await emit('resources', { resources }); };
  await emit('start', { mode, policy });
  try {
    for (;;) {
      await observe();
      if (!restarts && elapsed() >= policy.durationMs / 2) {
        await emit('restart-start');
        const result = await restart();
        restarts += 1;
        await emit('restart-complete', { result });
      }
      await emit('cycle-start', { index: cycles });
      const result = await cycle(cycles);
      cycles += 1;
      await emit('cycle-complete', { index: cycles - 1, result });
      await observe();
      if (elapsed() >= policy.durationMs) break;
      const next = Math.min(start + policy.durationMs, start + cycles * policy.periodMs);
      while (now() < next) {
        await sleep(Math.min(60_000, next - now()));
        await observe();
      }
    }
    const elapsedMs = elapsed();
    assert.equal(restarts, 1, 'Soak requires one successful coordinator restart.');
    assert.ok(cycles >= policy.minimumCycles, `Soak requires at least ${policy.minimumCycles} completed cycles.`);
    const result = { ok: true, mode, elapsedMs, wallElapsedMs: lastWall - wallStart, cycles, samples, restarts, durationQualified: mode === 'soak' && elapsedMs >= SOAK_MODES.soak.durationMs };
    // Not a receipt: the caller still makes its end-of-run identity checks and
    // records the final `complete` entry only after they pass.
    await emit('loop-complete', { cycles, samples, restarts });
    return result;
  } catch (error) {
    // Avoid the clock guard here so the reason for a gap is still journaled.
    await record({ type: 'failed', elapsedMs: now() - start, wallElapsedMs: wallNow() - wallStart, cycles, samples, restarts, error: String(error) });
    throw error;
  }
}
