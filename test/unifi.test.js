import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {UnifiController, UnifiError, normalizeControllerUrl} from '../lib/unifi.js';
import sta from './fixtures/sta.json' with {type: 'json'};

const ok = (data, extra = {}) => ({status: 200, headers: {}, body: JSON.stringify({meta: {rc: 'ok'}, data}), ...extra});

/**
 * A fake controller: answers by (method, path), records every request. `flavour` decides what
 * GET / and the login endpoints do.
 */
function fakeController({flavour = 'unifi-os', sessionTtl = Infinity, loginStatus = 200} = {}) {
    const calls = [];
    let requestsSinceLogin = 0;
    let loggedIn = false;
    const transport = async ({method, url, headers, body}) => {
        const {pathname} = new URL(url);
        calls.push({method, path: pathname, headers, body});
        if (pathname === '/' && method === 'GET') {
            return flavour === 'unifi-os'
                ? {status: 200, headers: {'x-csrf-token': 'csrf-from-root'}, body: '<html>'}
                : {status: 302, headers: {location: '/manage'}, body: ''};
        }
        if (pathname === '/api/auth/login') {
            if (flavour !== 'unifi-os') {
                return {status: 404, headers: {}, body: 'not found'};
            }
            if (loginStatus !== 200) {
                return {status: loginStatus, headers: {}, body: '{"code":"AUTHENTICATION_FAILED"}'};
            }
            loggedIn = true;
            requestsSinceLogin = 0;
            return {
                status: 200,
                headers: {'set-cookie': ['TOKEN=jwt123; Path=/; HttpOnly'], 'x-csrf-token': 'csrf-os'},
                body: JSON.stringify({unique_id: 'u1', username: body.username}),
            };
        }
        if (pathname === '/api/login') {
            if (flavour !== 'legacy') {
                return {status: 404, headers: {}, body: ''};
            }
            if (loginStatus !== 200) {
                return {status: 400, headers: {}, body: JSON.stringify({meta: {rc: 'error', msg: 'api.err.Invalid'}})};
            }
            loggedIn = true;
            requestsSinceLogin = 0;
            return ok([], {
                headers: {'set-cookie': ['unifises=sess456; Path=/; Secure', 'csrf_token=csrf-legacy; Path=/']},
            });
        }
        if (pathname === '/api/auth/logout' || pathname === '/api/logout') {
            loggedIn = false;
            return ok([]);
        }
        if (!loggedIn || !headers.cookie || requestsSinceLogin >= sessionTtl) {
            return {
                status: 401,
                headers: {},
                body: JSON.stringify({meta: {rc: 'error', msg: 'api.err.LoginRequired'}}),
            };
        }
        requestsSinceLogin += 1;
        const prefix = flavour === 'unifi-os' ? '/proxy/network' : '';
        const site = pathname.startsWith(`${prefix}/api/s/`) ? pathname.slice(`${prefix}/api/s/`.length) : null;
        if (site === 'default/stat/sta') {
            return ok(sta);
        }
        if (site === 'default/rest/wlanconf/w1' && method === 'PUT') {
            return ok([{_id: 'w1', ...body}]);
        }
        if (site === 'default/rest/device/d1' && method === 'PUT') {
            return ok([{_id: 'd1', ...body}]);
        }
        if (site === 'default/stat/broken') {
            return {status: 200, headers: {}, body: JSON.stringify({meta: {rc: 'error', msg: 'api.err.NoSuchThing'}})};
        }
        return {status: 404, headers: {}, body: 'nope'};
    };
    return {transport, calls};
}

const creds = {username: 'admin', password: 'pw'};

describe('normalizeControllerUrl', () => {
    test('accepts host, host:port and urls', () => {
        assert.equal(normalizeControllerUrl('192.168.1.1'), 'https://192.168.1.1');
        assert.equal(normalizeControllerUrl('unifi.local:8443'), 'https://unifi.local:8443');
        assert.equal(normalizeControllerUrl('https://unifi.local:8443/manage/'), 'https://unifi.local:8443');
        assert.equal(normalizeControllerUrl('http://10.0.0.1:8080'), 'http://10.0.0.1:8080');
        assert.throws(() => normalizeControllerUrl(''), /empty/);
    });
});

