"""Shared call log for the Python desks (options, airdrops, sleepers). Every graded pick is logged the first time
it is graded (and again if its grade changes); later runs update the current value so performance can be tracked.
File: data/calls_<desk>.json. Estimates, not advice."""
import json, os, time
from common import DATA_DIR
HZ = [('1h', 3600), ('4h', 4 * 3600), ('24h', 86400), ('3d', 3 * 86400), ('7d', 7 * 86400), ('30d', 30 * 86400)]

class Tracker:
    def __init__(self, desk):
        self.f = os.path.join(DATA_DIR, f'calls_{desk}.json'); self.desk = desk
        try: self.calls = json.load(open(self.f))['calls']
        except Exception: self.calls = []
        self.last = {c['key']: c for c in self.calls}
    def log(self, key, grade, score, value, label, feat=None, url=None):
        """value = price / premium / proxy at call time."""
        now = int(time.time()); p = self.last.get(key)
        if p and (p['grade'] == grade or now - p['t'] < 3600): return
        if not value: return
        c = {'key': key, 't': now, 'grade': grade, 'score': score, 'v0': value, 'v': value, 'vmax': value, 'vmin': value, 'label': label, 'url': url, 'feat': feat or {}, 'at': {}}
        self.calls.append(c); self.last[key] = c
    def update(self, key, value, now=None):
        if value is None: return
        now = now or int(time.time())
        for c in self.calls:
            if c['key'] != key: continue
            c['v'] = value; c['vmax'] = max(c['vmax'], value); c['vmin'] = min(c['vmin'], value); c['vt'] = now
            for h, s in HZ:
                if h not in c['at'] and now - c['t'] >= s: c['at'][h] = {'ret': (value / c['v0'] - 1) * 100, 'peak': c['vmax'] / c['v0']}
    def keys_open(self, max_age=31 * 86400):
        now = time.time(); return {c['key'] for c in self.calls if now - c['t'] < max_age}
    def save(self):
        self.calls = self.calls[-20000:]
        json.dump({'desk': self.desk, 'savedAt': int(time.time() * 1000), 'calls': self.calls}, open(self.f, 'w'))
