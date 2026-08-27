/**
 * UniFi Network controller HTTP client. Plain node:https, no client library: the API is a handful
 * of JSON endpoints behind a cookie session, and the two controller generations differ only in the
 * login endpoint and a path prefix:
 *
 *   flavour     login                  api prefix                 websocket
 *   unifi-os    POST /api/auth/login   /proxy/network/api/s/<site>  /proxy/network/wss/s/<site>/events
 *   legacy      POST /api/login        /api/s/<site>                /wss/s/<site>/events
 *
 * UniFi OS (UDM, UDR, UCK G2, Cloud Gateways, port 443) answers `GET /` with 200; a legacy
 * controller (self-hosted network application, port 8443) redirects to /manage — that is the
 * auto-detection. Mutating requests carry the CSRF token (UniFi OS: `x-csrf-token` response header,
 * legacy: `csrf_token` cookie; UniFi OS may also only ship it inside the `TOKEN` JWT as `csrfToken`).
 * An expired session (401, or HTTP 200 with `meta.msg: api.err.LoginRequired`) is re-established
 * once per request. A login rejection is classified: invalid credentials (UniFi OS: 403
 * AUTHENTICATION_FAILED_INVALID_CREDENTIALS, legacy: 400/401), an account with 2FA (HTTP 499 /
 * `api.err.Ubic2faTokenRequired` / MFA_AUTH_REQUIRED) — neither is retried by trying the other flavour.
 *
 * Verified against fixtures only so far; see README "Controller compatibility".
 */

import http from 'node:http';
import https from 'node:https';

export class UnifiError extends Error {
    constructor(message, {status, path, body} = {}) {
        super(message);
        this.name = 'UnifiError';
        this.status = status;
        this.path = path;
        this.body = body;
    }
}

/** `host`, `host:8443` or a full url → `https://host[:port]` without trailing slash. */
export function normalizeControllerUrl(input) {
    let s = String(input || '').trim();
    if (!s) {
        throw new Error('controller url is empty');
    }
    if (!/^https?:\/\//i.test(s)) {
        s = 'https://' + s;
    }
    const url = new URL(s);
    return url.origin;
}

/** Default transport: one request, no redirects, JSON bodies. Replaced in tests. */
export function httpRequest({method, url, headers = {}, body, insecure = false, timeout = 15000}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const lib = u.protocol === 'http:' ? http : https;
        const data = body === undefined ? undefined : JSON.stringify(body);
        const req = lib.request(
            u,
            {
                method,
                headers: {
                    accept: 'application/json',
                    ...headers,
                    ...(data !== undefined && {
                        'content-type': 'application/json',
                        'content-length': Buffer.byteLength(data),
                    }),
                },
                rejectUnauthorized: !insecure,
                timeout,
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () =>
                    resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()}),
                );
                res.on('error', reject);
            },
        );
        req.on('timeout', () => req.destroy(new Error(`timeout after ${timeout} ms`)));
        req.on('error', reject);
        if (data !== undefined) {
            req.write(data);
        }
        req.end();
    });
}

function parseSetCookie(headers) {
    let raw = headers && (headers['set-cookie'] || headers['Set-Cookie']);
    if (!raw) {
        return [];
    }
    if (!Array.isArray(raw)) {
        raw = [raw];
    }
    return raw
        .map((line) => String(line).split(';')[0])
        .map((pair) => {
            const i = pair.indexOf('=');
            return i > 0 ? [pair.slice(0, i).trim(), pair.slice(i + 1).trim()] : null;
        })
        .filter(Boolean);
}

/** The `csrfToken` claim of a UniFi OS `TOKEN` JWT, or null. */
export function csrfFromToken(jwt) {
    const parts = String(jwt || '').split('.');
    if (parts.length < 2) {
        return null;
    }
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        return typeof payload.csrfToken === 'string' && payload.csrfToken ? payload.csrfToken : null;
    } catch {
        return null;
    }
}

const LOGIN_REQUIRED = 'api.err.LoginRequired';

/** Session expiry: 401/403, or — Network application — HTTP 200 with `meta.msg: api.err.LoginRequired`. */
export function isSessionExpired(status, parsed) {
    if (status === 401 || status === 403) {
        return true;
    }
    return Boolean(status === 200 && parsed && parsed.meta && parsed.meta.msg === LOGIN_REQUIRED);
}

