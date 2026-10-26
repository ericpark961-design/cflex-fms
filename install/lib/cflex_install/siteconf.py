"""site.yaml — load and check (docs/spec/01 §3.4).

The installer always uses its own loader for the subset site.yaml uses: block
mappings and sequences, one-line flow {..} / [..], quoted and plain scalars,
comments. Anything outside that subset is an error with a line number, never a
guess. PyYAML is deliberately not used: RHEL does not guarantee it, and the one
RHEL 8 ships (python3-pyyaml 3.12) rejects §3.4's own `{ url: https://… }` —
a plain scalar with ':' inside a flow mapping — which newer PyYAML accepts.
The same file must load the same way on every host.
"""

import io
import json
import re

ROLES = ("collector", "app", "db")


class ConfigError(Exception):
    pass


# ── loader ─────────────────────────────────────────────────────────────────

def _strip_comment(text):
    out, q = [], None
    for i, ch in enumerate(text):
        if q:
            if ch == q and not (q == '"' and i and text[i - 1] == "\\"):
                q = None
        elif ch in "'\"":
            q = ch
        elif ch == "#" and (i == 0 or text[i - 1] in " \t"):
            break
        out.append(ch)
    return "".join(out).rstrip()


def _scalar(tok, lineno):
    t = tok.strip()
    if t == "" or t in ("~", "null", "Null", "NULL"):
        return None
    if t[0] == '"':
        if len(t) < 2 or t[-1] != '"':
            raise ConfigError("line %d: unterminated string %s" % (lineno, t))
        return json.loads(t)
    if t[0] == "'":
        if len(t) < 2 or t[-1] != "'":
            raise ConfigError("line %d: unterminated string %s" % (lineno, t))
        return t[1:-1].replace("''", "'")
    if t in ("true", "True", "TRUE"):
        return True
    if t in ("false", "False", "FALSE"):
        return False
    if re.match(r"^[-+]?\d+$", t):
        return int(t)
    if re.match(r"^[-+]?(\d+\.\d*|\.\d+)$", t):
        return float(t)
    if t[0] in "&*!|>%@`":
        raise ConfigError("line %d: YAML feature not supported here: %s" % (lineno, t))
    return t


class _Flow(object):
    """One-line flow collection: {a: b, c: [d, e]}."""

    def __init__(self, s, lineno):
        self.s, self.i, self.lineno = s, 0, lineno

    def err(self, msg):
        raise ConfigError("line %d: %s (col %d): %s" % (self.lineno, msg, self.i + 1, self.s))

    def ws(self):
        while self.i < len(self.s) and self.s[self.i] in " \t":
            self.i += 1

    def value(self, stops):
        self.ws()
        if self.i >= len(self.s):
            self.err("value expected")
        c = self.s[self.i]
        if c == "{":
            return self.mapping()
        if c == "[":
            return self.seq()
        if c in "'\"":
            j = self.i + 1
            while j < len(self.s):
                if self.s[j] == c and not (c == '"' and self.s[j - 1] == "\\"):
                    break
                j += 1
            if j >= len(self.s):
                self.err("unterminated string")
            tok = self.s[self.i:j + 1]
            self.i = j + 1
            return _scalar(tok, self.lineno)
        j = self.i
        while j < len(self.s) and self.s[j] not in stops:
            j += 1
        tok = self.s[self.i:j]
        self.i = j
        return _scalar(tok, self.lineno)

    def key(self):
        self.ws()
        j = self.i
        if j < len(self.s) and self.s[j] in "'\"":
            return self.value(":")
        while j < len(self.s):
            if self.s[j] == ":" and (j + 1 == len(self.s) or self.s[j + 1] in " \t,}"):
                break
            if self.s[j] in ",}":
                self.err("':' expected after key")
            j += 1
        k = self.s[self.i:j].strip()
        self.i = j
        return k

    def mapping(self):
        self.i += 1
        out = {}
        self.ws()
        if self.i < len(self.s) and self.s[self.i] == "}":
            self.i += 1
            return out
        while True:
            k = self.key()
            self.ws()
            if self.i >= len(self.s) or self.s[self.i] != ":":
                self.err("':' expected")
            self.i += 1
            if k in out:
                self.err("duplicate key %s" % k)
            out[k] = self.value(",}")
            self.ws()
            if self.i >= len(self.s):
                self.err("'}' expected")
            if self.s[self.i] == ",":
                self.i += 1
                continue
            if self.s[self.i] == "}":
                self.i += 1
                return out
            self.err("',' or '}' expected")

    def seq(self):
        self.i += 1
        out = []
        self.ws()
        if self.i < len(self.s) and self.s[self.i] == "]":
            self.i += 1
            return out
        while True:
            out.append(self.value(",]"))
            self.ws()
            if self.i >= len(self.s):
                self.err("']' expected")
            if self.s[self.i] == ",":
                self.i += 1
                continue
            if self.s[self.i] == "]":
                self.i += 1
                return out
            self.err("',' or ']' expected")


