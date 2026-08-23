import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {NetworkState, topicKey, normalizeMac, splitList} from '../lib/model.js';
import {normalizeEvent} from '../lib/events.js';
import sta from './fixtures/sta.json' with {type: 'json'};
import devices from './fixtures/device.json' with {type: 'json'};
import wlans from './fixtures/wlanconf.json' with {type: 'json'};
import events from './fixtures/events.json' with {type: 'json'};

const evt = (name) => normalizeEvent(events[name].data[0]);

function clock(start = 1756200000000) {
    let t = start;
    const now = () => t;
    now.advance = (ms) => {
        t += ms;
    };
    return now;
}

function items(result) {
    return Object.fromEntries(result.changes.map((c) => [c.item, c.value]));
}

/** A state that has seen the fixtures once. */
function seeded(options = {}) {
    const now = clock();
    const state = new NetworkState({now, ...options});
    state.applyDevices(devices);
    state.applyWlans(wlans);
    const first = state.applyClients(sta);
    return {state, now, first};
}

describe('helpers', () => {
    test('topicKey strips separators and wildcards', () => {
        assert.equal(topicKey('Home WiFi'), 'Home_WiFi');
        assert.equal(topicKey(' a/b+c#d '), 'a_b_c_d');
        assert.equal(topicKey('Bastis-iPhone'), 'Bastis-iPhone');
        assert.equal(topicKey('Küche AP'), 'Küche_AP');
        assert.equal(topicKey(''), '');
    });

    test('normalizeMac', () => {
        assert.equal(normalizeMac('AA:BB:CC:DD:EE:01'), 'aa:bb:cc:dd:ee:01');
        assert.equal(normalizeMac('aabbccddee01'), 'aa:bb:cc:dd:ee:01');
        assert.equal(normalizeMac('AA-BB-CC-DD-EE-01'), 'aa:bb:cc:dd:ee:01');
        assert.equal(normalizeMac('weird'), 'weird');
    });

    test('splitList', () => {
        assert.deepEqual(splitList(['a,b', 'c']), ['a', 'b', 'c']);
        assert.deepEqual(splitList('a b,,c'), ['a', 'b', 'c']);
        assert.deepEqual(splitList([]), []);
        assert.deepEqual(splitList(undefined), []);
    });
});

