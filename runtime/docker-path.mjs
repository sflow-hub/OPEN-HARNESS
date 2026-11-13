import { accessSync, constants } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { homedir } from 'node:os';

export function dockerCandidates(platform = process.platform, environment = process.env, homeDirectory = homedir()) {
  const path = platform === 'win32' ? win32 : { join };
  const executable = platform === 'win32' ? 'docker.exe' : 'docker';
  return [environment.OPEN_HARNESS_DOCKER_BINARY,
    ...(environment.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean).map(directory => path.join(directory, executable)),
    ...(platform === 'darwin' ? ['/Applications/Docker.app/Contents/Resources/bin/docker', '/opt/homebrew/bin/docker', '/usr/local/bin/docker'] : []),
    ...(platform === 'win32' ? [win32.join(environment.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', executable)] : ['/usr/bin/docker', '/usr/local/bin/docker']),
    path.join(homeDirectory, '.docker', 'bin', executable),
  ].filter(Boolean);
}

export function prepareDockerEnvironment(environment = process.env) {
  for (const candidate of dockerCandidates(process.platform, environment)) {
    try {
      accessSync(candidate, constants.X_OK);
      const directory = dirname(candidate), separator = process.platform === 'win32' ? ';' : ':';
      if (!(environment.PATH || '').split(separator).includes(directory)) environment.PATH = directory + separator + (environment.PATH || '');
      return candidate;
    } catch { /* A packaged launcher may have a smaller PATH than an interactive shell. */ }
  }
  return 'docker';
}

prepareDockerEnvironment();
