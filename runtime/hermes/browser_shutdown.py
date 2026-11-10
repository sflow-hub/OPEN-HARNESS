"""Close only managed Chromium windows normally so pending cookies reach disk."""
import argparse
import ctypes
import os
import shlex
import time


def browser_processes():
    profile = os.environ.get('AGENT_BROWSER_PROFILE', '/workspace/private/.config/chromium')
    profile_arg = os.fsencode('--user-data-dir=' + profile)
    result = {}
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            executable = os.path.basename(os.readlink('/proc/' + entry + '/exe'))
            if executable not in ('chromium', 'chromium-browser', 'chrome'):
                continue
            with open('/proc/' + entry + '/cmdline', 'rb') as handle:
                args = [arg for arg in handle.read().split(b'\0') if arg]
            # Chromium rewrites argv into a single space-separated process title.
            if len(args) == 1:
                try:
                    args = [os.fsencode(arg) for arg in shlex.split(os.fsdecode(args[0]))]
                except ValueError as error:
                    raise RuntimeError('The private browser process could not be identified safely.') from error
            if any(arg.startswith(b'--type=') for arg in args):
                continue
            if profile_arg not in args:
                if not any(arg.startswith(b'--user-data-dir=') for arg in args):
                    raise RuntimeError('The private browser profile could not be identified safely.')
                continue
            with open('/proc/' + entry + '/stat') as handle:
                fields = handle.read().rsplit(')', 1)[1].split()
            if fields[0] != 'Z':
                result[int(entry)] = fields[19]
        except (OSError, IndexError):
            pass
    return result


class ClientData(ctypes.Union):
    _fields_ = [('b', ctypes.c_char * 20), ('s', ctypes.c_short * 10), ('l', ctypes.c_long * 5)]


class ClientMessage(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int),
                ('display', ctypes.c_void_p), ('window', ctypes.c_ulong), ('message_type', ctypes.c_ulong),
                ('format', ctypes.c_int), ('data', ClientData)]


class Event(ctypes.Union):
    _fields_ = [('client', ClientMessage), ('padding', ctypes.c_long * 24)]


def property_values(x, display, window, atom):
    actual, form, count, remaining = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong()
    data = ctypes.POINTER(ctypes.c_ubyte)()
    status = x.XGetWindowProperty(display, window, atom, 0, 4096, False, 0,
                                  ctypes.byref(actual), ctypes.byref(form), ctypes.byref(count),
                                  ctypes.byref(remaining), ctypes.byref(data))
    try:
        if status != 0 or form.value != 32 or remaining.value or count.value > 4096 or not data:
            return []
        return list(ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[:count.value])
    finally:
        if data:
            x.XFree(data)


def request_window_close(identities):
    x = ctypes.CDLL('libX11.so.6')
    x.XOpenDisplay.argtypes = [ctypes.c_char_p]; x.XOpenDisplay.restype = ctypes.c_void_p
    x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]; x.XDefaultRootWindow.restype = ctypes.c_ulong
    x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]; x.XInternAtom.restype = ctypes.c_ulong
    x.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long,
                                    ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int),
                                    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
    x.XFree.argtypes = [ctypes.c_void_p]
    x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(Event)]
    x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]; x.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x.XOpenDisplay(b':99')
    if not display:
        if not identities:
            return 0
        raise RuntimeError('The private browser display is unavailable. Its profile has not been transferred.')
    sent = 0
    try:
        atom = lambda name: x.XInternAtom(display, name, False)
        root = x.XDefaultRootWindow(display)
        windows = property_values(x, display, root, atom(b'_NET_CLIENT_LIST'))
        if windows and not identities:
            raise RuntimeError('A private desktop window remains but its browser could not be identified safely.')
        pid_atom, protocols, delete_window = atom(b'_NET_WM_PID'), atom(b'WM_PROTOCOLS'), atom(b'WM_DELETE_WINDOW')
        for window in windows:
            owner = property_values(x, display, window, pid_atom)
            if len(owner) != 1 or owner[0] not in identities or browser_processes().get(owner[0]) != identities[owner[0]]:
                continue
            event = Event()
            event.client.type, event.client.send_event = 33, True
            event.client.display, event.client.window, event.client.message_type = display, window, protocols
            event.client.format, event.client.data.l[0], event.client.data.l[1] = 32, delete_window, 0
            if not x.XSendEvent(display, window, False, 0, ctypes.byref(event)):
                raise RuntimeError('The private browser did not accept a normal close request.')
            sent += 1
        x.XSync(display, False)
    finally:
        x.XCloseDisplay(display)
    return sent


def close_browser(timeout=8):
    identities = browser_processes()
    if not identities:
        request_window_close({})
        return
    if not request_window_close(identities) and browser_processes():
        raise RuntimeError('Close the private browser before moving this agent. Its profile has not been transferred.')
    deadline = time.monotonic() + timeout
    while browser_processes():
        if time.monotonic() >= deadline:
            raise RuntimeError('The private browser is waiting to close. Check it for a confirmation before moving this agent.')
        time.sleep(.1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--timeout', type=float, default=8)
    options = parser.parse_args()
    if not 0 < options.timeout <= 8:
        parser.error('Browser close timeout must be between zero and eight seconds.')
    close_browser(options.timeout)