describe('clients from stat/sta', () => {
    test('items for every client, keyed by alias → hostname → mac', () => {
        const {first} = seeded();
        const v = items(first);
        assert.equal(v['client/Basti_iPhone/present'], true);
        assert.deepEqual(v['client/Basti_iPhone/details'], {
            mac: 'aa:bb:cc:dd:ee:01',
            name: 'Basti iPhone',
            hostname: 'bastis-iphone',
            ip: '192.168.1.101',
            wired: false,
            ssid: 'Home WiFi',
            band: '5 GHz',
            channel: 36,
            ap: 'AP Living Room',
            network: 'LAN',
        });
        assert.equal(v['client/printer/present'], true);
        assert.deepEqual(v['client/printer/details'].wired, true);
        assert.equal(v['client/printer/details'].ssid, null);
        assert.equal(v['client/printer/details'].band, null);
        assert.equal(v['client/Basti_iPhone/details'].band, '5 GHz');
        assert.equal(v['client/Basti_iPhone/details'].channel, 36);
        assert.equal(v['client/printer/details'].ap, 'Switch Office');
        assert.equal(v['client/guest-laptop/present'], true);
        assert.equal(first.clear.length, 0);
        assert.equal(first.discovery, true);
    });

    test('counts: total, wireless, wired, per ssid (wlans without clients report 0)', () => {
        const {first} = seeded();
        const v = items(first);
        assert.equal(v.client_count, 3);
        assert.equal(v['client_count/wireless'], 2);
        assert.equal(v['client_count/wired'], 1);
        assert.equal(v['wifi/Home_WiFi/client_count'], 1);
        assert.equal(v['wifi/Guests/client_count'], 1);
    });

    test('a second identical poll reports nothing', () => {
        const {state} = seeded();
        const again = state.applyClients(sta);
        assert.deepEqual(again.changes, []);
        assert.equal(again.discovery, false);
    });

    test('a client missing from the poll is absent at once with timeout 0', () => {
        const {state, now} = seeded();
        now.advance(60000);
        const v = items(state.applyClients(sta.slice(1)));
        assert.equal(v['client/Basti_iPhone/present'], false);
        assert.equal(v.client_count, 2);
        assert.equal(v['wifi/Home_WiFi/client_count'], 0);
        assert.equal(v['client/printer/present'], undefined, 'unchanged items are not repeated');
    });

    test('presence timeout keeps a client present until it elapses', () => {
        const {state, now} = seeded({presenceTimeout: 300});
        now.advance(60000);
        let v = items(state.applyClients(sta.slice(1)));
        assert.equal(v['client/Basti_iPhone/present'], undefined);
        assert.equal(v.client_count, undefined);
        now.advance(240000);
        v = items(state.applyClients(sta.slice(1)));
        assert.equal(v['client/Basti_iPhone/present'], false);
        assert.equal(v.client_count, 2);
    });

    test('client-key hostname and mac', () => {
        const byHost = new NetworkState({clientKey: 'hostname'});
        assert.ok('client/bastis-iphone/present' in items(byHost.applyClients(sta)));
        const byMac = new NetworkState({clientKey: 'mac'});
        assert.ok('client/aa:bb:cc:dd:ee:01/present' in items(byMac.applyClients(sta)));
    });

    test('duplicate names get a mac suffix; a client without any name falls back to its mac', () => {
        const state = new NetworkState();
        const v = items(
            state.applyClients([
                {mac: 'aa:bb:cc:dd:ee:01', hostname: 'phone'},
                {mac: 'aa:bb:cc:dd:ee:02', hostname: 'phone'},
                {mac: 'aa:bb:cc:dd:ee:03'},
            ]),
        );
        assert.ok('client/phone/present' in v);
        assert.ok('client/phone_ee02/present' in v);
        assert.ok('client/aa:bb:cc:dd:ee:03/present' in v);
    });

    test('a renamed client moves to a new key and clears the old topics', () => {
        const {state} = seeded();
        const renamed = sta.map((c) => (c.hostname === 'printer' ? {...c, name: 'Office Printer'} : c));
        const result = state.applyClients(renamed);
        assert.deepEqual(result.clear, ['client/printer/present', 'client/printer/details']);
        assert.equal(items(result)['client/Office_Printer/present'], true);
        assert.equal(result.discovery, true);
    });

    test('--clients filter limits per-client topics, not the counts', () => {
        const {first, state} = seeded({clients: ['AA:BB:CC:DD:EE:01', 'printer']});
        const v = items(first);
        assert.ok('client/Basti_iPhone/present' in v);
        assert.ok('client/printer/present' in v);
        assert.ok(!('client/guest-laptop/present' in v));
        assert.equal(v.client_count, 3);
        assert.deepEqual(
            state.clientList().map((c) => c.key),
            ['Basti_iPhone', 'printer'],
        );
    });
});