/**
 * Why a login response is a rejection, or null when it is a success. `parsed` is the JSON body.
 * UniFi OS: 403 `{code: "AUTHENTICATION_FAILED_INVALID_CREDENTIALS"}`, 499 `MFA_AUTH_REQUIRED`;
 * legacy: 400 `{meta: {rc: "error", msg: "api.err.Invalid"}}`, `api.err.Ubic2faTokenRequired`.
 */
export function loginFailure(status, parsed) {
    const meta = parsed && parsed.meta;
    const code = (meta && meta.msg) || (parsed && (parsed.code || parsed.message)) || '';
    if (status === 499 || /2fa|mfa/i.test(code)) {
        return `the account has two-factor authentication enabled${code ? ` (${code})` : ''} — use a local controller account without 2fa`;
    }
    if (status === 400 || status === 401 || status === 403 || (status === 200 && meta && meta.rc !== 'ok')) {
        return `invalid credentials${code ? ` (${code})` : ''} — a local controller account is required, not a Ubiquiti sso login`;
    }
    if (status !== 200) {
        return `http ${status}`;
    }
    return null;
}

/**
 * @param {object} o
 * @param {string} o.url controller url (see normalizeControllerUrl)
 * @param {string} o.username
 * @param {string} o.password
 * @param {string} [o.site] default "default"
 * @param {'auto' | 'unifi-os' | 'legacy'} [o.mode]
 * @param {boolean} [o.insecure] accept any tls certificate
 * @param {object} [o.log]
 * @param {Function} [o.request] transport (httpRequest)
 * @param {number} [o.timeout] ms per request
 */
export class UnifiController {
    constructor({url, username, password, site = 'default', mode = 'auto', insecure = false, log, request, timeout}) {
        this.url = normalizeControllerUrl(url);
        this.username = username;
        this.password = password;
        this.site = site;
        this.configuredMode = mode;
        this.mode = mode === 'auto' ? null : mode;
        this.insecure = insecure;
        this.log = log || {debug() {}, info() {}, warn() {}, error() {}};
        this.transport = request || httpRequest;
        this.timeout = timeout;
        this.cookies = new Map();
        this.csrfToken = null;
        this.loggedIn = false;
        this.loginPromise = null;
    }

    get apiPrefix() {
        return this.mode === 'unifi-os' ? '/proxy/network' : '';
    }

    /** `stat/sta` → `/proxy/network/api/s/<site>/stat/sta` (unifi-os) or `/api/s/<site>/stat/sta`. */
    sitePath(path) {
        return `${this.apiPrefix}/api/s/${encodeURIComponent(this.site)}/${path.replace(/^\/+/, '')}`;
    }

    websocketUrl() {
        return `${this.url.replace(/^http/, 'ws')}${this.apiPrefix}/wss/s/${encodeURIComponent(this.site)}/events`;
    }

    websocketHeaders() {
        const h = {};
        const cookie = this.cookieHeader();
        if (cookie) {
            h.Cookie = cookie;
        }
        return h;
    }

