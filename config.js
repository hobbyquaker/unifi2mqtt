import {parseConfig} from 'mqtt-interfaces-core';
import pkg from './package.json' with {type: 'json'};

export const OPTIONS = {
    controller: {
        alias: 'c',
        type: 'string',
        describe: 'controller url: https://<console> (UniFi OS) or https://<host>:8443 (legacy controller)',
        demandOption: true,
    },
    username: {
        type: 'string',
        describe: 'controller user (a local account; read-only is enough for status, admin for set topics)',
        demandOption: true,
    },
    password: {
        type: 'string',
        describe: 'controller password',
        secret: true,
        demandOption: true,
    },
    site: {
        type: 'string',
        describe: 'site id (the part after /site/ in the controller url; not the display name)',
        default: 'default',
    },
    mode: {
        type: 'string',
        describe: 'api flavour: unifi-os (UDM, UDR, UCK G2, Cloud Gateway) or legacy (self-hosted controller)',
        choices: ['auto', 'unifi-os', 'legacy'],
        default: 'auto',
    },
    insecure: {
        alias: 'k',
        type: 'boolean',
        describe: 'accept the controller tls certificate without validation (self-signed certificates)',
        default: false,
    },
    events: {
        type: 'boolean',
        describe: 'subscribe to the controller event websocket for instant client events (--no-events: polling only)',
        default: true,
    },
    'poll-interval': {
        type: 'number',
        describe: 'seconds between polls of clients, devices and wlans',
        default: 60,
    },
    'presence-timeout': {
        type: 'number',
        describe: 'seconds a client may be gone before it is reported absent (0 = immediately)',
        default: 0,
    },
    clients: {
        type: 'array',
        describe: 'only publish these clients (mac addresses, names or hostnames, comma separated); default: all',
        default: [],
    },
    'client-key': {
        type: 'string',
        describe: 'how clients are named in topics: name (alias, else hostname, else mac), hostname or mac',
        choices: ['name', 'hostname', 'mac'],
        default: 'name',
    },
    'ha-clients': {
        type: 'boolean',
        describe:
            'announce a device_tracker per client to Home Assistant (--no-ha-clients: controller and devices only)',
        default: true,
    },
    'publish-raw': {
        type: 'boolean',
        describe: 'additionally publish every websocket message of the controller as <name>/raw',
        default: false,
    },
};

export function check(argv) {
    if (argv.pollInterval < 5) {
        throw new Error('--poll-interval must be >= 5 seconds');
    }
    if (argv.presenceTimeout < 0) {
        throw new Error('--presence-timeout must be >= 0');
    }
    return true;
}

export default parseConfig({
    pkg,
    options: OPTIONS,
    defaults: {name: 'unifi'},
    check,
    examples: [
        [
            '$0 -c https://192.168.1.1 --username unifi2mqtt --password s3cret -k -u mqtt://broker',
            'run in the foreground',
        ],
        [
            'sudo $0 --install -n unifi -c https://192.168.1.1 --username unifi2mqtt --password s3cret -k -u mqtt://broker',
            'install as service unifi2mqtt@unifi',
        ],
    ],
});