describe('websocket events', () => {
    test('connect event: new client present immediately, event item not retained', () => {
        const {state, now} = seeded();
        now.advance(60000); // the fixture event happened 60 s after the seed
        const result = state.applyEvent(evt('connected'));
        const v = items(result);
        assert.equal(v['client/new-phone/present'], true);
        assert.equal(v['client/new-phone/details'].ssid, 'Home WiFi');
        assert.equal(v['client/new-phone/details'].ap, 'AP Living Room');
        assert.equal(v.client_count, 4);
        assert.equal(v['wifi/Home_WiFi/client_count'], 2);
        const event = result.changes.find((c) => c.item === 'event/client');
        assert.equal(event.retain, false);
        assert.deepEqual(event.value, {
            type: 'connected',
            client: 'new-phone',
            mac: 'aa:bb:cc:dd:ee:04',
            hostname: 'new-phone',
            ssid: 'Home WiFi',
            ap: 'AP Living Room',
            wired: false,
            guest: false,
            time: 1756200060000,
            msg: events.connected.data[0].msg,
        });
        assert.equal(result.discovery, true);
    });

    test('a client first seen through an event survives the next poll for a grace period', () => {
        const {state, now} = seeded();
        state.applyEvent(evt('connected'));
        now.advance(5000);
        let v = items(state.applyClients(sta));
        assert.equal(v['client/new-phone/present'], undefined, 'still present');
        now.advance(60000);
        v = items(state.applyClients(sta));
        assert.equal(v['client/new-phone/present'], false);
    });

    test('disconnect event with timeout 0: absent at once', () => {
        const {state} = seeded();
        const v = items(state.applyEvent(evt('disconnected')));
        assert.equal(v['client/Basti_iPhone/present'], false);
        assert.equal(v.client_count, 2);
        assert.equal(v['wifi/Home_WiFi/client_count'], 0);
        assert.equal(state.nextExpiry(), null);
    });

    test('disconnect event with timeout: expire() flips it later, a reconnect cancels', () => {
        const {state, now} = seeded({presenceTimeout: 120});
        now.advance(120000); // event time is 120 s after the seed
        let result = state.applyEvent(evt('disconnected'));
        assert.equal(items(result)['client/Basti_iPhone/present'], undefined);
        assert.equal(items(result)['event/client'].type, 'disconnected');
        assert.equal(state.nextExpiry(), 120000);
        now.advance(60000);
        assert.deepEqual(state.expire().changes, []);
        assert.equal(state.nextExpiry(), 60000);
        // comes back → expiry cancelled
        state.applyEvent({...evt('connected'), mac: 'aa:bb:cc:dd:ee:01', hostname: 'bastis-iphone'});
        assert.equal(state.nextExpiry(), null);
        now.advance(120000);
        assert.deepEqual(state.expire().changes, []);
        // and leaves again, for good
        state.applyEvent({...evt('disconnected'), time: now()});
        now.advance(120000);
        result = state.expire();
        assert.equal(items(result)['client/Basti_iPhone/present'], false);
        assert.equal(items(result).client_count, 2);
    });

    test('roam keeps the client present and updates the ap', () => {
        const {state} = seeded();
        const v = items(state.applyEvent(evt('roam')));
        assert.equal(v['client/Basti_iPhone/present'], undefined);
        assert.equal(v['client/Basti_iPhone/details'].ap, '78:8a:20:00:00:03', 'unknown ap → mac');
        assert.equal(v['event/client'].type, 'roam');
    });

    test('wired guest event, device events and events for filtered clients', () => {
        const {state} = seeded({clients: ['printer']});
        const lg = items(state.applyEvent(evt('lan_guest')));
        assert.ok(!('client/visitor-pc/present' in lg), 'filtered out');
        assert.ok(!('event/client' in lg));
        assert.equal(lg.client_count, 4, 'but counted');
        assert.equal(lg['client_count/wired'], 2);
        assert.deepEqual(state.applyEvent(evt('device')).changes, []);
        assert.deepEqual(state.applyEvent(null).changes, []);
    });
});