describe('UnifiController — UniFi OS', () => {
    test('detects the flavour, logs in, keeps cookie + csrf, prefixes /proxy/network', async () => {
        const {transport, calls} = fakeController({flavour: 'unifi-os'});
        const c = new UnifiController({url: 'https://udm', ...creds, request: transport});
        const clients = await c.clients();
        assert.equal(c.mode, 'unifi-os');
        assert.equal(clients.length, 3);
        assert.deepEqual(
            calls.map((x) => `${x.method} ${x.path}`),
            ['GET /', 'POST /api/auth/login', 'GET /proxy/network/api/s/default/stat/sta'],
        );
        assert.deepEqual(calls[1].body, {username: 'admin', password: 'pw', rememberMe: false});
        assert.equal(calls[2].headers.cookie, 'TOKEN=jwt123');
        assert.equal(c.csrfToken, 'csrf-os');
        assert.equal(c.websocketUrl(), 'wss://udm/proxy/network/wss/s/default/events');
        assert.deepEqual(c.websocketHeaders(), {Cookie: 'TOKEN=jwt123'});
    });

    test('mutating requests carry the csrf token; setters use PUT rest/…', async () => {
        const {transport, calls} = fakeController();
        const c = new UnifiController({url: 'https://udm', ...creds, request: transport});
        await c.setWlanEnabled('w1', false);
        await c.setDeviceLed('d1', 'off');
        const put = calls.filter((x) => x.method === 'PUT');
        assert.equal(put[0].path, '/proxy/network/api/s/default/rest/wlanconf/w1');
        assert.deepEqual(put[0].body, {enabled: false});
        assert.equal(put[0].headers['x-csrf-token'], 'csrf-os');
        assert.equal(put[1].path, '/proxy/network/api/s/default/rest/device/d1');
        assert.deepEqual(put[1].body, {led_override: 'off'});
        // GETs go without the token
        assert.equal(
            calls.find((x) => x.method === 'GET' && x.path.includes('/api/')),
            undefined,
        );
    });

    test('an expired session is renewed once, transparently', async () => {
        const {transport, calls} = fakeController({sessionTtl: 1});
        const c = new UnifiController({url: 'https://udm', ...creds, request: transport});
        await c.clients();
        await c.clients();
        const seq = calls.map((x) => `${x.method} ${x.path}`);
        assert.deepEqual(seq, [
            'GET /',
            'POST /api/auth/login',
            'GET /proxy/network/api/s/default/stat/sta',
            'GET /proxy/network/api/s/default/stat/sta', // 401
            'POST /api/auth/login',
            'GET /proxy/network/api/s/default/stat/sta',
        ]);
        assert.equal(c.loggedIn, true);
    });

    test('bad credentials fail loudly', async () => {
        const {transport} = fakeController({loginStatus: 401});
        const c = new UnifiController({url: 'https://udm', ...creds, request: transport});
        await assert.rejects(
            () => c.clients(),
            (err) => err instanceof UnifiError && /invalid credentials/.test(err.message),
        );
        assert.equal(c.loggedIn, false);
    });

    test('api errors carry the controller message; logout clears the session', async () => {
        const {transport, calls} = fakeController();
        const c = new UnifiController({url: 'https://udm', ...creds, request: transport});
        await assert.rejects(() => c.api('GET', 'stat/broken'), /api\.err\.NoSuchThing/);
        await assert.rejects(() => c.api('GET', 'stat/missing'), /http 404/);
        await c.logout();
        assert.equal(c.loggedIn, false);
        assert.equal(c.cookieHeader(), '');
        assert.equal(calls.at(-1).path, '/api/auth/logout');
    });

    test('concurrent first calls log in only once', async () => {
        const {transport, calls} = fakeController();
        const c = new UnifiController({url: 'https://udm', ...creds, request: transport});
        await Promise.all([c.clients(), c.clients(), c.clients()]);
        assert.equal(calls.filter((x) => x.path === '/api/auth/login').length, 1);
    });
});

describe('UnifiController — legacy controller', () => {
    test('detects legacy from the redirect, logs in at /api/login, no path prefix', async () => {
        const {transport, calls} = fakeController({flavour: 'legacy'});
        const c = new UnifiController({url: 'unifi.local:8443', ...creds, site: 'office', request: transport});
        assert.equal(c.url, 'https://unifi.local:8443');
        await c.api('GET', 'stat/sta').catch(() => {}); // site office → 404 in the fake, fine
        assert.equal(c.mode, 'legacy');
        assert.deepEqual(
            calls.map((x) => `${x.method} ${x.path}`),
            ['GET /', 'POST /api/login', '/api/s/office/stat/sta'].map((s, i) => (i === 2 ? 'GET ' + s : s)),
        );
        assert.deepEqual(calls[1].body, {username: 'admin', password: 'pw', remember: false});
        assert.equal(calls[2].headers.cookie, 'unifises=sess456; csrf_token=csrf-legacy');
        assert.equal(c.csrfToken, 'csrf-legacy');
        assert.equal(c.websocketUrl(), 'wss://unifi.local:8443/wss/s/office/events');
    });

    test('configured mode skips detection', async () => {
        const {transport, calls} = fakeController({flavour: 'legacy'});
        const c = new UnifiController({url: 'https://unifi:8443', ...creds, mode: 'legacy', request: transport});
        await c.clients();
        assert.equal(calls[0].path, '/api/login');
        assert.equal(calls[1].path, '/api/s/default/stat/sta');
    });

    test('rejected legacy login', async () => {
        const {transport} = fakeController({flavour: 'legacy', loginStatus: 400});
        const c = new UnifiController({url: 'https://unifi:8443', ...creds, request: transport});
        await assert.rejects(() => c.clients(), /login failed: invalid credentials/);
    });
});
