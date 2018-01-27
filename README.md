# unifi2mqtt

[![mqtt-smarthome](https://img.shields.io/badge/mqtt-smarthome-blue.svg)](https://github.com/mqtt-smarthome/mqtt-smarthome)
[![NPM version](https://badge.fury.io/js/unifi2mqtt.svg)](http://badge.fury.io/js/unifi2mqtt)
[![Dependency Status](https://img.shields.io/gemnasium/hobbyquaker/unifi2mqtt.svg?maxAge=2592000)](https://gemnasium.com/github.com/hobbyquaker/unifi2mqtt)
[![Build Status](https://travis-ci.org/hobbyquaker/unifi2mqtt.svg?branch=master)](https://travis-ci.org/hobbyquaker/unifi2mqtt)
[![XO code style](https://img.shields.io/badge/code_style-XO-5ed9c7.svg)](https://github.com/sindresorhus/xo)
[![License][mit-badge]][mit-url]

> Publish connected clients from Ubiquiti Unifi to MQTT

### Install

`$ sudo npm install -g unifi2mqtt`

I suggest to use [pm2](http://pm2.keymetrics.io/) to manage the unifi2mqtt process (start on system boot, manage log 
files, ...)

### Usage 

```
Usage: unifi2mqtt [options]

Options:
  -a, --unifi-host      unifi hostname or address         [default: "127.0.0.1"]
  -p, --unifi-port      unifi port                               [default: 8443]
  -c, --unifi-user      unifi user                            [default: "admin"]
  -s, --unifi-password  unifi password                                [required]
  -w, --unifi-site      unifi site                          [default: "default"]
  -k, --insecure        allow connection to unifi without valid certificate
  -v, --verbosity       possible values: "error", "warn", "info", "debug"
                                                               [default: "info"]
  -n, --name            instance name. used as topic prefix   [default: "unifi"]
  -u, --url             mqtt broker url            [default: "mqtt://127.0.0.1"]
  -h, --help            Show help                                      [boolean]
  --version             Show version number                            [boolean]

```

### Topics and Payloads

Topics and Payloads follow [mqtt-smarthome architectural proposal](https://github.com/mqtt-smarthome/mqtt-smarthome).

* `<name>/status/<ssid>/client/<hostname>` - `{"val":true}` if client is connected to the wifi network, `{"val":false}`
otherwise. Object also contains the properties `mac` and `ts`. Retained.
* `<name>/status/<ssid>/event/connected` - Client connect event. Payload as above. Not retained.
* `<name>/status/<ssid>/event/disconnected` - Client disconnect event. Payload as above. Not retained.
* `<name>/status/<ssid>/clientCount` - number of clients in specific wifi network, e.g. `{"val":5}`. Retained.
* `<name>/status/clientCount` - number of clients in all wifi networks, e.g. `{"val":12}`. Retained.
* `<name>/connected` - `1` if connected to mqtt broker, `2` if connected to UniFi Controller, `0` on last will. 
Retained.


## License

MIT © [Sebastian Raff](https://github.com/hobbyquaker)

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
