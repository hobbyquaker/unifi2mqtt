#!/usr/bin/env node

const UnifiEvents = require('unifi-events');
const log = require('yalm');
const Mqtt = require('mqtt');
const config = require('./config.js');
const pkg = require('./package.json');

let mqttConnected;

log.setLevel(config.verbosity);

log.info(pkg.name + ' ' + pkg.version + ' starting');
log.info('mqtt trying to connect', config.url);

const mqtt = Mqtt.connect(config.url, {will: {topic: config.name + '/connected', payload: '0', retain: true}});

function mqttPub(topic, payload, options) {
    if (typeof payload === 'object') {
        payload = JSON.stringify(payload);
    }
    log.debug('mqtt >', topic, payload);
    mqtt.publish(topic, payload, options);
}

let unifiConnected = false;
let retainedClientsTimeout;
const retainedClients = {};

mqtt.on('connect', () => {
    mqttConnected = true;

    log.info('mqtt connected', config.url);
    mqttPub(config.name + '/connected', unifiConnected ? '2' : '1', {retain: true});

    log.info('mqtt subscribe', config.name + '/set/#');
    mqtt.subscribe(config.name + '/set/#');

    log.info('mqtt subscribe', config.name + '/status/+/client/+');
    mqtt.subscribe(config.name + '/status/+/client/+');
    retainedClientsTimeout = setTimeout(clientsReceived, 2000);
});

mqtt.on('close', () => {
    if (mqttConnected) {
        mqttConnected = false;
        log.info('mqtt closed ' + config.url);
    }
});

mqtt.on('error', err => {
    log.error('mqtt', err);
});

mqtt.on('message', (topic, payload) => {
    payload = payload.toString();
    log.debug('mqtt <', topic, payload);

    const parts = topic.split('/');

    if (parts[1] === 'status' && parts[3] === 'client') {
        clearTimeout(retainedClientsTimeout);
        retainedClientsTimeout = setTimeout(clientsReceived, 2000);
        try {
            const val = JSON.parse(payload).val;
            if (val) {
                if (retainedClients[parts[2]]) {
                    retainedClients[parts[2]].push(parts[4]);
                } else {
                    retainedClients[parts[2]] = [parts[4]];
                }
            }
        } catch (err) {
            log.error(topic, payload, err);
        }
    }
});

function unifiConnect(connected) {
    if (unifiConnected !== connected) {
        unifiConnected = connected;
        mqttPub(config.name + '/connected', unifiConnected ? '2' : '1', {retain: true});
        if (unifiConnected) {
            log.info('unifi connected');
        } else {
            log.info('unifi disconnected');
        }
    }
}

log.info('trying to connect https://' + config.unifiHost + ':' + config.unifiPort);
const unifi = new UnifiEvents({
    controller: 'https://' + config.unifiHost + ':' + config.unifiPort,
    username: config.unifiUser,
    password: config.unifiPassword,
    site: config.unifiSite,
    rejectUnauthorized: !config.insecure,
    listen: true
});

function clientsReceived() {
    log.info('all retained clients received');
    log.info('mqtt unsubscribe', config.name + '/status/+/client/+');
    mqtt.unsubscribe(config.name + '/status/+/client/+');
    getClients();
}

function getClients() {
    if (!unifiConnected) {
        setTimeout(getClients, 1000);
        return;
    }
    log.info('unifi > getClients');

    unifi.getClients().then(clients => {
        clients.data.forEach(client => {
            mqttPub([config.name, 'status', client.essid, 'client', client.hostname].join('/'), {val: true, mac: client.mac, ts: (new Date()).getTime()}, {retain: true});
            const index = retainedClients[client.essid].indexOf(client.hostname);
            if (index > -1) {
                retainedClients[client.essid].splice(index, 1);
            }
        });
        Object.keys(retainedClients).forEach(essid => {
            retainedClients[essid].forEach(hostname => {
                mqttPub([config.name, 'status', essid, 'client', hostname].join('/'), {val: false, ts: (new Date()).getTime()}, {retain: true});
            });
        });
    });
}

unifi.on('websocket-status', data => {
    if (data.match(/Connected/)) {
        log.debug(data);
        unifiConnect(true);
    } else if (data.match(/disconnected/)) {
        log.debug(data);
        unifiConnect(false);
    } else if (data.match(/error/)) {
        log.error(data);
    } else {
        log.debug(data);
    }
});

unifi.on('disconnected', data => {
    mqttPub([config.name, 'status', data.ssid, 'event', 'disconnected'].join('/'), {val: data.hostname, mac: data.user, ts: data.time});
    mqttPub([config.name, 'status', data.ssid, 'client', data.hostname].join('/'), {val: false, mac: data.user, ts: data.time}, {retain: true});
});

unifi.on('connected', data => {
    mqttPub([config.name, 'status', data.ssid, 'event', 'connected'].join('/'), {val: data.hostname, mac: data.user, ts: data.time});
    mqttPub([config.name, 'status', data.ssid, 'client', data.hostname].join('/'), {val: true, mac: data.user, ts: data.time}, {retain: true});
});
