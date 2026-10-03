"""Fake Docker CLI for the offline release-gate tests. It never contacts a daemon.

The tests copy this file next to fake-state.json and call it through a small executable wrapper. It answers only
the calls scripts/debian-origin-gate.py makes (version, image inspect, container inspect, rm --force, run) and fails
anything else. `run` simulates a probe container: it records the container, writes the cidfile, then executes the
helper command on this host with container paths mapped to the bind-mount sources, and `/` and other image paths
mapped to a synthetic image root. Scenarios in the state file make a named probe hang, fail to be auto-removed
(leak) or collide with an existing container name. Every call is appended to docker-log.jsonl.
"""
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE, LOG = HERE / 'fake-state.json', HERE / 'docker-log.jsonl'


def load():
    return json.loads(STATE.read_text(encoding='utf-8'))


def save(state):
    STATE.write_text(json.dumps(state, indent=2), encoding='utf-8')


def fail(message, code=1):
    sys.stderr.write(message + '\n')
    sys.exit(code)


def find_container(state, reference):
    for container in state['containers'].values():
        if reference in (container['Id'], container['Name'].lstrip('/')):
            return container
    return None


def run(state, args):
    options, mounts, labels, index = {}, [], {}, 0
    flags = {'--rm', '--read-only'}
    while index < len(args) and args[index].startswith('--'):
        name = args[index]
        if name in flags:
            options[name] = True
            index += 1
            continue
        value = args[index + 1]
        if name == '--mount':
            mounts.append(dict(part.split('=', 1) if '=' in part else (part, True) for part in value.split(',')))
        elif name == '--label':
            key, _, label = value.partition('=')
            labels[key] = label
        else:
            options.setdefault(name, []).append(value)
        index += 2
    image, command = args[index], args[index + 1:]
    if image not in state['images']:
        fail(f'Unable to find image {image!r} locally', 125)
    name = options['--name'][0]
    if find_container(state, name):
        fail(f'docker: Error response from daemon: Conflict. The container name "/{name}" is already in use.', 125)
    step = next((s for s in ('probe-component-root', 'probe-bind') if name.endswith(s)), name)
    scenario = state.get('scenario', {}).get(step)
    container = {'Id': secrets.token_hex(32), 'Name': '/' + name, 'Image': state['images'][image]['inspect']['Id'],
                 'Config': {'Image': image, 'Labels': labels}, 'State': {'Running': True}}
    state['containers'][container['Id']] = container
    save(state)
    Path(options['--cidfile'][0]).write_text(container['Id'], encoding='utf-8')
    with LOG.open('a', encoding='utf-8') as log:
        log.write(json.dumps({'probe': step, 'options': options, 'mounts': mounts, 'labels': labels, 'image': image,
                              'command': command, 'container': container['Id']}) + '\n')
    if scenario == 'hang':
        time.sleep(60)
    root = Path(state['images'][image]['root'])
    table = sorted(((m['dst'], m['src']) for m in mounts), key=lambda item: -len(item[0]))

    def host(path):
        if not path.startswith('/'):
            return path
        for destination, source in table:
            if path == destination or path.startswith(destination + '/'):
                return source + path[len(destination):]
        return str(root) + path if path != '/' else str(root)

    entrypoint = options['--entrypoint'][0]
    if entrypoint != '/usr/local/bin/python3':
        fail(f'unexpected entrypoint {entrypoint}', 127)
    def container_view(data):  # report paths as the container sees them, as a real probe would
        for destination, source in sorted(table, key=lambda item: -len(item[1])):
            data = data.replace(source.encode(), destination.encode())
        return data.replace(str(root).encode() + b'/', b'/')

    workdir = host(options.get('--workdir', ['/'])[0])
    result = subprocess.run([state['python'], *[host(argument) for argument in command]], capture_output=True, cwd=workdir,
                            env={'PYTHONDONTWRITEBYTECODE': '1', 'PATH': '/usr/bin:/bin'})
    sys.stdout.buffer.write(container_view(result.stdout))
    sys.stderr.buffer.write(container_view(result.stderr))
    state = load()
    if scenario != 'leak' and '--rm' in options:
        state['containers'].pop(container['Id'], None)
    else:
        state['containers'][container['Id']]['State'] = {'Running': False}
    save(state)
    sys.exit(result.returncode)


def main():
    args = sys.argv[1:]
    with LOG.open('a', encoding='utf-8') as log:
        log.write(json.dumps({'argv': args, 'env': sorted(os.environ), 'dockerConfig': os.environ.get('DOCKER_CONFIG'),
                              'dockerHost': os.environ.get('DOCKER_HOST'), 'cwd': os.getcwd()}) + '\n')
    if args[:1] != ['--host']:
        fail('the gate must name the Docker daemon explicitly', 2)
    state, args = load(), args[2:]
    if args == ['version', '--format', '{{json .Server}}']:
        print(json.dumps({'Version': '27.0.0-fake', 'ApiVersion': '1.46', 'Os': state.get('os', 'linux'), 'Arch': state['arch']}))
    elif args[:2] == ['image', 'inspect'] and len(args) == 3:
        entry = state['images'].get(args[2])
        if entry is None:
            fail(f'Error response from daemon: No such image: {args[2]}')
        print(json.dumps([entry['inspect']]))
    elif args[:3] == ['inspect', '--type', 'container'] and len(args) == 4:
        container = find_container(state, args[3])
        if container is None:
            fail(f'Error: No such container: {args[3]}')
        print(json.dumps([container]))
    elif args[:2] == ['rm', '--force'] and len(args) == 3:
        if args[2] not in state['containers']:
            fail(f'Error response from daemon: No such container: {args[2]}')
        del state['containers'][args[2]]
        save(state)
        print(args[2])
    elif args[:1] == ['run']:
        run(state, args[1:])
    else:
        fail(f'unexpected docker call: {args}', 2)


if __name__ == '__main__':
    main()