    cookieHeader() {
        return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    /** Forget the session (e.g. after a websocket handshake was refused); the next call logs in again. */
    invalidateSession() {
        this.loggedIn = false;
        this.cookies.clear();
        this.csrfToken = null;
    }

    absorbResponse(res) {
        let fromJwt = null;
        for (const [k, v] of parseSetCookie(res.headers)) {
            this.cookies.set(k, v);
            if (k === 'csrf_token') {
                this.csrfToken = v;
            } else if (k === 'TOKEN') {
                fromJwt = csrfFromToken(v);
            }
        }
        const token = res.headers && (res.headers['x-csrf-token'] || res.headers['X-CSRF-Token']);
        if (token) {
            this.csrfToken = Array.isArray(token) ? token[0] : token;
        } else if (fromJwt) {
            // some UniFi OS versions ship the csrf token only inside the TOKEN jwt
            this.csrfToken = fromJwt;
        }
    }

    async raw(method, path, body) {
        const headers = {};
        const cookie = this.cookieHeader();
        if (cookie) {
            headers.cookie = cookie;
        }
        if (this.csrfToken && method !== 'GET') {
            headers['x-csrf-token'] = this.csrfToken;
        }
        this.log.debug('unifi >', method, path, body === undefined ? '' : JSON.stringify(body));
        const res = await this.transport({
            method,
            url: this.url + path,
            headers,
            body,
            insecure: this.insecure,
            timeout: this.timeout,
        });
        this.absorbResponse(res);
        this.log.debug('unifi <', res.status, path, (res.body || '').slice(0, 200));
        return res;
    }

    /** Detect the api flavour once (or take the configured one). */
    async detectMode() {
        if (this.mode) {
            return this.mode;
        }
        const res = await this.raw('GET', '/');
        // UniFi OS serves its ui at / (200); a legacy controller redirects to /manage (302)
        this.mode = res.status === 200 ? 'unifi-os' : 'legacy';
        this.log.info('unifi controller flavour detected:', this.mode, `(GET / → ${res.status})`);
        return this.mode;
    }

    async login() {
        if (this.loginPromise) {
            return this.loginPromise;
        }
        this.loginPromise = this.doLogin().finally(() => {
            this.loginPromise = null;
        });
        return this.loginPromise;
    }

    async doLogin() {
        this.cookies.clear();
        this.csrfToken = null;
        this.loggedIn = false;
        await this.detectMode();
        const unifiOs = this.mode === 'unifi-os';
        const path = unifiOs ? '/api/auth/login' : '/api/login';
        const body = unifiOs
            ? {username: this.username, password: this.password, rememberMe: false}
            : {username: this.username, password: this.password, remember: false};
        const res = await this.raw('POST', path, body);
        const failure = loginFailure(res.status, safeJson(res.body));
        if (failure) {
            throw new UnifiError(`login failed: ${failure}`, {status: res.status, path, body: res.body});
        }
        if (this.cookies.size === 0) {
            throw new UnifiError('login failed: no session cookie in response', {status: res.status, path});
        }
        this.loggedIn = true;
        this.log.info('unifi logged in as', this.username, 'at', this.url, `(${this.mode}, site ${this.site})`);
    }

    async logout() {
        if (!this.loggedIn) {
            return;
        }
        const path = this.mode === 'unifi-os' ? '/api/auth/logout' : '/api/logout';
        try {
            await this.raw('POST', path, {});
        } catch (err) {
            this.log.debug('unifi logout failed:', err.message);
        }
        this.invalidateSession();
    }

    /**
     * Authenticated JSON request on an absolute path; logs in when there is no session and once
     * more when the controller answers 401. Returns the parsed body.
     */
    async request(method, path, body) {
        if (!this.loggedIn) {
            await this.login();
        }
        let res = await this.raw(method, path, body);
        let parsed = safeJson(res.body);
        if (isSessionExpired(res.status, parsed)) {
            this.log.info('unifi session expired, logging in again');
            this.invalidateSession();
            await this.login();
            res = await this.raw(method, path, body);
            parsed = safeJson(res.body);
        }
        if (res.status !== 200) {
            const msg =
                (parsed && parsed.meta && parsed.meta.msg) || (parsed && parsed.message) || `http ${res.status}`;
            throw new UnifiError(`${method} ${path}: ${msg}`, {status: res.status, path, body: res.body});
        }
        if (parsed && parsed.meta && parsed.meta.rc && parsed.meta.rc !== 'ok') {
            throw new UnifiError(`${method} ${path}: ${parsed.meta.msg || parsed.meta.rc}`, {
                status: res.status,
                path,
                body: res.body,
            });
        }
        if (parsed === undefined) {
            throw new UnifiError(`${method} ${path}: response is not json`, {status: res.status, path, body: res.body});
        }
        return parsed;
    }

    /** Site-scoped api call; returns the `data` array. */
    async api(method, path, body) {
        if (!this.loggedIn) {
            // the site path depends on the flavour, which login() detects
            await this.login();
        }
        const parsed = await this.request(method, this.sitePath(path), body);
        return Array.isArray(parsed.data) ? parsed.data : [];
    }

    /** Currently connected clients (stat/sta). */
    clients() {
        return this.api('GET', 'stat/sta');
    }

    /** Adopted UniFi devices: access points, switches, gateways (stat/device). */
    devices() {
        return this.api('GET', 'stat/device');
    }

    /** Wireless networks (rest/wlanconf). */
    wlans() {
        return this.api('GET', 'rest/wlanconf');
    }

    setWlanEnabled(id, enabled) {
        return this.api('PUT', `rest/wlanconf/${encodeURIComponent(id)}`, {enabled: Boolean(enabled)});
    }

    /** led_override: on | off | default (site setting). */
    setDeviceLed(id, mode) {
        return this.api('PUT', `rest/device/${encodeURIComponent(id)}`, {led_override: mode});
    }

    /** Re-provision a device (cmd/devmgr force-provision) — for APs that missed a WLAN change. */
    forceProvision(mac) {
        return this.api('POST', 'cmd/devmgr', {cmd: 'force-provision', mac});
    }
}

function safeJson(text) {
    if (typeof text !== 'string' || text.trim() === '') {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
