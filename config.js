module.exports = require('yargs')
    .usage('Usage: $0 [options]')
    .describe('a', 'unifi hostname or address')
    .describe('p', 'unifi port')
    .describe('c', 'unifi user')
    .describe('s', 'unifi password')
    .describe('w', 'unifi site')
    .describe('k', 'allow ssl connections with invalid certs')
    .describe('v', 'possible values: "error", "warn", "info", "debug"')
    .describe('n', 'instance name. used as topic prefix')
    .describe('u', 'mqtt broker url')
    .describe('h', 'show help')
    .alias({
        a: 'unifi-host',
        p: 'unifi-port',
        c: 'unifi-user',
        s: 'unifi-password',
        w: 'unifi-site',
        h: 'help',
        n: 'name',
        u: 'url',
        v: 'verbosity',
        k: 'insecure'
    })
    .default({
        a: '127.0.0.1',
        p: 8443,
        c: 'admin',
        u: 'mqtt://127.0.0.1',
        n: 'unifi',
        v: 'info',
        w: 'default'
    })
    .demand('unifi-password')
    .env()
    .version()
    .help('help')
    .argv;
