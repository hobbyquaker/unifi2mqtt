/**
 * Redaction for controller dumps (`scripts/dump.js`): a fixed substitution so the output is still
 * consistent (the same mac maps to the same placeholder everywhere, in every file) but carries no
 * identifying data. Pure, no I/O.
 *
 *   - mac addresses: the OUI (vendor) is kept, the device part becomes a counter
 *   - public IPv4 → 203.0.113.<n>, every IPv6 except ::/::1 → 2001:db8::<n>; private IPv4 stays
 *   - names (name, hostname, alias, essid, ssid, ap_name, sw_name, note, …) → name-<n> / ssid-<n>,
 *     and those strings are also replaced inside every other string (event messages)
 *   - serials → SERIAL-<n>, usernames / emails → user-<n>
 *   - secrets (x_*, *password*, *secret*, *token*, *key, psk, passphrase, cookie, …) → "***"
 */

import {isIPv6} from 'node:net';

const MAC_RE =
    /\b([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})\b/gi;
const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
// candidates only (anything hex with two or more colons); isIPv6() decides — a mac is not an IPv6
const IPV6_RE = /[0-9a-f]*(?::[0-9a-f]*){2,7}/gi;
const IS_MAC = /^([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})[:-]([0-9a-f]{2})$/i;
const IS_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const SECRET_KEY_RE = /^x_|passw|secret|token|_key$|^key$|psk|passphrase|cookie|authorization|auth_?key|api[-_]?key/i;
const NAME_KEYS = new Set([
    'name',
    'hostname',
    'alias',
    'note',
    'ap_name',
    'sw_name',
    'gw_name',
    'device_name',
    'site_name',
    'desc',
    'dhcpd_dns_1',
]);
const SSID_KEYS = new Set(['essid', 'ssid', 'wlan_name']);
const SERIAL_KEYS = new Set(['serial', 'serial_number', 'serialno']);
const USER_KEYS = new Set(['username', 'email', 'admin', 'user', 'x_user', 'first_name', 'last_name']);

function isPrivateIPv4(a, b) {
    return (
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) ||
        a >= 224
    );
}

/**
 * @param {object} [o]
 * @param {string[]} [o.secrets] literal strings to blank wherever they appear (the login password)
 * @returns {{redact: (value: any) => any, stats: () => object}}
 */
export function createRedactor({secrets = []} = {}) {
    const maps = {
        mac: new Map(),
        ip4: new Map(),
        ip6: new Map(),
        name: new Map(),
        ssid: new Map(),
        serial: new Map(),
        user: new Map(),
    };
    const literalSecrets = secrets.filter((s) => typeof s === 'string' && s.length >= 3);

    const mapped = (map, value, make) => {
        const key = String(value).toLowerCase();
        if (!map.has(key)) {
            map.set(key, make(map.size + 1));
        }
        return map.get(key);
    };
    const mac = (m, o1, o2, o3) => {
        const oui = `${o1}:${o2}:${o3}`.toLowerCase();
        return mapped(
            maps.mac,
            m,
            (n) =>
                `${oui}:00:${String(Math.floor(n / 256)).padStart(2, '0')}:${(n % 256).toString(16).padStart(2, '0')}`,
        );
    };
    const ip4 = (m, a, b) =>
        isPrivateIPv4(Number(a), Number(b)) ? m : mapped(maps.ip4, m, (n) => `203.0.113.${n % 256}`);
    const ip6 = (m) =>
        !isIPv6(m) || m === '::' || m === '::1' ? m : mapped(maps.ip6, m, (n) => `2001:db8::${n.toString(16)}`);

    const scrubText = (text) => {
        let out = text;
        for (const s of literalSecrets) {
            out = out.split(s).join('***');
        }
        out = out.replace(MAC_RE, mac).replace(IPV4_RE, ip4).replace(IPV6_RE, ip6);
        return out;
    };

    // pass 1: keyed substitutions + inline patterns; collects the name maps
    const walk = (value, key) => {
        if (Array.isArray(value)) {
            return value.map((v) => walk(v, key));
        }
        if (value && typeof value === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(value)) {
                out[k] = walk(v, k);
            }
            return out;
        }
        if (typeof value !== 'string' || value === '') {
            return value;
        }
        if (key && SECRET_KEY_RE.test(key)) {
            return '***';
        }
        if (key && NAME_KEYS.has(key) && !IS_MAC.test(value) && !IS_IPV4.test(value)) {
            return mapped(maps.name, value, (n) => `name-${n}`);
        }
        if (key && SSID_KEYS.has(key)) {
            return mapped(maps.ssid, value, (n) => `ssid-${n}`);
        }
        if (key && SERIAL_KEYS.has(key)) {
            return mapped(maps.serial, value, (n) => `SERIAL-${n}`);
        }
        if (key && USER_KEYS.has(key)) {
            return mapped(maps.user, value, (n) => `user-${n}`);
        }
        return scrubText(value);
    };

    // pass 2: known names / ssids inside free text (event messages: `User[…] connected to AP[Office] with SSID "Home"`)
    const replaceKnown = (value) => {
        if (Array.isArray(value)) {
            return value.map(replaceKnown);
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceKnown(v)]));
        }
        if (typeof value !== 'string') {
            return value;
        }
        let out = value;
        for (const map of [maps.name, maps.ssid, maps.serial, maps.user]) {
            for (const [original, placeholder] of map) {
                if (original.length >= 3 && out !== placeholder) {
                    out = out.replace(new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), placeholder);
                }
            }
        }
        return out;
    };

    return {
        redact: (value) => replaceKnown(walk(value, undefined)),
        stats: () => Object.fromEntries(Object.entries(maps).map(([k, m]) => [k, m.size])),
    };
}
