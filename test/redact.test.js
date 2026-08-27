import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {createRedactor} from '../lib/redact.js';

describe('createRedactor', () => {
    test('macs keep the oui and map consistently across calls and files', () => {
        const {redact} = createRedactor();
        const a = redact({mac: 'F4:92:BF:12:34:56', ap_mac: 'f4:92:bf:aa:bb:cc'});
        const b = redact([{sw_mac: 'f4:92:bf:12:34:56'}]);
        assert.equal(a.mac, 'f4:92:bf:00:00:01');
        assert.equal(a.ap_mac, 'f4:92:bf:00:00:02');
        assert.equal(b[0].sw_mac, a.mac);
        assert.equal(redact('User[f4:92:bf:12:34:56] roamed'), 'User[f4:92:bf:00:00:01] roamed');
    });

    test('public ips are replaced, private ones stay, ipv6 goes to the documentation prefix', () => {
        const {redact} = createRedactor();
        const r = redact({
            ip: '192.168.1.42',
            wan_ip: '84.12.99.7',
            gw: '10.0.0.1',
            v6: ['2a02:8108:1::5', 'fe80::1', '::1'],
        });
        assert.equal(r.ip, '192.168.1.42');
        assert.equal(r.wan_ip, '203.0.113.1');
        assert.equal(r.gw, '10.0.0.1');
        assert.deepEqual(r.v6, ['2001:db8::1', '2001:db8::2', '::1']);
        assert.equal(redact('wan 84.12.99.7 again'), 'wan 203.0.113.1 again');
    });

    test('names, ssids, serials, users get placeholders and are replaced inside free text', () => {
        const {redact, stats} = createRedactor();
        const r = redact({
            name: "Basti's iPhone",
            hostname: 'bastis-iphone',
            essid: 'Home WiFi',
            serial: 'ABC123',
            username: 'basti',
            msg: 'User[Basti\'s iPhone] has connected to AP[Office AP] with SSID "Home WiFi"',
            ap_name: 'Office AP',
            model: 'U6-Lite',
        });
        assert.equal(r.name, 'name-1');
        assert.equal(r.hostname, 'name-2');
        assert.equal(r.essid, 'ssid-1');
        assert.equal(r.serial, 'SERIAL-1');
        assert.equal(r.username, 'user-1');
        assert.equal(r.ap_name, 'name-3');
        assert.equal(r.msg, 'User[name-1] has connected to AP[name-3] with SSID "ssid-1"');
        assert.equal(r.model, 'U6-Lite');
        assert.deepEqual(stats().name, 3);
    });

    test('secrets are blanked by key and by literal value', () => {
        const {redact} = createRedactor({secrets: ['s3cret-pw']});
        const r = redact({
            x_passphrase: 'wifi-pw',
            x_ssh_password: 'ssh',
            password: 'p',
            csrf_token: 't',
            api_key: 'k',
            cookie: 'TOKEN=abc',
            body: 'login with s3cret-pw failed',
            ok: 'plain',
            n: 5,
            b: true,
            e: '',
        });
        assert.deepEqual(r, {
            x_passphrase: '***',
            x_ssh_password: '***',
            password: '***',
            csrf_token: '***',
            api_key: '***',
            cookie: '***',
            body: 'login with *** failed',
            ok: 'plain',
            n: 5,
            b: true,
            e: '',
        });
    });

    test('a name that is a mac or ip is not mapped as a name', () => {
        const {redact} = createRedactor();
        const r = redact({name: 'aa:bb:cc:dd:ee:ff', hostname: '192.168.0.9'});
        assert.equal(r.name, 'aa:bb:cc:00:00:01');
        assert.equal(r.hostname, '192.168.0.9');
    });
});
