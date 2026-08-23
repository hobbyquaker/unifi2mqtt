FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: no native add-ons are needed
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY index.js config.js ./
COPY lib/ ./lib/

# Config only via environment (UNIFI2MQTT_* variables, see README), e.g.
#   -e UNIFI2MQTT_CONTROLLER=https://192.168.1.1 -e UNIFI2MQTT_USERNAME=... -e UNIFI2MQTT_PASSWORD=...
#   -e UNIFI2MQTT_INSECURE=true -e UNIFI2MQTT_MQTT_URL=mqtt://broker
ENV NODE_ENV=production \
    UNIFI2MQTT_MQTT_URL=mqtt://localhost \
    UNIFI2MQTT_NAME=unifi \
    UNIFI2MQTT_VERBOSITY=info

USER node

ENTRYPOINT ["node", "index.js"]
