FROM node
WORKDIR /unifi2mqtt
COPY package*.json ./
RUN npm install

COPY . .

CMD node index.js
#CMD env