def _inline(text, lineno):
    t = text.strip()
    if t[:1] in ("{", "["):
        f = _Flow(t, lineno)
        v = f.value("")
        f.ws()
        if f.i != len(t):
            f.err("trailing text")
        return v
    return _scalar(t, lineno)


def _split_key(text, lineno):
    """'key: rest' → (key, rest) or None when the line is not a mapping entry."""
    q, depth = None, 0
    for i, ch in enumerate(text):
        if q:
            if ch == q:
                q = None
            continue
        if ch in "'\"" and i == 0:
            q = ch
        elif ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1
        elif ch == ":" and depth == 0 and (i + 1 == len(text) or text[i + 1] in " \t"):
            k = text[:i].strip()
            if k[:1] in "'\"":
                k = _scalar(k, lineno)
            return k, text[i + 1:].strip()
    return None


def _lines(src):
    out = []
    for n, raw in enumerate(src.splitlines(), 1):
        if "\t" in raw[:len(raw) - len(raw.lstrip())]:
            raise ConfigError("line %d: tab in indentation" % n)
        body = _strip_comment(raw)
        if not body.strip() or body.strip() in ("---", "..."):
            continue
        out.append([len(body) - len(body.lstrip(" ")), body.strip(), n])
    return out


def _block(lines, i, indent):
    if lines[i][1] == "-" or lines[i][1].startswith("- "):
        return _seq(lines, i, indent)
    return _map(lines, i, indent)


def _map(lines, i, indent):
    out = {}
    while i < len(lines) and lines[i][0] == indent:
        ind, text, n = lines[i]
        if text == "-" or text.startswith("- "):
            break
        kv = _split_key(text, n)
        if kv is None:
            raise ConfigError("line %d: 'key: value' expected: %s" % (n, text))
        k, rest = kv
        if k in out:
            raise ConfigError("line %d: duplicate key %s" % (n, k))
        i += 1
        if rest:
            out[k] = _inline(rest, n)
        elif i < len(lines) and lines[i][0] > indent:
            out[k], i = _block(lines, i, lines[i][0])
        elif i < len(lines) and lines[i][0] == indent and (lines[i][1] == "-" or lines[i][1].startswith("- ")):
            out[k], i = _seq(lines, i, indent)
        else:
            out[k] = None
    if i < len(lines) and lines[i][0] > indent:
        raise ConfigError("line %d: unexpected indentation" % lines[i][2])
    return out, i


def _seq(lines, i, indent):
    out = []
    while i < len(lines) and lines[i][0] == indent and (lines[i][1] == "-" or lines[i][1].startswith("- ")):
        ind, text, n = lines[i]
        content = text[1:].lstrip(" ")
        if not content:
            i += 1
            if i < len(lines) and lines[i][0] > indent:
                v, i = _block(lines, i, lines[i][0])
            else:
                v = None
            out.append(v)
            continue
        if content[:1] not in "{[\"'" and _split_key(content, n) is not None:
            # "- key: v" opens a mapping whose keys sit at the column of "key".
            col = indent + (len(text) - len(content))
            lines[i] = [col, content, n]
            v, i = _map(lines, i, col)
            out.append(v)
            continue
        out.append(_inline(content, n))
        i += 1
    return out, i


