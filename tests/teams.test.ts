import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/db';
import { Profiles } from '../runtime/profiles';
import { TaskStore } from '../runtime/tasks';
import { TeamStore, ensureTeamFolders } from '../runtime/teams';
import { teamMountArgs } from '../runtime/hermes';

test('active team folders are created at startup and creation, scoped to members, and retained on retirement', () => {
  const root = mkdtempSync(join(tmpdir(), 'team-folders-')), store = new Store(':memory:');
  try {
    const profiles = new Profiles(store.db);
    profiles.create({ id: 'atlas', name: 'Atlas' }); profiles.create({ id: 'scout', name: 'Scout' });
    new TaskStore(store.db);
    const previous = new TeamStore(store.db).create({ name: 'Existing', color: 'blue', icon: 'people', memberAgentIds: ['atlas'] });
    const teams = new TeamStore(store.db, root);
    assert.ok(existsSync(join(root, 'teams', previous.id, 'shared')));
    if (process.platform !== 'win32') assert.equal(statSync(join(root, 'teams')).mode & 0o777, 0o700);
    const team = teams.create({ name: 'New', color: 'sage', icon: 'people', memberAgentIds: ['scout'] });
    const folder = join(root, 'teams', team.id, 'shared');
    assert.ok(existsSync(folder));
    writeFileSync(join(folder, 'keep.txt'), 'keep');
    assert.deepEqual(teams.activeTeamIds('atlas'), [previous.id]);
    assert.deepEqual(teamMountArgs(root, teams.activeTeamIds('scout')), ['-v', `${folder}:/workspace/teams/${team.id}`]);
    assert.deepEqual(teamMountArgs(root, teams.activeTeamIds('non-member')), []);
    teams.update(team.id, { ...team, memberAgentIds: [] });
    assert.deepEqual(teamMountArgs(root, teams.activeTeamIds('scout')), []);
    teams.retire(team.id);
    assert.deepEqual(teamMountArgs(root, teams.activeTeamIds('scout')), []);
    assert.equal(readFileSync(join(folder, 'keep.txt'), 'utf8'), 'keep');
    assert.throws(() => ensureTeamFolders(root, ['../escape']), /Invalid team id/);
    rmSync(join(root, 'teams', previous.id), { recursive: true });
    new TeamStore(store.db, root);
    assert.ok(existsSync(join(root, 'teams', previous.id, 'shared')));
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});
