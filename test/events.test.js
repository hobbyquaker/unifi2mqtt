import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';

import {normalizeEvent, parseMessage, EventStream} from '../lib/events.js';
import fixtures from './fixtures/events.json' with {type: 'json'};

describe('normalizeEvent', () => {
    test('wireless user connected', () => {
        const evt = normalizeEvent(fixtures.connected.data[0]);
        assert.deepEqual(evt, {
            kind: 'client',
            key: 'EVT_WU_Connected',
            subject: 'WU',
            type: 'connected',
            time: 1756200060000,
            msg: fixtures.connected.data[0].msg,
            mac: 'aa:bb:cc:dd:ee:04',
            hostname: 'new-phone',
            ssid: 'Home WiFi',
            ap: '78:8a:20:00:00:01',
            wired: false,
            guest: false,
        });
    });

    test('disconnect, roam, lan guest', () => {
        assert.equal(normalizeEvent(fixtures.disconnected.data[0]).type, 'disconnected');
        assert.equal(normalizeEvent(fixtures.roam.data[0]).type, 'roam');
        assert.equal(normalizeEvent(fixtures.roam.data[0]).ap, '78:8a:20:00:00:03');
        const lg = normalizeEvent(fixtures.lan_guest.data[0]);
        assert.equal(lg.kind, 'client');
        assert.equal(lg.mac, 'aa:bb:cc:dd:ee:05');
        assert.equal(lg.wired, true);
        assert.equal(lg.guest, true);
        assert.equal(normalizeEvent({key: 'EVT_WU_RoamRadio', user: 'x'}).type, 'roam_radio');
    });

    test('device and other events', () => {
        const dev = normalizeEvent(fixtures.device.data[0]);
        assert.equal(dev.kind, 'device');
        assert.equal(dev.type, 'restarted');
        assert.equal(dev.mac, '78:8a:20:00:00:01');
        assert.equal(normalizeEvent({key: 'EVT_AD_Login', time: 1}).kind, 'other');
        assert.equal(normalizeEvent({key: 'nope'}), null);
        assert.equal(normalizeEvent(null), null);
        // datetime fallback when time is missing
        assert.equal(
            normalizeEvent({key: 'EVT_WU_Connected', datetime: '2026-08-26T10:41:00Z'}).time,
            Date.parse('2026-08-26T10:41:00Z'),
        );
    });
});

describe('parseMessage', () => {
    test('events frame', () => {
        const msg = parseMessage(JSON.stringify(fixtures.connected));
        assert.equal(msg.type, 'events');
        assert.equal(msg.events.length, 1);
        assert.equal(msg.events[0].mac, 'aa:bb:cc:dd:ee:04');
    });

    test('sync frames are passed through without events', () => {
        const msg = parseMessage(Buffer.from(JSON.stringify(fixtures.sync)));
        assert.equal(msg.type, 'sta:sync');
        assert.deepEqual(msg.events, []);
        assert.equal(msg.data.length, 1);
    });

    test('garbage', () => {
        assert.equal(parseMessage('not json'), null);
        assert.equal(parseMessage('42'), null);
    });
});

describe('EventStream', () => {
    class FakeWebSocket extends EventEmitter {
        static instances = [];
        constructor(url, options) {
            super();
            this.url = url;
            this.options = options;
            this.closed = false;
            FakeWebSocket.instances.push(this);
        }
        close() {
            this.closed = true;
            this.emit('close', 1000, '');
        }
    }

    function controller({loggedIn = true} = {}) {
        return {
            loggedIn,
            insecure: true,
            invalidated: 0,
            websocketUrl: () => 'wss://udm/proxy/network/wss/s/default/events',
            websocketHeaders: () => ({Cookie: 'TOKEN=x'}),
            invalidateSession() {
                this.loggedIn = false;
                this.invalidated += 1;
            },
        };
    }

    test('connects with the session cookie and emits normalized events', () => {
        FakeWebSocket.instances = [];
        const ctrl = controller();
        const stream = new EventStream({controller: ctrl, WebSocket: FakeWebSocket, reconnectDelay: 1});
        const events = [];
        const messages = [];
        stream.on('event', (e) => events.push(e));
        stream.on('message', (m) => messages.push(m.type));
        stream.start();
        const ws = FakeWebSocket.instances[0];
        assert.equal(ws.url, 'wss://udm/proxy/network/wss/s/default/events');
        assert.deepEqual(ws.options, {headers: {Cookie: 'TOKEN=x'}, rejectUnauthorized: false});
        ws.emit('open');
        assert.equal(stream.connected, true);
        ws.emit('message', Buffer.from(JSON.stringify(fixtures.connected)));
        ws.emit('message', JSON.stringify(fixtures.sync));
        ws.emit('message', 'garbage');
        assert.deepEqual(messages, ['events', 'sta:sync']);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'connected');
        stream.stop();
        assert.equal(ws.closed, true);
        assert.equal(stream.connected, false);
    });

    test('a refused handshake invalidates the session and schedules a reconnect', async () => {
        FakeWebSocket.instances = [];
        const ctrl = controller();
        const stream = new EventStream({controller: ctrl, WebSocket: FakeWebSocket, reconnectDelay: 5});
        stream.on('error', () => {});
        stream.start();
        const ws = FakeWebSocket.instances[0];
        ws.emit('unexpected-response', {}, {statusCode: 401});
        ws.emit('close', 1006, '');
        assert.equal(ctrl.invalidated, 1);
        assert.equal(ctrl.loggedIn, false);
        await new Promise((r) => setTimeout(r, 20));
        // not logged in: no new socket, another attempt is pending
        assert.equal(FakeWebSocket.instances.length, 1);
        ctrl.loggedIn = true;
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(FakeWebSocket.instances.length, 2);
        stream.stop();
    });

    test('does not connect before the controller is logged in; stop cancels the retry', async () => {
        FakeWebSocket.instances = [];
        const stream = new EventStream({
            controller: controller({loggedIn: false}),
            WebSocket: FakeWebSocket,
            reconnectDelay: 5,
        });
        stream.start();
        assert.equal(FakeWebSocket.instances.length, 0);
        stream.stop();
        await new Promise((r) => setTimeout(r, 15));
        assert.equal(FakeWebSocket.instances.length, 0);
    });
});