def loads(src, use_pyyaml=False):
    """Parse site.yaml. use_pyyaml=True is for tests that cross-check against a modern PyYAML."""
    if use_pyyaml:
        import yaml
        data = yaml.safe_load(src)
        return data if data is not None else {}
    lines = _lines(src)
    if not lines:
        return {}
    if lines[0][0] != 0:
        raise ConfigError("line %d: top level must start at column 1" % lines[0][2])
    data, i = _block(lines, 0, 0)
    if i != len(lines):
        raise ConfigError("line %d: could not parse: %s" % (lines[i][2], lines[i][1]))
    return data


def load(path):
    with io.open(path, encoding="utf-8") as f:
        return loads(f.read())


# ── model ──────────────────────────────────────────────────────────────────

def get(d, dotted, default=None):
    cur = d
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return default
    return cur


def hosts(site):
    """Every host in site.yaml as (role, id, ip, extra) — collectors, app nodes, db."""
    h = site.get("hosts") or {}
    out = []
    for c in h.get("collectors") or []:
        out.append(("collector", c.get("id"), c.get("ip"), c))
    for a in h.get("app") or []:
        out.append(("app", a.get("id"), a.get("ip"), a))
    db = h.get("db")
    if isinstance(db, dict):
        out.append(("db", db.get("id", "db01"), db.get("ip"), db))
    return out


def validate(site):
    """Problems as a list of strings (empty = usable)."""
    errs = []
    if not isinstance(site, dict):
        return ["site.yaml: top level must be a mapping"]
    if not get(site, "tenant.code"):
        errs.append("tenant.code is required")
    hs = hosts(site)
    if not any(r == "collector" for r, _, _, _ in hs):
        errs.append("hosts.collectors: at least one collector")
    if not any(r == "app" for r, _, _, _ in hs):
        errs.append("hosts.app: at least one app node")
    seen = {}
    for role, hid, ip, _ in hs:
        if not hid:
            errs.append("hosts.%s: every host needs an id" % role)
        if not ip or not re.match(r"^\d{1,3}(\.\d{1,3}){3}$", str(ip)):
            errs.append("hosts.%s.%s: ip must be an IPv4 address, got %r" % (role, hid, ip))
        if hid in seen:
            errs.append("hosts: duplicate id %s" % hid)
        seen[hid] = role
    actives = [a for a in (get(site, "hosts.app") or []) if a.get("role") == "active"]
    if get(site, "hosts.app") and len(actives) != 1:
        errs.append("hosts.app: exactly one node must have role: active")
    tp = get(site, "snmp.trap_port", 162)
    if tp != 162:
        errs.append("snmp.trap_port: firewall request v3 opens UDP 162 only, got %r" % tp)
    if get(site, "portal.enabled", True):
        url = get(site, "portal.url") or ""
        if not url.startswith("https://"):
            errs.append("portal.url must be https://")
    ppm = get(site, "install.privileged_ports", "auto")
    if ppm not in ("auto", "forward", "sysctl"):
        errs.append("install.privileged_ports: auto|forward|sysctl, got %r" % ppm)
    rh = get(site, "install.redis_host")
    if rh and rh not in [a.get("id") for a in (get(site, "hosts.app") or [])]:
        errs.append("install.redis_host: %r is not an app node id" % rh)
    return errs


def find_host(site, role, host_id=None, local_ips=()):
    """This machine's entry: by --host-id, else by an IP this machine holds."""
    cands = [(r, hid, ip, x) for r, hid, ip, x in hosts(site) if r == role]
    if host_id:
        for c in cands:
            if c[1] == host_id:
                return c
        raise ConfigError("no %s host with id %s in site.yaml" % (role, host_id))
    mine = [c for c in cands if c[2] in local_ips]
    if len(mine) == 1:
        return mine[0]
    if not mine:
        raise ConfigError("none of this machine's addresses (%s) is a %s host in site.yaml; pass --host-id"
                          % (", ".join(local_ips) or "none", role))
    raise ConfigError("several %s hosts match this machine; pass --host-id" % role)


def redis_host(site):
    """The app node that runs Redis (default: the active one)."""
    rh = get(site, "install.redis_host")
    apps = get(site, "hosts.app") or []
    if rh:
        return next(a for a in apps if a.get("id") == rh)
    return next((a for a in apps if a.get("role") == "active"), apps[0] if apps else None)