describe('devices from stat/device', () => {
    test('items and details', () => {
        const state = new NetworkState();
        const result = state.applyDevices(devices);
        const v = items(result);
        assert.equal(v['device/AP_Living_Room/online'], true);
        assert.equal(v['device/AP_Living_Room/led'], 'default');
        assert.equal(v['device/AP_Living_Room/clients'], 2);
        assert.deepEqual(v['device/AP_Living_Room/details'], {
            mac: '78:8a:20:00:00:01',
            name: 'AP Living Room',
            model: 'U6LR',
            type: 'uap',
            ip: '192.168.1.10',
            version: '6.6.77.15402',
        });
        assert.equal(v['device/Switch_Office/online'], false);
        assert.equal(v['device/Switch_Office/led'], 'off');
        assert.equal(result.discovery, true);
        assert.equal(state.deviceByKey('Switch_Office').id, '5f1a0000000000000000d002');
        assert.equal(state.deviceByKey('nope'), undefined);
    });

    test('changes only, removed devices are cleared', () => {
        const state = new NetworkState();
        state.applyDevices(devices);
        const v = items(state.applyDevices([{...devices[0], led_override: 'on', num_sta: 3}]));
        assert.deepEqual(v, {'device/AP_Living_Room/led': 'on', 'device/AP_Living_Room/clients': 3});
        const result = state.applyDevices([{...devices[0], led_override: 'on', num_sta: 3}]);
        assert.deepEqual(result.changes, []);
        assert.deepEqual(result.clear, []);
        const removed = state.applyDevices([devices[0]]);
        assert.deepEqual(removed.clear, []);
        // the switch was already removed by the previous call
        const state2 = new NetworkState();
        state2.applyDevices(devices);
        const gone = state2.applyDevices([devices[0]]);
        assert.deepEqual(gone.clear, [
            'device/Switch_Office/online',
            'device/Switch_Office/led',
            'device/Switch_Office/clients',
            'device/Switch_Office/details',
        ]);
        assert.equal(gone.discovery, true);
    });
});

describe('wlans from rest/wlanconf', () => {
    test('enabled per ssid, lookup by key', () => {
        const state = new NetworkState();
        const v = items(state.applyWlans(wlans));
        assert.equal(v['wifi/Home_WiFi/enabled'], true);
        assert.equal(v['wifi/Guests/enabled'], false);
        assert.equal(v['wifi/Home_WiFi/client_count'], 0);
        assert.equal(state.wlanByKey('Guests').id, '5f1a0000000000000000w002');
        assert.equal(state.wlanByKey('Guests').guest, true);
        assert.deepEqual(
            state.wlanList().map((w) => w.key),
            ['Home_WiFi', 'Guests'],
        );
    });

    test('a removed wlan is cleared', () => {
        const state = new NetworkState();
        state.applyWlans(wlans);
        const result = state.applyWlans([wlans[0]]);
        assert.deepEqual(result.clear, ['wifi/Guests/enabled', 'wifi/Guests/client_count']);
        assert.equal(result.discovery, true);
    });
});

describe('presence edge cases', () => {
    test('a roam after a pending disconnect cancels the expiry', () => {
        const now = clock();
        const state = new NetworkState({now, presenceTimeout: 60});
        state.applyClients(sta);
        now.advance(120000);
        state.applyEvent(evt('disconnected'));
        assert.equal(state.nextExpiry(), 60000);
        state.applyEvent(evt('roam'));
        assert.equal(state.nextExpiry(), null);
        now.advance(120000);
        assert.deepEqual(state.expire().changes, []);
        assert.equal(state.clients.get('aa:bb:cc:dd:ee:01').present, true);
    });

    test('a poll sighting cancels a pending disconnect', () => {
        const now = clock();
        const state = new NetworkState({now, presenceTimeout: 60});
        state.applyClients(sta);
        now.advance(120000);
        state.applyEvent(evt('disconnected'));
        state.applyClients(sta);
        assert.equal(state.nextExpiry(), null);
    });

    test('a disconnect event for an unknown client creates it absent, without a pending expiry', () => {
        const state = new NetworkState({presenceTimeout: 60});
        const v = items(state.applyEvent({...evt('disconnected'), mac: 'aa:bb:cc:dd:ee:99', hostname: 'stranger'}));
        assert.equal(v['client/stranger/present'], false);
        assert.equal(state.nextExpiry(), null);
    });
});
